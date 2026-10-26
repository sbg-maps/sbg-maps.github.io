import * as THREE from "three";
import { loadFolder, loadZip, holeGrids, SURFACES } from "./mapfile.js";
import { importModel, importModels, findModels, unpackZips, expandArchives } from "./importer.js";
import { renderer, pick, pickCenter, pointerRay, hitMaterial, frameBox, scene, camera, controls, onFrame, frame } from "./scene.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { HeightmapView } from "./viewer.js";
import { Project, MODEL_SURFACES, MARKERS, BASE_Y, MAX_PER_HOLE, MAX_SIZE, ITEMS } from "./project.js";
import { golferInfo, loadGolferFile, restoreGolfer, onGolferChange } from "./golfer.js";
import { PlayerView } from "./pov.js";
import { Terrain } from "./terrain.js";
import { History } from "./history.js";
import { SHAPES, spriteFromImage, circlePath, linePath } from "./shapes.js";
import { put as storePut, get as storeGet } from "./storage.js";
import { CHANGES } from "./changes.js";
import { MOD_VERSION, MOD_VERSIONS, downloadedVersion, shortDate } from "./mod.js";
import { SKIES } from "./skies.js";
import { isFlying, setFlying, onFlyChange, flySpeed, setLookButtons, setLookBlocked } from "./fly.js";

const status = document.getElementById("status");
const holeSelect = document.getElementById("hole-select");
const info = document.getElementById("info");
const empty = document.getElementById("empty");
const flyBtn = document.getElementById("fly-btn");
const closeBtn = document.getElementById("close-btn");
const flyHint = document.getElementById("fly-hint");
const toolbar = document.getElementById("toolbar");
const dropOverlay = document.getElementById("drop");

/** Golf-sized default: the longest side of an imported level becomes roughly this many metres. */
const DEFAULT_LEVEL_SIZE = 300;

let view = null; // HeightmapView for heightmap maps whose holes each have their own terrain
let project = null; // the level being edited
let tab = "model";
let tool = "look";
let selectedMaterial = null;
/** Every selected material (Shift+click adds or removes); changes made to one of them apply to all. */
const selectedMaterials = new Set();
let selectedObject = null;
const brush = { radius: 14, strength: 12, surface: 1 };
const newLevelChoice = { shape: "island", size: "500x600" };

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
  controls.enabled = !e.value && !isFlying();
  if (e.value) gizmoBefore = history.capture();
  else {
    history.commit(gizmoBefore);
    gizmoBefore = null;
    if (project) {
      project.shapeVersion++;
      project.rebuildMarkers();
    }
  }
});
gizmo.addEventListener("objectChange", () => project?.rebuildMarkers());
setLookBlocked(() => gizmo.dragging);
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
  stopSongPreview();
  view = project = null;
  selectedMaterial = null;
  selectedMaterials.clear();
  showAllMaterials = false;
  toolbar.hidden = true;
  scene.background = null;
  renderer.domElement.parentElement.style.background = "";
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
  flyBtn.hidden = false;
  closeBtn.hidden = false;
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

async function openModel(picked, name = "Level") {
  const files = await unpackZips([...picked]);
  const models = findModels(files);
  const model = models.length > 1 ? await chooseModel(models) : models[0];
  if (models.length > 1 && !model) return setStatus("Import cancelled");
  const { root, missing, layers, backdrops = [] } =
    model === ALL_MODELS
      ? await importModels(files, models, name, (i, n) => setStatus(`Importing part ${i + 1} of ${n}...`))
      : await importModel(files, model);
  clear();
  empty.hidden = true;
  flyBtn.hidden = false;
  closeBtn.hidden = false;
  project = new Project(root);
  const size = project.box.getSize(new THREE.Vector3());
  // Converted game worlds are in metres already (and sections must keep one scale to line up): true size.
  project.scale = Array.isArray(root.userData.worldOrigin) ? 1 : niceScale(DEFAULT_LEVEL_SIZE / Math.max(size.x, size.z));
  project.applyTransform();
  startEditing();
  const parts = model === ALL_MODELS ? ` (${models.length - backdrops.length} parts${backdrops.length ? `, left out ${backdrops.length} sky and backdrop parts` : ""})` : "";
  const extra = layers ? ` (left out ${layers} stacked shadow/light layers)` : "";
  setStatus(missing.length ? `Imported, but these files were missing: ${missing.join(", ")}` : `Imported ${root.name}${parts}${extra}`, missing.length > 0);
}

/** chooseModel's answer for "all of them, as one level". */
const ALL_MODELS = "all";
// From this many model files on, a download is most likely one level split into parts.
const PARTS_FROM = 4;

