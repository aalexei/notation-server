// Graph of notes (3d-force-graph) + note panel (HTMX) with a graph of the
// note's neighbours (Cytoscape) + live updates (SSE).
//
// The search box builds one model of the whole graph: which notes and
// edges exist (after collapsing), which are visible, and which match; the
// 3D view draws it. The panel's neighbour graph ignores the search box.
"use strict";

const cfg = JSON.parse(document.getElementById("config").textContent);
const SLOTS = 16; // categorical colour slots (--series-N in app.css); further tags fold into "other"
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const GROUP = "group:"; // id prefix of collapsed groups
const UNTAGGED = "(untagged)";

let selectedId = null;
let graph = { nodes: [], edges: [], problems: [] };
let slotOf = new Map(); // tag -> colour slot, fixed from the whole corpus
let tagCounts = new Map(); // tag -> number of notes with it

// What the 3D view draws: `nodes` are notes and collapsed groups.
let model = { nodes: [], edges: [], byId: new Map(), neighbours: new Map() };
let visible = new Set(); // ids of visible nodes
let matches = null; // ids matching the search words, or null when there are none

const $ = (sel) => document.querySelector(sel);
const searchInput = $("#search");
const depthSelect = $("#depth");
const hideIsolated = $("#hide-isolated");
const clusterBox = $("#cluster");
const titlesBox = $("#titles");

// Titles are remembered between visits.
const VIEW_PREFS_KEY = "notation-server.graphView";
const viewPrefs = JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || "{}");
titlesBox.checked = Boolean(viewPrefs.titles);
const saveViewPrefs = () => localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify({ titles: titlesBox.checked }));

// three-spritetext draws the titles, and three.js the orbit-centre marker.
// 3d-force-graph doesn't share its copy of three.js, so these load a second
// one, pinned to the same release (both URLs resolve to the same module).
const SPRITE_TEXT_URL = "https://esm.sh/three-spritetext@1.10.0?deps=three@0.186.0";
const THREE_URL = "https://esm.sh/three@0.186.0";

const idOf = (end) => (typeof end === "object" ? end.id : end);

// A note's tags, as used everywhere here: its own tags, then one for each
// level of the folder it is filed in, ending in "/". A note filed in
// journal/2025 also has the tags "journal/" and "journal/2025/".
function tagsOf(note) {
  const parts = note.subdir ? note.subdir.split("/") : [];
  const folders = parts.map((_, i) => `${parts.slice(0, i + 1).join("/")}/`);
  return [...note.tags, ...folders].map((t) => t.toLowerCase());
}

// A note's colour comes from its first tag.
const category = (note) => note.allTags[0] || UNTAGGED;

// Colour follows the tag, not its rank in the current view: slots go to the
// tags that are most often first, once, from the whole corpus.
function assignSlots() {
  const counts = new Map();
  for (const n of graph.nodes) counts.set(category(n), (counts.get(category(n)) || 0) + 1);
  const ranked = [...counts.entries()]
    .filter(([c]) => c !== UNTAGGED)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SLOTS);
  slotOf = new Map(ranked.map(([c], i) => [c, i]));
}

function colourFor(tag) {
  return slotOf.has(tag) ? css(`--series-${slotOf.get(tag) + 1}`) : css("--other");
}

function withAlpha(hex, alpha) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The search box, the one place the graph is filtered:
//
//   words                highlight the notes whose title, aliases or id
//                        contain them all, in any order
//   A..B                 keep the notes created in a range of id beginnings
//                        (ids start YYYYMMDDhhmmss), both ends included,
//                        either open: 2026..  ..202609  20260901..20260930
//   #tag  -#tag  ~#tag   keep only / hide / collapse into one node the notes
//                        with a tag; folders are tags ending in "/": -#journal/
//
// A note in two collapsed tags goes into the one named first.

