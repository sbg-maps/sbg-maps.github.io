"""Convert a Super Mario 64 decomp level area into a .glb for the SBG map editor.

usage: sm64_to_glb.py <decomp_root> <level> <area> <out.glb> [--all-objects]
example: sm64_to_glb.py ~/sm64-solarflare bob 1 bob.glb

Reads the decomp's C sources (no build needed beyond the PNG textures that ship with it) and writes:
- node "level": the area's visual geometry with textures. Render only: its materials have extras.renderOnly.
- node "collision": SM64's collision mesh, invisible. Materials are split by (SM64 surface type, texture
  underneath) and carry extras.surface (our surface id, guessed from the SM64 type), extras.invisible and
  extras.sm64Surface, so the editor can show and reassign them.
- one node per level object (see-saw bridge, gates, trees...) with its position/rotation and
  extras.object (behaviour: "seesaw" for bhvSeesawPlatform, otherwise "static") and extras.sm64Behavior.
Units stay SM64 units; the editor scales the level to golf size.
"""
import json
import math
import os
import re
import struct
import sys

from PIL import Image

# ---------- C source parsing ----------

CALL = re.compile(r"(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def split_args(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
            continue
        depth += ch == "("
        depth -= ch == ")"
        cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def num(s):
    s = s.strip()
    s = re.sub(r"^\((?:s16|s32|u8|u16|f32)\)", "", s)
    try:
        return int(s, 0)
    except ValueError:
        return float(s.rstrip("f"))


class Decomp:
    def __init__(self, root):
        self.root = root
        self.vtx = {}       # name -> list of (x, y, z, s, t, a, b, c, d)
        self.gfx = {}       # name -> list of (macro, args)
        self.geo = {}       # name -> list of (macro, args)
        self.textures = {}  # name -> png path
        self.models = {}    # MODEL_* -> geo name
        self.models_dl = {} # MODEL_* -> (display list, layer)
        self.trajectories = {}  # name -> list of (x, y, z)
        self.collision = {} # name -> list of (macro, args)

    def load_file(self, path):
        try:
            text = strip_comments(open(path, encoding="utf-8", errors="replace").read())
        except OSError:
            return
        base = os.path.dirname(path)
        for m in re.finditer(r"const\s+Texture\s+(\w+)\s*\[\s*\]\s*=\s*\{\s*#include\s+\"([^\"]+)\"", text):
            png = m.group(2).replace(".inc.c", ".png")
            self.textures[m.group(1)] = os.path.join(self.root, png)
        for m in re.finditer(r"const\s+Vtx\s+(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};", text, flags=re.S):
            verts = []
            for v in re.finditer(r"\{\{\{\s*([^}]*)\}\s*,\s*([^,]*),\s*\{\s*([^}]*)\}\s*,\s*\{\s*([^}]*)\}\}\}", m.group(2)):
                pos = [num(x) for x in v.group(1).split(",")]
                tc = [num(x) for x in v.group(3).split(",")]
                col = [num(x) for x in v.group(4).split(",")]
                verts.append((*pos, *tc, *col))
            self.vtx[m.group(1)] = verts
        for kind, store in (("Gfx", self.gfx), ("GeoLayout", self.geo), ("Collision", self.collision)):
            for m in re.finditer(r"const\s+" + kind + r"\s+(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};", text, flags=re.S):
                store[m.group(1)] = [(c.group(1), split_args(c.group(2))) for c in CALL.finditer(m.group(2))]
        for m in re.finditer(r"LOAD_MODEL_FROM_GEO\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)", text):
            self.models.setdefault(m.group(1), m.group(2))
        for m in re.finditer(r"LOAD_MODEL_FROM_DL\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)", text):
            self.models_dl.setdefault(m.group(1), (m.group(2), m.group(3)))
        for m in re.finditer(r"const\s+Trajectory\s+(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};", text, flags=re.S):
            self.trajectories[m.group(1)] = [tuple(num(x) for x in split_args(c.group(2))[1:4])
                                             for c in CALL.finditer(m.group(2)) if c.group(1) == "TRAJECTORY_POS"]
        for inc in re.findall(r"#include\s+\"([^\"]+\.inc\.c)\"", text):
            for candidate in (os.path.join(self.root, inc), os.path.join(base, inc)):
                if os.path.exists(candidate) and not candidate.endswith((".rgba16.inc.c", ".ia8.inc.c", ".ia16.inc.c", ".i4.inc.c", ".i8.inc.c", ".ia4.inc.c", ".ci4.inc.c", ".ci8.inc.c")):
                    self.load_file(candidate)
                    break


# ---------- geometry building ----------

def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def translate(x, y, z):
    return [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]


def rot_x(deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]]