/** Asks which of several model files to import; resolves to the File, ALL_MODELS, or null if cancelled. */
function chooseModel(models) {
  const dialog = document.getElementById("pick-model");
  const list = dialog.querySelector(".models");
  const mb = (n) => (n / 1048576 >= 0.1 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
  const together = models.length >= PARTS_FROM;
  const total = models.reduce((a, m) => a + m.size, 0);
  list.innerHTML =
    `<button class="choice all ${together ? "active" : ""}" data-i="all">All ${models.length} together <small>one level, ${mb(total)}</small></button>` +
    models.map((m, i) => `<button class="choice ${!together && !i ? "active" : ""}" data-i="${i}">${esc(m.name)} <small>${mb(m.size)}</small></button>`).join("");
  dialog.hidden = false;
  let chosen = together ? ALL_MODELS : 0;
  return new Promise((resolve) => {
    dialog.onclick = (e) => {
      const choice = e.target.closest(".choice");
      if (choice) {
        chosen = choice.dataset.i === "all" ? ALL_MODELS : Number(choice.dataset.i);
        list.querySelectorAll(".choice").forEach((c) => c.classList.toggle("active", c === choice));
      }
      const done = e.target.closest("[data-act=import]") ? (chosen === ALL_MODELS ? ALL_MODELS : models[chosen]) : e.target === dialog || e.target.closest("[data-act=cancel]") ? null : undefined;
      if (done === undefined) return;
      dialog.hidden = true;
      dialog.onclick = null;
      resolve(done);
    };
  });
}

function newLevel(sizeX, sizeZ, shape) {
  clear();
  empty.hidden = true;
  flyBtn.hidden = false;
  closeBtn.hidden = false;
  project = Project.newLevel(sizeX, sizeZ, { name: "My level" }, shape, newSeed());
  project.levelShape = shape;
  startEditing("terrain");
  setTool(shape === "sea" ? "land" : "raise");
  setStatus(shape === "sea" ? "Paint land out of the sea with the Land brush" : "Shape the land with the brushes, then place the Start and Flag");
}

const newSeed = () => (Math.random() * 1e9) | 0;

/**
 * Decides what a set of picked or dropped files is: a map (a map folder or a .sbgmap, also inside zips) or a model
 * (with its textures, also zipped, even zips inside zips).
 */
async function openFiles(picked) {
  // A .sbgmap on its own opens as it is (it is a zip, but should not be unpacked like a model download).
  if (picked.length === 1 && /\.sbgmap$/i.test(picked[0].file.name)) return openMap(await loadZip(picked[0].file));
  const entries = await expandArchives(picked);
  const manifests = entries.filter((e) => e.path.split("/").pop() === "map.json");
  if (manifests.length) {
    // The top-most map.json is the map (a map folder, or one zipped with its folder).
    const top = manifests.sort((a, b) => a.path.length - b.path.length)[0];
    const root = top.path.slice(0, -"map.json".length);
    return openMap(await loadFolder(entries.filter((e) => e.path.startsWith(root))));
  }
  const maps = entries.filter((e) => /\.sbgmap$/i.test(e.file.name));
  if (maps.length && !findModels(entries.map((e) => e.file)).length) return openMap(await loadZip(maps[0].file));
  return openModel(entries.map((e) => e.file), levelName(picked, entries));
}

/** A name for a level made of several parts: the folder they are in, or the zip or folder that was opened. */
function levelName(picked, entries) {
  const model = entries.find((e) => findModels([e.file]).length);
  const folder = model?.path.split("/").slice(-2, -1)[0];
  return folder || picked[0]?.file.name.replace(/\.[^.]+$/, "") || "Level";
}

const asEntries = (fileList) => [...fileList].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
document.getElementById("import-files").addEventListener("change", (e) => e.target.files.length && run("Importing", () => openFiles(asEntries(e.target.files))));
document.getElementById("import-folder").addEventListener("change", (e) => e.target.files.length && run("Importing", () => openFiles(asEntries(e.target.files))));
document.getElementById("open-file").addEventListener("change", (e) => e.target.files[0] && run("Opening", () => openFiles(asEntries(e.target.files))));

// New level dialog.
const newDialog = document.getElementById("new-level");
document.getElementById("new-level-btn").addEventListener("click", () => (newDialog.hidden = false));
newDialog.addEventListener("click", (e) => {
  if (e.target === newDialog || e.target.closest("[data-act=cancel]")) newDialog.hidden = true;
  const choice = e.target.closest(".choice");
  if (choice) {
    const group = choice.closest(".choice-group");
    group.querySelectorAll(".choice").forEach((c) => c.classList.toggle("active", c === choice));
    if (choice.dataset.shape) newLevelChoice.shape = choice.dataset.shape;
    if (choice.dataset.size) newLevelChoice.size = choice.dataset.size;
  }
  if (e.target.closest("[data-act=create]")) {
    newDialog.hidden = true;
    const [x, z] = newLevelChoice.size.split("x").map(Number);
    newLevel(x, z, newLevelChoice.shape);
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
  if (!history.undo()) return;
  setStatus("Undone");
  reshaped();
}
function redo() {
  if (!history.redo()) return;
  setStatus("Redone");
  reshaped();
}
/** The level may have changed shape: checks that depend on it run again. */
function reshaped() {
  if (!project) return;
  project.shapeVersion++;
  project.rebuildMarkers();
  renderPanel();
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
  else if (e.key === "Enter" && tool === "area" && project?.cutOutline?.length >= 3) cutArea();
  else if (mod && e.key.toLowerCase() === "d" && project && selectedObject) {
    e.preventDefault();
    duplicateSelected();
  } else if ((e.key === "Delete" || e.key === "Backspace") && project && selectedObject && !isFlying()) {
    // Delete the selected object (or cut-out piece); undo brings it back.
    e.preventDefault();
    const o = selectedObject;
    selectObject(null);
    history.record(() => project.removeObject(o));
    project.rebuildMarkers();
    renderPanel();
    setStatus(`Deleted ${o.name || "object"} (Ctrl+Z brings it back)`);
  }
});

// ---------- Fly view ----------

flyBtn.addEventListener("click", () => {
  flyBtn.blur(); // so Space flies up instead of pressing the button again
  setFlying(!isFlying(), camera.position.distanceTo(controls.target) * 2);
});
onFlyChange((on) => {
  flyBtn.classList.toggle("active", on);
  flyBtn.textContent = on ? "Stop flying" : "Fly";
  flyHint.hidden = !on;
  flyHint.innerHTML = `<b>WASD</b> move, <b>E</b>/<b>Q</b> up/down, <b>Shift</b> or <b>F</b> faster, <b>drag</b> to look (right- or middle-drag with brushes), <b>wheel</b> speed (${flySpeed()} m/s), <b>Esc</b> stop`;
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
      redItemBoxes: (h.redItemBoxes ?? []).map(withY),
      golfCarts: (h.golfCarts ?? []).map(withY),
      checkpoints: (h.checkpoints ?? []).map(withY),
      ...(h.bounds?.length >= 3 ? { bounds: h.bounds.map(([x, z]) => withY({ x, z })) } : {}),
    },
  ];
  project.activeHole = 0;
  project.rebuildMarkers();
  startEditing("terrain");
}

// ---------- Tools ----------

// Toolbar tools, in labelled groups: what makes the hole, editing the level, trying it out. Boxes and carts are picked
// in the Objects tab (with everything else placed on the level) and only show here while being placed.
const PLACE_TOOLS = [
  { id: "look", name: "Look", tip: "Orbit around. Click the level to find its material, or an object to select it." },
  { id: "tee", group: "Hole", name: "Start", tip: "Click to place the Start: the tee, where players hit their first shot." },
  { id: "cup", group: "Hole", name: "Flag", tip: "Click to place the Flag: the hole (cup) players are aiming for." },
  { id: "checkpoints", group: "Hole", name: "Checkpoint", tip: "Click to add checkpoints, in order from the Start to the Flag: players come back to the furthest one they reached." },
  { id: "bounds", group: "Hole", name: "Play area", tip: "Click corners around the hole: balls that leave this area are out of bounds. Erase removes a corner." },
  { id: "itemBoxes", group: "Placing", name: "Item box", tip: "Click to add item boxes (up to 64 per hole). Choose what they give in the Objects tab." },
  { id: "redItemBoxes", group: "Placing", name: "Red box", tip: "Click to add red item boxes: they give the better movement items (like spring boots). Needs mod 0.4.1." },
  { id: "golfCarts", group: "Placing", name: "Golf cart", tip: "Click to park a golf cart (it faces the Flag), or click and drag to aim it. Anyone can drive them. Needs mod 0.4.1." },
  { id: "area", group: "Level", name: "Cut area", tip: "Click corners around a part of the level (seen from above), then Cut it out: everything inside becomes an object you can move, resize or delete. Works on solid meshes too." },
  { id: "part", group: "Level", name: "Remove part", tip: "Click a part of the level to remove it: one file of a level imported in parts, or one named piece of a model (the outline shows what goes). Ctrl+Z brings it back." },
  { id: "piece", group: "Level", name: "Cut piece", tip: "Click a floating island (or any separate piece of an imported level) to cut it out as an object you can move, turn and resize. Ctrl+Z puts it back." },
  { id: "pov", group: "Try", name: "Player view", tip: "Click to stand there and see what a player sees (in the Player view window)." },
  { id: "golfer", group: "Try", name: "Golfer", tip: "Click to drop a golfer (player-sized) anywhere, to judge the scale. Not saved into the map." },
  { id: "erase", group: "Erase", name: "Erase", tip: "Click a marker or golfer to remove it. With any tool, right-click a marker or placed object to erase it." },
];
const TERRAIN_TOOLS = [
  { id: "land", group: "Land", name: "Land", tip: "Drag to make land out of the sea (beaches appear by themselves). Right-drag to look around." },
  { id: "sea", group: "Land", name: "Sea", tip: "Drag to sink land into the sea. Right-drag to look around." },
  { id: "raise", group: "Land", name: "Raise", tip: "Drag to raise the ground. Right-drag to look around." },
  { id: "lower", group: "Land", name: "Lower", tip: "Drag to lower the ground (below the water level it becomes water). Right-drag to look around." },
  { id: "smooth", group: "Land", name: "Smooth", tip: "Drag to smooth bumps. Right-drag to look around." },
  { id: "flatten", group: "Land", name: "Flatten", tip: "Drag to flatten to the height where you start. Right-drag to look around." },
  { id: "paint", group: "Land", name: "Paint", tip: "Drag to paint the surface chosen in the Terrain tab. Right-drag to look around." },
];
const BRUSH_TOOLS = new Set(TERRAIN_TOOLS.map((t) => t.id));

function startEditing(firstTab = "model") {
  playerView.setActive(true);
  // Opening something is not a change: only overwrite the autosave once the user edits.
  savedSignature = projectSignature();
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
  // Brushes, path drawing and golf carts (click-drag to aim) use the left button themselves.
  controls.mouseButtons = BRUSH_TOOLS.has(id) || id === "path" || id === "golfCarts"
    ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  setLookButtons(BRUSH_TOOLS.has(id) || id === "path" || id === "golfCarts" ? [2] : [0, 2]);
  brushCursor.visible = false;
  partOutline.visible = false;
  if (!toolbar.hidden) renderToolbar();
}

function renderToolbar() {
  const all = project?.terrain ? [...PLACE_TOOLS.slice(0, 1), ...TERRAIN_TOOLS, ...PLACE_TOOLS.slice(1)] : PLACE_TOOLS;
  // Boxes and carts are placed from the Objects tab; the toolbar only shows the one being placed.
  const tools = all.filter((t) => !HOLE_OBJECTS.includes(t.id) || t.id === tool);
  toolbar.innerHTML =
    tools
      .map((t, i) => {
        const label = t.group && t.group !== tools[i - 1]?.group && t.group !== "Erase" ? `<span class="tool-group">${t.group}</span>` : "";
        return `${label}<button class="tool ${t.id === tool ? "active" : ""} ${BRUSH_TOOLS.has(t.id) ? "brush" : ""}" data-tool="${t.id}" title="${t.tip}">${t.name}</button>`;
      })
      .join("") +
    (tool === "path" ? `<button class="tool active" data-tool="look" title="Stop drawing the path (Esc)">Done drawing</button>` : "") +
    (tool === "area"
      ? `<button class="tool active" id="cut-area" ${project?.cutOutline?.length >= 3 ? "" : "disabled"} title="Cut everything inside the outline out as an object">Cut it out (${project?.cutOutline?.length ?? 0} corners)</button><button class="tool" id="cut-clear" title="Start the outline again">Clear outline</button>`
      : "");
  toolbar.querySelector("#cut-area")?.addEventListener("click", cutArea);
  toolbar.querySelector("#cut-clear")?.addEventListener("click", () => {
    project.cutOutline = [];
    project.rebuildMarkers();
    renderToolbar();
  });
  toolbar.querySelectorAll("button[data-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      setTool(b.dataset.tool);
      setStatus([...tools, { id: "look", tip: "" }].find((t) => t.id === tool)?.tip ?? "");
      if (tab === "objects") renderPanel(); // its place buttons show the tool too
    }),
  );
}

