import * as THREE from "three";
import { loadFolder, loadZip } from "./mapfile.js";
import { importModel } from "./importer.js";
import { renderer, pick, frameBox } from "./scene.js";
import { HeightmapView } from "./viewer.js";
import { Project, MODEL_SURFACES, MARKERS } from "./project.js";

const status = document.getElementById("status");
const holeSelect = document.getElementById("hole-select");
const info = document.getElementById("info");
const empty = document.getElementById("empty");
const toolbar = document.getElementById("toolbar");
const dropOverlay = document.getElementById("drop");

/** Golf-sized default: the longest side of an imported level becomes roughly this many metres. */
const DEFAULT_LEVEL_SIZE = 450;

let view = null; // HeightmapView for format 1 maps
let project = null; // Project for model maps
let tab = "model";
let tool = "look";
let selectedMaterial = null;

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

// The file buttons are labels; let Enter and Space open the picker too.
for (const label of document.querySelectorAll("label.btn")) {
  label.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      label.querySelector("input").click();
    }
  });
}

function clear() {
  view?.dispose();
  project?.dispose();
  view = project = null;
  selectedMaterial = null;
  toolbar.hidden = true;
}

async function run(label, fn) {
  try {
    setStatus(`${label}...`);
    await fn();
  } catch (e) {
    console.error(e);
    setStatus(`${label} failed: ${e.message}`, true);
  }
}

// ---------- Opening things ----------

async function openMap(map) {
  clear();
  empty.hidden = true;
  if (map.manifest.format === 2) {
    project = await Project.fromMap(map);
    startEditing();
  } else {
    view = new HeightmapView(map);
    fillHoleSelect(map.manifest.holes, 0);
    showViewHole(0);
  }
  setStatus(`${map.manifest.name} by ${map.manifest.author || "unknown"}`);
}

async function openModel(files) {
  const { root, missing } = await importModel(files);
  clear();
  empty.hidden = true;
  project = new Project(root);
  const size = project.box.getSize(new THREE.Vector3());
  project.scale = Math.max(0.01, Math.round((DEFAULT_LEVEL_SIZE / Math.max(size.x, size.z)) * 2) / 2);
  project.applyTransform();
  project.holes[0].water = Math.floor(project.box.min.y - 5);
  project.rebuildMarkers();
  startEditing();
  setStatus(missing.length ? `Imported, but these files were missing: ${missing.join(", ")}` : `Imported ${root.name}`, missing.length > 0);
}

/** Decides what a set of picked or dropped files is: a map folder, a .sbgmap, or a model. */
async function openFiles(entries) {
  const files = entries.map((e) => e.file);
  const sbgmap = files.find((f) => /\.(sbgmap|zip)$/i.test(f.name));
  if (entries.some((e) => e.path.split("/").pop() === "map.json")) return openMap(await loadFolder(entries));
  if (sbgmap && files.length === 1) return openMap(await loadZip(sbgmap));
  return openModel(files);
}

const asEntries = (fileList) => [...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
document.getElementById("import-files").addEventListener("change", (e) => e.target.files.length && run("Importing", () => openModel(e.target.files)));
document.getElementById("import-folder").addEventListener("change", (e) => e.target.files.length && run("Importing", () => openFiles(asEntries(e.target.files))));
document.getElementById("open-file").addEventListener("change", (e) => e.target.files[0] && run("Opening", async () => openMap(await loadZip(e.target.files[0]))));

// Drag and drop, including whole folders.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dropOverlay.hidden = ++dragDepth <= 0;
});
window.addEventListener("dragleave", () => (dropOverlay.hidden = --dragDepth <= 0));
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const roots = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  run("Opening", async () => openFiles((await Promise.all(roots.map((r) => readEntry(r, "")))).flat()));
});

async function readEntry(entry, prefix) {
  if (entry.isFile) return [{ file: await new Promise((res, rej) => entry.file(res, rej)), path: prefix + entry.name }];
  const reader = entry.createReader();
  const children = [];
  for (let batch; (batch = await new Promise((res, rej) => reader.readEntries(res, rej))).length; ) children.push(...batch);
  return (await Promise.all(children.map((c) => readEntry(c, `${prefix}${entry.name}/`)))).flat();
}

// ---------- Hole picker ----------

function fillHoleSelect(holes, selected) {
  holeSelect.innerHTML = "";
  holes.forEach((h, i) => holeSelect.add(new Option(`${i + 1}. ${h.name || "Unnamed"} (par ${h.par})`, i)));
  holeSelect.value = selected;
  holeSelect.disabled = false;
}

holeSelect.addEventListener("change", () => {
  const i = Number(holeSelect.value);
  if (view) showViewHole(i);
  if (project) {
    project.activeHole = i;
    project.rebuildMarkers();
    renderPanel();
  }
});

