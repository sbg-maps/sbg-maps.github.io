// An editable model-based map (format 2): one imported level, surfaces per material, several holes on it.
import * as THREE from "three";
import { zipSync, strToU8 } from "fflate";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { scene, renderer, fromMap, toMap, disposeObject } from "./scene.js";
import { materialsOf, hasCutoutAlpha } from "./importer.js";
import { makeGolfer, yawToRotation } from "./golfer.js";
import { Terrain, setContours } from "./terrain.js";
import { holeGrids } from "./mapfile.js";

/** Surfaces a model material can have, grouped for the picker. `id` is what goes into the map file. */
export const MODEL_SURFACES = [
  { id: "fairway", name: "Fairway", group: "Golf", color: "#84ce54" },
  { id: "rough", name: "Rough", group: "Golf", color: "#62a642" },
  { id: "green", name: "Green", group: "Golf", color: "#a8e870" },
  { id: "sand", name: "Sand (bunker)", group: "Golf", color: "#f4e2a8" },
  { id: "path", name: "Dirt path", group: "Golf", color: "#a0785a" },
  { id: "snow-fairway", name: "Snow fairway", group: "Snow", color: "#e8f2f8" },
  { id: "snow-rough", name: "Snow rough", group: "Snow", color: "#c8d8e4" },
  { id: "snow-green", name: "Snow green", group: "Snow", color: "#f4fbff" },
  { id: "ice", name: "Ice (slippery)", group: "Snow", color: "#8fd8f4" },
  { id: "desert-sand", name: "Desert sand", group: "Desert", color: "#e8c482" },
  { id: "dry-fairway", name: "Dry fairway", group: "Desert", color: "#b8c86a" },
  { id: "dry-green", name: "Dry green", group: "Desert", color: "#ccd88a" },
  { id: "sand-rough", name: "Sandy rough", group: "Desert", color: "#c8b47a" },
  { id: "road", name: "Road", group: "City", color: "#5a5e66" },
  { id: "sidewalk", name: "Sidewalk", group: "City", color: "#b4b4ac" },
  { id: "bridge", name: "Wooden bridge", group: "City", color: "#a8743c" },
  { id: "building", name: "Building / roof", group: "City", color: "#9a8aa8" },
  { id: "slide", name: "Slide (can't stand on it)", group: "Special", color: "#ff9a3c" },
  { id: "oob", name: "Out of bounds", group: "Special", color: "#8a8a8a" },
  { id: "solid", name: "Wall / solid", group: "Special", color: "#c27ad6" },
  { id: "none", name: "No collision", group: "Special", color: "#e05a5a" },
];

export const MARKERS = {
  tee: { name: "Start", color: 0xffffff },
  cup: { name: "Flag", color: 0xe8443a },
  itemBoxes: { name: "Item box", color: 0xf5c400 },
  redItemBoxes: { name: "Red item box", color: 0xe8443a },
  checkpoints: { name: "Checkpoint", color: 0xb400dc },
  bounds: { name: "Play area corner", color: 0x3aa0ff },
};

/**
 * The game's start area (from the hole the mod builds on): two platforms side by side in front of the Start point,
 * facing the Flag. Offsets in metres: x to the right, z forward; size is width, height and depth; the top sits 0.14 m
 * above the platform's position. The mod raises them onto the highest ground under their corners (up to 3 m).
 */
export const TEE_PLATFORMS = [-10.7, 10.7].map((x) => ({ x, z: 2.53 }));
const PLATFORM_SIZE = { w: 15.08, h: 1.72, d: 5.1, top: 0.14 };

/** Players in the air, as the game moves them: gravity 9.81 times its player gravity factor 2.87 (m/s per second). */
const JUMP_GRAVITY = 9.81 * 2.87;
/** In the air, players lose this share of their horizontal speed per second (the game's AirHorizontalDrag). */
const JUMP_AIR_DRAG = 1.2;
/** The game's physics step (s); the flight is simulated with it, like the game does. */
const PHYSICS_STEP = 0.02;

/** Space around the model inside the map area, so tees and bounds are never at the very edge. */
const PAD = 20;
/** The level's lowest point always sits at this height, whatever its scale, with the water a little below. */
export const BASE_Y = 20;
export const DEFAULT_WATER = 15;
export const MAX_SIZE = 900;
/** Most item boxes, and most checkpoints, the mod places in one hole. */
export const MAX_PER_HOLE = 64;
/** Song formats the game's audio engine (FMOD) plays. */
export const SONG_TYPES = ["mp3", "ogg", "wav", "flac"];

export class Project {
  /** @param {{terrain?: Terrain}} [options] a sculptable terrain for levels built from scratch */
  constructor(root, info = {}, { terrain = null } = {}) {
    this.info = { id: "", name: root.name || "My map", author: "", credits: "", ...info };
    this.terrain = terrain;
    this.pivot = new THREE.Group();
    this.pivot.add(root);
    this.root = root;
    this.scale = 1;
    this.rotation = 0; // quarter turns around y
    this.appliedRotation = 0;
    this.markersGroup = new THREE.Group();
    this.surfaceOverlay = false;
    this.holes = [];
    this.materials = [];
    this.golfers = []; // editor-only scale references, in map coordinates
    /** Songs in the map, by file name inside it (music/...); the map plays `music`, a hole its own `music` if set. */
    this.songs = new Map();
    this.music = null;
    /** Loudness per song (0 to 1); songs not listed play at full volume. */
    this.songVolumes = new Map();
    /** Real rotations of camera-facing objects, which the editor turns toward the camera while showing them. */
    this.billboardBase = new WeakMap();
    this.collectMaterials();
    scene.add(this.pivot, this.markersGroup);
    if (terrain) scene.add(terrain.mesh);
    this.applyTransform();
    this.addHole();
  }

  /** A new level from scratch: an island of sculptable terrain and no model. */
  static newLevel(sizeX, sizeZ, info = {}, shape = "island", seed = 1) {
    const root = new THREE.Group();
    root.name = info.name || "My level";
    return new Project(root, info, { terrain: Terrain.generate(shape, sizeX, sizeZ, seed) });
  }

  dispose() {
    scene.remove(this.pivot, this.markersGroup);
    disposeObject(this.pivot);
    disposeObject(this.markersGroup);
    if (this.terrain) {
      scene.remove(this.terrain.mesh);
      this.terrain.dispose();
    }
  }

