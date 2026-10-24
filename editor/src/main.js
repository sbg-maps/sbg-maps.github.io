import * as THREE from "three";
import { loadFolder, loadZip } from "./mapfile.js";
import { importModel } from "./importer.js";
import { renderer, pick, pickCenter, hitMaterial, frameBox, scene, camera, controls } from "./scene.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { HeightmapView } from "./viewer.js";
import { Project, MODEL_SURFACES, MARKERS, BASE_Y } from "./project.js";
import { golferInfo, loadGolferFile, restoreGolfer, onGolferChange } from "./golfer.js";
import { PlayerView } from "./pov.js";

const status = document.getElementById("status");
const holeSelect = document.getElementById("hole-select");
const info = document.getElementById("info");
const empty = document.getElementById("empty");
const toolbar = document.getElementById("toolbar");
const dropOverlay = document.getElementById("drop");

/** Golf-sized default: the longest side of an imported level becomes roughly this many metres. */
const DEFAULT_LEVEL_SIZE = 300;

let view = null; // HeightmapView for format 1 maps
let project = null; // Project for model maps
let tab = "model";
let tool = "look";
let selectedMaterial = null;
let selectedObject = null;

const playerView = new PlayerView(() => project);
playerView.setActive(false);
onGolferChange(() => {
  project?.rebuildMarkers();
  if (project && tab === "model") renderPanel();
});
restoreGolfer();

// Move/rotate/scale gizmo for objects and props.
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.addEventListener("dragging-changed", (e) => (controls.enabled = !e.value));
gizmo.addEventListener("objectChange", () => project?.rebuildMarkers());
scene.add(gizmo.getHelper());

function setStatus(text, isError = false) {
  status.textContent = text;
  status.title = text;
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
  gizmo.detach();
  playerView.setActive(false);
  selectedObject = null;
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
  project.scale = niceScale(DEFAULT_LEVEL_SIZE / Math.max(size.x, size.z));
  project.applyTransform();
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
      ${stat("Start to flag", `${Math.round(length)} m`)}
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
  { id: "tee", name: "Start", tip: "Click to place the Start: the tee, where players hit their first shot." },
  { id: "cup", name: "Flag", tip: "Click to place the Flag: the hole (cup) players are aiming for." },
  { id: "itemBoxes", name: "Item box", tip: "Click to add item boxes." },
  { id: "checkpoints", name: "Checkpoint", tip: "Click to add a checkpoint." },
  { id: "pov", name: "Player view", tip: "Click to stand there and see what a player sees (in the Player view window)." },
  { id: "golfer", name: "Golfer", tip: "Click to drop a golfer (player-sized) anywhere, to judge the scale. Not saved into the map." },
  { id: "erase", name: "Erase", tip: "Click a marker or golfer to remove it." },
];

function startEditing() {
  playerView.setActive(true);
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
    const owner = project.objects.find((o) => isInside(o, hit.object));
    if (tab === "objects" && owner) selectObject(owner);
    else selectMaterial(hitMaterial(hit));
  } else if (tool === "pov") {
    playerView.standAt(hit.point);
  } else if (tool === "erase") {
    if (!project.erase(hit.point)) setStatus("No marker there");
    renderPanel();
  } else {
    project.place(tool, hit.point);
    renderPanel();
  }
});

function isInside(ancestor, object) {
  for (let o = object; o; o = o.parent) if (o === ancestor) return true;
  return false;
}

function selectObject(object) {
  selectedObject = object;
  if (object) gizmo.attach(object);
  else gizmo.detach();
  tab = "objects";
  renderPanel();
}

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
    ["objects", "Objects"],
    ["holes", "Holes"],
    ["export", "Export"],
  ];
  if (tab !== "objects") gizmo.detach();
  else if (selectedObject) gizmo.attach(selectedObject);
  info.innerHTML = `
    <nav class="tabs">${tabs.map(([id, name]) => `<button class="tab ${id === tab ? "active" : ""}" data-tab="${id}">${name}</button>`).join("")}</nav>
    <section>${{ model: modelPanel, objects: objectsPanel, holes: holesPanel, export: exportPanel }[tab]()}</section>`;
  info.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => ((tab = b.dataset.tab), renderPanel())));
  ({ model: wireModel, objects: wireObjects, holes: wireHoles, export: wireExport })[tab]();
}

