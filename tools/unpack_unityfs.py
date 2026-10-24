"""Stream-unpack a UnityFS bundle (data.unity3d) to a folder without holding it in memory.

usage: unpack_unityfs.py <bundle> <out_dir> [name_filter...]
With no filter it only lists the contained files.
"""
import os
import struct
import sys

import lz4.block


def read_cstr(f):
    out = bytearray()
    while (c := f.read(1)) not in (b"\0", b""):
        out += c
    return out.decode()


def main():
    path, out_dir, filters = sys.argv[1], sys.argv[2], sys.argv[3:]
    with open(path, "rb") as f:
        assert read_cstr(f) == "UnityFS"
        version = struct.unpack(">I", f.read(4))[0]
        read_cstr(f), read_cstr(f)
        size, ci_size, ui_size, flags = struct.unpack(">qIII", f.read(20))
        if version >= 7:
            f.seek((f.tell() + 15) // 16 * 16)
        if flags & 0x80:  # block info at end of file
            here = f.tell()
            f.seek(size - ci_size)
            ci = f.read(ci_size)
            f.seek(here)
        else:
            ci = f.read(ci_size)
        if flags & 0x200:  # block info needs padding
            f.seek((f.tell() + 15) // 16 * 16)
        data_start = f.tell()
        comp = flags & 0x3F
        info = lz4.block.decompress(ci, uncompressed_size=ui_size) if comp in (2, 3) else ci
        assert comp in (0, 2, 3), f"unsupported block-info compression {comp}"

        p = 16  # skip hash
        (nblocks,) = struct.unpack_from(">i", info, p)
        p += 4
        blocks = []
        for _ in range(nblocks):
            u, c, fl = struct.unpack_from(">IIH", info, p)
            p += 10
            blocks.append((u, c, fl))
        (nnodes,) = struct.unpack_from(">i", info, p)
        p += 4
        nodes = []
        for _ in range(nnodes):
            off, sz, fl = struct.unpack_from(">qqI", info, p)
            p += 20
            end = info.index(b"\0", p)
            nodes.append((off, sz, info[p:end].decode()))
            p = end + 1

        for off, sz, name in nodes:
            print(f"{sz:>12} {name}")
        wanted = [n for n in nodes if filters and n[2] in filters]
        if not wanted:
            return

        # Decompressed stream position -> block index, so we only decompress what wanted files cover.
        os.makedirs(out_dir, exist_ok=True)
        block_starts, pos, cpos = [], 0, data_start
        for u, c, fl in blocks:
            block_starts.append((pos, cpos, u, c, fl))
            pos += u
            cpos += c
        cache = {}

        def block(i):
            if i not in cache:
                cache.clear()
                upos, cp, u, c, fl = block_starts[i]
                f.seek(cp)
                raw = f.read(c)
                m = fl & 0x3F
                if m == 0:
                    cache[i] = raw
                elif m in (2, 3):
                    cache[i] = lz4.block.decompress(raw, uncompressed_size=u)
                else:
                    raise SystemExit(f"unsupported block compression {m}")
            return cache[i]

        for off, sz, name in wanted:
            dest = os.path.join(out_dir, name)
            with open(dest, "wb") as o:
                remaining, cur = sz, off
                i = max(k for k, b in enumerate(block_starts) if b[0] <= cur)
                while remaining:
                    upos = block_starts[i][0]
                    data = block(i)
                    chunk = data[cur - upos : cur - upos + remaining]
                    o.write(chunk)
                    remaining -= len(chunk)
                    cur += len(chunk)
                    i += 1
            print("wrote", dest)


main()
