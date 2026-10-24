// Read-only view of heightmap (format 1) holes.
import * as THREE from "three";
import { scene, frameBox, disposeObject } from "./scene.js";
import { holeGrids, SURFACES } from "./mapfile.js";

const MAX_SAMPLES_PER_SIDE = 700;
const tmpColor = new THREE.Color();

export class HeightmapView {
  constructor(map) {
    this.map = map;
    this.group = null;
  }

  dispose() {
    if (this.group) {
      scene.remove(this.group);
      disposeObject(this.group);
    }
  }

  show(index) {
    this.dispose();
    const hole = this.map.manifest.holes[index];
    const grids = holeGrids(this.map, hole);
    this.group = new THREE.Group();
    this.group.add(buildTerrain(hole, grids), buildWater(hole));
    addMarkers(this.group, hole, grids);
    scene.add(this.group);
    frameBox(new THREE.Box3().setFromObject(this.group.children[0]));
    return hole;
  }
}

function buildTerrain(hole, grids) {
  const { width, depth } = hole.heightmap;
  const [sx, sz] = hole.size;
  // Decimate very large heightmaps so the browser stays responsive.
  const step = Math.max(1, Math.ceil(Math.max(width, depth) / MAX_SAMPLES_PER_SIDE));
  const nx = Math.floor((width - 1) / step) + 1;
  const nz = Math.floor((depth - 1) / step) + 1;

  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const si = Math.min(i * step, width - 1);
      const sj = Math.min(j * step, depth - 1);
      const x = (si / (width - 1)) * sx;
      const z = (sj / (depth - 1)) * sz;
      const o = (j * nx + i) * 3;
      positions.set([x, grids.heightAtSample(si, sj), -z], o);
      // Surface colours are sRGB; vertex colours are linear.
      const c = SURFACES[grids.surfaceAt(x, z)].color;
      tmpColor.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
      colors.set([tmpColor.r, tmpColor.g, tmpColor.b], o);
    }
  }
  const indices = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      indices.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
}

function buildWater(hole) {
  const [sx, sz] = hole.size;
  const pad = 200;
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(sx + pad * 2, sz + pad * 2),
    new THREE.MeshStandardMaterial({ color: 0x4fc0e8, transparent: true, opacity: 0.85, roughness: 0.2 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(sx / 2, hole.water ?? 5, -sz / 2);
  return water;
}

function addMarkers(group, hole, grids) {
  const at = (p, lift = 0) => new THREE.Vector3(p.x, grids.heightAt(p.x, p.z) + lift, -p.z);
  const marker = (geometry, color, position) => {
    const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));
    m.position.copy(position);
    group.add(m);
  };
  marker(new THREE.CylinderGeometry(3, 3, 0.6, 24), 0xffffff, at(hole.tee, 0.3));
  marker(new THREE.CylinderGeometry(0.15, 0.15, 6, 8), 0xeeeeee, at(hole.cup, 3));
  marker(new THREE.ConeGeometry(1, 2, 3), 0xdd2222, at(hole.cup, 5.5));
  for (const b of hole.itemBoxes ?? []) marker(new THREE.BoxGeometry(2, 2, 2), 0xf5c400, at(b, 1.5));
  for (const c of hole.checkpoints ?? []) marker(new THREE.OctahedronGeometry(1.5), 0xb400dc, at(c, 2));
}
