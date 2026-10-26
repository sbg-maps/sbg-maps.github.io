// The game mod, for the mod page (mod/index.html). Newest version first.
// For every mod release: bump Version in plugin/Plugin.cs, add an entry here with the same version, then run
// tools/publish_mod.sh, which uploads the zip that `download` points at. Semantic versioning (major.minor.patch):
//   major: older mods can no longer play new maps or join new lobbies (map format or network messages changed)
//   minor: new features that still work alongside older maps
//   patch: bug fixes only
// Write for players: what they get in the game, a line each.
export const MOD_VERSIONS = [
  {
    version: "0.6.0",
    date: "2026-10-26",
    items: [
      "Animated models: an imported model plays the animation chosen for it in the editor.",
      "Maps whose file name starts with \"private\" stay on your computer: players who join you do not get them.",
      "The Custom Maps course tab has its own icon and lists only map holes; the game's tabs list only the game's holes.",
      "The game starts straight at the title screen, without the intro.",
      "Test a map is now Custom maps on the title screen, with Mod settings inside it: the intro skip, the F5/F7/F9 keys and the volume of map music.",
      "F5 (restart hole) and F7 (skip hole) only work when you are alone in the lobby.",
      "F9 saves your character as SbgMaps/my-character.glb (in the game folder), for the map editor.",
      "Fixed the swing bar showing water and losing the flag when aiming straight at the hole.",
      "Players who walk or fall into an out of bounds zone are knocked out and respawn, like in the game's bottomless pits. Below the zone is still in bounds.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-10-26",
    items: ["Out of bounds zones: balls that land in one, or fall through it into a pit, go back to their player with a penalty stroke."],
  },
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

// Which mod version this browser last downloaded from the mod page, so the editor can flag a newer one.
const DOWNLOADED_KEY = "sbg.modDownloaded";
export function downloadedVersion() {
  try {
    return localStorage.getItem(DOWNLOADED_KEY);
  } catch {
    return null;
  }
}
export function markDownloaded(version) {
  try {
    localStorage.setItem(DOWNLOADED_KEY, version);
  } catch {
    // Only a reminder; nothing breaks without it.
  }
}
/** "Oct 25" from "2026-10-25". */
export const shortDate = (date) => new Date(`${date}T12:00:00`).toLocaleDateString("en", { month: "short", day: "numeric" });
