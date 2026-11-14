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
const hideIsolated = $("#hide-isolated");
const fromInput = $("#from");
const toInput = $("#to");
const groupBox = $("#group");
excludeInput.value = cfg.excludeTags.join(",");

const GROUP = "group:"; // id prefix of group boxes and collapsed groups
let collapsed = new Set(); // categories drawn as a single node while grouping
const placed = new Set(); // ids that have been through a layout
const lastPos = new Map(); // id -> position, kept across rebuilds

function category(node) {
  if (colourBy.value === "subdir") return node.subdir || "(root)";
  return node.tags[0] || "(untagged)";
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

function elements() {
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
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const groups = [...new Set(graph.nodes.map(groupOf))].filter((g) => g !== null).map((g) => {
    const data = { id: GROUP + g, cat: g, title: g, colour: colourFor(g), tags: [], aliases: [], degree: degree.get(GROUP + g) || 0 };
    const ms = members.get(g);
    if (!ms) return { group: "nodes", data, selectable: false };
    return {
      group: "nodes",
      data: { ...data, title: `${g} (${ms.length})`, members: ms, size: ms.length },
      classes: "collapsed",
      selectable: false,
    };
  });
  return [
    ...groups,
    ...graph.nodes.filter((n) => !standIn.has(n.id)).map((n) => {
      const g = groupOf(n);
      const data = { ...n, colour: colourFor(category(n)), degree: degree.get(n.id) || 0 };
      return { group: "nodes", data: g === null ? data : { ...data, parent: GROUP + g } };
    }),
    ...edges.map((e) => ({ group: "edges", data: e })),
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
    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      if (n.hasClass("collapsed")) toggleGroup(n.data("cat"));
      else if (!n.isParent()) focusNote(n.id());
    });
    cy.on("dbltap", "node", (evt) => { if (evt.target.isParent()) toggleGroup(evt.target.data("cat")); });
    cy.on("tap", (evt) => { if (evt.target === cy) clearSelection(); });
    applyFilters();
    runLayout(true);
    reselect();
  } else {
    rebuild(false);
  }
}

// Replace the graph's elements, keeping every note where it was. A
// relayout of "fresh" starts over, for when the grouping changes.
function rebuild(relayout) {
  cy.nodes(":childless").forEach((n) => { if (placed.has(n.id())) lastPos.set(n.id(), { ...n.position() }); });
  cy.elements().remove();
  cy.add(elements());
  cy.nodes(":childless").forEach((n) => {
    const members = n.data("members");
    const at = members ? centroid(members.map((m) => lastPos.get(m.id)).filter(Boolean)) : lastPos.get(n.id());
    if (!at) return;
    n.position(at);
    placed.add(n.id());
  });
  applyFilters();
  if (relayout || cy.nodes(":childless:visible").some((n) => !placed.has(n.id()))) runLayout(relayout === "fresh");
  reselect();
}

function centroid(points) {
  if (!points.length) return null;
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
}

function reselect() {
  if (selectedId && cy.getElementById(selectedId).nonempty()) {
    cy.getElementById(selectedId).select();
    highlightIncident();
  }
}

function toggleGroup(cat) {
  if (!collapsed.delete(cat)) collapsed.add(cat);
  rebuild(true);
}

function runLayout(initial) {
  const visible = cy.elements(":visible");
  const notes = visible.nodes(":childless");
  const known = notes.filter((n) => placed.has(n.id()));
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
  notes.forEach((n) => placed.add(n.id()));
  visible.layout({
    name: "fcose",
    randomize,
    animate: !randomize && visible.length < 1500,
    animationDuration: 400,
    nodeRepulsion: 6000,
    idealEdgeLength: 60,
    nodeSeparation: 60,
    padding: 30,
  }).run();
}

