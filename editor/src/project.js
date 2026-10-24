// An editable model-based map (format 2): one imported level, surfaces per material, several holes on it.
import * as THREE from "three";
import { zipSync, strToU8 } from "fflate";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { scene, fromMap, toMap, disposeObject } from "./scene.js";
import { materialsOf } from "./importer.js";

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
export const MAX_SIZE = 900;

export class Project {
  constructor(root, info = {}) {
    this.info = { id: "", name: root.name || "My map", author: "", credits: "", ...info };
    this.pivot = new THREE.Group();
    this.pivot.add(root);
    this.root = root;
    this.scale = 1;
    this.rotation = 0; // quarter turns around y
    this.markersGroup = new THREE.Group();
    this.surfaceOverlay = false;
    this.holes = [];
    this.materials = [];
    this.collectMaterials();
    scene.add(this.pivot, this.markersGroup);
    this.applyTransform();
    this.addHole();
  }

  dispose() {
    scene.remove(this.pivot, this.markersGroup);
    disposeObject(this.pivot);
    disposeObject(this.markersGroup);
  }

  collectMaterials() {
    const seen = new Map();
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of materialsOf(o)) {
        if (!seen.has(m)) {
          m.userData.surface ??= "rough";
          m.userData.thumb ??= thumbnail(m);
          seen.set(m, { material: m, original: { color: m.color.clone(), map: m.map } });
        }
      }
    });
    this.materials = [...seen.values()];
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
      const surface = MODEL_SURFACES.find((s) => s.id === material.userData.surface);
      if (this.surfaceOverlay) {
        material.map = null;
        material.color.set(surface.color);
      } else {
        material.map = original.map;
        material.color.copy(original.color);
      }
      material.opacity = material.userData.surface === "none" && this.surfaceOverlay ? 0.35 : 1;
      material.transparent = material.opacity < 1;
      material.needsUpdate = true;
    }
  }

  /** Scale and rotate the model, then place it so its footprint starts at (PAD, PAD) in map coordinates. */
  applyTransform() {
    // Remember markers relative to the model so they follow scaling and rotation.
    const local = this.holes.map((h) => this.markerPoints(h).map(([, p]) => (p ? this.pivot.worldToLocal(fromMap(p)) : null)));

    this.pivot.position.set(0, 0, 0);
    this.pivot.scale.setScalar(this.scale);
    this.pivot.rotation.set(0, (this.rotation * Math.PI) / 2, 0);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.root);
    this.pivot.position.set(PAD - box.min.x, 0, -PAD - box.max.z);
    this.pivot.updateMatrixWorld(true);
    this.box = new THREE.Box3().setFromObject(this.root);

    this.holes.forEach((h, i) =>
      this.markerPoints(h).forEach(([set], j) => {
        if (local[i][j]) set(toMap(this.pivot.localToWorld(local[i][j].clone())));
      }),
    );
    this.rebuildMarkers();
  }

  /** Map area size in metres [x, z]. */
  get size() {
    const s = this.box.getSize(new THREE.Vector3());
    return [Math.ceil(s.x + PAD * 2), Math.ceil(s.z + PAD * 2)];
  }

  addHole() {
    const n = this.holes.length + 1;
    this.holes.push({
      name: `Hole ${n}`,
      par: 4,
      difficulty: "none",
      water: Math.floor(this.box.min.y - 5),
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
    if (kind === "tee") h.tee = p;
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
      if (h.tee) add(new THREE.CylinderGeometry(3, 3, 0.6, 24), MARKERS.tee.color, h.tee, 0.3);
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
      if (h.checkpoints.length > 1) out.push(`${label}: at most 1 checkpoint for now.`);
    });
    return out;
  }

  /** Builds the .sbgmap (zip) bytes: map.json plus level.glb. */
  async exportSbgmap() {
    const glb = await this.exportGlb();
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
      model: { file: "level.glb" },
      holes: this.holes.map((h) => ({
        name: h.name,
        par: h.par,
        difficulty: h.difficulty,
        theme: "coast",
        water: h.water,
        greenRadius: h.greenRadius,
        tee: round(h.tee),
        cup: round(h.cup),
        itemBoxes: h.itemBoxes.map(round),
        checkpoints: h.checkpoints.map(round),
      })),
    };
    return zipSync({ "map.json": strToU8(JSON.stringify(manifest, null, 2)), "level.glb": new Uint8Array(glb) }, { level: 6 });
  }

  /** The level with scale/rotation/placement baked into the vertices, surfaces in material extras. */
  async exportGlb() {
    const out = new THREE.Scene();
    const wasOverlay = this.surfaceOverlay;
    this.setSurfaceOverlay(false);
    // Only the surface goes into the file (userData becomes glTF extras); keep editor-only data out.
    const savedUserData = this.materials.map(({ material }) => [material, material.userData]);
    for (const [m, data] of savedUserData) m.userData = { surface: data.surface };
    this.pivot.updateMatrixWorld(true);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone().applyMatrix4(o.matrixWorld);
      const mesh = new THREE.Mesh(geometry, o.material);
      mesh.name = o.name;
      out.add(mesh);
    });
    try {
      return await new GLTFExporter().parseAsync(out, { binary: true });
    } finally {
      for (const [m, data] of savedUserData) m.userData = data;
      this.setSurfaceOverlay(wasOverlay);
      out.traverse((o) => o.isMesh && o.geometry.dispose());
    }
  }

  /** Re-opens a format 2 map for editing. Vertices are already baked, so scale starts at 1. */
  static async fromMap(map) {
    const bytes = map.files.get(map.manifest.model.file);
    if (!bytes) throw new Error(`Missing ${map.manifest.model.file}`);
    const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer, "");
    const root = gltf.scene;
    root.name = map.manifest.name;
    root.traverse((o) => {
      for (const m of materialsOf(o)) {
        m.side = THREE.DoubleSide;
        m.userData.surface ??= "rough";
      }
    });
    const m = map.manifest;
    const project = new Project(root, { id: m.id, name: m.name, author: m.author, credits: m.credits });
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
    project.activeHole = 0;
    // The baked model already sits at its saved place; keep it there instead of re-padding.
    project.pivot.position.set(0, 0, 0);
    project.pivot.updateMatrixWorld(true);
    project.box = new THREE.Box3().setFromObject(project.root);
    project.rebuildMarkers();
    return project;
  }
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
