// Loads 3D models picked by the user (OBJ+MTL, glTF/GLB, FBX, DAE) together with their textures.
// Everything is read locally through blob URLs; nothing is uploaded.
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MTLLoader } from "three/addons/loaders/MTLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import { unzip } from "fflate";

export const MODEL_EXTENSIONS = [".obj", ".glb", ".gltf", ".fbx", ".dae"];

const ext = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();
const base = (path) => path.split(/[\\/]/).pop().toLowerCase();

/** Model files among the picked files, biggest first (a download often has the level plus smaller extras). */
export function findModels(files) {
  return [...files].filter((f) => MODEL_EXTENSIONS.includes(ext(f.name))).sort((a, b) => b.size - a.size);
}

const ARCHIVE_EXTENSIONS = [".rar", ".7z", ".tar", ".gz", ".tgz", ".xz", ".bz2"];
// Junk that zips made on a Mac or Windows carry along.
const isJunk = (path) => /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i.test(path);

/** The entries of a zip, unpacked in background workers so big zips do not freeze the page. */
export async function readZip(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  let entries;
  try {
    entries = await new Promise((resolve, reject) => unzip(data, (err, out) => (err ? reject(err) : resolve(out))));
  } catch (e) {
    const why = String(e?.message ?? e);
    if (/compression|unknown/i.test(why))
      throw new Error(`${file.name} uses a kind of zip compression browsers cannot read (Windows makes it for very big files). Extract it and import the folder, or zip it again with 7-Zip.`);
    if (/encrypt|password/i.test(why)) throw new Error(`${file.name} is password protected. Extract it and import the folder.`);
    throw new Error(`${file.name} is not a zip that can be read (${why})`);
  }
  return Object.entries(entries).filter(([name]) => !name.endsWith("/") && !isJunk(name));
}

/**
 * Unpacks every .zip among picked files ({ file, path }), zips inside zips too, keeping folder paths. A zip holding a
 * map (map.json) is unpacked the same way, so maps zipped together with their folder open as well.
 */
export async function expandArchives(entries, depth = 0) {
  const out = [];
  for (const entry of entries) {
    const e = ext(entry.file.name);
    if (ARCHIVE_EXTENSIONS.includes(e)) throw new Error(`${entry.file.name}: only .zip files can be opened here. Extract it first, or zip it as .zip.`);
    if (e !== ".zip" || depth > 3) {
      out.push(entry);
      continue;
    }
    const dir = entry.path.slice(0, -entry.file.name.length);
    const inner = (await readZip(entry.file)).map(([name, bytes]) => ({ file: new File([bytes], name.split("/").pop()), path: dir + name }));
    out.push(...(await expandArchives(inner, depth + 1)));
  }
  return out;
}

/** Replaces any .zip among the files with the files inside it (models are often shared zipped). */
export async function unpackZips(files) {
  return (await expandArchives([...files].map((file) => ({ file, path: file.name })))).map((e) => e.file);
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
        root = await loadObj(manager, files, modelFile);
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
 * Loads several models into one level: map rips often come as many parts (one file per room or area) that already
 * sit where they belong in the level's own coordinates.
 */
export async function importModels(fileList, modelFiles, name, onPart = () => {}) {
  const root = new THREE.Group();
  root.name = name;
  const missing = new Set();
  let layers = 0;
  for (let i = 0; i < modelFiles.length; i++) {
    onPart(i, modelFiles.length);
    const part = await importModel(fileList, modelFiles[i]);
    root.add(part.root);
    part.missing.forEach((m) => missing.add(m));
    layers += part.layers;
  }
  const backdrops = dropBackdrops(root);
  return { root, missing: [...missing], layers, backdrops };
}

// A part this many times bigger than the typical part is a sky dome or far-off scenery around the level.
const BACKDROP_SIZE = 15;

/**
 * Removes sky domes and distant backdrop scenery from a level in parts: they are kilometres across, would swallow the
 * level in the view and in the game (which has its own sky), and throw off its size. Returns their names.
 */
function dropBackdrops(root) {
  const parts = root.children.map((part) => ({ part, size: Math.max(...new THREE.Box3().setFromObject(part).getSize(new THREE.Vector3()).toArray()) }));
  if (parts.length < 4) return [];
  const sizes = parts.map((p) => p.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const dropped = parts.filter((p) => median > 0 && p.size > median * BACKDROP_SIZE);
  if (dropped.length === parts.length) return [];
  for (const { part } of dropped) {
    part.removeFromParent();
    part.traverse((o) => o.geometry?.dispose());
  }
  return dropped.map((p) => p.part.name);
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

async function loadObj(manager, files, modelFile) {
  const loader = new OBJLoader(manager);
  // The material files the OBJ names (mtllib), else the one with its name, else any: levels in parts each have their own.
  const text = await modelFile.text();
  const wanted = [...text.matchAll(/^mtllib\s+(.+?)\s*$/gm)].map((m) => base(m[1]));
  const mtls = files.filter((f) => ext(f.name) === ".mtl");
  const own = base(modelFile.name).replace(/\.obj$/, ".mtl");
  let picked = mtls.filter((f) => wanted.includes(base(f.name)));
  if (!picked.length) picked = mtls.filter((f) => base(f.name) === own);
  if (!picked.length) picked = mtls.slice(0, 1);
  if (picked.length) {
    const combined = URL.createObjectURL(new Blob(await Promise.all(picked.map((f) => f.text().then((t) => t + "\n")))));
    try {
      const materials = await new MTLLoader(manager).loadAsync(combined);
      materials.preload();
      loader.setMaterials(materials);
    } finally {
      URL.revokeObjectURL(combined);
    }
  }
  return loader.parse(text);
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

/**
 * True if the image has see-through parts and solid parts (leaves, petals, fences): it should be cut out, or the
 * see-through parts show as black.
 */
export function hasCutoutAlpha(image) {
  try {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    let clear = 0;
    let solid = 0;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 100) clear++;
      else if (px[i] > 200) solid++;
    }
    const n = px.length / 4;
    return clear > n * 0.02 && solid > n * 0.02;
  } catch {
    return false;
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
      // Drawn normally it is a dark panel; it is drawn added on, and nothing collides with it.
      if (map && isGlowTexture(map.image)) Object.assign(out.userData, { renderOnly: true, alphaMode: "add" });
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