def rot_y(deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]]


def rot_z(deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def scale_m(f):
    return [[f, 0, 0, 0], [0, f, 0, 0], [0, 0, f, 0], [0, 0, 0, 1]]


IDENTITY = translate(0, 0, 0)


def apply(m, p, w=1.0):
    return tuple(m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] * w for i in range(3))


class MeshBuilder:
    """Collects triangles per material key, as unindexed vertex lists."""

    def __init__(self):
        self.parts = {}  # key -> dict(pos, nrm, uv, col)

    def add(self, key, verts):
        part = self.parts.setdefault(key, {"pos": [], "nrm": [], "uv": [], "col": []})
        for v in verts:
            part["pos"].append(v["pos"])
            part["nrm"].append(v["nrm"])
            part["uv"].append(v["uv"])
            part["col"].append(v["col"])


def texture_size(dec, tex):
    path = dec.textures.get(tex)
    if path and os.path.exists(path):
        with Image.open(path) as im:
            return im.size
    return (32, 32)


def run_display_list(dec, name, matrix, layer, out, billboard=False, state=None):
    """Executes a display list, emitting textured triangles into `out` (MeshBuilder)."""
    if state is None:
        state = {"tex": None, "lit": True, "textured": True, "verts": [None] * 64}
    for macro, args in dec.gfx.get(name, []):
        if macro in ("gsDPSetTextureImage",):
            state["tex"] = args[3]
        elif macro.startswith("gsDPLoadTextureBlock") or macro.startswith("gsDPLoadTextureTile"):
            state["tex"] = args[0]
        elif macro == "gsSPTexture":
            state["textured"] = "G_OFF" not in args[-1]
        elif macro == "gsDPSetCombineMode":
            state["textured"] = not all(a.strip() in ("G_CC_SHADE", "G_CC_PRIMITIVE", "G_CC_SHADEFADEA", "G_CC_FADE") for a in args)
        elif macro == "gsSPSetGeometryMode" and "G_LIGHTING" in args[0]:
            state["lit"] = True
        elif macro == "gsSPClearGeometryMode" and "G_LIGHTING" in args[0]:
            state["lit"] = False
        elif macro == "gsSPVertex":
            ref = args[0].replace(" ", "")
            sym, off = (ref.split("+") + ["0"])[:2]
            src = dec.vtx.get(sym, [])
            count, v0 = num(args[1]), num(args[2])
            for i in range(count):
                if num(off) + i < len(src):
                    state["verts"][v0 + i] = src[num(off) + i]
        elif macro in ("gsSP1Triangle", "gsSP2Triangles", "gsSP1Quadrangle"):
            idx = [num(a) for a in args]
            tris = [idx[0:3]]
            if macro == "gsSP2Triangles":
                tris.append(idx[4:7])
            if macro == "gsSP1Quadrangle":
                tris = [idx[0:3], [idx[0], idx[2], idx[3]]]
            emit_triangles(dec, state, tris, matrix, layer, out, billboard)
        elif macro in ("gsSPDisplayList",):
            run_display_list(dec, args[0], matrix, layer, out, billboard, state)
        elif macro == "gsSPBranchList":
            run_display_list(dec, args[0], matrix, layer, out, billboard, state)
            return
        elif macro == "gsSPEndDisplayList":
            return


def emit_triangles(dec, state, tris, matrix, layer, out, billboard):
    tex = state["tex"] if state["textured"] else None
    w, h = texture_size(dec, tex) if tex else (32, 32)
    key = (tex, state["lit"], layer)
    copies = [matrix]
    if billboard:
        # Sprites face the camera in SM64; as a static model, cross two copies so they read from every side.
        copies = [matrix, mat_mul(matrix, rot_y(90))]
    for m in copies:
        for tri in tris:
            verts = [state["verts"][i] for i in tri]
            if any(v is None for v in verts):
                continue
            built = []
            for v in verts:
                x, y, z, s, t, a, b, c, d = v
                pos = apply(m, (x, y, z))
                if state["lit"]:
                    n = [((q + 128) % 256 - 128) / 127.0 for q in (a, b, c)]
                    n = apply(m, n, 0.0)
                    ln = math.sqrt(sum(q * q for q in n)) or 1.0
                    nrm = tuple(q / ln for q in n)
                    col = (255, 255, 255, d)
                else:
                    nrm = None
                    col = (a, b, c, d)
                built.append({"pos": pos, "nrm": nrm, "uv": (s / 32.0 / w, t / 32.0 / h), "col": col})
            fn = face_normal([v["pos"] for v in built])
            for v in built:
                if v["nrm"] is None:
                    v["nrm"] = fn
            out.add(key, built)