function showViewHole(index) {
  const hole = view.show(index);
  const length = Math.hypot(hole.cup.x - hole.tee.x, hole.cup.z - hole.tee.z);
  info.innerHTML = `
    <h2>${esc(hole.name ?? "Unnamed")}</h2>
    <div class="tags"><span class="tag par">Par ${hole.par}</span><span class="tag">${esc(hole.difficulty ?? "none")}</span></div>
    <div class="stats">
      ${stat("Tee to cup", `${Math.round(length)} m`)}
      ${stat("Size", `${hole.size[0]} x ${hole.size[1]} m`)}
      ${stat("Water level", `${hole.water ?? 5} m`)}
      ${stat("Item boxes", hole.itemBoxes?.length ?? 0)}
      ${stat("Checkpoints", hole.checkpoints?.length ?? 0)}
    </div>
    <p class="hint">Heightmap maps are view-only for now.</p>`;
}

// ---------- Editing ----------

const TOOLS = [
  { id: "look", name: "Look", tip: "Orbit around. Click the model to find its material." },
  { id: "tee", name: "Tee", tip: "Click to place the tee." },
  { id: "cup", name: "Cup", tip: "Click to place the cup." },
  { id: "itemBoxes", name: "Item box", tip: "Click to add item boxes." },
  { id: "checkpoints", name: "Checkpoint", tip: "Click to add a checkpoint." },
  { id: "erase", name: "Erase", tip: "Click a marker to remove it." },
];

function startEditing() {
  tool = "look";
  tab = "model";
  toolbar.hidden = false;
  renderToolbar();
  fillHoleSelect(project.holes, project.activeHole);
  frameBox(project.box);
  renderPanel();
}

function renderToolbar() {
  toolbar.innerHTML = TOOLS.map((t) => `<button class="tool ${t.id === tool ? "active" : ""}" data-tool="${t.id}" title="${t.tip}">${t.name}</button>`).join("");
  toolbar.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      tool = b.dataset.tool;
      renderToolbar();
      setStatus(TOOLS.find((t) => t.id === tool).tip);
    }),
  );
}

// A click is a pointer press that did not move (so orbiting never places markers).
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!project || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  const hit = pick(e, [project.root]);
  if (!hit) return;
  if (tool === "look") {
    const materials = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
    const group = hit.object.geometry.groups.find((g) => hit.faceIndex * 3 >= g.start && hit.faceIndex * 3 < g.start + g.count);
    selectMaterial(materials[group?.materialIndex ?? 0]);
  } else if (tool === "erase") {
    if (!project.erase(hit.point)) setStatus("No marker there");
    renderPanel();
  } else {
    project.place(tool, hit.point);
    renderPanel();
  }
});

function selectMaterial(material) {
  if (selectedMaterial) selectedMaterial.emissive.setHex(0x000000);
  selectedMaterial = material;
  if (material) material.emissive.setHex(0x665500);
  tab = "model";
  renderPanel();
  info.querySelector(".material.selected")?.scrollIntoView({ block: "nearest" });
}

function renderPanel() {
  if (!project) return;
  const tabs = [
    ["model", "Model"],
    ["holes", "Holes"],
    ["export", "Export"],
  ];
  info.innerHTML = `
    <nav class="tabs">${tabs.map(([id, name]) => `<button class="tab ${id === tab ? "active" : ""}" data-tab="${id}">${name}</button>`).join("")}</nav>
    <section>${{ model: modelPanel, holes: holesPanel, export: exportPanel }[tab]()}</section>`;
  info.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => ((tab = b.dataset.tab), renderPanel())));
  ({ model: wireModel, holes: wireHoles, export: wireExport })[tab]();
}

function modelPanel() {
  const [sx, sz] = project.size;
  return `
    <h3>Size</h3>
    <div class="field"><label for="scale">Scale</label><input id="scale" type="number" min="0.01" step="0.5" value="${project.scale}" /></div>
    <div class="stats">${stat("Course area", `${sx} x ${sz} m`)}</div>
    <div class="row"><button class="btn btn-secondary small" id="rotate">Rotate 90&deg;</button>
    <label class="check"><input type="checkbox" id="overlay" ${project.surfaceOverlay ? "checked" : ""} /> Show surfaces</label></div>
    <h3>Surfaces</h3>
    <p class="hint">Pick what each material is. Tip: click the model with Look to find a material.</p>
    <div class="materials">${project.materials
      .map(({ material }, i) => `<div class="material ${material === selectedMaterial ? "selected" : ""}" data-i="${i}">
          <span class="thumb" style="${materialThumb(material)}"></span>
          <span class="mat-name" title="${esc(material.name)}">${esc(material.name || `Material ${i + 1}`)}</span>
          <select data-i="${i}" class="surface">${MODEL_SURFACES.map((s) => `<option value="${s.id}" ${s.id === material.userData.surface ? "selected" : ""}>${s.name}</option>`).join("")}</select>
        </div>`)
      .join("")}</div>`;
}

