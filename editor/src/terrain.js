// Sculptable, paintable terrain for building levels from scratch. Exports as format 1 heightmap + paintmap,
// which the game turns into its own native terrain (real ground textures and grass).
import * as THREE from "three";
import { SURFACES } from "./mapfile.js";

/** Metres per height sample and per paint cell. */
export const TERRAIN_STEP = 1;
const H_MIN = 0;
const H_MAX = 120;
/** Default water level of new levels, the height land is raised to, and the sea floor. */
export const WATER = 5;
const LAND_HEIGHT = 20;
const BEACH_HEIGHT = WATER + 1.5;
const SEA_FLOOR = 1;

const tmpColor = new THREE.Color();
const tmpRay = new THREE.Ray();
const tmpMatrix = new THREE.Matrix4();
const tmpPoint = new THREE.Vector3();
const tmpBox = new THREE.Box3();
/** Ray march step for picking, in metres (well under a sample, so slopes are not skipped). */
const RAY_STEP = 0.25 * TERRAIN_STEP;

export class Terrain {
  /**
   * @param {number} sizeX metres
   * @param {number} sizeZ metres
   * @param {{heights?: Float32Array, paint?: Uint8Array}} [data]
   */
  constructor(sizeX, sizeZ, data = {}) {
    this.sizeX = sizeX;
    this.sizeZ = sizeZ;
    this.nx = Math.round(sizeX / TERRAIN_STEP) + 1;
    this.nz = Math.round(sizeZ / TERRAIN_STEP) + 1;
    this.heights = data.heights ?? new Float32Array(this.nx * this.nz);
    // One surface per cell; cells sit between samples.
    this.cx = this.nx - 1;
    this.cz = this.nz - 1;
    this.paint = data.paint ?? new Uint8Array(this.cx * this.cz);
    /** Lowest and highest height the mesh has had, for its bounds (they only grow, which is safe for culling). */
    this.yMin = Infinity;
    this.yMax = -Infinity;
    /** Heights before a brush step, only the area around the brush is copied in (see brush). */
    this.before = new Float32Array(this.heights.length);
    this.mesh = this.buildMesh();
    this.mesh.name = "terrain";
    this.mesh.userData.isTerrain = true;
    // Picking walks the height grid instead of testing every triangle (over a million on large levels).
    this.mesh.raycast = (raycaster, intersects) => this.raycast(raycaster, intersects);
  }