  /** Everything markers and tools can be placed on. */
  get pickTargets() {
    return this.terrain ? [this.root, this.terrain.mesh] : [this.root];
  }

  /** Can a tee, cup or item box stand where this ray hit? Not on pictures (trees) or moving things, only on the level and static props. */
  isGround(hit) {
    const owner = this.objects.find((o) => { for (let x = hit.object; x; x = x.parent) if (x === o) return true; return false; });
    return !owner || (owner.userData.object === "static" && !owner.userData.billboard);
  }

  /** Does the level have any model geometry (imported level, props, objects)? */
  get hasModel() {
    let found = false;
    this.root.traverse((o) => (found ||= o.isMesh));
    return found;
  }

  collectMaterials() {
    const seen = new Map();
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const fades = fadesOut(o.geometry);
      for (const m of materialsOf(o)) {
        // Layers that fade out through their vertex colours (game rips blend ground textures like this).
        if (fades && m.userData.alphaMode == null) m.userData.alphaMode = "blend";
        if (!seen.has(m)) {
          m.userData.surface ??= m.userData.renderOnly ? "none" : "rough";
          // How the texture's alpha is drawn; imported files and older maps say it in their own ways.
          m.userData.alphaMode ??=
            m.userData.alphaBlend || (m.transparent && !(m.alphaTest > 0)) ? "blend" : m.alphaTest > 0 || (m.map?.image && hasCutoutAlpha(m.map.image)) ? "cutout" : "opaque";
          m.userData.alphaCutoff ??= m.alphaTest > 0 ? m.alphaTest : 0.5;
          m.userData.opacity ??= m.userData.alphaMode === "blend" ? m.opacity : 1;
          m.userData.doubleSided ??= m.side === THREE.DoubleSide;
          m.userData.thumb ??= thumbnail(m);
          seen.set(m, { material: m, original: { color: m.color.clone(), map: m.map, vertexColors: m.vertexColors } });
        }
      }
    });
    this.materials = [...seen.values()];
    // Levels converted from game sources carry a separate invisible collision mesh.
    this.hasCollisionMesh = this.materials.some(({ material }) => material.userData.invisible && !material.userData.renderOnly);
    this.refreshOverlay();
  }

  /** Materials whose surface the mapper chooses (render-only visuals are left out). */
  get surfaceMaterials() {
    return this.materials.filter(({ material }) => !material.userData.renderOnly);
  }

  /** Changes how a material is drawn (alphaMode, alphaCutoff, opacity, doubleSided). */
  setLook(material, changes) {
    Object.assign(material.userData, changes);
    this.refreshOverlay();
  }

  setSurface(material, surface) {
    material.userData.surface = surface;
    this.refreshOverlay();
  }

  /** Toggle between the model's own textures and flat surface colours. */
  setSurfaceOverlay(on) {
    this.surfaceOverlay = on;
    this.refreshOverlay();
  }

  refreshOverlay() {
    for (const { material, original } of this.materials) {
      const { invisible, renderOnly } = material.userData;
      const surface = MODEL_SURFACES.find((s) => s.id === material.userData.surface) ?? MODEL_SURFACES[0];
      if (this.surfaceOverlay) {
        material.map = null;
        material.vertexColors = false;
        material.color.set(surface.color);
      } else {
        material.map = original.map;
        material.vertexColors = original.vertexColors;
        material.color.copy(original.color);
      }
      // Normal view shows what players see; the surface view shows what they play on.
      material.visible = this.surfaceOverlay ? !renderOnly : !invisible;
      const { alphaMode = "opaque", alphaCutoff = 0.5, opacity = 1, doubleSided = true } = material.userData;
      const seeThrough = alphaMode === "blend" || alphaMode === "add";
      material.opacity = material.userData.surface === "none" && this.surfaceOverlay ? 0.35 : alphaMode === "blend" ? opacity : 1;
      material.alphaTest = alphaMode === "cutout" ? alphaCutoff : 0;
      material.blending = alphaMode === "add" ? THREE.AdditiveBlending : THREE.NormalBlending;
      material.transparent = material.opacity < 1 || seeThrough;
      material.depthWrite = !seeThrough;
      material.side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      material.needsUpdate = true;
    }
  }

  /** Objects inside the level (see-saws, rollers, props): nodes marked with userData.object. */
  get objects() {
    const out = [];
    const walk = (o) => {
      for (const c of o.children) {
        if (c.userData.object) out.push(c);
        else walk(c);
      }
    };
    walk(this.root);
    return out;
  }

  /**
   * Adds an object (shape, picture or imported model) standing at a world point. Built-in shapes and pictures are
   * in metres; pass `size` to fit an imported model to roughly that many metres instead.
   */
  addObject(model, worldPoint, { size = null, billboard = false, data = null } = {}) {
    const obj = new THREE.Group();
    obj.name = model.name || "object";
    obj.userData.object = "static";
    if (data) Object.assign(obj.userData, structuredClone(data));
    if (billboard) obj.userData.billboard = true;
    obj.add(model);
    const box = new THREE.Box3().setFromObject(model);
    if (size != null) {
      // Imported models: centre on the footprint, bottom on the ground.
      model.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
    }
    this.root.add(obj);
    this.pivot.updateMatrixWorld(true);
    // Objects live inside the (possibly scaled) level; undo that scale so metres stay metres.
    const levelScale = this.root.getWorldScale(new THREE.Vector3()).x || 1;
    const dims = box.getSize(new THREE.Vector3());
    const fit = size != null ? size / Math.max(dims.x, dims.y, dims.z, 0.001) : 1;
    obj.scale.setScalar(fit / levelScale);
    obj.position.copy(this.root.worldToLocal(worldPoint.clone()));
    obj.updateMatrixWorld(true);
    this.collectMaterials();
    this.rebuildMarkers();
    return obj;
  }

  /** Kept for older callers: an imported model as a static prop. */
  addProp(model, worldPoint, size = 10) {
    return this.addObject(model, worldPoint, { size });
  }

  /** Takes an object out of the level. Not disposed, so undo can put it back. */
  removeObject(object) {
    object.removeFromParent();
    this.collectMaterials();
  }

  /** Scale and rotate the model, then place it so its footprint starts at (PAD, PAD) in map coordinates. */
  applyTransform() {
    if (this.terrain) {
      // Terrain levels are built in map coordinates already; props and objects are placed directly.
      this.pivot.position.set(0, 0, 0);
      this.pivot.scale.setScalar(1);
      this.pivot.rotation.set(0, 0, 0);
      this.pivot.updateMatrixWorld(true);
      this.box = new THREE.Box3().setFromObject(this.terrain.mesh).union(new THREE.Box3().setFromObject(this.root));
      this.rebuildMarkers();
      return;
    }
    // Remember markers relative to the model so they follow scaling and rotation.
    const local = this.holes.map((h) => this.markerPoints(h).map(([, p]) => (p ? this.pivot.worldToLocal(fromMap(p)) : null)));

    this.pivot.position.set(0, 0, 0);
    this.pivot.scale.setScalar(this.scale);
    this.pivot.rotation.set(0, (this.rotation * Math.PI) / 2, 0);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    this.pivot.position.set(PAD - box.min.x, BASE_Y - box.min.y, -PAD - box.max.z);
    this.pivot.updateMatrixWorld(true);
    this.box = new THREE.Box3().setFromObject(this.root);

    this.holes.forEach((h, i) =>
      this.markerPoints(h).forEach(([set], j) => {
        if (local[i][j]) set(toMap(this.pivot.localToWorld(local[i][j].clone())));
      }),
    );
    // A custom start direction turns with the level (a quarter turn is -90 degrees of map yaw).
    const turned = this.rotation - this.appliedRotation;
    this.appliedRotation = this.rotation;
    for (const h of this.holes) if (h.tee && h.tee.yaw != null) h.tee.yaw = (((h.tee.yaw - turned * 90) % 360) + 360) % 360;
    this.rebuildMarkers();
  }

  /** Map area size in metres [x, z]. */
  get size() {
    if (this.terrain) return [this.terrain.sizeX, this.terrain.sizeZ];
    const s = this.box.getSize(new THREE.Vector3());
    return [Math.ceil(s.x + PAD * 2), Math.ceil(s.z + PAD * 2)];
  }

  addHole() {
    const n = this.holes.length + 1;
    this.holes.push({
      name: `Hole ${n}`,
      par: 4,
      difficulty: "none",
      water: this.terrain ? 5 : DEFAULT_WATER,
      greenRadius: 10,
      tee: null,
      cup: null,
      itemBoxes: [],
      checkpoints: [],
    });
    this.activeHole = this.holes.length - 1;
    this.rebuildMarkers();
  }

  removeHole(index) {
    this.holes.splice(index, 1);
    if (this.holes.length === 0) this.addHole();
    this.activeHole = Math.min(this.activeHole, this.holes.length - 1);
    this.rebuildMarkers();
  }

  get hole() {
    return this.holes[this.activeHole];
  }

  /** [setter, point] pairs for every marker of a hole, used to carry markers through transform changes. */
  markerPoints(h) {
    const out = [];
    out.push([(p) => (h.tee = { ...h.tee, ...p }), h.tee]);
    out.push([(p) => (h.cup = p), h.cup]);
    h.itemBoxes.forEach((b, i) => out.push([(p) => (h.itemBoxes[i] = p), b]));
    (h.redItemBoxes ?? []).forEach((b, i) => out.push([(p) => (h.redItemBoxes[i] = p), b]));
    h.checkpoints.forEach((c, i) => out.push([(p) => (h.checkpoints[i] = p), c]));
    (h.bounds ?? []).forEach((c, i) => out.push([(p) => (h.bounds[i] = p), c]));
    return out;
  }

  place(kind, worldPoint) {
    const p = toMap(worldPoint);
    const h = this.hole;
    if (kind === "golfer") this.golfers.push(p);
    else if (kind === "tee") h.tee = p;
    else if (kind === "cup") h.cup = p;
    else (h[kind] ??= []).push(p);
    this.rebuildMarkers();
  }

  /** Removes the marker of the active hole nearest to a world point (within 6 m). */
  erase(worldPoint) {
    const h = this.hole;
    let best = null;
    const consider = (p, remove) => {
      if (!p) return;
      const d = fromMap(p).distanceTo(worldPoint);
      if (d < 6 && (!best || d < best.d)) best = { d, remove };
    };
    consider(h.tee, () => (h.tee = null));
    consider(h.cup, () => (h.cup = null));
    h.itemBoxes.forEach((b, i) => consider(b, () => h.itemBoxes.splice(i, 1)));
    (h.redItemBoxes ?? []).forEach((b, i) => consider(b, () => h.redItemBoxes.splice(i, 1)));
    h.checkpoints.forEach((c, i) => consider(c, () => h.checkpoints.splice(i, 1)));
    (h.bounds ?? []).forEach((c, i) => consider(c, () => h.bounds.splice(i, 1)));
    this.golfers.forEach((g, i) => consider(g, () => this.golfers.splice(i, 1)));
    best?.remove();
    this.rebuildMarkers();
    return !!best;
  }

  /** The active hole's play area: corner posts and a see-through fence along its edges (closed once it has 3 corners). */
  addPlayArea(points) {
    const color = MARKERS.bounds.color;
    const post = new THREE.CylinderGeometry(0.5, 0.5, 8, 8);
    for (const p of points) {
      const m = new THREE.Mesh(post, new THREE.MeshBasicMaterial({ color }));
      m.position.copy(fromMap(p)).y += 4;
      this.markersGroup.add(m);
    }
    if (points.length < 2) return;
    const ring = points.length >= 3 ? [...points, points[0]] : points;
    const fence = [];
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = fromMap(ring[i]);
      const b = fromMap(ring[i + 1]);
      fence.push(a.x, a.y - 2, a.z, b.x, b.y - 2, b.z, b.x, b.y + 6, b.z, a.x, a.y - 2, a.z, b.x, b.y + 6, b.z, a.x, a.y + 6, a.z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(fence, 3));
    const wall = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
    this.markersGroup.add(wall);
  }

  /** A rounded play area around the start and the flag, with room to miss. */
  fitPlayArea() {
    const { tee, cup } = this.hole;
    if (!tee || !cup) return false;
    const dx = cup.x - tee.x;
    const dz = cup.z - tee.z;
    const length = Math.hypot(dx, dz);
    const margin = Math.max(25, length * 0.3);
    const angle = Math.atan2(dz, dx);
    const points = [];
    // Half circles around both ends, joined by straight sides.
    for (const [end, from] of [[cup, angle - Math.PI / 2], [tee, angle + Math.PI / 2]]) {
      for (let k = 0; k <= 8; k++) {
        const a = from + (k / 8) * Math.PI;
        const x = end.x + Math.cos(a) * margin;
        const z = end.z + Math.sin(a) * margin;
        const y = this.terrain ? this.terrain.heightAt(x, z) : end.y;
        points.push({ x, y, z });
      }
    }
    const [sx, sz] = this.size;
    this.hole.bounds = points.map((p) => ({ ...p, x: Math.min(sx, Math.max(0, p.x)), z: Math.min(sz, Math.max(0, p.z)) }));
    this.rebuildMarkers();
    return true;
  }

  rebuildMarkers() {
    disposeObject(this.markersGroup);
    this.markersGroup.clear();
    this.holes.forEach((h, i) => {
      const active = i === this.activeHole;
      const add = (geometry, color, p, lift) => {
        const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, transparent: !active, opacity: active ? 1 : 0.35 }));
        m.position.copy(fromMap(p)).y += lift;
        this.markersGroup.add(m);
      };
      if (h.tee) {
        // A thin ring, so it doesn't get in the way of the player view.
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(2.6, 3, 40),
          new THREE.MeshBasicMaterial({ color: MARKERS.tee.color, side: THREE.DoubleSide, transparent: !active, opacity: active ? 1 : 0.35 }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(fromMap(h.tee)).y += 0.08;
        this.markersGroup.add(ring);
        if (active) {
          // A golfer at the start shows how big the level is to players.
          const golfer = makeGolfer();
          const yaw0 = this.teeYaw(h);
          golfer.position.copy(fromMap(h.tee));
          golfer.position.x += Math.cos((yaw0 * Math.PI) / 180) * 3.5;
          golfer.position.z += Math.sin((yaw0 * Math.PI) / 180) * 3.5;
          golfer.rotation.y = yawToRotation(yaw0);
          this.markersGroup.add(golfer);
        }
        for (const p of this.teePlatforms(h)) {
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(PLATFORM_SIZE.w, PLATFORM_SIZE.h, PLATFORM_SIZE.d),
            new THREE.MeshStandardMaterial({ color: p.clash ? 0xe8443a : 0xf2efe6, transparent: true, opacity: active ? 0.75 : 0.3, roughness: 0.8 }),
          );
          box.position.copy(fromMap({ x: p.x, z: p.z }, p.y + PLATFORM_SIZE.top - PLATFORM_SIZE.h / 2));
          box.rotation.y = yawToRotation(p.yaw) + Math.PI;
          box.userData.platform = true;
          this.markersGroup.add(box);
        }
        // Arrow showing which way players face at the start.
        const yaw = this.teeYaw(h);
        const dir = new THREE.Vector3(Math.sin((yaw * Math.PI) / 180), 0, -Math.cos((yaw * Math.PI) / 180));
        const arrow = new THREE.ArrowHelper(dir, fromMap(h.tee).setY(h.tee.y + 1.2), 8, 0xffffff, 3, 2);
        this.markersGroup.add(arrow);
      }
      if (active && h.bounds?.length) this.addPlayArea(h.bounds);
      if (h.cup) {
        add(new THREE.CylinderGeometry(0.15, 0.15, 6, 8), 0xeeeeee, h.cup, 3);
        add(new THREE.ConeGeometry(1, 2, 3), MARKERS.cup.color, h.cup, 5.5);
        if (active) {
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(h.greenRadius - 0.4, h.greenRadius, 48),
            new THREE.MeshBasicMaterial({ color: 0xa8e870, side: THREE.DoubleSide }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.copy(fromMap(h.cup)).y += 0.3;
          this.markersGroup.add(ring);
        }
      }
      for (const b of h.itemBoxes) add(new THREE.BoxGeometry(2, 2, 2), MARKERS.itemBoxes.color, b, 1.5);
      for (const b of h.redItemBoxes ?? []) add(new THREE.BoxGeometry(2, 2, 2), MARKERS.redItemBoxes.color, b, 1.5);
      for (const c of h.checkpoints) add(new THREE.OctahedronGeometry(1.5), MARKERS.checkpoints.color, c, 2);
      if (active && h.tee && h.cup) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([fromMap(h.tee).setY(h.tee.y + 1), fromMap(h.cup).setY(h.cup.y + 1)]),
          new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 4, gapSize: 3 }),
        );
        line.computeLineDistances();
        this.markersGroup.add(line);
      }
    });
    for (const p of this.golfers) {
      const golfer = makeGolfer(0xf5a623);
      golfer.position.copy(fromMap(p));
      this.markersGroup.add(golfer);
    }
    // Paths that rollers follow.
    for (const obj of this.objects) {
      const path = ["roller", "mover"].includes(obj.userData.object) ? obj.userData.path : null;
      if (!path?.length || !obj.visible) continue;
      obj.updateMatrixWorld(true);
      const pts = path.map((p) => new THREE.Vector3(...p).applyMatrix4(obj.matrixWorld));
      // Dots at the points (sized to the level so they stay visible), joined by a line.
      const dot = new THREE.SphereGeometry(Math.max(0.5, Math.max(...this.size) / 400), 12, 8);
      const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8a00, depthTest: false });
      for (const p of pts) {
        const d = new THREE.Mesh(dot, dotMat);
        d.position.copy(p);
        d.renderOrder = 5;
        this.markersGroup.add(d);
      }
      if (obj.userData.loop !== false && obj.userData.object === "mover") pts.push(pts[0]);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xff8a00, depthTest: false }));
      line.renderOrder = 5;
      this.markersGroup.add(line);
    }
    // Jump pads: the flight and where it comes down.
    for (const pad of this.objects) {
      if (!pad.visible || pad.userData.object !== "jumppad") continue;
      const flight = this.jumpFlight(pad);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(flight.points), new THREE.LineDashedMaterial({ color: 0xff7a1a, dashSize: 1.2, gapSize: 0.6, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 5;
      this.markersGroup.add(line);
      if (flight.landing) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(2.2, 3, 40),
          new THREE.MeshBasicMaterial({ color: flight.inWater ? 0x3aa0ff : 0xff7a1a, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(flight.landing).y += 0.15;
        ring.renderOrder = 5;
        this.markersGroup.add(ring);
      }
    }
        // Water plane for the active hole.
    const h = this.hole;
    if (h) {
      const [sx, sz] = this.size;
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(sx + 400, sz + 400),
        new THREE.MeshStandardMaterial({ color: 0x4fc0e8, transparent: true, opacity: 0.8, roughness: 0.2 }),
      );
      water.rotation.x = -Math.PI / 2;
      water.position.set(sx / 2, h.water, -sz / 2);
      water.userData.isWater = true;
      this.markersGroup.add(water);
    }
  }

  /** Which way players face at the start, in map degrees (0 = +z). */
  teeYaw(h) {
    return h.tee.yaw ?? (h.cup ? (Math.atan2(h.cup.x - h.tee.x, h.cup.z - h.tee.z) * 180) / Math.PI : 0);
  }

  /**
   * Where the game puts the start platforms of a hole (map coordinates, platform height as the mod places them),
   * and whether the level or an object pokes through one (`clash`). Remembered until the Start or the level moves.
   */
  teePlatforms(h) {
    if (!h.tee) return [];
    const yaw = this.teeYaw(h);
    const key = `${h.tee.x}|${h.tee.y}|${h.tee.z}|${yaw}|${this.scale}|${this.rotation}|${this.shapeVersion}`;
    this.platformCache ??= new WeakMap();
    const cached = this.platformCache.get(h);
    if (cached?.key === key) return cached.platforms;
    const rad = (yaw * Math.PI) / 180;
    const right = { x: Math.cos(rad), z: -Math.sin(rad) };
    const fwd = { x: Math.sin(rad), z: Math.cos(rad) };
    const at = (cx, cz, dx, dz) => ({ x: cx + right.x * dx + fwd.x * dz, z: cz + right.z * dx + fwd.z * dz });
    const { w, d, top } = PLATFORM_SIZE;
    const platforms = TEE_PLATFORMS.map((o) => {
      const c = at(h.tee.x, h.tee.z, o.x, o.z);
      const corners = [[0, 0], [w / 2, d / 2], [-w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]].map(([dx, dz]) => at(c.x, c.z, dx, dz));
      let y = h.tee.y;
      for (const p of corners) {
        const g = this.surfaceBelow(p, h.tee.y + 3);
        if (g <= h.tee.y + 3) y = Math.max(y, g);
      }
      return { ...c, y, yaw, clash: this.clashes(c, at, y + top) };
    });
    this.platformCache.set(h, { key, platforms });
    return platforms;
  }

  /** Bumped when the level's shape changes (sculpting), so cached checks run again. */
  shapeVersion = 0;

  /** Highest visible surface under a map point, looking down from `fromY` (map coordinates). */
  surfaceBelow(p, fromY) {
    const hit = this.firstHit(fromMap({ x: p.x, z: p.z }, fromY), new THREE.Vector3(0, -1, 0), 1e5);
    return hit ? hit.point.y : -Infinity;
  }

  /** First visible level or object surface along a ray (three.js coordinates). */
  firstHit(origin, dir, far, ignore = null) {
    const ray = new THREE.Raycaster(origin, dir, 0, far);
    return ray.intersectObjects([this.pivot, this.terrain?.mesh].filter(Boolean), true).find((hit) => {
      for (let o = hit.object; o; o = o.parent) if (!o.visible || o === ignore) return false;
      const mats = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
      const group = hit.object.geometry.groups?.find((g) => hit.faceIndex * 3 >= g.start && hit.faceIndex * 3 < g.start + g.count);
      return mats[group?.materialIndex ?? 0]?.visible !== false;
    }) ?? null;
  }

  /** Does anything stick up through a platform whose top is at `topY` (bumps, walls, objects)? */
  clashes(c, at, topY) {
    const { w, d } = PLATFORM_SIZE;
    const tolerance = 0.3;
    // Bumps: look down onto the top from a little above it, across the whole platform.
    for (let i = 0; i <= 6; i++)
      for (let j = 0; j <= 2; j++) {
        const p = at(c.x, c.z, -w / 2 + (w * i) / 6, -d / 2 + (d * j) / 2);
        const hit = this.firstHit(fromMap(p, topY + 4), new THREE.Vector3(0, -1, 0), 4 - tolerance);
        if (hit) return true;
      }
    // Walls and objects: look along the edges and across, a little above the top.
    const edges = [[[-w / 2, -d / 2], [w / 2, -d / 2]], [[-w / 2, d / 2], [w / 2, d / 2]], [[-w / 2, -d / 2], [-w / 2, d / 2]], [[w / 2, -d / 2], [w / 2, d / 2]], [[-w / 2, -d / 2], [w / 2, d / 2]], [[-w / 2, d / 2], [w / 2, -d / 2]]];
    for (const height of [0.5, 1.5]) {
      for (const [[ax, az], [bx, bz]] of edges) {
        const a = fromMap(at(c.x, c.z, ax, az), topY + height);
        const b = fromMap(at(c.x, c.z, bx, bz), topY + height);
        const dir = b.clone().sub(a);
        const length = dir.length();
        if (this.firstHit(a, dir.normalize(), length)) return true;
      }
    }
    return false;
  }

  /**
   * Where a player launched by a jump pad flies (three.js coordinates): the arc and the first spot it meets the level,
   * an object or the water, with the game's gravity and air drag for players (not steering in the air).
   */
  jumpFlight(pad) {
    const d = pad.userData;
    pad.updateMatrixWorld(true);
    const key = `${pad.matrixWorld.elements.join(",")}|${d.launchSpeed}|${d.launchPitch}|${this.hole?.water}|${this.shapeVersion}`;
    this.flightCache ??= new WeakMap();
    const cached = this.flightCache.get(pad);
    if (cached?.key === key) return cached.flight;
    const box = new THREE.Box3().setFromObject(pad);
    const start = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + 0.9, (box.min.z + box.max.z) / 2);
    // Forward is the pad's -z (map +z), flattened; pitch tilts it up.
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(pad.matrixWorld).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const pitch = THREE.MathUtils.degToRad(d.launchPitch ?? 35);
    const v = forward.multiplyScalar(Math.cos(pitch) * (d.launchSpeed ?? 103)).setY(Math.sin(pitch) * (d.launchSpeed ?? 103));
    const water = this.hole?.water ?? -Infinity;
    const points = [start.clone()];
    const p = start.clone();
    // Three physics steps per checked segment keeps the ray tests few.
    const steps = 3;
    const step = PHYSICS_STEP * steps;
    let landing = null;
    let inWater = false;
    for (let t = 0; t < 15 && !landing; t += step) {
      const next = p.clone();
      for (let k = 0; k < steps; k++) {
        v.y -= JUMP_GRAVITY * PHYSICS_STEP;
        const keep = Math.max(0, 1 - JUMP_AIR_DRAG * PHYSICS_STEP);
        v.x *= keep;
        v.z *= keep;
        next.addScaledVector(v, PHYSICS_STEP);
      }
      const dir = next.clone().sub(p);
      const length = dir.length();
      const hit = length > 0 ? this.firstHit(p, dir.normalize(), length, pad) : null;
      if (hit) {
        landing = hit.point;
      } else if (next.y <= water) {
        landing = p.clone().lerp(next, (p.y - water) / Math.max(1e-6, p.y - next.y));
        inWater = true;
      }
      p.copy(landing ?? next);
      points.push(p.clone());
    }
    const flight = { points, landing, inWater };
    this.flightCache.set(pad, { key, flight });
    return flight;
  }

  /** Things that work but look wrong in game; they don't stop the export. */
  warnings() {
    const out = [];
    this.holes.forEach((h, i) => {
      if (this.teePlatforms(h).some((p) => p.clash)) out.push(`${h.name || `Hole ${i + 1}`}: the start platforms (red) run into the level or an object. Move the Start or turn it.`);
    });
    return out;
  }

  /** Problems that would stop a hole from working in game. */
  problems() {
    const out = [];
    const [sx, sz] = this.size;
    if (sx > MAX_SIZE || sz > MAX_SIZE) out.push(`The level is ${sx} x ${sz} m; the game fits at most ${MAX_SIZE} x ${MAX_SIZE} m. Lower the scale.`);
    this.holes.forEach((h, i) => {
      const label = `${h.name || `Hole ${i + 1}`}`;
      if (!h.tee) out.push(`${label}: place the Start (where players tee off).`);
      if (!h.cup) out.push(`${label}: place the Flag (the hole players aim for).`);
      if (h.itemBoxes.length + (h.redItemBoxes?.length ?? 0) > MAX_PER_HOLE) out.push(`${label}: at most ${MAX_PER_HOLE} item boxes (red ones included).`);
      const under = [h.tee && "the Start", h.cup && "the Flag"].filter((what, k) => what && [h.tee, h.cup][k].y < h.water);
      if (under.length) out.push(`${label}: ${under.join(" and ")} ${under.length > 1 ? "are" : "is"} under the water level (${h.water} m).`);
      if (h.checkpoints.length > MAX_PER_HOLE) out.push(`${label}: at most ${MAX_PER_HOLE} checkpoints.`);
    });
    return out;
  }

  /**
   * Builds the .sbgmap (zip) bytes: map.json plus level.glb and/or the terrain grids. With `previews`, each hole also
   * gets a picture for the game's match setup (left out of autosaves, which run often).
   */
  async exportSbgmap({ previews = false } = {}) {
    const files = {};
    const pictures = previews ? await this.renderPreviews() : [];
    pictures.forEach((bytes, i) => bytes && (files[`previews/hole${i + 1}.jpg`] = [bytes, { level: 0 }]));
    const withModel = !this.terrain || this.hasModel;
    if (withModel) files["level.glb"] = new Uint8Array(await this.exportGlb());
    const grids = this.terrain?.exportGrids("terrain");
    if (grids) Object.assign(files, grids.files);
    const id = this.info.id || `${slug(this.info.author || "anon")}.${slug(this.info.name)}`;
    const round = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 100) / 100]));
    const manifest = {
      format: 2,
      id,
      name: this.info.name,
      author: this.info.author,
      credits: this.info.credits || undefined,
      version: "1.0.0",
      size: this.size,
      model: withModel ? { file: "level.glb" } : undefined,
      music: this.music ?? undefined,
      songs: this.songVolumesFor(this.usedSongs()),
      holes: this.holes.map((h, i) => ({
        name: h.name,
        par: h.par,
        difficulty: h.difficulty,
        theme: "coast",
        heightmap: grids?.heightmap,
        paintmap: grids?.paintmap,
        water: h.water,
        greenRadius: h.greenRadius,
        tee: h.tee ? round(h.tee) : undefined,
        cup: h.cup ? round(h.cup) : undefined,
        itemBoxes: h.itemBoxes.map(round),
        redItemBoxes: h.redItemBoxes?.length ? h.redItemBoxes.map(round) : undefined,
        items: itemWeights(h.items),
        redItems: itemWeights(h.redItems),
        checkpoints: h.checkpoints.map(round),
        bounds: h.bounds?.length >= 3 ? h.bounds.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100]) : undefined,
        music: h.music ?? undefined,
        preview: pictures[i] ? `previews/hole${i + 1}.jpg` : undefined,
      })),
    };
    // Only songs something plays go in, stored as they are (they are compressed already).
    for (const name of this.usedSongs()) files[name] = [this.songs.get(name), { level: 0 }];
    return zipSync({ "map.json": strToU8(JSON.stringify(manifest, null, 2)), ...files }, { level: 6 });
  }

  /** `songs` for map.json: settings of the given songs that differ from the defaults, or nothing. */
  songVolumesFor(names) {
    const out = {};
    for (const n of names) {
      const v = this.songVolumes.get(n);
      if (v != null && v !== 1) out[n] = { volume: Math.round(v * 100) / 100 };
    }
    return Object.keys(out).length ? out : undefined;
  }

  static PREVIEW_SIZE = [608, 400];

  /**
   * A picture of each hole from above and behind the Start, looking down the hole to the Flag (like the game's own
   * hole pictures), as JPEG bytes; null for holes without a Start and Flag. Editor helpers are hidden meanwhile.
   */
  async renderPreviews() {
    const [w, h] = Project.PREVIEW_SIZE;
    const target = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.5, 20000);
    const keep = new Set([this.pivot, this.markersGroup, this.terrain?.mesh]);
    const hidden = scene.children.filter((o) => o.visible && !o.isLight && !keep.has(o));
    const before = { active: this.activeHole, background: scene.background };
    const pixels = [];
    try {
      hidden.forEach((o) => (o.visible = false));
      scene.background = new THREE.Color(0x9fd8f5);
      setContours(false);
      for (let i = 0; i < this.holes.length; i++) {
        const hole = this.holes[i];
        if (!hole.tee || !hole.cup) {
          pixels.push(null);
          continue;
        }
        this.activeHole = i;
        this.rebuildMarkers();
        // Only the water stays of the markers, reaching to the horizon like the game's sea.
        this.markersGroup.children.forEach((o) => {
          o.visible = !!o.userData.isWater;
          if (o.visible) o.scale.set(30, 30, 1);
        });
        const tee = fromMap(hole.tee);
        const cup = fromMap(hole.cup);
        const along = new THREE.Vector3(cup.x - tee.x, 0, cup.z - tee.z);
        const length = Math.max(20, along.length());
        along.normalize();
        camera.position.copy(tee).addScaledVector(along, -(length * 0.25 + 15)).add(new THREE.Vector3(0, length * 0.35 + 20, 0));
        // Stay well above any hill behind the Start, and clear of what lies between it and the Flag.
        camera.position.y = Math.max(camera.position.y, this.groundUnder(camera.position) + 25, ...[0.2, 0.4].map((t) => this.groundUnder(tee.clone().lerp(cup, t)) + 15));
        camera.lookAt(tee.clone().lerp(cup, 0.55));
        camera.updateMatrixWorld();
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const data = new Uint8Array(w * h * 4);
        renderer.readRenderTargetPixels(target, 0, 0, w, h, data);
        pixels.push(data);
      }
    } finally {
      renderer.setRenderTarget(null);
      target.dispose();
      setContours(true);
      hidden.forEach((o) => (o.visible = true));
      scene.background = before.background;
      this.activeHole = before.active;
      this.rebuildMarkers();
    }
    return Promise.all(pixels.map((data) => data && toJpeg(data, w, h)));
  }

  /** Height of the level or terrain under a point (three.js coordinates), or -Infinity. */
  groundUnder(p) {
    const ray = new THREE.Raycaster(new THREE.Vector3(p.x, 1e5, p.z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects([this.pivot, this.terrain?.mesh].filter(Boolean), true).find((h) => h.object.visible);
    return hit ? hit.point.y : -Infinity;
  }

  usedSongs() {
    return new Set([this.music, ...this.holes.map((h) => h.music)].filter((n) => n && this.songs.has(n)));
  }

  /** Adds a song file and returns its name inside the map. */
  addSong(fileName, bytes) {
    let ext = fileName.split(".").pop().toLowerCase();
    if (ext === "mpga" || ext === "mpeg") ext = "mp3";
    if (!SONG_TYPES.includes(ext)) throw new Error(`Songs can be ${SONG_TYPES.join(", ")} (not .${ext})`);
    const base = fileName.replace(/\.[^.]*$/, "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "song";
    let name = `music/${base}.${ext}`;
    for (let i = 2; this.songs.has(name); i++) name = `music/${base}-${i}.${ext}`;
    this.songs.set(name, bytes);
    this.music ??= name;
    return name;
  }

  removeSong(name) {
    this.songs.delete(name);
    this.songVolumes.delete(name);
    if (this.music === name) this.music = this.songs.keys().next().value ?? null;
    for (const h of this.holes) if (h.music === name) delete h.music;
  }

  /**
   * The level with scale/rotation/placement baked into the vertices and surfaces in material extras.
   * Objects stay separate nodes with their own transform (so the game can move them) and their userData as extras.
   */
  async exportGlb() {
    const out = new THREE.Scene();
    // Export copies of the materials as players see them, so the live ones (and the view) are never touched while
    // the exporter runs; autosave runs this in the background while the mapper keeps editing.
    const copies = new Map(this.materials.map((entry) => [entry.material, exportMaterial(entry)]));
    const exportMaterialOf = (m) => (Array.isArray(m) ? m.map((x) => copies.get(x) ?? x) : copies.get(m) ?? m);
    // Camera-facing objects are exported with their real rotation, not the one they show right now.
    for (const o of this.objects) {
      const base = this.billboardBase.get(o);
      if (base) o.quaternion.copy(base);
    }
    this.pivot.updateMatrixWorld(true);
    const objects = new Set(this.objects.filter((o) => o.visible));
    const nodeFor = new Map();
    for (const obj of objects) {
      const node = new THREE.Group();
      node.name = obj.name;
      obj.matrixWorld.decompose(node.position, node.quaternion, node.scale);
      node.userData = JSON.parse(JSON.stringify(obj.userData));
      out.add(node);
      nodeFor.set(obj, node);
    }
    const inverse = new THREE.Matrix4();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      // The object may be the mesh itself (single-part glTF nodes load that way) or one of its parents.
      let owner = o;
      while (owner && !objects.has(owner) && owner !== this.root) owner = owner.parent;
      if (owner && !objects.has(owner) && this.objects.some((x) => !x.visible && isAncestor(x, o))) return; // hidden object
      const node = objects.has(owner) ? nodeFor.get(owner) : null;
      const matrix = node ? inverse.copy(owner.matrixWorld).invert().multiply(o.matrixWorld) : o.matrixWorld;
      const mesh = new THREE.Mesh(o.geometry.clone().applyMatrix4(matrix), exportMaterialOf(o.material));
      mesh.name = o.name;
      (node ?? out).add(mesh);
    });
    try {
      return await new GLTFExporter().parseAsync(out, { binary: true });
    } finally {
      out.traverse((o) => o.isMesh && o.geometry.dispose());
      copies.forEach((m) => m.dispose());
    }
  }

  /**
   * Re-opens a map for editing: its model (if any) at its saved place, and its terrain when every hole shares one.
   * Returns null for heightmap maps whose holes each have their own terrain (those open in the viewer).
   */
  static async fromMap(map) {
    const m = map.manifest;
    const heightFiles = new Set(m.holes.map((h) => h.heightmap?.file).filter(Boolean));
    if (heightFiles.size > 1) return null;
    let root = new THREE.Group();
    if (m.model?.file) {
      const bytes = map.files.get(m.model.file);
      if (!bytes) throw new Error(`Missing ${m.model.file}`);
      root = (await new GLTFLoader().parseAsync(bytes.slice().buffer, "")).scene;
      root.traverse((o) => {
        for (const mat of materialsOf(o)) {
          mat.side = THREE.DoubleSide;
          mat.userData.surface ??= "rough";
        }
      });
    }
    root.name = m.name;
    const terrainHole = m.holes.find((h) => h.heightmap);
    const terrain = terrainHole ? Terrain.fromHole({ ...terrainHole, size: terrainHole.size ?? m.size }, holeGrids(map, { ...terrainHole, size: terrainHole.size ?? m.size })) : null;
    const project = new Project(root, { id: m.id, name: m.name, author: m.author, credits: m.credits }, { terrain });
    project.holes = m.holes.map((h) => ({
      name: h.name,
      par: h.par,
      difficulty: h.difficulty ?? "none",
      water: h.water ?? 5,
      greenRadius: h.greenRadius ?? 10,
      tee: h.tee,
      cup: h.cup,
      itemBoxes: h.itemBoxes ?? [],
      redItemBoxes: h.redItemBoxes ?? [],
      ...(h.items ? { items: { ...h.items } } : {}),
      ...(h.redItems ? { redItems: { ...h.redItems } } : {}),
      checkpoints: h.checkpoints ?? [],
      // Play area corners carry a height only for drawing; the game uses x and z.
      ...(h.bounds?.length >= 3 ? { bounds: h.bounds.map(([x, z]) => ({ x, y: terrain ? terrain.heightAt(x, z) : (h.cup?.y ?? h.tee?.y ?? BASE_Y), z })) } : {}),
      ...(h.music ? { music: h.music } : {}),
    }));
    for (const name of [m.music, ...m.holes.map((h) => h.music)]) {
      if (name && map.files.has(name)) project.songs.set(name, map.files.get(name));
    }
    project.music = m.music && project.songs.has(m.music) ? m.music : null;
    for (const [name, settings] of Object.entries(m.songs ?? {})) if (typeof settings?.volume === "number") project.songVolumes.set(name, settings.volume);
    // Points saved without a height (format 1) take it from the terrain.
    if (terrain) {
      for (const h of project.holes) for (const [set, p] of project.markerPoints(h)) if (p && p.y == null) set({ ...p, y: terrain.heightAt(p.x, p.z) });
    }
    project.activeHole = 0;
    if (!terrain) {
      // The baked model already sits at its saved place; keep it there instead of re-padding.
      project.pivot.position.set(0, 0, 0);
      project.pivot.updateMatrixWorld(true);
      project.box = new THREE.Box3().setFromObject(project.root);
    }
    project.rebuildMarkers();
    return project;
  }
}

