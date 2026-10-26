// End-to-end tests: drives the built editor in headless Chromium through the main workflows and checks
// the exported files. Run with `npm test` (builds first). Optional local assets (ripped levels, the decomp
// conversion) are used when present and skipped otherwise; they are never committed.
import { chromium } from "playwright";
import { createServer } from "vite";
import { unzipSync, strFromU8 } from "fflate";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { deflateSync as zlibSync } from "zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sbg-editor-test-"));
const OPTIONAL = {
  objFolder: path.join(repo, "imports/bob-omb/source-unzipped"),
  sm64Glb: path.join(repo, "imports/sm64/bob.glb"),
};

let failures = 0;
const results = [];
// `node tests/e2e.mjs <text>` runs only the tests whose name contains the text.
const only = process.argv[2]?.toLowerCase();
async function test(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return;
  const started = Date.now();
  try {
    await fn();
    results.push(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}: ${e.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------- fixtures ----------

/** A tiny textured OBJ (a ground quad and a box) with MTL and a PNG, written to a temp folder. */
function makeObjFixture() {
  const dir = path.join(tmp, "obj");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "level.obj"),
    ["mtllib level.mtl", "v -50 0 -50", "v 50 0 -50", "v 50 0 50", "v -50 0 50", "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", "usemtl grass", "f 1/1 2/2 3/3", "f 1/1 3/3 4/4"].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "level.mtl"), "newmtl grass\nKd 0.2 0.2 0.2\nmap_Kd grass.png\n");
  fs.writeFileSync(path.join(dir, "grass.png"), png(8, 8, [60, 180, 60, 255]));
  return dir;
}

/**
 * A tiny rigged model as .glb: a 1 x 2 m strip on two bones (the top bone bends), with two animations, "Wave" and
 * "Idle". Written by hand like the PNG above.
 */
function makeSkinnedGlb(sceneExtras = null) {
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  const parts = [
    f32([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0, -0.5, 2, 0, 0.5, 2, 0]), // positions
    Buffer.from(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])), // joints
    f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), // weights
    Buffer.from(new Uint16Array([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4]).buffer), // indices
    f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]), // inverse binds
    f32([0, 1, 2]), // key times
    f32([0, 0, 0, 1, 0, 0, 0.3827, 0.9239, 0, 0, 0, 1]), // Idle: bend 45 degrees and back
    f32([0, 0, 0, 1, 0.3827, 0, 0, 0.9239, 0, 0, 0, 1]), // Wave
  ];
  let offset = 0;
  const views = parts.map((b) => {
    const v = { buffer: 0, byteOffset: offset, byteLength: b.length };
    offset += b.length;
    return v;
  });
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0], ...(sceneExtras ? { extras: sceneExtras } : {}) }],
    nodes: [
      { name: "Rig", children: [1, 3] },
      { name: "Hip", children: [2] },
      { name: "Top", translation: [0, 1, 0] },
      { name: "Body", mesh: 0, skin: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 4 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: "VEC3", min: [-0.5, 0, 0], max: [0.5, 2, 0] },
      { bufferView: 1, componentType: 5121, count: 6, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: 6, type: "VEC4" },
      { bufferView: 3, componentType: 5123, count: 12, type: "SCALAR" },
      { bufferView: 4, componentType: 5126, count: 2, type: "MAT4" },
      { bufferView: 5, componentType: 5126, count: 3, type: "SCALAR", min: [0], max: [2] },
      { bufferView: 6, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: 7, componentType: 5126, count: 3, type: "VEC4" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: offset }],
    animations: [
      { name: "Wave", samplers: [{ input: 5, output: 7 }], channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }] },
      { name: "Idle", samplers: [{ input: 5, output: 6 }], channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }] },
    ],
  };
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const bin = pad(Buffer.concat(parts), 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const chunk = (data, type) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([header, chunk(jsonChunk, 0x4e4f534a), chunk(bin, 0x004e4942)]);
}

/** Solid-colour PNG, written by hand to keep the tests dependency-free. */
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(rgba).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlibSync(raw);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}


function readSbgmap(file) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(file)));
  const manifest = JSON.parse(strFromU8(files["map.json"]));
  let gltf = null;
  if (files["level.glb"]) {
    const glb = files["level.glb"];
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLen = dv.getUint32(12, true);
    gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  }
  return { files, manifest, gltf };
}

// ---------- page helpers ----------

async function freshPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("favicon") && page.errors.push(m.text()));
  await page.goto(url);
  return page;
}

async function canvasBox(page) {
  return (await page.$("#viewport canvas")).boundingBox();
}

async function clickView(page, fx, fy) {
  const b = await canvasBox(page);
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
}

/** Drags across the view; `hold` is how long (ms) to stay at each point (brushes work per second, not per frame). */
async function dragView(page, path, hold = 80) {
  const b = await canvasBox(page);
  await page.mouse.move(b.x + b.width * path[0][0], b.y + b.height * path[0][1]);
  await page.mouse.down();
  for (const [fx, fy] of path.slice(1)) {
    await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 8 });
    await page.waitForTimeout(hold);
  }
  await page.mouse.up();
}

async function exportMap(page, name) {
  await page.click('.tab[data-tab="export"]');
  const problems = await page.$$eval(".problems li", (l) => l.map((x) => x.textContent));
  assert(problems.length === 0, `export blocked: ${problems.join(" / ")}`);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click("#export")]);
  const file = path.join(tmp, name);
  await download.saveAs(file);
  return file;
}

async function placeStartAndFlag(page) {
  await page.click('button[data-tool="tee"]');
  await clickView(page, 0.42, 0.62);
  await page.click('button[data-tool="cup"]');
  await clickView(page, 0.55, 0.45);
  const h = await page.evaluate(() => window.__sbg.project.hole);
  assert(h.tee && h.cup, "Start and Flag were not placed");
}

// ---------- tests ----------

const server = await createServer({ root: path.resolve(here, ".."), server: { port: 4720, strictPort: true }, logLevel: "error" });
await server.listen();
const url = "http://localhost:4720/";
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

