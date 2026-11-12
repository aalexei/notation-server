// Graph of notes (3d-force-graph) + note panel (HTMX) + live updates (SSE).
"use strict";

const cfg = JSON.parse(document.getElementById("config").textContent);
const SLOTS = 8; // categorical colour slots; further categories fold into "other"
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let fg = null; // the ForceGraph3D instance
let selectedId = null;
let hoverId = null;
let graph = { nodes: [], edges: [], problems: [] };
let slotOf = new Map(); // category -> slot index, fixed from the whole corpus
// Node and link objects persist across refreshes and filter changes, so
// the simulation keeps their positions instead of starting over.
const nodeById = new Map();
let links = [];
let neighbours = new Map(); // id -> Set of ids linked either way (whole corpus)
let shown = { nodes: [], links: [] };
let shownKey = "";
let matches = null; // Set of ids matching the search, or null when not searching

const $ = (sel) => document.querySelector(sel);
const searchInput = $("#search");
const colourBy = $("#colour-by");
const depthSelect = $("#depth");
const excludeInput = $("#exclude-tags");
const hideOrphans = $("#hide-orphans");
const groupInput = $("#group");
excludeInput.value = cfg.excludeTags.join(",");

const idOf = (end) => (typeof end === "object" ? end.id : end);

function category(node) {
  if (colourBy.value === "subdir") return node.subdir || "(root)";
  return node.tags[0] || "(untagged)";
}

