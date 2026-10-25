// Loads 3D models picked by the user (OBJ+MTL, glTF/GLB, FBX, DAE) together with their textures.
// Everything is read locally through blob URLs; nothing is uploaded.
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { unzipSync } from "fflate";

export const MODEL_EXTENSIONS = [".obj", ".glb", ".gltf", ".fbx", ".dae"];

const ext = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();
const base = (path) => path.split(/[\\/]/).pop().toLowerCase();

/** Model files among the picked files, biggest first (a download often has the level plus smaller extras). */
export function findModels(files) {
  return [...files].filter((f) => MODEL_EXTENSIONS.includes(ext(f.name))).sort((a, b) => b.size - a.size);
}

/** Replaces any .zip among the files with the files inside it (models are often shared zipped). */
export async function unpackZips(files) {
  const out = [];
  for (const f of files) {
    if (ext(f.name) !== ".zip") {
      out.push(f);
      continue;
    }
    const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
    for (const [name, bytes] of Object.entries(entries)) if (!name.endsWith("/")) out.push(new File([bytes], name.split("/").pop()));
  }
  return out;
}

/**
 * Loads a model from the picked files (the given one, or the biggest). Other files (mtl, textures, bin) are resolved
 * by file name, case-insensitively, so it works whatever folder layout the model came in.
 */
export async function importModel(fileList, modelFile = findModels(fileList)[0]) {
  const files = [...fileList];
  if (!modelFile) throw new Error(`No model file found. Supported: ${MODEL_EXTENSIONS.join(", ")}`);

  const urls = new Map();
  for (const f of files) urls.set(base(f.name), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  // Map whatever path the model asks for onto the picked file with the same name. Loaders prefix relative paths
  // with the parent file's URL (itself a blob URL), so only our exact blob URLs pass through untouched.
  const ours = new Set(urls.values());
  manager.setURLModifier((url) => (ours.has(url) || url.startsWith("data:") ? url : urls.get(base(decodeURIComponent(url))) ?? url));
  const missing = new Set();
  manager.onError = (url) => missing.add(base(decodeURIComponent(url)));
  const progress = { loaded: 0, total: 0 };
  manager.onStart = manager.onProgress = (_url, loaded, total) => Object.assign(progress, { loaded, total });

  const modelUrl = urls.get(base(modelFile.name));
  let root;
  try {
    switch (ext(modelFile.name)) {
      case ".obj":
        root = await loadObj(manager, files, modelUrl);
        break;
      case ".glb":
      case ".gltf":
        root = (await new GLTFLoader(manager).loadAsync(modelUrl)).scene;
        break;
      case ".fbx":
        root = await new FBXLoader(manager).loadAsync(modelUrl);
        break;
      case ".dae":
        root = (await new ColladaLoader(manager).loadAsync(modelUrl)).scene;
        break;
    }
    await waitUntilIdle(progress);
  } finally {
    // Textures are decoded into images by now; the blob URLs are no longer needed.
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }
  root.name = modelFile.name.replace(/\.[^.]+$/, "");
  // glTF has proper multi-texture materials, and its stacked copies can be meant (invisible collision meshes).
  const layers = [".glb", ".gltf"].includes(ext(modelFile.name)) ? 0 : dropTextureLayers(root);
  // glTF stores each texture's wrap mode; other formats assume repeating textures.
  normalizeMaterials(root, { keepWrap: [".glb", ".gltf"].includes(ext(modelFile.name)) });
  return { root, missing: [...missing], layers };
}

/**
 * Some game rips (GameCube/Wii/Switch tools exporting to .dae) split materials that blend several textures into
 * one copy of the mesh per texture, stacked on the same triangles. The extra copies hold shadow or light overlays
 * that would cover the real texture and flicker, so they are removed. Returns how many were removed.
 */
function dropTextureLayers(root) {
  const seen = [];
  const extra = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const same = seen.find((s) => s.parent === o.parent && samePositions(s.geometry.attributes.position, pos) && sameMatrix(s, o));
    if (same) extra.push(o);
    else seen.push(o);
  });
  for (const o of extra) o.removeFromParent();
  return extra.length;
}

