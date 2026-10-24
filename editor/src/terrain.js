// Sculptable, paintable terrain for building levels from scratch. Exports as format 1 heightmap + paintmap,
// which the game turns into its own native terrain (real ground textures and grass).
import * as THREE from "three";
import { SURFACES } from "./mapfile.js";

/** Metres per height sample and per paint cell. */
export const TERRAIN_STEP = 1;
const H_MIN = 0;
const H_MAX = 120;

const tmpColor = new THREE.Color();

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
    this.mesh = this.buildMesh();
    this.mesh.name = "terrain";
    this.mesh.userData.isTerrain = true;
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
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
    this.geometry = geometry;
    this.refreshArea(0, 0, this.nx - 1, this.nz - 1);
    return mesh;
  }

  refresh() {
    this.refreshArea(0, 0, this.nx - 1, this.nz - 1);
  }

  /** Rewrites vertex positions and colours for samples in [i0..i1] x [j0..j1]. */
  refreshArea(i0, j0, i1, j1) {
    const pos = this.geometry.attributes.position;
    const col = this.geometry.attributes.color;
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        const k = j * this.nx + i;
        pos.setXYZ(k, i * TERRAIN_STEP, this.heights[k], -j * TERRAIN_STEP);
        // Vertex colour from the cell it is the corner of (clamped at the far edges).
        const s = this.paint[Math.min(j, this.cz - 1) * this.cx + Math.min(i, this.cx - 1)];
        const c = SURFACES[s]?.color ?? SURFACES[0].color;
        tmpColor.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
        col.setXYZ(k, tmpColor.r, tmpColor.g, tmpColor.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
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
   * @param {"raise"|"lower"|"smooth"|"flatten"|"paint"} op
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
    const before = op === "smooth" ? this.heights.slice() : null;
    // strength is metres per second at the brush centre
    const amount = strength * dt;
    for (let j = Math.max(0, j0); j <= Math.min(this.nz - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.nx - 1, i1); i++) {
        const d = Math.hypot(i - ci, j - cj) / r;
        if (d > 1) continue;
        const w = 1 - smoothstep(0, 1, d);
        const k = j * this.nx + i;
        let h = this.heights[k];
        if (op === "raise") h += amount * w;
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

function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
