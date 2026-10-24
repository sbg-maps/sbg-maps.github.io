# Super Battle Golf custom maps

## What the game looks like inside (verified 2026-10-24)

- Unity 6000.3.10f1, **Mono** backend (not IL2CPP). Decompiles cleanly, BepInEx + Harmony work.
- Game code: `Managed/GameAssembly.dll` (decompiled to `decomp/GameAssembly`).
- Networking: Mirror (kcp/Steam transport). Host is the server. Hole change = `BNetworkManager.ServerChangeScene(holeData.Scene.Name)`.
- `AntiCheat.dll` is only a server-side rate limiter. No client integrity checks.
- Content model:
  - `CourseCollection` -> `CourseData[]` (the tabs in match setup) -> `HoleData[]`.
  - `HoleData` = name, `SceneReference` (scene GUID), par, difficulty, thumbnails, FMOD music event, IsNight.
  - **One hole = one Unity scene.**
  - Custom hole lists go over the wire as `SetNonStandardCourseMessage { int[] globalHoleIndices }`, so every client must have the same holes registered in the same order.
- Surfaces: the ball checks what it hit.
  - `TerrainCollider` -> splat layer -> `TerrainLayer` enum (Fairway, Green, Rough, Sand, Ice, Road...).
  - Any mesh with a `TerrainAddition` component -> that component's layer.
  - Anything else counts as "NotTerrain".
  - So **plain meshes from Blender can be real fairway/green/sand** once they carry `TerrainAddition`.
- Scene parts a hole needs (first look; a vanilla scene dump will confirm the full list):
  - `GolfTeeingPlatform`/`TeeingSpot`, `GolfHole` + `GolfHoleGreenTrigger`, `ItemSpawner` (item boxes)
  - `LevelBoundsWall`/`OutOfBoundsHazard`, `Checkpoint`, `HoleCameraTransformData`, `LevelHazard`
