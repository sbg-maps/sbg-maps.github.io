// Golfer used for judging scale: the player's own exported golfer (F9 in game) when loaded, otherwise a stand-in.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { put as store, get as fetchStored } from "./storage.js";

/** Player height in metres when no exported golfer is loaded. */
export const DEFAULT_GOLFER_HEIGHT = 1.8;

/** Camera relative to the golfer (glTF/three axes, golfer facing -z) when no exported golfer is loaded. */
const DEFAULT_CAMERA = { fov: 60, position: [0.8, 2.4, 5.5], lookAt: [0, 1.2, -6] };

const golfer = { model: null, height: DEFAULT_GOLFER_HEIGHT, camera: null, fromGame: false };
const listeners = new Set();
export const onGolferChange = (fn) => listeners.add(fn);
export const golferInfo = () => golfer;

async function useGolferBytes(bytes) {
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  const extras = gltf.scene.userData ?? {};
  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) o.material.side = THREE.DoubleSide;
  });
  const box = new THREE.Box3().setFromObject(model);
  golfer.model = model;
  golfer.height = extras.playerHeight > 0.3 ? extras.playerHeight : box.max.y;
  golfer.camera = extras.camera ?? null;
  golfer.fromGame = true;
  for (const fn of listeners) fn(golfer);
}

/** Is this a character saved with F9 in the game (my-character.glb, or an older golfer.glb), whatever it is called now? */
export async function isCharacterFile(file) {
  if (!/\.glb$/i.test(file.name) || file.size < 20) return false;
  const head = new DataView(await file.slice(0, 20).arrayBuffer());
  if (head.getUint32(0, true) !== 0x46546c67) return false;
  const length = head.getUint32(12, true);
  try {
    const json = JSON.parse(await file.slice(20, 20 + length).text());
    return json.scenes?.some((s) => s.extras?.sbgGolfer) || /golfer export/i.test(json.asset?.generator ?? "");
  } catch {
    return false;
  }
}

/** Loads a my-character.glb (or older golfer.glb) picked by the user and remembers it in this browser. */
export async function loadGolferFile(file) {
  const bytes = await file.arrayBuffer();
  await useGolferBytes(bytes);
  try {
    await store("golfer", bytes);
  } catch {
    // Private windows may refuse storage; the golfer still works for this session.
  }
}

/** Restores a golfer loaded in an earlier visit. */
export async function restoreGolfer() {
  try {
    const bytes = await fetchStored("golfer");
    if (bytes) await useGolferBytes(bytes);
  } catch {
    // No stored golfer, or storage unavailable.
  }
}

/** Camera pose relative to the golfer: { fov, position: Vector3, quaternion: Quaternion }. */
export function golferCamera() {
  const c = golfer.camera;
  if (c?.position && c?.rotation) {
    return { fov: c.fov ?? 60, position: new THREE.Vector3(...c.position), quaternion: new THREE.Quaternion(...c.rotation) };
  }
  const position = new THREE.Vector3(...DEFAULT_CAMERA.position);
  const m = new THREE.Matrix4().lookAt(position, new THREE.Vector3(...DEFAULT_CAMERA.lookAt), new THREE.Vector3(0, 1, 0));
  return { fov: DEFAULT_CAMERA.fov, position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m) };
}

/** A golfer standing on y = 0 and facing -z (the direction players face in the game). */
export function makeGolfer(shirt = 0x3fa9f5) {
  if (golfer.model) {
    const g = golfer.model.clone(true);
    g.userData = { editorOnly: true };
    return g;
  }
  return makeStandIn(shirt);
}

const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.8 });

/** Chibi stand-in golfer, used until the player loads their own. */
function makeStandIn(shirt) {
  const g = new THREE.Group();
  g.name = "golfer";
  const skin = mat(0xf2c7a0);
  const pants = mat(0xf4f0e6);
  const shoes = mat(0x3a2a20);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.35, 4, 8), pants);
    leg.position.set(side * 0.13, 0.3, 0);
    g.add(leg);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.3), shoes);
    shoe.position.set(side * 0.13, 0.05, 0.05);
    g.add(shoe);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.32, 4, 8), mat(shirt));
    arm.position.set(side * 0.36, 0.86, 0.05);
    arm.rotation.z = side * 0.35;
    g.add(arm);
  }
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.3, 6, 12), mat(shirt));
  body.position.y = 0.82;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 16), skin);
  head.position.y = 1.36;
  g.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.37, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xe8443a));
  cap.position.y = 1.4;
  g.add(cap);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 16, 1, false, -Math.PI / 2, Math.PI), mat(0xe8443a));
  brim.position.set(0, 1.42, 0.3);
  g.add(brim);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), mat(0x222222));
    eye.position.set(side * 0.12, 1.36, 0.33);
    g.add(eye);
  }
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), mat(0xbbbbbb));
  shaft.position.set(0.42, 0.45, 0.12);
  shaft.rotation.z = 0.15;
  g.add(shaft);
  const clubHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.08), mat(0x666666));
  clubHead.position.set(0.49, 0.03, 0.12);
  g.add(clubHead);

  const box = new THREE.Box3().setFromObject(g);
  g.scale.setScalar(DEFAULT_GOLFER_HEIGHT / box.max.y);
  // Built facing +z; turn it to face -z like the game's golfer.
  const wrap = new THREE.Group();
  wrap.rotation.y = Math.PI;
  wrap.add(g);
  const out = new THREE.Group();
  out.add(wrap);
  out.userData.editorOnly = true;
  return out;
}

/** Map yaw (degrees clockwise from +z) to the golfer's rotation around y. */
export const yawToRotation = (yawDeg) => (-yawDeg * Math.PI) / 180;
