import * as THREE from "three";
import { loadFolder, loadZip, holeGrids, SURFACES } from "./mapfile.js";
import { importModel } from "./importer.js";
import { renderer, pick, pickCenter, hitMaterial, frameBox, scene, camera, controls, onFrame } from "./scene.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { HeightmapView } from "./viewer.js";
import { Project, MODEL_SURFACES, MARKERS, BASE_Y } from "./project.js";
import { golferInfo, loadGolferFile, restoreGolfer, onGolferChange } from "./golfer.js";
import { PlayerView } from "./pov.js";
import { Terrain } from "./terrain.js";
import { History } from "./history.js";
import { SHAPES, spriteFromImage, circlePath, linePath } from "./shapes.js";

const status = document.getElementById("status");
const holeSelect = document.getElementById("hole-select");
const info = document.getElementById("info");
const empty = document.getElementById("empty");
const toolbar = document.getElementById("toolbar");
const dropOverlay = document.getElementById("drop");

/** Golf-sized default: the longest side of an imported level becomes roughly this many metres. */
const DEFAULT_LEVEL_SIZE = 300;

let view = null; // HeightmapView for heightmap maps whose holes each have their own terrain
let project = null; // the level being edited
let tab = "model";
let tool = "look";
let selectedMaterial = null;
let selectedObject = null;
const brush = { radius: 8, strength: 6, surface: 1 };

const history = new History(
  () => project,
  () => {
    if (selectedObject && !selectedObject.parent) selectObject(null);
    fillHoleSelect(project.holes, project.activeHole);
    renderPanel();
  },
);

const playerView = new PlayerView(() => project);
playerView.setActive(false);
onGolferChange(() => {
  project?.rebuildMarkers();
  if (project && tab === "model") renderPanel();
});
restoreGolfer();

// Move/rotate/scale gizmo for objects and props. A drag is one undo step.
const gizmo = new TransformControls(camera, renderer.domElement);
let gizmoBefore = null;
gizmo.addEventListener("dragging-changed", (e) => {
  controls.enabled = !e.value;
  if (e.value) gizmoBefore = history.capture();
  else {
    history.commit(gizmoBefore);
    gizmoBefore = null;
  }
});
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
  history.clear();
  setTool("look");
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

// ---------- Opening and creating ----------