/** Cuts everything inside the Cut area outline out of the level as one object. */
function cutArea() {
  const piece = project.findArea(project.cutOutline);
  if (!piece) return setStatus("Nothing of the level is inside that outline", true);
  let obj;
  history.record(() => (obj = project.cutPiece(piece)), { meshes: [...piece.take.keys()] });
  obj.name = "Cut area";
  project.cutOutline = [];
  setTool("look");
  tab = "objects";
  selectObject(obj);
  setStatus(`Cut out ${piece.taken} triangles. Move, turn or resize them with the handles, Delete removes them; Ctrl+Z puts them back.`);
}

// Brush cursor.
// Remove part: outlines the part under the pointer.
const partOutline = new THREE.Box3Helper(new THREE.Box3(), 0xffd23f);
partOutline.visible = false;
scene.add(partOutline);
renderer.domElement.addEventListener("pointermove", (e) => {
  if (tool !== "part" || !project || e.buttons) {
    partOutline.visible = false;
    return;
  }
  const hit = pick(e, project.pickTargets);
  const part = hit && project.partAt(hit.object);
  partOutline.visible = !!part;
  if (part) partOutline.box.setFromObject(part);
});

const brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, transparent: true }));
brushCursor.rotation.x = -Math.PI / 2;
brushCursor.renderOrder = 10;
brushCursor.visible = false;
scene.add(brushCursor);

let stroke = null; // { before, last: event, target }
// Golf carts: press to put one down, drag to aim it (it faces where you let go); a plain click faces the Flag.
let cartDrag = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || tool !== "golfCarts" || !project) return;
  const hit = pick(e, project.pickTargets, (h) => project.isGround(h));
  if (!hit) return;
  const before = history.capture();
  const h = project.hole;
  (h.golfCarts ??= []).push(toMapPoint(hit.point));
  cartDrag = { before, index: h.golfCarts.length - 1, x: e.clientX, y: e.clientY };
  renderer.domElement.setPointerCapture(e.pointerId);
  project.rebuildMarkers();
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!cartDrag) return;
  if (Math.hypot(e.clientX - cartDrag.x, e.clientY - cartDrag.y) < 8) return;
  const hit = pick(e, project.pickTargets);
  const cart = project.hole.golfCarts[cartDrag.index];
  if (!hit || !cart) return;
  const p = toMapPoint(hit.point);
  cart.yaw = Math.round(((Math.atan2(p.x - cart.x, p.z - cart.z) * 180) / Math.PI + 360) % 360);
  project.rebuildMarkers();
});
renderer.domElement.addEventListener("pointerup", () => {
  if (!cartDrag) return;
  history.commit(cartDrag.before);
  cartDrag = null;
  renderPanel();
});
const toMapPoint = (v) => ({ x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(-v.z * 100) / 100 });

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
  downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
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
  project.shapeVersion++;
  project.rebuildMarkers();
});
onFrame((now) => {
  if (!stroke || !project?.terrain) return;
  // Real elapsed time, so brushes work at the same speed on slow and fast computers.
  const dt = Math.min(0.1, stroke.time ? (now - stroke.time) / 1000 : 1 / 60);
  stroke.time = now;
  const hit = pick(stroke.last, [project.terrain.mesh]);
  if (!hit) return;
  project.terrain.brush(tool, hit.point.x, -hit.point.z, { radius: brush.radius, strength: brush.strength, surface: brush.surface, target: stroke.target, dt });
});

// Pictures marked "face the camera" turn toward it (around the vertical axis), as they will in the game.
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
onFrame(() => {
  if (!project) return;
  for (const o of project.objects) {
    if (!o.userData.billboard || gizmo.object === o) {
      project.billboardBase.delete(o);
      continue;
    }
    if (!project.billboardBase.has(o)) project.billboardBase.set(o, o.quaternion.clone());
    o.getWorldPosition(tmpV);
    const yaw = Math.atan2(camera.position.x - tmpV.x, camera.position.z - tmpV.z);
    o.parent.getWorldQuaternion(tmpQ);
    o.quaternion.copy(tmpQ.invert().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)));
  }
});