- Ecosystem: Thunderstore community "super-battle-golf", BepInExPack 5.4.2305, 89 packages.
- Prior art: `MasterBuilderMAC-CustomMaps` 1.1.3 (Jun 2026, about 1k downloads).
  - It loads scene AssetBundles + JSON, injects a "Custom Holes" CourseData, and patches `SceneGuidToPathMapProvider`.
  - It fixes shaders/fonts/post-processing by stealing them from vanilla scenes.
  - It has **no license** (we can't copy its code), no sync, no authoring tools, random GUIDs per launch, and hasn't been checked against the 2026-10-12 game update.

## Pieces we need

1. **Loader plugin** (BepInEx): register map packs as CourseData/HoleData with stable IDs (hash of map id + hole index).
   Load scenes on demand, patch the scene GUID map, and fix up materials/shaders from vanilla assets.
2. **Map format** `.sbgmap`: zip with `map.json` (id, version, author, holes, par, music, night...), content, thumbnails.
3. **Authoring/editor**: import geometry, split into holes, and place tee, cup, green, item boxes, OOB volumes and hazards.
   Paint surface types. Includes a validator ("hole 3 has no cup").
4. **Multiplayer sync**: on lobby join, the host advertises its map list (id + hash).
   Clients missing a map download it from the host in chunks over the existing Mirror connection and verify the hash.
   No Workshop needed, and friends only install the mod once.
5. **Distribution**: Thunderstore package (r2modman / Gale = one-click install, Linux-friendly). Maps go in a `maps/` folder or arrive via host sync.
6. **Dev loop on Linux**: Proton + `WINEDLLOVERRIDES="winhttp=n,b"`, BepInEx console log, ScriptEngine hot reload.

## Decision (2026-10-24): standalone lightweight editor, no Unity, friends author too

- The core is **runtime assembly** (option A below). The plugin builds each hole from data, so the map format is engine-free.
- The editor is its own small app: import geometry (glTF/OBJ/FBX), split into holes, place tee/cup/item boxes/OOB, paint surfaces, validate, export `.sbgmap`.
  Likely a web app (three.js) that runs offline in a browser on Linux and Windows, with nothing to install.
- Blender is optional, only as a modelling tool feeding geometry in.
- Later option: an in-game test/edit mode that reuses the same format.

## Original options considered

- **A. Blender-first (runtime assembly).**
  - Geometry is glTF. Markers are named empties/collections (`Hole1/Tee`, `Hole1/Cup`, `ItemBox`, `OOB`).
  - Surfaces come from material names. The plugin builds the scene at load time using the game's own prefabs/materials.
  - Pros: no Unity for anyone, tiny files (good for sync), looks native.
  - Cons: more reverse engineering (we clone vanilla templates, assign deterministic Mirror sceneIds), and we are limited to the game's material set plus vertex color/textures.
- **B. Unity SDK (scene bundles).**
  - A Unity 6000.3.10f1 project that references the game DLLs. You place the real components and click "Build map".
  - Pros: proven by prior art, full fidelity (custom shaders, terrain, lighting).
  - Cons: every author needs a ~10 GB Unity install, bundles of 50-150 MB, and shader fix-ups.

## Hole scene anatomy (Twin Beach dump, `tools/dump_scene.py`)

- Same in every hole: `Manager container` (SingletonInitializer, ~30 managers, `Networked managers` with CourseManager/WindManager/CheckpointManager...), `Main Camera`, HUD canvases, `EventSystem`.
- Gameplay: `Teeing platform (stairs|stairless)` x4, `Regular main hole` (GolfHole + Trigger + flag), `Course item spawner` x16 (under `Item spawners`), `Checkpoint`, `Ocean` (MainOutOfBoundsHazard), `Overview camera track`, `Screenshot camera`.
- Ground: MicroSplat `Terrain` plus spline meshes with `TerrainAddition`. Everything else is decoration (`Entity`/`Foliage`).

**v1 strategy: donor scene.**
- Load a small vanilla hole, then destroy its decoration and terrain, and spawn the map geometry with `TerrainAddition` per surface.
- *Move* the existing networked tees/cup/item spawners/checkpoint to the map's markers. Their Mirror sceneIds are already valid on every client.
- Later: clone extras with deterministic sceneIds when a map needs more than the donor has.

## Findings from the first playtests (2026-10-24)

- The shot preview (swing power bar) ignores physics. It reads a terrain data grid (heights, paint weights, plus "overrides" raycast from TerrainAddition meshes).
  - That grid is baked into each scene. Disposing it before `TerrainManager.Start` makes the game regenerate it from the live scene.
- The 3 m around the cup always use the terrain's own paint, so the terrain must be painted green there.
- Vanilla cups sit in a terrain hole cutout (`TerrainData.SetHoles`). The cup's own MeshCollider has no real shape.
- Mesh surfaces that sit at different heights create steps that break the putt preview.
- **So maps are terrain-first:** heightmap + surface paint + cup cutout. Meshes are optional extras (bridges, ramps).
- The editor's core is therefore sculpt + paint + place markers.

## Dev loop

- Plugin builds into `BepInEx/scripts`. `SbgMaps.DevReloader` (in `plugins/`) polls for new builds and triggers ScriptEngine, since its file watcher does not work under Proton.
- Host hotkeys: F5 restart hole (re-reads map files), F7 skip hole, F8 dump objects to log. Feedback shows in the text chat.
- The game's own console: enable the "Console commands" lobby rule (disables achievements for that match), then press backquote.
  - Built-ins include `skipHole`, `finishHole`, `giveItem <ItemType>`.

## Status

- Phase 1 done (hand-built test hole played fine).
- Phase 2 (friend test) skipped by choice; risk noted: every player needs the mod and the same maps.
- Phase 3 in progress: format 1 (FORMAT.md), loader, "Custom" course tab, host->client hole selection message, sample pack.

## Import track: levels from other games (requested 2026-10-24)

Goal: import ripped levels (e.g. SM64 Bob-omb Battlefield, WoW Stormwind) and split them into holes.

- Imported levels stay **meshes**: they have overhangs, bridges and buildings that a heightmap would flatten.
  - Surfaces are tagged with `TerrainAddition`, which is how vanilla does bridges/buildings.
  - The regenerated shot-preview grid includes TerrainAddition meshes (ProcessHitsJob raycasts them), so the preview works on them.
  - The cup cuts a hole in the collision mesh under the cup. The terrain under the cup is painted green, because the preview uses terrain paint at cup height there.
  - The sunken donor terrain stays as sea floor; the water level works as now.
- Editor = web app (three.js) since it has loaders for glTF/GLB, OBJ, FBX and DAE.
  - It converts every input into one simple mesh format (positions/normals/uvs/indices per material + PNG textures), so the plugin only reads that.
  - Editor steps: import, scale (player-height reference), assign surfaces per material and then per face, split into holes (tee/cup/items/bounds/camera per hole), crop to the used area (decimate if huge), keep it within the 1000 m playfield.
- Map format 2: map-level shared assets (meshes, textures) plus holes that reference them. Heightmap holes stay supported and can be mixed with meshes.
- Plugin: runtime mesh + texture loading, URP Lit materials (`Universal Render Pipeline/Lit` is in the build), MeshCollider + TerrainAddition per surface group, ground layer 8.
- Ripped assets: private play with friends only, never published to Thunderstore.
- First step: import proof with one real ripped level as a playable hole, before building the editor.

## Seamless creator/player experience (user requirement, 2026-10-24)

- **Host-to-player map transfer, in the lobby.** On join, the host sends its map list (id + hash).
  - Missing or outdated maps download in the background over the Mirror connection, chunked, with a progress bar.
  - If a hole starts before a download finishes, that player's scene load waits for it.
- **In-game community browser.** Thunderstore is the catalog: the game's community already has a "Courses" category, moderation, versioning and free hosting.
  - The mod lists map packages and installs them with one click; r2modman users get them too.
  - The editor exports a Thunderstore-ready package. No server of our own.
- Ripped/copyrighted levels never go to the public catalog; host transfer covers private play.
- **Editor hosting:** GitHub Pages from `editor/` (workflow `.github/workflows/pages.yml`), fully client-side.

## Editor roadmap ("super expansive", requested 2026-10-24)

Done: model import (OBJ/glTF/FBX/DAE), surfaces (golf/snow/desert/city/special), Start/Flag/items/checkpoints, several holes per level, export/reopen,
SM64 decomp converter, objects (static/see-saw/roller), props with move/rotate/size gizmo, golfer scale reference, start height/direction,
fixed base height + water default.

Next, roughly in order:
1. In-game test of decomp levels (objects, rollers, see-saw, collision mesh, slide layer). Fix what breaks.
2. ~~Map transfer host->players in the lobby~~ (built 2026-10-24, needs a two-player test): list on join, content hashes,
   16 KB chunks paced by Steam's own queue (PendingReliable + SentUnacked kept under 384 KB; Steam drops messages that
   overflow its buffer), Steam SendRateMax raised to 16 MB/s and buffer to 4 MB; downloads go to SbgMaps/maps/downloaded
   and join the Custom Maps course in the host's order without a restart. Next: in-game community browser (Thunderstore).
