// Graph of notes (3d-force-graph) + note panel (HTMX) with a graph of the
// note's neighbours (Cytoscape) + live updates (SSE).
//
// The controls build one model of the whole graph: which notes and edges
// exist (after grouping), which are visible, and which match the search;
// the 3D view draws it. The panel's neighbour graph ignores the controls.
"use strict";

const cfg = JSON.parse(document.getElementById("config").textContent);
const SLOTS = 8; // categorical colour slots; further categories fold into "other"
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const GROUP = "group:"; // id prefix of collapsed groups

let selectedId = null;
let graph = { nodes: [], edges: [], problems: [] };
let slotOf = new Map(); // category -> slot index, fixed from the whole corpus
let collapsed = new Set(); // categories drawn as a single node while grouping

// What the 3D view draws: `nodes` are notes and collapsed groups.
let model = { nodes: [], edges: [], byId: new Map(), neighbours: new Map() };
let visible = new Set(); // ids of visible nodes
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

  const nodes = [
    ...[...members].map(([g, ms]) => ({
      id: GROUP + g, cat: g, title: `${g} (${ms.length})`, colour: colourFor(g),
      tags: [], aliases: [], members: ms, size: ms.length, degree: degree(GROUP + g),
    })),
    ...graph.nodes.filter((n) => !standIn.has(n.id)).map((n) => ({
      ...n, colour: colourFor(category(n)), degree: degree(n.id), groupCat: groupOf(n),
    })),
  ];
  model = { nodes, edges, byId: new Map(nodes.map((n) => [n.id, n])), neighbours };
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
  for (const id of shown) {
    const n = model.byId.get(id);
    count += n.members ? n.members.filter(memberShown).length : 1;
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
// (data, grouping, colours). `relayout`: reheat the simulation.
function update({ structure = false, relayout = false } = {}) {
  if (structure) buildModel();
  computeVisibility();
  computeMatches();
  if (graphView.mounted) graphView.render({ structure, relayout });
}

function restyle() {
  computeMatches();
  if (graphView.mounted) graphView.restyle();
}

function toggleGroup(cat) {
  if (!collapsed.delete(cat)) collapsed.add(cat);
  renderLegend();
  update({ structure: true, relayout: true });
}

// The 3D graph.

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

const graphView = {
  el: $("#graph"),
  fg: null,
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
    if (typeof ForceGraph3D === "undefined") {
      this.el.innerHTML = `<p class="notice">The graph is unavailable: 3d-force-graph did not load.</p>`;
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
      // The library multiplies the colour's alpha by this (default 0.2);
      // at 1, the alpha in linkColour is the opacity drawn.
      .linkOpacity(1)
      .linkWidth((l) => (this.incident(l) ? 0.6 : l.count > 1 ? Math.min(l.count, 10) * 0.3 : 0))
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
    if (this.incident(l)) return withAlpha(css("--text-secondary"), 0.7);
    return withAlpha(css("--edge"), matches || selectedId ? 0.1 : 0.3);
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

  theme() {
    this.fg.backgroundColor(css("--surface-1"));
    this.restyle();
  },
};

// The note panel's graph of the open note and its nearest neighbours: every
// note it links to or that links to it, whatever the controls hide. Past
// NEIGHBOUR_LIMIT, only the closest are drawn unless asked for all.

const NEIGHBOUR_LIMIT = 30;
const MISSING = "missing:"; // id prefix of links to notes that don't exist
const neighbourGraph = { cy: null, observer: null, noteId: null, showAll: false };

function neighbourStyle() {
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(colour)",
        label: "data(title)",
        color: css("--text-secondary"),
        "font-size": 11,
        "text-valign": "bottom",
        "text-margin-y": 3,
        "text-wrap": "ellipsis",
        "text-max-width": "120px",
        width: 12,
        height: 12,
        "border-width": 2,
        "border-color": css("--surface-1"),
      },
    },
    {
      selector: "node.centre",
      style: {
        width: 22, height: 22, "font-size": 12, "font-weight": "bold",
        color: css("--text-primary"), "border-color": css("--text-primary"),
      },
    },
    {
      selector: "node.missing",
      style: {
        "background-opacity": 0, "border-style": "dashed", "border-color": css("--critical"),
        color: css("--critical"),
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.3,
        "line-color": css("--text-muted"),
        "target-arrow-color": css("--text-muted"),
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
      },
    },
    { selector: "edge[?both]", style: { "source-arrow-color": css("--text-muted"), "source-arrow-shape": "triangle" } },
    // Links between two neighbours, for context.
    { selector: "edge.between", style: { width: 1, "line-color": css("--edge"), "target-arrow-color": css("--edge"),
      "source-arrow-color": css("--edge"), opacity: 0.6 } },
    { selector: "edge.missing", style: { "line-style": "dashed", "line-color": css("--critical"),
      "target-arrow-color": css("--critical") } },
  ];
}

