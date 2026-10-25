"""Convert an area of a World of Warcraft 1.12.1 (build 5875) map into a .glb for the SBG map editor.

usage: wow_to_glb.py <Data dir> <map> <out.glb> (--preset NAME | --tiles X1,Y1[,X2,Y2] | --box X1,Y1,X2,Y2) [options]
example: wow_to_glb.py ~/wow/Data Azeroth stormwind.glb --preset stormwind

Reads the client's MPQ archives directly (read only; later patch archives override earlier ones) and writes:
- node "terrain": the ADT terrain of the chosen chunks, one primitive per ADT tile. The four texture layers,
  their alpha maps and the baked terrain shadows are painted into one texture per tile (--chunk-px pixels per
  33 yard chunk). Holes in the terrain are kept open. extras.surface "rough".
- node "buildings": the WMOs placed on those tiles (MODF), group by group, merged by material. Triangles the
  client draws but does not collide with get a render-only copy of their material, and collision-only
  triangles an invisible one.
- node "doodads": M2 models placed on the tiles (MDDF) and inside the WMOs (MODD, global set plus the set the
  placement asks for): skin 0 in its bind pose, merged by texture. Alpha-tested foliage is render only.
- node "water": rivers, lakes and canals (ADT MCLQ and WMO MLIQ) as a see-through render-only surface.

Coordinates: WoW's world frame W is z-up in yards (x north, y west, z up; the frame the server's .gps prints).
glTF is y-up and right-handed, and the SBG map frame is glTF with z flipped (east, up, north):
    glTF (x, y, z) = (-(Wy - cy), Wz - ground, -(Wx - cx)) * 0.9144
so map x runs east, map z runs north and nothing is mirrored (both frames are right-handed). (cx, cy) is the
centre of the cut-out area and `ground` the lowest terrain height in it, so the model sits on y = 0.
Models are placed as the client does: MDDF/MODF positions are in "placement" space P (x = 32 tiles - Wy,
y = up, z = 32 tiles - Wx), rotated Y(b - 90) * Z(-a) * X(c) in P around a model whose native z-up axes are
first turned into P by (x, y, z) -> (x, z, -y).
The root scene extras record where the file sits in the map, {"source": "wow", "map": <map>, "worldOrigin":
[-cy, ground, -cx] * 0.9144}: glTF world position = local position + worldOrigin, the glTF world frame being
(-Wy, Wz, -Wx) * 0.9144, so areas of the same map placed at their worldOrigin line up as in the game.
"""
import argparse
import array
import bz2
import io
import json
import math
import os
import re
import struct
import sys
import zlib

from PIL import Image

try:
    import mpyq
except ImportError:
    sys.exit("needs mpyq (pip install mpyq)")

YARD = 0.9144             # metres per yard
TILE = 1600.0 / 3.0       # ADT tile size in yards
CHUNK = TILE / 16.0       # MCNK size
UNIT = CHUNK / 8.0        # distance between terrain vertices (and liquid vertices)
ZERO = 32.0 * TILE        # placement space origin offset

# Archives in override order: the first one holding a file wins. Unknown .MPQ files in the folder go last.
ARCHIVE_ORDER = ["patch-3", "patch-2", "patch", "wmo", "texture", "terrain", "model", "misc", "dbc", "interface",
                 "base", "backup"]

PRESETS = {
    # Stormwind City with a ring of Elwynn Forest around it, in W coordinates (x north, y west), yards.
    "stormwind": {"map": "Azeroth", "box": (-9300.0, -40.0, -8200.0, 1180.0)},
    # Open questing areas.
    # Elwynn Forest: Goldshire, Northshire Abbey and the forest and farms between.
    "elwynn": {"map": "Azeroth", "box": (-9750.0, -500.0, -8800.0, 450.0)},
    # Westfall: Sentinel Hill, the Saldean and Furlbrow farms and the coast road.
    "westfall": {"map": "Azeroth", "box": (-10950.0, 650.0, -10050.0, 1550.0)},
    # Mulgore: Bloodhoof Village and the plains around it.
    "mulgore": {"map": "Kalimdor", "box": (-2800.0, -800.0, -1900.0, 100.0)},
}

FOLIAGE = re.compile(r"tree|bush|shrub|plant|leaf|leaves|foliage|flower|grass|ivy|vine|fern|hedge|weed|canopy", re.I)


# ---------- MPQ archives ----------

class Archive:
    """One MPQ (format 0 or 1). mpyq parses the header and the hash and block tables; files are read here so that
    encrypted files, sector checksums and a file that exactly fills its last sector all work."""

    def __init__(self, path):
        self.path = path
        self.mpq = mpyq.MPQArchive(path, listfile=False)
        self.sector = 512 << self.mpq.header["sector_size_shift"]
        self.index = {}
        for e in self.mpq.hash_table:
            if e.block_table_index < len(self.mpq.block_table):
                self.index.setdefault((e.hash_a, e.hash_b), e.block_table_index)

    def block(self, name):
        i = self.index.get((self.mpq._hash(name, "HASH_A"), self.mpq._hash(name, "HASH_B")))
        return None if i is None else self.mpq.block_table[i]

    def decrypt(self, data, key):
        whole = len(data) // 4 * 4
        return self.mpq._decrypt(data[:whole], key) + data[whole:]

    @staticmethod
    def decompress(data):
        kind = data[0]
        if kind == 0x02:
            return zlib.decompress(data[1:])
        if kind == 0x10:
            return bz2.decompress(data[1:])
        raise NotImplementedError(f"MPQ compression 0x{kind:02x}")

    def read(self, name, b):
        f = self.mpq.file
        f.seek(b.offset + self.mpq.header["offset"])
        raw = f.read(b.archived_size)
        key = None
        if b.flags & 0x00010000:  # encrypted: key from the bare file name
            key = self.mpq._hash(name.replace("/", "\\").split("\\")[-1], "TABLE")
            if b.flags & 0x00020000:
                key = ((key + b.offset) ^ b.size) & 0xFFFFFFFF
        compressed = b.flags & 0x00000200
        if b.flags & 0x00000100:
            raise NotImplementedError("PKWARE imploded file " + name)
        if b.flags & 0x01000000:  # single unit
            if key is not None:
                raw = self.decrypt(raw, key)
            return self.decompress(raw) if compressed and b.size > b.archived_size else raw
        if not compressed:
            if key is None:
                return raw[:b.size]
            return b"".join(self.decrypt(raw[i:i + self.sector], key + n) for n, i in enumerate(range(0, b.size, self.sector)))
        count = (b.size + self.sector - 1) // self.sector
        table = raw[:4 * (count + 1)]
        if key is not None:
            table = self.decrypt(table, (key - 1) & 0xFFFFFFFF)
        offsets = struct.unpack("<%dI" % (count + 1), table)
        out = []
        left = b.size
        for n in range(count):
            sector = raw[offsets[n]:offsets[n + 1]]
            if key is not None:
                sector = self.decrypt(sector, (key + n) & 0xFFFFFFFF)
            want = min(self.sector, left)
            out.append(self.decompress(sector) if len(sector) < want else sector)
            left -= want
        return b"".join(out)