function parseSearch(value) {
  const s = { words: [], ranges: [], only: [], hide: [], fold: [], unknown: [] };
  for (const token of value.split(/\s+/).filter(Boolean)) {
    let m = token.match(/^(\d*)\.\.(\d*)$/);
    if (m && (m[1] || m[2])) { s.ranges.push({ from: m[1], to: m[2] }); continue; }
    m = token.match(/^([-~]?)#(.*)$/);
    if (!m) { s.words.push(token.toLowerCase()); continue; }
    const tag = m[2].toLowerCase();
    if (!tag) continue; // a "#" still being typed
    // Unknown tags (typos, or a tag half typed) are reported, not applied.
    if (!tagCounts.has(tag)) s.unknown.push(m[1] + "#" + tag);
    else ({ "": s.only, "-": s.hide, "~": s.fold })[m[1]].push(tag);
  }
  s.fold = [...new Set(s.fold)];
  return s;
}

// An id is in a range if it doesn't sort before FROM, and its beginning,
// as long as TO, doesn't sort after TO.
const inRange = (id, { from, to }) => (!from || id >= from) && (!to || id.slice(0, to.length) <= to);

// "202609" -> "2026-09", for the range shown next to the note count.
const showPrefix = (p) => [p.slice(0, 4), p.slice(4, 6), p.slice(6, 8)].filter(Boolean).join("-") + p.slice(8);

function describeRange({ from, to }) {
  if (!from) return `created up to ${showPrefix(to)}`;
  if (!to) return `created from ${showPrefix(from)}`;
  return `created ${showPrefix(from)} – ${showPrefix(to)}`;
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
  // The notes of a collapsed tag are replaced by one node standing in for them.
  const { fold } = parseSearch(searchInput.value);
  const standIn = new Map();
  const members = new Map();
  for (const n of graph.nodes) {
    const g = fold.find((t) => n.allTags.includes(t));
    if (!g) continue;
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
    ...fold.filter((g) => members.has(g)).map((g) => ({
      id: GROUP + g, cat: g, title: `${g} (${members.get(g).length})`, colour: colourFor(g),
      tags: [], allTags: [], aliases: [], members: members.get(g), size: members.get(g).length, degree: degree(GROUP + g),
    })),
    ...graph.nodes.filter((n) => !standIn.has(n.id)).map((n) => ({
      ...n, colour: colourFor(category(n)), degree: degree(n.id),
    })),
  ];
  model = { nodes, edges, byId: new Map(nodes.map((n) => [n.id, n])), neighbours };
}

function noteFilter() {
  const { ranges, only, hide } = parseSearch(searchInput.value);
  return (d) => !hide.some((t) => d.allTags.includes(t)) && only.every((t) => d.allTags.includes(t))
    && ranges.every((r) => inRange(d.id, r));
}

function computeVisibility() {
  const passes = noteFilter();
  // "Unlinked" is judged on the whole graph: a note with any link at all
  // stays, even when the notes it links to are filtered out.
  const linked = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const noteShown = (m) => passes(m) && (!hideIsolated.checked || linked.has(m.id));
  const depth = Number(depthSelect.value);

  let shown = new Set(model.nodes
    .filter((n) => n.id === selectedId || (n.members ? n.members.some(noteShown) : noteShown(n)))
    .map((n) => n.id));
  if (depth > 0 && model.byId.has(selectedId)) {
    const hood = new Set([selectedId]);
    for (let i = 0; i < depth; i++) {
      for (const id of [...hood]) for (const nb of model.neighbours.get(id) || []) hood.add(nb);
    }
    shown = new Set([...shown].filter((id) => hood.has(id)));
  }
  let count = 0;
  for (const id of shown) {
    const n = model.byId.get(id);
    count += n.members ? n.members.filter(noteShown).length : 1;
  }
  visible = shown;
  const { ranges, unknown } = parseSearch(searchInput.value);
  $("#stats").textContent = [
    `${count} of ${graph.nodes.length} notes`,
    ...ranges.map(describeRange),
    ...(unknown.length ? [`no such tag: ${unknown.join(" ")}`] : []),
  ].join(" · ");
}

// Every word must be part of the title, an alias or the id, in any order.
function matchesQuery(d, words) {
  if (d.members) return d.members.some((m) => matchesQuery(m, words));
  const fields = [d.title, d.id, ...d.aliases].map((s) => s.toLowerCase());
  return words.every((w) => fields.some((f) => f.includes(w)));
}

function computeMatches() {
  const { words } = parseSearch(searchInput.value);
  matches = words.length ? new Set(model.nodes.filter((n) => matchesQuery(n, words)).map((n) => n.id)) : null;
}

// Recompute the model and redraw. `structure`: the nodes or edges changed
// (data, collapsing, colours). `relayout`: reheat the simulation.
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

// Apply the search box. Collapsing changes the model's structure, the
// other terms only what is shown; neither is redone if unchanged.
const applied = { filters: null, fold: null };
function applySearch() {
  const { ranges, only, hide, fold } = parseSearch(searchInput.value);
  const filters = JSON.stringify({ ranges, only, hide });
  const folds = JSON.stringify(fold);
  renderLegend();
  if (folds !== applied.fold) {
    Object.assign(applied, { filters, fold: folds });
    update({ structure: true, relayout: true });
  } else if (filters !== applied.filters) {
    applied.filters = filters;
    update({ relayout: true });
  } else {
    restyle();
  }
}

// Add or remove one term ("-#ref", "~#project") in the search box and apply it.
function setTerm(term, on) {
  const tokens = searchInput.value.split(/\s+/).filter(Boolean);
  const has = tokens.some((t) => t.toLowerCase() === term);
  const rest = tokens.filter((t) => t.toLowerCase() !== term);
  searchInput.value = [...rest, ...((on ?? !has) ? [term] : [])].join(" ");
  applySearch();
}

// The legend: the coloured tags and "other". Clicking a tag hides or shows
// its notes (-#tag in the search box); shift-clicking collapses or expands
// them (~#tag). How it looks follows the search box.
function renderLegend() {
  const { only, hide, fold } = parseSearch(searchInput.value);
  const swatch = (colour) => `<span class="swatch" style="background:${colour}"></span>`;
  const items = [...slotOf.keys()].map((t) => {
    const off = hide.includes(t);
    const folded = fold.includes(t);
    const classes = ["entry", off && "off", folded && "folded", only.includes(t) && "only"].filter(Boolean).join(" ");
    return `<button type="button" class="${classes}" data-tag="${escapeHtml(t)}" aria-pressed="${!off}"
        title="Click to ${off ? "show" : "hide"}, shift-click to ${folded ? "expand" : "collapse"}">${
        swatch(colourFor(t))}${escapeHtml(t)} <span class="count">${tagCounts.get(t) || 0}</span></button>`;
  });
  items.push(`<span class="entry other">${swatch(css("--other"))}other</span>`);
  $("#legend").innerHTML = items.join("");
}

// The 3D graph.

// With "Cluster by tag", pull each note towards the centre of every tag it
// has, folders included, so the notes sharing a tag gather together; notes
// without tags gather as a group of their own. A note with several tags is
// pulled towards each equally, so it settles between them, and a note in
// journal/2025/ sits in that cluster, inside the journal/ one. Collapsed
// groups aren't pulled.
function clusterForce() {
  let nodes = [];
  const clusterTags = (n) => (n.allTags.length ? n.allTags : [UNTAGGED]);
  function force(alpha) {
    if (!clusterBox.checked) return;
    const centres = new Map();
    for (const n of nodes) {
      if (n.members) continue;
      for (const t of clusterTags(n)) {
        let c = centres.get(t);
        if (!c) centres.set(t, (c = { x: 0, y: 0, z: 0, count: 0 }));
        c.x += n.x; c.y += n.y; c.z += n.z || 0; c.count++;
      }
    }
    const k = alpha * 0.25;
    for (const n of nodes) {
      if (n.members) continue;
      const cs = clusterTags(n).map((t) => centres.get(t)).filter((c) => c.count >= 2);
      for (const c of cs) {
        n.vx += ((c.x / c.count - n.x) * k) / cs.length;
        n.vy += ((c.y / c.count - n.y) * k) / cs.length;
        n.vz += ((c.z / c.count - (n.z || 0)) * k) / cs.length;
      }
    }
  }
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

// A title longer than TITLE_WRAP characters is split over two lines, at the
// space nearest its middle; one without spaces stays on one line.
const TITLE_WRAP = 28;
function wrapTitle(title) {
  if (title.length <= TITLE_WRAP) return title;
  let split = -1;
  for (let i = title.indexOf(" "); i !== -1; i = title.indexOf(" ", i + 1)) {
    if (split < 0 || Math.abs(i - title.length / 2) < Math.abs(split - title.length / 2)) split = i;
  }
  return split < 0 ? title : `${title.slice(0, split)}\n${title.slice(split + 1)}`;
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
  SpriteText: null, // three-spritetext, once loaded
  titles: new Map(), // note id -> its title sprite, while titles are shown
  // Node objects persist across updates, so the simulation keeps their
  // positions instead of starting over.
  nodeById: new Map(),
  lastPos: new Map(), // positions of notes folded into a collapsed group
  links: [],
  shownKey: null, // the visible ids last handed over; null when they must be again

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
        ? "collapsed · click to expand"
        : n.id + (n.allTags.length ? " · " + escapeHtml(n.allTags.join(" ")) : "")}</span></div>`)
      .nodeVal((n) => (n.members ? 4 + n.size / 2 : 1 + n.degree))
      .nodeRelSize(3)
      .nodeOpacity(0.95)
      .nodeColor((n) => this.nodeColour(n))
      .linkColor((l) => this.linkColour(l))
      // The library multiplies the colour's alpha by this (default 0.2);
      // at 1, the alpha in linkColour is the opacity drawn.
      .linkOpacity(1)
      .linkWidth((l) => (this.incident(l) ? 0.8 : l.count > 1 ? Math.min(l.count, 10) * 0.4 : 0.4))
      // One arrowhead per link only; two-way links get none.
      .linkDirectionalArrowLength((l) => (l.both ? 0 : 2.5))
      .linkDirectionalArrowRelPos(1)
      .onNodeClick((n) => (n.members ? setTerm(`~#${n.cat}`, false) : focusNote(n.id)))
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
    // The trackball's own keys (A/S/D change what a drag does) would clash
    // with moving by keyboard (see keyMove).
    fg.controls().keys = [];
    new ResizeObserver(() => {
      if (el.clientWidth && el.clientHeight) fg.width(el.clientWidth).height(el.clientHeight);
    }).observe(el);
    this.fg = fg;
    this.render({ structure: true });
    this.showTitles();
    this.showCentre();
  },

  // The middle of the shown notes' bounding box, and its diagonal.
  graphMiddle() {
    const bbox = this.fg && this.fg.getGraphBbox();
    if (!bbox) return null; // no notes shown
    const { x: [x0, x1], y: [y0, y1], z: [z0, z1] } = bbox;
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, size: Math.hypot(x1 - x0, y1 - y0, z1 - z0) };
  },

  // "Center pivot": move the orbit centre to the middle of the graph. The
  // camera moves with it, keeping its distance and orientation.
  centrePivot() {
    const middle = this.graphMiddle();
    if (!middle) return;
    const target = this.fg.controls().target;
    const camera = this.fg.camera().position;
    this.fg.cameraPosition(
      { x: camera.x + middle.x - target.x, y: camera.y + middle.y - target.y, z: camera.z + middle.z - target.z },
      { x: middle.x, y: middle.y, z: middle.z }, 800);
  },

  // The other button (and Home) alternates, along the line from the orbit
  // centre to the camera and without moving the orbit centre, between going
  // onto the orbit centre, to look around from it (as close as the controls
  // allow), and backing away until every shown note is in view.
  PIVOT_DISTANCE: 1,
  nextView: "pivot", // the graph is framed once it first settles
  toggleView() {
    if (!this.fg) return;
    const camera = this.fg.camera();
    const target = this.fg.controls().target;
    const back = camera.position.clone().sub(target).normalize(); // orbit centre -> camera
    if (!back.lengthSq()) back.set(0, 0, 1);
    let distance = this.PIVOT_DISTANCE;
    if (this.nextView === "frame") {
      // Far enough for a sphere around the orbit centre, holding every shown
      // note, to fit the narrower of the two fields of view.
      const nodes = this.fg.graphData().nodes;
      const reach = Math.max(1, ...nodes.map((n) => Math.hypot(n.x - target.x, n.y - target.y, (n.z || 0) - target.z)));
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      distance = (reach + 20) / Math.sin(Math.min(vfov, hfov) / 2);
    }
    this.fg.cameraPosition(
      { x: target.x + back.x * distance, y: target.y + back.y * distance, z: target.z + back.z * distance },
      { x: target.x, y: target.y, z: target.z }, 800);
    this.nextView = this.nextView === "frame" ? "pivot" : "frame";
    const button = $("#view-toggle");
    button.textContent = this.nextView === "frame" ? "Frame all" : "Go to pivot";
    button.title = this.nextView === "frame"
      ? "Back away from the pivot until the whole graph is in view (Home, with the graph selected)"
      : "Move onto the pivot, to look around from it (Home, with the graph selected)";
  },

  // A three-ring gyroscope marks the orbit centre: the point the mouse
  // rotates around and zooms towards, and the keys carry along. Like a node,
  // it has a fixed size in the graph, so it shrinks with distance; nodes in
  // front of it hide it, and its rings show which way the world is turned.
  // It fades out as the camera comes within a few ring widths, so it isn't
  // drawn across the view when the camera is on the orbit centre.
  MARKER_RADIUS: 5, // graph units, about a medium node
  async showCentre() {
    let THREE;
    try {
      THREE = await import(THREE_URL);
    } catch (e) {
      return; // the graph works without it
    }
    const material = new THREE.LineBasicMaterial({ color: css("--text-muted"), transparent: true, opacity: 0.8 });
    const ring = new THREE.BufferGeometry().setFromPoints(new THREE.EllipseCurve(0, 0, 1, 1).getPoints(48));
    const marker = new THREE.Group();
    for (const [rx, ry] of [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]]) {
      const loop = new THREE.LineLoop(ring, material);
      loop.rotation.set(rx, ry, 0);
      marker.add(loop);
    }
    const dot = new THREE.MeshBasicMaterial({ color: css("--text-muted"), transparent: true });
    marker.add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), dot));
    marker.scale.setScalar(this.MARKER_RADIUS);
    this.centreMarker = marker;
    this.fg.scene().add(marker);
    const follow = () => {
      const target = this.fg.controls().target;
      marker.position.set(target.x, target.y, target.z);
      const away = this.fg.camera().position.distanceTo(target) / this.MARKER_RADIUS; // in ring radii
      const fade = Math.min(1, Math.max(0, (away - 2) / 4)); // gone within 2 radii, full from 6
      material.opacity = 0.8 * fade;
      dot.opacity = fade;
      marker.visible = fade > 0;
      requestAnimationFrame(follow);
    };
    follow();
  },

  // Each note's title floats just above it, in text colours rather than the
  // tag's (as in 3d-force-graph's text-nodes example).
  async showTitles() {
    if (!titlesBox.checked) {
      this.fg.nodeThreeObject(null);
      this.titles.clear();
      return;
    }
    if (!this.SpriteText) {
      try {
        this.SpriteText = (await import(SPRITE_TEXT_URL)).default;
      } catch (e) {
        titlesBox.checked = false;
        toast(`Titles are unavailable: ${e.message}`);
        return;
      }
    }
    if (!this.fg || !titlesBox.checked) return; // switched off, or rebuilt, while loading
    this.titles.clear();
    this.fg.nodeThreeObject((n) => this.titleSprite(n)).nodeThreeObjectExtend(true);
  },

  titleSprite(n) {
    const text = wrapTitle(n.title);
    const sprite = new this.SpriteText(text);
    sprite.material.depthWrite = false; // keep the text's background transparent
    sprite.textHeight = 4;
    // Above the node. The offset is in title heights, so a two-line title
    // (twice as tall) takes half of it to sit the same distance away.
    sprite.center.y = -2.0 / text.split("\n").length;
    sprite.color = this.titleColour(n);
    this.titles.set(n.id, sprite);
    return sprite;
  },

  titleColour(n) {
    if (n.id === selectedId) return css("--text-primary");
      return this.emphasised(n.id) ? withAlpha(css("--text-secondary"), 0.6) : withAlpha(css("--text-secondary"), 0.15);
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
    // Links are new objects, so they must be handed over. ("" would be
    // taken for an empty view, and an empty view would then never be drawn.)
    this.shownKey = null;
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
    // A title is redrawn when its colour is set, so only when it changes.
    for (const [id, sprite] of this.titles) {
      const node = this.nodeById.get(id);
      const colour = node && this.titleColour(node);
      if (colour && sprite.color !== colour) sprite.color = colour;
    }
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
    this.centreMarker?.traverse((o) => o.material?.color.set(css("--text-muted")));
  },
};

