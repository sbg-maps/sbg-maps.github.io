// Fly view: move the camera freely like a game spectator instead of orbiting around a point.
// WASD moves, Q/E (or C/Space) go down/up, Shift or F is faster, dragging looks around, the wheel sets the speed.
// F exists because Firefox always opens its own menu on Shift + right-click, which pages cannot stop.
// Clicks still reach the tools, so markers can be placed and land shaped while flying.
import * as THREE from "three";
import { camera, controls, renderer, onFrame } from "./scene.js";

const KEYS = {
  KeyW: [0, 0, -1], ArrowUp: [0, 0, -1],
  KeyS: [0, 0, 1], ArrowDown: [0, 0, 1],
  KeyA: [-1, 0, 0], ArrowLeft: [-1, 0, 0],
  KeyD: [1, 0, 0], ArrowRight: [1, 0, 0],
  KeyE: [0, 1, 0], Space: [0, 1, 0],
  KeyQ: [0, -1, 0], KeyC: [0, -1, 0],
};
const LOOK_SPEED = 0.004; // radians per pixel
const MIN_SPEED = 2;
const MAX_SPEED = 2000;

const held = new Set();
const euler = new THREE.Euler(0, 0, 0, "YXZ");
const move = new THREE.Vector3();
let active = false;
let speed = 40; // metres per second
let look = null; // pointer being dragged to look around
let lastTime = 0;
let changeListener = () => {};

export const isFlying = () => active;
export const onFlyChange = (fn) => (changeListener = fn);
export const flySpeed = () => Math.round(speed);

/** Which mouse buttons look around: brush tools paint with the left button, so only the right one looks. */
let lookButtons = [0, 2];
export function setLookButtons(buttons) {
  lookButtons = buttons;
}
/** Return true while something else owns the drag (moving an object with the gizmo). */
let lookBlocked = () => false;
export function setLookBlocked(fn) {
  lookBlocked = fn;
}

/** Start flying from where the camera is, at a speed that suits a level of the given size (metres). */
export function setFlying(on, levelSize = 300) {
  if (on === active) return;
  active = on;
  held.clear();
  look = null;
  if (on) {
    speed = THREE.MathUtils.clamp(levelSize / 10, MIN_SPEED, MAX_SPEED);
    controls.enabled = false;
  } else {
    // Orbit around whatever is ahead, as far away as the old orbit point was.
    const dist = Math.max(10, camera.position.distanceTo(controls.target));
    controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(dist));
    controls.enabled = true;
  }
  changeListener(active);
}

const typing = (e) => ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable;

window.addEventListener("keydown", (e) => {
  if (!active || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Escape") return setFlying(false);
  if (!KEYS[e.code] && !e.code.startsWith("Shift") && e.code !== "KeyF") return;
  held.add(e.code);
  e.preventDefault();
});
window.addEventListener("keyup", (e) => held.delete(e.code));
window.addEventListener("blur", () => held.clear());

const canvas = renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
  if (!active) return;
  // The middle button always looks around (and must not start the browser's autoscroll).
  if (e.button === 1) e.preventDefault();
  if (!lookButtons.includes(e.button) && e.button !== 1) return;
  look = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
canvas.addEventListener("pointermove", (e) => {
  if (!look || e.pointerId !== look.id) return;
  if (lookBlocked()) return void (look = null);
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= (e.clientX - look.x) * LOOK_SPEED;
  euler.x = THREE.MathUtils.clamp(euler.x - (e.clientY - look.y) * LOOK_SPEED, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  euler.z = 0;
  camera.quaternion.setFromEuler(euler);
  look.x = e.clientX;
  look.y = e.clientY;
});
window.addEventListener("pointerup", (e) => {
  if (look && e.pointerId === look.id) look = null;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!active) return;
    e.preventDefault();
    speed = THREE.MathUtils.clamp(speed * (e.deltaY < 0 ? 1.2 : 1 / 1.2), MIN_SPEED, MAX_SPEED);
    changeListener(active);
  },
  { passive: false },
);
canvas.addEventListener("contextmenu", (e) => active && e.preventDefault());
canvas.addEventListener("mousedown", (e) => active && e.button === 1 && e.preventDefault());

onFrame((now) => {
  const dt = Math.min(0.1, lastTime ? (now - lastTime) / 1000 : 0);
  lastTime = now;
  if (!active || !held.size) return;
  move.set(0, 0, 0);
  for (const code of held) if (KEYS[code]) move.add(new THREE.Vector3(...KEYS[code]));
  if (!move.lengthSq()) return;
  const up = move.y;
  move.y = 0;
  // Forward and sideways follow where the camera looks; up and down stay straight up and down.
  move.applyQuaternion(camera.quaternion);
  move.y += up;
  const fast = held.has("ShiftLeft") || held.has("ShiftRight") || held.has("KeyF") ? 3 : 1;
  camera.position.addScaledVector(move.normalize(), speed * fast * dt);
});