function samePositions(a, b) {
  if (a === b) return true;
  if (a.count !== b.count || a.itemSize !== b.itemSize) return false;
  const x = a.array;
  const y = b.array;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

const sameMatrix = (a, b) => a.matrix.equals(b.matrix);

async function loadObj(manager, files, modelUrl) {
  const loader = new OBJLoader(manager);
  const mtlFile = files.find((f) => ext(f.name) === ".mtl");
  if (mtlFile) {
    const materials = await new MTLLoader(manager).loadAsync(manager.resolveURL(mtlFile.name));
    materials.preload();
    loader.setMaterials(materials);
  }
  return loader.loadAsync(modelUrl);
}

/**
 * Resolves once the loading manager has finished every file it started (textures load after the model itself),
 * and nothing new has started for a moment.
 */
async function waitUntilIdle(progress, timeoutMs = 30000) {
  const deadline = performance.now() + timeoutMs;
  let quietSince = performance.now();
  let last = -1;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (progress.loaded !== progress.total || progress.total !== last) {
      last = progress.total;
      quietSince = performance.now();
    } else if (performance.now() - quietSince > 150) {
      return;
    }
  }
}

/** True if the image is fully transparent and grey: a glow map that only works with additive blending. */
function isGlowTexture(image) {
  try {
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] !== 0) return false;
    // Fully transparent pixels lose their colour when drawn, so look at the colour separately.
    const opaque = document.createElement("canvas");
    opaque.width = opaque.height = size;
    const octx = opaque.getContext("2d", { willReadFrequently: true, alpha: false });
    octx.drawImage(image, 0, 0, size, size);
    return !hasColour(octx.getImageData(0, 0, size, size).data);
  } catch {
    return false;
  }
}

const hasColour = (px) => {
  for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 8) return true;
  return false;
};

export function materialsOf(object) {
  if (!object.material) return [];
  return Array.isArray(object.material) ? object.material : [object.material];
}

/**
 * Converts every material to MeshStandardMaterial so it previews consistently and exports cleanly to glTF.
 * Ripped game models often have a dark diffuse colour multiplied with the texture; with a texture we use white.
 */
function normalizeMaterials(root, { keepWrap = false } = {}) {
  const converted = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const convert = (m) => {
      if (converted.has(m)) return converted.get(m);
      // A texture that failed to load has no image data; treat it as untextured.
      const map = m.map?.image?.width ? m.map : null;
      const out = new THREE.MeshStandardMaterial({
        name: m.name || "material",
        map,
        color: map ? new THREE.Color(0xffffff) : (m.color?.clone() ?? new THREE.Color(0xcccccc)),
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
        // Baked shading from games like SM64 lives in vertex colours.
        vertexColors: !!o.geometry.attributes.color,
        transparent: m.transparent && m.opacity < 1,
        opacity: m.opacity ?? 1,
        alphaTest: m.alphaTest || (map && m.transparent ? 0.5 : 0),
      });
      // glTF extras (surface, invisible collision, render-only) arrive as userData; keep them.
      out.userData = { ...m.userData };
      // A grey texture with no alpha at all is a glow (light shafts, mist) that the game adds onto the picture.
      // Drawn normally it is a dark panel, so it is left out: hidden and without collision.
      if (map && isGlowTexture(map.image)) {
        Object.assign(out.userData, { invisible: true, renderOnly: true });
        out.visible = false;
      }
      if (out.map) {
        out.map.colorSpace = THREE.SRGBColorSpace;
        if (!keepWrap) out.map.wrapS = out.map.wrapT = THREE.RepeatWrapping;
      }
      converted.set(m, out);
      return out;
    };
    o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
  });
}