async function openMap(map) {
  const opened = await Project.fromMap(map);
  clear();
  empty.hidden = true;
  if (opened) {
    project = opened;
    startEditing();
  } else {
    view = new HeightmapView(map);
    view.map = map;
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

function newLevel(sizeX, sizeZ) {
  clear();
  empty.hidden = true;
  project = Project.newLevel(sizeX, sizeZ, { name: "My level" });
  startEditing("terrain");
  setTool("raise");
  setStatus("New level: sculpt with the brush tools, then place the Start and Flag");
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

// New level dialog.
const newDialog = document.getElementById("new-level");
document.getElementById("new-level-btn").addEventListener("click", () => (newDialog.hidden = false));
newDialog.addEventListener("click", (e) => {
  if (e.target === newDialog || e.target.closest("[data-act=cancel]")) newDialog.hidden = true;
  const size = e.target.closest("[data-size]")?.dataset.size;
  if (size) {
    newDialog.hidden = true;
    const [x, z] = size.split("x").map(Number);
    newLevel(x, z);
  }
});

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

// Undo/redo.
function undo() {
  if (history.undo()) setStatus("Undone");
}
function redo() {
  if (history.redo()) setStatus("Redone");
}
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("redo").addEventListener("click", redo);
window.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  } else if (e.key === "Escape" && tool === "path") setTool("look");
});

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
    <p class="hint">Each hole of this map has its own terrain. Edit one as its own level:</p>
    <button class="btn btn-primary small" id="edit-hole">Edit this hole</button>`;
  info.querySelector("#edit-hole").addEventListener("click", () => editViewHole(index));
}

function editViewHole(index) {
  const map = view.map;
  const h = map.manifest.holes[index];
  const terrain = Terrain.fromHole(h, holeGrids(map, h));
  const root = new THREE.Group();
  clear();
  project = new Project(root, { name: `${map.manifest.name} - ${h.name}`, author: map.manifest.author ?? "" }, { terrain });
  const withY = (p) => (p ? { ...p, y: p.y ?? terrain.heightAt(p.x, p.z) } : null);
  project.holes = [
    {
      name: h.name,
      par: h.par,
      difficulty: h.difficulty ?? "none",
      water: h.water ?? 5,
      greenRadius: 10,
      tee: withY(h.tee),
      cup: withY(h.cup),
      itemBoxes: (h.itemBoxes ?? []).map(withY),
      checkpoints: (h.checkpoints ?? []).map(withY),
    },
  ];
  project.activeHole = 0;
  project.rebuildMarkers();
  startEditing("terrain");
}

// ---------- Tools ----------

const PLACE_TOOLS = [
  { id: "look", name: "Look", tip: "Orbit around. Click the level to find its material, or an object to select it." },
  { id: "tee", name: "Start", tip: "Click to place the Start: the tee, where players hit their first shot." },
  { id: "cup", name: "Flag", tip: "Click to place the Flag: the hole (cup) players are aiming for." },
  { id: "itemBoxes", name: "Item box", tip: "Click to add item boxes." },
  { id: "checkpoints", name: "Checkpoint", tip: "Click to add a checkpoint." },
  { id: "pov", name: "Player view", tip: "Click to stand there and see what a player sees (in the Player view window)." },
  { id: "golfer", name: "Golfer", tip: "Click to drop a golfer (player-sized) anywhere, to judge the scale. Not saved into the map." },
  { id: "erase", name: "Erase", tip: "Click a marker or golfer to remove it." },
];
const TERRAIN_TOOLS = [
  { id: "raise", name: "Raise", tip: "Drag to raise the ground. Right-drag to look around." },
  { id: "lower", name: "Lower", tip: "Drag to lower the ground (below the water level it becomes water). Right-drag to look around." },
  { id: "smooth", name: "Smooth", tip: "Drag to smooth bumps. Right-drag to look around." },
  { id: "flatten", name: "Flatten", tip: "Drag to flatten to the height where you start. Right-drag to look around." },
  { id: "paint", name: "Paint", tip: "Drag to paint the surface chosen in the Terrain tab. Right-drag to look around." },
];
const BRUSH_TOOLS = new Set(TERRAIN_TOOLS.map((t) => t.id));

function startEditing(firstTab = "model") {
  playerView.setActive(true);
  tool = "look";
  tab = firstTab;
  toolbar.hidden = false;
  renderToolbar();
  fillHoleSelect(project.holes, project.activeHole);
  frameBox(project.box);
  renderPanel();
}

function setTool(id) {
  tool = id;
  // Brush tools draw with the left button, so the view orbits with the right button instead.
  controls.mouseButtons = BRUSH_TOOLS.has(id) || id === "path"
    ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  brushCursor.visible = false;
  if (!toolbar.hidden) renderToolbar();
}

function renderToolbar() {
  const tools = project?.terrain ? [...PLACE_TOOLS.slice(0, 1), ...TERRAIN_TOOLS, ...PLACE_TOOLS.slice(1)] : PLACE_TOOLS;
  toolbar.innerHTML =
    tools.map((t) => `<button class="tool ${t.id === tool ? "active" : ""} ${BRUSH_TOOLS.has(t.id) ? "brush" : ""}" data-tool="${t.id}" title="${t.tip}">${t.name}</button>`).join("") +
    (tool === "path" ? `<button class="tool active" data-tool="look" title="Stop drawing the path (Esc)">Done drawing</button>` : "");
  toolbar.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      setTool(b.dataset.tool);
      setStatus([...tools, { id: "look", tip: "" }].find((t) => t.id === tool)?.tip ?? "");
    }),
  );
}

// Brush cursor.
const brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true }));
brushCursor.rotation.x = -Math.PI / 2;
brushCursor.renderOrder = 10;
brushCursor.visible = false;
scene.add(brushCursor);

let stroke = null; // { before, last: event, target }
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!project?.terrain || !BRUSH_TOOLS.has(tool)) return;
  const hit = pick(e, [project.terrain.mesh]);
  brushCursor.visible = !!hit;
  if (hit) {
    brushCursor.position.copy(hit.point).y += 0.2;
    brushCursor.scale.setScalar(brush.radius);
  }
  if (stroke) stroke.last = e;
});
renderer.domElement.addEventListener("pointerdown", (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  if (e.button !== 0 || !project?.terrain || !BRUSH_TOOLS.has(tool)) return;
  const hit = pick(e, [project.terrain.mesh]);
  if (!hit) return;
  stroke = { before: history.capture({ terrain: true }), last: e, target: hit.point.y };
  renderer.domElement.setPointerCapture(e.pointerId);
});
window.addEventListener("pointerup", () => {
  if (!stroke) return;
  history.commit(stroke.before, { terrain: true });
  stroke = null;
  project.rebuildMarkers();
});
onFrame(() => {
  if (!stroke || !project?.terrain) return;
  const hit = pick(stroke.last, [project.terrain.mesh]);
  if (!hit) return;
  project.terrain.brush(tool, hit.point.x, -hit.point.z, { radius: brush.radius, strength: brush.strength, surface: brush.surface, target: stroke.target, dt: 1 / 60 });
});

// A click is a pointer press that did not move (so orbiting never places markers).
let downAt = null;
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!project || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || e.button !== 0) return;
  if (BRUSH_TOOLS.has(tool)) return;
  const hit = pick(e, project.pickTargets);
  if (!hit) return;
  if (tool === "look") {
    const owner = project.objects.find((o) => isInside(o, hit.object));
    if (owner) selectObject(owner);
    else if (!hit.object.userData.isTerrain) selectMaterial(hitMaterial(hit));
  } else if (tool === "path") {
    if (!selectedObject) return setTool("look");
    history.record(() => {
      const local = selectedObject.worldToLocal(hit.point.clone());
      selectedObject.userData.path = [...(selectedObject.userData.path ?? []), [local.x, local.y, local.z].map(round3)];
    });
    project.rebuildMarkers();
    renderPanel();
  } else if (tool === "pov") {
    playerView.standAt(hit.point);
  } else if (tool === "erase") {
    history.record(() => {
      if (!project.erase(hit.point)) setStatus("No marker there");
    });
    renderPanel();
  } else {
    history.record(() => project.place(tool, hit.point));
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
  if (tool === "path" && !object) setTool("look");
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

// ---------- Side panel ----------

function renderPanel() {
  if (!project) return;
  const tabs = [
    ...(project.terrain ? [["terrain", "Terrain"]] : []),
    ["model", project.terrain ? "Surfaces" : "Model"],
    ["objects", "Objects"],
    ["holes", "Holes"],
    ["export", "Export"],
  ];
  if (tab !== "objects") gizmo.detach();
  else if (selectedObject) gizmo.attach(selectedObject);
  const panels = { terrain: [terrainPanel, wireTerrain], model: [modelPanel, wireModel], objects: [objectsPanel, wireObjects], holes: [holesPanel, wireHoles], export: [exportPanel, wireExport] };
  info.innerHTML = `
    <nav class="tabs">${tabs.map(([id, name]) => `<button class="tab ${id === tab ? "active" : ""}" data-tab="${id}">${name}</button>`).join("")}</nav>
    <section>${panels[tab][0]()}</section>`;
  info.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => ((tab = b.dataset.tab), renderPanel())));
  panels[tab][1]();
}

// Terrain
const PAINTABLE = [1, 0, 2, 3, 4, 5]; // fairway first

function terrainPanel() {
  const [sx, sz] = project.size;
  return `
    <p class="hint">Pick a brush in the toolbar and drag over the ground. <b>Right-drag</b> looks around, the wheel zooms. Ctrl+Z undoes.</p>
    <div class="field"><label for="brush-radius">Brush size: ${brush.radius} m</label><input id="brush-radius" type="range" min="2" max="40" value="${brush.radius}" /></div>
    <div class="field"><label for="brush-strength">Strength: ${brush.strength}</label><input id="brush-strength" type="range" min="1" max="20" value="${brush.strength}" /></div>
    <h3>Paint</h3>
    <div class="swatches">${PAINTABLE.map((id) => `<button class="swatch ${brush.surface === id ? "active" : ""}" data-surface="${id}"><i style="background:rgb(${SURFACES[id].color})"></i>${SURFACES[id].name}</button>`).join("")}</div>
    <p class="hint">Painted terrain uses the game's own ground textures and grass. Anything lowered below the water level (${project.hole.water} m) becomes water.</p>
    <div class="stats">${stat("Level size", `${sx} x ${sz} m`)}</div>`;
}

function wireTerrain() {
  info.querySelector("#brush-radius").addEventListener("input", (e) => {
    brush.radius = Number(e.target.value);
    e.target.previousElementSibling.textContent = `Brush size: ${brush.radius} m`;
  });
  info.querySelector("#brush-strength").addEventListener("input", (e) => {
    brush.strength = Number(e.target.value);
    e.target.previousElementSibling.textContent = `Strength: ${brush.strength}`;
  });
  info.querySelectorAll(".swatch").forEach((b) =>
    b.addEventListener("click", () => {
      brush.surface = Number(b.dataset.surface);
      setTool("paint");
      renderPanel();
    }),
  );
}

// Model / surfaces
function modelPanel() {
  const [sx, sz] = project.size;
  const surfaceRows = project.materials
    .map(({ material }, i) =>
      material.userData.renderOnly
        ? ""
        : `<div class="material ${material === selectedMaterial ? "selected" : ""}" data-i="${i}">
          <span class="thumb" style="${materialThumb(material)}"></span>
          <span class="mat-name" title="${esc(material.name)}">${esc(material.name || `Material ${i + 1}`)}</span>
          <select data-i="${i}" class="surface">${surfaceOptions(material.userData.surface)}</select>
        </div>`,
    )
    .join("");
  return `
    ${project.terrain ? "" : `
    <h3>Size</h3>
    <div class="field"><label for="scale">Scale</label><input id="scale" type="number" min="0.0001" step="any" value="${+project.scale.toPrecision(3)}" /></div>
    <div class="stats">${stat("Course area", `${sx} x ${sz} m`)}</div>`}
    <h3>Your golfer</h3>
    <p class="hint">${
      golferInfo().fromGame
        ? `Using your golfer from the game (${golferInfo().height.toFixed(2)} m)${golferInfo().camera ? " and its camera" : ""}.`
        : `Using a stand-in golfer (${golferInfo().height} m). In the game, press <b>F9</b> while playing to save your golfer and camera to <b>SbgMaps/golfer.glb</b>, then load it here. It stays on your computer.`
    }</p>
    <label class="btn btn-secondary small" tabindex="0">Load golfer.glb<input id="golfer-file" type="file" accept=".glb" hidden /></label>
    <div class="row">${project.terrain ? "" : `<button class="btn btn-secondary small" id="rotate">Rotate 90&deg;</button>`}
    <label class="check"><input type="checkbox" id="overlay" ${project.surfaceOverlay ? "checked" : ""} /> Show surfaces</label></div>
    <h3>Surfaces</h3>
    <p class="hint">${project.terrain ? "Surfaces of your objects and props (the terrain is painted in the Terrain tab)." : "Pick what each material plays as. Tip: click the level with Look to find a material."}${
      project.hasCollisionMesh ? " This level has a separate collision mesh: tick Show surfaces to see it." : ""
    }</p>
    <div class="materials">${surfaceRows || `<p class="hint">Nothing here yet.</p>`}</div>`;
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
  info.querySelector("#scale")?.addEventListener("change", (e) => {
    project.scale = Math.max(0.0001, Number(e.target.value) || 1);
    project.applyTransform();
    frameBox(project.box);
    renderPanel();
  });
  info.querySelector("#rotate")?.addEventListener("click", () => {
    project.rotation = (project.rotation + 1) % 4;
    project.applyTransform();
    frameBox(project.box);
    renderPanel();
  });
  info.querySelector("#overlay").addEventListener("change", (e) => project.setSurfaceOverlay(e.target.checked));
  info.querySelector("#golfer-file").addEventListener("change", (e) =>
    e.target.files[0] &&
    run("Loading golfer", async () => {
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

// Objects
const BEHAVIOURS = [
  ["static", "Stays put"],
  ["mover", "Moves along a path"],
  ["roller", "Rolls copies along a path"],
  ["seesaw", "Tilting see-saw"],
  ["chomp", "Chain chomp (lunges around its spot)"],
];
const DEFAULTS = {
  mover: { speed: 4, loop: true, count: 1 },
  roller: { speed: 8, interval: 3 },
};

/** The object's size in metres per local unit (paths and speeds are stored in local units). */
const unitScale = (o) => o.getWorldScale(new THREE.Vector3()).x || 1;

function objectsPanel() {
  const objects = project.objects;
  const sel = selectedObject;
  return `
    <h3>Add</h3>
    <div class="palette">
      ${Object.entries(SHAPES).map(([id, s]) => `<button class="btn btn-secondary small add-shape" data-shape="${id}">${s.name}</button>`).join("")}
      <label class="btn btn-secondary small" tabindex="0">Picture<input id="add-sprite" type="file" accept="image/*" hidden /></label>
      <label class="btn btn-secondary small" tabindex="0">3D model<input id="add-prop" type="file" multiple hidden /></label>
    </div>
    <p class="hint">New objects appear where you are looking. Click one in the view or the list to select it.</p>
    ${sel ? selectedObjectPanel(sel) : ""}
    <h3>In this level</h3>
    <div class="objects">${objects
      .map((o, i) => `<div class="object ${o === sel ? "selected" : ""}" data-i="${i}">
        <input type="checkbox" class="obj-visible" data-i="${i}" ${o.visible ? "checked" : ""} title="Include in the map" />
        <span class="mat-name" title="${esc(o.name)}">${esc(o.name || `Object ${i + 1}`)}</span>
        <span class="obj-kind">${esc(BEHAVIOURS.find(([id]) => id === o.userData.object)?.[1] ?? "")}</span>
        <button class="icon-btn obj-delete" data-i="${i}" title="Delete">&times;</button>
      </div>`)
      .join("") || `<p class="hint">No objects yet.</p>`}</div>`;
}

function selectedObjectPanel(o) {
  const d = o.userData;
  const kind = d.object ?? "static";
  const s = unitScale(o);
  const pathed = kind === "mover" || kind === "roller";
  const points = d.path?.length ?? 0;
  return `
    <div class="card">
      <div class="field"><label for="obj-name">Name</label><input id="obj-name" value="${esc(o.name)}" /></div>
      <div class="row">
        ${["translate", "rotate", "scale"].map((m) => `<button class="btn btn-secondary small gizmo-mode ${gizmo.mode === m ? "active-mode" : ""}" data-mode="${m}">${{ translate: "Move", rotate: "Rotate", scale: "Size" }[m]}</button>`).join("")}
      </div>
      <div class="field"><label for="obj-kind">Behaviour</label><select id="obj-kind">${BEHAVIOURS.map(([id, name]) => `<option value="${id}" ${id === kind ? "selected" : ""}>${name}</option>`).join("")}</select></div>
      ${pathed ? `
        <div class="field"><label for="obj-speed">Speed (m/s)</label><input id="obj-speed" type="number" min="0.5" max="60" step="0.5" value="${round2((d.speed ?? DEFAULTS[kind].speed / s) * s)}" /></div>
        ${kind === "mover" ? `
          <div class="field"><label for="obj-count">Copies on the path</label><input id="obj-count" type="number" min="1" max="16" value="${d.count ?? 1}" /></div>
          <label class="check"><input type="checkbox" id="obj-loop" ${d.loop ?? true ? "checked" : ""} /> Go round the path (otherwise back and forth)</label>
          <label class="check"><input type="checkbox" id="obj-knocks" ${d.knocks ? "checked" : ""} /> Knocks players over</label>` : `
          <div class="field"><label for="obj-interval">Seconds between copies</label><input id="obj-interval" type="number" min="0.5" max="30" step="0.5" value="${d.interval ?? DEFAULTS.roller.interval}" /></div>
          <p class="hint">Rolling copies always knock players over.</p>`}
        <h3>Path (${points} point${points === 1 ? "" : "s"})</h3>
        <div class="row">
          <button class="btn ${tool === "path" ? "btn-primary" : "btn-secondary"} small" id="path-draw">${tool === "path" ? "Drawing: click the ground" : "Draw path"}</button>
          <button class="btn btn-secondary small" id="path-circle">Circle</button>
          <button class="btn btn-secondary small" id="path-line">Back and forth</button>
          <button class="btn btn-secondary small" id="path-clear" ${points ? "" : "disabled"}>Clear</button>
        </div>
        <p class="hint">Paths start from where the object stands. ${points < 2 ? "Add at least 2 points." : ""}</p>` : ""}
      ${kind === "chomp" ? `<p class="hint">Hops around where you place it and lunges every few seconds. Touching it knocks players over.</p>` : ""}
      ${kind === "seesaw" ? `<p class="hint">Tilts toward players standing on it. Its long side should run front to back.</p>` : ""}
      <label class="check"><input type="checkbox" id="obj-billboard" ${d.billboard ? "checked" : ""} /> Always face the camera (for pictures)</label>
    </div>`;
}

async function addObject(make, label) {
  const hit = pickCenter(project.pickTargets);
  const where = hit ? hit.point : project.box.getCenter(new THREE.Vector3());
  let obj;
  history.record(() => {
    obj = project.addObject(make.root, where, { size: make.size, billboard: make.billboard });
  });
  selectObject(obj);
  setStatus(`Added ${label}`);
}

function wireObjects() {
  const objects = project.objects;
  info.querySelectorAll(".add-shape").forEach((b) => b.addEventListener("click", () => addObject({ root: SHAPES[b.dataset.shape].make() }, SHAPES[b.dataset.shape].name)));
  info.querySelector("#add-sprite").addEventListener("change", (e) =>
    e.target.files[0] &&
    run("Adding picture", async () => {
      const sprite = await spriteFromImage(e.target.files[0]);
      await addObject({ root: sprite.root, billboard: true }, sprite.root.name);
    }),
  );
  info.querySelector("#add-prop").addEventListener("change", (e) =>
    e.target.files.length &&
    run("Adding model", async () => {
      const { root, missing } = await importModel(e.target.files);
      await addObject({ root, size: 10 }, root.name);
      if (missing.length) setStatus(`Added, but these files were missing: ${missing.join(", ")}`, true);
    }),
  );
  info.querySelectorAll(".object").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (!["SELECT", "INPUT", "BUTTON"].includes(e.target.tagName)) selectObject(objects[Number(row.dataset.i)]);
    }),
  );
  info.querySelectorAll(".obj-visible").forEach((c) =>
    c.addEventListener("change", () => {
      history.record(() => (objects[Number(c.dataset.i)].visible = c.checked));
      project.rebuildMarkers();
    }),
  );
  info.querySelectorAll(".obj-delete").forEach((b) =>
    b.addEventListener("click", () => {
      const o = objects[Number(b.dataset.i)];
      if (o === selectedObject) selectObject(null);
      history.record(() => project.removeObject(o));
      project.rebuildMarkers();
      renderPanel();
    }),
  );
  info.querySelectorAll(".gizmo-mode").forEach((b) => b.addEventListener("click", () => (gizmo.setMode(b.dataset.mode), renderPanel())));

  const o = selectedObject;
  if (!o) return;
  const d = o.userData;
  const s = unitScale(o);
  const edit = (fn, rerender = true) => {
    history.record(fn);
    project.rebuildMarkers();
    if (rerender) renderPanel();
  };
  info.querySelector("#obj-name").addEventListener("change", (e) => edit(() => (o.name = e.target.value)));
  info.querySelector("#obj-kind").addEventListener("change", (e) =>
    edit(() => {
      d.object = e.target.value;
      // Give moving things sensible starting values, in the object's own units.
      if (DEFAULTS[d.object]) {
        d.speed ??= DEFAULTS[d.object].speed / s;
        if (d.object === "mover") {
          d.loop ??= true;
          d.count ??= 1;
        } else d.interval ??= DEFAULTS.roller.interval;
        if (!d.path || d.path.length < 2) d.path = circlePath(10 / s);
      }
      if (d.object === "roller" && d.radius == null) {
        const size = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
        d.radius = Math.max(size.x, size.y, size.z) / 2 / s;
      }
    }),
  );
  info.querySelector("#obj-speed")?.addEventListener("change", (e) => edit(() => (d.speed = Math.max(0.1, Number(e.target.value) || 1) / s)));
  info.querySelector("#obj-count")?.addEventListener("change", (e) => edit(() => (d.count = Math.min(16, Math.max(1, Number(e.target.value) || 1)))));
  info.querySelector("#obj-loop")?.addEventListener("change", (e) => edit(() => (d.loop = e.target.checked)));
  info.querySelector("#obj-knocks")?.addEventListener("change", (e) => edit(() => (d.knocks = e.target.checked)));
  info.querySelector("#obj-interval")?.addEventListener("change", (e) => edit(() => (d.interval = Math.max(0.5, Number(e.target.value) || 3))));
  info.querySelector("#obj-billboard").addEventListener("change", (e) => edit(() => (d.billboard = e.target.checked)));
  info.querySelector("#path-draw")?.addEventListener("click", () => {
    setTool(tool === "path" ? "look" : "path");
    setStatus(tool === "path" ? "Click the ground to add path points. Esc or Done drawing to stop." : "");
    renderPanel();
  });
  info.querySelector("#path-circle")?.addEventListener("click", () => edit(() => (d.path = circlePath(10 / s))));
  info.querySelector("#path-line")?.addEventListener("click", () => edit(() => ((d.path = linePath(20 / s)), (d.loop = false))));
  info.querySelector("#path-clear")?.addEventListener("click", () => edit(() => (d.path = [])));
}

// Holes
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
    ${project.terrain ? "" : `<p class="hint">The level's lowest point is at ${BASE_Y} m.</p>`}
    <div class="field"><label for="green">Green radius around the flag (m)</label><input id="green" type="number" min="3" max="40" step="1" value="${h.greenRadius}" /></div>
    <div class="stats">
      ${stat("Start to flag", length)}
      ${stat("Start (tee)", h.tee ? "placed" : "missing")}
      ${stat("Flag (cup)", h.cup ? "placed" : "missing")}
      ${stat(MARKERS.itemBoxes.name + "es", `${h.itemBoxes.length} / 16`)}
      ${stat(MARKERS.checkpoints.name + "s", `${h.checkpoints.length} / 1`)}
    </div>
    <p class="hint">Use the toolbar over the 3D view to place things. <b>Start</b> is where players tee off, <b>Flag</b> is the hole they aim for. ${
      project.terrain ? "Paint a green around the flag in the Terrain tab." : "Ground within the green radius of the flag plays as a putting green."
    }</p>`;
}

function wireHoles() {
  const h = project.hole;
  const bind = (id, fn) =>
    info.querySelector(id).addEventListener("change", (e) => {
      history.record(() => fn(e.target.value));
      project.rebuildMarkers();
      fillHoleSelect(project.holes, project.activeHole);
      renderPanel();
    });
  bind("#hole-name", (v) => (project.hole.name = v));
  bind("#par", (v) => (project.hole.par = Math.max(1, Number(v) || 4)));
  bind("#difficulty", (v) => (project.hole.difficulty = v));
  bind("#water", (v) => (project.hole.water = Number(v) || 0));
  if (h.tee) {
    bind("#tee-y", (v) => (project.hole.tee.y = Number(v) || 0));
    bind("#tee-yaw", (v) => (project.hole.tee.yaw = ((Number(v) % 360) + 360) % 360));
    info.querySelector("#tee-face").addEventListener("change", (e) => {
      history.record(() => {
        const t = project.hole.tee;
        const c = project.hole.cup;
        if (e.target.checked) delete t.yaw;
        else t.yaw = c ? Math.round((Math.atan2(c.x - t.x, c.z - t.z) * 180) / Math.PI + 360) % 360 : 0;
      });
      project.rebuildMarkers();
      renderPanel();
    });
  }
  bind("#green", (v) => (project.hole.greenRadius = Math.max(3, Number(v) || 10)));
  info.querySelector("#add-hole").addEventListener("click", () => {
    history.record(() => project.addHole());
    fillHoleSelect(project.holes, project.activeHole);
    renderPanel();
  });
  info.querySelector("#remove-hole").addEventListener("click", () => {
    history.record(() => project.removeHole(project.activeHole));
    fillHoleSelect(project.holes, project.activeHole);
    renderPanel();
  });
}

// Export
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

// ---------- Helpers ----------

function materialThumb(material) {
  const url = material.userData.thumb;
  return url ? `background-image:url('${url}')` : `background:#${material.color.getHexString()}`;
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Rounds a scale factor to two significant digits (game levels can be 0.03 or 5.5). */
function niceScale(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.max(1e-4, Math.round(v / p) * p);
}
const stat = (label, value) => `<div class="stat"><span>${label}</span><span>${value}</span></div>`;

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Test hook: lets the automated browser tests reach editor state.
window.__sbg = { get project() { return project; }, history };
