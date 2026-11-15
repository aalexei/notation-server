// Graph of notes in two views, 2D (Cytoscape) and 3D (3d-force-graph),
// driven by the same controls + note panel (HTMX) + live updates (SSE).
//
// The controls build one model: which notes and edges exist (after
// grouping), which are visible, and which match the search. Each view only
// draws that model, so both always show the same data.
"use strict";

const cfg = JSON.parse(document.getElementById("config").textContent);
const SLOTS = 8; // categorical colour slots; further categories fold into "other"
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const FORCE_GRAPH_URL = "https://unpkg.com/3d-force-graph@1.80.2/dist/3d-force-graph.min.js";
const VIEW_KEY = "notation-server.view";
const GROUP = "group:"; // id prefix of group boxes and collapsed groups

let selectedId = null;
let graph = { nodes: [], edges: [], problems: [] };
let slotOf = new Map(); // category -> slot index, fixed from the whole corpus
let collapsed = new Set(); // categories drawn as a single node while grouping

// What the views draw. `nodes` are notes and collapsed groups; `groups` are
// the boxes of expanded groups (only the 2D view draws those).
let model = { nodes: [], groups: [], edges: [], byId: new Map(), neighbours: new Map() };
let visible = new Set(); // ids of visible nodes and group boxes
let matches = null; // ids matching the search, or null when not searching

const $ = (sel) => document.querySelector(sel);
const searchInput = $("#search");
const colourBy = $("#colour-by");
const depthSelect = $("#depth");
const hideIsolated = $("#hide-isolated");
const fromInput = $("#from");
const toInput = $("#to");
const groupBox = $("#group");

// Toggled from the legend. A note is hidden if any of its tags is, or its
// folder is; "(untagged)" and "(root)" stand for no tag and the top folder.
const UNTAGGED = "(untagged)";
const ROOT = "(root)";
const hidden = { tag: new Set(cfg.excludeTags), subdir: new Set() };
let legendExpanded = false; // whether the uncoloured entries are listed

const idOf = (end) => (typeof end === "object" ? end.id : end);

function category(node) {
  if (colourBy.value === "subdir") return node.subdir || ROOT;
  return node.tags[0] || UNTAGGED;
}

// Only the categories with a colour of their own are grouped.
function groupOf(node) {
  const cat = category(node);
  return groupBox.checked && slotOf.has(cat) ? cat : null;
}

// Colour follows the category, not its rank in the current view: slots are
// assigned once per colour-by mode, from the whole corpus, by frequency.
function assignSlots() {
  const counts = new Map();
  for (const n of graph.nodes) counts.set(category(n), (counts.get(category(n)) || 0) + 1);
  const ranked = [...counts.entries()]
    .filter(([c]) => c !== UNTAGGED && c !== ROOT)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SLOTS);
  slotOf = new Map(ranked.map(([c], i) => [c, i]));
}

function colourFor(cat) {
  return slotOf.has(cat) ? css(`--series-${slotOf.get(cat) + 1}`) : css("--other");
}

function withAlpha(hex, alpha) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

// How many notes have each tag (any of their tags) or are in each folder.
function legendCounts(mode) {
  const counts = new Map();
  const add = (k) => counts.set(k, (counts.get(k) || 0) + 1);
  for (const n of graph.nodes) {
    if (mode === "subdir") add(n.subdir || ROOT);
    else if (n.tags.length) n.tags.forEach(add);
    else add(UNTAGGED);
  }
  return counts;
}