await test("page loads without errors", async () => {
  const page = await freshPage(browser, url);
  await page.waitForTimeout(500);
  assert((await page.textContent(".empty h2")) === "Tee it up!", "empty state missing");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("mod page offers the mod version in plugin/Plugin.cs", async () => {
  const plugin = fs.readFileSync(path.resolve(here, "../../plugin/Plugin.cs"), "utf8");
  const version = plugin.match(/Version = "([^"]+)"/)[1];
  const page = await freshPage(browser, url + "mod/");
  await page.waitForSelector(".version h3");
  const href = await page.getAttribute("#download", "href");
  assert(href.endsWith(`/mod-${version}/SbgMaps-${version}.zip`), `download points at ${href}, mod is ${version}`);
  assert((await page.textContent(".version h3")).startsWith(version), "newest change entry is not the mod version");
  // An older download in this browser: the editor's mod button shows the new version with a New badge.
  await page.evaluate(() => localStorage.setItem("sbg.modDownloaded", "0.0.1"));
  await page.goto(url);
  await page.waitForSelector("#mod-link .mod-new:not([hidden])", { timeout: 15000 });
  assert((await page.textContent("#mod-version")) === version, "editor mod button shows the wrong version");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

let terrainMap;
await test("new level: sculpt, paint, undo/redo, objects, paths, export", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-shape="twin"]');
  await page.click('[data-size="320x320"] small'); // clicking the inner text must work too
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  const size = await page.evaluate(() => window.__sbg.project.size);
  assert(size[0] === 320 && size[1] === 320, `wrong level size ${size}`);
  await page.click('button[data-tool="raise"]');
  const t = () => page.evaluate(() => Array.from(window.__sbg.project.terrain.heights).reduce((a, b) => a + b, 0));
  const before = await t();
  await dragView(page, [[0.45, 0.5], [0.5, 0.52], [0.55, 0.5]]);
  const raised = await t();
  assert(raised > before + 1, `raise brush did nothing (${before} -> ${raised})`);
  await page.keyboard.press("Control+z");
  const undone = await t();
  assert(Math.abs(undone - before) < 1e-3, `undo did not restore terrain (${before} vs ${undone})`);
  await page.keyboard.press("Control+Shift+z");
  assert(Math.abs((await t()) - raised) < 1e-3, "redo did not reapply the stroke");

  // Paint fairway, then green.
  await page.click('.swatch[data-surface="2"]');
  await dragView(page, [[0.5, 0.45], [0.52, 0.45]]);
  const greens = await page.evaluate(() => window.__sbg.project.terrain.paint.filter((v) => v === 2).length);
  assert(greens > 10, `paint brush painted ${greens} green cells`);

  await placeStartAndFlag(page);

  // Objects: a moving box with a circle path that knocks players over, and a picture.
  await page.click('.tab[data-tab="objects"]');
  await page.click('.add-shape[data-shape="box"]');
  await page.selectOption("#obj-kind", "mover");
  await page.check("#obj-knocks");
  // Even size: the largest side follows the box (3 m box to 6 m), proportions kept.
  await page.fill("#obj-size", "6");
  await page.dispatchEvent("#obj-size", "change");
  const sized = await page.evaluate(() => {
    const o = window.__sbg.project.objects[0];
    const s = new window.__sbg.THREE.Box3().setFromObject(o).getSize(new window.__sbg.THREE.Vector3());
    return [s.x, s.y, s.z].map((v) => Math.round(v * 10) / 10);
  });
  assert(sized.every((v) => v === 6), `box sized to ${sized}`);
  // Turn to face map east (90 degrees): its front (-z in three.js, map north) now points along +x.
  await page.fill('.slider-num[data-for="obj-yaw"]', "90");
  await page.dispatchEvent('.slider-num[data-for="obj-yaw"]', "change");
  const facing = await page.evaluate(() => {
    const o = window.__sbg.project.objects[0];
    const f = new window.__sbg.THREE.Vector3(0, 0, -1).applyQuaternion(o.getWorldQuaternion(new window.__sbg.THREE.Quaternion()));
    return [f.x, f.z].map((v) => Math.round(v * 100) / 100);
  });
  assert(facing[0] === 1 && facing[1] === 0, `turned to 90 but faces ${facing}`);
  assert((await page.inputValue('.slider-num[data-for="obj-yaw"]')) === "90", "turn box does not show 90");
  // Duplicate (button, then Ctrl+D on the copy), undo takes the last copy away.
  await page.click("#obj-duplicate");
  await page.keyboard.press("Control+d");
  const copies = () => page.evaluate(() => window.__sbg.project.objects.length);
  assert((await copies()) === 3, `duplicates: ${await copies()} objects`);
  const same = await page.evaluate(() => window.__sbg.project.objects.every((o) => o.userData.object === "mover" && o.userData.knocks));
  assert(same, "copies lost their settings");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  assert((await copies()) === 1, "undo did not take the copies away");
  await page.click(".object .mat-name");
  const obj = await page.evaluate(() => window.__sbg.project.objects[0].userData);
  assert(obj.object === "mover" && obj.path?.length >= 2 && obj.knocks, `mover setup wrong: ${JSON.stringify(obj)}`);
  await page.click("#path-line");
  // Draw two extra points.
  await page.click("#path-draw");
  // The islands are random, so a spot can be sea: try spots until two points land (waiting, as slow machines draw few frames).
  const points = () => page.evaluate(() => window.__sbg.project.objects[0].userData.path.length);
  const spots = [[0.6, 0.55], [0.62, 0.6], [0.4, 0.55], [0.45, 0.62], [0.55, 0.45], [0.42, 0.45], [0.5, 0.66], [0.58, 0.66]];
  for (let added = 0; added < 2 && spots.length; ) {
    const before = await points();
    const [x, y] = spots.shift();
    await clickView(page, x, y);
    await page.waitForFunction((n) => window.__sbg.project.objects[0].userData.path.length > n, before, { timeout: 3000 }).catch(() => {});
    if ((await points()) > before) added++;
  }
  await page.keyboard.press("Escape");
  const pts = await page.evaluate(() => window.__sbg.project.objects[0].userData.path.length);
  assert(pts === 4, `expected 4 path points, got ${pts}`);
  const pic = path.join(tmp, "star.png");
  fs.writeFileSync(pic, png(16, 16, [255, 210, 0, 255]));
  await page.setInputFiles("#add-sprite", pic);
  await page.waitForFunction(() => window.__sbg.project.objects.length === 2, null, { timeout: 15000 }).catch(() => {});
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === 2, "picture was not added");

  // Undo removes the picture again, redo brings it back.
  await page.keyboard.press("Control+z");
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === 1, "undo did not remove the picture");
  await page.keyboard.press("Control+Shift+z");
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === 2, "redo did not restore the picture");

  // A jump pad with its own launch settings.
  await page.click('.add-shape[data-shape="jumppad"]');
  await page.fill("#obj-jump-speed", "30");
  await page.dispatchEvent("#obj-jump-speed", "change");
  // Right-click (no drag) erases what is under the pointer; undo brings it back.
  const objectsBefore = await page.evaluate(() => window.__sbg.project.objects.length);
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === objectsBefore - 1, "right-click did not erase the object");
  await page.keyboard.press("Control+z");
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === objectsBefore, "undo did not bring the erased object back");

  terrainMap = await exportMap(page, "terrain.sbgmap");
  const { manifest, files, gltf } = readSbgmap(terrainMap);
  const hole = manifest.holes[0];
  assert(hole.heightmap && files[hole.heightmap.file], "terrain heightmap missing from export");
  assert(files[hole.heightmap.file].length === hole.heightmap.width * hole.heightmap.depth * 2, "heightmap size mismatch");
  assert(files[hole.paintmap.file].length === hole.paintmap.width * hole.paintmap.depth, "paintmap size mismatch");
  assert(gltf, "objects should export a level.glb");
  const nodes = gltf.nodes.filter((n) => n.extras?.object);
  const mover = nodes.find((n) => n.extras.object === "mover");
  assert(mover && mover.extras.knocks === true && mover.extras.path.length === 4, `mover node wrong: ${JSON.stringify(mover?.extras)}`);
  assert(nodes.some((n) => n.extras.billboard === true), "picture lost its face-the-camera flag");
  const pad = nodes.find((n) => n.extras.object === "jumppad");
  assert(pad && pad.extras.launchSpeed === 30 && pad.extras.launchPitch === 35, `jump pad node wrong: ${JSON.stringify(pad?.extras)}`);
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("open sea: Land brush makes land with beaches; New shape is undoable", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-shape="sea"]');
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  const landCells = () => page.evaluate(() => Array.from(window.__sbg.project.terrain.heights).filter((h) => h > 8).length);
  assert((await landCells()) === 0, "open sea should start without land");
  assert((await page.evaluate(() => document.querySelector(".tool.active")?.dataset.tool)) === "land", "Land brush should be picked for open sea");
  for (let k = 0; k < 3; k++) await dragView(page, [[0.4, 0.5], [0.5, 0.5], [0.6, 0.5]], 600);
  const land = await landCells();
  assert(land > 50, `Land brush made ${land} land samples`);
  const sand = await page.evaluate(() => window.__sbg.project.terrain.paint.filter((v) => v === 3).length);
  assert(sand > 0, "no beaches were painted");
  await page.click('.tab[data-tab="terrain"]');
  await page.selectOption("#shape-kind", "archipelago");
  await page.click("#reshape");
  const reshaped = await landCells();
  assert(reshaped !== land, "New shape did not change the terrain");
  await page.keyboard.press("Control+z");
  assert((await landCells()) === land, "undo did not bring back the hand-made land");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("autosave and continue where you left off", async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const page = await context.newPage();
  await page.goto(url);
  await page.click("#new-level-btn");
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  await page.click('.tab[data-tab="objects"]');
  await page.click('.add-shape[data-shape="pillar"]');
  await page.evaluate(() => window.__sbg.autosave());
  await page.waitForTimeout(500);
  const again = await context.newPage();
  await again.goto(url);
  await again.waitForSelector("#restore", { timeout: 10000 });
  await again.click("#restore");
  await again.waitForFunction(() => window.__sbg.project?.objects.length === 1, null, { timeout: 20000 }).catch(() => {});
  const s = await again.evaluate(() => ({ terrain: !!window.__sbg.project?.terrain, objects: window.__sbg.project?.objects.length }));
  assert(s.terrain && s.objects === 1, `restore failed: ${JSON.stringify(s)}`);
  await context.close();
});