class GameData:
    """All MPQs of a client Data folder, searched in patch order. Files are looked up by their client path."""

    def __init__(self, data_dir):
        names = {os.path.splitext(f)[0].lower(): f for f in os.listdir(data_dir) if f.lower().endswith(".mpq")}
        order = [n for n in ARCHIVE_ORDER if n in names] + sorted(n for n in names if n not in ARCHIVE_ORDER)
        self.archives = [Archive(os.path.join(data_dir, names[n])) for n in order]

    def read(self, name):
        """File contents, or None when missing (callers cache what they parse)."""
        name = name.replace("/", "\\")
        for a in self.archives:
            b = a.block(name)
            if b is None or not b.flags & 0x80000000:
                continue
            if b.flags & 0x02000000 or not b.size:  # a delete marker hides older copies
                return None
            return a.read(name, b)
        return None


def chunks(data, start=0, end=None):
    """(tag, data offset, size) of each IFF chunk; WoW stores the tags reversed."""
    end = len(data) if end is None else end
    p = start
    while p + 8 <= end:
        tag = data[p:p + 4][::-1].decode("latin1")
        size = struct.unpack_from("<I", data, p + 4)[0]
        yield tag, p + 8, size
        p += 8 + size


def cstrings(blob):
    """Offset -> string for a block of NUL-terminated strings (MTEX, MMDX, MOTX, MODN...)."""
    out, start = {}, 0
    for i, ch in enumerate(blob):
        if ch == 0:
            if i > start:
                out[start] = blob[start:i].decode("latin1")
            start = i + 1
    return out


# ---------- matrices (4x4, column vectors, rows of a list) ----------

def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def translate(x, y, z):
    return [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]


def scale_m(f):
    return [[f, 0, 0, 0], [0, f, 0, 0], [0, 0, f, 0], [0, 0, 0, 1]]


def rot(axis, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    if axis == "x":
        return [[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]]
    if axis == "y":
        return [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]]
    return [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def quat_m(x, y, z, w):
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0], [0, 0, 0, 1]]


IDENTITY = translate(0, 0, 0)
NATIVE_TO_P = [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]]  # model z-up -> placement y-up
P_TO_W = [[0, 0, -1, ZERO], [-1, 0, 0, ZERO], [0, 1, 0, 0], [0, 0, 0, 1]]  # placement -> world


def placement(pos, rotation, scale=1.0):
    """Model -> W matrix for an MDDF/MODF entry (pos and rotation in placement space, degrees)."""
    a, b, c = rotation
    m = mat_mul(P_TO_W, translate(*pos))
    for r in (rot("y", b - 90), rot("z", -a), rot("x", c), NATIVE_TO_P, scale_m(scale)):
        m = mat_mul(m, r)
    return m


def transform_points(m, pts):
    """Flat [x, y, z, ...] list through matrix m."""
    (a, b, c, d), (e, f, g, h), (i, j, k, l) = m[0], m[1], m[2]
    out = array.array("f")
    for n in range(0, len(pts), 3):
        x, y, z = pts[n], pts[n + 1], pts[n + 2]
        out.extend((a * x + b * y + c * z + d, e * x + f * y + g * z + h, i * x + j * y + k * z + l))
    return out


def transform_normals(m, nrm):
    (a, b, c, _), (e, f, g, _), (i, j, k, _) = m[0], m[1], m[2]
    out = array.array("f")
    for n in range(0, len(nrm), 3):
        x, y, z = nrm[n], nrm[n + 1], nrm[n + 2]
        u, v, w = a * x + b * y + c * z, e * x + f * y + g * z, i * x + j * y + k * z
        s = math.sqrt(u * u + v * v + w * w) or 1.0
        out.extend((u / s, v / s, w / s))
    return out


# ---------- textures ----------

class Textures:
    """BLP files decoded once, downscaled to at most max_px and encoded for the GLB (JPEG unless alpha is used)."""

    def __init__(self, data, max_px):
        self.data = data
        self.max_px = max_px
        self.images = {}
        self.encoded = {}
        self.missing = set()

    def image(self, path):
        key = path.lower()
        if key not in self.images:
            raw = self.data.read(path)
            im = None
            if raw:
                try:
                    im = Image.open(io.BytesIO(raw))
                    im.load()
                    im = im.convert("RGBA")
                except Exception as e:  # odd BLP variants: report and use a neutral colour
                    print(f"  texture {path}: {e}")
                    im = None
            if im is None:
                self.missing.add(path)
            self.images[key] = im
        return self.images[key]

    def has_alpha(self, path):
        im = self.image(path)
        return im is not None and im.getchannel("A").getextrema()[0] < 128

    def encode(self, path, alpha, max_px=None):
        """(bytes, mime) or None."""
        key = (path.lower(), alpha, max_px)
        if key not in self.encoded:
            im = self.image(path)
            if im is None:
                self.encoded[key] = None
            else:
                limit = max_px or self.max_px
                if max(im.size) > limit:
                    f = limit / max(im.size)
                    im = im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.LANCZOS)
                buf = io.BytesIO()
                if alpha:
                    im.save(buf, "PNG", optimize=True)
                    self.encoded[key] = (buf.getvalue(), "image/png")
                else:
                    im.convert("RGB").save(buf, "JPEG", quality=85)
                    self.encoded[key] = (buf.getvalue(), "image/jpeg")
        return self.encoded[key]


# ---------- geometry collection ----------

class Part:
    """Indexed triangles for one material, already in glTF metres."""

    def __init__(self):
        self.pos = array.array("f")
        self.nrm = array.array("f")
        self.uv = array.array("f")
        self.idx = array.array("I")

    def count(self):
        return len(self.pos) // 3


