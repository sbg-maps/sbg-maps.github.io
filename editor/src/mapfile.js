// Reads SbgMaps format 1 maps (see FORMAT.md) from a .sbgmap zip or a picked folder.
import { unzipSync } from "fflate";

export const SURFACES = [
  { id: 0, name: "Rough", color: [74, 128, 52] },
  { id: 1, name: "Fairway", color: [110, 180, 70] },
  { id: 2, name: "Green", color: [140, 215, 95] },
  { id: 3, name: "Sand", color: [230, 210, 150] },
  { id: 4, name: "Dirt path", color: [160, 120, 80] },
  { id: 5, name: "Out of bounds", color: [120, 120, 120] },
];

/** Loads a map from a .sbgmap File. Returns { manifest, files } where files maps relative paths to bytes. */
export async function loadZip(file) {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const files = new Map(Object.entries(entries).filter(([name]) => !name.endsWith("/")));
  return fromFiles(files);
}

/** Loads a map from the FileList of a folder picker (webkitdirectory). */
export async function loadFolder(fileList) {
  const all = [...fileList];
  const manifestFile = all.find((f) => f.webkitRelativePath.split("/").pop() === "map.json");
  if (!manifestFile) throw new Error("No map.json in that folder");
  const root = manifestFile.webkitRelativePath.slice(0, -"map.json".length);
  const files = new Map();
  for (const f of all) {
    if (f.webkitRelativePath.startsWith(root)) files.set(f.webkitRelativePath.slice(root.length), new Uint8Array(await f.arrayBuffer()));
  }
  return fromFiles(files);
}

function fromFiles(files) {
  const raw = files.get("map.json");
  if (!raw) throw new Error("No map.json at the root of the map");
  const manifest = JSON.parse(new TextDecoder().decode(raw));
  if (manifest.format !== 1) throw new Error(`Unsupported map format ${manifest.format}`);
  return { manifest, files };
}

/** Decodes a hole's grids into typed arrays with sampling helpers in map metres. */
export function holeGrids(map, hole) {
  const hm = hole.heightmap;
  const hBytes = map.files.get(hm.file);
  if (!hBytes) throw new Error(`Missing ${hm.file}`);
  if (hBytes.byteLength !== hm.width * hm.depth * 2) throw new Error(`${hm.file} has the wrong size`);
  // Copy so the Uint16Array is aligned regardless of where the zip put the bytes.
  const heights = new Uint16Array(hBytes.slice().buffer);

  let paint = null;
  const pm = hole.paintmap;
  if (pm) {
    paint = map.files.get(pm.file);
    if (!paint) throw new Error(`Missing ${pm.file}`);
    if (paint.byteLength !== pm.width * pm.depth) throw new Error(`${pm.file} has the wrong size`);
  }

  const [sx, sz] = hole.size;
  const toHeight = (v) => hm.min + (v / 65535) * (hm.max - hm.min);

  return {
    heightAtSample: (i, j) => toHeight(heights[j * hm.width + i]),
    heightAt(x, z) {
      const fx = Math.min(Math.max(x / sx, 0), 1) * (hm.width - 1);
      const fz = Math.min(Math.max(z / sz, 0), 1) * (hm.depth - 1);
      const x0 = Math.min(Math.floor(fx), hm.width - 2);
      const z0 = Math.min(Math.floor(fz), hm.depth - 2);
      const tx = fx - x0;
      const tz = fz - z0;
      const h = (i, j) => heights[j * hm.width + i];
      const a = h(x0, z0) + (h(x0 + 1, z0) - h(x0, z0)) * tx;
      const b = h(x0, z0 + 1) + (h(x0 + 1, z0 + 1) - h(x0, z0 + 1)) * tx;
      return toHeight(a + (b - a) * tz);
    },
    surfaceAt(x, z) {
      if (!paint) return 0;
      const i = Math.min(Math.max(Math.floor((x / sx) * pm.width), 0), pm.width - 1);
      const j = Math.min(Math.max(Math.floor((z / sz) * pm.depth), 0), pm.depth - 1);
      const v = paint[j * pm.width + i];
      return v < SURFACES.length ? v : 0;
    },
  };
}