  /**
   * A level with a natural-looking coastline. Shapes: island, twin, archipelago, long, sea (all water).
   * Land is about 20 m high with gentle hills, beaches slope into a sea floor below the water.
   */
  static generate(shape, sizeX, sizeZ, seed = 1) {
    const t = new Terrain(sizeX, sizeZ);
    const cx = sizeX / 2;
    const cz = sizeZ / 2;
    const r = Math.min(sizeX, sizeZ) / 2;
    // Each shape is a set of blobs; land is wherever the (noisy) blob field is high enough.
    const rnd = mulberry(seed);
    const blobs = {
      island: [[cx, cz, sizeX * 0.44, sizeZ * 0.44]],
      long: [[cx, cz, sizeX * 0.3, sizeZ * 0.47]],
      twin: [
        [cx - sizeX * 0.17, cz - sizeZ * 0.2, sizeX * 0.3, sizeZ * 0.27],
        [cx + sizeX * 0.17, cz + sizeZ * 0.2, sizeX * 0.3, sizeZ * 0.27],
      ],
      // Islands on a loose grid, each nudged, so they spread over the whole level.
      archipelago: [
        [0.27, 0.25], [0.7, 0.22], [0.5, 0.5], [0.25, 0.75], [0.74, 0.74],
      ].map(([u, v]) => [sizeX * (u + (rnd() - 0.5) * 0.12), sizeZ * (v + (rnd() - 0.5) * 0.12), sizeX * (0.16 + rnd() * 0.08), sizeZ * (0.14 + rnd() * 0.08)]),
      sea: [],
    }[shape] ?? [[cx, cz, sizeX * 0.44, sizeZ * 0.44]];
    const scale = 1 / Math.max(60, r * 0.6);
    for (let j = 0; j < t.nz; j++) {
      for (let i = 0; i < t.nx; i++) {
        const x = i * TERRAIN_STEP;
        const z = j * TERRAIN_STEP;
        // Distance-based field: 1 at a blob's centre, 0 on its rim, negative (sea) outside every blob.
        let field = -1;
        for (const [bx, bz, rx, rz] of blobs) field = Math.max(field, 1 - Math.hypot((x - bx) / rx, (z - bz) / rz));
        // Wobble the coastline (open sea has none) and stay clear of the level's edge.
        field = blobs.length ? field + (noise2(x * scale, z * scale, seed) - 0.5) * 0.7 : -1;
        // Fade out well before the border so islands never end in a straight cliff.
        const border = Math.min(x, z, sizeX - x, sizeZ - z) / Math.max(60, r * 0.35) - 0.15 + (noise2(x * scale * 2 + 90, z * scale * 2 + 90, seed + 3) - 0.5) * 0.3;
        field = Math.min(field, border);
        // Sea floor, a short slope up to a narrow sandy beach just above the water, then rolling land.
        const shelf = smoothstep(-0.03, 0.015, field);
        const land = smoothstep(0.02, 0.2, field);
        const hills = (noise2(x * scale * 1.7 + 50, z * scale * 1.7 + 50, seed + 7) - 0.5) * 10 * smoothstep(0.2, 0.45, field);
        t.heights[j * t.nx + i] = SEA_FLOOR + (BEACH_HEIGHT - SEA_FLOOR) * shelf + (LAND_HEIGHT - BEACH_HEIGHT) * land + hills;
      }
    }
    t.autoBeaches();
    t.refresh();
    return t;
  }