function noteFilter() {
  const exclude = new Set(excludeInput.value.split(",").map((t) => t.trim()).filter(Boolean));
  // Note ids start with their creation date, YYYYMMDD.
  const from = fromInput.value.replaceAll("-", "");
  const to = toInput.value.replaceAll("-", "");
  return (d) => {
    const day = d.id.slice(0, 8);
    return !d.tags.some((t) => exclude.has(t)) && (!from || day >= from) && (!to || day <= to);
  };
}

function applyFilters() {
  const passes = noteFilter();
  // Inside a collapsed group, "unlinked" means no links at all.
  const linked = new Set(graph.edges.flatMap((e) => [e.source, e.target]));
  const memberShown = (m) => passes(m) && (!hideIsolated.checked || linked.has(m.id));
  const depth = Number(depthSelect.value);
  // Notes and collapsed groups; group boxes follow their contents.
  const notes = cy.nodes(":childless");
  cy.batch(() => {
    cy.elements().removeClass("hidden");
    notes.forEach((n) => {
      const d = n.data();
      const shown = d.members ? d.members.some(memberShown) : passes(d);
      if (!shown && n.id() !== selectedId) n.addClass("hidden");
    });
    if (depth > 0 && selectedId && cy.getElementById(selectedId).nonempty()) {
      let hood = cy.getElementById(selectedId);
      for (let i = 0; i < depth; i++) hood = hood.closedNeighborhood();
      notes.difference(hood.nodes()).addClass("hidden");
    }
    // Judged after the other filters: a note linked only to hidden notes is unlinked too.
    if (hideIsolated.checked) {
      notes
        .filter((n) => !n.hasClass("hidden") && n.id() !== selectedId
          && n.neighborhood().nodes().not(".hidden").empty())
        .addClass("hidden");
    }
    cy.nodes(":parent").filter((p) => p.children().not(".hidden").empty()).addClass("hidden");
  });
  applySearch();
  let shown = 0;
  notes.not(".hidden").forEach((n) => {
    const members = n.data("members");
    shown += members ? members.filter(memberShown).length : 1;
  });
  $("#stats").textContent = `${shown} of ${graph.nodes.length} notes`;
}

function matches(d, q) {
  if (d.members) return d.members.some((m) => matches(m, q));
  return d.title.toLowerCase().includes(q) || d.id.includes(q) || d.aliases.some((a) => a.includes(q));
}

function applySearch() {
  const q = searchInput.value.trim().toLowerCase();
  cy.batch(() => {
    cy.elements().removeClass("faded match");
    if (!q) return;
    const hits = cy.nodes(":childless").filter((n) => matches(n.data(), q));
    hits.addClass("match");
    // Fading a group box would fade the matches inside it too.
    cy.elements().not(":parent").difference(hits).difference(hits.edgesWith(hits)).addClass("faded");
  });
}

function recolour() {
  cy.nodes().forEach((n) => n.data("colour", colourFor(n.data("cat") ?? category(n.data()))));
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
  const note = graph.nodes.find((n) => n.id === id);
  if (cy && note && collapsed.delete(groupOf(note))) rebuild(true);
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
  if (!hit) return;
  const members = hit.data("members");
  const q = searchInput.value.trim().toLowerCase();
  focusNote(members ? members.find((m) => matches(m, q)).id : hit.id());
});
colourBy.addEventListener("change", () => {
  assignSlots();
  renderLegend();
  if (groupBox.checked) { collapsed.clear(); rebuild("fresh"); }
  else recolour();
});
groupBox.addEventListener("change", () => rebuild("fresh"));
for (const input of [depthSelect, excludeInput, hideIsolated, fromInput, toInput]) {
  input.addEventListener("change", () => { applyFilters(); runLayout(false); });
}
window.addEventListener("popstate", (evt) => {
  if (evt.state && evt.state.id) focusNote(evt.state.id, { push: false });
  else if (cy) { selectedId = null; cy.nodes().unselect(); applyFilters(); }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  cy.style(style());
  recolour();
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
