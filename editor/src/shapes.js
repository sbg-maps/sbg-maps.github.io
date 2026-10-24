// Ready-made objects for the Objects palette: simple shapes, picture sprites and imported models.
import * as THREE from "three";

const mat = (color, surface) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, name: surface });
  m.userData.surface = surface;
  return m;
};

/** Shapes players can add. Sizes in metres; each sits on y = 0. */
export const SHAPES = {
  ball: { name: "Ball", make: () => mesh(new THREE.SphereGeometry(1.5, 32, 20), mat(0x2b2b33, "solid"), 1.5) },
  box: { name: "Box", make: () => mesh(new THREE.BoxGeometry(3, 3, 3), mat(0xf5a623, "solid"), 1.5) },
  platform: { name: "Platform", make: () => mesh(new THREE.BoxGeometry(8, 1, 8), mat(0x84ce54, "fairway"), 0.5) },
  ramp: { name: "Ramp", make: () => ramp() },
  pillar: { name: "Pillar", make: () => mesh(new THREE.CylinderGeometry(1.2, 1.2, 8, 24), mat(0xb4b4ac, "solid"), 4) },
  wall: { name: "Wall", make: () => mesh(new THREE.BoxGeometry(12, 4, 1), mat(0xc27ad6, "solid"), 2) },
};

function mesh(geometry, material, lift) {
  const m = new THREE.Mesh(geometry, material);
  m.position.y = lift;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

function ramp() {
  // Wedge 6 m wide, 10 m long, rising 3 m toward -z (map +z).
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(10, 0), new THREE.Vector2(10, 3)]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-3, 0, 5);
  return mesh(geometry, mat(0x84ce54, "fairway"), 0);
}

/** A picture as an upright plane (alpha cut out), `height` metres tall, marked to face the camera in game. */
export async function spriteFromImage(file, height = 3) {
  const url = URL.createObjectURL(file);
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Keep the pixels: the texture is exported from this canvas copy, not the blob URL.
    const canvas = document.createElement("canvas");
    canvas.width = texture.image.width;
    canvas.height = texture.image.height;
    canvas.getContext("2d").drawImage(texture.image, 0, 0);
    texture.image = canvas;
    texture.needsUpdate = true;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const material = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, name: file.name });
    material.userData.surface = "none";
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height), material);
    plane.position.y = height / 2;
    const g = new THREE.Group();
    g.add(plane);
    g.name = file.name.replace(/\.[^.]+$/, "");
    return { root: g, billboard: true };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Path helpers in the object's local space (three.js axes, metres before the object's own scale). */
export function circlePath(radius, points = 16) {
  return Array.from({ length: points }, (_, i) => {
    const a = (i / points) * Math.PI * 2;
    return [Math.cos(a) * radius, 0, Math.sin(a) * radius];
  });
}

export function linePath(length) {
  return [
    [0, 0, 0],
    [0, 0, -length],
  ];
}