def face_normal(p):
    ux, uy, uz = (p[1][i] - p[0][i] for i in range(3))
    vx, vy, vz = (p[2][i] - p[0][i] for i in range(3))
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    ln = math.sqrt(sum(q * q for q in n)) or 1.0
    return tuple(q / ln for q in n)


def run_geo(dec, name, matrix, out, depth=0):
    """Walks a geo layout, running its display lists with node transforms."""
    stack = []
    current = matrix
    last = matrix
    billboard_level = None
    level = 0
    for macro, args in dec.geo.get(name, []):
        if macro == "GEO_OPEN_NODE":
            stack.append(current)
            current = last
            level += 1
        elif macro == "GEO_CLOSE_NODE":
            current = stack.pop() if stack else matrix
            last = current
            level -= 1
            if billboard_level is not None and level < billboard_level:
                billboard_level = None
        elif macro == "GEO_DISPLAY_LIST":
            run_display_list(dec, args[1], current, args[0], out, billboard_level is not None)
            last = current
        elif macro in ("GEO_TRANSLATE_NODE", "GEO_TRANSLATE_NODE_WITH_DL", "GEO_ANIMATED_PART", "GEO_TRANSLATE"):
            # GEO_TRANSLATE_NODE(layer, x, y, z[, dl]); GEO_ANIMATED_PART(layer, x, y, z, dl)
            x, y, z = (num(a) for a in args[1:4])
            last = mat_mul(current, translate(x, y, z))
            if len(args) > 4 and args[4] not in ("NULL", "0"):
                run_display_list(dec, args[4], last, args[0], out, billboard_level is not None)
        elif macro in ("GEO_SCALE", "GEO_SCALE_WITH_DL"):
            last = mat_mul(current, scale_m(num(args[1]) / 65536.0))
            if len(args) > 2:
                run_display_list(dec, args[2], last, args[0], out, billboard_level is not None)
        elif macro in ("GEO_BILLBOARD", "GEO_BILLBOARD_WITH_PARAMS"):
            billboard_level = level + 1
            last = current
        elif macro == "GEO_BRANCH" and depth < 8:
            run_geo(dec, args[1], current, out, depth + 1)
        elif macro in ("GEO_RETURN", "GEO_END"):
            break


# ---------- collision ----------

SM64_TO_SURFACE = {
    "SURFACE_SLIPPERY": "slide",
    "SURFACE_NOISE_SLIPPERY": "slide",
    "SURFACE_HARD_SLIPPERY": "slide",
    "SURFACE_NO_CAM_COL_SLIPPERY": "slide",
    "SURFACE_NOISE_SLIPPERY_73": "slide",
    "SURFACE_NOISE_SLIPPERY_74": "slide",
    "SURFACE_VERY_SLIPPERY": "ice",
    "SURFACE_NOISE_VERY_SLIPPERY": "ice",
    "SURFACE_NOISE_VERY_SLIPPERY_73": "ice",
    "SURFACE_NOISE_VERY_SLIPPERY_74": "ice",
    "SURFACE_HARD_VERY_SLIPPERY": "ice",
    "SURFACE_ICE": "ice",
    "SURFACE_BURNING": "oob",
    "SURFACE_DEATH_PLANE": "oob",
    "SURFACE_INSTANT_QUICKSAND": "oob",
    "SURFACE_DEEP_QUICKSAND": "oob",
    "SURFACE_QUICKSAND": "sand",
    "SURFACE_SHALLOW_QUICKSAND": "sand",
    "SURFACE_WALL_MISC": "solid",
    "SURFACE_HANGABLE": "solid",
}


# SM64 floor classes and the steepest slope Mario can stand on for each (mario_floor_is_slippery).
VERY_SLIPPERY = {"SURFACE_VERY_SLIPPERY", "SURFACE_ICE", "SURFACE_HARD_VERY_SLIPPERY", "SURFACE_NOISE_VERY_SLIPPERY",
                 "SURFACE_NOISE_VERY_SLIPPERY_73", "SURFACE_NOISE_VERY_SLIPPERY_74", "SURFACE_NO_CAM_COL_VERY_SLIPPERY"}
