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
