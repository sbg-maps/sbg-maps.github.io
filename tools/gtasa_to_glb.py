"""Convert an area of the Grand Theft Auto: San Andreas map (classic PC version) into .glb files for the SBG map editor.

usage: gtasa_to_glb.py <game dir> <out.glb> (--preset NAME | --box X1,Y1,X2,Y2) [options]
       gtasa_to_glb.py <game dir> --grid <out dir> [--presets <out dir>] [--index sections.json] [options]
example: gtasa_to_glb.py "~/.steam/steam/steamapps/common/Grand Theft Auto San Andreas" grove.glb --preset grove_street

Reads the game folder directly and never writes to it: data/gta.dat for the IDE and IPL lists, every IDE object
definition (objs, tobj, anim), every IPL placement (the text IPLs plus the binary *_streamN.ipl files inside
models/gta3.img), the DFF models and TXD texture dictionaries from models/gta3.img, data/water.dat and the zone
names (data/info.zon with text/american.gxt) for naming grid sections. Writes:
- node "world": every detailed model placed in the area, merged by material. Vertex prelight colours (doubled,
  as the game draws them, times the material colour) are kept as COLOR_0; textures are downscaled to --max-tex
  and shared by content. Textures with cut-out alpha (fences, foliage, signs) are alphaMode MASK. Render geometry
  doubles as collision (extras.surface "rough"); the alpha-textured parts of trees and plants (IDE tree/palm
  flags or names like tree, bush, palm, veg) are render only, so balls and players pass through the leaves but
  not the trunks.
- node "water": the water.dat polygons cut to the area, a see-through blue render-only surface.
Left out: LOD models (any placement another one names as its LOD, and lod/islandlod model names), interiors
(placements with an interior id other than 0 or 13, the data/maps/interior IPLs and their pools), the Liberty
City piece in the sky, night-only timed objects (lights that switch on after dark), additive glow models and
damaged variants of breakable models.
Objects are picked by their placement position and kept whole, so neighbouring sections overlap a little at the
edges. Big terrain pieces placed just outside also fill the edge. The editor takes at most 900 x 900 m, so the
triangles of the few models that reach past a 896 m square around the section centre are left out. When a section
is over --max-tris or --max-mb, the smallest props are dropped first (by bounding size).

Coordinates: GTA's world frame G is z-up in metres (x east, y north, z up). glTF is y-up and right-handed, and
the SBG map frame is glTF with z flipped (east, up, north):
    glTF (x, y, z) = (Gx - cx, Gz - ground, -(Gy - cy))
so map x runs east, map z runs north and nothing is mirrored (both frames are right-handed). (cx, cy) is the
centre of the cut-out area and `ground` the lowest model point in it, so the model sits on y = 0. An IPL
placement turns a model by the conjugate of its stored quaternion (x, y, z, w) and then moves it to its position.
Each file records where it sits in the world in its root scene extras, {"source": "gtasa", "worldOrigin":
[cx, ground, -cy]}: glTF world position = local position + worldOrigin, with the glTF world frame being
(Gx, Gz, -Gy). Several sections placed at their worldOrigin line up as in the game (sections.json lists it too).
"""
import argparse
import hashlib
import io
import json
import os
import re
import struct
import sys
import zlib

import numpy as np
from PIL import Image

PRESETS = {
    # Boxes in G coordinates (x1, y1, x2, y2), metres; each side 850 m or less.
    # Los Santos.
    "grove_street": (1830.0, -2060.0, 2670.0, -1260.0),       # Grove Street, Ganton, Idlewood, Jefferson
    "santa_maria_beach": (60.0, -2260.0, 900.0, -1480.0),     # Santa Maria Beach, the pier, Verona Beach
    "downtown_ls": (1170.0, -1600.0, 1990.0, -780.0),         # Downtown, Pershing Square, the tall towers
    "vinewood": (650.0, -1260.0, 1490.0, -430.0),             # Vinewood, Mulholland and the Vinewood sign
    # San Fierro and the countryside around it.
    "sf_downtown": (-2330.0, 440.0, -1490.0, 1280.0),         # Downtown, Calton Heights, Chinatown, Juniper Hill
    "avispa_country_club": (-2970.0, -750.0, -2130.0, 90.0),  # SF golf course, Missionary Hill, Ocean Flats
    "bayside": (-2870.0, 2030.0, -2030.0, 2870.0),            # Bayside marina and the Gant Bridge north end
    "mount_chiliad": (-2760.0, -2080.0, -1920.0, -1240.0),    # the summit and the cable car slopes
    "angel_pine": (-2600.0, -2780.0, -1760.0, -1980.0),       # Angel Pine and Shady Creeks
    "back_o_beyond": (-1165.0, -2670.0, -325.0, -1830.0),     # Back o Beyond, the woods south of Flint County
    # Red County and Bone County.
    "red_county": (1950.0, -380.0, 2790.0, 460.0),            # Palomino Creek and the farmland around it
    "dillimore": (300.0, -960.0, 1140.0, -120.0),             # Dillimore and the Red County hills around it
    "verdant_meadows": (-180.0, 2090.0, 660.0, 2930.0),       # the abandoned airfield
    "fort_carson": (-546.0, 603.0, 294.0, 1443.0),            # Fort Carson and the desert around it
    # Las Venturas.
    "las_venturas_strip": (1670.0, 1110.0, 2510.0, 1950.0),   # The Strip, the casinos, Come-A-Lot
    "yellow_bell_golf": (900.0, 2300.0, 1740.0, 3000.0),      # Yellow Bell Golf Course and Prickle Pine
}

GRID_MIN, GRID_MAX, GRID_N = -3000.0, 3000.0, 8  # 8 x 8 sections of 750 m
LIMIT = 896.0  # the editor takes levels up to 900 x 900 m
BIG, REACH = 30.0, 400.0  # models this big (radius) placed up to REACH outside a section still fill its edge

FOLIAGE = re.compile(r"tree|bush|shrub|palm|plant|veg|leaf|leaves|foliage|flower|grass|ivy|vine|fern|hedge|weed|cact|"
                     r"pine|oak|elm|cedar|birch|sprig|branch|reed|frond|yucca|agave|joshua|sagebrush|tumbleweed", re.I)
LOD_NAME = re.compile(r"^lod|lod$|islandlod|_lod|lod_", re.I)

# IDE object flags (San Andreas).
F_ADDITIVE = 0x8
F_NO_ZWRITE = 0x40
F_TREE = 0x2000
F_PALM = 0x4000
F_NO_CULL = 0x200000


def warn(msg):
    print("  " + msg)


# ---------- game files ----------

class Img:
    """models/gta3.img, IMG version 2 ("VER2"): a directory of 32 byte entries, data in 2048 byte sectors."""

    def __init__(self, path):
        self.f = open(path, "rb")
        head = self.f.read(8)
        if head[:4] != b"VER2":
            sys.exit(f"{path}: not an IMG version 2 archive (classic PC San Andreas)")
        n = struct.unpack_from("<I", head, 4)[0]
        table = self.f.read(32 * n)
        self.entries = {}
        for i in range(n):
            off, stream, archived, name = struct.unpack_from("<IHH24s", table, 32 * i)
            self.entries[name.split(b"\0")[0].decode("latin1").lower()] = (off, archived or stream)

    def read(self, name):
        e = self.entries.get(name.lower())
        if e is None:
            return None
        self.f.seek(e[0] * 2048)
        return self.f.read(e[1] * 2048)


