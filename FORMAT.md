# SbgMaps map format (format 1)

A map is either a folder with `map.json` at its root, or the same contents zipped into a `.sbgmap` file.
Maps go in `<game folder>/SbgMaps/maps/`. One map holds one or more holes, and all of them show up in the "Custom" course tab.

The plugin re-reads a map's files every time one of its holes loads. Editing a map and restarting the hole (host hotkey F5) shows the change.
New maps, or a different number of holes, need a game restart because the course list is built at startup.

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
| `tee` | {x, z, yaw?} | Where the teeing platforms go. `yaw` is degrees clockwise from +z; by default the tee faces the cup. |
| `cup` | {x, z} | The cup. The ground within 3 m of it is always painted green. |
| `itemBoxes` | [{x, z}] | Item box positions. Up to 16 for now. |
| `checkpoints` | [{x, z}] | Respawn checkpoints. Up to 1 for now. |
| `bounds` | [[x, z], ...] | Optional. Playable-area polygon. Default: the whole `size` rectangle. |
| `green` | [[x, z], ...] | Optional. Green polygon (raises the flag, putting rules). Default: 15 m circle around the cup. |
| `returnPath` | [[x, z], ...] | Optional. Path that out-of-bounds balls are returned towards. Default: straight line from tee to cup. |

Heights (y) are world heights in metres. x and z are map coordinates in metres.
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

## Tools

- `tools/make_sample_map.py <out_dir>` generates the two-hole sample pack.
- `tools/preview_map.py <map_dir> <out_dir>` renders a top-down PNG of each hole.
