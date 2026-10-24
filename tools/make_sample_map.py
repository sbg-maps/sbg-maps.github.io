"""Generate the sample map pack (format 1) used to test the loader.

usage: make_sample_map.py <out_dir>
Writes <out_dir>/map.json plus raw grids. Heights are little-endian uint16, paint is one byte per cell
(0 rough, 1 fairway, 2 green, 3 sand, 4 dirt path, 5 out of bounds). Rows run along +z.
"""
import array
import json
import math
import os
import sys

RES = 0.5  # metres per sample
WATER = 5.0
H_MIN, H_MAX = 0.0, 64.0

ROUGH, FAIRWAY, GREEN, SAND = 0, 1, 2, 3


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def dist_to_segment(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def dist_to_path(px, pz, path):
    return min(dist_to_segment(px, pz, *path[i], *path[i + 1]) for i in range(len(path) - 1))


def write_hole(out_dir, key, size, height, surface):
    sx, sz = size
    hw, hd = int(sx / RES) + 1, int(sz / RES) + 1
    pw, pd = int(sx / RES), int(sz / RES)
    heights = array.array("H")
    for j in range(hd):
        z = j * RES
        for i in range(hw):
            h = height(i * RES, z)
            heights.append(int(round((min(max(h, H_MIN), H_MAX) - H_MIN) / (H_MAX - H_MIN) * 65535)))
    paint = bytearray()
    for j in range(pd):
        z = (j + 0.5) * RES
        for i in range(pw):
            paint.append(surface((i + 0.5) * RES, z))
    if sys.byteorder != "little":
        heights.byteswap()
    with open(os.path.join(out_dir, f"{key}.height.r16"), "wb") as f:
        heights.tofile(f)
    with open(os.path.join(out_dir, f"{key}.paint.u8"), "wb") as f:
        f.write(paint)
    return (
        {"file": f"{key}.height.r16", "width": hw, "depth": hd, "min": H_MIN, "max": H_MAX},
        {"file": f"{key}.paint.u8", "width": pw, "depth": pd},
    )


def dogleg(out_dir):
    size = (240.0, 420.0)
    tee = (110.0, 30.0)
    corner = (110.0, 240.0)
    cup = (175.0, 380.0)
    path = [tee, corner, cup]
    pond, pond_r = (45.0, 250.0), 30.0
    bunkers = [((140.0, 255.0), 9.0), ((195.0, 365.0), 6.0), ((150.0, 395.0), 5.0)]

    def base(x, z):
        return 20.0 + 2.5 * math.sin(x / 31.0) * math.cos(z / 47.0) + 5.0 * (z / size[1])

    cup_h = base(*cup)
    tee_h = base(*tee)

    def height(x, z):
        h = base(x, z)
        h = h + (tee_h - h) * (1 - smoothstep(8, 16, math.hypot(x - tee[0], z - tee[1])))
        h = h + (cup_h - h) * (1 - smoothstep(14, 24, math.hypot(x - cup[0], z - cup[1])))
        d = math.hypot(x - pond[0], z - pond[1])
        h = h + (1.5 - h) * (1 - smoothstep(pond_r * 0.6, pond_r, d))
        for (bx, bz), r in bunkers:
            h -= 0.8 * (1 - smoothstep(r * 0.5, r, math.hypot(x - bx, z - bz)))
        return h

    def surface(x, z):
        if math.hypot(x - cup[0], z - cup[1]) < 14:
            return GREEN
        for (bx, bz), r in bunkers:
            if math.hypot(x - bx, z - bz) < r:
                return SAND
        if math.hypot(x - pond[0], z - pond[1]) < pond_r + 3:
            return SAND
        if dist_to_path(x, z, path) < 16 and z > tee[1] + 12:
            return FAIRWAY
        return ROUGH

    hm, pm = write_hole(out_dir, "hole1", size, height, surface)
    boxes = [{"x": x, "z": z} for x, z in [(85, 90), (135, 90), (85, 160), (135, 160), (88, 220), (132, 225),
                                           (150, 300), (175, 290), (130, 330), (160, 340)]]
    return {
        "name": "Dogleg Dunes", "par": 4, "difficulty": "beginner", "theme": "coast",
        "size": list(size), "heightmap": hm, "paintmap": pm, "water": WATER,
        "tee": {"x": tee[0], "z": tee[1]}, "cup": {"x": cup[0], "z": cup[1]},
        "itemBoxes": boxes, "checkpoints": [{"x": corner[0], "z": corner[1]}],
        "returnPath": [list(tee), list(corner), list(cup)],
    }


def island_green(out_dir):
    size = (200.0, 300.0)
    tee = (100.0, 30.0)
    cup = (100.0, 245.0)
    island_r = 24.0

    def height(x, z):
        land = 22.0 + 1.5 * math.sin(x / 23.0)
        near = 1 - smoothstep(110, 130, z)         # tee side
        far = smoothstep(270, 285, z)              # back shore
        island = 1 - smoothstep(island_r - 6, island_r, math.hypot(x - cup[0], z - cup[1]))
        solid = max(near, far, island)
        return 1.0 + (land - 1.0) * solid

    def surface(x, z):
        if math.hypot(x - cup[0], z - cup[1]) < 15:
            return GREEN
        if math.hypot(x - cup[0], z - cup[1]) < island_r - 4:
            return FAIRWAY
        if abs(x - tee[0]) < 20 and tee[1] + 10 < z < 115:
            return FAIRWAY
        return SAND if 115 <= z <= 280 else ROUGH

    hm, pm = write_hole(out_dir, "hole2", size, height, surface)
    boxes = [{"x": x, "z": z} for x, z in [(70, 60), (130, 60), (70, 100), (130, 100)]]
    return {
        "name": "Island Green", "par": 3, "difficulty": "intermediate", "theme": "coast",
        "size": list(size), "heightmap": hm, "paintmap": pm, "water": WATER,
        "tee": {"x": tee[0], "z": tee[1]}, "cup": {"x": cup[0], "z": cup[1]},
        "itemBoxes": boxes, "checkpoints": [],
    }


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    manifest = {
        "format": 1,
        "id": "sbgmaps.sample-islands",
        "name": "Sample Islands",
        "author": "SbgMaps",
        "version": "1.0.0",
        "holes": [dogleg(out_dir), island_green(out_dir)],
    }
    with open(os.path.join(out_dir, "map.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("wrote", out_dir)


main()
