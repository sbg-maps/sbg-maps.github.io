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

## Phases

0. Setup: BepInEx in game, plugin skeleton, dump a vanilla hole scene's hierarchy (AssetRipper/UnityPy) to get the exact required component list.
1. Proof: one hard-coded custom hole playable solo (host).
2. Proof: same hole with a friend (scene IDs, sync of hole list).
3. Map format + authoring tool (A or B).
4. Host-to-client map transfer.
5. Polish: thumbnails, menu tab, validator, Thunderstore release.