class Game:
    """Case-insensitive access to the game folder (read only)."""

    def __init__(self, root):
        self.root = root
        self.files = {}
        for d, _, names in os.walk(root):
            for n in names:
                p = os.path.join(d, n)
                self.files[os.path.relpath(p, root).replace("\\", "/").lower()] = p
        img = self.path("models/gta3.img")
        if not img:
            sys.exit(f"no models/gta3.img under {root}")
        self.img = Img(img)

    def path(self, rel):
        return self.files.get(rel.replace("\\", "/").lower())

    def text(self, rel):
        p = self.path(rel)
        if p is None:
            return None
        with open(p, "rb") as f:
            return f.read().decode("latin1")


def data_lines(text, sections):
    """(section, fields) for the lines inside the given IDE/IPL sections."""
    sec = None
    for line in text.splitlines():
        line = line.split("#")[0].strip()
        if not line:
            continue
        if "," not in line and len(line.split()) == 1:  # a section name or "end"
            sec = None if line.lower() == "end" else line.lower()
            continue
        if sec in sections:
            yield sec, [f.strip() for f in line.split(",")]


class ObjectDef:
    __slots__ = ("id", "model", "txd", "dist", "flags", "night_only", "source")


def load_definitions(game, ide_files):
    """id -> ObjectDef for every objs, tobj and anim line, plus the txd parent map."""
    defs, parents = {}, {}
    for rel in ide_files:
        text = game.text(rel)
        if text is None:
            warn(f"missing {rel}")
            continue
        for sec, f in data_lines(text, ("objs", "tobj", "anim", "txdp")):
            try:
                if sec == "txdp":
                    parents[f[0].lower()] = f[1].lower()
                    continue
                d = ObjectDef()
                d.id, d.model, d.txd = int(f[0]), f[1].lower(), f[2].lower()
                d.night_only = False
                d.source = rel
                if sec == "anim":
                    d.dist, d.flags = float(f[4]), int(f[5])
                else:
                    tail = f[3:]
                    if sec == "tobj":
                        t_on, t_off = int(tail[-2]), int(tail[-1])
                        tail = tail[:-2]
                        d.night_only = t_on > t_off  # e.g. 20 -> 6: lit windows and neon at night
                    if len(tail) == 2:
                        d.dist, d.flags = float(tail[0]), int(tail[1])
                    else:  # id, model, txd, mesh count, distances..., flags
                        d.dist, d.flags = float(tail[1]), int(tail[-1])
                defs[d.id] = d
            except (ValueError, IndexError):
                continue
    return defs, parents


class Inst:
    __slots__ = ("id", "name", "interior", "pos", "rot", "lod", "ipl", "index")


def load_placements(game, ipl_files):
    """All inst entries: text IPLs from gta.dat and their binary streams in gta3.img. The lod field of an entry
    is an index into the inst list of the text IPL of the same name; returns (placements, set of LOD keys)."""
    out, lods = [], set()
    bases = {}
    for rel in ipl_files:
        text = game.text(rel)
        if text is None:
            continue
        base = os.path.splitext(os.path.basename(rel.replace("\\", "/")))[0].lower()
        bases[base] = rel
        n = 0
        for sec, f in data_lines(text, ("inst",)):
            try:
                i = Inst()
                i.id, i.name, i.interior = int(f[0]), f[1].lower(), int(f[2])
                i.pos = (float(f[3]), float(f[4]), float(f[5]))
                i.rot = (float(f[6]), float(f[7]), float(f[8]), float(f[9]))
                i.lod = int(f[10]) if len(f) > 10 else -1
            except (ValueError, IndexError):
                continue
            i.ipl, i.index = base, n
            n += 1
            out.append(i)
            if i.lod >= 0:
                lods.add((base, i.lod))
    for name in sorted(game.img.entries):
        m = re.match(r"(.+)_stream\d+\.ipl$", name)
        if not m or m.group(1) not in bases:
            continue  # scripted extras (crack den, Truth's farm, bridge barriers) are not part of the map
        raw = game.img.read(name)
        if not raw or raw[:4] != b"bnry":
            continue
        count = struct.unpack_from("<I", raw, 4)[0]
        ofs = struct.unpack_from("<I", raw, 28)[0]
        for k in range(count):
            x, y, z, rx, ry, rz, rw, mid, interior, lod = struct.unpack_from("<7f3i", raw, ofs + 40 * k)
            i = Inst()
            i.id, i.name, i.interior = mid, None, interior
            i.pos, i.rot, i.lod = (x, y, z), (rx, ry, rz, rw), lod
            i.ipl, i.index = name, -1
            out.append(i)
            if lod >= 0:
                lods.add((m.group(1), lod))
    return out, lods


def load_water(game):
    """Water polygons from data/water.dat: lists of (x, y, z) corners in drawing order."""
    text = game.text("data/water.dat") or ""
    polys = []
    for line in text.splitlines():
        v = line.split()
        if len(v) < 22:
            continue
        try:
            nums = [float(t) for t in v]
        except ValueError:
            continue
        nverts = 4 if len(nums) >= 29 else 3
        corners = [tuple(nums[7 * k:7 * k + 3]) for k in range(nverts)]
        if nverts == 4:  # grid order (x1,y1) (x2,y1) (x1,y2) (x2,y2) -> outline
            corners = [corners[0], corners[1], corners[3], corners[2]]
        if max(c[2] for c in corners) < 400:  # pools of interiors, which float high above the map
            polys.append(corners)
    return polys


def load_zones(game):
    """[(name, area, x1, y1, x2, y2)] from info.zon, names translated through american.gxt when possible."""
    text = game.text("data/info.zon") or ""
    gxt = read_gxt(game.path("text/american.gxt"))
    zones = []
    for _, f in data_lines(text, ("zone",)):
        try:
            x1, y1, x2, y2 = float(f[2]), float(f[3]), float(f[5]), float(f[6])
        except (ValueError, IndexError):
            continue
        key = f[-1].strip().upper()
        name = gxt.get(key, key)
        zones.append((name, abs(x2 - x1) * abs(y2 - y1), min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)))
    return zones


def read_gxt(path):
    """Main table of a San Andreas GXT: key -> text (keys are found by their JAMCRC hash)."""
    if not path:
        return {}
    with open(path, "rb") as f:
        raw = f.read()
    try:
        ver, bits = struct.unpack_from("<HH", raw, 0)
        if raw[4:8] != b"TABL" or bits != 8:
            return {}
        off = struct.unpack_from("<I", raw, 20)[0]  # first table (MAIN)
        if raw[off:off + 4] != b"TKEY":
            return {}
        n = struct.unpack_from("<I", raw, off + 4)[0] // 8
        keys = [struct.unpack_from("<II", raw, off + 8 + 8 * k) for k in range(n)]
        tdat = off + 8 + 8 * n
        base = tdat + 8
        by_crc = {}
        for o, crc in keys:
            s = raw[base + o:raw.index(b"\0", base + o)].decode("latin1")
            by_crc[crc] = s
    except (struct.error, ValueError):
        return {}

    class Lookup(dict):
        def get(self, key, default=None):
            crc = ~zlib.crc32(key.encode()) & 0xFFFFFFFF
            return by_crc.get(crc, default)
    return Lookup()