// A click is a pointer press that did not move (so orbiting never places markers).
let downAt = null;
// Right-click (without dragging, which pans or looks around) erases the object or marker under the pointer.
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("pointerup", (e) => {
  // A quick right-click that did not move; a slower press or a drag is looking around.
  if (!project || !downAt || e.button !== 2 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || performance.now() - downAt.t > 400) return;
  // Markers (boxes, carts, the Start...) first: they stand on top of whatever is under them.
  let erased = false;
  history.record(() => (erased = project.erase(null, pointerRay(e))));
  if (erased) {
    setStatus("Erased (Ctrl+Z brings it back)");
    return renderPanel();
  }
  const hit = pick(e, project.pickTargets);
  const owner = hit && project.objects.find((o) => isInside(o, hit.object));
  if (!owner) return setStatus("Nothing to erase there");
  if (project.isLevelPart(owner)) return setStatus("That is part of the level: select it and press Delete to remove it");
  if (owner === selectedObject) selectObject(null);
  history.record(() => project.removeObject(owner));
  project.rebuildMarkers();
  setStatus(`Erased ${owner.name || "object"} (Ctrl+Z brings it back)`);
  renderPanel();
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!project || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || e.button !== 0) return;
  if (BRUSH_TOOLS.has(tool) || tool === "golfCarts") return;
  const hit = pick(e, project.pickTargets, (h) => tool === "look" || project.isGround(h));
  if (!hit) return;
  if (tool === "look") {
    const owner = project.objects.find((o) => isInside(o, hit.object));
    if (owner) selectObject(owner);
    else if (!hit.object.userData.isTerrain) selectMaterial(hitMaterial(hit), e.shiftKey);
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
  } else if (tool === "area") {
    (project.cutOutline ??= []).push({ x: hit.point.x, y: hit.point.y, z: -hit.point.z });
    project.rebuildMarkers();
    renderToolbar();
  } else if (tool === "part") {
    const part = project.partAt(hit.object);
    if (!part) return setStatus("Nothing to remove there: that is the whole level, or an object (right-click or Delete removes objects)", true);
    history.record(() => project.removePart(part), { parts: [{ node: part, parent: part.parent }] });
    partOutline.visible = false;
    setStatus(`Removed ${part.name || "part"} (Ctrl+Z brings it back)`);
    renderPanel();
  } else if (tool === "piece") {
    const piece = project.findPiece(hit);
    if (!piece) return setStatus("That is not a separate piece: it is joined to most of the level (or is an object already)", true);
    let obj;
    history.record(() => (obj = project.cutPiece(piece)), { meshes: [...piece.take.keys()] });
    setTool("look");
    tab = "objects";
    selectObject(obj);
    setStatus(`Cut out a piece (${piece.taken} triangles). Move, turn or resize it with the handles; Ctrl+Z puts it back.`);
  } else if (tool === "erase") {
    history.record(() => {
      if (!project.erase(hit.point, pointerRay(e))) setStatus("No marker there");
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

/** Selects a material; with `add` (Shift held) it is added to the selection, or taken out if it was in it. */
function selectMaterial(material, add = false) {
  if (!add) selectedMaterials.clear();
  if (material && add && selectedMaterials.has(material)) {
    selectedMaterials.delete(material);
    material = [...selectedMaterials].pop() ?? null;
  } else if (material) selectedMaterials.add(material);
  selectedMaterial = material;
  for (const { material: m } of project?.materials ?? []) m.emissive?.setHex(selectedMaterials.has(m) ? 0x665500 : 0x000000);
  tab = "model";
  renderPanel();
  info.querySelector(".material.selected")?.scrollIntoView({ block: "nearest" });
}

// ---------- Side panel ----------

function renderPanel() {
  if (!project) return;
  updateSkyPreview();
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
    <div class="field"><label for="brush-strength">Strength: ${brush.strength}</label><input id="brush-strength" type="range" min="2" max="40" value="${brush.strength}" /></div>
    <p class="hint">The lines on the ground mark every 2 m of height (stronger every 10 m).</p>
    <h3>Shape</h3>
    <div class="row">
      <select id="shape-kind" class="pill-select small-select">${[["island", "Island"], ["twin", "Twin islands"], ["archipelago", "Archipelago"], ["long", "Long island"], ["sea", "Open sea"]]
        .map(([id, name]) => `<option value="${id}" ${id === (project.levelShape ?? "island") ? "selected" : ""}>${name}</option>`)
        .join("")}</select>
      <button class="btn btn-secondary small" id="reshape">New shape</button>
    </div>
    <p class="hint">Rolls a new coastline and hills (paint and sculpting are replaced; Ctrl+Z brings them back).</p>
    <h3>Paint</h3>
    <div class="swatches">${PAINTABLE.map((id) => `<button class="swatch ${brush.surface === id ? "active" : ""}" data-surface="${id}"><i style="background:rgb(${SURFACES[id].color})"></i>${SURFACES[id].name}</button>`).join("")}</div>
    <p class="hint">Painted terrain uses the game's own ground textures and grass. Anything lowered below the water level (${project.hole.water} m) becomes water.</p>
    <div class="stats">${stat("Level size", `${sx} x ${sz} m`)}</div>`;
}

function wireTerrain() {
  info.querySelector("#reshape").addEventListener("click", () => {
    const shape = info.querySelector("#shape-kind").value;
    history.record(() => {
      const fresh = Terrain.generate(shape, project.terrain.sizeX, project.terrain.sizeZ, newSeed());
      project.terrain.restore({ heights: fresh.heights, paint: fresh.paint });
      fresh.dispose();
      project.levelShape = shape;
      // Markers follow the new ground.
      for (const h of project.holes) for (const [set, p] of project.markerPoints(h)) if (p) set({ ...p, y: project.terrain.heightAt(p.x, p.z) });
    }, { terrain: true });
    project.rebuildMarkers();
    renderPanel();
  });
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
const MATERIALS_LISTED = 60;
let showAllMaterials = false;
function modelPanel() {
  const [sx, sz] = project.size;
  // Levels can have a thousand materials: list the first ones (and any picked) until the mapper asks for all.
  const shortList = !showAllMaterials && project.materials.length > MATERIALS_LISTED;
  const surfaceRows = project.materials
    .map(({ material }, i) =>
      (material.userData.invisible && material.userData.renderOnly) || (shortList && i >= MATERIALS_LISTED && !selectedMaterials.has(material))
        ? ""
        : `<div class="material ${selectedMaterials.has(material) ? "selected" : ""}" data-i="${i}">
          <span class="thumb" style="${materialThumb(material)}"></span>
          <span class="mat-name" title="${esc(material.name)}">${esc(material.name || `Material ${i + 1}`)}</span>
          ${material.userData.renderOnly
            ? `<span class="hint" title="Only drawn: nothing collides with it">Looks only</span><span></span>`
            : `<select data-i="${i}" class="surface">${surfaceOptions(material.userData.surface)}</select>
          <label class="climb" title="Players can walk up it however steep it is (only walls stop them)"><input type="checkbox" data-i="${i}" ${material.userData.climbable ? "checked" : ""} /> Climb</label>`}
        </div>${material === selectedMaterial ? lookSettings(material, i) : ""}`,
    )
    .join("");
  return `
    ${project.terrain ? "" : `
    <h3>Size</h3>
    ${scaleSlider()}
    <div class="stats">${stat("Course area", `${sx} x ${sz} m`)}</div>
    ${Array.isArray(project.root.userData.worldOrigin) ? `<label class="btn btn-secondary small" tabindex="0" title="Another section of the same game world, placed where it really is">Add a section<input id="add-section" type="file" accept=".glb,.gltf,.zip" hidden /></label>
    <p class="hint">Sections of the same world line up by themselves. Holes can then be anywhere: each one takes the piece of the level around it.</p>` : ""}`}
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
    <p class="hint">${project.terrain ? "Surfaces of your objects and props (the terrain is painted in the Terrain tab)." : "Pick what each material plays as. Tip: click the level with Look to find a material."} Click a material for how its texture's transparency is drawn; Shift+click to pick several and change them together.${
      project.hasCollisionMesh ? " This level has a separate collision mesh: tick Show surfaces to see it." : ""
    }</p>
    <div class="materials">${surfaceRows || `<p class="hint">Nothing here yet.</p>`}</div>
    ${shortList ? `<button class="btn btn-secondary small" id="all-materials">Show all ${project.materials.length} materials</button>` : ""}`;
}

const ALPHA_MODES = [
  ["opaque", "Solid", "Ignores the texture's transparency"],
  ["cutout", "Cut out", "Leaves, fences, grass: see-through parts are cut away"],
  ["blend", "See-through", "Glass, water, smoke: blends with what is behind"],
  ["add", "Glow", "Light shafts, sparkles: adds light, dark parts vanish"],
];

/** Drawing settings of the selected material: transparency, its strength, and whether both sides show. */
function lookSettings(material, i) {
  const { alphaMode = "opaque", alphaCutoff = 0.5, opacity = 1, doubleSided = true } = material.userData;
  const slider = (cls, label, value, min, tip) =>
    `<label class="look-slider" title="${tip}">${label}<input type="range" class="${cls}" data-i="${i}" min="${min}" max="100" step="5" value="${Math.round(value * 100)}" /><span class="hint">${Math.round(value * 100)}%</span></label>`;
  const many = selectedMaterials.size > 1 ? `<p class="hint"><b>${selectedMaterials.size} materials selected</b>: changes here and in their rows apply to all of them. Shift+click to add or remove one.</p>` : "";
  return `<div class="mat-look">${many}
    <div class="choice-group alpha-modes">${ALPHA_MODES.map(([id, name, tip]) => `<button class="choice ${id === alphaMode ? "active" : ""}" data-mode="${id}" data-i="${i}" title="${tip}">${name}</button>`).join("")}</div>
    ${alphaMode === "cutout" ? slider("alpha-cutoff", "Cut below", alphaCutoff, 5, "Parts more see-through than this are cut away. Raise it if edges look fuzzy, lower it if thin parts vanish.") : ""}
    ${alphaMode === "blend" ? slider("alpha-opacity", "Opacity", opacity, 0, "How solid it looks overall (0% is fully invisible)") : ""}
<div class="row">
    <label class="check" title="Show the back of each face too (needed for leaves and flat cut-outs)"><input type="checkbox" class="two-sided" data-i="${i}" ${doubleSided ? "checked" : ""} /> Two-sided</label>
    ${material.userData.invisible ? "" : `<label class="check" title="Players and balls pass through it (plants, flowers, grass tufts, light shafts)"><input type="checkbox" class="walk-through" data-i="${i}" ${material.userData.renderOnly ? "checked" : ""} /> Walk through</label>`}</div>
  </div>`;
}

function surfaceOptions(selected) {
  const groups = [...new Set(MODEL_SURFACES.map((s) => s.group))];
  return groups
    .map((g) => `<optgroup label="${g}">${MODEL_SURFACES.filter((s) => s.group === g)
      .map((s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${s.name}</option>`)
      .join("")}</optgroup>`)
    .join("");
}

/** The material a control belongs to, plus the rest of the selection if it is one of the selected. */
function together(el) {
  const { material } = project.materials[Number(el.dataset.i)];
  return selectedMaterials.has(material) ? [...selectedMaterials] : [material];
}

/** Scale slider: logarithmic (game levels can need 0.03 or 5.5), from a hundredth to a hundred times, plus a box to type in. */
function scaleSlider() {
  const scale = project.realScale;
  const at = Math.log10(scale);
  return `<div class="field slider-field"><label for="scale-range">Scale</label>
    <div class="slider-row">
      <input type="range" id="scale-range" min="${Math.min(-2, at)}" max="${Math.max(2, at)}" step="0.005" value="${at}" />
      <input type="text" inputmode="decimal" class="slider-num" id="scale" value="${+scale.toPrecision(3)}" aria-label="Scale" />
    </div></div>`;
}

function wireModel() {
  info.querySelector("#all-materials")?.addEventListener("click", () => {
    showAllMaterials = true;
    renderPanel();
  });
  const setScale = (v) => {
    project.realScale = Math.max(0.0001, v);
    project.applyTransform();
  };
  const scaleBox = info.querySelector("#scale");
  info.querySelector("#scale-range")?.addEventListener("input", (e) => {
    const v = niceScale(Math.pow(10, Number(e.target.value)));
    scaleBox.value = v;
    setScale(v);
  });
  info.querySelector("#scale-range")?.addEventListener("change", () => {
    frameBox(project.box);
    renderPanel();
  });
  scaleBox?.addEventListener("change", (e) => {
    const v = readNumber(e.target.value);
    if (v === null || v <= 0) {
      e.target.value = +project.realScale.toPrecision(3);
      return;
    }
    setScale(v);
    frameBox(project.box);
    renderPanel();
  });
  info.querySelector("#add-section")?.addEventListener("change", (e) =>
    e.target.files.length &&
    run("Adding section", async () => {
      const { root } = await importModel(await unpackZips([...e.target.files]));
      project.addSection(root);
      history.version++;
      frameBox(project.box);
      renderPanel();
      setStatus(`Added ${root.name}`);
    }),
  );
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
    s.addEventListener("change", () => {
      for (const m of together(s)) project.setSurface(m, s.value);
      if (selectedMaterials.size > 1) renderPanel();
    }),
  );
  info.querySelectorAll(".climb input").forEach((c) =>
    c.addEventListener("change", () => {
      for (const material of together(c)) {
        if (c.checked) material.userData.climbable = true;
        else delete material.userData.climbable;
      }
      if (selectedMaterials.size > 1) renderPanel();
    }),
  );
  const look = (el, changes) => {
    for (const m of together(el)) project.setLook(m, changes);
    history.version++;
  };
  info.querySelectorAll(".alpha-modes .choice").forEach((b) =>
    b.addEventListener("click", () => {
      look(b, { alphaMode: b.dataset.mode });
      renderPanel();
    }),
  );
  for (const [cls, key] of [["alpha-cutoff", "alphaCutoff"], ["alpha-opacity", "opacity"]])
    info.querySelectorAll(`.${cls}`).forEach((r) =>
      r.addEventListener("input", () => {
        look(r, { [key]: Number(r.value) / 100 });
        r.nextElementSibling.textContent = `${r.value}%`;
      }),
    );
  info.querySelectorAll(".two-sided").forEach((c) => c.addEventListener("change", () => look(c, { doubleSided: c.checked })));
  info.querySelectorAll(".walk-through").forEach((c) =>
    c.addEventListener("change", () => {
      for (const material of together(c)) {
        if (c.checked) material.userData.renderOnly = true;
        else delete material.userData.renderOnly;
      }
      history.version++;
      renderPanel();
    }),
  );
  info.querySelectorAll(".material").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (!["SELECT", "INPUT", "LABEL"].includes(e.target.tagName)) selectMaterial(project.materials[Number(row.dataset.i)].material, e.shiftKey);
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
  ["jumppad", "Jump pad (launches players and balls)"],
  ["outofbounds", "Out of bounds zone (balls in it go back)"],
];
const DEFAULTS = {
  mover: { speed: 4, loop: true, count: 1 },
  roller: { speed: 8, interval: 3 },
};

/** The object's size in metres per local unit (paths and speeds are stored in local units). */
const unitScale = (o) => o.getWorldScale(new THREE.Vector3()).x || 1;

/** Things placed per hole with a toolbar tool (Objects group): shown on top of the Objects tab too. */
const HOLE_OBJECTS = ["itemBoxes", "redItemBoxes", "golfCarts"];

function objectsPanel() {
  const objects = project.objects;
  const sel = selectedObject;
  const h = project.hole;
  return `
    <h3>On this hole</h3>
    <div class="palette">
      ${HOLE_OBJECTS.map((id) => {
        const t = PLACE_TOOLS.find((x) => x.id === id);
        return `<button class="btn ${tool === id ? "btn-primary" : "btn-secondary"} small place-tool" data-tool="${id}" title="${t.tip}">${t.name}</button>`;
      }).join("")}
    </div>
    <div class="stats">
      ${stat("Item boxes", `${h.itemBoxes.length + (h.redItemBoxes?.length ?? 0)} / ${MAX_PER_HOLE}${h.redItemBoxes?.length ? ` (${h.redItemBoxes.length} red)` : ""}`)}
      ${stat("Golf carts", `${h.golfCarts?.length ?? 0} / 16`)}
    </div>
    <p class="hint">Pick one, then click the level to place it. Right-click one to erase it.</p>
    <h3>Items in the boxes</h3>
    ${itemChoice("items", h.items, "Normal boxes", "Normal boxes give the game's usual items: better ones the further a player is behind the leader.")}
    ${itemChoice("redItems", h.redItems, "Red boxes", "Red boxes give spring boots or the fire club, like in the game.")}
    <h3>Add to the level</h3>
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

/**
 * Even size of an object: its largest side in metres, on a slider (a tenth to ten times the size it has now) and in a
 * box to type into. Keeps the object's proportions.
 */
function sizeSlider(o) {
  const now = +project.objectSize(o).toPrecision(3);
  const at = Math.log10(now);
  return `<div class="field slider-field"><label for="obj-size-range">Size (largest side)</label>
    <div class="slider-row">
      <input type="range" id="obj-size-range" min="${at - 1}" max="${at + 1}" step="0.005" value="${at}" />
      <input type="text" inputmode="decimal" class="slider-num" id="obj-size" value="${now}" aria-label="Size in metres" />
      <span class="slider-unit">m</span>
    </div></div>`;
}

/** Copies the selected object next to itself and selects the copy. */
function duplicateSelected() {
  if (!project || !selectedObject) return;
  let copy;
  history.record(() => (copy = project.duplicateObject(selectedObject)));
  selectObject(copy);
  setStatus(`Duplicated ${copy.name || "object"} (Ctrl+Z takes it away)`);
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
      ${sizeSlider(o)}
      ${o.userData.billboard ? "" : slider("obj-yaw", "Turn (degrees, 0 = map north)", project.objectYaw(o), { min: 0, max: 359.9, step: 0.5, unit: "&deg;" })}
      <div class="row">
        ${["translate", "rotate", "scale"].map((m) => `<button class="btn btn-secondary small gizmo-mode ${gizmo.mode === m ? "active-mode" : ""}" data-mode="${m}">${{ translate: "Move", rotate: "Rotate", scale: "Stretch" }[m]}</button>`).join("")}
        <button class="btn btn-secondary small" id="obj-duplicate" title="Copy it, with the same settings (Ctrl+D)">Duplicate</button>
      </div>
      <div class="field"><label for="obj-kind">Behaviour</label><select id="obj-kind">${BEHAVIOURS.map(([id, name]) => `<option value="${id}" ${id === kind ? "selected" : ""}>${name}</option>`).join("")}</select></div>
      ${pathed ? `
        ${slider("obj-speed", "Speed", round2((d.speed ?? DEFAULTS[kind].speed / s) * s), { min: 0.5, max: 60, step: 0.5, unit: "m/s" })}
        ${kind === "mover" ? `
          ${slider("obj-count", "Copies on the path", d.count ?? 1, { min: 1, max: 16 })}
          <label class="check"><input type="checkbox" id="obj-loop" ${d.loop ?? true ? "checked" : ""} /> Go round the path (otherwise back and forth)</label>
          <label class="check"><input type="checkbox" id="obj-knocks" ${d.knocks ? "checked" : ""} /> Knocks players over</label>` : `
          ${slider("obj-interval", "Seconds between copies", d.interval ?? DEFAULTS.roller.interval, { min: 0.5, max: 30, step: 0.5, unit: "s" })}
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
      ${kind === "outofbounds" ? `<p class="hint">A ball that lands inside this zone, or keeps falling through it, goes back to its player with a penalty stroke, like any out of bounds shot. Use it over holes and pits balls should not drop into. Players walk through it; it is invisible in the game. Size it with Stretch (each side on its own) or the Size slider.</p>` : ""}
      ${kind === "seesaw" ? `<p class="hint">Tilts toward players standing on it. Its long side should run front to back.</p>` : ""}
      ${kind === "jumppad" ? `
        ${slider("obj-jump-speed", "Launch speed (players)", d.launchSpeed ?? 103, { min: 5, max: 200, step: 1, unit: "m/s" })}
        ${slider("obj-jump-pitch", "Angle up", d.launchPitch ?? 35, { min: 0, max: 90, step: 1, unit: "&deg;" })}
        <p class="hint">Launches players and balls that touch its top, the way its arrow points (turn it with Rotate). 90 degrees is straight up. The game's own pads use 103 m/s at 35 degrees; balls, diving and knocked-out players get the game's weaker launches. The orange arc shows where a player lands.</p>` : ""}
      <label class="check"><input type="checkbox" id="obj-billboard" ${d.billboard ? "checked" : ""} /> Always face the camera (for pictures)</label>
    </div>`;
}

async function addObject(make, label) {
  const hit = pickCenter(project.pickTargets);
  const where = hit ? hit.point : project.box.getCenter(new THREE.Vector3());
  let obj;
  history.record(() => {
    obj = project.addObject(make.root, where, { size: make.size, billboard: make.billboard, data: make.data });
  });
  selectObject(obj);
  setStatus(`Added ${label}`);
}

/** Item choices of the hole's boxes (Objects tab). */
function wireItemChoices() {
  info.querySelectorAll(".items-own").forEach((c) =>
    c.addEventListener("change", () => {
      const key = c.dataset.key;
      history.record(() => {
        if (c.checked) project.hole[key] = Object.fromEntries(ITEMS.map((it) => [it.id, key === "redItems" ? it.red : it.close]).filter(([, w]) => w > 0));
        else delete project.hole[key];
      });
      renderPanel();
    }),
  );
  info.querySelectorAll(".item-weight input").forEach((input) =>
    input.addEventListener("change", () => {
      const v = Math.max(0, Math.min(100, Number(input.value) || 0));
      history.record(() => {
        const weights = project.hole[input.dataset.key];
        if (v > 0) weights[input.dataset.item] = v;
        else delete weights[input.dataset.item];
      });
      renderPanel();
    }),
  );
}

function wireObjects() {
  wireItemChoices();
  info.querySelectorAll(".place-tool").forEach((b) =>
    b.addEventListener("click", () => {
      setTool(tool === b.dataset.tool ? "look" : b.dataset.tool);
      setStatus(PLACE_TOOLS.find((t) => t.id === tool)?.tip ?? "");
      renderPanel();
    }),
  );
  const objects = project.objects;
  info.querySelectorAll(".add-shape").forEach((b) => b.addEventListener("click", () => addObject({ root: SHAPES[b.dataset.shape].make(), data: SHAPES[b.dataset.shape].data }, SHAPES[b.dataset.shape].name)));
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
      const { root, missing } = await importModel(await unpackZips([...e.target.files]));
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
  info.querySelector("#obj-duplicate").addEventListener("click", duplicateSelected);
  // Size: follows the slider while dragging, one undo step per drag.
  const sizeBox = info.querySelector("#obj-size");
  let sizeBefore = null;
  info.querySelector("#obj-size-range").addEventListener("input", (e) => {
    sizeBefore ??= history.capture();
    const v = +Math.pow(10, Number(e.target.value)).toPrecision(3);
    sizeBox.value = v;
    project.setObjectSize(o, v);
  });
  info.querySelector("#obj-size-range").addEventListener("change", () => {
    history.commit(sizeBefore ?? history.capture());
    sizeBefore = null;
    renderPanel();
  });
  // Turn: follows the slider while dragging, one undo step per drag (the box sends a change too).
  let yawBefore = null;
  info.querySelector("#obj-yaw")?.addEventListener("input", (e) => {
    yawBefore ??= history.capture();
    project.setObjectYaw(o, Number(e.target.value));
  });
  info.querySelector("#obj-yaw")?.addEventListener("change", (e) => {
    yawBefore ??= history.capture();
    project.setObjectYaw(o, Number(e.target.value));
    history.commit(yawBefore);
    yawBefore = null;
    renderPanel();
  });
  sizeBox.addEventListener("change", (e) => {
    const v = readNumber(e.target.value);
    if (v === null || v <= 0) return renderPanel();
    edit(() => project.setObjectSize(o, v));
  });
  info.querySelector("#obj-jump-speed")?.addEventListener("change", (e) => edit(() => (d.launchSpeed = Math.min(200, Math.max(5, Number(e.target.value) || 103)))));
  info.querySelector("#obj-jump-pitch")?.addEventListener("change", (e) => edit(() => (d.launchPitch = Math.min(90, Math.max(0, Number(e.target.value) || 0)))));
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
      if (d.object === "jumppad") {
        d.launchSpeed ??= 103;
        d.launchPitch ??= 35;
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
    <div class="field"><label for="hole-name">Hole name</label><input id="hole-name" value="${esc(h.name)}" /></div>
    <p class="hint">Shown in the game's hole list. The map's own name (and file name) is set in the Export tab.</p>
    ${warningList()}
    ${slider("par", "Par", h.par, { min: 1, max: 9 })}
    <div class="field"><label for="difficulty">Difficulty</label><select id="difficulty">${["none", "beginner", "intermediate", "expert"]
      .map((d) => `<option ${d === h.difficulty ? "selected" : ""}>${d}</option>`)
      .join("")}</select></div>
    ${h.tee ? `
    ${slider("tee-y", "Start height", round2(h.tee.y), { min: Math.floor(levelLow()), max: Math.ceil(levelHigh() + 10), step: 0.05, unit: "m" })}
    <label class="check"><input type="checkbox" id="tee-face" ${h.tee.yaw == null ? "checked" : ""} /> Players start facing the flag</label>
    ${h.tee.yaw == null ? "" : slider("tee-yaw", "Start direction (degrees, 0 = map north)", Math.round(h.tee.yaw), { min: 0, max: 359, step: 1, unit: "&deg;" })}` : ""}
    ${slider("water", "Water level", h.water, { min: Math.floor(levelLow() - 5), max: Math.ceil(levelHigh()), step: 0.1, unit: "m", note: waterNote(h, h.water) })}
    ${project.terrain ? "" : `<p class="hint">The level's lowest point is at ${BASE_Y} m.</p>`}
    ${slider("green", "Green radius around the flag", h.greenRadius, { min: 3, max: 40, step: 0.5, unit: "m" })}
    <div class="stats">
      ${stat("Start to flag", length)}
      ${stat("Start (tee)", h.tee ? "placed" : "missing")}
      ${stat("Flag (cup)", h.cup ? "placed" : "missing")}
      ${stat(MARKERS.checkpoints.name + "s", `${h.checkpoints.length} / ${MAX_PER_HOLE}`)}
    </div>
    <h3>Sky</h3>
    ${skyChoice(h)}
    <h3>Play area</h3>
    <p class="hint">Balls that leave it are out of bounds, so shots can't fly off to other parts of the map. ${
      h.bounds?.length >= 3 ? `${h.bounds.length} corners.` : h.bounds?.length ? `${h.bounds.length} corner${h.bounds.length === 1 ? "" : "s"}: needs at least 3.` : "None yet: the whole map counts."
    } Click corners with <b>Play area</b> in the toolbar, or fit one around the start and flag.</p>
    <div class="row">
      <button class="btn btn-secondary small" id="fit-bounds" ${h.tee && h.cup ? "" : "disabled"}>Fit around start and flag</button>
      <button class="btn btn-secondary small" id="clear-bounds" ${h.bounds?.length ? "" : "disabled"}>Clear</button>
    </div>
    <p class="hint">Use the toolbar over the 3D view to place things. <b>Start</b> is where players tee off, <b>Flag</b> is the hole they aim for. ${
      project.terrain ? "Paint a green around the flag in the Terrain tab." : "Ground within the green radius of the flag plays as a putting green."
    }</p>`;
}

/** The hole's sky: the beach default, the sky of any vanilla hole, or a panorama picture. */
function skyChoice(h) {
  const worlds = [...new Set(SKIES.map((s) => s.world))];
  return `<div class="field"><label for="sky">Sky in the game</label><select id="sky">
      <option value="">Default (the beach)</option>
      ${worlds.map((w) => `<optgroup label="${w}">${SKIES.filter((s) => s.world === w).map((s) => `<option value="${esc(s.id)}" ${s.id === h.sky ? "selected" : ""}>${esc(s.id)}</option>`).join("")}</optgroup>`).join("")}
    </select></div>
    <div class="row">
      <label class="btn btn-secondary small" tabindex="0" title="A panorama picture (equirectangular, twice as wide as high), like a 360 photo">${h.skyImage ? "Other picture" : "Use my own picture"}<input id="sky-file" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" hidden /></label>
      ${h.skyImage ? `<button class="btn btn-secondary small" id="sky-clear">Remove picture</button>` : ""}
    </div>
    <p class="hint">${h.skyImage ? `Picture: <b>${esc(h.skyImage.replace(/^sky\//, ""))}</b>, shown all around the hole instead of the sky.` : "The game's skies are named after the hole they come from. Your own picture should be a 360 panorama (twice as wide as high)."} Needs mod 0.4.0.</p>`;
}

/** Shows the active hole's sky behind the level: its picture, or its sky colours. */
const skyTextures = new Map();
function updateSkyPreview() {
  const h = project?.hole;
  const viewportEl = renderer.domElement.parentElement;
  scene.background = null;
  viewportEl.style.background = "";
  if (!h) return;
  if (h.skyImage && project.skyImages.has(h.skyImage)) {
    let tex = skyTextures.get(h.skyImage);
    if (!tex) {
      const url = URL.createObjectURL(new Blob([project.skyImages.get(h.skyImage)]));
      tex = new THREE.TextureLoader().load(url, () => URL.revokeObjectURL(url));
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      skyTextures.set(h.skyImage, tex);
    }
    scene.background = tex;
  } else if (h.sky) {
    const sky = SKIES.find((s) => s.id === h.sky);
    if (sky) viewportEl.style.background = `linear-gradient(180deg, ${sky.sky}, ${sky.horizon})`;
  }
}

/** Choose-the-items section for one kind of box: the game's own choice, or a weight per item (chance = weight / total). */
function itemChoice(key, weights, label, usual) {
  const total = weights ? Object.values(weights).reduce((a, b) => a + (b > 0 ? b : 0), 0) : 0;
  return `<label class="check"><input type="checkbox" class="items-own" data-key="${key}" ${weights ? "checked" : ""} /> ${label}: choose the items</label>
    ${weights
      ? `<div class="item-weights">${ITEMS.map((it) => {
          const w = weights[it.id] ?? 0;
          return `<label class="item-weight ${w > 0 ? "on" : ""}"><span>${it.name}</span><input type="range" min="0" max="100" step="5" data-key="${key}" data-item="${it.id}" value="${w}" aria-label="${it.name}" /><small>${total > 0 && w > 0 ? Math.round((w / total) * 100) + "%" : ""}</small></label>`;
        }).join("")}</div>
        <p class="hint">Each slider is how often that item comes up compared to the others (all the way left = never). ${total > 0 ? "" : "<b class=\"bad\">Pick at least one item.</b>"}</p>`
      : `<p class="hint">${usual}</p>`}`;
}

/** Lowest and highest point of the level (map metres). */
const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const levelLow = () => finiteOr(project.terrain ? project.terrain.yMin : project.box.min.y, 0);
const levelHigh = () => finiteOr(project.terrain ? project.terrain.yMax : project.box.max.y, 100);

/** How the water sits against the Start and Flag, for the water slider. */
function waterNote(h, water) {
  const say = (name, p) => {
    if (!p) return null;
    const d = round2(p.y - water);
    return d < 0 ? `<b class="bad">${name} is ${-d} m under water</b>` : `${name} ${d} m above`;
  };
  const parts = [say("Start", h.tee), say("Flag", h.cup)].filter(Boolean);
  return parts.length ? parts.join(", ") : "Place the Start and Flag to compare.";
}

function wireHoles() {
  const h = project.hole;
  const bind = (id, fn) =>
    info.querySelector(id)?.addEventListener("change", (e) => {
      history.record(() => fn(e.target.value));
      project.rebuildMarkers();
      fillHoleSelect(project.holes, project.activeHole);
      renderPanel();
    });
  bind("#hole-name", (v) => (project.hole.name = v));
  bind("#par", (v) => (project.hole.par = Math.max(1, Number(v) || 4)));
  bind("#difficulty", (v) => (project.hole.difficulty = v));
  bind("#water", (v) => (project.hole.water = Number(v) || 0));
  // While dragging: move the water in the view and say where it sits against the Start and Flag.
  info.querySelector("#water").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    const water = project.markersGroup.children.find((o) => o.userData.isWater);
    if (water) water.position.y = v;
    const note = info.querySelector("#water-note");
    if (note) note.innerHTML = waterNote(project.hole, v);
  });
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
  info.querySelector("#sky").addEventListener("change", (e) => {
    history.record(() => {
      if (e.target.value) project.hole.sky = e.target.value;
      else delete project.hole.sky;
    });
    updateSkyPreview();
  });
  info.querySelector("#sky-file").addEventListener("change", (e) =>
    e.target.files[0] &&
    run("Adding sky picture", async () => {
      const name = project.addSkyImage(e.target.files[0].name, new Uint8Array(await e.target.files[0].arrayBuffer()));
      history.record(() => (project.hole.skyImage = name));
      updateSkyPreview();
      renderPanel();
    }),
  );
  info.querySelector("#sky-clear")?.addEventListener("click", () => {
    history.record(() => delete project.hole.skyImage);
    updateSkyPreview();
    renderPanel();
  });
  info.querySelector("#fit-bounds").addEventListener("click", () => {
    history.record(() => project.fitPlayArea());
    renderPanel();
  });
  info.querySelector("#clear-bounds").addEventListener("click", () => {
    history.record(() => delete project.hole.bounds);
    project.rebuildMarkers();
    renderPanel();
  });
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

/** The "only the level around each hole" choice (forced on for levels bigger than one hole area). */
function trimChoice() {
  if (project.terrain || !project.hasModel) return "";
  const [sx, sz] = project.size;
  const big = sx > MAX_SIZE || sz > MAX_SIZE;
  return `<label class="check"><input type="checkbox" id="trim" ${project.trims ? "checked" : ""} ${big ? "disabled" : ""} /> Only keep the level around each hole</label>
    <p class="hint">${big
      ? `The level is ${sx} x ${sz} m, bigger than one hole area (${MAX_SIZE} m), so each hole gets the piece of the level around its Start, Flag and play area.`
      : "Each hole then gets just the piece of the level around its Start, Flag and play area: a smaller download and faster loading."} The editor keeps the whole level.</p>`;
}

/** Warnings (things that look wrong in game but still work), as a list, or nothing. */
function warningList() {
  const warnings = project.warnings();
  return warnings.length ? `<ul class="warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
}

// Export
function exportPanel() {
  const problems = project.problems();
  return `
    <div class="field"><label for="map-name">Map name</label><input id="map-name" value="${esc(project.info.name)}" /></div>
    <p class="hint">The name of the whole map: the file is named after it. Each hole has its own name in the Holes tab, which is what the game's hole list shows.</p>
    <div class="field"><label for="author">Author</label><input id="author" value="${esc(project.info.author)}" /></div>
    <div class="field"><label for="credits">Credits</label><textarea id="credits" rows="3" placeholder="e.g. Model by ...">${esc(project.info.credits)}</textarea></div>
    ${musicSection()}
    ${trimChoice()}
    ${problems.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p class="ok">Ready to play!</p>`}
    ${warningList()}
    <button class="btn btn-primary" id="export" ${problems.length ? "disabled" : ""}>Download .sbgmap</button>
    <p class="hint">Put the file in <b>Super Battle Golf/SbgMaps/maps/</b>. Your holes show up under <b>Custom Maps</b> (from mod 0.4.0 without restarting the game).</p>`;
}

function wireExport() {
  const bind = (id, key) => info.querySelector(id).addEventListener("input", (e) => (project.info[key] = e.target.value));
  bind("#map-name", "name");
  bind("#author", "author");
  bind("#credits", "credits");
  wireMusic();
  info.querySelector("#trim")?.addEventListener("change", (e) => {
    project.trimToHoles = e.target.checked;
    renderPanel();
  });
  info.querySelector("#export").addEventListener("click", () =>
    run("Exporting", async () => {
      const bytes = await project.exportSbgmap({ previews: true, forGame: true });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      a.download = `${(project.info.name || "map").replace(/[^\w.-]+/g, "_")}.sbgmap`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`Saved ${a.download} (${Math.round(bytes.length / 1024)} KB)`);
    }),
  );
}

// Music
let songPreview = null; // { name, audio, url }

function musicSection() {
  const songs = [...project.songs.keys()];
  const label = (name) => esc(name.replace(/^music\//, ""));
  const options = (selected, first) =>
    `<option value="">${first}</option>${songs.map((n) => `<option value="${esc(n)}" ${n === selected ? "selected" : ""}>${label(n)}</option>`).join("")}`;
  const rows = songs
    .map((n) => {
      const kb = Math.round(project.songs.get(n).length / 1024);
      const playing = songPreview?.name === n;
      return `<div class="song"><span class="mat-name" title="${label(n)}">${label(n)}</span><span class="hint">${kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}</span>
        <button class="btn btn-secondary small song-play" data-name="${esc(n)}">${playing ? "Stop" : "Play"}</button>
        <button class="btn btn-secondary small song-remove" data-name="${esc(n)}" title="Remove this song">Remove</button>
        <label class="song-volume" title="How loud this song plays in the game (the game's music volume setting still applies on top)">Volume
          <input type="range" class="song-vol" data-name="${esc(n)}" min="0" max="100" step="5" value="${Math.round((project.songVolumes.get(n) ?? 1) * 100)}" />
          <span class="hint">${Math.round((project.songVolumes.get(n) ?? 1) * 100)}%</span></label></div>`;
    })
    .join("");
  return `
    <h3>Music</h3>
    <p class="hint">Plays instead of the game's music while people play your map, and goes along with it to everyone. mp3, ogg, wav or flac.</p>
    <div class="songs">${rows}</div>
    <label class="btn btn-secondary small" tabindex="0">Add song<input id="song-file" type="file" accept="audio/*,.mp3,.mpga,.ogg,.wav,.flac" hidden /></label>
    ${songs.length ? `<div class="field"><label for="map-music">Map song</label><select id="map-music">${options(project.music, "Game music")}</select></div>
    ${project.holes.length > 1 ? project.holes.map((h, i) => `<div class="field"><label for="hole-music-${i}">${esc(h.name)}</label><select class="hole-music" id="hole-music-${i}" data-i="${i}">${options(h.music, "Map song")}</select></div>`).join("") : ""}` : ""}`;
}

function stopSongPreview() {
  if (!songPreview) return;
  songPreview.audio.pause();
  URL.revokeObjectURL(songPreview.url);
  songPreview = null;
}

function wireMusic() {
  const changed = () => {
    history.version++; // autosave picks it up
    renderPanel();
  };
  info.querySelector("#song-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    run("Adding song", async () => {
      const name = project.addSong(file.name, new Uint8Array(await file.arrayBuffer()));
      changed();
      const mb = file.size / 1048576;
      setStatus(mb > 15 ? `Added ${name.slice(6)}: ${mb.toFixed(0)} MB is big, friends download it with the map. An ogg around 128 kbps keeps it small.` : `Added ${name.slice(6)}`);
    });
  });
  info.querySelector("#map-music")?.addEventListener("change", (e) => {
    project.music = e.target.value || null;
    changed();
  });
  info.querySelectorAll(".hole-music").forEach((s) =>
    s.addEventListener("change", () => {
      const h = project.holes[Number(s.dataset.i)];
      if (s.value) h.music = s.value;
      else delete h.music;
      changed();
    }),
  );
  info.querySelectorAll(".song-play").forEach((b) =>
    b.addEventListener("click", () => {
      const was = songPreview?.name;
      stopSongPreview();
      if (was !== b.dataset.name) {
        const url = URL.createObjectURL(new Blob([project.songs.get(b.dataset.name)]));
        const audio = new Audio(url);
        audio.loop = true;
        audio.volume = project.songVolumes.get(b.dataset.name) ?? 1;
        audio.play().catch(() => setStatus("This browser can't preview that song (the game can still play it)"));
        songPreview = { name: b.dataset.name, audio, url };
      }
      renderPanel();
    }),
  );
  info.querySelectorAll(".song-vol").forEach((r) => {
    r.addEventListener("input", () => {
      const volume = Number(r.value) / 100;
      project.songVolumes.set(r.dataset.name, volume);
      r.nextElementSibling.textContent = `${r.value}%`;
      if (songPreview?.name === r.dataset.name) songPreview.audio.volume = volume;
    });
    r.addEventListener("change", () => history.version++);
  });
  info.querySelectorAll(".song-remove").forEach((b) =>
    b.addEventListener("click", () => {
      if (songPreview?.name === b.dataset.name) stopSongPreview();
      project.removeSong(b.dataset.name);
      changed();
    }),
  );
}

// ---------- Helpers ----------

/**
 * A number setting as a slider with an exact number box next to it. The slider has the id, so handlers listen to its
 * "change" (released) and "input" (dragging) events; typing in the box moves the slider and fires "change".
 */
function slider(id, label, value, { min, max, step = 1, unit = "", note = "" } = {}) {
  const lo = Math.min(min, value);
  const hi = Math.max(max, value);
  return `<div class="field slider-field"><label for="${id}">${label}</label>
    <div class="slider-row">
      <input type="range" id="${id}" data-slider min="${lo}" max="${hi}" step="${step}" value="${value}" />
      <input type="text" inputmode="decimal" class="slider-num" data-for="${id}" value="${value}" aria-label="${label}" />
      ${unit ? `<span class="slider-unit">${unit}</span>` : ""}
    </div>${note ? `<p class="hint slider-note" id="${id}-note">${note}</p>` : ""}</div>`;
}

info.addEventListener("input", (e) => {
  if (!e.target.matches("input[data-slider]")) return;
  const box = e.target.parentElement.querySelector(".slider-num");
  if (box) box.value = e.target.value;
});
info.addEventListener("change", (e) => {
  if (!e.target.matches(".slider-num")) return;
  const range = document.getElementById(e.target.dataset.for);
  if (!range) return;
  const v = readNumber(e.target.value);
  if (v === null) {
    e.target.value = range.value;
    return;
  }
  e.target.value = v;
  // Typed values may go past the slider's ends.
  if (v < Number(range.min)) range.min = v;
  if (v > Number(range.max)) range.max = v;
  range.value = v;
  range.dispatchEvent(new Event("change", { bubbles: true }));
});

/** A typed number, with a decimal comma or point ("0,5" or "0.5"); null when it is not one. */
function readNumber(text) {
  const v = Number(String(text).trim().replace(",", "."));
  return String(text).trim() !== "" && Number.isFinite(v) ? v : null;
}

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

// ---------- Autosave ----------

// The project is saved in this browser a few seconds after each change, as a .sbgmap (the same format the
// Export button writes), and offered back when the editor is opened again.
const AUTOSAVE_KEY = "autosave";
let savedSignature = null;
let saving = false;

function projectSignature() {
  return project ? `${history.version}|${JSON.stringify(project.info)}|${project.scale}|${project.rotation}` : null;
}

async function autosave() {
  const sig = projectSignature();
  if (!sig || sig === savedSignature || saving || stroke) return;
  saving = true;
  try {
    const bytes = await project.exportSbgmap({ autosave: true });
    await storePut(AUTOSAVE_KEY, { bytes, name: project.info.name, savedAt: Date.now() });
    savedSignature = sig;
  } catch (e) {
    console.warn("Autosave failed", e);
  } finally {
    saving = false;
  }
}
setInterval(autosave, 4000);
window.addEventListener("beforeunload", () => autosave());

async function offerRestore() {
  let saved = null;
  try {
    saved = await storeGet(AUTOSAVE_KEY);
  } catch {
    return; // storage unavailable (private window)
  }
  if (!saved?.bytes || project || view) return;
  const when = new Date(saved.savedAt).toLocaleString();
  const box = document.createElement("div");
  box.className = "restore";
  box.innerHTML = `<button class="btn btn-primary" id="restore">Continue where you left off</button><span>${esc(saved.name || "Untitled")}, saved ${esc(when)}</span>`;
  empty.append(box);
  box.querySelector("#restore").addEventListener("click", () =>
    run("Restoring", async () => {
      await openMap(await loadZip(new File([saved.bytes], `${saved.name || "autosave"}.sbgmap`)));
      // The reopened map is the saved one; no need to save it again until something changes.
      savedSignature = projectSignature();
      setStatus(`Restored ${saved.name || "your last session"}`);
    }),
  );
}
offerRestore();

// Controls overview.
const helpDialog = document.getElementById("help");
document.getElementById("help-btn").addEventListener("click", () => (helpDialog.hidden = false));
helpDialog.addEventListener("click", (e) => {
  if (e.target === helpDialog || e.target.closest("[data-act=cancel]")) helpDialog.hidden = true;
});

// Close: back to the start screen. The work is autosaved first, so "Continue where you left off" brings it back.
closeBtn.addEventListener("click", () =>
  run("Closing", async () => {
    const name = project?.info.name || "this map";
    if (project && !confirm(`Close ${name}? It stays in the autosave: "Continue where you left off" brings it back until you start something new.`)) return;
    if (project) await autosave();
    setFlying(false);
    clear();
    empty.hidden = false;
    flyBtn.hidden = true;
    closeBtn.hidden = true;
    info.innerHTML = `<p class="hint">Hole details show up here.</p>`;
    holeSelect.innerHTML = "";
    holeSelect.disabled = true;
    empty.querySelector(".restore")?.remove();
    await offerRestore();
    setStatus("Closed");
  }),
);

// What's new: returning visitors see what changed since their last visit, in a card that never blocks the editor.
const SEEN_KEY = "sbg-maps-seen-changes";
async function showWhatsNew() {
  const latest = CHANGES[0]?.id ?? 0;
  let seen = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, String(latest));
  } catch {
    return; // storage blocked: nothing to compare with
  }
  if (seen === null) {
    // No mark yet: a first visit, unless an autosave shows they were here before this card existed.
    let saved = null;
    try {
      saved = await storeGet(AUTOSAVE_KEY);
    } catch {
      // treat as a first visit
    }
    if (!saved) return;
    seen = "0";
  }
  const fresh = CHANGES.filter((c) => c.id > Number(seen));
  if (!fresh.length) return;
  const card = document.createElement("div");
  card.className = "whats-new";
  card.innerHTML = `<h2>What's new</h2>
    ${fresh.map((c) => `<h3>${esc(c.date)}</h3><ul>${c.items.map((i) => `<li>${i}</li>`).join("")}</ul>`).join("")}
    <button class="btn btn-primary small" id="whats-new-ok">Got it</button>`;
  document.body.append(card);
  card.querySelector("#whats-new-ok").addEventListener("click", () => card.remove());
}
showWhatsNew();

// Test hook: lets the automated browser tests reach editor state.
window.__sbg = { get project() { return project; }, history, autosave, THREE, frameBox, camera, controls, renderer, frame, renderPanel: () => renderPanel() };

// Mod button: newest version and date; a "New" badge when this browser downloaded an older version.
{
  const link = document.getElementById("mod-link");
  link.querySelector("#mod-version").textContent = MOD_VERSION;
  link.querySelector("#mod-date").textContent = shortDate(MOD_VERSIONS[0].date);
  const had = downloadedVersion();
  const update = !!had && had !== MOD_VERSION;
  link.querySelector(".mod-new").hidden = !update;
  link.classList.toggle("has-update", update);
  if (update) link.title = `Mod ${MOD_VERSION} is out (you have ${had})`;
}