SLIPPERY = {"SURFACE_SLIPPERY", "SURFACE_NOISE_SLIPPERY", "SURFACE_HARD_SLIPPERY", "SURFACE_NO_CAM_COL_SLIPPERY",
            "SURFACE_NOISE_SLIPPERY_73", "SURFACE_NOISE_SLIPPERY_74"}
NOT_SLIPPERY = {"SURFACE_NOT_SLIPPERY", "SURFACE_HARD_NOT_SLIPPERY", "SURFACE_SWITCH"}
STAND_LIMIT = {"very": 0.9848077, "slippery": 0.9396926, "default": 0.7880108, "not": 0.0}  # minimum normal.y


def classify(kind, normal):
    """Our surface for an SM64 collision triangle: slide where Mario would slide, ice for walkable very slippery floor."""
    fixed = {"SURFACE_BURNING": "oob", "SURFACE_DEATH_PLANE": "oob", "SURFACE_INSTANT_QUICKSAND": "oob", "SURFACE_DEEP_QUICKSAND": "oob",
             "SURFACE_QUICKSAND": "sand", "SURFACE_SHALLOW_QUICKSAND": "sand", "SURFACE_WALL_MISC": "solid", "SURFACE_HANGABLE": "solid"}
    if kind in fixed:
        return fixed[kind]
    if normal[1] < 0.1:
        return "rough"  # walls: nobody stands on them
    cls = "very" if kind in VERY_SLIPPERY else "slippery" if kind in SLIPPERY else "not" if kind in NOT_SLIPPERY else "default"
    if normal[1] < STAND_LIMIT[cls]:
        return "slide"
    return "ice" if cls == "very" else "rough"


def collision_triangles(dec, name):
    verts, tris, kind = [], [], None
    for macro, args in dec.collision.get(name, []):
        if macro == "COL_VERTEX":
            verts.append(tuple(num(a) for a in args))
        elif macro == "COL_TRI_INIT":
            kind = args[0]
        elif macro in ("COL_TRI", "COL_TRI_SPECIAL"):
            a, b, c = (num(x) for x in args[:3])
            tris.append((kind, verts[a], verts[b], verts[c]))
    return tris


def nearest_texture(cells, centroid, normal, cell):
    """Texture of the visual triangle closest to a collision triangle's centroid, preferring similar facing."""
    cx, cy, cz = (int(math.floor(centroid[i] / cell)) for i in range(3))
    best, best_d = None, float("inf")
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for tex, c, n in cells.get((cx + dx, cy + dy, cz + dz), ()):
                    d = math.dist(c, centroid) * (2.0 - max(0.0, sum(n[i] * normal[i] for i in range(3))))
                    if d < best_d:
                        best, best_d = tex, d
    return best


# ---------- objects ----------

BEHAVIOUR = {"bhvSeesawPlatform": "seesaw"}

# Ball spawners: which trajectory each spawner type rolls along (from bowling_ball.inc.c).
ROLLER_SPAWNERS = {"bhvBoBBowlingBallSpawner", "bhvTTMBowlingBallSpawner", "bhvThiBowlingBallSpawner"}
ROLLER_PATHS = {"BBALL_BP_STYPE_BOB_UPPER": "bob_seg7_metal_ball_path0", "BBALL_BP_STYPE_BOB_LOWER": "bob_seg7_metal_ball_path1",
                "BBALL_BP_STYPE_TTM": "ttm_seg7_trajectory_070170A0"}
# Checkerboard elevator groups (checkerboard_platform.inc.c): two platforms on a vertical loop around a pole.
ELEVATOR_TYPES = {0: (145, (0.7, 1.5, 0.7)), 1: (235, (1.2, 2.0, 1.2))}  # (loop radius, platform scale)
ELEVATOR_SPEED = 300  # units per second (10 per frame)

# Chain chomp (chain_chomp.inc.c): hitbox radius 80, chain 750 units, stretches to 900 when lunging.
CHOMP = {"radius": 80, "reach": 900, "idleReach": 450, "lungeSpeed": 3000}

# SM64 bowling ball: hitbox radius 100 units, rolls at about 28 units per frame (30 fps), one every ~2-4 s.
ROLLER_DEFAULTS = {"radius": 100, "speed": 750, "interval": 3.5}