// Keyboard movement, once the graph has been clicked (so has the focus):
//
//   W/S, A/D, R/F   move the orbit centre forward and back, left and right,
//                   up and down, as the camera faces; the camera moves with
//                   it, keeping its distance and orientation
//   arrow keys      orbit the camera around the orbit centre, as dragging
//                   the mouse that way does
//   Q/E             roll around the direction the camera faces
//   Shift           move slower;  Home  the "Go to pivot" / "Frame all" button
//
// Clicking a note, dragging and scrolling work as before.

const MOVE_KEYS = {
  KeyW: ["move", 0, 0, 1], KeyS: ["move", 0, 0, -1],
  KeyA: ["move", -1, 0, 0], KeyD: ["move", 1, 0, 0],
  KeyR: ["move", 0, 1, 0], KeyF: ["move", 0, -1, 0],
  // [kind, sideways, up]: the direction the mouse would be dragged.
  ArrowLeft: ["orbit", -1, 0], ArrowRight: ["orbit", 1, 0],
  ArrowUp: ["orbit", 0, 1], ArrowDown: ["orbit", 0, -1],
  KeyQ: ["roll", -1], KeyE: ["roll", 1],
};
// As 3d-force-graph set up three.js's fly controls: Shift slows moving, not turning.
const MOVE_SPEED = 300; // graph units a second
const TURN_SPEED = Math.PI / 6; // radians a second
const keyMove = { held: new Set(), slow: false, last: 0, frame: 0 };

