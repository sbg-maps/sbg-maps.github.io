// The game mod, for the mod page (mod/index.html). Newest version first.
// For every mod release: bump Version in plugin/Plugin.cs (+0.0.1 for small changes), add an entry here with the same
// version, then run tools/publish_mod.sh, which uploads the zip that `download` points at.
// Write for players: what they get in the game, a line each.
export const MOD_VERSIONS = [
  {
    version: "0.4.1",
    date: "2026-10-25",
    items: [
      "Golf carts a map parks on a hole: the game's own drivable carts, facing where the map maker aimed them.",
      "Skies: a hole can use the sky of any of the game's holes, or a 360 picture.",
      "Maps choose what comes out of their item boxes and red boxes.",
      "Red boxes and jump pads look like the game's own.",
      "Big worlds: each hole loads just its own part of the level, so large levels fit.",
      "The cup on flat ground only cuts its opening, so the ground around it stays as the map maker built it.",
      "Downloading a newer copy of a map replaces the old one.",
      "Skies of the normal holes you play are saved for maps to use.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-10-25",
    items: [
      "Red item boxes and jump pads.",
      "Vertex colours on imported levels.",
      "The swing power bar reads the map's ground instead of showing water.",
      "Maps are lit by their sky instead of looking dark and flat.",
      "Song volume set in the editor works in game.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-10-25",
    items: [
      "Fixed players being dropped while a map downloads.",
      "Test a map on the title screen: pick a hole and play it right away.",
      "New or changed map files show up on the title screen without a restart.",
      "The out of bounds wall follows the map's play area.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-10-24",
    items: ["Maps download from the host when you join, with a progress bar.", "Map music."],
  },
];

export const MOD_VERSION = MOD_VERSIONS[0].version;
export const downloadUrl = (version) =>
  `https://github.com/sbg-maps/sbg-maps.github.io/releases/download/mod-${version}/SbgMaps-${version}.zip`;