# Characters, enemies and collectibles are not level pieces; left out unless --all-objects is given.
NOT_SCENERY = re.compile(r"bhv(KingBobomb|Koopa|Star|HiddenStar|HiddenRedCoinStar|PitBowlingBall|BobombBuddy\w*|Bobomb|Goomba\w*|"
                         r"Mario|RecoveryHeart|1Up\w*|Hidden1Up\w*|WaterBombCannon|Cannon$|CannonBarrel\w*|\w*Coin\w*|RedCoin\w*|OneUp\w*|Butterfly|Bird\w*|Fish\w*|Bubba|Piranha\w*)")


def level_objects(dec, script_path, area, special_presets):
    text = strip_comments(open(script_path, encoding="utf-8").read())
    # Objects inside AREA(area, ...) ... END_AREA(), including local scripts it reaches through JUMP_LINK.
    m = re.search(r"AREA\s*\(\s*" + str(area) + r"\s*,.*?END_AREA\s*\(\s*\)", text, flags=re.S)
    body = m.group(0) if m else text
    scripts = {n.group(1): n.group(2) for n in re.finditer(r"LevelScript\s+(\w+)\s*\[\s*\]\s*=\s*\{(.*?)\};", text, flags=re.S)}
    seen = set()
    pending = re.findall(r"JUMP_LINK\s*\(\s*(\w+)\s*\)", body)
    while pending:
        name = pending.pop()
        if name in seen or name not in scripts:
            continue
        seen.add(name)
        body += scripts[name]
        pending += re.findall(r"JUMP_LINK\s*\(\s*(\w+)\s*\)", scripts[name])
    objs = []
    for c in CALL.finditer(body):
        if c.group(1) in ("OBJECT", "OBJECT_WITH_ACTS"):
            a = split_args(c.group(2))
            objs.append({"model": a[0], "pos": [num(x) for x in a[1:4]], "rot": [num(x) for x in a[4:7]], "param": a[7], "behavior": a[8]})
    return objs


def special_objects(dec, collision_name, presets):
    objs = []
    for macro, args in dec.collision.get(collision_name, []):
        if macro.startswith("SPECIAL_OBJECT"):
            preset = presets.get(args[0])
            if not preset:
                continue
            pos = [num(x) for x in args[1:4]]
            yaw = num(args[4]) * 360.0 / 256.0 if len(args) > 4 and macro != "SPECIAL_OBJECT" else 0.0
            objs.append({"model": preset[0], "pos": pos, "rot": [0, yaw, 0], "behavior": preset[1]})
    return objs


def macro_objects(dec, root, level, area):
    """MACRO_OBJECT placements (enemies, posts, chomps...) with their preset's model and behaviour."""
    presets = {}
    for m in re.finditer(r"/\*\s*(macro_\w+)\s*\*/\s*\{\s*(\w+)\s*,\s*(\w+)\s*,", open(os.path.join(root, "include", "macro_presets.inc.c")).read()):
        presets[m.group(1)] = (m.group(3), m.group(2))
    path = os.path.join(root, "levels", level, "areas", str(area), "macro.inc.c")
    if not os.path.exists(path):
        return []
    objs = []
    for c in CALL.finditer(strip_comments(open(path).read())):
        if c.group(1).startswith("MACRO_OBJECT"):
            a = split_args(c.group(2))
            if len(a) >= 5 and a[0] in presets:
                model, bhv = presets[a[0]]
                objs.append({"model": model, "pos": [num(x) for x in a[2:5]], "rot": [0, num(a[1]) * 360.0 / 256.0 if "." not in a[1] else num(a[1]), 0], "behavior": bhv})
    return objs


def sphere_mesh(radius, rings=12, segments=20):
    """A UV sphere as MeshBuilder parts (used for the rolling balls, which SM64 draws as flat sprites)."""
    out = MeshBuilder()
    def p(i, j):
        th, ph = math.pi * i / rings, 2 * math.pi * j / segments
        n = (math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph))
        return {"pos": tuple(radius * q for q in n), "nrm": n, "uv": (j / segments, i / rings), "col": (255, 255, 255, 255)}
    for i in range(rings):
        for j in range(segments):
            a, b, c, d = p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)
            out.add(("ball",), [a, c, b])
            out.add(("ball",), [a, d, c])
    return out


def loop_path(height, r, steps=12):
    """Vertical loop: up one side, half circle over the top, down the other side, half circle underneath."""
    pts = [(0, 0, -r)]
    pts += [(0, height + r * math.cos(f), r * math.sin(f)) for f in (math.radians(-90 + 180 * k / steps) for k in range(steps + 1))]
    pts += [(0, r * math.cos(f), r * math.sin(f)) for f in (math.radians(90 + 180 * k / steps) for k in range(steps + 1))]
    return [list(q) for q in pts]