function moveStep(now) {
  const fg = graphView.fg;
  if (!fg || !keyMove.held.size) { keyMove.frame = 0; return; }
  const dt = Math.min(0.1, (now - keyMove.last) / 1000); // seconds; capped after a stall
  keyMove.last = now;
  const camera = fg.camera();
  const target = fg.controls().target;
  const offset = target.clone().sub(camera.position); // camera -> orbit centre
  const forward = offset.clone().normalize();
  const right = forward.clone().cross(camera.up).normalize();
  if (!right.lengthSq()) { keyMove.frame = requestAnimationFrame(moveStep); return; } // looking straight along "up"
  const up = right.clone().cross(forward).normalize();
  const speed = MOVE_SPEED * (keyMove.slow ? 0.1 : 1) * dt;
  const turn = TURN_SPEED * dt;
  const step = camera.position.clone().set(0, 0, 0);
  for (const code of keyMove.held) {
    const [kind, a, b, c] = MOVE_KEYS[code];
    if (kind === "move") {
      step.addScaledVector(right, a).addScaledVector(up, b).addScaledVector(forward, c);
    } else if (kind === "orbit") {
      // The trackball's own rule for a drag: turn about the axis across the
      // drag direction and the line from the orbit centre to the camera.
      const eye = offset.clone().negate();
      const sideways = camera.up.clone().cross(eye).normalize();
      const axis = camera.up.clone().normalize().multiplyScalar(b).addScaledVector(sideways, a).cross(eye).normalize();
      offset.applyAxisAngle(axis, turn);
      camera.up.applyAxisAngle(axis, turn);
    } else {
      camera.up.applyAxisAngle(forward, a * turn); // roll
    }
  }
  // Moving shifts the orbit centre and camera together; orbiting swings the
  // camera around the orbit centre.
  if (step.lengthSq()) target.addScaledVector(step.normalize(), speed);
  camera.position.copy(target).sub(offset);
  camera.lookAt(target);
  keyMove.frame = requestAnimationFrame(moveStep);
}