await test("reopen the exported terrain level", async () => {
  const page = await freshPage(browser, url);
  assert(terrainMap, "no exported terrain map to reopen (the previous test failed)");
  await page.setInputFiles("#open-file", terrainMap);
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 }).catch(() => {});
  const state = await page.evaluate(() => {
    const p = window.__sbg.project;
    return { terrain: !!p.terrain, objects: p.objects.length, tee: !!p.hole.tee, cup: !!p.hole.cup, mover: p.objects.find((o) => o.userData.object === "mover")?.userData };
  });
  assert(state.terrain && state.objects === 3 && state.tee && state.cup, `reopened state wrong: ${JSON.stringify(state)}`);
  assert(state.mover.knocks && state.mover.path.length === 4, "mover settings lost on reopen");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("out of bounds zone: added from Objects, not ground for markers, exported as a zone", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  await page.click('.tab[data-tab="objects"]');
  await page.click('.add-shape[data-shape="outofbounds"]');
  await page.waitForFunction(() => window.__sbg.project.objects.some((o) => o.userData.object === "outofbounds"), null, { timeout: 5000 }).catch(() => {});
  const s = await page.evaluate(async () => {
    const p = window.__sbg.project;
    const zone = p.objects.find((o) => o.userData.object === "outofbounds");
    if (!zone) return null;
    const at = zone.getWorldPosition(new window.__sbg.THREE.Vector3());
    // The ground under the zone is the terrain, not the zone's top.
    const ground = p.groundUnder({ x: at.x, z: at.z });
    return { kind: document.querySelector("#obj-kind")?.value, zoneBottom: at.y, ground };
  });
  assert(s, "no out of bounds zone added");
  assert(s.kind === "outofbounds", `selected behaviour: ${s.kind}`);
  assert(Math.abs(s.ground - s.zoneBottom) < 1, `ground under the zone read as ${s.ground}, zone stands at ${s.zoneBottom}`);
  await placeStartAndFlag(page);
  const map = await exportMap(page, "zone");
  const glb = unzipSync(new Uint8Array(fs.readFileSync(map)))["level.glb"];
  const json = JSON.parse(strFromU8(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset + 12, 4).getUint32(0, true))));
  assert(json.nodes.some((n) => n.extras?.object === "outofbounds"), "exported level has no out of bounds node");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("animated model: plays the idle, other animation or none, exported with its bones, reopened playing", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  await page.click('.tab[data-tab="objects"]');
  await page.setInputFiles("#add-prop", { name: "waver.glb", mimeType: "model/gltf-binary", buffer: makeSkinnedGlb() });
  await page.waitForSelector("#obj-animation", { timeout: 10000 });
  assert((await page.inputValue("#obj-animation")) === "Idle", `default animation: ${await page.inputValue("#obj-animation")}`);
  // The top bone bends in the view (Idle turns it around z).
  const bend = () =>
    page.evaluate(() => {
      let top;
      window.__sbg.project.objects[0].traverse((n) => n.isBone && n.name === "Top" && (top = n));
      return top ? Math.abs(top.quaternion.z) : -1;
    });
  await page.waitForFunction(() => {
    let top;
    window.__sbg.project.objects[0].traverse((n) => n.isBone && n.name === "Top" && (top = n));
    return top && Math.abs(top.quaternion.z) > 0.05;
  }, null, { timeout: 5000 });
  await placeStartAndFlag(page);
  const level = (file) => {
    const glb = unzipSync(new Uint8Array(fs.readFileSync(file)))["level.glb"];
    return JSON.parse(strFromU8(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset + 12, 4).getUint32(0, true))));
  };
  const file = await exportMap(page, "animated.sbgmap");
  const json = level(file);
  const node = json.nodes.find((n) => n.extras?.object);
  assert(json.skins?.length === 1, `exported skins: ${json.skins?.length}`);
  assert(json.animations?.length === 1 && json.animations[0].name === node.extras.clip && node.extras.animation === "Idle", `exported clip: ${JSON.stringify(json.animations?.map((a) => a.name))} node ${JSON.stringify(node.extras)}`);
  // None: back in its own pose, exported still.
  await page.click('.tab[data-tab="objects"]');
  await page.selectOption("#obj-animation", "");
  assert((await bend()) < 0.001, "None left the model bent");
  const still = level(await exportMap(page, "still.sbgmap"));
  assert(!still.animations?.length && !still.skins?.length, "None still exported an animation");
  await page.click('.tab[data-tab="objects"]');
  await page.selectOption("#obj-animation", "Wave");
  const waving = await exportMap(page, "waving.sbgmap");
  await page.close();
  const again = await freshPage(browser, url);
  await again.setInputFiles("#open-file", waving);
  await again.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  await again.waitForFunction(() => {
    let top;
    window.__sbg.project.objects[0]?.traverse((n) => n.isBone && n.name === "Top" && (top = n));
    return top && Math.abs(top.quaternion.x) > 0.05;
  }, null, { timeout: 5000 });
  const o = await again.evaluate(() => ({ clips: window.__sbg.project.objects[0].animations.map((c) => c.name), chosen: window.__sbg.project.objects[0].userData.animation }));
  assert(o.chosen === "Wave" && o.clips.join() === "Wave", `reopened: ${JSON.stringify(o)}`);
  assert(again.errors.length === 0, again.errors.join("; "));
  await again.close();
});

