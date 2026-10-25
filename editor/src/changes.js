// What changed, newest first. Returning visitors see the entries newer than the last one they saw.
// Write for players: what they can do now in the editor, not how it works, and not mod or game news. Bump `id` for every new entry.
export const CHANGES = [
  {
    id: 4,
    date: "2026-10-25",
    items: [
      "Reopened maps show their real Scale. Before, a reopened map showed Scale 1 and typing the old number made it that much bigger again.",
    ],
  },
  {
    id: 3,
    date: "2026-10-25",
    items: [
      "<b>Big worlds</b>: levels bigger than one hole area work now. On export each hole gets just the piece of the level around it (or tick \"Only keep the level around each hole\" for any model level: smaller downloads). Converted game worlds can be combined with <b>Add a section</b> (Model tab), so one map can have holes in far-apart places. Needs mod 0.4.0.",
      "The Opacity slider for See-through materials now goes all the way down to 0% (invisible).",
      "<b>Cut piece</b> tool: click a floating island (or any separate piece of an imported level) to turn it into an object you can move, turn and resize. Handy when scaling a level spreads its islands too far apart.",
      "<b>Choose the items</b> in a hole's boxes (Holes tab): which items can come up and how often, for normal boxes and for red boxes. Needs mod 0.4.0.",
      "Red boxes in the game now look like the game's own red boxes. Needs mod 0.4.0.",
      "<b>Shift+click</b> materials (in the view with Look, or in the Model list) to pick several and change their surface, Climb, transparency or Walk through all at once.",
      "<b>Controls</b> button at the top lists every mouse and keyboard shortcut.",
      "<b>Close</b> button at the top: back to the start screen. Your work stays in the autosave (Continue where you left off).",
      "<b>Right-click</b> an object or marker to erase it (Ctrl+Z brings it back). Right-drag still moves the view.",
      "Jump pads launch like the game's own (103 m/s at 35 degrees) and the arc now uses the game's real gravity and air drag.",
    ],
  },
  {
    id: 2,
    date: "2026-10-25",
    items: [
      "<b>Fly</b> button (top right of the view): fly around the map with WASD, look by dragging, Shift or F to go faster, the wheel sets the speed. Tools keep working while you fly. In Firefox, use F to go faster: Shift + right-click opens the browser's menu.",
      "Up to 64 item boxes and 64 checkpoints per hole (was 16 and 1). Checkpoints count in the order you place them, from the Start to the Flag. Needs mod 0.4.0.",
      "<b>Red item boxes</b> (Red box in the toolbar): they give the better movement items, like the red boxes in the game. Needs mod 0.4.0.",
      "<b>Jump pads show their flight</b>: a dashed arc and a ring where players come down (blue if it is in the water). It updates as you move, turn or change a pad.",
      "GameCube and Wii levels: ground layers that fade into each other (through vertex colours) now blend instead of fighting, in the editor and in the game (mod 0.4.0). Re-export maps made before today to get this.",
      "Sliders for numbers (water level, start height and direction, par, green size, object speeds, jump pads). Dragging the water level moves the water live and tells you how far the Start and Flag are above it.",
      "<b>Jump pads</b> in Objects: they launch players and balls the way their arrow points, with your own speed and angle. Needs mod 0.4.0.",
      "<b>Start platforms</b> are drawn where the game puts them, in red if a wall, hill or object pokes through.",
      "<b>Transparency</b>: click a material (Model tab) to pick Solid, Cut out (leaves, petals, fences), See-through or Glow, and Two-sided. Textures with see-through parts start as Cut out.",
      "<b>Walk through</b> on a material: players and balls pass through it (plants, flowers).",
      "Hole pictures: each hole gets a picture in the game's hole list when you download the map.",
      "Song volume slider in the Export tab.",
      "Hole names and the map name are explained where you type them. In the game, holes still called \"Hole 1\" show the map's name instead.",
            "Zipped models can be imported as they are. If the files hold several models, you pick which one to build on.",
      "Levels ripped from GameCube and Wii games look right: no more white shadow layers over the textures or black light panels.",
    ],
  },
  {
    id: 1,
    date: "2026-10-24",
    items: [
      "<b>Play area</b>: mark where balls may go (Play area in the toolbar, or <i>Fit around start and flag</i> in Holes). Shots that leave it are out of bounds instead of landing on other parts of the map.",
      "<b>Music</b>: add your own songs to a map in the Export tab, one for the whole map or one per hole. Everyone gets them with the map.",
      "<b>Climb</b> box on surfaces: players can walk up steep ground on it.",
      "Shaping land is much faster, especially on large levels.",
      "Start, Flag and item boxes now land on the ground, not on trees or moving objects.",
    ],
  },
];
