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
async function test(name, fn) {
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
  const obj = await page.evaluate(() => window.__sbg.project.objects[0].userData);
  assert(obj.object === "mover" && obj.path?.length >= 2 && obj.knocks, `mover setup wrong: ${JSON.stringify(obj)}`);
  await page.click("#path-line");
  // Draw two extra points.
  await page.click("#path-draw");
  await clickView(page, 0.6, 0.55);
  await clickView(page, 0.62, 0.6);
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
  await placeStartAndFlag(page);
  await page.click('.tab[data-tab="model"]');
  await page.check(".material .climb input");
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
  assert(choices.length === 2 && choices[0][0].startsWith("level.obj") && choices[0][1], `model choices: ${JSON.stringify(choices)}`);
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
  // Choose the items in the boxes: start from the game's own, then set one.
  await page.check('.items-own[data-key="items"]');
  await page.fill('.item-weight input[data-key="items"][data-item="Coffee"]', "40");
  await page.dispatchEvent('.item-weight input[data-key="items"][data-item="Coffee"]', "change");
  // Park a golf cart.
  await page.click('button[data-tool="golfCarts"]');
  await clickView(page, 0.5, 0.55);
  await page.check('.items-own[data-key="redItems"]');
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
  assert(manifest.holes[0].golfCarts?.length === 1, `golf carts: ${JSON.stringify(manifest.holes[0].golfCarts)}`);
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