await test("map file size: one copy of each picture, JPEG when not see-through, shared corners", async () => {
  const dir = path.join(tmp, "dupes");
  fs.mkdirSync(dir, { recursive: true });
  // Two materials loading the same picture (each gets its own copy, as model loaders do), on a 2 x 2 grid of quads.
  const v = [];
  for (let z = 0; z <= 2; z++) for (let x = 0; x <= 2; x++) v.push(`v ${x * 50 - 50} 0 ${z * 50 - 50}`);
  const quad = (i) => [i + 1, i + 2, i + 5, i + 4];
  const faces = (q) => [`f ${q[0]}/1 ${q[1]}/2 ${q[2]}/3`, `f ${q[0]}/1 ${q[2]}/3 ${q[3]}/4`];
  fs.writeFileSync(path.join(dir, "level.obj"), ["mtllib level.mtl", ...v, "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", "usemtl a", ...faces(quad(0)), ...faces(quad(1)), "usemtl b", ...faces(quad(3)), ...faces(quad(4))].join("\n"));
  fs.writeFileSync(path.join(dir, "level.mtl"), "newmtl a\nmap_Kd grass.png\nnewmtl b\nmap_Kd grass.png\n");
  fs.writeFileSync(path.join(dir, "grass.png"), png(8, 8, [60, 180, 60, 255]));
  const page = await freshPage(browser, url);
  await page.setInputFiles("#import-files", fs.readdirSync(dir).map((f) => path.join(dir, f)));
  await page.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  const own = await page.evaluate(() => new Set(window.__sbg.project.materials.map((m) => m.original.map?.image)).size);
  assert(own === 2, `fixture should load the picture twice, got ${own}`);
  await placeStartAndFlag(page);
  const { gltf } = readSbgmap(await exportMap(page, "dupes.sbgmap"));
  assert(gltf.images.length === 1 && gltf.images[0].mimeType === "image/jpeg", `images: ${JSON.stringify(gltf.images.map((i) => i.mimeType))}`);
  // Each quad's corners have their own texture positions: 16 corners, not 24 (and both materials share them).
  const accessors = new Set(gltf.meshes.flatMap((m) => m.primitives.map((p) => p.attributes.POSITION)));
  const corners = [...accessors].reduce((n, i) => n + gltf.accessors[i].count, 0);
  assert(corners === 16, `8 triangles stored with ${corners} corners`);
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("a level stored z-up with .tga textures stands up, textured", async () => {
  const dir = path.join(tmp, "zup");
  fs.mkdirSync(dir, { recursive: true });
  // A 100 x 80 floor in the x-y plane facing +z, with one 10 m wall: how Source maps come out.
  fs.writeFileSync(
    path.join(dir, "map.obj"),
    ["mtllib map.mtl", "v 0 0 0", "v 100 0 0", "v 100 80 0", "v 0 80 0", "v 0 0 0", "v 100 0 0", "v 100 0 10", "v 0 0 10", "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1",
      "usemtl sand", "f 1/1 2/2 3/3", "f 1/1 3/3 4/4", "f 5/1 7/3 6/2", "f 5/1 8/4 7/3"].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "map.mtl"), "newmtl sand\nKd 1 1 1\nmap_Kd sand.tga\n");
  // Uncompressed 2 x 2 true-colour Targa.
  const tga = Buffer.alloc(18 + 2 * 2 * 3, 0xc0);
  tga.fill(0, 0, 18);
  tga[2] = 2;
  tga.writeUInt16LE(2, 12);
  tga.writeUInt16LE(2, 14);
  tga[16] = 24;
  fs.writeFileSync(path.join(dir, "sand.tga"), tga);
  const page = await freshPage(browser, url);
  await page.setInputFiles("#import-files", fs.readdirSync(dir).map((f) => path.join(dir, f)));
  await page.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  const s = await page.evaluate(() => {
    const p = window.__sbg.project;
    const size = p.box.getSize(new window.__sbg.THREE.Vector3());
    return { tilt: p.tilt, height: size.y / Math.max(size.x, size.z), textured: p.materials.filter((m) => m.material.map?.image).length };
  });
  assert(s.tilt === 3 && s.height < 0.2, `not stood up: ${JSON.stringify(s)}`);
  assert(s.textured === 1, `tga texture not loaded: ${JSON.stringify(s)}`);
  assert((await page.textContent("#status")).includes("lying on its side"), "no word about standing it up");
  // Tip over 90 degrees turns it on.
  await page.click('.tab[data-tab="model"]');
  await page.click("#tilt");
  assert((await page.evaluate(() => window.__sbg.project.tilt)) === 0, "Tip over did not go round");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("a character saved in the game loads as your character, not as a level, whatever its name", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  const before = await page.evaluate(() => window.__sbg.project.root.uuid);
  await page.setInputFiles("#import-files", { name: "renamed.glb", mimeType: "model/gltf-binary", buffer: makeSkinnedGlb({ sbgGolfer: 1, playerHeight: 1.6 }) });
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Loaded your character"), null, { timeout: 10000 });
  const after = await page.evaluate(() => window.__sbg.project.root.uuid);
  assert(before === after, "the level was replaced");
  // Any other model dropped onto the open level asks first; "Add as an object" keeps the level.
  const drop = (name, bytes) =>
    page.evaluate(
      ([name, bytes]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(bytes)], name));
        window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [name, [...bytes]],
    );
  await drop("waver.glb", makeSkinnedGlb());
  await page.waitForSelector("#drop-model:not([hidden])", { timeout: 10000 });
  await page.click('#drop-model [data-act="object"]');
  await page.waitForFunction(() => window.__sbg.project.objects.length === 1, null, { timeout: 10000 });
  assert((await page.evaluate(() => window.__sbg.project.root.uuid)) === before, "Add as an object replaced the level");
  await drop("waver.glb", makeSkinnedGlb());
  await page.waitForSelector("#drop-model:not([hidden])", { timeout: 10000 });
  await page.click('#drop-model [data-act="level"]');
  await page.waitForFunction((before) => window.__sbg.project.root.uuid !== before, before, { timeout: 10000 });
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("zips: a map zipped with its folder, a zipped .sbgmap, zips in zips, other archives explained", async () => {
  assert(terrainMap, "no exported terrain map (an earlier test failed)");
  const { zipSync } = await import("fflate");
  const map = unzipSync(new Uint8Array(fs.readFileSync(terrainMap)));
  const write = (name, files) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, zipSync(files));
    return file;
  };
  const opened = async (file, input) => {
    const page = await freshPage(browser, url);
    await page.setInputFiles(input, file);
    await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 }).catch(() => {});
    const ok = await page.evaluate(() => !!window.__sbg.project?.terrain && !!window.__sbg.project.hole.tee);
    const status = await page.textContent("#status");
    if (ok) assert(page.errors.length === 0, page.errors.join("; "));
    await page.close();
    return ok || status;
  };
  // A map folder zipped up (map.json one level down), through either button, with Mac junk alongside.
  const folder = write("folder-map.zip", { ...Object.fromEntries(Object.entries(map).map(([k, v]) => [`My map/${k}`, v])), "__MACOSX/My map/._map.json": new Uint8Array(4) });
  assert((await opened(folder, "#open-file")) === true, "zipped map folder did not open with Open map");
  assert((await opened(folder, "#import-files")) === true, "zipped map folder did not open with Import model");
  // A .sbgmap shared inside a zip, and that zip inside another zip.
  const shared = write("shared.zip", { "maps/cool.sbgmap": new Uint8Array(fs.readFileSync(terrainMap)) });
  assert((await opened(shared, "#open-file")) === true, "a .sbgmap inside a zip did not open");
  const nested = write("nested.zip", { "download/shared.zip": new Uint8Array(fs.readFileSync(shared)) });
  assert((await opened(nested, "#open-file")) === true, "a zip inside a zip did not open");
  // Other archive kinds get a clear message.
  const rar = path.join(tmp, "level.rar");
  fs.writeFileSync(rar, "Rar!");
  const said = await opened(rar, "#import-files");
  assert(typeof said === "string" && said.includes("only .zip"), `rar message: ${said}`);
});