// The legend lists the tags (or folders) of the colour-by mode: coloured
// ones first, then untagged notes; the rest are listed on request, except
// hidden ones, which always are. Clicking an entry shows or hides its
// notes; while grouping, coloured entries also get a collapse button.
function renderLegend() {
  const mode = colourBy.value;
  const other = mode === "tag" ? "subdir" : "tag";
  const counts = legendCounts(mode);
  const label = (k) => ({ [UNTAGGED]: "untagged", [ROOT]: "top folder" })[k] || k;
  const entry = (k) => {
    const shown = !hidden[mode].has(k);
    const colour = slotOf.has(k) ? colourFor(k) : css("--other");
    const fold = groupBox.checked && slotOf.has(k)
      ? `<button type="button" class="fold" data-group="${escapeHtml(k)}" aria-pressed="${collapsed.has(k)}"
           title="${collapsed.has(k) ? "Expand" : "Collapse"} this group">${collapsed.has(k) ? "+" : "−"}</button>`
      : "";
    return `<span class="entry${shown ? "" : " off"}"><button type="button" class="toggle" data-key="${escapeHtml(k)}"
        aria-pressed="${shown}" title="${shown ? "Hide" : "Show"} these notes"><span class="swatch" style="background:${colour}"></span>${
        escapeHtml(label(k))} <span class="count">${counts.get(k)}</span></button>${fold}</span>`;
  };
  const byUse = (a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b);
  const first = [...slotOf.keys(), UNTAGGED, ROOT].filter((k) => counts.has(k));
  const rest = [...counts.keys()].filter((k) => !first.includes(k)).sort(byUse);
  const listed = legendExpanded ? rest : rest.filter((k) => hidden[mode].has(k));

  const items = [...first, ...listed].map(entry);
  if (rest.length > listed.length || legendExpanded) {
    items.push(`<button type="button" class="more" aria-expanded="${legendExpanded}">${
      legendExpanded ? "fewer" : `+${rest.length - listed.length} more`}</button>`);
  }
  if (hidden[mode].size) items.push(`<button type="button" class="reset" data-reset="${mode}">show all</button>`);
  // Hidden folders still apply when colouring by tag, and the other way round.
  const n = hidden[other].size;
  if (n) {
    items.push(`<button type="button" class="reset" data-reset="${other}">${n} hidden ${
      other === "tag" ? "tag" : "folder"}${n > 1 ? "s" : ""} · show</button>`);
  }
  $("#legend").innerHTML = items.join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The model.

// One edge per linked pair: A->B and B->A become a single double-headed
// edge, and links into a collapsed group become one edge with a count.
function mergedEdges(links) {
  const byPair = new Map();
  for (const { source, target } of links) {
    const key = `${source}>${target}`;
    const reverse = byPair.get(`${target}>${source}`);
    if (reverse) { reverse.both = true; reverse.count += 1; }
    else if (byPair.has(key)) byPair.get(key).count += 1;
    else byPair.set(key, { id: key, source, target, both: false, count: 1 });
  }
  return [...byPair.values()];
}

function buildModel() {
  // The notes of a collapsed group are replaced by one node standing in for them.
  const standIn = new Map();
  const members = new Map();
  for (const n of graph.nodes) {
    const g = groupOf(n);
    if (g === null || !collapsed.has(g)) continue;
    standIn.set(n.id, GROUP + g);
    if (!members.has(g)) members.set(g, []);
    members.get(g).push(n);
  }
  const edges = mergedEdges(
    graph.edges
      .map((e) => ({ source: standIn.get(e.source) || e.source, target: standIn.get(e.target) || e.target }))
      .filter((e) => e.source !== e.target),
  );
  const neighbours = new Map();
  const link = (a, b) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  for (const e of edges) { link(e.source, e.target); link(e.target, e.source); }
  const degree = (id) => (neighbours.get(id) || new Set()).size;

  const cats = [...new Set(graph.nodes.map(groupOf))].filter((g) => g !== null);
  const nodes = [
    ...cats.filter((g) => members.has(g)).map((g) => ({
      id: GROUP + g, cat: g, title: `${g} (${members.get(g).length})`, colour: colourFor(g),
      tags: [], aliases: [], members: members.get(g), size: members.get(g).length, degree: degree(GROUP + g),
    })),
    ...graph.nodes.filter((n) => !standIn.has(n.id)).map((n) => ({
      ...n, colour: colourFor(category(n)), degree: degree(n.id), groupCat: groupOf(n),
    })),
  ];
  const groups = cats.filter((g) => !members.has(g))
    .map((g) => ({ id: GROUP + g, cat: g, title: g, colour: colourFor(g) }));
  model = { nodes, groups, edges, byId: new Map(nodes.map((n) => [n.id, n])), neighbours };
}

function noteFilter() {
  // Note ids start with their creation date, YYYYMMDD.
  const from = fromInput.value.replaceAll("-", "");
  const to = toInput.value.replaceAll("-", "");
  return (d) => {
    const day = d.id.slice(0, 8);
    const tagHidden = d.tags.length ? d.tags.some((t) => hidden.tag.has(t)) : hidden.tag.has(UNTAGGED);
    return !tagHidden && !hidden.subdir.has(d.subdir || ROOT) && (!from || day >= from) && (!to || day <= to);
  };
}

function computeVisibility() {
  const passes = noteFilter();
  // Inside a collapsed group, "unlinked" means no links at all.
  const linked = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const memberShown = (m) => passes(m) && (!hideIsolated.checked || linked.has(m.id));
  const depth = Number(depthSelect.value);

  let shown = new Set(model.nodes
    .filter((n) => n.id === selectedId || (n.members ? n.members.some(memberShown) : passes(n)))
    .map((n) => n.id));
  if (depth > 0 && model.byId.has(selectedId)) {
    const hood = new Set([selectedId]);
    for (let i = 0; i < depth; i++) {
      for (const id of [...hood]) for (const nb of model.neighbours.get(id) || []) hood.add(nb);
    }
    shown = new Set([...shown].filter((id) => hood.has(id)));
  }
  // Judged after the other filters: a note linked only to hidden notes is unlinked too.
  if (hideIsolated.checked) {
    const before = shown;
    shown = new Set([...before].filter((id) => id === selectedId
      || [...(model.neighbours.get(id) || [])].some((nb) => before.has(nb))));
  }
  let count = 0;
  for (const id of [...shown]) {
    const n = model.byId.get(id);
    count += n.members ? n.members.filter(memberShown).length : 1;
    if (n.groupCat) shown.add(GROUP + n.groupCat); // its group box
  }
  visible = shown;
  $("#stats").textContent = `${count} of ${graph.nodes.length} notes`;
}

function matchesQuery(d, q) {
  if (d.members) return d.members.some((m) => matchesQuery(m, q));
  return d.title.toLowerCase().includes(q) || d.id.includes(q) || d.aliases.some((a) => a.includes(q));
}

function computeMatches() {
  const q = searchInput.value.trim().toLowerCase();
  matches = q ? new Set(model.nodes.filter((n) => matchesQuery(n, q)).map((n) => n.id)) : null;
}

// Recompute the model and redraw. `structure`: the nodes or edges changed
// (data, grouping, colours). `relayout`: true to re-run the layout from the
// current positions, "fresh" to start over. Hidden views catch up when shown.
function update({ structure = false, relayout = false } = {}) {
  if (structure) buildModel();
  computeVisibility();
  computeMatches();
  for (const [name, view] of Object.entries(views)) {
    view.pending = mergeChanges(view.pending, { structure, relayout });
    if (name === activeView && view.mounted) flush(view);
  }
}

function mergeChanges(a, b) {
  if (!a) return b;
  const strength = (r) => ({ false: 0, true: 1, fresh: 2 })[String(r)];
  return {
    structure: a.structure || b.structure,
    relayout: strength(a.relayout) >= strength(b.relayout) ? a.relayout : b.relayout,
  };
}

function flush(view) {
  const change = view.pending;
  view.pending = null;
  view.render(change || {});
}

function restyle() {
  computeMatches();
  const view = views[activeView];
  if (view.mounted) view.restyle();
}

function toggleGroup(cat) {
  if (!collapsed.delete(cat)) collapsed.add(cat);
  renderLegend();
  update({ structure: true, relayout: true });
}

// The 2D view.

function cyStyle() {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(colour)",
        label: "data(title)",
        color: css("--text-secondary"),
        "font-size": 11,
        "min-zoomed-font-size": 9,
        "text-valign": "bottom",
        "text-margin-y": 3,
        width: "mapData(degree, 0, 20, 10, 34)",
        height: "mapData(degree, 0, 20, 10, 34)",
        "border-width": 2,
        "border-color": css("--surface-1"),
      },
    },
    {
      selector: "node:parent",
      style: {
        shape: "round-rectangle",
        "background-opacity": 0.07,
        "border-width": 1,
        "border-color": "data(colour)",
        "border-opacity": 0.6,
        padding: 14,
        "text-valign": "top",
        "font-size": 14,
        "min-zoomed-font-size": 0,
      },
    },
    {
      selector: "node.collapsed",
      style: {
        shape: "round-rectangle",
        width: "mapData(size, 1, 100, 26, 80)",
        height: "mapData(size, 1, 100, 26, 80)",
        "text-valign": "bottom",
        "font-size": 14,
        "min-zoomed-font-size": 0,
        "font-weight": "bold",
        color: css("--text-primary"),
      },
    },
    {
      selector: "edge",
      style: {
        width: "mapData(count, 1, 10, 1.2, 4)",
        "line-color": css("--edge"),
        "target-arrow-color": css("--edge"),
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.7,
        "curve-style": "bezier",
      },
    },
    { selector: "edge[?both]", style: { "source-arrow-color": css("--edge"), "source-arrow-shape": "triangle" } },
    { selector: ".hidden", style: { display: "none" } },
    { selector: ".faded", style: { opacity: 0.15 } },
    {
      selector: "node:selected, node.match",
      style: { "border-color": css("--text-primary"), "border-width": 3, color: css("--text-primary"), "z-index": 10 },
    },
    {
      selector: "edge.incident",
      style: { "line-color": css("--text-secondary"), "target-arrow-color": css("--text-secondary"), width: 2 },
    },
    { selector: "edge.incident[?both]", style: { "source-arrow-color": css("--text-secondary") } },
  ];
}

