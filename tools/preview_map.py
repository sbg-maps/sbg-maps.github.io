"""Render a top-down PNG of each hole in a map folder: surface colours, water, hillshade, tee/cup/item markers.

usage: preview_map.py <map_dir> <out_dir>
"""
import array
import json
import os
import struct
import sys
import zlib

COLORS = {0: (74, 128, 52), 1: (110, 180, 70), 2: (140, 215, 95), 3: (230, 210, 150), 4: (160, 120, 80), 5: (120, 120, 120)}
WATER = (60, 130, 200)


def write_png(path, w, h, pixels):
    raw = b"".join(b"\0" + bytes(pixels[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def main():
    map_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    manifest = json.load(open(os.path.join(map_dir, "map.json")))
    for n, hole in enumerate(manifest["holes"]):
        hm, pm = hole["heightmap"], hole["paintmap"]
        hs = array.array("H")
        hs.frombytes(open(os.path.join(map_dir, hm["file"]), "rb").read())
        paint = open(os.path.join(map_dir, pm["file"]), "rb").read()
        sx, sz = hole["size"]
        w, h = pm["width"], pm["depth"]

        def height(i, j):
            hi = min(int(i / w * (hm["width"] - 1)), hm["width"] - 1)
            hj = min(int(j / h * (hm["depth"] - 1)), hm["depth"] - 1)
            return hm["min"] + hs[hj * hm["width"] + hi] / 65535 * (hm["max"] - hm["min"])

        px = bytearray(w * h * 3)
        for j in range(h):
            for i in range(w):
                y = height(i, j)
                c = WATER if y < hole["water"] else COLORS.get(paint[j * w + i], (255, 0, 255))
                shade = 1.0 + 0.25 * (height(min(i + 1, w - 1), j) - height(max(i - 1, 0), j) + height(i, max(j - 1, 0)) - height(i, min(j + 1, h - 1)))
                shade = max(0.6, min(1.3, shade))
                row = h - 1 - j  # +z up in the image
                o = (row * w + i) * 3
                px[o:o + 3] = bytes(max(0, min(255, int(v * shade))) for v in c)

        def mark(x, z, color, r):
            ci, cj = int(x / sx * w), int(z / sz * h)
            for dj in range(-r, r + 1):
                for di in range(-r, r + 1):
                    i, j = ci + di, cj + dj
                    if 0 <= i < w and 0 <= j < h and di * di + dj * dj <= r * r:
                        o = ((h - 1 - j) * w + i) * 3
                        px[o:o + 3] = bytes(color)

        mark(hole["tee"]["x"], hole["tee"]["z"], (255, 255, 255), 6)
        mark(hole["cup"]["x"], hole["cup"]["z"], (220, 30, 30), 5)
        for b in hole.get("itemBoxes", []):
            mark(b["x"], b["z"], (250, 200, 0), 4)
        for c in hole.get("checkpoints", []):
            mark(c["x"], c["z"], (180, 0, 220), 5)
        out = os.path.join(out_dir, f"hole{n + 1}.png")
        write_png(out, w, h, px)
        print("wrote", out)


main()
