// An editable model-based map (format 2): one imported level, surfaces per material, several holes on it.
import * as THREE from "three";
import { zipSync, strToU8 } from "fflate";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { scene, fromMap, toMap, disposeObject } from "./scene.js";
import { materialsOf } from "./importer.js";
import { makeGolfer, yawToRotation } from "./golfer.js";
import { Terrain } from "./terrain.js";
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
  checkpoints: { name: "Checkpoint", color: 0xb400dc },
};

/** Space around the model inside the map area, so tees and bounds are never at the very edge. */
const PAD = 20;
/** The level's lowest point always sits at this height, whatever its scale, with the water a little below. */
export const BASE_Y = 20;
export const DEFAULT_WATER = 15;
export const MAX_SIZE = 900;

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
      for (const m of materialsOf(o)) {
        if (!seen.has(m)) {
          m.userData.surface ??= m.userData.renderOnly ? "none" : "rough";
          m.userData.thumb ??= thumbnail(m);
          seen.set(m, { material: m, original: { color: m.color.clone(), map: m.map, vertexColors: m.vertexColors } });
        }
      }
    });
    this.materials = [...seen.values()];
    // Levels converted from game sources carry a separate invisible collision mesh.
    this.hasCollisionMesh = this.materials.some(({ material }) => material.userData.invisible);
    this.refreshOverlay();
  }

  /** Materials whose surface the mapper chooses (render-only visuals are left out). */
  get surfaceMaterials() {
    return this.materials.filter(({ material }) => !material.userData.renderOnly);
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
      material.opacity = material.userData.surface === "none" && this.surfaceOverlay ? 0.35 : 1;
      material.transparent = material.opacity < 1 || material.userData.alphaBlend === true;
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
  addObject(model, worldPoint, { size = null, billboard = false } = {}) {
    const obj = new THREE.Group();
    obj.name = model.name || "object";
    obj.userData.object = "static";
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
    h.checkpoints.forEach((c, i) => out.push([(p) => (h.checkpoints[i] = p), c]));
    return out;
  }

  place(kind, worldPoint) {
    const p = toMap(worldPoint);
    const h = this.hole;
    if (kind === "golfer") this.golfers.push(p);
    else if (kind === "tee") h.tee = p;
    else if (kind === "cup") h.cup = p;
    else h[kind].push(p);
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
    h.checkpoints.forEach((c, i) => consider(c, () => h.checkpoints.splice(i, 1)));
    this.golfers.forEach((g, i) => consider(g, () => this.golfers.splice(i, 1)));
    best?.remove();
    this.rebuildMarkers();
    return !!best;
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
          const yaw0 = h.tee.yaw ?? (h.cup ? (Math.atan2(h.cup.x - h.tee.x, h.cup.z - h.tee.z) * 180) / Math.PI : 0);
          golfer.position.copy(fromMap(h.tee));
          golfer.position.x += Math.cos((yaw0 * Math.PI) / 180) * 3.5;
          golfer.position.z += Math.sin((yaw0 * Math.PI) / 180) * 3.5;
          golfer.rotation.y = yawToRotation(yaw0);
          this.markersGroup.add(golfer);
        }
        // Arrow showing which way players face at the start.
        const yaw = h.tee.yaw ?? (h.cup ? (Math.atan2(h.cup.x - h.tee.x, h.cup.z - h.tee.z) * 180) / Math.PI : 0);
        const dir = new THREE.Vector3(Math.sin((yaw * Math.PI) / 180), 0, -Math.cos((yaw * Math.PI) / 180));
        const arrow = new THREE.ArrowHelper(dir, fromMap(h.tee).setY(h.tee.y + 1.2), 8, 0xffffff, 3, 2);
        this.markersGroup.add(arrow);
      }
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

  /** Problems that would stop a hole from working in game. */
  problems() {
    const out = [];
    const [sx, sz] = this.size;
    if (sx > MAX_SIZE || sz > MAX_SIZE) out.push(`The level is ${sx} x ${sz} m; the game fits at most ${MAX_SIZE} x ${MAX_SIZE} m. Lower the scale.`);
    this.holes.forEach((h, i) => {
      const label = `${h.name || `Hole ${i + 1}`}`;
      if (!h.tee) out.push(`${label}: place the Start (where players tee off).`);
      if (!h.cup) out.push(`${label}: place the Flag (the hole players aim for).`);
      if (h.itemBoxes.length > 16) out.push(`${label}: at most 16 item boxes for now.`);
      const under = [h.tee && "the Start", h.cup && "the Flag"].filter((what, k) => what && [h.tee, h.cup][k].y < h.water);
      if (under.length) out.push(`${label}: ${under.join(" and ")} ${under.length > 1 ? "are" : "is"} under the water level (${h.water} m).`);
      if (h.checkpoints.length > 1) out.push(`${label}: at most 1 checkpoint for now.`);
    });
    return out;
  }

  /** Builds the .sbgmap (zip) bytes: map.json plus level.glb and/or the terrain grids. */
  async exportSbgmap() {
    const files = {};
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
      holes: this.holes.map((h) => ({
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
        checkpoints: h.checkpoints.map(round),
      })),
    };
    return zipSync({ "map.json": strToU8(JSON.stringify(manifest, null, 2)), ...files }, { level: 6 });
  }

  /**
   * The level with scale/rotation/placement baked into the vertices and surfaces in material extras.
   * Objects stay separate nodes with their own transform (so the game can move them) and their userData as extras.
   */
  async exportGlb() {
    const out = new THREE.Scene();
    const wasOverlay = this.surfaceOverlay;
    this.setSurfaceOverlay(false);
    // Only game-relevant fields go into the file (userData becomes glTF extras); keep editor-only data out.
    const KEEP = ["surface", "invisible", "renderOnly", "sm64Surface", "alphaBlend"];
    const savedUserData = this.materials.map(({ material }) => [material, material.userData, material.visible]);
    for (const [m, data] of savedUserData) {
      m.userData = Object.fromEntries(KEEP.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
      m.visible = true;
    }
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
      const mesh = new THREE.Mesh(o.geometry.clone().applyMatrix4(matrix), o.material);
      mesh.name = o.name;
      (node ?? out).add(mesh);
    });
    try {
      return await new GLTFExporter().parseAsync(out, { binary: true });
    } finally {
      for (const [m, data, visible] of savedUserData) {
        m.userData = data;
        m.visible = visible;
      }
      this.setSurfaceOverlay(wasOverlay);
      out.traverse((o) => o.isMesh && o.geometry.dispose());
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
      checkpoints: h.checkpoints ?? [],
    }));
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