def zone_hint(zones, box):
    """Most common named zone over a 5 x 5 sample of the box, as a file name part."""
    votes = {}
    for a in range(5):
        for b in range(5):
            x = box[0] + (a + 0.5) / 5 * (box[2] - box[0])
            y = box[1] + (b + 0.5) / 5 * (box[3] - box[1])
            hits = [z for z in zones if z[2] <= x <= z[4] and z[3] <= y <= z[5] and z[1] < 2.5e6]
            if hits:
                name = min(hits, key=lambda z: z[1])[0]
                votes[name] = votes.get(name, 0) + 1
    if not votes:
        return ""
    name = max(votes, key=votes.get)
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


# ---------- RenderWare streams ----------

def rw_chunks(data, start=0, end=None):
    """(type, data start, size, version) of the chunks between start and end."""
    end = len(data) if end is None else end
    p = start
    while p + 12 <= end:
        t, size, ver = struct.unpack_from("<III", data, p)
        if p + 12 + size > end:
            size = end - p - 12
        yield t, p + 12, size, ver
        p += 12 + size


def rw_version(v):
    return ((v >> 14 & 0x3FF00) + 0x30000) | (v >> 16 & 0x3F) if v & 0xFFFF0000 else v << 8


def rw_string(data, p, size):
    return data[p:p + size].split(b"\0")[0].decode("latin1")


# ---------- textures ----------

def rgb565(c):
    r = (c >> 11 & 31) * 255 // 31
    g = (c >> 5 & 63) * 255 // 63
    b = (c & 31) * 255 // 31
    return np.stack([r, g, b], -1).astype(np.int32)


