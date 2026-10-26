# SbgMaps map format (formats 1 and 2)

A map is either a folder with `map.json` at its root, or the same contents zipped into a `.sbgmap` file.
Maps go in `<game folder>/SbgMaps/maps/`. One map holds one or more holes, and all of them show up in the "Custom" course tab.

The plugin re-reads a map's files every time one of its holes loads. Editing a map and restarting the hole (host hotkey F5) shows the change.
New maps, or a different number of holes, need a game restart because the course list is built at startup.

- **Format 1:** heightmap holes (sculpted terrain plus painted surfaces).
- **Format 2:** adds a level **model**; holes may also share a heightmap terrain (levels built from scratch in the editor use a terrain plus a model holding their objects) (`.glb`) shared by all holes, for imported levels. The map editor at https://sbg-maps.github.io/ produces this format.

## map.json

```json
{
  "format": 1,
  "id": "author.map-name",
  "name": "Display name",
  "author": "Who made it",
  "version": "1.0.0",
  "holes": [ { ...hole... } ]
}
```

- `id` must be unique; it is how players' copies are matched up. Maps are listed sorted by `id`.
- Format 2 adds:
  - `size`: [x, z] area shared by all holes.
  - `model`: `{ "file": "level.glb" }`.
  - `credits`: optional text.
  - `music`: optional song file in the map (e.g. `"music/theme.ogg"`; mp3, ogg, wav or flac). It loops instead of the game's hole music, at the game's music volume, and speeds up slightly on "hurry up". Without it, the game's music plays.
  - `songs`: optional settings per song file, e.g. `{"music/theme.ogg": {"volume": 0.6}}`. `volume` runs from 0 to 1 (default 1) and applies on top of the game's music volume.

## Hole