function centroid(points) {
  if (!points.length) return null;
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
}

const cyView = {
  el: $("#graph-2d"),
  cy: null,
  pending: null,
  placed: new Set(), // ids that have been through a layout
  lastPos: new Map(), // id -> position, kept across rebuilds

  get mounted() { return this.cy !== null; },

  async mount() {
    const cy = (this.cy = cytoscape({
      container: this.el, elements: this.elements(), style: cyStyle(), wheelSensitivity: 0.3,
    }));
    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      if (n.hasClass("collapsed")) toggleGroup(n.data("cat"));
      else if (!n.isParent()) focusNote(n.id());
    });
    cy.on("dbltap", "node", (evt) => { if (evt.target.isParent()) toggleGroup(evt.target.data("cat")); });
    cy.on("tap", (evt) => { if (evt.target === cy) clearSelection(); });
    // Cytoscape only notices window resizes by itself.
    new ResizeObserver(() => cy.resize()).observe(this.el);
    this.applyVisibility();
    this.runLayout(true);
    this.restyle();
  },

  elements() {
    return [
      ...model.groups.map((g) => ({
        group: "nodes", data: { ...g, tags: [], aliases: [], degree: 0 }, selectable: false,
      })),
      ...model.nodes.map((n) => {
        if (n.members) return { group: "nodes", data: n, classes: "collapsed", selectable: false };
        return { group: "nodes", data: n.groupCat ? { ...n, parent: GROUP + n.groupCat } : n };
      }),
      ...model.edges.map((e) => ({ group: "edges", data: e })),
    ];
  },

  render({ structure = false, relayout = false }) {
    const cy = this.cy;
    if (structure) {
      // Replace the elements, keeping every note where it was.
      cy.nodes(":childless").forEach((n) => {
        if (this.placed.has(n.id())) this.lastPos.set(n.id(), { ...n.position() });
      });
      cy.elements().remove();
      cy.add(this.elements());
      cy.nodes(":childless").forEach((n) => {
        const members = n.data("members");
        const at = members
          ? centroid(members.map((m) => this.lastPos.get(m.id)).filter(Boolean))
          : this.lastPos.get(n.id());
        if (!at) return;
        n.position(at);
        this.placed.add(n.id());
      });
    }
    this.applyVisibility();
    if (relayout || cy.nodes(":childless:visible").some((n) => !this.placed.has(n.id()))) {
      this.runLayout(relayout === "fresh");
    }
    this.restyle();
  },

  applyVisibility() {
    this.cy.batch(() => this.cy.nodes().forEach((n) => { n.toggleClass("hidden", !visible.has(n.id())); }));
  },

  runLayout(initial) {
    const visibleEls = this.cy.elements(":visible");
    const notes = visibleEls.nodes(":childless");
    const known = notes.filter((n) => this.placed.has(n.id()));
    const randomize = initial || known.empty();
    if (!randomize) {
      // Notes shown for the first time start next to a neighbour, not piled at the origin.
      const box = known.boundingBox();
      notes.difference(known).forEach((n) => {
        const anchor = n.neighborhood().nodes().intersection(known)[0];
        const at = anchor ? anchor.position() : { x: box.x1 + Math.random() * box.w, y: box.y1 + Math.random() * box.h };
        n.position({ x: at.x + Math.random() * 40 - 20, y: at.y + Math.random() * 40 - 20 });
      });
    }
    notes.forEach((n) => this.placed.add(n.id()));
    visibleEls.layout({
      name: "fcose",
      randomize,
      animate: !randomize && visibleEls.length < 1500,
      animationDuration: 400,
      nodeRepulsion: 6000,
      idealEdgeLength: 60,
      nodeSeparation: 60,
      padding: 30,
    }).run();
  },

  // Search, selection and the selected note's edges.
  restyle() {
    const cy = this.cy;
    cy.batch(() => {
      cy.elements().removeClass("faded match incident");
      cy.nodes().unselect();
      if (matches) {
        const hits = cy.nodes(":childless").filter((n) => matches.has(n.id()));
        hits.addClass("match");
        // Fading a group box would fade the matches inside it too.
        cy.elements().not(":parent").difference(hits).difference(hits.edgesWith(hits)).addClass("faded");
      }
      const node = selectedId && cy.getElementById(selectedId);
      if (node && node.nonempty()) {
        node.select();
        node.connectedEdges().addClass("incident");
      }
    });
  },

  focus(id) {
    const node = this.cy.getElementById(id);
    if (node.nonempty() && visible.has(id)) {
      this.cy.animate({ center: { eles: node }, zoom: Math.max(this.cy.zoom(), 1) }, { duration: 300 });
    }
  },

  show() { this.cy.resize(); },
  hide() {},
  theme() { this.cy.style(cyStyle()); },
};