// Colour follows the category, not its rank in the current view: slots are
// assigned once per colour-by mode, from the whole corpus, by frequency.
function assignSlots() {
  const counts = new Map();
  for (const n of graph.nodes) counts.set(category(n), (counts.get(category(n)) || 0) + 1);
  const ranked = [...counts.entries()]
    .filter(([c]) => c !== "(untagged)" && c !== "(root)")
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

function renderLegend() {
  const items = [...slotOf.keys()].map(
    (c) => `<span><span class="swatch" style="background:${colourFor(c)}"></span>${escapeHtml(c)}</span>`,
  );
  items.push(`<span><span class="swatch" style="background:${css("--other")}"></span>other</span>`);
  $("#legend").innerHTML = items.join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Styling. A selected note keeps its neighbours at full strength and fades
// the rest; a search fades everything that doesn't match.

function emphasised(id) {
  if (matches) return matches.has(id);
  if (!selectedId) return true;
  return id === selectedId || (neighbours.get(selectedId) || new Set()).has(id);
}

function nodeColour(n) {
  if (n.id === selectedId || n.id === hoverId) return css("--text-primary");
  const base = colourFor(category(n));
  return emphasised(n.id) ? base : withAlpha(base, 0.12);
}

function incident(l) {
  return selectedId && (idOf(l.source) === selectedId || idOf(l.target) === selectedId);
}

function linkColour(l) {
  if (incident(l)) return css("--text-secondary");
  return withAlpha(css("--edge"), matches || selectedId ? 0.08 : 0.5);
}

function restyle() {
  if (!fg) return;
  fg.nodeColor(fg.nodeColor()).linkColor(fg.linkColor()).linkWidth(fg.linkWidth());
}

// Pull nodes that share a colour slot towards their group's centroid, so
// each tag (or folder) forms its own region instead of one tangled ball.
function clusterForce() {
  let nodes = [];
  function force(alpha) {
    if (!groupInput.checked) return;
    const centres = new Map();
    for (const n of nodes) {
      const cat = category(n);
      if (!slotOf.has(cat)) continue;
      let c = centres.get(cat);
      if (!c) centres.set(cat, (c = { x: 0, y: 0, z: 0, count: 0 }));
      c.x += n.x; c.y += n.y; c.z += n.z || 0; c.count++;
    }
    const k = alpha * 0.25;
    for (const n of nodes) {
      const c = centres.get(category(n));
      if (!c || c.count < 2) continue;
      n.vx += (c.x / c.count - n.x) * k;
      n.vy += (c.y / c.count - n.y) * k;
      n.vz += (c.z / c.count - (n.z || 0)) * k;
    }
  }
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

function syncData() {
  const fresh = new Set();
  for (const n of graph.nodes) {
    fresh.add(n.id);
    const existing = nodeById.get(n.id);
    if (existing) Object.assign(existing, n);
    else nodeById.set(n.id, { ...n });
  }
  for (const id of [...nodeById.keys()]) if (!fresh.has(id)) nodeById.delete(id);

  links = graph.edges.map((e) => ({ source: e.source, target: e.target }));
  neighbours = new Map();
  for (const e of graph.edges) {
    if (!neighbours.has(e.source)) neighbours.set(e.source, new Set());
    if (!neighbours.has(e.target)) neighbours.set(e.target, new Set());
    neighbours.get(e.source).add(e.target);
    neighbours.get(e.target).add(e.source);
  }
  shownKey = ""; // links are new objects, so the next applyFilters must push them
}

async function loadGraph() {
  // Fetch everything and filter client-side, so colours stay stable.
  const res = await fetch("/api/graph?exclude_tags=");
  graph = await res.json();
  assignSlots();
  renderLegend();
  renderProblems();
  syncData();

  if (!fg) {
    const el = $("#graph");
    fg = ForceGraph3D()(el)
      .backgroundColor(css("--surface-1"))
      .showNavInfo(false)
      .nodeId("id")
      .nodeLabel((n) => `<div class="node-tip">${escapeHtml(n.title)}<br><span>${n.id}${
        n.tags.length ? " · " + escapeHtml(n.tags.join(" ")) : ""}</span></div>`)
      .nodeVal((n) => 1 + (neighbours.get(n.id)?.size || 0))
      .nodeRelSize(3)
      .nodeOpacity(0.95)
      .nodeColor(nodeColour)
      .linkColor(linkColour)
      .linkWidth((l) => (incident(l) ? 1.2 : 0))
      .linkDirectionalArrowLength(2.5)
      .linkDirectionalArrowRelPos(1)
      .onNodeClick((n) => focusNote(n.id))
      .onNodeHover((n) => {
        hoverId = n ? n.id : null;
        el.style.cursor = n ? "pointer" : "";
        restyle();
      })
      .onBackgroundClick(() => clearSelection());
    fg.d3Force("charge").strength(-40);
    fg.d3Force("link").distance(30);
    fg.d3Force("cluster", clusterForce());
    new ResizeObserver(() => fg.width(el.clientWidth).height(el.clientHeight)).observe(el);
  }
  applyFilters();
}

function applyFilters() {
  const exclude = new Set(excludeInput.value.split(",").map((t) => t.trim()).filter(Boolean));
  const depth = Number(depthSelect.value);

  let ids = new Set(
    [...nodeById.values()]
      .filter((n) => n.id === selectedId || !n.tags.some((t) => exclude.has(t)))
      .map((n) => n.id),
  );
  if (depth > 0 && selectedId && nodeById.has(selectedId)) {
    let frontier = new Set([selectedId]);
    const reached = new Set(frontier);
    for (let i = 0; i < depth; i++) {
      const next = new Set();
      for (const id of frontier) {
        for (const nb of neighbours.get(id) || []) {
          if (ids.has(nb) && !reached.has(nb)) { reached.add(nb); next.add(nb); }
        }
      }
      frontier = next;
    }
    ids = reached;
  }
  let shownLinks = links.filter((l) => ids.has(idOf(l.source)) && ids.has(idOf(l.target)));
  if (hideOrphans.checked) {
    const linked = new Set(shownLinks.flatMap((l) => [idOf(l.source), idOf(l.target)]));
    ids = new Set([...ids].filter((id) => linked.has(id) || id === selectedId));
  }

  // Only hand the graph new data when the visible set really changed:
  // every graphData call reheats the simulation and the layout jiggles.
  const key = [...ids].sort().join(",");
  if (key !== shownKey) {
    shownKey = key;
    shown = { nodes: [...ids].map((id) => nodeById.get(id)), links: shownLinks };
    fg.graphData(shown);
  }
  applySearch();
  $("#stats").textContent = `${shown.nodes.length} of ${nodeById.size} notes`;
}

function applySearch() {
  const q = searchInput.value.trim().toLowerCase();
  matches = q
    ? new Set(
        shown.nodes
          .filter((n) => n.title.toLowerCase().includes(q) || n.id.includes(q) || n.aliases.some((a) => a.includes(q)))
          .map((n) => n.id),
      )
    : null;
  restyle();
}

function renderProblems() {
  const box = $("#problems");
  if (!graph.problems.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<details><summary>${graph.problems.length} problem(s) in the note tree</summary><ul>${
    graph.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></details>`;
}

// Fly the camera to a node, once the simulation has given it a position.
function flyTo(id, attempts = 20) {
  const n = nodeById.get(id);
  if (!n || n.x === undefined) {
    if (attempts > 0) setTimeout(() => flyTo(id, attempts - 1), 150);
    return;
  }
  const distance = 120;
  const ratio = 1 + distance / (Math.hypot(n.x, n.y, n.z || 0) || 1);
  fg.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: (n.z || 0) * ratio }, n, 1000);
}

// Select a note: load its panel, centre the graph on it, update the URL.
async function focusNote(id, { push = true } = {}) {
  selectedId = id;
  if (push && location.pathname !== `/note/${id}`) history.pushState({ id }, "", `/note/${id}`);
  if (fg && nodeById.has(id)) {
    // The selection can change what is shown (n hops, or a hidden note
    // that is now selected); applyFilters also restyles.
    applyFilters();
    flyTo(id);
  }
  await loadPanel(id);
}

function clearSelection() {
  selectedId = null;
  applyFilters();
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

// notation: links inside a rendered note open in the panel, not a new page.
$("#panel").addEventListener("click", (evt) => {
  const a = evt.target.closest("a[data-note-id]");
  if (!a || evt.metaKey || evt.ctrlKey) return;
  evt.preventDefault();
  focusNote(a.dataset.noteId);
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

searchInput.addEventListener("input", applySearch);
searchInput.addEventListener("keydown", (evt) => {
  if (evt.key !== "Enter" || !matches || !matches.size) return;
  focusNote(matches.values().next().value);
});
colourBy.addEventListener("change", () => {
  assignSlots();
  renderLegend();
  restyle();
  if (groupInput.checked) fg.d3ReheatSimulation();
});
groupInput.addEventListener("change", () => fg.d3ReheatSimulation());
for (const el of [depthSelect, excludeInput, hideOrphans]) el.addEventListener("change", applyFilters);
window.addEventListener("popstate", (evt) => {
  if (evt.state && evt.state.id) focusNote(evt.state.id, { push: false });
  else if (fg) { selectedId = null; applyFilters(); }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  fg.backgroundColor(css("--surface-1"));
  restyle();
  renderLegend();
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
  connectEvents();
  if (cfg.initialId) {
    history.replaceState({ id: cfg.initialId }, "", `/note/${cfg.initialId}`);
    focusNote(cfg.initialId, { push: false });
  }
})();
