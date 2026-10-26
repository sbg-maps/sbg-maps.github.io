// What changed, newest first. Returning visitors see the entries newer than the last one they saw.
// Write for players: what they can do now in the editor, not how it works, and not mod or game news. Bump `id` for every new entry.
export const CHANGES = [
  {
    id: 12,
    date: "2026-10-26",
    items: [
      "<b>Animated models</b>: add a .glb, .fbx or .dae model that has animations (Objects tab, 3D model) and pick one in its <b>Animation</b> list. It plays here and loops in the game. An idle is picked by default; None makes it stand still. Needs mod 0.6.0.",
      "Dropping a model onto an open level asks first: <b>Add as an object</b> or <b>Replace the level</b>.",
      "<b>Your character</b>: press F9 in the game, then drop my-character.glb (SbgMaps in the game folder) onto the editor. The Golfer tool and Player view use it.",
    ],
  },
  {
    id: 11,
    date: "2026-10-26",
    items: [
      "Levels stored lying on their side (Counter-Strike and other Source maps, many 3ds Max exports) are stood up by themselves. If one still comes out wrong, <b>Tip over 90&deg;</b> on the Model tab, next to Rotate 90&deg;, turns it.",
      "Models with .tga textures show them.",
    ],
  },
  {
    id: 10,
    date: "2026-10-26",
    items: [
      "Map files are much smaller: a picture used by many materials is saved once, pictures that are not see-through are saved as JPEG, very large ones are made 2048 pixels at most, and models are stored more compactly. A Dark Souls level went from 460 MB to 34 MB. Export your map again to get the smaller file.",
    ],
  },
  {
    id: 9,
    date: "2026-10-26",
    items: [
      "Objects have a <b>Duplicate</b> button (or Ctrl+D): a copy with the same settings appears next to it.",
      "Objects have a <b>Size</b> slider and box (largest side in metres) that resizes them evenly, so imported models keep their proportions. The handles that stretch each side on its own are now called <b>Stretch</b>.",
      "Objects have a <b>Turn</b> slider and box: which way they face, in degrees (0 = map north).",
    ],
  },
  {
    id: 8,
    date: "2026-10-26",
    items: [
      "<b>Remove part</b> tool (Level group): click a part of the level to remove it, like one file of a level imported in parts or one named piece of a model. A yellow outline shows what goes; Ctrl+Z brings it back.",
    ],
  },
  {
    id: 7,
    date: "2026-10-26",
    items: [
      "<b>Out of bounds</b> zones (Objects tab): a see-through red box you can move and size. Balls that land in it, or fall through it into a pit, go back to their player with a penalty stroke. Put one in holes and gaps balls should not drop into. Needs mod 0.5.0.",
    ],
  },
  {
    id: 6,
    date: "2026-10-26",
    items: [
      "Tools are grouped in the toolbar: <b>Hole</b>, <b>Level</b>, <b>Try</b>. Item boxes, red boxes and golf carts are objects now: pick them in the <b>Objects</b> tab, next to their counts and the items in the boxes.",
      "Right-click erases the box, cart or marker you point at (red boxes too), and never the level itself. A level piece is removed with Delete after selecting it.",
    ],
  },
  {
    id: 5,
    date: "2026-10-26",
    items: [
      "<b>Scale</b> has a slider, and the item chances in boxes are sliders too. Number boxes take 0,5 as well as 0.5.",
      "<b>Levels in parts</b>: when a download has many model files (one per area, like Dark Souls rips), pick <b>All together</b> to import them as one level. Sky domes and far-off backdrops are left out.",
      "<b>Zips</b> open everywhere: a zipped map folder, a .sbgmap inside a zip, zips inside zips, through any button or by dropping them.",
      "Big imported levels run smoother: clicking on them is several times faster, autosave no longer stalls the editor, and long material lists show the first 60 (Show all lists the rest).",
    ],
  },
  {
    id: 4,
    date: "2026-10-25",
    items: [
      "<b>Cut area</b> tool: click corners around any part of the level, then Cut it out. Everything inside becomes an object you can move, resize or delete, even when it is part of one solid mesh.",
      "The <b>Player view</b> window can be resized: drag its top-left corner.",
      "<b>Golf cart</b> tool: park real, drivable golf carts on a hole (up to 16). Click to place one facing the Flag, or click and drag to aim it. Needs mod 0.4.1.",
      "<b>Sky</b> (Holes tab): give a hole the sky of any of the game's holes (desert, snow, city at night...) or your own 360 panorama picture. Needs mod 0.4.1.",
      "<b>Delete</b> key removes the selected object or cut-out piece (Ctrl+Z brings it back).",
      "Reopened maps show their real Scale. Before, a reopened map showed Scale 1 and typing the old number made it that much bigger again.",
    ],
  },
  {
    id: 3,
    date: "2026-10-25",
    items: [
      "<b>Big worlds</b>: levels bigger than one hole area work now. On export each hole gets just the piece of the level around it (or tick \"Only keep the level around each hole\" for any model level: smaller downloads). Converted game worlds can be combined with <b>Add a section</b> (Model tab), so one map can have holes in far-apart places. Needs mod 0.4.1.",
      "The Opacity slider for See-through materials now goes all the way down to 0% (invisible).",
      "<b>Cut piece</b> tool: click a floating island (or any separate piece of an imported level) to turn it into an object you can move, turn and resize. Handy when scaling a level spreads its islands too far apart.",
      "<b>Choose the items</b> in a hole's boxes (Holes tab): which items can come up and how often, for normal boxes and for red boxes. Needs mod 0.4.1.",
      "Red boxes in the game now look like the game's own red boxes. Needs mod 0.4.1.",
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