function isAncestor(ancestor, object) {
  for (let o = object.parent; o; o = o.parent) if (o === ancestor) return true;
  return false;
}

/** Small data-URL preview of a material's texture (or null), kept so the panel never depends on blob URLs. */
function thumbnail(material) {
  const img = material.map?.image;
  if (!img || !img.width) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  try {
    canvas.getContext("2d").drawImage(img, 0, 0, 32, 32);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "map";
}

/** RGBA pixels read from WebGL (bottom row first) as JPEG bytes. */
async function toJpeg(data, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) image.data.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  // The sky is see-through in the editor; give the picture an opaque one.
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Only game-relevant fields go into the file (material userData becomes glTF extras). */
const EXPORT_EXTRAS = ["surface", "invisible", "renderOnly", "climbable", "sm64Surface", "alphaBlend", "alphaMode"];

/** A copy of a material for export: its own textures and colours (not the surface view) and its drawing settings. */
function exportMaterial({ material, original }) {
  const m = material.clone();
  const data = material.userData;
  m.userData = Object.fromEntries(EXPORT_EXTRAS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  m.map = original.map;
  m.vertexColors = original.vertexColors;
  m.color.copy(original.color);
  m.emissive?.setHex(0x000000); // the editor's selection highlight
  m.visible = true;
  const { alphaMode = "opaque", alphaCutoff = 0.5, opacity = 1, doubleSided = true } = data;
  m.alphaTest = alphaMode === "cutout" ? alphaCutoff : 0;
  m.transparent = alphaMode === "blend" || alphaMode === "add";
  m.opacity = alphaMode === "blend" ? opacity : 1;
  m.blending = THREE.NormalBlending;
  m.side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  return m;
}

const fadeCache = new WeakMap();

/** Does a mesh have see-through vertex colours (a layer that fades into what is under it)? Remembered per geometry. */
function fadesOut(geometry) {
  if (fadeCache.has(geometry)) return fadeCache.get(geometry);
  const c = geometry.attributes.color;
  let fades = false;
  if (c && c.itemSize === 4) for (let i = 0; i < c.count && !fades; i++) fades = c.getW(i) < 0.99;
  fadeCache.set(geometry, fades);
  return fades;
}

/**
 * Items the game's boxes can hold, by the name the game uses, with the name players know. `close` and `red` are the
 * game's own weights for a player near the leader and for red boxes, used as the starting point when a mapper chooses.
 */
export const ITEMS = [
  { id: "Coffee", name: "Coffee", close: 0, red: 0 },
  { id: "SpringBoots", name: "Spring boots", close: 20, red: 50 },
  { id: "RocketDriver", name: "Fire club", close: 5, red: 50 },
  { id: "GolfCart", name: "Golf cart", close: 5, red: 0 },
  { id: "Landmine", name: "Landmine", close: 15, red: 0 },
  { id: "DuelingPistol", name: "Dueling pistol", close: 20, red: 0 },
  { id: "ElephantGun", name: "Elephant gun", close: 5, red: 0 },
  { id: "Airhorn", name: "Airhorn", close: 5, red: 0 },
  { id: "Electromagnet", name: "Electromagnet", close: 10, red: 0 },
  { id: "RocketLauncher", name: "Rocket launcher", close: 5, red: 0 },
  { id: "FreezeBomb", name: "Freeze bomb", close: 5, red: 0 },
  { id: "SmokeBomb", name: "Smoke bomb", close: 0, red: 0 },
  { id: "FlashCamera", name: "Flash camera", close: 5, red: 0 },
  { id: "Thunderstorm", name: "Thunderstorm", close: 0, red: 0 },
  { id: "Railgun", name: "Railgun", close: 0, red: 0 },
  { id: "OrbitalLaser", name: "Orbital laser", close: 0, red: 0 },
  { id: "JumboBurger", name: "Jumbo burger", close: 0, red: 0 },
];

/** Item weights for map.json: only items that can appear, or nothing (the game's own choice). */
function itemWeights(weights) {
  if (!weights) return undefined;
  const out = Object.fromEntries(Object.entries(weights).filter(([, w]) => w > 0));
  return Object.keys(out).length ? out : undefined;
}