graphView.el.addEventListener("keydown", (evt) => {
  keyMove.slow = evt.shiftKey;
  if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
  if (evt.key === "Home") { evt.preventDefault(); graphView.toggleView(); return; }
  if (!MOVE_KEYS[evt.code]) return;
  evt.preventDefault(); // arrow keys would scroll
  keyMove.held.add(evt.code);
  if (!keyMove.frame) {
    keyMove.last = performance.now();
    keyMove.frame = requestAnimationFrame(moveStep);
  }
});
graphView.el.addEventListener("keyup", (evt) => {
  keyMove.slow = evt.shiftKey;
  keyMove.held.delete(evt.code);
});
graphView.el.addEventListener("blur", () => keyMove.held.clear());

// The note panel's graph of the open note and its nearest neighbours: every
// note it links to or that links to it, whatever the search box hides. Past
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
  tagCounts = new Map();
  for (const n of graph.nodes) {
    n.allTags = tagsOf(n);
    for (const t of n.allTags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
  assignSlots();
  renderProblems();
  Object.assign(applied, { filters: null, fold: null }); // the data changed, so redo everything
  applySearch();
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
  // A note inside a collapsed group can't be shown, so its groups are expanded.
  const note = graph.nodes.find((n) => n.id === id);
  const { fold } = parseSearch(searchInput.value);
  for (const t of fold) if (note && note.allTags.includes(t)) setTerm(`~#${t}`, false);
  update({ relayout: Number(depthSelect.value) > 0 });
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

// Tag suggestions, while a tag is being typed after #, -# or ~#.

const suggest = { el: $("#suggest"), tags: [], active: 0 };

// The tag being typed at the caret: where it starts and what is typed so far.
function tagAtCaret() {
  const before = searchInput.value.slice(0, searchInput.selectionStart);
  const m = before.match(/(?:^|\s)[-~]?#(\S*)$/);
  return m ? { start: before.length - m[1].length, typed: m[1].toLowerCase() } : null;
}

function hideSuggestions() {
  suggest.el.hidden = true;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
}

function renderSuggestions() {
  const at = tagAtCaret();
  if (!at) { hideSuggestions(); return; }
  const starts = (t) => (t.startsWith(at.typed) ? 1 : 0);
  suggest.tags = [...tagCounts.keys()].filter((t) => t.includes(at.typed))
    .sort((a, b) => starts(b) - starts(a) || tagCounts.get(b) - tagCounts.get(a) || a.localeCompare(b))
    .slice(0, 8);
  if (!suggest.tags.length) { hideSuggestions(); return; }
  suggest.active = Math.min(suggest.active, suggest.tags.length - 1);
  suggest.el.innerHTML = suggest.tags.map((t, i) => `<li role="option" id="suggest-${i}" data-index="${i}"
      aria-selected="${i === suggest.active}"><span class="swatch" style="background:${colourFor(t)}"></span>${
      escapeHtml(t)} <span class="count">${tagCounts.get(t)}</span></li>`).join("");
  suggest.el.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  searchInput.setAttribute("aria-activedescendant", `suggest-${suggest.active}`);
}

function acceptSuggestion(i) {
  const at = tagAtCaret();
  if (!at) return;
  const value = searchInput.value;
  let end = searchInput.selectionStart;
  while (end < value.length && !/\s/.test(value[end])) end++;
  const insert = `${suggest.tags[i]} `;
  searchInput.value = value.slice(0, at.start) + insert + value.slice(end).replace(/^\s+/, "");
  const caret = at.start + insert.length;
  searchInput.setSelectionRange(caret, caret);
  hideSuggestions();
  applySearch();
}

suggest.el.addEventListener("mousedown", (evt) => evt.preventDefault()); // keep the focus in the box
suggest.el.addEventListener("click", (evt) => {
  const li = evt.target.closest("li[data-index]");
  if (li) acceptSuggestion(Number(li.dataset.index));
});

// Controls.

// Words highlight as you type; the other terms change which notes are
// shown, so they apply after a pause (typing "#project" passes through "#p").
searchInput.addEventListener("input", () => {
  suggest.active = 0;
  renderSuggestions();
  restyle();
  clearTimeout(searchInput.timer);
  searchInput.timer = setTimeout(applySearch, 300);
});
searchInput.addEventListener("click", renderSuggestions);
searchInput.addEventListener("blur", hideSuggestions);
searchInput.addEventListener("keydown", (evt) => {
  if (!suggest.el.hidden) {
    const n = suggest.tags.length;
    const move = { ArrowDown: 1, ArrowUp: n - 1 }[evt.key];
    if (move) { evt.preventDefault(); suggest.active = (suggest.active + move) % n; renderSuggestions(); return; }
    if (evt.key === "Enter" || evt.key === "Tab") { evt.preventDefault(); acceptSuggestion(suggest.active); return; }
    // Without preventDefault, Escape would also clear the whole search box.
    if (evt.key === "Escape") { evt.preventDefault(); hideSuggestions(); return; }
  }
  if (evt.key !== "Enter") return;
  clearTimeout(searchInput.timer);
  applySearch();
  if (!matches) return;
  const hit = model.nodes.find((n) => matches.has(n.id) && visible.has(n.id));
  if (!hit) return;
  const { words } = parseSearch(searchInput.value);
  focusNote(hit.members ? hit.members.find((m) => matchesQuery(m, words)).id : hit.id);
});
$("#legend").addEventListener("click", (evt) => {
  const button = evt.target.closest("button[data-tag]");
  if (button) setTerm(`${evt.shiftKey ? "~" : "-"}#${button.dataset.tag}`);
});
clusterBox.addEventListener("change", () => update({ relayout: true }));
titlesBox.addEventListener("change", () => {
  saveViewPrefs();
  if (graphView.mounted) graphView.showTitles();
});
$("#centre-pivot").addEventListener("click", () => graphView.centrePivot());
$("#view-toggle").addEventListener("click", () => graphView.toggleView());
for (const input of [depthSelect, hideIsolated]) {
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
  // The tags hidden at start (--exclude-tags) are written into the search box.
  searchInput.value = cfg.excludeTags.map((t) => `-#${t.toLowerCase()}`).join(" ");
  await loadGraph();
  graphView.mount();
  connectEvents();
  if (cfg.initialId) {
    history.replaceState({ id: cfg.initialId }, "", `/note/${cfg.initialId}`);
    focusNote(cfg.initialId, { push: false });
  }
})();