class Output:
    """Converts W coordinates to glTF and collects parts per (node, material key)."""

    def __init__(self, cx, cy, ground):
        self.cx, self.cy, self.ground = cx, cy, ground
        self.nodes = {}  # node name -> {material key: Part}

    def part(self, node, key):
        return self.nodes.setdefault(node, {}).setdefault(key, Part())

    def add(self, node, key, pos_w, nrm_w, uv, tris):
        """pos_w/nrm_w: flat W coordinates; tris: flat local indices."""
        part = self.part(node, key)
        base = part.count()
        cx, cy, g = self.cx, self.cy, self.ground
        for n in range(0, len(pos_w), 3):
            part.pos.extend(((cy - pos_w[n + 1]) * YARD, (pos_w[n + 2] - g) * YARD, (cx - pos_w[n]) * YARD))
            part.nrm.extend((-nrm_w[n + 1], nrm_w[n + 2], -nrm_w[n]))
        part.uv.extend(uv)
        part.idx.extend(base + i for i in tris)


def winding_fix(pos, nrm, tris):
    """Orders each triangle counter-clockwise around its vertex normals (glTF's front face)."""
    out = array.array("I")
    for t in range(0, len(tris), 3):
        a, b, c = tris[t], tris[t + 1], tris[t + 2]
        ax, ay, az = pos[3 * a:3 * a + 3]
        ux, uy, uz = pos[3 * b] - ax, pos[3 * b + 1] - ay, pos[3 * b + 2] - az
        vx, vy, vz = pos[3 * c] - ax, pos[3 * c + 1] - ay, pos[3 * c + 2] - az
        fx, fy, fz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        sx = nrm[3 * a] + nrm[3 * b] + nrm[3 * c]
        sy = nrm[3 * a + 1] + nrm[3 * b + 1] + nrm[3 * c + 1]
        sz = nrm[3 * a + 2] + nrm[3 * b + 2] + nrm[3 * c + 2]
        out.extend((a, b, c) if fx * sx + fy * sy + fz * sz >= 0 else (a, c, b))
    return out


# ---------- terrain (ADT v18) ----------

class Chunk:
    """One MCNK: position of its north-west corner (W x, y, base z), 145 heights, layers, shadow, liquid."""