await test("a level in parts: many OBJ files in one zip import together", async () => {
  const enc = (text) => new TextEncoder().encode(text);
  const { zipSync } = await import("fflate");
  const files = {};
  // Four rooms side by side, each its own OBJ with its own MTL and texture, in shared level coordinates.
  for (let i = 0; i < 4; i++) {
    const x = i * 20;
    files[`Asylum/m${i}.obj`] = enc([`mtllib m${i}.mtl`, "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", `usemtl room${i}`,
      `v ${x} 0 0`, `v ${x + 20} 0 0`, `v ${x + 20} 0 20`, `v ${x} 0 20`, "f 1/1 3/3 2/2", "f 1/1 4/4 3/3"].join("\n"));
    files[`Asylum/m${i}.mtl`] = enc(`newmtl room${i}\nmap_Kd room${i}.png\n`);
    files[`Asylum/room${i}.png`] = new Uint8Array(png(8, 8, [40 * i, 120, 60, 255]));
  }
  // A sky dome around it all, like map rips often have: left out.
  files["Asylum/sky.obj"] = enc(["v -3000 -500 -3000", "v 3000 -500 -3000", "v 0 2000 3000", "f 1 2 3"].join("\n"));
  const zip = path.join(tmp, "parts.zip");
  fs.writeFileSync(zip, zipSync(files));
  const page = await freshPage(browser, url);
  await page.setInputFiles("#import-files", zip);
  await page.waitForSelector("#pick-model:not([hidden])", { timeout: 20000 });
  assert(await page.$eval("#pick-model .choice.active", (b) => b.dataset.i === "all"), "All together is not the default for a level in parts");
  await page.click('#pick-model [data-act="import"]');
  await page.waitForFunction(() => window.__sbg.project, null, { timeout: 30000 });
  const s = await page.evaluate(() => {
    const p = window.__sbg.project;
    const size = p.box.getSize(new window.__sbg.THREE.Vector3());
    return { name: p.root.name, parts: p.root.children.length, materials: p.materials.length, textured: p.materials.filter((m) => m.material.map).length, ratio: size.x / size.z };
  });
  assert(s.name === "Asylum" && s.parts === 4 && s.materials === 4 && s.textured === 4, `parts import wrong: ${JSON.stringify(s)}`);
  assert(Math.abs(s.ratio - 4) < 0.1, `parts not side by side (width/depth ${s.ratio})`);
  const status = await page.textContent("#status");
  assert(status.includes("4 parts") && status.includes("left out 1 sky"), `status: ${status}`);
  // Remove part: click one room away, undo brings it back.
  await page.click('button.tool[data-tool="part"]');
  const parts = () => page.evaluate(() => window.__sbg.project.root.children.filter((c) => !c.userData.object).length);
  for (const [x, y] of [[0.5, 0.55], [0.45, 0.5], [0.55, 0.5], [0.5, 0.45]]) {
    await clickView(page, x, y);
    if ((await parts()) < 4) break;
  }
  assert((await parts()) === 3, `Remove part left ${await parts()} parts`);
  // Removed for real: its mesh and texture leave the exported level.
  const exported = await page.evaluate(async () => {
    const glb = new Uint8Array(await window.__sbg.project.exportGlb());
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true))));
    return { meshes: json.meshes.length, images: json.images?.length ?? 0 };
  });
  assert(exported.meshes === 3 && exported.images === 3, `export after removing a part: ${JSON.stringify(exported)}`);
  await page.keyboard.press("Control+z");
  assert((await parts()) === 4, "undo did not bring the part back");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("import an OBJ with MTL and texture, export, reopen", async () => {
  const dir = fs.existsSync(OPTIONAL.objFolder) ? OPTIONAL.objFolder : makeObjFixture();
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith(".txt")).map((f) => path.join(dir, f));
  const page = await freshPage(browser, url);
  await page.setInputFiles("#import-files", files);
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Imported"), null, { timeout: 30000 }).catch(() => {});
  const status = await page.textContent("#status");
  assert(status.startsWith("Imported") && !status.includes("missing"), `import status: ${status}`);
  const textured = await page.evaluate(() => window.__sbg.project.materials.filter((m) => m.material.map).length);
  assert(textured > 0, "no textures loaded");
  // Autosave reuses the level export until something in the level changes.
  const sig0 = await page.evaluate(() => window.__sbg.project.levelSignature());
  await placeStartAndFlag(page);
  assert((await page.evaluate(() => window.__sbg.project.levelSignature())) === sig0, "placing markers changed the level signature");
  await page.click('.tab[data-tab="model"]');
  await page.check(".material .climb input");
  await page.waitForFunction((sig) => window.__sbg.project.levelSignature() !== sig, sig0, { timeout: 5000 }).catch(() => {});
  assert((await page.evaluate(() => window.__sbg.project.levelSignature())) !== sig0, "a material change kept the old level export");
  await page.waitForFunction(() => window.__sbg.project.materials.some((m) => m.material.userData.climbable), null, { timeout: 5000 });
  // Transparency settings of the selected material.
  await page.click(".material .thumb");
  await page.waitForSelector(".mat-look", { timeout: 5000 }).catch(async () => {
    throw new Error(`no material settings after selecting; panel: ${(await page.textContent("#info")).slice(0, 300)}`);
  });
  await page.click('.alpha-modes [data-mode="cutout"]');
  await page.$eval(".alpha-cutoff", (r) => {
    r.value = "30";
    r.dispatchEvent(new Event("input"));
  });
  await page.uncheck(".mat-look .two-sided");
  const file = await exportMap(page, "obj.sbgmap");
  const { gltf } = readSbgmap(file);
  const cut = gltf.materials.find((m) => m.alphaMode === "MASK");
  assert(cut && Math.abs(cut.alphaCutoff - 0.3) < 0.01 && !cut.doubleSided, `cut-out settings lost on export: ${JSON.stringify(gltf.materials)}`);
  assert(gltf.images?.length > 0, "textures missing from export");
  assert(gltf.materials.some((m) => m.extras?.climbable), "Climb box lost on export");
  await page.close();
  const again = await freshPage(browser, url);
  await again.setInputFiles("#open-file", file);
  await again.waitForFunction(() => window.__sbg.project?.hole.cup, null, { timeout: 20000 }).catch(() => {});
  assert(await again.evaluate(() => !!window.__sbg.project?.hole.cup), "reopened OBJ map lost its flag");
  assert(again.errors.length === 0, again.errors.join("; "));
  await again.close();
});

