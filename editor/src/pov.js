// Picture-in-picture "player view": what a golfer standing at a spot sees, with the game's camera.
import * as THREE from "three";
import { afterRender, scene, viewport, fromMap } from "./scene.js";
import { golferCamera, makeGolfer, yawToRotation, onGolferChange } from "./golfer.js";

export class PlayerView {
  constructor(getProject) {
    this.getProject = getProject;
    this.visible = true;
    this.spot = null; // map point, or null to follow the active hole's Start
    this.yaw = null; // degrees, or null to face the flag
    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 20000);
    this.golfer = null;

    this.frame = document.createElement("div");
    this.frame.className = "pov";
    this.frame.innerHTML = `
      <div class="pov-bar">
        <span class="pov-title">Player view</span>
        <button class="pov-btn" data-act="left" title="Turn left">&lsaquo;</button>
        <button class="pov-btn" data-act="right" title="Turn right">&rsaquo;</button>
        <button class="pov-btn" data-act="start" title="Back to the Start">Start</button>
        <button class="pov-btn" data-act="hide" title="Hide">&times;</button>
      </div>`;
    this.toggle = document.createElement("button");
    this.toggle.className = "pov-show";
    this.toggle.textContent = "Player view";
    this.toggle.hidden = true;
    viewport.append(this.frame, this.toggle);

    this.frame.addEventListener("click", (e) => {
      const act = e.target.dataset?.act;
      if (act === "left") this.turn(-15);
      else if (act === "right") this.turn(15);
      else if (act === "start") {
        this.spot = null;
        this.yaw = null;
      } else if (act === "hide") this.setVisible(false);
    });
    this.toggle.addEventListener("click", () => this.setVisible(true));
    onGolferChange(() => this.rebuildGolfer());
    afterRender((r) => this.render(r));
  }

  setVisible(on) {
    this.visible = on;
    this.frame.hidden = !on;
    this.toggle.hidden = on;
  }

  setActive(on) {
    this.active = on;
    this.frame.hidden = !on || !this.visible;
    this.toggle.hidden = !on || this.visible;
    if (!on && this.golfer) this.golfer.visible = false;
  }

  /** Stand at a world point, facing the flag. */
  standAt(worldPoint) {
    this.spot = { x: worldPoint.x, y: worldPoint.y, z: -worldPoint.z };
    this.yaw = null;
    this.setVisible(true);
  }

  turn(deg) {
    this.yaw = (((this.currentYaw() + deg) % 360) + 360) % 360;
  }

  currentSpot() {
    return this.spot ?? this.getProject()?.hole?.tee ?? null;
  }

  currentYaw() {
    if (this.yaw != null) return this.yaw;
    const hole = this.getProject()?.hole;
    const spot = this.currentSpot();
    if (!spot) return 0;
    if (!this.spot && hole?.tee?.yaw != null) return hole.tee.yaw;
    if (hole?.cup) return (Math.atan2(hole.cup.x - spot.x, hole.cup.z - spot.z) * 180) / Math.PI;
    return 0;
  }

  rebuildGolfer() {
    if (this.golfer) scene.remove(this.golfer);
    this.golfer = makeGolfer(0x7ed957);
    this.golfer.visible = false;
    scene.add(this.golfer);
  }

  render(renderer) {
    const spot = this.active && this.visible ? this.currentSpot() : null;
    if (!this.golfer) this.rebuildGolfer();
    this.golfer.visible = !!spot && !!this.spot; // the Start already has its own golfer
    if (!spot) return;

    const yaw = yawToRotation(this.currentYaw());
    const base = fromMap(spot);
    const facing = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    this.golfer.position.copy(base);
    this.golfer.quaternion.copy(facing);

    const cam = golferCamera();
    this.camera.fov = cam.fov;
    this.camera.position.copy(cam.position).applyQuaternion(facing).add(base);
    this.camera.quaternion.copy(facing).multiply(cam.quaternion);

    const canvas = renderer.domElement.getBoundingClientRect();
    const rect = this.frame.getBoundingClientRect();
    const x = rect.left - canvas.left;
    const y = canvas.bottom - rect.bottom;
    this.camera.aspect = rect.width / Math.max(rect.height, 1);
    this.camera.updateProjectionMatrix();

    // Only the start golfer should show in the main view, but the player view should see its own golfer.
    const wasVisible = this.golfer.visible;
    this.golfer.visible = true;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setViewport(x, y, rect.width, rect.height);
    renderer.clear();
    renderer.render(scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvas.width, canvas.height);
    this.golfer.visible = wasVisible;
  }
}
