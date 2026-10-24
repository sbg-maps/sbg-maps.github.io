// A cute stand-in golfer at the in-game player's size, for judging the scale of a level.
import * as THREE from "three";

/** Player height in metres, measured from the game's player collider. */
export const GOLFER_HEIGHT = 1.8;

const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.8 });

/** Builds a chibi golfer standing on y = 0, facing +z (three.js), `GOLFER_HEIGHT` tall. */
export function makeGolfer(shirt = 0x3fa9f5) {
  const g = new THREE.Group();
  g.name = "golfer";
  const skin = mat(0xf2c7a0);
  const pants = mat(0xf4f0e6);
  const shoes = mat(0x3a2a20);

  // Proportions on a 1.8 m figure: big head, short body, like the game's characters.
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
  // Golf club.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 6), mat(0xbbbbbb));
  shaft.position.set(0.42, 0.45, 0.12);
  shaft.rotation.z = 0.15;
  g.add(shaft);
  const clubHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.08), mat(0x666666));
  clubHead.position.set(0.49, 0.03, 0.12);
  g.add(clubHead);

  // Scale so the top of the cap is exactly GOLFER_HEIGHT.
  const box = new THREE.Box3().setFromObject(g);
  g.scale.setScalar(GOLFER_HEIGHT / box.max.y);
  g.userData.editorOnly = true;
  return g;
}
