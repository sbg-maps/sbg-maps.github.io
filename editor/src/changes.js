// What changed, newest first. Returning visitors see the entries newer than the last one they saw.
// Write for players: what they can do now, not how it works. Bump `id` for every new entry.
export const CHANGES = [
  {
    id: 1,
    date: "2026-10-24",
    items: [
      "<b>Play area</b>: mark where balls may go (Play area in the toolbar, or <i>Fit around start and flag</i> in Holes). Shots that leave it are out of bounds instead of landing on other parts of the map.",
      "<b>Music</b>: add your own songs to a map in the Export tab, one for the whole map or one per hole. Everyone gets them with the map.",
      "<b>Climb</b> box on surfaces: players can walk up steep ground like Mario. Levels imported from Super Mario 64 have it already.",
      "Shaping land is much faster, especially on large levels.",
      "Start, Flag and item boxes now land on the ground, not on trees or moving objects.",
      "New mod version (0.2.0): maps download to friends in the lobby with a progress bar, and the game waits until everyone has the map. Everyone needs the new version.",
    ],
  },
];
