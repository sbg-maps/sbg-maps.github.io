import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadFolder, loadZip, holeGrids, SURFACES } from "./mapfile.js";

// Map coordinates (x right, z forward, Unity-style) are shown as three.js (x, y, -z).
const MAX_SAMPLES_PER_SIDE = 700;
const tmpColor = new THREE.Color();

const viewport = document.getElementById("viewport");
const status = document.getElementById("status");
const holeSelect = document.getElementById("hole-select");
const info = document.getElementById("info");
const empty = document.getElementById("empty");

// Transparent canvas so the CSS sky gradient shows behind the course.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x6a7a4a, 1.8));
const sun = new THREE.DirectionalLight(0xfff6e0, 2.2);
sun.position.set(-200, 400, 150);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 5000);
camera.position.set(0, 300, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

let holeGroup = null;
let currentMap = null;

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

function setStatus(text, isError = false) {
  status.textContent = text;
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

async function open(loader, arg) {
  try {
    setStatus("Loading...");
    currentMap = await loader(arg);
    const { manifest } = currentMap;
    holeSelect.innerHTML = "";
    manifest.holes.forEach((h, i) => holeSelect.add(new Option(`${i + 1}. ${h.name ?? "Unnamed"} (par ${h.par})`, i)));
    holeSelect.disabled = false;
    empty.hidden = true;
    showHole(0);
    setStatus(`${manifest.name} by ${manifest.author ?? "unknown"}`);
  } catch (e) {
    console.error(e);
    setStatus(`Could not open map: ${e.message}`, true);
  }
}

document.getElementById("open-file").addEventListener("change", (e) => e.target.files[0] && open(loadZip, e.target.files[0]));
document.getElementById("open-folder").addEventListener("change", (e) => e.target.files.length && open(loadFolder, e.target.files));
holeSelect.addEventListener("change", () => showHole(Number(holeSelect.value)));

function showHole(index) {
  const hole = currentMap.manifest.holes[index];
  const grids = holeGrids(currentMap, hole);
  if (holeGroup) {
    scene.remove(holeGroup);
    holeGroup.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
  holeGroup = new THREE.Group();
  holeGroup.add(buildTerrain(hole, grids));
  holeGroup.add(buildWater(hole));
  addMarkers(holeGroup, hole, grids);
  scene.add(holeGroup);
  frame(hole, grids);
  showInfo(hole);
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
      const y = grids.heightAtSample(si, sj);
      const o = (j * nx + i) * 3;
      positions.set([x, y, -z], o);
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

function frame(hole, grids) {
  const tee = new THREE.Vector3(hole.tee.x, grids.heightAt(hole.tee.x, hole.tee.z), -hole.tee.z);
  const cup = new THREE.Vector3(hole.cup.x, grids.heightAt(hole.cup.x, hole.cup.z), -hole.cup.z);
  const mid = tee.clone().lerp(cup, 0.5);
  const length = tee.distanceTo(cup);
  const back = tee.clone().sub(cup).setY(0).normalize();
  controls.target.copy(mid);
  camera.position.copy(mid).addScaledVector(back, length * 0.9).add(new THREE.Vector3(0, length * 0.6, 0));
  camera.far = Math.max(5000, length * 10);
  camera.updateProjectionMatrix();
}

function showInfo(hole) {
  const length = Math.hypot(hole.cup.x - hole.tee.x, hole.cup.z - hole.tee.z);
  const stat = (label, value) => `<div class="stat"><span>${label}</span><span>${value}</span></div>`;
  info.innerHTML = `
    <h2>${escape(hole.name ?? "Unnamed")}</h2>
    <div class="tags">
      <span class="tag par">Par ${hole.par}</span>
      <span class="tag">${escape(hole.difficulty ?? "none")}</span>
    </div>
    <div class="stats">
      ${stat("Tee to cup", `${Math.round(length)} m`)}
      ${stat("Size", `${hole.size[0]} x ${hole.size[1]} m`)}
      ${stat("Water level", `${hole.water ?? 5} m`)}
      ${stat("Item boxes", hole.itemBoxes?.length ?? 0)}
      ${stat("Checkpoints", hole.checkpoints?.length ?? 0)}
    </div>
    <h3>Surfaces</h3>
    <div class="legend">${SURFACES.map((s) => `<div><i style="background:rgb(${s.color})"></i>${s.name}</div>`).join("")}</div>`;
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