| field | type | meaning |
|---|---|---|
| `name` | string | Shown in match setup and the hole intro. |
| `par` | int | Par, at least 1. |
| `difficulty` | string | `none`, `beginner`, `intermediate` or `expert`. |
| `theme` | string | Only `coast` for now (decides the donor hole, ground textures, sky and sounds). |
| `size` | [x, z] | Playable area in metres, at most 900 x 900. Map coordinates run from (0, 0) to `size`. |
| `heightmap` | grid | Ground heights (see below). |
| `paintmap` | grid | Surface types (see below). Optional; without it everything is rough. |
| `water` | number | World height of the water. Ground below it is water (out of bounds). Default 5. |
| `greenRadius` | number | Model maps: ground within this many metres of the cup plays and looks like green. Default 10. |
| `tee` | {x, y?, z, yaw?} | Where the teeing platforms go. With `y`, all platforms sit at that height. `yaw` is degrees clockwise from +z; by default the tee faces the cup. |
| `cup` | {x, z} | The cup. The ground within 3 m of it is always painted green. |
| `itemBoxes` | [{x, z}] | Item box positions. Up to 64 together with `redItemBoxes`. |
| `redItemBoxes` | [{x, z}] | Optional. Red item boxes, which give the better movement items. |
| `items` | {item: weight} | Optional. What normal boxes give, e.g. `{"Coffee": 40, "SpringBoots": 20}`; chance is weight / total. Default: the game's own pools, better items for players further behind. Item names are the game's (`Coffee`, `SpringBoots`, `RocketDriver` (fire club), `GolfCart`, `Landmine`, `DuelingPistol`, `ElephantGun`, `Airhorn`, `Electromagnet`, `RocketLauncher`, `FreezeBomb`, `SmokeBomb`, `FlashCamera`, `Thunderstorm`, `Railgun`, `OrbitalLaser`, `JumboBurger`). |
| `redItems` | {item: weight} | Optional. What red boxes give. Default: `{"SpringBoots": 50, "RocketDriver": 50}`, like the game's. |
| `golfCarts` | [{x, z, yaw?}] | Optional. Golf carts parked on the hole (the game's own, drivable), facing the cup unless `yaw` is given. Up to 16. |
| `checkpoints` | [{x, z}] | Respawn checkpoints, in order from the start to the flag. Up to 64. |
| `bounds` | [[x, z], ...] | Optional. Playable-area polygon. Default: the whole `size` rectangle. |
| `green` | [[x, z], ...] | Optional. Green polygon (raises the flag, putting rules). Default: 15 m circle around the cup. |
| `returnPath` | [[x, z], ...] | Optional. Path that out-of-bounds balls are returned towards. Default: straight line from tee to cup. |
| `music` | string | Optional. A song file in the map for this hole only, instead of the map's `music`. |
| `model` | {file} | Optional. This hole's own level model, used instead of the map's `model`: the piece of a bigger level around this hole, in this hole's coordinates (like its points). Lets one map hold holes from far-apart parts of a big world. |
| `origin` | [x, z] | Optional, with `model`. Where this hole's area sat in the level it was cut from; the editor uses it to put the pieces back together. |
| `sky` | string | Optional. The sky and air (skybox, sun, ambient light, fog and colour grading) of a vanilla hole, by its scene name, e.g. `"Mirage"`, `"Snow 2"`, `"Central Park"`. The mod saves these from the game (SbgMaps/assets). |
| `skyImage` | string | Optional. A 360 panorama picture in the map (.jpg or .png, twice as wide as high) shown all around the hole instead of the sky. |
| `preview` | string | Optional. A picture of the hole in the map (.jpg or .png, about 608 x 400), shown when hovering the hole in match setup. The editor renders one per hole on export. |

Heights (y) are world heights in metres. x and z are map coordinates in metres.
Points (`tee`, `cup`, `itemBoxes`, `checkpoints`) may carry `y`. Without it, the height comes from the heightmap, or from the model below the point. Model maps should always give `y` for the cup.
The plugin centres the map on a 1000 m terrain and slopes the edges down into the sea with a 25 m beach.

## Grids

```json
"heightmap": { "file": "hole1.height.r16", "width": 481, "depth": 841, "min": 0, "max": 64 },
"paintmap":  { "file": "hole1.paint.u8",  "width": 480, "depth": 800 }
```

- Raw files, rows along +z, starting at z = 0. Each row runs along +x, starting at x = 0.
- **Heightmap**: `width * depth` little-endian uint16 samples. The samples span the area edge to edge (the first sample is at 0, the last at `size`).
  - World height = `min + value / 65535 * (max - min)`.
  - 0.5 m spacing matches the game's own terrain.
- **Paintmap**: `width * depth` bytes, one surface per cell (cells tile the area):

| value | surface |
|---|---|
| 0 | rough |
| 1 | fairway |
| 2 | green |
| 3 | sand |
| 4 | dirt path |
| 5 | out of bounds |

Unknown values count as rough.

## Level model (format 2)

- A binary glTF (`.glb`) in map coordinates. glTF is right-handed, so a vertex at glTF (x, y, z) sits at map (x, y, -z).
  - The editor bakes scale, rotation and placement into the vertices.
- Supported: triangle meshes with positions, normals, the first UV set, base colour factor and embedded PNG/JPEG base colour textures. Node transforms are applied.
- Each material's `extras.surface` decides how it plays:

| surface | plays as |
|---|---|
| `fairway`, `rough`, `green`, `sand`, `path` | golf surfaces |
| `snow-fairway`, `snow-rough`, `snow-green`, `ice` | snow surfaces; `ice` is slippery |
| `desert-sand`, `dry-fairway`, `dry-green`, `sand-rough` | desert surfaces |
| `road`, `sidewalk`, `bridge`, `building` | city surfaces |
| `slide` | slippery and hard to climb: plays as ice, and pulls players downhill harder the steeper it is |
| `oob` | out of bounds |
| `solid` | walls and props: solid, no golf surface |
| `none` | decoration: no collision |

- Missing or unknown surfaces count as rough.
- Other material extras:
  - `invisible: true` makes a collision-only mesh, never drawn. Levels converted from game sources ship their real collision mesh this way.
  - `renderOnly: true` makes a visual-only mesh with no collision. The game still cuts the cup into it and tints it green near the flag.
  - `climbable: true` lets players walk up it at up to 80 degrees, past the game's usual steepness limit (only walls stop them). The SM64 converter sets it on every floor Mario can walk on.

### Objects

Vertex colours (`COLOR_0`, RGB or RGBA) multiply the texture, as game rips use them for baked shading. A part whose vertex alpha goes below 1 is a layer that fades into what is under it: it is drawn see-through (if the game's lit particle shader is available, else it is not drawn) and still collides.

A node with `extras.object` is an object. It is built separately, with its own transform, so the game can move it.

| `object` | behaviour |
|---|---|
| `static` | a prop: built like the level |
| `seesaw` | tilts toward players standing on it (around its local x axis; its length runs along local z). Host-simulated, synced. |
| `roller` | rolls copies of its model along `extras.path`, knocking players over. Positions come from the network clock, so they match on every machine. |
| `mover` | platforms riding `extras.path` (`loop: true` to go round, otherwise back and forth), `count` evenly spaced copies at `speed` units/s. Clock-synced; players ride along. With `knocks: true` they knock players over instead. |
| `chomp` | hops around its origin (the post) and lunges up to `reach` in a clock-chosen direction (`radius`, `idleReach`, `lungeSpeed`); touching it knocks players over. |
| `jumppad` | launches players and balls touching its top along its forward direction (+z), tilted up by `launchPitch` degrees (0 flat, 90 straight up; default 35) at `launchSpeed` m/s (default 103). |
| `outofbounds` | an out of bounds zone: the box around its meshes is an invisible trigger (nothing is drawn or collides). A ball that lands on ground inside it, drops out through its bottom, or stays inside 1.5 s goes back to its player with a penalty stroke. Mod 0.5.0. |

Any object may set `billboard: true` (its look turns to face the camera, for pictures) and a static object may set `knocks: true`.

Roller extras, all in the node's local units (scaled by the node's transform):
- `path`: [[x, y, z], ...] points on the ground.
- `radius`: ball radius.
- `speed`: units per second.
- `interval`: seconds between balls.

`tools/sm64_to_glb.py` converts a Super Mario 64 decomp level into this layout: render-only visuals, an invisible collision mesh with surfaces guessed from SM64's own surface types, and objects (see-saws, rollers on the level's trajectories, gates, trees, cannon lids).
- The game cuts a ~2 m square hole in the model under the cup.
- Ground surfaces within `greenRadius` of the cup become green: snow surfaces become `snow-green`, desert ones `dry-green`.

## Tools

- `tools/make_sample_map.py <out_dir>` generates the two-hole sample pack.
- `tools/preview_map.py <map_dir> <out_dir>` renders a top-down PNG of each hole.