// The 3D view.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

// Pull the notes of each group towards the group's centroid while
// grouping, so each tag (or folder) forms its own region.
function clusterForce() {
  let nodes = [];
  function force(alpha) {
    if (!groupBox.checked) return;
    const centres = new Map();
    for (const n of nodes) {
      if (!n.groupCat) continue;
      let c = centres.get(n.groupCat);
      if (!c) centres.set(n.groupCat, (c = { x: 0, y: 0, z: 0, count: 0 }));
      c.x += n.x; c.y += n.y; c.z += n.z || 0; c.count++;
    }
    const k = alpha * 0.25;
    for (const n of nodes) {
      const c = n.groupCat && centres.get(n.groupCat);
      if (!c || c.count < 2) continue;
      n.vx += (c.x / c.count - n.x) * k;
      n.vy += (c.y / c.count - n.y) * k;
      n.vz += (c.z / c.count - (n.z || 0)) * k;
    }
  }
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

function centroid3(points) {
  const known = points.filter((p) => p && p.x !== undefined);
  if (!known.length) return null;
  const mean = (k) => known.reduce((s, p) => s + (p[k] || 0), 0) / known.length;
  return { x: mean("x"), y: mean("y"), z: mean("z") };
}

const fgView = {
  el: $("#graph-3d"),
  fg: null,
  mounting: null,
  pending: null,
  hoverId: null,
  framed: false,
  // Node objects persist across updates, so the simulation keeps their
  // positions instead of starting over.
  nodeById: new Map(),
  lastPos: new Map(), // positions of notes folded into a collapsed group
  links: [],
  shownKey: "",

  get mounted() { return this.fg !== null; },

  mount() {
    this.mounting ||= this.load();
    return this.mounting;
  },

  async load() {
    try {
      if (typeof ForceGraph3D === "undefined") await loadScript(FORCE_GRAPH_URL);
    } catch (e) {
      this.el.innerHTML = `<p class="notice">The 3D view is unavailable: ${escapeHtml(e.message)}</p>`;
      this.mounting = null;
      return;
    }
    const el = this.el;
    const fg = ForceGraph3D()(el)
      .backgroundColor(css("--surface-1"))
      .showNavInfo(false)
      .nodeId("id")
      .nodeLabel((n) => `<div class="node-tip">${escapeHtml(n.title)}<br><span>${n.members
        ? "group · click to expand"
        : n.id + (n.tags.length ? " · " + escapeHtml(n.tags.join(" ")) : "")}</span></div>`)
      .nodeVal((n) => (n.members ? 4 + n.size / 2 : 1 + n.degree))
      .nodeRelSize(3)
      .nodeOpacity(0.95)
      .nodeColor((n) => this.nodeColour(n))
      .linkColor((l) => this.linkColour(l))
      .linkWidth((l) => (this.incident(l) ? 1.2 : l.count > 1 ? Math.min(l.count, 10) * 0.3 : 0))
      // One arrowhead per link only; two-way links get none.
      .linkDirectionalArrowLength((l) => (l.both ? 0 : 2.5))
      .linkDirectionalArrowRelPos(1)
      .onNodeClick((n) => (n.members ? toggleGroup(n.cat) : focusNote(n.id)))
      .onNodeHover((n) => {
        this.hoverId = n ? n.id : null;
        el.style.cursor = n ? "pointer" : "";
        this.restyle();
      })
      .onBackgroundClick(() => clearSelection())
      // Frame the whole graph once the first layout settles, unless a note is in focus.
      .onEngineStop(() => {
        if (this.framed) return;
        this.framed = true;
        if (!selectedId) fg.zoomToFit(600, 20);
      });
    fg.d3Force("charge").strength(-40);
    fg.d3Force("link").distance(30);
    fg.d3Force("cluster", clusterForce());
    new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight) fg.width(el.clientWidth).height(el.clientHeight);
    }).observe(el);
    this.fg = fg;
    this.render({ structure: true });
  },

  sync() {
    const fresh = new Set(model.nodes.map((n) => n.id));
    for (const [id, n] of this.nodeById) {
      if (fresh.has(id)) continue;
      if (n.x !== undefined) this.lastPos.set(id, { x: n.x, y: n.y, z: n.z });
      this.nodeById.delete(id);
    }
    for (const n of model.nodes) {
      const existing = this.nodeById.get(n.id);
      if (existing) { Object.assign(existing, n); continue; }
      const node = { ...n };
      // A collapsed group starts where its notes were; a re-shown note where it was.
      const at = n.members
        ? centroid3(n.members.map((m) => this.nodeById.get(m.id) || this.lastPos.get(m.id)))
        : this.lastPos.get(n.id);
      if (at) Object.assign(node, at);
      this.nodeById.set(n.id, node);
    }
    this.links = model.edges.map((e) => ({ ...e }));
    this.shownKey = ""; // links are new objects, so they must be handed over
  },

  render({ structure = false, relayout = false }) {
    if (structure) this.sync();
    const ids = model.nodes.filter((n) => visible.has(n.id)).map((n) => n.id);
    const key = ids.join(",");
    if (key !== this.shownKey) {
      // Every graphData call reheats the simulation, so only when needed.
      this.shownKey = key;
      this.fg.graphData({
        nodes: ids.map((id) => this.nodeById.get(id)),
        links: this.links.filter((l) => visible.has(idOf(l.source)) && visible.has(idOf(l.target))),
      });
    } else if (relayout) {
      this.fg.d3ReheatSimulation();
    }
    this.restyle();
  },

  // A selected note keeps its neighbours at full strength and fades the
  // rest; a search fades everything that doesn't match.
  emphasised(id) {
    if (matches) return matches.has(id);
    if (!selectedId) return true;
    return id === selectedId || (model.neighbours.get(selectedId) || new Set()).has(id);
  },

  nodeColour(n) {
    if (n.id === selectedId || n.id === this.hoverId) return css("--text-primary");
    return this.emphasised(n.id) ? n.colour : withAlpha(n.colour, 0.12);
  },

  incident(l) {
    return selectedId && (idOf(l.source) === selectedId || idOf(l.target) === selectedId);
  },

  linkColour(l) {
    if (this.incident(l)) return css("--text-secondary");
    return withAlpha(css("--edge"), matches || selectedId ? 0.08 : 0.5);
  },

  restyle() {
    const fg = this.fg;
    fg.nodeColor(fg.nodeColor()).linkColor(fg.linkColor()).linkWidth(fg.linkWidth());
  },

  // Fly the camera to a node, once the simulation has given it a position.
  focus(id, attempts = 20) {
    const n = this.nodeById.get(id);
    if (!n || !visible.has(id)) return;
    if (n.x === undefined) {
      if (attempts > 0) setTimeout(() => this.focus(id, attempts - 1), 150);
      return;
    }
    const ratio = 1 + 120 / (Math.hypot(n.x, n.y, n.z || 0) || 1);
    this.fg.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: (n.z || 0) * ratio }, n, 1000);
  },

  show() { this.fg.resumeAnimation(); },
  hide() { this.fg.pauseAnimation(); },
  theme() {
    this.fg.backgroundColor(css("--surface-1"));
    this.restyle();
  },
};