def load_special_presets(root):
    presets = {}
    path = os.path.join(root, "include", "special_presets.inc.c")
    for m in re.finditer(r"\{\s*(special_\w+)\s*,\s*\w+\s*,\s*\w+\s*,\s*(\w+)\s*,\s*(\w+)\s*\}", open(path).read()):
        presets[m.group(1)] = (m.group(2), m.group(3))
    return presets


# ---------- glb writing ----------

class GlbWriter:
    def __init__(self):
        self.bin = bytearray()
        self.gltf = {"asset": {"version": "2.0", "generator": "sbg-maps sm64_to_glb"}, "buffers": [], "bufferViews": [],
                     "accessors": [], "meshes": [], "materials": [], "textures": [], "images": [], "samplers": [{"wrapS": 10497, "wrapT": 10497}],
                     "nodes": [], "scenes": [{"nodes": []}], "scene": 0}
        self.material_index = {}
        self.image_index = {}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.bin.extend(data)
        self.gltf["bufferViews"].append(v)
        return len(self.gltf["bufferViews"]) - 1

    def accessor(self, values, kind, comp=5126, normalized=False):
        flat = [x for v in values for x in v]
        fmt = {5126: "f", 5121: "B", 5125: "I"}[comp]
        data = struct.pack("<%d%s" % (len(flat), fmt), *flat)
        acc = {"bufferView": self.view(data, 34962), "componentType": comp, "count": len(values), "type": kind}
        if normalized:
            acc["normalized"] = True
        if kind == "VEC3" and comp == 5126:
            acc["min"] = [min(v[i] for v in values) for i in range(3)]
            acc["max"] = [max(v[i] for v in values) for i in range(3)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def image(self, path):
        if path in self.image_index:
            return self.image_index[path]
        with open(path, "rb") as f:
            data = f.read()
        self.gltf["images"].append({"bufferView": self.view(data), "mimeType": "image/png", "name": os.path.basename(path)})
        self.gltf["textures"].append({"source": len(self.gltf["images"]) - 1, "sampler": 0})
        self.image_index[path] = len(self.gltf["textures"]) - 1
        return self.image_index[path]

    def material(self, key, name, texture_path, extras, alpha):
        if key in self.material_index:
            return self.material_index[key]
        mat = {"name": name, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": True, "extras": extras}
        if texture_path and os.path.exists(texture_path):
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": self.image(texture_path)}
        if alpha == "mask":
            mat["alphaMode"] = "MASK"
            mat["alphaCutoff"] = 0.5
        elif alpha == "blend":
            mat["alphaMode"] = "BLEND"
        self.gltf["materials"].append(mat)
        self.material_index[key] = len(self.gltf["materials"]) - 1
        return self.material_index[key]

    def mesh(self, name, primitives):
        self.gltf["meshes"].append({"name": name, "primitives": primitives})
        return len(self.gltf["meshes"]) - 1

    def node(self, node, root=True):
        self.gltf["nodes"].append(node)
        i = len(self.gltf["nodes"]) - 1
        if root:
            self.gltf["scenes"][0]["nodes"].append(i)
        return i

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.gltf["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.gltf, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin)))
            f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin))


def primitive_for(writer, part, material, with_colors):
    prim = {"attributes": {"POSITION": writer.accessor(part["pos"], "VEC3"), "NORMAL": writer.accessor(part["nrm"], "VEC3"),
                           "TEXCOORD_0": writer.accessor(part["uv"], "VEC2")}, "material": material, "mode": 4}
    if with_colors:
        prim["attributes"]["COLOR_0"] = writer.accessor(part["col"], "VEC4", comp=5121, normalized=True)
    return prim


def alpha_for(layer):
    if "ALPHA" in layer:
        return "mask"
    if "TRANSPARENT" in layer or "XLU" in layer:
        return "blend"
    return None


def texture_label(dec, tex):
    return os.path.basename(dec.textures.get(tex, tex or "untextured")).replace(".png", "")


# ---------- main ----------

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    all_objects = "--all-objects" in sys.argv
    root, level, area, out_path = args[0], args[1], int(args[2]), args[3]
    dec = Decomp(root)
    for path in [os.path.join(root, "levels", level, f) for f in ("leveldata.c", "geo.c", "script.c")] + \
            [os.path.join(root, "bin", f) for f in sorted(os.listdir(os.path.join(root, "bin"))) if f.endswith(".c")] + \
            [os.path.join(root, "levels", "scripts.c")]:
        dec.load_file(path)
    # Actor geos/models that level objects use (trees etc.).
    for group in sorted(os.listdir(os.path.join(root, "actors"))):
        if group.endswith((".c",)) and not group.startswith("."):
            dec.load_file(os.path.join(root, "actors", group))
    print(f"parsed: {len(dec.vtx)} vertex arrays, {len(dec.gfx)} display lists, {len(dec.geo)} geo layouts, {len(dec.textures)} textures")

    script = os.path.join(root, "levels", level, "script.c")
    script_text = strip_comments(open(script).read())
    area_m = re.search(r"AREA\s*\(\s*%d\s*,\s*(\w+)\s*\)(.*?)END_AREA" % area, script_text, flags=re.S)
    area_geo = area_m.group(1)
    collision_name = re.search(r"TERRAIN\s*\(\s*(\w+)\s*\)", area_m.group(2)).group(1)

    writer = GlbWriter()

    # Visual level.
    visual = MeshBuilder()
    run_geo(dec, area_geo, IDENTITY, visual)
    prims = []
    for (tex, lit, layer), part in visual.parts.items():
        label = texture_label(dec, tex)
        mat = writer.material(("v", tex, lit, layer), f"{label}{'' if lit else ' (shaded)'}", dec.textures.get(tex), {"surface": "none", "renderOnly": True}, alpha_for(layer))
        prims.append(primitive_for(writer, part, mat, with_colors=not lit))
    writer.node({"name": "level", "mesh": writer.mesh("level", prims)})
    tri_count = sum(len(p["pos"]) for p in visual.parts.values()) // 3
    print(f"level: {tri_count} triangles in {len(prims)} materials")

    # Collision, split by SM64 surface type and the texture of the visual geometry it sits on.
    cell = 400.0
    cells = {}
    for (tex, lit, layer), part in visual.parts.items():
        if "ALPHA" in layer or "TRANSPARENT" in layer:
            continue
        p = part["pos"]
        for i in range(0, len(p), 3):
            c = tuple((p[i][k] + p[i + 1][k] + p[i + 2][k]) / 3 for k in range(3))
            n = face_normal(p[i:i + 3])
            cells.setdefault(tuple(int(math.floor(c[k] / cell)) for k in range(3)), []).append((tex, c, n))
    col = MeshBuilder()
    for kind, a, b, c in collision_triangles(dec, collision_name):
        centroid = tuple((a[k] + b[k] + c[k]) / 3 for k in range(3))
        n = face_normal([a, b, c])
        tex = nearest_texture(cells, centroid, n, cell)
        col.add((kind, tex, classify(kind, n)), [{"pos": v, "nrm": n, "uv": (0, 0), "col": (255, 255, 255, 255)} for v in (a, b, c)])
    prims = []
    for (kind, tex, surface), part in sorted(col.parts.items(), key=lambda kv: (kv[0][0], str(kv[0][1]), kv[0][2])):
        label = f"{texture_label(dec, tex)} / {kind.replace('SURFACE_', '').lower()}{' (steep)' if surface == 'slide' else ''}"
        mat = writer.material(("c", kind, tex, surface), label, dec.textures.get(tex), {"surface": surface, "invisible": True, "sm64Surface": kind}, None)
        prims.append(primitive_for(writer, part, mat, with_colors=False))
    writer.node({"name": "collision", "mesh": writer.mesh("collision", prims)})
    print(f"collision: {sum(len(p['pos']) for p in col.parts.values()) // 3} triangles in {len(prims)} groups")

    # Objects.
    presets = load_special_presets(root)
    objs = level_objects(dec, script, area, presets) + special_objects(dec, collision_name, presets) + macro_objects(dec, root, level, area)
    # The chain chomp stands on its own post.
    objs += [{**o, "model": "MODEL_WOODEN_POST", "behavior": "bhvWoodenPost", "rot": [0, 0, 0]} for o in objs if o["behavior"] == "bhvChainChomp"]
    placed = 0
    seen = set()
    for i, o in enumerate(objs):
        extras = {}
        mesh_override = None
        if o["behavior"] == "bhvCheckerboardElevatorGroup":
            params = re.findall(r"BPARAM(\d)\((\d+)\)", o.get("param", ""))
            p = {int(k): int(v) for k, v in params}
            radius, scale = ELEVATOR_TYPES.get(p.get(1, 0), ELEVATOR_TYPES[0])
            height = (p.get(2) or 65) * 10
            mesh_override = MeshBuilder()
            run_geo(dec, dec.models["MODEL_CHECKERBOARD_PLATFORM"], [[scale[0], 0, 0, 0], [0, scale[1], 0, 0], [0, 0, scale[2], 0], [0, 0, 0, 1]], mesh_override)
            extras = {"object": "mover", "path": loop_path(height, radius), "loop": True, "count": 2, "speed": ELEVATOR_SPEED}
        elif o["behavior"] == "bhvChainChomp":
            extras = {"object": "chomp", **CHOMP}
        elif o["behavior"] in ROLLER_SPAWNERS:
            # Invisible spawner: becomes a roller that carries the ball model and its path (relative to the node).
            path = dec.trajectories.get(ROLLER_PATHS.get(re.sub(r"BPARAM2\((\w+)\)", r"\1", o.get("param", "")), ""))
            if not path:
                continue
            o = {**o, "model": "MODEL_BOWLING_BALL", "pos": list(path[0]), "rot": [0, 0, 0]}
            extras = {"object": "roller", "path": [[p[k] - path[0][k] for k in range(3)] for p in path], **ROLLER_DEFAULTS}
            mesh_override = sphere_mesh(ROLLER_DEFAULTS["radius"])
        elif not all_objects and NOT_SCENERY.match(o["behavior"]):
            continue
        # SM64 places some objects once per star act; keep one of each.
        key = (tuple(o["pos"]), o["model"], extras.get("object"))
        if key in seen:
            continue
        seen.add(key)
        mesh = mesh_override or MeshBuilder()
        if mesh_override:
            pass
        elif o["model"] in dec.models:
            run_geo(dec, dec.models[o["model"]], IDENTITY, mesh)
        elif o["model"] in dec.models_dl:
            dl, layer = dec.models_dl[o["model"]]
            run_display_list(dec, dl, IDENTITY, layer, mesh)
        if not mesh.parts:
            continue
        behaviour = extras.get("object") or BEHAVIOUR.get(o["behavior"], "static")
        surface = {"seesaw": "bridge", "roller": "none", "chomp": "none", "mover": "rough"}.get(behaviour, "solid")
        prims = []
        if mesh_override is not None and ("ball",) in mesh.parts:
            # Dark polished metal, like SM64's iron balls.
            mat = writer.material(("ballmat",), "iron ball", None, {"surface": "none"}, None)
            writer.gltf["materials"][mat]["pbrMetallicRoughness"].update({"baseColorFactor": [0.12, 0.12, 0.14, 1], "metallicFactor": 0.8, "roughnessFactor": 0.3})
            prims.append(primitive_for(writer, mesh.parts[("ball",)], mat, with_colors=False))
        for key, part in mesh.parts.items():
            if key == ("ball",):
                continue
            tex, lit, layer = key
            label = f"{o['model'].replace('MODEL_', '').lower()}: {texture_label(dec, tex)}"
            mat = writer.material(("o", o["model"], tex, lit, layer), label, dec.textures.get(tex), {"surface": surface}, alpha_for(layer))
            prims.append(primitive_for(writer, part, mat, with_colors=not lit))
        # SM64 applies yaw, then pitch, then roll; glTF quaternion for R = Ry * Rx * Rz.
        q = quat_mul(quat_mul(quat_axis((0, 1, 0), o["rot"][1]), quat_axis((1, 0, 0), o["rot"][0])), quat_axis((0, 0, 1), o["rot"][2]))
        writer.node({"name": f"{o['model'].replace('MODEL_', '').lower()} {i}", "mesh": writer.mesh(o["model"], prims),
                     "translation": o["pos"], "rotation": q, "extras": {"object": behaviour, "sm64Behavior": o["behavior"], **extras}})
        placed += 1
    skipped = sorted({o["model"] for o in objs if o["model"] not in dec.models and o["model"] not in dec.models_dl and o["behavior"] not in ROLLER_SPAWNERS})
    print(f"objects: {placed} placed" + (f"; skipped (no model in this level): {', '.join(skipped)}" if skipped else ""))

    writer.write(out_path)
    print(f"wrote {out_path} ({os.path.getsize(out_path) // 1024} KB)")


def quat_axis(axis, deg):
    h = math.radians(deg) / 2
    s = math.sin(h)
    return (axis[0] * s, axis[1] * s, axis[2] * s, math.cos(h))


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


main()