function wireModel() {
  info.querySelector("#scale").addEventListener("change", (e) => {
    project.scale = Math.max(0.01, Number(e.target.value) || 1);
    project.applyTransform();
    frameBox(project.box);
    renderPanel();
  });
  info.querySelector("#rotate").addEventListener("click", () => {
    project.rotation = (project.rotation + 1) % 4;
    project.applyTransform();
    frameBox(project.box);
    renderPanel();
  });
  info.querySelector("#overlay").addEventListener("change", (e) => project.setSurfaceOverlay(e.target.checked));
  info.querySelectorAll("select.surface").forEach((s) =>
    s.addEventListener("change", () => project.setSurface(project.materials[Number(s.dataset.i)].material, s.value)),
  );
  info.querySelectorAll(".material").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.tagName !== "SELECT") selectMaterial(project.materials[Number(row.dataset.i)].material);
    }),
  );
}

function holesPanel() {
  const h = project.hole;
  const length = h.tee && h.cup ? `${Math.round(Math.hypot(h.cup.x - h.tee.x, h.cup.z - h.tee.z))} m` : "place tee and cup";
  return `
    <div class="row">
      <button class="btn btn-primary small" id="add-hole">Add hole</button>
      <button class="btn btn-secondary small" id="remove-hole" ${project.holes.length < 2 ? "disabled" : ""}>Remove this hole</button>
    </div>
    <div class="field"><label for="hole-name">Name</label><input id="hole-name" value="${esc(h.name)}" /></div>
    <div class="field"><label for="par">Par</label><input id="par" type="number" min="1" max="9" value="${h.par}" /></div>
    <div class="field"><label for="difficulty">Difficulty</label><select id="difficulty">${["none", "beginner", "intermediate", "expert"]
      .map((d) => `<option ${d === h.difficulty ? "selected" : ""}>${d}</option>`)
      .join("")}</select></div>
    <div class="field"><label for="water">Water level (m)</label><input id="water" type="number" step="1" value="${h.water}" /></div>
    <div class="field"><label for="green">Green radius (m)</label><input id="green" type="number" min="3" max="40" step="1" value="${h.greenRadius}" /></div>
    <div class="stats">
      ${stat("Tee to cup", length)}
      ${stat("Tee", h.tee ? "placed" : "missing")}
      ${stat("Cup", h.cup ? "placed" : "missing")}
      ${stat(MARKERS.itemBoxes.name + "es", `${h.itemBoxes.length} / 16`)}
      ${stat(MARKERS.checkpoints.name + "s", `${h.checkpoints.length} / 1`)}
    </div>
    <p class="hint">Use the toolbar over the 3D view to place markers. Everything around the cup within the green radius plays as green.</p>`;
}

function wireHoles() {
  const h = project.hole;
  const bind = (id, fn) =>
    info.querySelector(id).addEventListener("change", (e) => {
      fn(e.target.value);
      project.rebuildMarkers();
      fillHoleSelect(project.holes, project.activeHole);
      renderPanel();
    });
  bind("#hole-name", (v) => (h.name = v));
  bind("#par", (v) => (h.par = Math.max(1, Number(v) || 4)));
  bind("#difficulty", (v) => (h.difficulty = v));
  bind("#water", (v) => (h.water = Number(v) || 0));
  bind("#green", (v) => (h.greenRadius = Math.max(3, Number(v) || 10)));
  info.querySelector("#add-hole").addEventListener("click", () => {
    project.addHole();
    fillHoleSelect(project.holes, project.activeHole);
    renderPanel();
  });
  info.querySelector("#remove-hole").addEventListener("click", () => {
    project.removeHole(project.activeHole);
    fillHoleSelect(project.holes, project.activeHole);
    renderPanel();
  });
}

function exportPanel() {
  const problems = project.problems();
  return `
    <div class="field"><label for="map-name">Map name</label><input id="map-name" value="${esc(project.info.name)}" /></div>
    <div class="field"><label for="author">Author</label><input id="author" value="${esc(project.info.author)}" /></div>
    <div class="field"><label for="credits">Credits</label><textarea id="credits" rows="3" placeholder="e.g. Model by ...">${esc(project.info.credits)}</textarea></div>
    ${problems.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p class="ok">Ready to play!</p>`}
    <button class="btn btn-primary" id="export" ${problems.length ? "disabled" : ""}>Download .sbgmap</button>
    <p class="hint">Put the file in <b>Super Battle Golf/SbgMaps/maps/</b> and restart the game. Your holes show up under <b>Custom Maps</b>.</p>`;
}

function wireExport() {
  const bind = (id, key) => info.querySelector(id).addEventListener("input", (e) => (project.info[key] = e.target.value));
  bind("#map-name", "name");
  bind("#author", "author");
  bind("#credits", "credits");
  info.querySelector("#export").addEventListener("click", () =>
    run("Exporting", async () => {
      const bytes = await project.exportSbgmap();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      a.download = `${(project.info.name || "map").replace(/[^\w.-]+/g, "_")}.sbgmap`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`Saved ${a.download} (${Math.round(bytes.length / 1024)} KB)`);
    }),
  );
}

function materialThumb(material) {
  const url = material.userData.thumb;
  return url ? `background-image:url('${url}')` : `background:#${material.color.getHexString()}`;
}

const stat = (label, value) => `<div class="stat"><span>${label}</span><span>${value}</span></div>`;

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