function renderNeighbours() {
  const ng = neighbourGraph;
  if (ng.cy) { ng.cy.destroy(); ng.cy = null; }
  if (ng.observer) { ng.observer.disconnect(); ng.observer = null; }
  const el = $("#panel .neighbours");
  if (!el) return;
  const id = el.dataset.noteId;
  if (id !== ng.noteId) { ng.noteId = id; ng.showAll = false; }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const note = byId.get(id);
  if (!note) return;

  const out = new Set();
  const into = new Set();
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
    if (e.source === id) out.add(e.target);
    if (e.target === id) into.add(e.source);
  }
  // Closest first: linked both ways, then the best connected.
  const both = (n) => (out.has(n) && into.has(n) ? 1 : 0);
  const ranked = [...new Set([...out, ...into])].sort((a, b) => both(b) - both(a)
    || (degree.get(b) || 0) - (degree.get(a) || 0) || byId.get(a).title.localeCompare(byId.get(b).title));
  const shown = ng.showAll ? ranked : ranked.slice(0, NEIGHBOUR_LIMIT);
  const missing = note.broken || [];

  // The cut-off notice and its toggle.
  let bar = el.parentElement.querySelector(".neighbours-cut");
  if (ranked.length > NEIGHBOUR_LIMIT) {
    if (!bar) {
      bar = document.createElement("p");
      bar.className = "neighbours-cut muted";
      el.before(bar);
    }
    bar.innerHTML = ng.showAll
      ? `All ${ranked.length} neighbours · <button type="button">show the closest ${NEIGHBOUR_LIMIT}</button>`
      : `The closest ${NEIGHBOUR_LIMIT} of ${ranked.length} neighbours · <button type="button">show all</button>`;
  } else if (bar) {
    bar.remove();
  }

  const keep = new Set([id, ...shown]);
  const ring = [...shown, ...missing.map((m) => MISSING + m)];
  const node = (n, classes = "") => ({
    group: "nodes", data: { id: n.id, title: n.title, colour: colourFor(category(n)) }, classes,
  });
  const elements = [
    node(note, "centre"),
    ...shown.map((n) => node(byId.get(n))),
    ...missing.map((m) => ({ group: "nodes", data: { id: MISSING + m, title: `missing ${m}` }, classes: "missing" })),
    ...mergedEdges(graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target))).map((e) => ({
      group: "edges", data: e, classes: e.source === id || e.target === id ? "" : "between",
    })),
    ...missing.map((m) => ({
      group: "edges", data: { id: `${id}>${MISSING}${m}`, source: id, target: MISSING + m }, classes: "missing",
    })),
  ];
  const count = shown.length + missing.length;
  // Kept short: it sits above the note's own content.
  el.style.height = `${count <= 8 ? 200 : count <= 20 ? 260 : 320}px`;

  // Fixed zoom and pan, so scrolling over it scrolls the panel; nodes can still be dragged.
  const cy = (ng.cy = cytoscape({
    container: el,
    elements,
    style: neighbourStyle(),
    userZoomingEnabled: false,
    userPanningEnabled: false,
    boxSelectionEnabled: false,
    autounselectify: true,
    layout: { name: "preset", fit: false },
  }));
  // The note in the middle and its neighbours on an ellipse filling the box,
  // closest first from the top, at a readable zoom. Past 14 they alternate
  // between an outer and an inner ellipse, to give the labels room.
  const place = () => {
    const w = cy.width();
    const h = cy.height();
    const rx = Math.max(60, w / 2 - 75); // room for a label either side
    const ry = Math.max(40, h / 2 - 28); // and for the label below
    cy.batch(() => {
      ring.forEach((nid, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
        const k = ring.length > 14 && i % 2 ? 0.6 : 1;
        cy.getElementById(nid).position({ x: rx * k * Math.cos(angle), y: ry * k * Math.sin(angle) });
      });
      cy.getElementById(id).position({ x: 0, y: 0 });
    });
    cy.zoom(1);
    cy.pan({ x: w / 2, y: h / 2 });
  };
  place();
  const clickable = (n) => !n.hasClass("centre") && !n.hasClass("missing");
  cy.on("tap", "node", (evt) => { if (clickable(evt.target)) focusNote(evt.target.id()); });
  cy.on("mouseover", "node", (evt) => { el.style.cursor = clickable(evt.target) ? "pointer" : ""; });
  cy.on("mouseout", "node", () => { el.style.cursor = ""; });
  ng.observer = new ResizeObserver(() => { cy.resize(); place(); });
  ng.observer.observe(el);
}

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
  if (graphView.mounted) graphView.focus(id);
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

// Draw the neighbour graph whenever a note lands in the panel.
$("#panel").addEventListener("htmx:afterSwap", renderNeighbours);

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

$("#panel").addEventListener("click", (evt) => {
  if (!evt.target.closest(".neighbours-cut button")) return;
  neighbourGraph.showAll = !neighbourGraph.showAll;
  renderNeighbours();
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
  update({ structure: true, relayout: groupBox.checked });
  renderNeighbours(); // node colours follow the colour-by mode
});
groupBox.addEventListener("change", () => {
  renderLegend();
  update({ structure: true, relayout: true });
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
  if (graphView.mounted) graphView.theme();
  renderNeighbours();
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
  graphView.mount();
  connectEvents();
  if (cfg.initialId) {
    history.replaceState({ id: cfg.initialId }, "", `/note/${cfg.initialId}`);
    focusNote(cfg.initialId, { push: false });
  }
})();