  /**
   * Paints sand along the shore and on the sea floor. Ground that was shore or sea before (per `before` heights)
   * and is now dry land becomes rough; paint on land that was already land (bunkers, fairways) is kept.
   */
  autoBeaches(i0 = 0, j0 = 0, i1 = this.cx - 1, j1 = this.cz - 1, before = null) {
    const avg = (hs, i, j) => (hs[j * this.nx + i] + hs[j * this.nx + i + 1] + hs[(j + 1) * this.nx + i] + hs[(j + 1) * this.nx + i + 1]) / 4;
    const shore = WATER + 3;
    for (let j = Math.max(0, j0); j <= Math.min(this.cz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.cx - 1, i1); i++) {
        const k = j * this.cx + i;
        if (avg(this.heights, i, j) < shore) this.paint[k] = 3;
        else if (before && avg(before, i, j) < shore) this.paint[k] = 0;
      }
    }
  }

  /** A gently rounded island: flat in the middle, sloping into the sea at the edges. */
  static island(sizeX, sizeZ, height = 22) {
    const t = new Terrain(sizeX, sizeZ);
    const edge = Math.min(40, Math.min(sizeX, sizeZ) * 0.15);
    for (let j = 0; j < t.nz; j++) {
      for (let i = 0; i < t.nx; i++) {
        const x = i * TERRAIN_STEP;
        const z = j * TERRAIN_STEP;
        const d = Math.min(x, z, sizeX - x, sizeZ - z);
        const f = smoothstep(0, edge, d);
        t.heights[j * t.nx + i] = 4 + (height - 4) * f;
      }
    }
    for (let j = 0; j < t.cz; j++) {
      for (let i = 0; i < t.cx; i++) {
        const d = Math.min(i, j, t.cx - 1 - i, t.cz - 1 - j) * TERRAIN_STEP;
        t.paint[j * t.cx + i] = d < edge * 0.6 ? 3 : 0; // sand beach, rough inside
      }
    }
    t.refresh();
    return t;
  }

  /** Builds an editable terrain from a format 1 hole (heightmap + optional paintmap). */
  static fromHole(hole, grids) {
    const [sx, sz] = hole.size;
    const t = new Terrain(sx, sz);
    for (let j = 0; j < t.nz; j++) for (let i = 0; i < t.nx; i++) t.heights[j * t.nx + i] = grids.heightAt(i * TERRAIN_STEP, j * TERRAIN_STEP);
    for (let j = 0; j < t.cz; j++)
      for (let i = 0; i < t.cx; i++) t.paint[j * t.cx + i] = grids.surfaceAt((i + 0.5) * TERRAIN_STEP, (j + 0.5) * TERRAIN_STEP);
    t.refresh();
    return t;
  }

  buildMesh() {
    const positions = new Float32Array(this.nx * this.nz * 3);
    const colors = new Float32Array(this.nx * this.nz * 3);
    const indices = [];
    for (let j = 0; j < this.nz - 1; j++) {
      for (let i = 0; i < this.nx - 1; i++) {
        const a = j * this.nx + i;
        // Map z runs along three.js -z, so this winding faces up.
        indices.push(a, a + 1, a + this.nx, a + 1, a + this.nx + 1, a + this.nx);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nx * this.nz * 3), 3));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, contourMaterial());
    this.geometry = geometry;
    this.refreshArea(0, 0, this.nx - 1, this.nz - 1);
    return mesh;
  }

  refresh() {
    this.refreshArea(0, 0, this.nx - 1, this.nz - 1);
  }

  /**
   * Rewrites vertex positions, colours and normals for samples in [i0..i1] x [j0..j1] and uploads only those rows,
   * so a brush step costs the brush area, not the whole level.
   */
  refreshArea(i0, j0, i1, j1) {
    i0 = Math.max(0, i0);
    j0 = Math.max(0, j0);
    i1 = Math.min(this.nx - 1, i1);
    j1 = Math.min(this.nz - 1, j1);
    if (i0 > i1 || j0 > j1) return;
    const { nx, nz, heights } = this;
    const pos = this.geometry.attributes.position;
    const col = this.geometry.attributes.color;
    const nrm = this.geometry.attributes.normal;
    const h = (i, j) => heights[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const y = heights[k];
        if (y < this.yMin) this.yMin = y;
        if (y > this.yMax) this.yMax = y;
        pos.setXYZ(k, i * TERRAIN_STEP, y, -j * TERRAIN_STEP);
        // Vertex colour from the cell it is the corner of (clamped at the far edges).
        const s = this.paint[Math.min(j, this.cz - 1) * this.cx + Math.min(i, this.cx - 1)];
        const c = SURFACES[s]?.color ?? SURFACES[0].color;
        tmpColor.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
        col.setXYZ(k, tmpColor.r, tmpColor.g, tmpColor.b);
        // Normal from the height grid's slopes (map z runs along -z).
        const dx = (h(i + 1, j) - h(i - 1, j)) / ((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) * TERRAIN_STEP);
        const dz = (h(i, j + 1) - h(i, j - 1)) / ((Math.min(nz - 1, j + 1) - Math.max(0, j - 1)) * TERRAIN_STEP);
        const len = Math.hypot(dx, 1, dz);
        nrm.setXYZ(k, -dx / len, 1 / len, dz / len);
      }
    }
    // Neighbours' normals depend on these heights too, so their rows were included by the callers' 1-sample margin.
    const start = j0 * nx * 3;
    const count = (j1 - j0 + 1) * nx * 3;
    for (const attr of [pos, col, nrm]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(start, count);
      attr.needsUpdate = true;
    }
    const box = (this.geometry.boundingBox ??= new THREE.Box3());
    box.min.set(0, this.yMin, -(nz - 1) * TERRAIN_STEP);
    box.max.set((nx - 1) * TERRAIN_STEP, this.yMax, 0);
    this.geometry.boundingSphere ??= new THREE.Sphere();
    box.getBoundingSphere(this.geometry.boundingSphere);
  }

  /** Mesh.raycast replacement: marches the ray over the height grid and refines the crossing. */
  raycast(raycaster, intersects) {
    const mesh = this.mesh;
    tmpMatrix.copy(mesh.matrixWorld).invert();
    tmpRay.copy(raycaster.ray).applyMatrix4(tmpMatrix);
    // Clip the ray to the terrain's box (padded, so a flat level still has some thickness).
    const box = tmpBox.copy(this.geometry.boundingBox).expandByScalar(1);
    let t0 = 0;
    if (!box.containsPoint(tmpRay.origin)) {
      const entry = tmpRay.intersectBox(box, tmpPoint);
      if (!entry) return;
      t0 = tmpRay.origin.distanceTo(entry);
    }
    const dir = tmpRay.direction;
    // Furthest distance inside the box along the ray.
    const exitT = (a, d, lo, hi) => (d > 0 ? (hi - a) / d : d < 0 ? (lo - a) / d : Infinity);
    const t1 = Math.min(
      exitT(tmpRay.origin.x, dir.x, box.min.x, box.max.x),
      exitT(tmpRay.origin.y, dir.y, box.min.y, box.max.y),
      exitT(tmpRay.origin.z, dir.z, box.min.z, box.max.z),
    );
    const above = (t) => {
      const x = tmpRay.origin.x + dir.x * t;
      const z = tmpRay.origin.z + dir.z * t;
      return tmpRay.origin.y + dir.y * t - this.heightAt(x, -z);
    };
    let prevT = t0;
    if (above(t0) < 0) return; // starts under the ground (the camera is never there)
    for (let t = t0 + RAY_STEP; t <= t1 + RAY_STEP; t += RAY_STEP) {
      const tt = Math.min(t, t1);
      const cur = above(tt);
      if (cur <= 0) {
        let lo = prevT;
        let hi = tt;
        for (let n = 0; n < 12; n++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        const local = tmpRay.at(hi, new THREE.Vector3());
        const point = local.clone().applyMatrix4(mesh.matrixWorld);
        const distance = raycaster.ray.origin.distanceTo(point);
        if (distance < raycaster.near || distance > raycaster.far) return;
        const i = Math.min(this.cx - 1, Math.max(0, Math.floor(local.x / TERRAIN_STEP)));
        const j = Math.min(this.cz - 1, Math.max(0, Math.floor(-local.z / TERRAIN_STEP)));
        intersects.push({ distance, point, object: mesh, faceIndex: (j * this.cx + i) * 2 });
        return;
      }
      prevT = tt;
      if (tt >= t1) return;
    }
  }

  heightAt(x, z) {
    const fx = Math.min(Math.max(x / TERRAIN_STEP, 0), this.nx - 1);
    const fz = Math.min(Math.max(z / TERRAIN_STEP, 0), this.nz - 1);
    const i = Math.min(Math.floor(fx), this.nx - 2);
    const j = Math.min(Math.floor(fz), this.nz - 2);
    const tx = fx - i;
    const tz = fz - j;
    const h = (a, b) => this.heights[b * this.nx + a];
    const top = h(i, j) + (h(i + 1, j) - h(i, j)) * tx;
    const bottom = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * tx;
    return top + (bottom - top) * tz;
  }

  /** Snapshot for undo. */
  snapshot() {
    return { heights: this.heights.slice(), paint: this.paint.slice() };
  }

  restore(snap) {
    this.heights.set(snap.heights);
    this.paint.set(snap.paint);
    this.refresh();
  }

  /**
   * Applies a brush at map point (x, z).
   * @param {"land"|"sea"|"raise"|"lower"|"smooth"|"flatten"|"paint"} op
   * @param {{radius:number, strength:number, surface?:number, target?:number, dt?:number}} opts
   */
  brush(op, x, z, { radius, strength, surface = 0, target = 0, dt = 1 / 60 }) {
    const r = radius / TERRAIN_STEP;
    const ci = x / TERRAIN_STEP;
    const cj = z / TERRAIN_STEP;
    const i0 = Math.floor(ci - r);
    const i1 = Math.ceil(ci + r);
    const j0 = Math.floor(cj - r);
    const j1 = Math.ceil(cj + r);
    if (op === "paint") {
      for (let j = Math.max(0, j0); j <= Math.min(this.cz - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(this.cx - 1, i1); i++) {
          if (Math.hypot(i + 0.5 - ci, j + 0.5 - cj) <= r) this.paint[j * this.cx + i] = surface;
        }
      }
      this.refreshArea(i0 - 1, j0 - 1, i1 + 1, j1 + 1);
      return;
    }
    // Heights before this step, copied only around the brush (smooth and the beaches read one sample further out).
    let before = null;
    if (op === "smooth" || op === "land" || op === "sea") {
      before = this.before;
      const a0 = Math.max(0, i0 - 2);
      const a1 = Math.min(this.nx - 1, i1 + 2);
      for (let j = Math.max(0, j0 - 2); j <= Math.min(this.nz - 1, j1 + 2); j++) {
        before.set(this.heights.subarray(j * this.nx + a0, j * this.nx + a1 + 1), j * this.nx + a0);
      }
    }
    // strength is metres per second at the brush centre
    const amount = strength * dt;
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        const d = Math.hypot(i - ci, j - cj) / r;
        if (d > 1) continue;
        const w = 1 - smoothstep(0, 1, d);
        const k = j * this.nx + i;
        let h = this.heights[k];
        if (op === "land" && h < LAND_HEIGHT) h = Math.min(LAND_HEIGHT, h + amount * 1.5 * w);
        else if (op === "sea" && h > SEA_FLOOR) h = Math.max(SEA_FLOOR, h - amount * 1.5 * w);
        else if (op === "raise") h += amount * w;
        else if (op === "lower") h -= amount * w;
        else if (op === "flatten") h += (target - h) * Math.min(1, w * strength * dt * 0.5);
        else if (op === "smooth") {
          let sum = 0;
          let n = 0;
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              const jj = j + dj;
              if (ii >= 0 && jj >= 0 && ii < this.nx && jj < this.nz) {
                sum += before[jj * this.nx + ii];
                n++;
              }
            }
          h += (sum / n - h) * Math.min(1, w * strength * dt * 0.5);
        }
        this.heights[k] = Math.min(H_MAX, Math.max(H_MIN, h));
      }
    }
    if (op === "land" || op === "sea") this.autoBeaches(i0 - 1, j0 - 1, i1 + 1, j1 + 1, before);
    this.refreshArea(i0 - 1, j0 - 1, i1 + 1, j1 + 1);
  }

  /** Format 1 grid definitions and file contents for a hole using this terrain. */
  exportGrids(prefix) {
    const heights = new Uint16Array(this.nx * this.nz);
    for (let k = 0; k < heights.length; k++) heights[k] = Math.round(((this.heights[k] - H_MIN) / (H_MAX - H_MIN)) * 65535);
    return {
      heightmap: { file: `${prefix}.height.r16`, width: this.nx, depth: this.nz, min: H_MIN, max: H_MAX },
      paintmap: { file: `${prefix}.paint.u8`, width: this.cx, depth: this.cz },
      files: {
        [`${prefix}.height.r16`]: new Uint8Array(heights.buffer),
        [`${prefix}.paint.u8`]: this.paint.slice(),
      },
    };
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * Terrain material with height contour lines (thin every 2 m, strong every 10 m), so sculpting is easy to see.
 */
function contourMaterial() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vWorldY;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vWorldY;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float minor = abs(fract(vWorldY / 2.0 + 0.5) - 0.5) / fwidth(vWorldY / 2.0);
        float major = abs(fract(vWorldY / 10.0 + 0.5) - 0.5) / fwidth(vWorldY / 10.0);
        diffuseColor.rgb *= mix(0.82, 1.0, clamp(minor, 0.0, 1.0));
        diffuseColor.rgb *= mix(0.62, 1.0, clamp(major * 0.7, 0.0, 1.0));`,
      );
  };
  return material;
}

/** Smooth 2D value noise in [0, 1], with a few octaves. */
function noise2(x, z, seed) {
  const hash = (i, j) => {
    let h = (i * 374761393 + j * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const one = (x, z) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const fx = x - i;
    const fz = z - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fz * fz * (3 - 2 * fz);
    const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * u;
    const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * u;
    return a + (b - a) * v;
  };
  return one(x, z) * 0.55 + one(x * 2.1 + 17, z * 2.1 + 31) * 0.3 + one(x * 4.3 + 7, z * 4.3 + 11) * 0.15;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