def parse_adt(raw, tx, ty):
    """Returns dict with MTEX/MMDX/MWMO names, MDDF/MODF placements and the 256 MCNK chunks."""
    adt = {"tx": tx, "ty": ty, "textures": [], "m2": [], "wmo": [], "mddf": [], "modf": [], "chunks": []}
    mmdx = mwmo = {}
    for tag, p, size in chunks(raw):
        if tag == "MTEX":
            adt["textures"] = list(cstrings(raw[p:p + size]).values())
        elif tag == "MMDX":
            mmdx = cstrings(raw[p:p + size])
        elif tag == "MMID":
            adt["m2"] = [mmdx.get(o, "") for o in struct.unpack_from("<%dI" % (size // 4), raw, p)]
        elif tag == "MWMO":
            mwmo = cstrings(raw[p:p + size])
        elif tag == "MWID":
            adt["wmo"] = [mwmo.get(o, "") for o in struct.unpack_from("<%dI" % (size // 4), raw, p)]
        elif tag == "MDDF":
            for q in range(p, p + size - 35, 36):
                name, uid = struct.unpack_from("<II", raw, q)
                pos, rotation = struct.unpack_from("<3f", raw, q + 8), struct.unpack_from("<3f", raw, q + 20)
                scale, flags = struct.unpack_from("<HH", raw, q + 32)
                adt["mddf"].append({"name": name, "uid": uid, "pos": pos, "rot": rotation, "scale": scale / 1024.0})
        elif tag == "MODF":
            for q in range(p, p + size - 63, 64):
                name, uid = struct.unpack_from("<II", raw, q)
                pos, rotation = struct.unpack_from("<3f", raw, q + 8), struct.unpack_from("<3f", raw, q + 20)
                ext = struct.unpack_from("<6f", raw, q + 32)
                flags, doodad_set = struct.unpack_from("<HH", raw, q + 56)
                adt["modf"].append({"name": name, "uid": uid, "pos": pos, "rot": rotation, "ext": ext, "set": doodad_set})
        elif tag == "MCNK":
            adt["chunks"].append(parse_mcnk(raw, p - 8))
    return adt


def subchunk(base, ofs):
    """Data offset of the sub chunk an MCNK header offset points at."""
    return base + ofs + 8 if ofs else None


def parse_mcnk(raw, base):
    h = base + 8
    c = Chunk()
    (c.flags, c.ix, c.iy, n_layers, _, ofs_h, _, ofs_ly, _, ofs_a, size_a, ofs_sh, size_sh, c.area, _,
     c.holes) = struct.unpack_from("<15IH", raw, h)
    ofs_lq, size_lq = struct.unpack_from("<II", raw, h + 0x60)
    c.x, c.y, c.z = struct.unpack_from("<3f", raw, h + 0x68)
    c.heights = struct.unpack_from("<145f", raw, subchunk(base, ofs_h))
    c.layers = []
    p = subchunk(base, ofs_ly)
    alpha = subchunk(base, ofs_a)
    for n in range(n_layers):
        tex, flags, ofs, effect = struct.unpack_from("<4I", raw, p + 16 * n)
        amap = raw[alpha + ofs:alpha + ofs + 2048] if n and flags & 0x100 and alpha else None
        c.layers.append((tex, amap))
    c.shadow = None
    if size_sh > 8 and ofs_sh:
        sp = subchunk(base, ofs_sh)
        c.shadow = raw[sp:sp + 512]
    c.liquid = None
    if ofs_lq and size_lq > 8 and c.flags & 0x3C:
        lp = base + ofs_lq + 8
        heights = [struct.unpack_from("<f", raw, lp + 8 + 8 * k + 4)[0] for k in range(81)]
        tiles = raw[lp + 8 + 81 * 8:lp + 8 + 81 * 8 + 64]
        kind = "magma" if c.flags & 0x10 else "slime" if c.flags & 0x20 else "water"
        c.liquid = (kind, heights, tiles)
    return c


def chunk_vertex(c, k):
    """W position of MCVT vertex k (rows of 9 outer then 8 inner vertices)."""
    row, col = divmod(k, 17)
    if col < 9:
        i, j = row, col
    else:
        i, j = row + 0.5, col - 9 + 0.5
    return c.x - i * UNIT, c.y - j * UNIT, c.z + c.heights[k]


def outer_index(i, j):
    return i * 17 + j


def inner_index(i, j):
    return i * 17 + 9 + j


class Terrain:
    """Height lookup across chunk and tile borders, for seamless normals."""

    def __init__(self):
        self.outer = {}  # (global row, global col) -> height

    def add(self, adt, c):
        gi0, gj0 = (adt["ty"] * 16 + c.iy) * 8, (adt["tx"] * 16 + c.ix) * 8
        for i in range(9):
            for j in range(9):
                self.outer[(gi0 + i, gj0 + j)] = c.z + c.heights[outer_index(i, j)]

    def normal(self, gi, gj):
        """W normal at an outer grid point (rows run -x, cols run -y)."""
        h = self.outer.get
        c = h((gi, gj))
        dn = (h((gi + 1, gj), c) - h((gi - 1, gj), c)) / (2 * UNIT)  # dz per row step (toward -x)
        de = (h((gi, gj + 1), c) - h((gi, gj - 1), c)) / (2 * UNIT)  # dz per col step (toward -y)
        nx, ny, nz = dn, de, 1.0  # dz/dx = -dn, so the normal's x is +dn
        s = math.sqrt(nx * nx + ny * ny + 1.0)
        return nx / s, ny / s, nz / s


def chunk_mesh(terrain, adt, c):
    """W positions, normals, chunk-local uv (0..1) and triangles of one MCNK, holes left open."""
    gi0, gj0 = (adt["ty"] * 16 + c.iy) * 8, (adt["tx"] * 16 + c.ix) * 8
    pos, nrm, uv = [], [], []
    for k in range(145):
        pos.extend(chunk_vertex(c, k))
        row, col = divmod(k, 17)
        if col < 9:
            n = terrain.normal(gi0 + row, gj0 + col)
            uv.extend((col / 8.0, row / 8.0))
        else:
            ns = [terrain.normal(gi0 + row + a, gj0 + col - 9 + b) for a in (0, 1) for b in (0, 1)]
            n = [sum(v[q] for v in ns) / 4 for q in range(3)]
            uv.extend(((col - 9 + 0.5) / 8.0, (row + 0.5) / 8.0))
        nrm.extend(n)
    tris = []
    for i in range(8):
        for j in range(8):
            if c.holes & (1 << ((i // 2) * 4 + j // 2)):
                continue
            a, b, d, e, m = outer_index(i, j), outer_index(i, j + 1), outer_index(i + 1, j), outer_index(i + 1, j + 1), inner_index(i, j)
            tris.extend((m, a, b, m, b, e, m, e, d, m, d, a))
    return pos, nrm, uv, tris


class TerrainPainter:
    """Bakes a chunk's texture layers into one image: each layer texture repeats 8 times across the chunk."""

    def __init__(self, textures, cell_px, shadow):
        self.textures = textures
        self.cell = cell_px
        self.shadow = shadow
        self.tiled = {}

    def layer(self, path):
        key = path.lower()
        if key not in self.tiled:
            im = self.textures.image(path)
            rep = max(1, self.cell // 8)
            if im is None:
                tile = Image.new("RGB", (rep, rep), (110, 120, 80))
            else:
                tile = im.convert("RGB").resize((rep, rep), Image.LANCZOS)
            big = Image.new("RGB", (self.cell, self.cell))
            for a in range(0, self.cell, rep):
                for b in range(0, self.cell, rep):
                    big.paste(tile, (a, b))
            self.tiled[key] = big
        return self.tiled[key]

    def paint(self, adt, c):
        names = adt["textures"]
        if not c.layers:
            return Image.new("RGB", (self.cell, self.cell), (110, 120, 80))
        img = self.layer(names[c.layers[0][0]]).copy()
        for tex, amap in c.layers[1:]:
            if amap is None or len(amap) < 2048:
                continue
            vals = bytearray(4096)
            for k, byte in enumerate(amap):
                vals[2 * k] = (byte & 0x0F) * 17
                vals[2 * k + 1] = (byte >> 4) * 17
            mask = Image.frombytes("L", (64, 64), bytes(vals)).resize((self.cell, self.cell), Image.BILINEAR)
            img = Image.composite(self.layer(names[tex]), img, mask)
        if c.shadow and self.shadow < 1.0:
            bits = bytearray(4096)
            for k, byte in enumerate(c.shadow):
                for b in range(8):
                    bits[k * 8 + b] = 255 if byte >> b & 1 else 0
            mask = Image.frombytes("L", (64, 64), bytes(bits)).resize((self.cell, self.cell), Image.BILINEAR)
            dark = img.point(lambda v: int(v * self.shadow))
            img = Image.composite(dark, img, mask)
        return img


# ---------- WMO v17 ----------

class Wmo:
    """Root file plus groups. Geometry stays in the WMO's native frame (z-up, yards)."""

    def __init__(self, data, path):
        raw = data.read(path)
        if raw is None:
            raise FileNotFoundError(path)
        self.path = path
        self.materials, self.doodad_sets, self.doodads, self.groups = [], [], [], []
        motx = modn = {}
        n_groups = 0
        for tag, p, size in chunks(raw):
            if tag == "MOHD":
                n_groups = struct.unpack_from("<I", raw, p + 4)[0]
            elif tag == "MOTX":
                motx = cstrings(raw[p:p + size])
            elif tag == "MOMT":
                for q in range(p, p + size - 63, 64):
                    flags, shader, blend, tex1 = struct.unpack_from("<4I", raw, q)
                    self.materials.append({"flags": flags, "blend": blend, "texture": motx.get(tex1)})
            elif tag == "MODS":
                for q in range(p, p + size - 31, 32):
                    self.doodad_sets.append(struct.unpack_from("<II", raw, q + 20))
            elif tag == "MODN":
                modn = cstrings(raw[p:p + size])
            elif tag == "MODD":
                for q in range(p, p + size - 39, 40):
                    name = struct.unpack_from("<I", raw, q)[0] & 0xFFFFFF
                    pos = struct.unpack_from("<3f", raw, q + 4)
                    quat = struct.unpack_from("<4f", raw, q + 16)
                    scale = struct.unpack_from("<f", raw, q + 32)[0]
                    self.doodads.append({"name": modn.get(name, ""), "pos": pos, "quat": quat, "scale": scale})
        stem = path[:-4]
        for g in range(n_groups):
            graw = data.read(f"{stem}_{g:03d}.wmo")
            if graw:
                self.groups.append(self.parse_group(graw))

    @staticmethod
    def parse_group(raw):
        g = {"pos": (), "nrm": (), "uv": (), "idx": (), "mopy": b"", "liquid": None, "doodads": (), "flags": 0}
        for tag, p, size in chunks(raw):
            if tag != "MOGP":
                continue
            g["flags"] = struct.unpack_from("<I", raw, p + 8)[0]
            for t2, q, s2 in chunks(raw, p + 68, p + size):
                if t2 == "MOPY":
                    g["mopy"] = raw[q:q + s2]
                elif t2 == "MOVI":
                    g["idx"] = struct.unpack_from("<%dH" % (s2 // 2), raw, q)
                elif t2 == "MOVT":
                    g["pos"] = struct.unpack_from("<%df" % (s2 // 4), raw, q)
                elif t2 == "MONR":
                    g["nrm"] = struct.unpack_from("<%df" % (s2 // 4), raw, q)
                elif t2 == "MODR":
                    g["doodads"] = struct.unpack_from("<%dH" % (s2 // 2), raw, q)
                elif t2 == "MOTV" and not g["uv"]:
                    g["uv"] = struct.unpack_from("<%df" % (s2 // 4), raw, q)
                elif t2 == "MLIQ":
                    xv, yv, xt, yt = struct.unpack_from("<4I", raw, q)
                    corner = struct.unpack_from("<3f", raw, q + 16)
                    v0 = q + 30
                    heights = [struct.unpack_from("<f", raw, v0 + 8 * k + 4)[0] for k in range(xv * yv)]
                    tiles = raw[v0 + 8 * xv * yv:v0 + 8 * xv * yv + xt * yt]
                    g["liquid"] = (xv, yv, xt, yt, corner, heights, tiles)
        return g


# ---------- M2 (version 256) ----------

def m2_array(raw, ofs):
    return struct.unpack_from("<II", raw, ofs)


class M2:
    """Static mesh of the first view: (texture path or None, blend mode, two-sided, positions, normals, uvs,
    triangles) per batch, in the model's native frame. radius: bounding sphere radius in yards."""

    def __init__(self, data, path):
        raw = data.read(path)
        if raw is None or raw[:4] != b"MD20":
            raise FileNotFoundError(path)
        self.path = path
        n_vert, ofs_vert = m2_array(raw, 0x44)
        n_view, ofs_view = m2_array(raw, 0x4C)
        n_tex, ofs_tex = m2_array(raw, 0x5C)
        n_mat, ofs_mat = m2_array(raw, 0x84)
        n_tl, ofs_tl = m2_array(raw, 0x94)
        self.radius = struct.unpack_from("<f", raw, 0xCC)[0]
        textures = []
        for t in range(n_tex):
            kind, flags, n_name, ofs_name = struct.unpack_from("<4I", raw, ofs_tex + 16 * t)
            textures.append(raw[ofs_name:ofs_name + n_name].split(b"\0")[0].decode("latin1") if kind == 0 and n_name else None)
        tex_lookup = struct.unpack_from("<%dH" % n_tl, raw, ofs_tl) if n_tl else ()
        mats = [struct.unpack_from("<HH", raw, ofs_mat + 4 * m) for m in range(n_mat)]
        self.batches = []
        if not n_view or not n_vert:
            return
        verts = [struct.unpack_from("<3f8x3f2f8x", raw, ofs_vert + 48 * v) for v in range(n_vert)]
        (n_vi, o_vi), (n_ix, o_ix), _, (n_sub, o_sub), (n_bat, o_bat) = [m2_array(raw, ofs_view + 8 * k) for k in range(5)]
        vlist = struct.unpack_from("<%dH" % n_vi, raw, o_vi)
        ilist = struct.unpack_from("<%dH" % n_ix, raw, o_ix)
        subs = [struct.unpack_from("<10H", raw, o_sub + 32 * s) for s in range(n_sub)]
        seen = set()
        for b in range(n_bat):
            (flags, prio, shader, sub, geoset, color, mat, layer, tex_count, tex_combo,
             _, _, _) = struct.unpack_from("<BbHHHhHHHHHHH", raw, o_bat + 24 * b)
            if sub >= len(subs) or (sub, layer) in seen:
                continue
            seen.add((sub, layer))
            mflags, blend = mats[mat] if mat < len(mats) else (0, 0)
            if blend >= 3 or layer > 0:  # additive glows, modulate decals and extra texture layers
                continue
            tex = textures[tex_lookup[tex_combo]] if tex_combo < len(tex_lookup) and tex_lookup[tex_combo] < len(textures) else None
            _, level, vstart, vcount, istart, icount = subs[sub][:6]
            istart += level << 16  # vanilla keeps the index start's high bits in "level"
            local = {}
            pos, nrm, uv, tris = [], [], [], []
            for k in ilist[istart:istart + icount]:
                gv = vlist[k] if k < len(vlist) else 0
                if gv not in local:
                    local[gv] = len(local)
                    v = verts[gv] if gv < len(verts) else verts[0]
                    pos.extend(v[0:3])
                    nrm.extend(v[3:6])
                    uv.extend(v[6:8])
                tris.append(local[gv])
            self.batches.append((tex, blend, bool(mflags & 0x04), pos, nrm, uv, tris))


def m2_path(name):
    return re.sub(r"\.(mdx|mdl)$", ".m2", name, flags=re.I)


# ---------- glb writing ----------

class GlbWriter:
    def __init__(self):
        self.bin = bytearray()
        self.gltf = {"asset": {"version": "2.0", "generator": "sbg-maps wow_to_glb"}, "buffers": [], "bufferViews": [],
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

    def accessor(self, values, kind, comp=5126):
        """values: an array.array, flat."""
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[kind]
        if sys.byteorder != "little":
            values = array.array(values.typecode, values)
            values.byteswap()
        data = values.tobytes()
        target = 34963 if kind == "SCALAR" else 34962
        acc = {"bufferView": self.view(data, target), "componentType": comp, "count": len(values) // width, "type": kind}
        if kind == "VEC3":
            acc["min"] = [min(values[i::3]) for i in range(3)]
            acc["max"] = [max(values[i::3]) for i in range(3)]
        self.gltf["accessors"].append(acc)
        return len(self.gltf["accessors"]) - 1

    def image(self, key, encoded, clamp=False):
        if key not in self.image_index:
            data, mime = encoded
            self.gltf["images"].append({"bufferView": self.view(data), "mimeType": mime, "name": key})
            wrap = 33071 if clamp else 10497
            sampler = {"wrapS": wrap, "wrapT": wrap}
            if sampler not in self.gltf["samplers"]:
                self.gltf["samplers"].append(sampler)
            self.gltf["textures"].append({"source": len(self.gltf["images"]) - 1, "sampler": self.gltf["samplers"].index(sampler)})
            self.image_index[key] = len(self.gltf["textures"]) - 1
        return self.image_index[key]

    def material(self, key, name, texture, extras, alpha=None, double_sided=True, color=None):
        """texture: (image key, encoded, clamp) or None."""
        if key in self.material_index:
            return self.material_index[key]
        mat = {"name": name, "pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1}, "doubleSided": double_sided, "extras": extras}
        if texture and texture[1]:
            mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": self.image(texture[0], texture[1], texture[2])}
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

    def mesh(self, name, primitives):
        self.gltf["meshes"].append({"name": name, "primitives": primitives})
        return len(self.gltf["meshes"]) - 1

    def node(self, node):
        self.gltf["nodes"].append(node)
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


def primitive_for(writer, part, material):
    return {"attributes": {"POSITION": writer.accessor(part.pos, "VEC3"), "NORMAL": writer.accessor(part.nrm, "VEC3"),
                           "TEXCOORD_0": writer.accessor(part.uv, "VEC2")},
            "indices": writer.accessor(part.idx, "SCALAR", comp=5125), "material": material, "mode": 4}


def label(path):
    return os.path.splitext(os.path.basename((path or "untextured").replace("\\", "/")))[0].lower()


# ---------- area selection ----------

def parse_area(args):
    """(map, box (x1, y1, x2, y2) in W yards, tile list)."""
    map_name = args.map
    box = None
    if args.preset:
        preset = PRESETS[args.preset]
        if preset["map"].lower() != map_name.lower():
            sys.exit(f"preset {args.preset} is on map {preset['map']}")
        box = preset["box"]
    if args.box:
        box = tuple(float(v) for v in args.box.split(","))
    if args.tiles:
        t = [int(v) for v in args.tiles.split(",")]
        x1, y1, x2, y2 = (t * 2)[:4] if len(t) == 2 else t
        # Tile (X, Y) covers W x in [(32 - Y - 1) * TILE, (32 - Y) * TILE] and W y likewise with X.
        tbox = ((32 - max(y1, y2) - 1) * TILE, (32 - max(x1, x2) - 1) * TILE, (32 - min(y1, y2)) * TILE, (32 - min(x1, x2)) * TILE)
        box = tbox if box is None else (max(box[0], tbox[0]), max(box[1], tbox[1]), min(box[2], tbox[2]), min(box[3], tbox[3]))
    if box is None:
        sys.exit("pick an area with --preset, --tiles or --box")
    x1, y1, x2, y2 = min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])
    tiles = [(tx, ty) for tx in range(int(32 - y2 / TILE), int(32 - y1 / TILE) + 1)
             for ty in range(int(32 - x2 / TILE), int(32 - x1 / TILE) + 1)]
    return map_name, (x1, y1, x2, y2), tiles


def chunk_in_box(c, box):
    return c.x - CHUNK < box[2] and c.x > box[0] and c.y - CHUNK < box[3] and c.y > box[1]


def point_in_box(x, y, box, margin=0.0):
    return box[0] - margin <= x <= box[2] + margin and box[1] - margin <= y <= box[3] + margin


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("data", help="client Data folder holding the .MPQ files")
    ap.add_argument("map", help="map folder name, e.g. Azeroth (Eastern Kingdoms) or Kalimdor")
    ap.add_argument("out", help="output .glb")
    ap.add_argument("--preset", choices=sorted(PRESETS), help="named area: " + ", ".join(sorted(PRESETS)))
    ap.add_argument("--tiles", help="ADT tiles X,Y or X1,Y1,X2,Y2 (as in Map_X_Y.adt)")
    ap.add_argument("--box", help="W box x1,y1,x2,y2 in yards (x north, y west, as the server's .gps shows)")
    ap.add_argument("--chunk-px", type=int, default=256, help="terrain texture pixels per chunk (33 yards); default 256")
    ap.add_argument("--max-tex", type=int, default=512, help="largest model texture side in pixels; default 512")
    ap.add_argument("--min-doodad", type=float, default=1.0, help="skip doodads with a bounding radius under this many yards; default 1")
    ap.add_argument("--shadow", type=float, default=0.7, help="brightness of baked terrain shadows (1 = none); default 0.7")
    ap.add_argument("--interiors", action="store_true", help="keep WMO interior groups (rooms inside buildings) and their doodads")
    ap.add_argument("--no-doodads", action="store_true", help="leave out M2 doodads")
    ap.add_argument("--no-wmo", action="store_true", help="leave out WMO buildings")
    ap.add_argument("--no-water", action="store_true", help="leave out liquids")
    args = ap.parse_args()
    map_name, box, tiles = parse_area(args)

    data = GameData(args.data)
    textures = Textures(data, args.max_tex)
    print(f"{len(data.archives)} archives; map {map_name}, box {box}, {len(tiles)} tiles")

    adts = []
    for tx, ty in tiles:
        raw = data.read(f"World\\Maps\\{map_name}\\{map_name}_{tx}_{ty}.adt")
        if raw:
            adts.append(parse_adt(raw, tx, ty))
    if not adts:
        sys.exit("no ADT tiles found for that area")
    terrain = Terrain()
    picked = []  # (adt, chunk)
    for adt in adts:
        for c in adt["chunks"]:
            terrain.add(adt, c)
            if chunk_in_box(c, box):
                picked.append((adt, c))
    ground = min(c.z + min(c.heights) for _, c in picked)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    out = Output(cx, cy, ground)
    writer = GlbWriter()
    print(f"terrain: {len(picked)} chunks, lowest point {ground:.1f} yd")

    # Terrain: one baked texture and one primitive per tile.
    painter = TerrainPainter(textures, args.chunk_px, args.shadow)
    cell = args.chunk_px
    terrain_prims = []
    for adt in adts:
        mine = [c for a, c in picked if a is adt]
        if not mine:
            continue
        ix0, iy0 = min(c.ix for c in mine), min(c.iy for c in mine)
        w, h = (max(c.ix for c in mine) - ix0 + 1) * cell, (max(c.iy for c in mine) - iy0 + 1) * cell
        atlas = Image.new("RGB", (w, h), (110, 120, 80))
        part = Part()
        for c in mine:
            ox, oy = (c.ix - ix0) * cell, (c.iy - iy0) * cell
            atlas.paste(painter.paint(adt, c), (ox, oy))
            pos, nrm, uv, tris = chunk_mesh(terrain, adt, c)
            base = part.count()
            for n in range(0, len(pos), 3):
                part.pos.extend(((cy - pos[n + 1]) * YARD, (pos[n + 2] - ground) * YARD, (cx - pos[n]) * YARD))
                part.nrm.extend((-nrm[n + 1], nrm[n + 2], -nrm[n]))
            for n in range(0, len(uv), 2):  # half a pixel in from the cell edges so neighbours do not bleed in
                part.uv.extend(((ox + 0.5 + uv[n] * (cell - 1)) / w, (oy + 0.5 + uv[n + 1] * (cell - 1)) / h))
            local = array.array("I", (base + t for t in tris))
            part.idx.extend(winding_fix(part.pos, part.nrm, local))
        buf = io.BytesIO()
        atlas.save(buf, "JPEG", quality=85)
        name = f"{map_name}_{adt['tx']}_{adt['ty']}"
        mat = writer.material(("terrain", name), f"terrain {name}", (name, (buf.getvalue(), "image/jpeg"), True),
                              {"surface": "rough", "wowTile": name})
        terrain_prims.append(primitive_for(writer, part, mat))
    writer.node({"name": "terrain", "mesh": writer.mesh("terrain", terrain_prims)})
    print(f"terrain: {len(terrain_prims)} tiles baked at {cell} px per chunk")

    # Liquids from the terrain chunks.
    water = {}  # kind -> (pos, nrm, uv, tris) in W
    if not args.no_water:
        for adt, c in picked:
            if not c.liquid:
                continue
            kind, heights, tflags = c.liquid
            w = water.setdefault(kind, ([], [], [], []))
            for i in range(8):
                for j in range(8):
                    if j + i * 8 >= len(tflags) or tflags[i * 8 + j] & 0x0F == 0x0F:
                        continue
                    base = len(w[0]) // 3
                    for a, b in ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j)):
                        w[0].extend((c.x - a * UNIT, c.y - b * UNIT, heights[a * 9 + b]))
                        w[1].extend((0.0, 0.0, 1.0))
                        w[2].extend((b / 8.0, a / 8.0))
                    w[3].extend((base, base + 1, base + 2, base, base + 2, base + 3))

    # Placed objects, each once even when listed by several tiles.
    wmo_cache, m2_cache = {}, {}
    seen_uid = set()
    skipped_small = 0
    instances = 0

    def m2(path):
        path = m2_path(path)
        if path.lower() not in m2_cache:
            try:
                m2_cache[path.lower()] = M2(data, path)
            except (FileNotFoundError, struct.error) as e:
                print(f"  model {path}: {e}")
                m2_cache[path.lower()] = None
        return m2_cache[path.lower()]

    def place_m2(path, matrix, scale):
        nonlocal skipped_small, instances
        model = m2(path)
        if model is None or not model.batches:
            return
        if model.radius * scale < args.min_doodad:
            skipped_small += 1
            return
        instances += 1
        foliage = bool(FOLIAGE.search(path))
        for tex, blend, two_sided, pos, nrm, uv, tris in model.batches:
            alpha = "mask" if blend == 1 or (foliage and tex and textures.has_alpha(tex)) else "blend" if blend == 2 else None
            render_only = alpha is not None and foliage
            key = ("m2", (tex or "").lower(), alpha, render_only)
            pw, nw = transform_points(matrix, pos), transform_normals(matrix, nrm)
            out.add("doodads", key, pw, nw, uv, winding_fix(pw, nw, tris))

    if not args.no_wmo:
        for adt in adts:
            for o in adt["modf"]:
                x1, y1, z1, x2, y2, z2 = o["ext"]  # placement space extents
                wx1, wx2, wy1, wy2 = ZERO - z2, ZERO - z1, ZERO - x2, ZERO - x1
                if ("wmo", o["uid"]) in seen_uid or wx2 < box[0] or wx1 > box[2] or wy2 < box[1] or wy1 > box[3]:
                    continue
                seen_uid.add(("wmo", o["uid"]))
                path = adt["wmo"][o["name"]]
                if path.lower() not in wmo_cache:
                    try:
                        wmo_cache[path.lower()] = Wmo(data, path)
                    except FileNotFoundError as e:
                        print(f"  wmo {e}")
                        wmo_cache[path.lower()] = None
                wmo = wmo_cache[path.lower()]
                if wmo is None:
                    continue
                matrix = placement(o["pos"], o["rot"])
                tri_total = 0
                # Indoor groups (rooms inside buildings) and the doodads only they hold are left out unless asked for.
                # Outdoor parts of a city are flagged interior too (for portal culling) but lit as exterior (0x40).
                groups = [g for g in wmo.groups if args.interiors or g["flags"] & 0x2048 != 0x2000]
                kept_doodads = {d for g in groups for d in g["doodads"]}
                hidden_doodads = {d for g in wmo.groups for d in g["doodads"]} - kept_doodads
                for g in groups:
                    if not g["pos"]:
                        continue
                    pw, nw = transform_points(matrix, g["pos"]), transform_normals(matrix, g["nrm"] or [0.0, 0.0, 1.0] * (len(g["pos"]) // 3))
                    uv = g["uv"] or [0.0] * (len(g["pos"]) // 3 * 2)
                    by_key = {}
                    for t in range(len(g["idx"]) // 3):
                        flags, mat_id = g["mopy"][2 * t], g["mopy"][2 * t + 1]
                        render = flags & 0x20 and not flags & 0x04
                        collides = flags & 0x08 or render
                        if mat_id == 0xFF or mat_id >= len(wmo.materials):
                            if not collides:
                                continue
                            key = ("wmo-collision",)
                        else:
                            m = wmo.materials[mat_id]
                            alpha = "mask" if m["blend"] == 1 else "blend" if m["blend"] >= 2 else None
                            key = ("wmo", (m["texture"] or "").lower(), alpha, not collides)
                        by_key.setdefault(key, []).extend(g["idx"][3 * t:3 * t + 3])
                    for key, tris in by_key.items():
                        tri_total += len(tris) // 3
                        # Keep only the vertices these triangles use.
                        remap = {}
                        for v in tris:
                            remap.setdefault(v, len(remap))
                        order = list(remap)
                        sub_p = array.array("f", (pw[3 * v + k] for v in order for k in range(3)))
                        sub_n = array.array("f", (nw[3 * v + k] for v in order for k in range(3)))
                        sub_uv = array.array("f", (uv[2 * v + k] for v in order for k in range(2)))
                        local = array.array("I", (remap[v] for v in tris))
                        out.add("buildings", key, sub_p, sub_n, sub_uv, winding_fix(sub_p, sub_n, local))
                    if g["liquid"] and not args.no_water:
                        xv, yv, xt, yt, corner, heights, tflags = g["liquid"]
                        w = water.setdefault("water", ([], [], [], []))
                        for ty_ in range(yt):
                            for tx_ in range(xt):
                                if ty_ * xt + tx_ >= len(tflags) or tflags[ty_ * xt + tx_] & 0x0F == 0x0F:
                                    continue
                                base = len(w[0]) // 3
                                for a, b in ((tx_, ty_), (tx_ + 1, ty_), (tx_ + 1, ty_ + 1), (tx_, ty_ + 1)):
                                    p = transform_points(matrix, [corner[0] + a * UNIT, corner[1] + b * UNIT, heights[b * xv + a]])
                                    w[0].extend(p)
                                    w[1].extend((0.0, 0.0, 1.0))
                                    w[2].extend((a / 8.0, b / 8.0))
                                w[3].extend((base, base + 1, base + 2, base, base + 2, base + 3))
                # Doodads: the global set (0) plus the set this placement picks.
                if not args.no_doodads:
                    for s in sorted({0, o["set"]}):
                        if s >= len(wmo.doodad_sets):
                            continue
                        first, count = wmo.doodad_sets[s]
                        for n in range(first, min(first + count, len(wmo.doodads))):
                            d = wmo.doodads[n]
                            if not d["name"] or n in hidden_doodads:
                                continue
                            dm = mat_mul(matrix, mat_mul(translate(*d["pos"]), mat_mul(quat_m(*d["quat"]), scale_m(d["scale"]))))
                            place_m2(d["name"], dm, d["scale"])
                print(f"wmo {path}: {len(groups)} of {len(wmo.groups)} groups, {tri_total} triangles, doodad set {o['set']}")

    if not args.no_doodads:
        for adt in adts:
            for d in adt["mddf"]:
                wx, wy = ZERO - d["pos"][2], ZERO - d["pos"][0]
                if ("m2", d["uid"]) in seen_uid or not point_in_box(wx, wy, box):
                    continue
                seen_uid.add(("m2", d["uid"]))
                place_m2(adt["m2"][d["name"]], placement(d["pos"], d["rot"], d["scale"]), d["scale"])
    print(f"doodads: {instances} placed, {skipped_small} skipped as smaller than {args.min_doodad} yd, {len(m2_cache)} models")

    # Materials for buildings and doodads.
    for node in ("buildings", "doodads"):
        prims = []
        for key, part in sorted(out.nodes.get(node, {}).items(), key=lambda kv: str(kv[0])):
            if key == ("wmo-collision",):
                mat = writer.material(key, "wmo collision", None, {"surface": "rough", "invisible": True})
            else:
                kind, tex, alpha, render_only = key
                extras = {"surface": "none", "renderOnly": True} if render_only else {"surface": "rough"}
                enc = textures.encode(tex, alpha is not None) if tex else None
                name = label(tex) + (" (cut out)" if alpha == "mask" else " (see-through)" if alpha == "blend" else "") + (" (no collision)" if render_only else "")
                mat = writer.material(key, name, (label(tex) + ("-a" if alpha else ""), enc, False) if enc else None, extras, alpha,
                                      color=None if enc else (0.6, 0.6, 0.6, 1.0))
            prims.append(primitive_for(writer, part, mat))
        if prims:
            writer.node({"name": node, "mesh": writer.mesh(node, prims)})
            print(f"{node}: {sum(p.count() for p in out.nodes[node].values())} vertices, "
                  f"{sum(len(p.idx) for p in out.nodes[node].values()) // 3} triangles in {len(prims)} materials")

    if water:
        prims = []
        colours = {"water": (0.16, 0.34, 0.45, 0.7), "magma": (0.9, 0.35, 0.05, 1.0), "slime": (0.3, 0.55, 0.15, 0.85)}
        for kind, (pos, nrm, uv, tris) in water.items():
            part = out.part("water", kind)
            out.add("water", kind, array.array("f", pos), array.array("f", nrm), array.array("f", uv), array.array("I", tris))
            fixed = winding_fix(part.pos, part.nrm, part.idx)
            part.idx = fixed
            mat = writer.material(("liquid", kind), kind, None, {"surface": "none", "renderOnly": True},
                                  "blend" if colours[kind][3] < 1 else None, color=colours.get(kind, colours["water"]))
            prims.append(primitive_for(writer, part, mat))
        writer.node({"name": "water", "mesh": writer.mesh("water", prims)})
        print(f"water: {sum(len(p.idx) for p in out.nodes['water'].values()) // 3} triangles")

    if textures.missing:
        print(f"{len(textures.missing)} textures missing or undecodable, e.g. {sorted(textures.missing)[:3]}")
    writer.gltf["scenes"][0]["extras"] = {"source": "wow", "map": map_name,
                                          "worldOrigin": [-cy * YARD, ground * YARD, -cx * YARD]}
    writer.gltf["asset"]["extras"] = {"wowMap": map_name, "wowBox": list(box), "groundYards": ground,
                                      "centre": [cx, cy], "frame": "glTF = (-(Wy - cy), Wz - ground, -(Wx - cx)) * 0.9144"}
    writer.write(args.out)
    print(f"wrote {args.out}: {os.path.getsize(args.out) / 1e6:.1f} MB, {len(writer.gltf['materials'])} materials, "
          f"{len(writer.gltf['images'])} images; size {(box[3] - box[1]) * YARD:.0f} x {(box[2] - box[0]) * YARD:.0f} m")


if __name__ == "__main__":
    main()
