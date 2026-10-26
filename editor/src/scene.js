// Shared three.js scene, camera and picking.
// Map coordinates (x right, z forward, Unity-style) are shown as three.js (x, y, -z).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";

export const viewport = document.getElementById("viewport");

// Transparent canvas so the CSS sky gradient shows behind the course.
export const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x6a7a4a, 1.8));
const sun = new THREE.DirectionalLight(0xfff6e0, 2.2);
sun.position.set(-200, 400, 150);
scene.add(sun);

export const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 20000);
camera.position.set(0, 300, 300);
export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

const frameCallbacks = new Set();
export const onFrame = (fn) => frameCallbacks.add(fn);
const afterRenderCallbacks = new Set();
/** Extra render passes after the main view (e.g. the picture-in-picture player view). */
export const afterRender = (fn) => afterRenderCallbacks.add(fn);

export function frame(t) {
  // Disabled while flying (it would turn the camera back to its orbit point).
  if (controls.enabled) controls.update();
  for (const fn of frameCallbacks) fn(t);
  renderer.render(scene, camera);
  for (const fn of afterRenderCallbacks) fn(renderer);
}
renderer.setAnimationLoop(frame);

export const toMap = (v) => ({ x: v.x, y: v.y, z: -v.z });
export const fromMap = (p, y = p.y ?? 0) => new THREE.Vector3(p.x, y, -p.z);

// Big meshes get a bounding volume tree the first time a ray tests them, so picking on levels with millions of
// triangles takes a fraction of a millisecond instead of tens. Built "indirect" so the geometry itself (its triangle
// order and material groups) is left untouched; rebuilt if the geometry is edited in place.
const BVH_FROM_TRIANGLES = 2000;
const bvhStamps = new WeakMap(); // not in userData: that would be exported into the map
THREE.Mesh.prototype.raycast = function (raycaster, intersects) {
  const g = this.geometry;
  const triangles = (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
  if (triangles >= BVH_FROM_TRIANGLES && !this.isSkinnedMesh) {
    const stamp = `${g.attributes.position.version}|${g.index?.version ?? -1}|${g.index?.count ?? 0}`;
    if (!g.boundsTree || bvhStamps.get(g) !== stamp) {
      g.boundsTree = new MeshBVH(g, { indirect: true });
      bvhStamps.set(g, stamp);
    }
  }
  return acceleratedRaycast.call(this, raycaster, intersects);
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

/** The material a raycast hit landed on (meshes can have several, split into groups). */
export function hitMaterial(hit) {
  const mats = Array.isArray(hit.object.material) ? hit.object.material : [hit.object.material];
  const group = hit.object.geometry.groups?.find((g) => hit.faceIndex * 3 >= g.start && hit.faceIndex * 3 < g.start + g.count);
  return mats[group?.materialIndex ?? 0];
}

/** First hit of a pointer event against the given objects (recursive) that is actually visible, or null. */
export function pick(event, objects, accept = () => true) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(objects, true).find((h) => isShown(h.object) && hitMaterial(h)?.visible !== false && accept(h)) ?? null;
}

/** The ray from the camera through the pointer. */
export function pointerRay(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.ray.clone();
}

/** Hit at the centre of the view (for placing new things where the user is looking). */
export function pickCenter(objects) {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  return raycaster.intersectObjects(objects, true).find((h) => isShown(h.object) && hitMaterial(h)?.visible !== false) ?? null;
}

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Point the camera at a box from a pleasant 3/4 angle. */
export function frameBox(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(size * 0.15, size * 0.55, size * 0.7));
  camera.lookAt(center);
  camera.far = Math.max(20000, size * 10);
  camera.updateProjectionMatrix();
}

export function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