await test("zipped game rip: pick the model, drop stacked layers, glow panels add light", async () => {
  // Like a GameCube/Wii rip: the ground plus a stacked shadow copy of it, a glow panel (grey, no alpha), and a smaller extra model.
  const quad = (y, first) => [`v -50 ${y} -50`, `v 50 ${y} -50`, `v 50 ${y} 50`, `v -50 ${y} 50`, `f ${first}/1 ${first + 1}/2 ${first + 2}/3`, `f ${first}/1 ${first + 2}/3 ${first + 3}/4`];
  const big = ["mtllib rip.mtl", "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", "o ground", "usemtl grass", ...quad(0, 1), "o ground_uv2", "usemtl shadow", ...quad(0, 5),
    "o shaft", "usemtl glow", "v 0 0 0", "v 5 0 0", "v 5 30 0", "v 0 30 0", "f 9/1 10/2 11/3", "f 9/1 11/3 12/4",
    // A floating island over the ground, separate from it.
    "o island", "usemtl grass", "v 10 20 10", "v 20 20 10", "v 20 20 20", "v 10 20 20", "f 13/1 15/3 14/2", "f 13/1 16/4 15/3"].join("\n");
  const enc = (text) => new TextEncoder().encode(text);
  const { zipSync } = await import("fflate");
  const zip = path.join(tmp, "rip.zip");
  fs.writeFileSync(zip, zipSync({
    "Level/level.obj": enc(big),
    "Level/extra.obj": enc(["v 0 0 0", "v 1 0 0", "v 0 0 1", "f 1 2 3"].join("\n")),
    "Level/rip.mtl": enc("newmtl grass\nmap_Kd grass.png\nnewmtl shadow\nmap_Kd kage.png\nnewmtl glow\nmap_Kd light.png\n"),
    "Level/grass.png": new Uint8Array(png(8, 8, [60, 180, 60, 255])),
    "Level/kage.png": new Uint8Array(png(8, 8, [120, 120, 120, 255])),
    "Level/light.png": new Uint8Array(png(8, 8, [70, 70, 70, 0])),
  }));
  const page = await freshPage(browser, url);
  await page.setInputFiles("#open-file", zip); // a zipped model given to Open map works too
  await page.waitForSelector("#pick-model:not([hidden])", { timeout: 20000 });
  const choices = await page.$$eval("#pick-model .choice", (b) => b.map((x) => [x.textContent, x.classList.contains("active")]));
  // Two models: the biggest is picked (not "All together", which is for levels in many parts).
  assert(choices.length === 3 && choices[0][0].startsWith("All 2 together") && !choices[0][1] && choices[1][0].startsWith("level.obj") && choices[1][1], `model choices: ${JSON.stringify(choices)}`);
  await page.click('#pick-model [data-act="import"]');
  await page.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  const s = await page.evaluate(() => {
    const p = window.__sbg.project;
    const meshes = [];
    p.root.traverse((o) => o.isMesh && meshes.push(o.name));
    return { meshes, status: document.querySelector("#status").textContent, glow: p.materials.find((m) => m.material.name === "glow")?.material.userData, collision: p.hasCollisionMesh };
  });
  assert(!s.meshes.includes("ground_uv2") && s.meshes.includes("ground"), `stacked layer not removed: ${s.meshes}`);
  assert(s.status.includes("left out 1"), `status: ${s.status}`);
  assert(s.glow?.alphaMode === "add" && s.glow?.renderOnly, `glow panel not drawn as a glow: ${JSON.stringify(s.glow)}`);
  assert(!s.collision, "glow panel mistaken for a collision mesh");
  // Cut piece: the island comes out as its own object, the ground stays; undo puts it back.
  const cut = await page.evaluate(() => {
    const { project: p, THREE, history } = window.__sbg;
    p.root.updateMatrixWorld(true);
    const islandMesh = p.root.getObjectByName("island");
    const centre = new THREE.Box3().setFromObject(islandMesh).getCenter(new THREE.Vector3());
    const hit = new THREE.Raycaster(centre.clone().setY(centre.y + 50), new THREE.Vector3(0, -1, 0)).intersectObject(islandMesh, true)[0];
    const piece = p.findPiece(hit);
    if (!piece) return { error: "no piece" };
    const before = p.objects.length;
    history.record(() => p.cutPiece(piece), { meshes: [...piece.take.keys()] });
    const after = p.objects.length;
    history.undo();
    return { taken: piece.taken, before, after, undone: p.objects.length, islandTris: islandMesh.geometry.attributes.position.count / 3 };
  });
  // Cut area: an outline around the island takes just it, even from one solid mesh.
  const area = await page.evaluate(() => {
    const { project: p, THREE } = window.__sbg;
    const box = new THREE.Box3().setFromObject(p.root.getObjectByName("island"));
    const m = 1;
    const outline = [
      { x: box.min.x - m, z: -box.max.z - m },
      { x: box.max.x + m, z: -box.max.z - m },
      { x: box.max.x + m, z: -box.min.z + m },
      { x: box.min.x - m, z: -box.min.z + m },
    ];
    return p.findArea(outline)?.taken ?? 0;
  });
  assert(area === 2, `cut area took ${area} triangles, expected the island's 2`);
  // A selected piece goes with the Delete key, and comes back with undo.
  const piecesBefore = await page.evaluate(() => window.__sbg.project.objects.length);
  await page.evaluate(() => {
    const { project: p, history, THREE } = window.__sbg;
    const islandMesh = p.root.getObjectByName("island");
    const centre = new THREE.Box3().setFromObject(islandMesh).getCenter(new THREE.Vector3());
    const hit = new THREE.Raycaster(centre.clone().setY(centre.y + 50), new THREE.Vector3(0, -1, 0)).intersectObject(islandMesh, true)[0];
    const piece = p.findPiece(hit);
    history.record(() => p.cutPiece(piece), { meshes: [...piece.take.keys()] });
  });
  await page.click('.tab[data-tab="objects"]');
  await page.click(".object:last-child .mat-name");
  await page.keyboard.press("Delete");
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === piecesBefore, "Delete did not remove the selected piece");
  await page.keyboard.press("Control+z");
  assert((await page.evaluate(() => window.__sbg.project.objects.length)) === piecesBefore + 1, "undo did not bring the deleted piece back");
  assert(cut.taken === 2 && cut.after === cut.before + 1 && cut.undone === cut.before && cut.islandTris === 2, `cut piece: ${JSON.stringify(cut)}`);
  // Shift+click picks several materials; a change to one applies to all of them.
  await page.click('.tab[data-tab="model"]');
  const rows = await page.$$(".material .thumb");
  assert(rows.length >= 2, `expected 2+ material rows, got ${rows.length}`);
  await rows[0].click();
  await (await page.$$(".material .thumb"))[1].click({ modifiers: ["Shift"] });
  assert((await page.$$(".material.selected")).length === 2, "shift+click did not select a second material");
  await page.click('.alpha-modes [data-mode="cutout"]');
  const modes = await page.evaluate(() => window.__sbg.project.materials.slice(0, 2).map((m) => m.material.userData.alphaMode));
  assert(modes.every((m) => m === "cutout"), `change did not apply to both: ${modes}`);
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

if (fs.existsSync(OPTIONAL.sm64Glb)) {
  await test("SM64 decomp level keeps collision mesh, objects and wrap modes", async () => {
    const page = await freshPage(browser, url);
    await page.setInputFiles("#import-files", OPTIONAL.sm64Glb);
    await page.waitForFunction(() => window.__sbg.project?.objects.length > 0, null, { timeout: 30000 }).catch(() => {});
    const s = await page.evaluate(() => {
      const p = window.__sbg.project;
      return { collision: p.hasCollisionMesh, objects: p.objects.map((o) => o.userData.object) };
    });
    assert(s.collision, "collision mesh not detected");
    for (const kind of ["mover", "chomp", "roller", "seesaw"]) assert(s.objects.includes(kind), `no ${kind} object`);
    await placeStartAndFlag(page);
    const { gltf } = readSbgmap(await exportMap(page, "sm64.sbgmap"));
    assert(gltf.samplers?.some((x) => x.wrapS === 33071), "clamped textures lost on export");
    assert(gltf.materials.some((m) => m.extras?.invisible), "invisible collision lost on export");
    assert(gltf.materials.some((m) => m.extras?.climbable), "climbable floors lost on export");
    await page.close();
  });
} else results.push("  skip SM64 decomp level (imports/sm64/bob.glb not present)");

await test("music, volume, play area and hole picture: add, export, reopen", async () => {
  // A quarter second of silence as a WAV file.
  const rate = 8000, samples = 2000, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  const song = path.join(tmp, "Main Theme.wav");
  fs.writeFileSync(song, wav);
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  await placeStartAndFlag(page);
  await page.click('.tab[data-tab="holes"]');
  await page.click("#fit-bounds");
  // Choose the items in the boxes (Objects tab, with the box tools): start from the game's own, then set one.
  await page.click('.tab[data-tab="objects"]');
  await page.check('.items-own[data-key="items"]');
  await page.$eval('.item-weight input[data-key="items"][data-item="Coffee"]', (el) => {
    el.value = "40";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Park a golf cart.
  await page.click('.place-tool[data-tool="golfCarts"]');
  await dragView(page, [[0.5, 0.55], [0.6, 0.55]], 20);
  await page.check('.items-own[data-key="redItems"]');
  // Right-click erases a red box standing on the level, but never the level under it.
  await page.click('.place-tool[data-tool="redItemBoxes"]');
  await clickView(page, 0.45, 0.5);
  const reds = () => page.evaluate(() => window.__sbg.project.hole.redItemBoxes?.length ?? 0);
  await page.waitForFunction(() => window.__sbg.project.hole.redItemBoxes?.length === 1, null, { timeout: 5000 }).catch(() => {});
  assert((await reds()) === 1, "red box not placed from the Objects tab");
  await page.click('button.tool[data-tool="look"]');
  const b = await canvasBox(page);
  await page.mouse.click(b.x + b.width * 0.45, b.y + b.height * 0.5, { button: "right" });
  await page.waitForFunction(() => (window.__sbg.project.hole.redItemBoxes?.length ?? 0) === 0, null, { timeout: 5000 }).catch(() => {});
  assert((await reds()) === 0, "right-click did not erase the red box");
  await page.click('.tab[data-tab="holes"]');
  // A vanilla hole's sky, then a picture of our own on top.
  await page.selectOption("#sky", "Mirage");
  const skyPng = path.join(tmp, "my sky.png");
  fs.writeFileSync(skyPng, png(64, 32, [90, 140, 220, 255]));
  await page.setInputFiles("#sky-file", skyPng);
  await page.waitForSelector("#sky-clear", { timeout: 10000 });
  await page.click('.tab[data-tab="export"]');
  await page.setInputFiles("#song-file", song);
  await page.waitForSelector(".song", { timeout: 10000 });
  await page.$eval(".song-vol", (r) => {
    r.value = "60";
    r.dispatchEvent(new Event("input"));
    r.dispatchEvent(new Event("change"));
  });
  const file = await exportMap(page, "music.sbgmap");
  const { manifest, files } = readSbgmap(file);
  assert(manifest.music === "music/Main_Theme.wav", `map song: ${manifest.music}`);
  assert(files["music/Main_Theme.wav"]?.length === wav.length, "song file missing from the map");
  assert(manifest.holes[0].golfCarts?.length === 1 && typeof manifest.holes[0].golfCarts[0].yaw === "number", `golf carts: ${JSON.stringify(manifest.holes[0].golfCarts)}`);
  assert(manifest.holes[0].sky === "Mirage" && manifest.holes[0].skyImage === "sky/my_sky.png" && files["sky/my_sky.png"]?.length > 50, `sky: ${manifest.holes[0].sky} ${manifest.holes[0].skyImage}`);
  assert(manifest.holes[0].items?.Coffee === 40 && manifest.holes[0].items?.SpringBoots === 20, `box items: ${JSON.stringify(manifest.holes[0].items)}`);
  assert(manifest.holes[0].redItems?.SpringBoots === 50 && manifest.holes[0].redItems?.RocketDriver === 50, `red box items: ${JSON.stringify(manifest.holes[0].redItems)}`);
  assert(manifest.songs?.["music/Main_Theme.wav"]?.volume === 0.6, `song volume: ${JSON.stringify(manifest.songs)}`);
  const picture = files[manifest.holes[0].preview ?? ""];
  assert(picture?.length > 2000 && picture[0] === 0xff && picture[1] === 0xd8, `hole picture: ${manifest.holes[0].preview} ${picture?.length}`);
  fs.writeFileSync(path.join(tmp, "preview.jpg"), picture);
  assert(manifest.holes[0].bounds?.length >= 3 && manifest.holes[0].bounds.every((p) => p.length === 2), `play area: ${JSON.stringify(manifest.holes[0].bounds)}`);
  await page.close();
  const again = await freshPage(browser, url);
  await again.setInputFiles("#open-file", file);
  await again.waitForFunction(() => window.__sbg.project?.music, null, { timeout: 20000 }).catch(() => {});
  assert(await again.evaluate(() => window.__sbg.project?.music === "music/Main_Theme.wav"), "reopened map lost its song");
  assert(await again.evaluate(() => window.__sbg.project?.hole.bounds?.length >= 3), "reopened map lost its play area");
  assert(await again.evaluate(() => window.__sbg.project?.songVolumes.get("music/Main_Theme.wav") === 0.6), "reopened map lost its song volume");
  assert(again.errors.length === 0, again.errors.join("; "));
  await again.close();
});

await test("what's new: first visit quiet, returning visit shows changes", async () => {
  const page = await freshPage(browser, url);
  await page.waitForTimeout(300);
  assert((await page.$(".whats-new")) === null, "card shown on a first visit");
  await page.evaluate(() => localStorage.setItem("sbg-maps-seen-changes", "0"));
  await page.reload();
  await page.waitForSelector(".whats-new", { timeout: 5000 });
  await page.click("#whats-new-ok");
  assert((await page.$(".whats-new")) === null, "card did not close");
  await page.reload();
  await page.waitForTimeout(300);
  assert((await page.$(".whats-new")) === null, "card shown again after Got it");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("heightmap map: view, then edit a hole as a level", async () => {
  const sampleDir = path.join(tmp, "sample");
  const { execFileSync } = await import("child_process");
  execFileSync("python3", ["-I", path.join(repo, "tools/make_sample_map.py"), sampleDir]);
  const zip = path.join(tmp, "sample.sbgmap");
  const { zipSync } = await import("fflate");
  fs.writeFileSync(zip, zipSync(Object.fromEntries(fs.readdirSync(sampleDir).map((f) => [f, new Uint8Array(fs.readFileSync(path.join(sampleDir, f)))]))));
  const page = await freshPage(browser, url);
  await page.setInputFiles("#open-file", zip);
  await page.waitForSelector("#edit-hole", { timeout: 20000 });
  await page.click("#edit-hole");
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 }).catch(() => {});
  const s = await page.evaluate(() => ({ terrain: !!window.__sbg.project?.terrain, cup: window.__sbg.project?.hole.cup }));
  assert(s.terrain && s.cup && typeof s.cup.y === "number", `edit hole failed: ${JSON.stringify(s)}`);
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("player view resizes from its corner", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-size="320x320"]');
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  const before = await (await page.$(".pov")).boundingBox();
  const h = await (await page.$(".pov-resize")).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x - 150, h.y - 20, { steps: 6 });
  await page.mouse.up();
  const after = await (await page.$(".pov")).boundingBox();
  assert(after.width > before.width + 100 && Math.abs(after.x + after.width - (before.x + before.width)) < 2, `resize: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("close: back to the start screen, autosave offered", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-size="320x320"]');
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  await page.click('button[data-tool="raise"]');
  await dragView(page, [[0.45, 0.5], [0.55, 0.5]]);
  page.once("dialog", (d) => d.accept());
  await page.click("#close-btn");
  await page.waitForFunction(() => !window.__sbg.project && !document.querySelector("#empty").hidden, null, { timeout: 10000 });
  await page.waitForSelector("#restore", { timeout: 10000 });
  assert(await page.isHidden("#close-btn"), "close button still shown");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await test("scale survives export and reopening", async () => {
  const dir = makeObjFixture();
  const page = await freshPage(browser, url);
  await page.setInputFiles("#import-files", fs.readdirSync(dir).map((f) => path.join(dir, f)));
  await page.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  await page.click('.tab[data-tab="model"]');
  // The slider is logarithmic: halfway between 1 and 100 is 10.
  await page.$eval("#scale-range", (el) => {
    el.value = "1";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert((await page.inputValue("#scale")) === "10", `scale slider at 10^1 shows ${await page.inputValue("#scale")}`);
  await page.fill("#scale", "0,5");
  await page.dispatchEvent("#scale", "change");
  assert((await page.evaluate(() => window.__sbg.project.realScale)) === 0.5, "a decimal comma did not set scale 0.5");
  await page.fill("#scale", "2.5");
  await page.dispatchEvent("#scale", "change");
  await placeStartAndFlag(page);
  const size = await page.evaluate(() => window.__sbg.project.size);
  const file = await exportMap(page, "scaled.sbgmap");
  await page.close();
  const again = await freshPage(browser, url);
  await again.setInputFiles("#open-file", file);
  await again.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  await again.click('.tab[data-tab="model"]');
  assert((await again.inputValue("#scale")) === "2.5", `reopened scale shows ${await again.inputValue("#scale")}`);
  const reopened = await again.evaluate(() => window.__sbg.project.size);
  assert(Math.abs(reopened[0] - size[0]) <= 1 && Math.abs(reopened[1] - size[1]) <= 1, `size changed on reopen: ${size} vs ${reopened}`);
  // Setting 5 doubles it (5 against the original), not 5 times the reopened size.
  await again.fill("#scale", "5");
  await again.dispatchEvent("#scale", "change");
  const doubled = await again.evaluate(() => window.__sbg.project.size);
  assert(Math.abs(doubled[0] - 40 - (size[0] - 40) * 2) <= 2, `scale 5 after 2.5: ${size} -> ${doubled}`);
  assert(again.errors.length === 0, again.errors.join("; "));
  await again.close();
});

await test("big level: each hole gets the piece around it, and reopening puts it back", async () => {
  const dir = makeObjFixture();
  const page = await freshPage(browser, url);
  await page.setInputFiles("#import-files", fs.readdirSync(dir).map((f) => path.join(dir, f)));
  await page.waitForFunction(() => window.__sbg.project, null, { timeout: 20000 });
  // Blow the 100 m quad up to 3 km: too big for one hole area.
  const tee = await page.evaluate(() => {
    const p = window.__sbg.project;
    p.scale = 30;
    p.applyTransform();
    const h = p.hole;
    h.tee = { x: 300, y: p.box.max.y, z: 300 };
    h.cup = { x: 500, y: p.box.max.y, z: 450 };
    p.rebuildMarkers();
    return h.tee;
  });
  await page.click('.tab[data-tab="export"]');
  assert(await page.isChecked("#trim"), "trim not forced for a level bigger than one hole area");
  const file = await exportMap(page, "big.sbgmap");
  const { manifest, files } = readSbgmap(file);
  const hole = manifest.holes[0];
  assert(!manifest.model && hole.model?.file === "hole1.glb" && files["hole1.glb"], `per-hole model missing: ${JSON.stringify({ model: manifest.model, hole: hole.model })}`);
  assert(hole.size[0] <= 900 && hole.size[1] <= 900 && Array.isArray(hole.origin), `hole area: ${JSON.stringify(hole.size)} origin ${hole.origin}`);
  assert(Math.abs(hole.tee.x + hole.origin[0] - tee.x) < 0.01 && Math.abs(hole.tee.z + hole.origin[1] - tee.z) < 0.01, "points not moved into the hole's area");
  assert(files["hole1.glb"].length < 200000, `piece too big: ${files["hole1.glb"].length}`);
  await page.close();
  const again = await freshPage(browser, url);
  await again.setInputFiles("#open-file", file);
  await again.waitForFunction(() => window.__sbg.project?.hole.tee, null, { timeout: 20000 });
  const back = await again.evaluate(() => window.__sbg.project.hole.tee);
  assert(Math.abs(back.x - tee.x) < 0.01 && Math.abs(back.z - tee.z) < 0.01, `reopened tee moved: ${JSON.stringify(back)} vs ${JSON.stringify(tee)}`);
  assert(again.errors.length === 0, again.errors.join("; "));
  await again.close();
});

await test("fly view: move, look, place while flying, stop", async () => {
  const page = await freshPage(browser, url);
  await page.click("#new-level-btn");
  await page.click('[data-size="320x320"]');
  await page.click('[data-act="create"]');
  await page.waitForFunction(() => window.__sbg.project?.terrain, null, { timeout: 20000 });
  const cam = () => page.evaluate(() => { const c = window.__sbg.camera; return { p: c.position.toArray(), q: c.quaternion.toArray(), orbit: window.__sbg.controls.enabled }; });
  await page.click("#fly-btn");
  assert(!(await page.isHidden("#fly-hint")), "fly hint not shown");
  const start = await cam();
  assert(!start.orbit, "orbit still on while flying");
  // Hold each key until the camera has moved (CI machines draw few frames per second).
  const hold = async (key, moved, arg) => {
    await page.keyboard.down(key);
    await page.waitForFunction(moved, arg, { timeout: 10000 }).catch(() => {});
    await page.keyboard.up(key);
  };
  await hold("w", ([x, y, z]) => window.__sbg.camera.position.distanceTo(new window.__sbg.THREE.Vector3(x, y, z)) > 10, start.p);
  const moved = await cam();
  const dir = await page.evaluate(() => window.__sbg.camera.getWorldDirection(new window.__sbg.THREE.Vector3()).toArray());
  const along = moved.p.reduce((a, v, i) => a + (v - start.p[i]) * dir[i], 0);
  assert(along > 5, `W did not fly forward (${along.toFixed(2)} m)`);
  await hold("e", (y) => window.__sbg.camera.position.y > y + 5, moved.p[1]);
  assert((await cam()).p[1] > moved.p[1] + 2, "E did not fly up");
  await page.click('button[data-tool="look"]');
  await dragView(page, [[0.5, 0.5], [0.6, 0.5]], 20);
  const turned = await cam();
  assert(turned.q.some((v, i) => Math.abs(v - moved.q[i]) > 0.01), "dragging did not look around");
  await page.click('button[data-tool="tee"]');
  await clickView(page, 0.5, 0.6);
  assert(await page.evaluate(() => !!window.__sbg.project.hole.tee), "could not place the Start while flying");
  await page.screenshot({ path: path.join(tmp, "fly.png") });
  await page.keyboard.press("Escape");
  const after = await cam();
  assert(after.orbit && (await page.isHidden("#fly-hint")), "Esc did not stop flying");
  await page.waitForTimeout(200);
  const settled = await cam();
  assert(settled.p.every((v, i) => Math.abs(v - after.p[i]) < 0.5), "camera jumped when flying stopped");
  assert(page.errors.length === 0, page.errors.join("; "));
  await page.close();
});

await browser.close();
await server.close();
console.log(results.join("\n"));
console.log(`screenshots in ${tmp}`);
console.log(failures ? `\n${failures} test(s) failed` : "\nall tests passed");
process.exit(failures ? 1 : 0);