function modelPanel() {
  const [sx, sz] = project.size;
  return `
    <h3>Size</h3>
    <div class="field"><label for="scale">Scale</label><input id="scale" type="number" min="0.0001" step="any" value="${+project.scale.toPrecision(3)}" /></div>
    <div class="stats">${stat("Course area", `${sx} x ${sz} m`)}</div>
    <h3>Your golfer</h3>
    <p class="hint">${
      golferInfo().fromGame
        ? `Using your golfer from the game (${golferInfo().height.toFixed(2)} m)${golferInfo().camera ? " and its camera" : ""}.`
        : `Using a stand-in golfer (${golferInfo().height} m). In the game, press <b>F9</b> while playing to save your golfer and camera to <b>SbgMaps/golfer.glb</b>, then load it here. It stays on your computer.`
    }</p>
    <label class="btn btn-secondary small" tabindex="0">Load golfer.glb<input id="golfer-file" type="file" accept=".glb" hidden /></label>
    <div class="row"><button class="btn btn-secondary small" id="rotate">Rotate 90&deg;</button>
    <label class="check"><input type="checkbox" id="overlay" ${project.surfaceOverlay ? "checked" : ""} /> Show surfaces</label></div>
    <h3>Surfaces</h3>
    <p class="hint">Pick what each material plays as. Tip: click the level with Look to find a material.${
      project.hasCollisionMesh ? " This level has a separate collision mesh: tick Show surfaces to see it." : ""
    }</p>
    <div class="materials">${project.materials
      .map(({ material }, i) => (material.userData.renderOnly ? "" : `<div class="material ${material === selectedMaterial ? "selected" : ""}" data-i="${i}">
          <span class="thumb" style="${materialThumb(material)}"></span>
          <span class="mat-name" title="${esc(material.name)}">${esc(material.name || `Material ${i + 1}`)}</span>
          <select data-i="${i}" class="surface">${surfaceOptions(material.userData.surface)}</select>
        </div>`))
      .join("")}</div>`;
}