// Tabs.

const views = { "2d": cyView, "3d": fgView };
let activeView = views[localStorage.getItem(VIEW_KEY)] ? localStorage.getItem(VIEW_KEY) : "2d";

async function showView(name) {
  activeView = name;
  localStorage.setItem(VIEW_KEY, name);
  for (const tab of document.querySelectorAll("#view-tabs [role=tab]")) {
    const selected = tab.dataset.view === name;
    tab.setAttribute("aria-selected", selected);
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const [other, view] of Object.entries(views)) {
    view.el.hidden = other !== name;
    if (other !== name && view.mounted) view.hide();
  }
  const view = views[name];
  if (!view.mounted) {
    view.pending = null; // mounting draws the current model
    await view.mount();
    if (activeView !== name || !view.mounted) return;
  } else {
    view.show();
    flush(view);
  }
  if (selectedId) view.focus(selectedId);
}

$("#view-tabs").addEventListener("click", (evt) => {
  const tab = evt.target.closest("[role=tab]");
  if (tab && tab.dataset.view !== activeView) showView(tab.dataset.view);
});
$("#view-tabs").addEventListener("keydown", (evt) => {
  if (evt.key !== "ArrowLeft" && evt.key !== "ArrowRight") return;
  const tabs = [...document.querySelectorAll("#view-tabs [role=tab]")];
  const next = tabs[(tabs.findIndex((t) => t.dataset.view === activeView) + 1) % tabs.length];
  next.focus();
  showView(next.dataset.view);
});