3. ~~Undo/redo, autosave with "Continue where you left off"~~ (done), more keyboard shortcuts.
4. Per-face surface painting (brush) on top of per-material surfaces, so greens/bunkers can be drawn on any model.
5. Bounds polygon, green polygon and return path drawing; intro camera path editing.
6. Hole settings: night, music, sky/ambience, wind; theme donor selection (forest/desert/snow/city donors).
7. ~~Heightmap terrain editing (sculpt + paint), New level~~ (done). Next: terrain under imported models, more paint surfaces per theme.
8. Walk/fly preview at golfer height and a shot-distance ring at the Start (needs club distances from the game).
9. ~~Object palette, pictures, paths, knocking movers~~ (done). More object types: moving platforms on paths, rotating platforms, elevators, boost pads; more than 16 item boxes / several checkpoints (clone with deterministic sceneIds).
10. Converters for other sources (more SM64 levels via the same tool; generic glTF scene import keeps object nodes).

## Backlog: objects ripped levels leave out (2026-10-24)

- Level rips contain only static geometry. Spawned objects are missing.
  - SM64 BoB: `bhvSeesawPlatform` (the tilting bridge, model in decomp `levels/bob/seesaw_platform`), chain chomp gate, grate door, checkerboard elevator, cannon.
- **Props (next):** the editor imports extra models into a level and places, rotates and scales them, with surfaces as usual. They are exported as extra nodes in level.glb or separate files; the mod builds them like the level.
- **Moving objects (later):** object types animated by the mod with networked physics (tilting see-saw, elevators, rotating platforms). Needs Mirror sync so every player sees the same state.
- The source for SM64 objects is the local decomp `~/sm64-solarflare` via the fast64 Blender addon, exported to .glb.

## Phases

0. Setup: BepInEx in game, plugin skeleton, dump a vanilla hole scene's hierarchy (AssetRipper/UnityPy) to get the exact required component list.
1. Proof: one hard-coded custom hole playable solo (host).
2. Proof: same hole with a friend (scene IDs, sync of hole list).
3. Map format + authoring tool (A or B).
4. Host-to-client map transfer.
5. Polish: thumbnails, menu tab, validator, Thunderstore release.

## Backlog: editor visitor stats (2026-10-24)

- Owner wants to see editor visits, later. Plan: GoatCounter (free, no cookies, no consent banner). Owner signs up
  with the sbg-maps org email and picks a code; then add the count.js tag, skip counting on localhost and in tests,
  and add a one-line footer note that anonymous visits are counted.
