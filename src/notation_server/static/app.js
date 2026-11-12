// Graph of notes (Cytoscape) + note panel (HTMX) + live updates (SSE).
"use strict";

const cfg = JSON.parse(document.getElementById("config").textContent);
const SLOTS = 8; // categorical colour slots; further categories fold into "other"
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let cy = null;
let selectedId = null;
let graph = { nodes: [], edges: [], problems: [] };
let slotOf = new Map(); // category -> slot index, fixed from the whole corpus

const $ = (sel) => document.querySelector(sel);
const searchInput = $("#search");
const colourBy = $("#colour-by");
const depthSelect = $("#depth");
const excludeInput = $("#exclude-tags");
excludeInput.value = cfg.excludeTags.join(",");

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

function style() {
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
      selector: "edge",
      style: {
        width: 1.2,
        "line-color": css("--edge"),
        "target-arrow-color": css("--edge"),
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.7,
        "curve-style": "bezier",
      },
    },
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
  ];
}

function elements() {
  const degree = new Map();
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  return [
    ...graph.nodes.map((n) => ({
      group: "nodes",
      data: { ...n, colour: colourFor(category(n)), degree: degree.get(n.id) || 0 },
    })),
    ...graph.edges.map((e) => ({ group: "edges", data: { id: `${e.source}>${e.target}`, ...e } })),
  ];
}

async function loadGraph() {
  // Fetch everything and filter client-side, so colours stay stable.
  const res = await fetch("/api/graph?exclude_tags=");
  graph = await res.json();
  assignSlots();
  renderLegend();
  renderProblems();

  if (!cy) {
    cy = cytoscape({ container: $("#graph"), elements: elements(), style: style(), wheelSensitivity: 0.3 });
    cy.on("tap", "node", (evt) => focusNote(evt.target.id()));
    cy.on("tap", (evt) => { if (evt.target === cy) clearSelection(); });
    applyFilters();
    runLayout(true);
  } else {
    const positions = new Map(cy.nodes().map((n) => [n.id(), { ...n.position() }]));
    cy.elements().remove();
    cy.add(elements());
    const fresh = cy.nodes().filter((n) => !positions.has(n.id()));
    cy.nodes().forEach((n) => { if (positions.has(n.id())) n.position(positions.get(n.id())); });
    applyFilters();
    if (fresh.length) runLayout(false);
  }
  if (selectedId && cy.getElementById(selectedId).nonempty()) {
    cy.getElementById(selectedId).select();
    highlightIncident();
  }
}

function runLayout(initial) {
  const visible = cy.elements(":visible");
  visible.layout({
    name: "cose",
    animate: !initial && visible.length < 400,
    randomize: initial,
    nodeRepulsion: () => 9000,
    idealEdgeLength: () => 70,
    padding: 30,
  }).run();
}

function applyFilters() {
  const exclude = new Set(excludeInput.value.split(",").map((t) => t.trim()).filter(Boolean));
  const depth = Number(depthSelect.value);
  cy.batch(() => {
    cy.elements().removeClass("hidden");
    cy.nodes().forEach((n) => {
      if (n.id() !== selectedId && n.data("tags").some((t) => exclude.has(t))) n.addClass("hidden");
    });
    if (depth > 0 && selectedId && cy.getElementById(selectedId).nonempty()) {
      let hood = cy.getElementById(selectedId);
      for (let i = 0; i < depth; i++) hood = hood.closedNeighborhood();
      cy.nodes().difference(hood.nodes()).addClass("hidden");
    }
  });
  applySearch();
  const shown = cy.nodes(":visible").length;
  $("#stats").textContent = `${shown} of ${cy.nodes().length} notes`;
}

function applySearch() {
  const q = searchInput.value.trim().toLowerCase();
  cy.batch(() => {
    cy.elements().removeClass("faded match");
    if (!q) return;
    const hits = cy.nodes().filter((n) => {
      const d = n.data();
      return d.title.toLowerCase().includes(q) || d.id.includes(q) || d.aliases.some((a) => a.includes(q));
    });
    hits.addClass("match");
    cy.elements().difference(hits).difference(hits.edgesWith(hits)).addClass("faded");
  });
}

function highlightIncident() {
  cy.edges().removeClass("incident");
  if (selectedId) cy.getElementById(selectedId).connectedEdges().addClass("incident");
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
  const node = cy && cy.getElementById(id);
  if (node && node.nonempty()) {
    cy.nodes().unselect();
    node.select();
    applyFilters();
    if (Number(depthSelect.value) > 0) runLayout(false);
    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300 });
    highlightIncident();
  }
  await loadPanel(id);
}

function clearSelection() {
  selectedId = null;
  cy.nodes().unselect();
  highlightIncident();
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
  if (evt.key !== "Enter") return;
  const hit = cy.nodes(".match:visible")[0];
  if (hit) focusNote(hit.id());
});
colourBy.addEventListener("change", () => {
  assignSlots();
  renderLegend();
  cy.nodes().forEach((n) => n.data("colour", colourFor(category(n.data()))));
});
depthSelect.addEventListener("change", () => { applyFilters(); runLayout(false); });
excludeInput.addEventListener("change", () => { applyFilters(); runLayout(false); });
window.addEventListener("popstate", (evt) => {
  if (evt.state && evt.state.id) focusNote(evt.state.id, { push: false });
  else if (cy) { selectedId = null; cy.nodes().unselect(); applyFilters(); }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  cy.style(style());
  cy.nodes().forEach((n) => n.data("colour", colourFor(category(n.data()))));
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
