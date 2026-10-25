# SBG Maps

Custom map support for Super Battle Golf: a BepInEx mod that loads custom holes, and a browser-based map editor.

- **Editor:** https://sbg-maps.github.io/ runs in your browser. Map files never leave your computer.
- **Map format:** [FORMAT.md](FORMAT.md)
- **Status and design notes:** [PLAN.md](PLAN.md)

Early work in progress. The mod is not packaged for install yet.

## Layout

- `plugin/` BepInEx plugin (C#, netstandard2.1)
- `devreloader/` dev-only helper that hot-reloads the plugin under Proton
- `editor/` map editor (Vite + three.js), deployed to GitHub Pages
- `tools/` Python scripts: game data inspection, sample map generator, map previews

This repo contains no game code or game assets. Decompiled and extracted game data stay local and are gitignored.

## Level converters

`tools/` also holds converters that turn other games' levels into a `.glb` the editor imports. They read your own local game files; the converted levels stay on your computer and are never committed.

- `tools/sm64_to_glb.py`: a Super Mario 64 decomp level area.
- `tools/wow_to_glb.py`: an area of a World of Warcraft 1.12.1 map, read straight from the client's MPQ archives (needs `pip install pillow mpyq`). Terrain with baked texture blends, WMO buildings (outdoor parts; `--interiors` keeps the rooms), M2 doodads and water, in metres, centred on the area. Example: `python tools/wow_to_glb.py <WoW>/Data Azeroth stormwind.glb --preset stormwind`. Pick other areas with `--tiles X,Y[,X2,Y2]` or `--box` in world yards; `--chunk-px`, `--max-tex` and `--min-doodad` trade detail for file size.
- `tools/gtasa_to_glb.py`: an area of the Grand Theft Auto: San Andreas map (classic PC version), read straight from the game folder (`models/gta3.img`, `data/`; needs `pip install pillow numpy`). All detailed models placed in the area (no LODs or interiors) with their textures and prelight vertex colours, merged by material, plus the water; leaves of trees and plants are render only. In metres, centred on the area. Example: `python tools/gtasa_to_glb.py "<GTA San Andreas>" grove.glb --preset grove_street`; `--box x1,y1,x2,y2` takes any area in game metres, `--grid DIR` writes the whole map as 8 x 8 sections of 750 m (ocean-only ones skipped), `--presets DIR` every named area (Grove Street, Santa Maria Beach, Downtown, Vinewood, Mount Chiliad, San Fierro, the Strip, Verdant Meadows, Yellow Bell golf course and more), with a `sections.json` index. Sections fit the editor's 900 x 900 m; `--max-tex`, `--max-tris` and `--max-mb` trade detail for file size (the smallest props go first). Import at Scale 1 for true size.

The WoW and GTA converters record where each file sits in its game world, in the root scene's extras: `{"source": "wow" | "gtasa", "map": ..., "worldOrigin": [x, y, z]}`, where a point's world position (glTF frame, metres) is its position in the file plus `worldOrigin`. Areas of the same map placed at their `worldOrigin` line up as in the game.