// Data, selection and the note panel.

async function loadGraph() {
  // Fetch everything and filter client-side, so colours stay stable.
  const res = await fetch("/api/graph?exclude_tags=");
  graph = await res.json();
  assignSlots();
  renderLegend();
  renderProblems();
  update({ structure: true });
}

function renderProblems() {
  const box = $("#problems");
  if (!graph.problems.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<details><summary>${graph.problems.length} problem(s) in the note tree</summary><ul>${
    graph.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></details>`;
}

// Select a note: load its panel, centre the graph on it, update the URL.
async function focusNote(id, { push = true } = {}) {
  selectedId = id;
  if (push && location.pathname !== `/note/${id}`) history.pushState({ id }, "", `/note/${id}`);
  // Opening a note inside a collapsed group expands the group.
  const note = graph.nodes.find((n) => n.id === id);
  const expand = Boolean(note && collapsed.delete(groupOf(note)));
  if (expand) renderLegend();
  update({ structure: expand, relayout: expand || Number(depthSelect.value) > 0 });
  const view = views[activeView];
  if (view.mounted) view.focus(id);
  await loadPanel(id);
}

function clearSelection() {
  selectedId = null;
  update();
  history.pushState({}, "", "/");
}

async function loadPanel(id, { keepScroll = false } = {}) {
  const panel = $("#panel");
  const scroll = panel.scrollTop;
  panel.classList.add("loading");
  try {
    await htmx.ajax("GET", `/note/${id}/view`, { target: "#panel", swap: "innerHTML" });
    panel.scrollTop = keepScroll ? scroll : 0;
  } finally {
    panel.classList.remove("loading");
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

// Draggable divider between the graph and the panel; the width is remembered.
const splitter = $("#splitter");
const PANEL_WIDTH_KEY = "notation-server.panelWidth";

function setPanelWidth(px) {
  const main = $("main");
  const width = Math.round(Math.min(Math.max(px, 280), main.clientWidth - 280));
  main.style.setProperty("--panel-width", `${width}px`);
  return width;
}

const savedWidth = Number(localStorage.getItem(PANEL_WIDTH_KEY));
if (savedWidth) setPanelWidth(savedWidth);

splitter.addEventListener("pointerdown", (evt) => {
  evt.preventDefault(); // no text selection while dragging
  // Capture keeps the drag going over the panel's PDF iframes.
  splitter.setPointerCapture(evt.pointerId);
  splitter.classList.add("dragging");
});
splitter.addEventListener("pointermove", (evt) => {
  if (!splitter.hasPointerCapture(evt.pointerId)) return;
  setPanelWidth($("main").getBoundingClientRect().right - evt.clientX);
});
splitter.addEventListener("lostpointercapture", () => {
  splitter.classList.remove("dragging");
  localStorage.setItem(PANEL_WIDTH_KEY, $("#panel").offsetWidth);
});
splitter.addEventListener("keydown", (evt) => {
  const step = { ArrowLeft: 40, ArrowRight: -40 }[evt.key];
  if (!step) return;
  evt.preventDefault();
  localStorage.setItem(PANEL_WIDTH_KEY, setPanelWidth($("#panel").offsetWidth + step));
});
splitter.addEventListener("dblclick", () => {
  $("main").style.removeProperty("--panel-width");
  localStorage.removeItem(PANEL_WIDTH_KEY);
});

// notation: links inside a rendered note open in the panel, not a new page.
$("#panel").addEventListener("click", (evt) => {
  const a = evt.target.closest("a[data-note-id]");
  if (!a || evt.metaKey || evt.ctrlKey) return;
  evt.preventDefault();
  focusNote(a.dataset.noteId);
});

$("#panel").addEventListener("click", (evt) => {
  const button = evt.target.closest("[data-fold]");
  if (!button) return;
  const open = button.dataset.fold === "open";
  for (const d of $("#panel").querySelectorAll("details.section:not(.empty)")) d.open = open;
});

document.body.addEventListener("htmx:afterRequest", (evt) => {
  const xhr = evt.detail.xhr;
  if (evt.detail.requestConfig.verb !== "post") return;
  if (evt.detail.successful) toast("Opened in Emacs");
  else {
    let detail = xhr.statusText;
    try { detail = JSON.parse(xhr.responseText).detail; } catch (_) { /* keep statusText */ }
    toast(`Could not open in Emacs: ${detail}`);
  }
});

// Controls.

searchInput.addEventListener("input", restyle);
searchInput.addEventListener("keydown", (evt) => {
  if (evt.key !== "Enter" || !matches) return;
  const hit = model.nodes.find((n) => matches.has(n.id) && visible.has(n.id));
  if (!hit) return;
  const q = searchInput.value.trim().toLowerCase();
  focusNote(hit.members ? hit.members.find((m) => matchesQuery(m, q)).id : hit.id);
});
colourBy.addEventListener("change", () => {
  assignSlots();
  collapsed.clear();
  renderLegend();
  update({ structure: true, relayout: groupBox.checked && "fresh" });
});
groupBox.addEventListener("change", () => {
  renderLegend();
  update({ structure: true, relayout: "fresh" });
});
$("#legend").addEventListener("click", (evt) => {
  const button = evt.target.closest("button");
  if (!button) return;
  const { key, group, reset } = button.dataset;
  if (group !== undefined) { toggleGroup(group); return; }
  if (button.classList.contains("more")) {
    legendExpanded = !legendExpanded;
  } else if (key !== undefined) {
    const set = hidden[colourBy.value];
    if (!set.delete(key)) set.add(key);
  } else if (reset) {
    hidden[reset].clear();
  }
  renderLegend();
  if (!button.classList.contains("more")) update({ relayout: true });
});
for (const input of [depthSelect, hideIsolated, fromInput, toInput]) {
  input.addEventListener("change", () => update({ relayout: true }));
}
window.addEventListener("popstate", (evt) => {
  if (evt.state && evt.state.id) focusNote(evt.state.id, { push: false });
  else { selectedId = null; update(); }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  renderLegend();
  update({ structure: true }); // node colours come from the theme
  for (const view of Object.values(views)) if (view.mounted) view.theme();
});

function connectEvents() {
  const es = new EventSource("/events");
  es.addEventListener("index-changed", async () => {
    await loadGraph();
    if (selectedId) loadPanel(selectedId, { keepScroll: true });
  });
  es.addEventListener("focus", (evt) => focusNote(JSON.parse(evt.data).id));
}

(async () => {
  await loadGraph();
  await showView(activeView);
  connectEvents();
  if (cfg.initialId) {
    history.replaceState({ id: cfg.initialId }, "", `/note/${cfg.initialId}`);
    focusNote(cfg.initialId, { push: false });
  }
})();