function surfaceOptions(selected) {
  const groups = [...new Set(MODEL_SURFACES.map((s) => s.group))];
  return groups
    .map((g) => `<optgroup label="${g}">${MODEL_SURFACES.filter((s) => s.group === g)
      .map((s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${s.name}</option>`)
      .join("")}</optgroup>`)
    .join("");
}

function wireModel() {
  info.querySelector("#scale").addEventListener("change", (e) => {
    project.scale = Math.max(0.0001, Number(e.target.value) || 1);
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
  info.querySelector("#golfer-file").addEventListener("change", (e) =>
    e.target.files[0] && run("Loading golfer", async () => {
      await loadGolferFile(e.target.files[0]);
      setStatus("Golfer loaded");
    }),
  );
  info.querySelectorAll("select.surface").forEach((s) =>
    s.addEventListener("change", () => project.setSurface(project.materials[Number(s.dataset.i)].material, s.value)),
  );
  info.querySelectorAll(".material").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.tagName !== "SELECT") selectMaterial(project.materials[Number(row.dataset.i)].material);
    }),
  );
}

const BEHAVIOURS = [
  ["static", "Static"],
  ["seesaw", "Tilting see-saw"],
  ["roller", "Roller (rolls balls along a path)"],
];

function objectsPanel() {
  const objects = project.objects;
  const sel = selectedObject;
  return `
    <label class="btn btn-primary small" tabindex="0">Add prop<input id="add-prop" type="file" multiple hidden /></label>
    <p class="hint">Props are extra models (a bridge, a lid, trees...). They appear where you are looking. Click an object in the view or the list to move it.</p>
    ${sel ? `
      <div class="row">
        ${["translate", "rotate", "scale"].map((m) => `<button class="btn btn-secondary small gizmo-mode ${gizmo.mode === m ? "active-mode" : ""}" data-mode="${m}">${{ translate: "Move", rotate: "Rotate", scale: "Size" }[m]}</button>`).join("")}
      </div>` : ""}
    <div class="objects">${objects
      .map((o, i) => `<div class="object ${o === sel ? "selected" : ""}" data-i="${i}">
        <input type="checkbox" class="obj-visible" data-i="${i}" ${o.visible ? "checked" : ""} title="Include in the map" />
        <span class="mat-name" title="${esc(o.name)}">${esc(o.name || `Object ${i + 1}`)}</span>
        <select class="obj-behaviour" data-i="${i}">${BEHAVIOURS.filter(([id]) => id !== "roller" || o.userData.path)
          .map(([id, name]) => `<option value="${id}" ${id === o.userData.object ? "selected" : ""}>${name}</option>`)
          .join("")}</select>
        <button class="icon-btn obj-delete" data-i="${i}" title="Delete">&times;</button>
      </div>`)
      .join("") || `<p class="hint">No objects yet.</p>`}</div>`;
}

function wireObjects() {
  const objects = project.objects;
  info.querySelector("#add-prop").addEventListener("change", (e) =>
    e.target.files.length &&
    run("Adding prop", async () => {
      const { root, missing } = await importModel(e.target.files);
      const hit = pickCenter([project.root]);
      const prop = project.addProp(root, hit ? hit.point : project.box.getCenter(new THREE.Vector3()));
      selectObject(prop);
      setStatus(missing.length ? `Added, but these files were missing: ${missing.join(", ")}` : `Added ${prop.name}`, missing.length > 0);
    }),
  );
  info.querySelectorAll(".gizmo-mode").forEach((b) => b.addEventListener("click", () => (gizmo.setMode(b.dataset.mode), renderPanel())));
  info.querySelectorAll(".object").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (!["SELECT", "INPUT", "BUTTON"].includes(e.target.tagName)) selectObject(objects[Number(row.dataset.i)]);
    }),
  );
  info.querySelectorAll(".obj-visible").forEach((c) =>
    c.addEventListener("change", () => {
      objects[Number(c.dataset.i)].visible = c.checked;
      project.rebuildMarkers();
    }),
  );
  info.querySelectorAll(".obj-behaviour").forEach((sel) => sel.addEventListener("change", () => (objects[Number(sel.dataset.i)].userData.object = sel.value)));
  info.querySelectorAll(".obj-delete").forEach((b) =>
    b.addEventListener("click", () => {
      const o = objects[Number(b.dataset.i)];
      if (o === selectedObject) selectObject(null);
      project.removeObject(o);
      project.rebuildMarkers();
      renderPanel();
    }),
  );
}

function holesPanel() {
  const h = project.hole;
  const length = h.tee && h.cup ? `${Math.round(Math.hypot(h.cup.x - h.tee.x, h.cup.z - h.tee.z))} m` : "place Start and Flag";
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
    ${h.tee ? `
    <div class="field"><label for="tee-y">Start height (m)</label><input id="tee-y" type="number" step="0.25" value="${round2(h.tee.y)}" /></div>
    <div class="field"><label for="tee-yaw">Start direction</label>
      <div class="row tight"><label class="check"><input type="checkbox" id="tee-face" ${h.tee.yaw == null ? "checked" : ""} /> Face the flag</label>
      <input id="tee-yaw" type="number" min="0" max="359" step="15" value="${Math.round(h.tee.yaw ?? 0)}" ${h.tee.yaw == null ? "disabled" : ""} /> &deg;</div></div>` : ""}
    <div class="field"><label for="water">Water level (m)</label><input id="water" type="number" step="1" value="${h.water}" /></div>
    <p class="hint">The level's lowest point is at ${BASE_Y} m.</p>
    <div class="field"><label for="green">Green radius around the flag (m)</label><input id="green" type="number" min="3" max="40" step="1" value="${h.greenRadius}" /></div>
    <div class="stats">
      ${stat("Start to flag", length)}
      ${stat("Start (tee)", h.tee ? "placed" : "missing")}
      ${stat("Flag (cup)", h.cup ? "placed" : "missing")}
      ${stat(MARKERS.itemBoxes.name + "es", `${h.itemBoxes.length} / 16`)}
      ${stat(MARKERS.checkpoints.name + "s", `${h.checkpoints.length} / 1`)}
    </div>
    <p class="hint">Use the toolbar over the 3D view to place things. <b>Start</b> is where players tee off, <b>Flag</b> is the hole they aim for. Ground within the green radius of the flag plays as a putting green.</p>`;
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
  if (h.tee) {
    bind("#tee-y", (v) => (h.tee.y = Number(v) || 0));
    bind("#tee-yaw", (v) => (h.tee.yaw = ((Number(v) % 360) + 360) % 360));
    info.querySelector("#tee-face").addEventListener("change", (e) => {
      if (e.target.checked) delete h.tee.yaw;
      else h.tee.yaw = h.cup ? Math.round((Math.atan2(h.cup.x - h.tee.x, h.cup.z - h.tee.z) * 180) / Math.PI + 360) % 360 : 0;
      project.rebuildMarkers();
      renderPanel();
    });
  }
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

const round2 = (v) => Math.round(v * 100) / 100;

/** Rounds a scale factor to two significant digits (game levels can be 0.03 or 5.5). */
function niceScale(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.max(1e-4, Math.round(v / p) * p);
}
const stat = (label, value) => `<div class="stat"><span>${label}</span><span>${value}</span></div>`;

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