def dxt_colours(blocks, four):
    """blocks: (n, 8) uint8 colour blocks -> (n, 16, 4) RGBA. four: always use the 4 colour mode (DXT3/5)."""
    c0 = blocks[:, 0].astype(np.int32) | blocks[:, 1].astype(np.int32) << 8
    c1 = blocks[:, 2].astype(np.int32) | blocks[:, 3].astype(np.int32) << 8
    idx = blocks[:, 4:8].copy().view("<u4").reshape(-1).astype(np.int64)
    a, b = rgb565(c0), rgb565(c1)
    pal = np.zeros((len(blocks), 4, 4), np.int32)
    pal[:, 0, :3], pal[:, 1, :3] = a, b
    pal[:, :, 3] = 255
    opaque = (c0 > c1) | four
    pal[:, 2, :3] = np.where(opaque[:, None], (2 * a + b) // 3, (a + b) // 2)
    pal[:, 3, :3] = np.where(opaque[:, None], (a + 2 * b) // 3, 0)
    pal[:, 3, 3] = np.where(opaque, 255, 0)
    sel = (idx[:, None] >> (2 * np.arange(16))) & 3
    return np.take_along_axis(pal, sel[:, :, None].repeat(4, 2), 1)


def decode_dxt(data, w, h, kind):
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    size = 8 if kind == 1 else 16
    raw = np.frombuffer(data, np.uint8, bw * bh * size).reshape(-1, size)
    if kind == 1:
        px = dxt_colours(raw, False)
    else:
        px = dxt_colours(raw[:, 8:], True)
        if kind == 3:
            nib = raw[:, :8]
            alpha = np.stack([nib & 15, nib >> 4], -1).reshape(-1, 16).astype(np.int32) * 17
        else:
            a0, a1 = raw[:, 0].astype(np.int32), raw[:, 1].astype(np.int32)
            bits = np.zeros(len(raw), np.int64)
            for k in range(6):
                bits |= raw[:, 2 + k].astype(np.int64) << (8 * k)
            sel = (bits[:, None] >> (3 * np.arange(16))) & 7
            pal = np.zeros((len(raw), 8), np.int32)
            pal[:, 0], pal[:, 1] = a0, a1
            big = a0 > a1
            for k in range(1, 7):
                pal[:, k + 1] = np.where(big, ((7 - k) * a0 + k * a1) // 7, 0)
            for k in range(1, 5):
                pal[:, k + 1] = np.where(big, pal[:, k + 1], ((5 - k) * a0 + k * a1) // 5)
            pal[:, 6] = np.where(big, pal[:, 6], 0)
            pal[:, 7] = np.where(big, pal[:, 7], 255)
            alpha = np.take_along_axis(pal, sel, 1)
        px[:, :, 3] = alpha
    img = px.reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(bh * 4, bw * 4, 4)
    return img[:h, :w].astype(np.uint8)


def decode_raster(fmt, d3d, w, h, depth, compression, palette, data):
    """One mip level of a D3D8/D3D9 texture native -> (h, w, 4) uint8 RGBA, or None."""
    fourcc = struct.pack("<I", d3d) if d3d else b""
    kind = {b"DXT1": 1, b"DXT3": 3, b"DXT5": 5}.get(fourcc) or {1: 1, 3: 3, 5: 5}.get(compression)
    if kind:
        return decode_dxt(data, w, h, kind)
    if palette is not None:
        if depth == 4:
            idx = np.frombuffer(data, np.uint8, (w * h + 1) // 2)
            idx = np.stack([idx & 15, idx >> 4], -1).reshape(-1)[:w * h]
        else:
            idx = np.frombuffer(data, np.uint8, w * h)
        return palette[idx].reshape(h, w, 4)
    base = fmt >> 8 & 0xF
    if base in (5, 6) or depth == 32:
        bgra = np.frombuffer(data, np.uint8, w * h * 4).reshape(h, w, 4)
        out = bgra[:, :, [2, 1, 0, 3]].copy()
        if base == 6 or d3d == 22:
            out[:, :, 3] = 255
        return out
    if depth == 16:
        v = np.frombuffer(data, "<u2", w * h).astype(np.int32).reshape(h, w)
        out = np.zeros((h, w, 4), np.int32)
        if base == 2:  # 565
            out[:, :, :3] = rgb565(v)
            out[:, :, 3] = 255
        elif base == 3:  # 4444
            out[:, :, 0], out[:, :, 1], out[:, :, 2], out[:, :, 3] = (v >> 8 & 15) * 17, (v >> 4 & 15) * 17, (v & 15) * 17, (v >> 12) * 17
        else:  # 1555 or 555
            out[:, :, 0], out[:, :, 1], out[:, :, 2] = (v >> 10 & 31) * 255 // 31, (v >> 5 & 31) * 255 // 31, (v & 31) * 255 // 31
            out[:, :, 3] = np.where(base == 1, (v >> 15) * 255, 255)
        return out.astype(np.uint8)
    if depth == 8 and base == 4:
        lum = np.frombuffer(data, np.uint8, w * h).reshape(h, w)
        return np.dstack([lum, lum, lum, np.full_like(lum, 255)])
    return None


def parse_txd(raw):
    """Texture dictionary -> {texture name (lower): (h, w, 4) uint8 RGBA}."""
    out = {}
    for t, p, size, _ in rw_chunks(raw):
        if t != 0x16:
            continue
        for t2, q, s2, _ in rw_chunks(raw, p, p + size):
            if t2 != 0x15:
                continue
            for t3, r, s3, _ in rw_chunks(raw, q, q + s2):
                if t3 != 0x01:
                    continue
                try:
                    platform = struct.unpack_from("<I", raw, r)[0]
                    name = rw_string(raw, r + 8, 32).lower()
                    fmt, d3d = struct.unpack_from("<II", raw, r + 72)
                    w, h, depth, levels, rtype, comp = struct.unpack_from("<HHBBBB", raw, r + 80)
                    if platform == 8:  # D3D8: d3d holds "has alpha", comp the DXT number
                        d3d = 0
                    elif platform == 9:
                        comp = 0
                    else:
                        continue
                    p2 = r + 88
                    palette = None
                    if fmt & 0x2000 or fmt & 0x4000:
                        n = 256 if fmt & 0x2000 else 16
                        palette = np.frombuffer(raw, np.uint8, n * 4, p2).reshape(n, 4).copy()
                        p2 += n * 4
                    dsize = struct.unpack_from("<I", raw, p2)[0]
                    img = decode_raster(fmt, d3d, w, h, depth, comp, palette, raw[p2 + 4:p2 + 4 + dsize])
                    if img is not None and name:
                        out[name] = img
                except (struct.error, ValueError) as e:
                    warn(f"texture: {e}")
                break
    return out


class Textures:
    """TXDs from gta3.img (with txdp parents), downscaled, deduplicated by content and encoded for the GLB."""

    def __init__(self, game, parents, max_px):
        self.game, self.parents, self.max_px = game, parents, max_px
        self.txds = {}
        self.cache = {}  # (txd, name) -> texture id or None
        self.store = {}  # texture id -> {"bytes", "mime", "alpha", "name"}
        self.missing = set()
        self.names = None

    def txd(self, name):
        if name not in self.txds:
            raw = self.game.img.read(name + ".txd")
            self.txds[name] = parse_txd(raw) if raw else {}
        return self.txds[name]

    def lookup(self, txd, name):
        """Texture id for a material texture name, or None."""
        key = (txd, name)
        if key in self.cache:
            return self.cache[key]
        img, chain, seen = None, txd, set()
        while chain and chain not in seen and img is None:
            seen.add(chain)
            img = self.txd(chain).get(name)
            chain = self.parents.get(chain)
        if img is None:  # a few models use a texture from another dictionary
            other = self.name_index().get(name)
            img = self.txd(other).get(name) if other else None
        tid = None
        if img is None:
            self.missing.add(f"{txd}/{name}")
        else:
            tid = self.add(name, img)
        self.cache[key] = tid
        return tid

    def name_index(self):
        """Texture name -> first dictionary in gta3.img holding it (built on first use)."""
        if self.names is None:
            self.names = {}
            for entry in sorted(self.game.img.entries):
                if not entry.endswith(".txd"):
                    continue
                raw = self.game.img.read(entry)
                for t, p, size, _ in rw_chunks(raw):
                    if t != 0x16:
                        continue
                    for t2, q, s2, _ in rw_chunks(raw, p, p + size):
                        if t2 == 0x15 and s2 > 52:
                            self.names.setdefault(rw_string(raw, q + 12 + 8, 32).lower(), entry[:-4])
        return self.names

    def add(self, name, img):
        a = img[:, :, 3]
        n = a.size
        clear = np.count_nonzero(a < 128) / n
        alpha = "mask" if clear > 0.01 else "blend" if a.mean() < 230 else None
        im = Image.fromarray(img, "RGBA")
        if max(im.size) > self.max_px:
            f = self.max_px / max(im.size)
            im = im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.LANCZOS)
        if alpha is None:
            im = im.convert("RGB")
        tid = hashlib.sha1(im.tobytes() + (im.mode + str(im.size)).encode()).hexdigest()[:16]
        if tid not in self.store:
            buf = io.BytesIO()
            if alpha:
                im.save(buf, "PNG", optimize=True)
                mime = "image/png"
            else:
                im.save(buf, "JPEG", quality=82)
                mime = "image/jpeg"
            self.store[tid] = {"bytes": buf.getvalue(), "mime": mime, "alpha": alpha, "name": name}
        return tid

    def drop_dictionaries(self):
        self.txds.clear()


# ---------- DFF models ----------

class Sub:
    """One material's triangles of a model, in model space."""
    __slots__ = ("tex", "alpha", "opacity", "pos", "nrm", "uv", "col", "tris")


def crease_normals(pos, tris, crease=0.7):
    """Vertex normals from area-weighted face normals; corners on a sharp edge get their own vertex with the face
    normal. Returns (vertex map into the old vertices, normals, new tris)."""
    p0, p1, p2 = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    fn = np.cross(p1 - p0, p2 - p0)
    vn = np.zeros_like(pos)
    for k in range(3):
        np.add.at(vn, tris[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
    fu = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    corner_v = tris.reshape(-1)
    corner_f = np.repeat(fu, 3, axis=0)
    sharp = np.einsum("ij,ij->i", corner_f, vn[corner_v]) < crease
    q = np.round(corner_f * 64).astype(np.int64)
    key = np.stack([corner_v, sharp.astype(np.int64), np.where(sharp, q[:, 0], 0), np.where(sharp, q[:, 1], 0),
                    np.where(sharp, q[:, 2], 0)], 1)
    uniq, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    vmap = uniq[:, 0]
    normals = np.where(sharp[first][:, None], corner_f[first], vn[vmap]).astype(np.float32)
    return vmap, normals, inverse.reshape(-1, 3).astype(np.uint32)


class Model:
    """A DFF's visible atomics as Subs (frame transforms applied). radius: bounding radius in metres."""

    def __init__(self, raw, txd, textures, prelight_scale=2.0):
        self.prelight_scale = prelight_scale
        self.subs = []
        self.radius = 0.0
        self.tris = 0
        clump = next(((p, s) for t, p, s, _ in rw_chunks(raw) if t == 0x10), None)
        if clump is None:
            return
        frames, names, geoms, atomics = [], [], [], []
        for t, p, size, ver in rw_chunks(raw, clump[0], clump[0] + clump[1]):
            if t == 0x0E:
                frames, names = self.frame_list(raw, p, size)
            elif t == 0x1A:
                for t2, q, s2, v2 in rw_chunks(raw, p, p + size):
                    if t2 == 0x0F:
                        geoms.append(self.geometry(raw, q, s2, rw_version(v2)))
            elif t == 0x14:
                for t2, q, s2, _ in rw_chunks(raw, p, p + size):
                    if t2 == 0x01:
                        fi, gi = struct.unpack_from("<II", raw, q)
                        atomics.append((fi, gi))
                        break
        ltm = []
        for i, (m, parent) in enumerate(frames):
            ltm.append(m if parent < 0 or parent >= i else ltm[parent] @ m)
        for fi, gi in atomics:
            name = names[fi] if fi < len(names) else ""
            if re.search(r"_dam$|_vlo$|_l[1-3]$|_lod$", name, re.I) or gi >= len(geoms) or geoms[gi] is None:
                continue
            m = ltm[fi] if fi < len(ltm) else np.eye(4)
            for mat, pos, nrm, uv, col, tris in geoms[gi]:
                pos = pos @ m[:3, :3].T + m[:3, 3]
                if nrm is not None:
                    nrm = nrm @ m[:3, :3].T
                self.add_sub(mat, pos, nrm, uv, col, tris, txd, textures)
        if self.subs:
            allp = np.concatenate([s.pos for s in self.subs])
            self.lo_hi = np.stack([allp.min(0), allp.max(0)], 0)
            centre = self.lo_hi.mean(0)
            self.radius = float(np.linalg.norm(allp - centre, axis=1).max())
            self.tris = sum(len(s.tris) for s in self.subs)

    @staticmethod
    def frame_list(raw, p, size):
        frames, names = [], []
        for t, q, s, _ in rw_chunks(raw, p, p + size):
            if t == 0x01:
                n = struct.unpack_from("<I", raw, q)[0]
                for k in range(n):
                    v = struct.unpack_from("<12fiI", raw, q + 4 + 56 * k)
                    m = np.eye(4)
                    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = v[0:3], v[3:6], v[6:9], v[9:12]
                    frames.append((m, v[12]))
            elif t == 0x03:
                name = ""
                for t2, r, s2, _ in rw_chunks(raw, q, q + s):
                    if t2 == 0x0253F2FE:
                        name = raw[r:r + s2].decode("latin1")
                names.append(name)
        return frames, names

    @staticmethod
    def geometry(raw, p, size, ver):
        """[(material, pos, nrm, uv, col, tris)] per material of a Geometry chunk, or None."""
        parts = list(rw_chunks(raw, p, p + size))
        st = next(((q, s) for t, q, s, _ in parts if t == 0x01), None)
        if st is None:
            return None
        q = st[0]
        flags, n_tri, n_vert, n_morph = struct.unpack_from("<Iiii", raw, q)
        q += 16
        if ver < 0x34000:
            q += 12
        if flags & 0x01000000 or n_vert <= 0:
            return None
        n_uv = flags >> 16 & 0xFF or (2 if flags & 0x80 else 1 if flags & 0x04 else 0)
        col = uv = None
        if flags & 0x08:
            col = np.frombuffer(raw, np.uint8, n_vert * 4, q).reshape(-1, 4)
            q += n_vert * 4
        for k in range(n_uv):
            if k == 0:
                uv = np.frombuffer(raw, np.float32, n_vert * 2, q).reshape(-1, 2)
            q += n_vert * 8
        tri = np.frombuffer(raw, np.uint16, n_tri * 4, q).reshape(-1, 4)
        q += n_tri * 8
        q += 16  # bounding sphere
        has_pos, has_nrm = struct.unpack_from("<II", raw, q)
        q += 8
        pos = np.frombuffer(raw, np.float32, n_vert * 3, q).reshape(-1, 3).astype(np.float64)
        q += n_vert * 12 if has_pos else 0
        nrm = np.frombuffer(raw, np.float32, n_vert * 3, q).reshape(-1, 3).astype(np.float64) if has_nrm else None
        # Materials.
        mats = []
        ml = next(((q2, s2) for t, q2, s2, _ in parts if t == 0x08), None)
        if ml:
            for t, q2, s2, mv in rw_chunks(raw, ml[0], ml[0] + ml[1]):
                if t == 0x01:
                    cnt = struct.unpack_from("<I", raw, q2)[0]
                    refs = struct.unpack_from("<%di" % cnt, raw, q2 + 4)
                elif t == 0x07:
                    mats.append(Model.material(raw, q2, s2))
            mats = [mats[r] if r >= 0 else mats[k] for k, r in enumerate(refs)] if len(mats) == len(refs) else mats
        if not mats:
            mats = [{"tex": None, "color": (255, 255, 255, 255)}]
        # Triangles: from the geometry, or else from the bin mesh extension.
        if n_tri:
            tris = np.stack([tri[:, 1], tri[:, 0], tri[:, 3]], 1).astype(np.uint32)
            mat_ids = tri[:, 2].astype(np.int64)
        else:
            tris, mat_ids = Model.bin_mesh(raw, parts)
            if tris is None:
                return None
        out = []
        for mi in np.unique(mat_ids):
            sel = tris[mat_ids == mi]
            sel = sel[(sel < n_vert).all(1)]
            if not len(sel):
                continue
            used, local = np.unique(sel, return_inverse=True)
            out.append((mats[min(int(mi), len(mats) - 1)], pos[used], None if nrm is None else nrm[used],
                        None if uv is None else uv[used], None if col is None else col[used],
                        local.reshape(-1, 3).astype(np.uint32)))
        return out

    @staticmethod
    def bin_mesh(raw, parts):
        ext = next(((q, s) for t, q, s, _ in parts if t == 0x03), None)
        if not ext:
            return None, None
        for t, q, s, _ in rw_chunks(raw, ext[0], ext[0] + ext[1]):
            if t != 0x50E:
                continue
            strip, n_mesh, _ = struct.unpack_from("<III", raw, q)
            q += 12
            tris, ids = [], []
            for _ in range(n_mesh):
                n_idx, mi = struct.unpack_from("<II", raw, q)
                idx = np.frombuffer(raw, "<u4", n_idx, q + 8)
                q += 8 + 4 * n_idx
                if strip:
                    if n_idx < 3:
                        continue
                    a, b, c = idx[:-2], idx[1:-1], idx[2:]
                    odd = np.arange(len(a)) % 2 == 1
                    t3 = np.stack([a, np.where(odd, c, b), np.where(odd, b, c)], 1)
                    t3 = t3[(t3[:, 0] != t3[:, 1]) & (t3[:, 1] != t3[:, 2]) & (t3[:, 0] != t3[:, 2])]
                else:
                    t3 = idx[:n_idx // 3 * 3].reshape(-1, 3)
                tris.append(t3)
                ids.append(np.full(len(t3), mi))
            if tris:
                return np.concatenate(tris).astype(np.uint32), np.concatenate(ids)
        return None, None

    @staticmethod
    def material(raw, p, size):
        m = {"tex": None, "color": (255, 255, 255, 255)}
        for t, q, s, _ in rw_chunks(raw, p, p + size):
            if t == 0x01:
                m["color"] = struct.unpack_from("<4B", raw, q + 4)
                textured = struct.unpack_from("<i", raw, q + 12)[0]
            elif t == 0x06 and textured:
                strings = [rw_string(raw, r, s2) for t2, r, s2, _ in rw_chunks(raw, q, q + s) if t2 == 0x02]
                if strings and strings[0]:
                    m["tex"] = strings[0].lower()
        return m

    def add_sub(self, mat, pos, nrm, uv, col, tris, txd, textures):
        s = Sub()
        s.tex = textures.lookup(txd, mat["tex"]) if mat["tex"] else None
        s.alpha = textures.store[s.tex]["alpha"] if s.tex else None
        r, g, b, a = mat["color"]
        s.opacity = round(a / 255.0, 2)
        if s.opacity < 1 and s.alpha is None:
            s.alpha = "blend"
        n = len(pos)
        c = np.full((n, 4), 255, np.float32) if col is None else col.astype(np.float32) * self.prelight_scale
        c[:, 0] *= r / 255.0
        c[:, 1] *= g / 255.0
        c[:, 2] *= b / 255.0
        c[:, 3] = 255
        if uv is None:
            uv = np.zeros((n, 2), np.float32)
        if nrm is None:
            vmap, nrm, tris = crease_normals(pos, tris)
            pos, uv, c = pos[vmap], uv[vmap], c[vmap]
        s.pos = pos.astype(np.float32)
        s.nrm = nrm.astype(np.float32)
        s.uv = uv.astype(np.float32)
        s.col = np.clip(c, 0, 255).astype(np.uint8)
        s.tris = tris.astype(np.uint32)
        self.subs.append(s)


def quat_matrix(x, y, z, w):
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def placement_matrix(rot):
    """Model -> world rotation for an IPL quaternion. The IPL stores the inverse rotation, so use the conjugate."""
    x, y, z, w = rot
    n = (x * x + y * y + z * z + w * w) ** 0.5 or 1.0
    return quat_matrix(-x / n, -y / n, -z / n, w / n)


# ---------- glb writing ----------

class GlbWriter:
    def __init__(self):
        self.bin = bytearray()
        self.gltf = {"asset": {"version": "2.0", "generator": "sbg-maps gtasa_to_glb"}, "buffers": [], "bufferViews": [],
                     "accessors": [], "meshes": [], "materials": [], "textures": [], "images": [], "samplers": [],
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

    def accessor(self, values, kind, normalized=False):
        """values: numpy array (n, width) or (n,)."""
        comp = {np.dtype(np.float32): 5126, np.dtype(np.uint32): 5125, np.dtype(np.uint8): 5121}[values.dtype]
        data = np.ascontiguousarray(values).astype(values.dtype.newbyteorder("<")).tobytes()
        target = 34963 if kind == "SCALAR" else 34962
        acc = {"bufferView": self.view(data, target), "componentType": comp, "count": len(values), "type": kind}
        if normalized:
            acc["normalized"] = True
        if kind == "VEC3" and comp == 5126:
            acc["min"] = values.min(0).tolist()
            acc["max"] = values.max(0).tolist()
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def image(self, key, data, mime):
        if key not in self.image_index:
            self.gltf["images"].append({"bufferView": self.view(data), "mimeType": mime, "name": key})
            if not self.gltf["samplers"]:
                self.gltf["samplers"].append({"wrapS": 10497, "wrapT": 10497})
            self.gltf["textures"].append({"source": len(self.gltf["images"]) - 1, "sampler": 0})
            self.image_index[key] = len(self.gltf["textures"]) - 1
        return self.image_index[key]

    def material(self, key, name, texture, extras, alpha=None, color=None, double_sided=False):
        """texture: (image key, bytes, mime) or None."""
        if key in self.material_index:
            return self.material_index[key]
        mat = {"name": name, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": double_sided,
               "extras": extras}
        if texture:
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": self.image(*texture)}
        if color:
            mat["pbrMetallicRoughness"]["baseColorFactor"] = list(color)
        if alpha == "mask":
            mat["alphaMode"] = "MASK"
            mat["alphaCutoff"] = 0.5
        elif alpha == "blend":
            mat["alphaMode"] = "BLEND"
        self.gltf["materials"].append(mat)
        self.material_index[key] = len(self.gltf["materials"]) - 1
        return self.material_index[key]

    def primitive(self, pos, nrm, uv, col, idx, material):
        attrs = {"POSITION": self.accessor(pos, "VEC3"), "NORMAL": self.accessor(nrm, "VEC3")}
        if uv is not None:
            attrs["TEXCOORD_0"] = self.accessor(uv, "VEC2")
        if col is not None:
            attrs["COLOR_0"] = self.accessor(col, "VEC4", normalized=True)
        return {"attributes": attrs, "indices": self.accessor(idx, "SCALAR"), "material": material, "mode": 4}

    def node(self, name, primitives):
        self.gltf["meshes"].append({"name": name, "primitives": primitives})
        self.gltf["nodes"].append({"name": name, "mesh": len(self.gltf["meshes"]) - 1})
        self.gltf["scenes"][0]["nodes"].append(len(self.gltf["nodes"]) - 1)

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


# ---------- the map ----------

class World:
    """Definitions and placements of the whole map, and a model cache."""

    def __init__(self, game_dir, max_tex, prelight_scale=2.0):
        self.prelight_scale = prelight_scale
        self.game = Game(game_dir)
        dat = self.game.text("data/gta.dat")
        if dat is None:
            sys.exit("no data/gta.dat")
        ides, ipls = [], []
        for line in dat.splitlines():
            v = line.split("#")[0].split(None, 1)
            if len(v) == 2 and v[0].upper() == "IDE":
                ides.append(v[1].strip())
            elif len(v) == 2 and v[0].upper() == "IPL" and v[1].strip().lower().endswith(".ipl"):
                ipls.append(v[1].strip())
        ides.append("data/maps/txd.ide")  # txd parents of the generic dictionaries (not listed in gta.dat)
        self.defs, parents = load_definitions(self.game, ides)
        # Interiors live in gta_int.img and the interior IPLs; the leveldes Liberty City piece floats in the sky.
        ipls = [p for p in ipls if not re.search(r"[\\/](interior|leveldes)[\\/]", p, re.I) or "seabed" in p.lower()]
        self.placements, lods = load_placements(self.game, ipls)
        self.textures = Textures(self.game, parents, max_tex)
        self.water = load_water(self.game)
        self.zones = load_zones(self.game)
        self.models = {}
        self.skipped = {}
        kept = []
        for p in self.placements:
            d = self.defs.get(p.id)
            reason = None
            if d is None:
                reason = "unknown id"
            elif p.ipl in {b for b, _ in lods} and (p.ipl, p.index) in lods:
                reason = "lod"
            elif LOD_NAME.search(d.model):
                reason = "lod"
            elif p.interior & 0xFF not in (0, 13):
                reason = "interior"
            elif d.night_only:
                reason = "night only"
            elif d.flags & F_ADDITIVE:
                reason = "glow"
            if reason:
                self.skipped[reason] = self.skipped.get(reason, 0) + 1
            else:
                kept.append(p)
        self.placements = kept
        print(f"{len(self.defs)} object definitions, {len(kept)} detailed placements "
              f"(left out: {', '.join(f'{v} {k}' for k, v in sorted(self.skipped.items()))}), {len(self.water)} water polygons")

    def model(self, d):
        if d.id not in self.models:
            raw = self.game.img.read(d.model + ".dff")
            m = None
            if raw:
                try:
                    m = Model(raw, d.txd, self.textures, self.prelight_scale)
                except (struct.error, ValueError, IndexError) as e:
                    warn(f"model {d.model}: {e}")
            if m is None or not m.subs:
                m = None
            self.models[d.id] = m
        return self.models[d.id]

    def forget_models(self):
        self.models.clear()
        self.textures.drop_dictionaries()


def in_box(x, y, box):
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def clip_polygon(poly, box):
    """Sutherland-Hodgman clip of an (x, y, z) polygon to the box in x and y."""
    def clip(pts, axis, value, keep_greater):
        out = []
        for i, a in enumerate(pts):
            b = pts[(i + 1) % len(pts)]
            ina = (a[axis] >= value) if keep_greater else (a[axis] <= value)
            inb = (b[axis] >= value) if keep_greater else (b[axis] <= value)
            if ina:
                out.append(a)
            if ina != inb:
                t = (value - a[axis]) / (b[axis] - a[axis])
                out.append(tuple(a[k] + t * (b[k] - a[k]) for k in range(3)))
        return out
    pts = list(poly)
    for axis, value, greater in ((0, box[0], True), (0, box[2], False), (1, box[1], True), (1, box[3], False)):
        if not pts:
            break
        pts = clip(pts, axis, value, greater)
    return pts


def build_section(world, box, out_path, max_tris, max_mb, min_size, prelight=True, water=True):
    """Writes one section; returns its index entry."""
    t = world.textures
    picked = []  # (placement, def, model)
    for p in world.placements:
        inside = in_box(p.pos[0], p.pos[1], box)
        if not inside and not in_box(p.pos[0], p.pos[1], (box[0] - REACH, box[1] - REACH, box[2] + REACH, box[3] + REACH)):
            continue
        d = world.defs[p.id]
        m = world.model(d)
        if m is None:
            continue
        if not inside:
            # A big terrain piece placed just outside still fills the section's edge (trimmed to LIMIT below).
            if m.radius < BIG:
                continue
            corners = np.array([[a, b, c] for a in m.lo_hi[:, 0] for b in m.lo_hi[:, 1] for c in m.lo_hi[:, 2]])
            w = corners @ placement_matrix(p.rot).T + np.array(p.pos)
            if w[:, 0].max() < box[0] or w[:, 0].min() > box[2] or w[:, 1].max() < box[1] or w[:, 1].min() > box[3]:
                continue
        picked.append((p, d, m))
    # Drop the smallest props until the section fits the budgets.
    def estimate(items):
        tris = sum(m.tris for _, _, m in items)
        verts = sum(len(s.pos) for _, _, m in items for s in m.subs)
        tex = {s.tex for _, _, m in items for s in m.subs if s.tex}
        return tris, verts * 36 + tris * 12 + sum(len(t.store[k]["bytes"]) for k in tex)
    threshold = min_size
    items = [it for it in picked if 2 * it[2].radius >= threshold]
    tris, size = estimate(items)
    for step in (0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 15.0, 20.0):
        if tris <= max_tris and size <= max_mb * 1e6:
            break
        if step <= threshold:
            continue
        threshold = step
        items = [it for it in picked if 2 * it[2].radius >= threshold]
        tris, size = estimate(items)
    dropped = len(picked) - len(items)
    if not items:
        return None
    # World positions.
    # Objects are kept whole, but the editor takes at most LIMIT x LIMIT metres: the triangles of the few big
    # models (terrain pieces) that reach past that square around the section centre are left out.
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    lim = (cx - LIMIT / 2, cy - LIMIT / 2, cx + LIMIT / 2, cy + LIMIT / 2)
    groups = {}  # material key -> list of (pos, nrm, uv, col, tris)
    zmin = float("inf")
    trimmed = set()
    for n, (p, d, m) in enumerate(items):
        r = placement_matrix(p.rot)
        tpos = np.array(p.pos)
        foliage = bool(d.flags & (F_TREE | F_PALM)) or bool(FOLIAGE.search(d.model)) or bool(FOLIAGE.search(d.txd))
        for s in m.subs:
            pos = s.pos @ r.T + tpos
            nrm, uv, col, tris = s.nrm @ r.T, s.uv, s.col, s.tris
            inside = (pos[:, 0] >= lim[0]) & (pos[:, 0] <= lim[2]) & (pos[:, 1] >= lim[1]) & (pos[:, 1] <= lim[3])
            if not inside.all():
                trimmed.add(n)
                tris = tris[inside[tris].all(1)]
                if not len(tris):
                    continue
                used, local = np.unique(tris, return_inverse=True)
                pos, nrm, uv, col, tris = pos[used], nrm[used], uv[used], col[used], local.reshape(-1, 3).astype(np.uint32)
            zmin = min(zmin, float(pos[:, 2].min()))
            render_only = bool(s.alpha and foliage) or bool(d.flags & F_NO_ZWRITE and s.alpha)
            key = (s.tex, s.alpha, s.opacity, render_only)
            groups.setdefault(key, []).append((pos, nrm, uv, col, tris))
    ground = zmin
    writer = GlbWriter()
    prims = []
    tri_total = 0
    for key in sorted(groups, key=lambda k: (k[0] or "", str(k[1]), k[2], k[3])):
        tex, alpha, opacity, render_only = key
        parts = groups[key]
        pos = np.concatenate([a[0] for a in parts])
        nrm = np.concatenate([a[1] for a in parts])
        uv = np.concatenate([a[2] for a in parts])
        col = np.concatenate([a[3] for a in parts])
        offsets = np.cumsum([0] + [len(a[0]) for a in parts[:-1]])
        idx = np.concatenate([a[4] + o for a, o in zip(parts, offsets)]).reshape(-1).astype(np.uint32)
        tri_total += len(idx) // 3
        gpos = np.stack([pos[:, 0] - cx, pos[:, 2] - ground, -(pos[:, 1] - cy)], 1).astype(np.float32)
        gnrm = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], 1)
        gnrm = (gnrm / np.maximum(np.linalg.norm(gnrm, axis=1, keepdims=True), 1e-9)).astype(np.float32)
        extras = {"surface": "none", "renderOnly": True} if render_only else {"surface": "rough"}
        info = t.store.get(tex) if tex else None
        name = (info["name"] if info else "untextured") + (" (cut out)" if alpha == "mask" else " (see-through)" if alpha == "blend" else "") \
            + (" (no collision)" if render_only else "")
        colour = (1.0, 1.0, 1.0, opacity) if opacity < 1 else None
        mat = writer.material(key, name, (tex, info["bytes"], info["mime"]) if info else None, extras, alpha, colour,
                              double_sided=alpha is not None)
        prims.append(writer.primitive(gpos, gnrm, uv if info else None, col if prelight else None, idx, mat))
    writer.node("world", prims)
    # Water.
    water_tris = 0
    if water:
        wpos, widx = [], []
        for poly in world.water:
            pts = clip_polygon(poly, box)
            if len(pts) < 3:
                continue
            base = len(wpos)
            wpos.extend(pts)
            for k in range(1, len(pts) - 1):
                widx.extend((base, base + k, base + k + 1))
        if widx:
            w = np.array(wpos)
            gpos = np.stack([w[:, 0] - cx, w[:, 2] - ground, -(w[:, 1] - cy)], 1).astype(np.float32)
            idx = np.array(widx, np.uint32).reshape(-1, 3)
            # Counter-clockwise seen from above (+y) in glTF.
            a, b, c = gpos[idx[:, 0]], gpos[idx[:, 1]], gpos[idx[:, 2]]
            flip = np.cross(b - a, c - a)[:, 1] < 0
            idx[flip] = idx[flip][:, [0, 2, 1]]
            nrm = np.tile(np.array([[0, 1, 0]], np.float32), (len(gpos), 1))
            mat = writer.material("water", "water", None, {"surface": "none", "renderOnly": True}, "blend",
                                  (0.16, 0.38, 0.52, 0.7), double_sided=True)
            writer.node("water", [writer.primitive(gpos, nrm, None, None, idx.reshape(-1), mat)])
            water_tris = len(idx)
    origin = [cx, ground, -cy]
    writer.gltf["scenes"][0]["extras"] = {"source": "gtasa", "worldOrigin": origin}
    writer.gltf["asset"]["extras"] = {"gtaBox": list(box), "groundMetres": ground, "centre": [cx, cy],
                                      "frame": "glTF = (Gx - cx, Gz - ground, -(Gy - cy)), metres"}
    writer.write(out_path)
    mb = os.path.getsize(out_path) / 1e6
    print(f"wrote {out_path}: {len(items)} objects ({dropped} props under {threshold:g} m dropped, {len(trimmed)} trimmed "
          f"to {LIMIT:g} m), {tri_total} triangles, "
          f"{water_tris} water triangles, {len(writer.gltf['materials'])} materials, {len(writer.gltf['images'])} images, "
          f"{mb:.1f} MB, ground {ground:.1f} m; size {box[2] - box[0]:.0f} x {box[3] - box[1]:.0f} m")
    return {"file": os.path.basename(out_path), "box": list(box), "triangles": tri_total, "waterTriangles": water_tris,
            "objects": len(items), "droppedProps": dropped, "trimmedObjects": len(trimmed), "dropThresholdMetres": threshold,
            "sizeMB": round(mb, 1), "groundMetres": round(ground, 2), "worldOrigin": origin}


def grid_sections(world):
    """(name, box) for each grid cell that holds anything but ocean (rows run north to south)."""
    step = (GRID_MAX - GRID_MIN) / GRID_N
    counts = {}
    for p in world.placements:
        d = world.defs[p.id]
        if d.txd == "seabed":
            continue
        c = int((p.pos[0] - GRID_MIN) // step)
        r = int((GRID_MAX - p.pos[1]) // step)
        if 0 <= r < GRID_N and 0 <= c < GRID_N:
            counts[(r, c)] = counts.get((r, c), 0) + 1
    out = []
    for r in range(GRID_N):
        for c in range(GRID_N):
            if counts.get((r, c), 0) < 10:
                continue
            box = (GRID_MIN + c * step, GRID_MAX - (r + 1) * step, GRID_MIN + (c + 1) * step, GRID_MAX - r * step)
            hint = zone_hint(world.zones, box)
            out.append((f"grid_r{r}_c{c}" + (f"_{hint}" if hint else ""), box))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("game", help="the San Andreas game folder (holding data/ and models/)")
    ap.add_argument("out", nargs="?", help="output .glb for --preset or --box")
    ap.add_argument("--preset", choices=sorted(PRESETS), help="named area: " + ", ".join(sorted(PRESETS)))
    ap.add_argument("--box", help="area x1,y1,x2,y2 in GTA metres (x east, y north, as /save or map tools show)")
    ap.add_argument("--grid", metavar="DIR", help="write every grid section (8 x 8 of 750 m, ocean-only ones skipped)")
    ap.add_argument("--presets", metavar="DIR", help="write every named preset")
    ap.add_argument("--only", help="with --grid/--presets: comma list of section names (or name prefixes) to write")
    ap.add_argument("--index", help="sections.json to create or update (default: sections.json next to the outputs)")
    ap.add_argument("--max-tex", type=int, default=256, help="largest texture side in pixels; default 256")
    ap.add_argument("--max-tris", type=int, default=1_500_000, help="triangle budget per section; default 1500000")
    ap.add_argument("--max-mb", type=float, default=60.0, help="file size budget per section in MB; default 60")
    ap.add_argument("--min-size", type=float, default=0.0,
                    help="always drop props smaller than this many metres across; smaller props are also dropped "
                         "automatically when a section is over budget")
    ap.add_argument("--prelight-scale", type=float, default=2.0,
                    help="multiply the prelight colours (the PC data is made for a doubling pipeline); default 2")
    ap.add_argument("--no-prelight", action="store_true", help="leave out the vertex prelight colours")
    ap.add_argument("--no-water", action="store_true", help="leave out water")
    args = ap.parse_args()

    jobs = []
    if args.grid or args.presets:
        world = World(args.game, args.max_tex, args.prelight_scale)
        if args.grid:
            os.makedirs(args.grid, exist_ok=True)
            jobs += [(n, b, os.path.join(args.grid, n + ".glb")) for n, b in grid_sections(world)]
        if args.presets:
            os.makedirs(args.presets, exist_ok=True)
            jobs += [(n, b, os.path.join(args.presets, n + ".glb")) for n, b in PRESETS.items()]
        if args.only:
            want = [w.strip() for w in args.only.split(",")]
            jobs = [j for j in jobs if any(j[0] == w or j[0].startswith(w) for w in want)]
    else:
        if not args.out or not (args.preset or args.box):
            ap.error("give <out.glb> with --preset or --box, or use --grid / --presets")
        box = PRESETS[args.preset] if args.preset else tuple(float(v) for v in args.box.split(","))
        box = (min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3]))
        if box[2] - box[0] > 900 or box[3] - box[1] > 900:
            print("warning: the editor's level is at most 900 x 900 m")
        world = World(args.game, args.max_tex, args.prelight_scale)
        jobs = [(args.preset or "box", box, args.out)]

    index_path = args.index or os.path.join(os.path.dirname(os.path.abspath(jobs[0][2])) if jobs else ".", "sections.json")
    index = {}
    if os.path.exists(index_path):
        with open(index_path) as f:
            index = {e["name"]: e for e in json.load(f).get("sections", [])}
    for name, box, path in jobs:
        print(f"== {name} {box}")
        entry = build_section(world, box, path, args.max_tris, args.max_mb, args.min_size, not args.no_prelight,
                              not args.no_water)
        if entry:
            entry["name"] = name
            entry["path"] = os.path.relpath(os.path.abspath(path), os.path.dirname(os.path.abspath(index_path)))
            index[name] = entry
        world.forget_models()
        with open(index_path, "w") as f:
            json.dump({"source": "Grand Theft Auto: San Andreas (PC)", "frame": "glTF = (Gx - cx, Gz - ground, -(Gy - cy))",
                       "sections": sorted(index.values(), key=lambda e: e["name"])}, f, indent=1)
    if world.textures.missing:
        print(f"{len(world.textures.missing)} textures not found, e.g. {sorted(world.textures.missing)[:4]}")


if __name__ == "__main__":
    main()
