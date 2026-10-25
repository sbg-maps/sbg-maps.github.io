using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using BepInEx;
using Newtonsoft.Json;

namespace SbgMaps
{
    /// <summary>
    /// A map on disk: either a folder containing map.json, or a .sbgmap zip with map.json at its root.
    /// Data files are re-read on every access so map edits show up on the next hole restart.
    /// </summary>
    public class MapPack
    {
        public string Path { get; }
        public bool IsZip { get; }
        public MapManifest Manifest { get; private set; }
        public string Hash { get; private set; }

        private MapPack(string path)
        {
            Path = path;
            IsZip = File.Exists(path);
        }

        public static MapPack Load(string path)
        {
            var pack = new MapPack(path);
            pack.Reload();
            return pack;
        }

        /// <summary>Re-reads map.json and the content hash from disk.</summary>
        public void Reload()
        {
            var manifest = JsonConvert.DeserializeObject<MapManifest>(System.Text.Encoding.UTF8.GetString(ReadFile("map.json")));
            Validate(manifest);
            Manifest = manifest;
            Hash = ComputeHash();
        }

        public byte[] ReadFile(string relative)
        {
            if (relative.Contains("..") || System.IO.Path.IsPathRooted(relative))
                throw new InvalidDataException($"invalid file path '{relative}' in map");
            if (!IsZip)
                return File.ReadAllBytes(System.IO.Path.Combine(Path, relative));
            using var zip = ZipFile.OpenRead(Path);
            var entry = zip.GetEntry(relative.Replace('\\', '/')) ?? throw new FileNotFoundException($"'{relative}' not found in {Path}");
            using var stream = entry.Open();
            using var mem = new MemoryStream();
            stream.CopyTo(mem);
            return mem.ToArray();
        }

        /// <summary>The hole's heightmap grids, or null for holes without a heightmap.</summary>
        public HoleGrids LoadGrids(int holeIndex)
        {
            var hole = Manifest.holes[holeIndex];
            if (hole.heightmap == null)
                return null;
            return new HoleGrids(hole, ReadFile(hole.heightmap.file), hole.paintmap != null ? ReadFile(hole.paintmap.file) : null);
        }

        /// <summary>The level model of a hole: its own (a piece cut out for it) or the map's shared one.</summary>
        public GlbReader.Model LoadModel(int holeIndex)
        {
            string file = Manifest.holes[holeIndex].model?.file ?? Manifest.model?.file;
            return file != null ? GlbReader.Read(ReadFile(file)) : null;
        }

        /// <summary>
        /// Hash of the map's content (file names and bytes), the same whether it is a folder or a zip, so a folder
        /// map on the host and its downloaded zip on a player's machine match.
        /// </summary>
        private string ComputeHash()
        {
            using var sha = SHA256.Create();
            foreach (var (name, data) in Entries())
            {
                var nameBytes = System.Text.Encoding.UTF8.GetBytes(name);
                sha.TransformBlock(nameBytes, 0, nameBytes.Length, null, 0);
                sha.TransformBlock(data, 0, data.Length, null, 0);
            }
            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        }

        /// <summary>All files of the map as (relative path, bytes), in a stable order.</summary>
        private IEnumerable<(string name, byte[] data)> Entries()
        {
            if (IsZip)
            {
                using var zip = ZipFile.OpenRead(Path);
                foreach (var entry in zip.Entries.Where(e => !e.FullName.EndsWith("/")).OrderBy(e => e.FullName, StringComparer.Ordinal))
                {
                    using var stream = entry.Open();
                    using var mem = new MemoryStream();
                    stream.CopyTo(mem);
                    yield return (entry.FullName.Replace('\\', '/'), mem.ToArray());
                }
                yield break;
            }
            foreach (var file in Directory.GetFiles(Path, "*", SearchOption.AllDirectories).OrderBy(f => System.IO.Path.GetRelativePath(Path, f).Replace('\\', '/'), StringComparer.Ordinal))
                yield return (System.IO.Path.GetRelativePath(Path, file).Replace('\\', '/'), File.ReadAllBytes(file));
        }

        /// <summary>The map as .sbgmap (zip) bytes, for sending to other players.</summary>
        public byte[] ToZipBytes()
        {
            if (IsZip)
                return File.ReadAllBytes(Path);
            using var mem = new MemoryStream();
            using (var zip = new ZipArchive(mem, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach (var (name, data) in Entries())
                {
                    var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                    using var stream = entry.Open();
                    stream.Write(data, 0, data.Length);
                }
            }
            return mem.ToArray();
        }

        private static void Validate(MapManifest m)
        {
            if (m == null)
                throw new InvalidDataException("map.json is empty");
            if (m.format != 1 && m.format != 2)
                throw new InvalidDataException($"unsupported map format {m.format} (this mod reads formats 1 and 2)");
            if (string.IsNullOrWhiteSpace(m.id))
                throw new InvalidDataException("map.json has no id");
            if (m.holes == null || m.holes.Count == 0)
                throw new InvalidDataException("map.json has no holes");
            for (int i = 0; i < m.holes.Count; i++)
            {
                var h = m.holes[i];
                string where = $"hole {i + 1}";
                // Format 2 holes share the map's area unless they give their own.
                h.size ??= m.size;
                if (h.size == null || h.size.Length != 2 || h.size[0] <= 0 || h.size[1] <= 0)
                    throw new InvalidDataException($"{where}: size must be [x, z] in metres");
                if (h.size[0] > MapBuilder.MaxMapSize || h.size[1] > MapBuilder.MaxMapSize)
                    throw new InvalidDataException($"{where}: size {h.size[0]}x{h.size[1]} is larger than the {MapBuilder.MaxMapSize} m limit");
                if (h.heightmap == null && m.model == null && h.model == null)
                    throw new InvalidDataException($"{where}: needs a heightmap or a model (its own, or the map's)");
                if (h.heightmap != null && (h.heightmap.width < 2 || h.heightmap.depth < 2))
                    throw new InvalidDataException($"{where}: heightmap needs at least 2x2 samples");
                if (h.tee == null)
                    throw new InvalidDataException($"{where}: no tee");
                if (h.cup == null)
                    throw new InvalidDataException($"{where}: no cup");
            }
        }
    }

    /// <summary>Finds and holds all installed maps.</summary>
    public static class MapLibrary
    {
        public static readonly List<MapPack> Maps = new List<MapPack>();

        /// <summary>Where users drop maps: &lt;game&gt;/SbgMaps/maps.</summary>
        public static string MapsFolder => System.IO.Path.Combine(Paths.GameRootPath, "SbgMaps", "maps");

        /// <summary>Maps received from hosts.</summary>
        public static string DownloadsFolder => System.IO.Path.Combine(MapsFolder, "downloaded");

        /// <summary>Map files and folders, the player's own first (so they win over a downloaded copy with the same id).</summary>
        private static IEnumerable<string> Candidates()
        {
            Directory.CreateDirectory(MapsFolder);
            Directory.CreateDirectory(DownloadsFolder);
            return Directory.GetDirectories(MapsFolder).Where(d => File.Exists(System.IO.Path.Combine(d, "map.json")))
                .Concat(Directory.GetFiles(MapsFolder, "*.sbgmap"))
                .Concat(Directory.GetFiles(DownloadsFolder, "*.sbgmap"))
                .ToList();
        }

        private static string scanned;

        /// <summary>Names, sizes and times of every map file, so a cheap check tells whether anything changed.</summary>
        private static string Signature()
        {
            var sb = new System.Text.StringBuilder();
            foreach (var path in Candidates())
            {
                var files = Directory.Exists(path) ? Directory.GetFiles(path, "*", SearchOption.AllDirectories) : new[] { path };
                foreach (var f in files)
                {
                    var info = new FileInfo(f);
                    sb.Append(f).Append('|').Append(info.Length).Append('|').Append(info.LastWriteTimeUtc.Ticks).Append('\n');
                }
            }
            return sb.ToString();
        }

        /// <summary>Scans again if maps were added, removed or changed since the last scan. True if it did.</summary>
        public static bool RescanIfChanged()
        {
            string now = Signature();
            if (now == scanned)
                return false;
            Plugin.Log.LogInfo("The maps folder changed, loading maps again");
            Scan();
            return true;
        }

        public static void Scan()
        {
            Maps.Clear();
            scanned = Signature();
            // Several files can carry the same map id (a browser saves a re-download as "name (1).sbgmap"): the
            // player's own maps win over downloaded ones, and among those the most recently changed file wins.
            var loaded = new List<(MapPack pack, bool downloaded, DateTime changed)>();
            foreach (var path in Candidates())
            {
                try
                {
                    var pack = MapPack.Load(path);
                    bool downloaded = System.IO.Path.GetFullPath(path).StartsWith(System.IO.Path.GetFullPath(DownloadsFolder));
                    var changed = Directory.Exists(path) ? Directory.GetFiles(path, "*", SearchOption.AllDirectories).Select(File.GetLastWriteTimeUtc).DefaultIfEmpty().Max() : File.GetLastWriteTimeUtc(path);
                    loaded.Add((pack, downloaded, changed));
                }
                catch (Exception e)
                {
                    Plugin.Log.LogError($"Could not load map {path}: {e.Message}");
                }
            }
            foreach (var group in loaded.GroupBy(l => l.pack.Manifest.id))
            {
                var ordered = group.OrderBy(l => l.downloaded).ThenByDescending(l => l.changed).ToList();
                var pack = ordered[0].pack;
                Maps.Add(pack);
                Plugin.Log.LogInfo($"Map '{pack.Manifest.name}' ({pack.Manifest.id}) with {pack.Manifest.holes.Count} hole(s), hash {pack.Hash.Substring(0, 12)}, from {System.IO.Path.GetFileName(pack.Path)}");
                foreach (var other in ordered.Skip(1))
                    Plugin.Log.LogWarning($"Not using {other.pack.Path}: '{pack.Path}' has the same map id '{pack.Manifest.id}' and is {(other.downloaded && !ordered[0].downloaded ? "your own copy" : "newer")}");
            }
            // Same order on every machine, so global hole indices line up between players.
            Maps.Sort((a, b) => string.CompareOrdinal(a.Manifest.id, b.Manifest.id));
        }

        public static MapPack Find(string id) => Maps.FirstOrDefault(m => m.Manifest.id == id);

        /// <summary>Uses this pack for its id from now on (e.g. a version just downloaded from the host).</summary>
        public static void Replace(MapPack pack)
        {
            Maps.RemoveAll(m => m.Manifest.id == pack.Manifest.id);
            Maps.Add(pack);
            Maps.Sort((a, b) => string.CompareOrdinal(a.Manifest.id, b.Manifest.id));
        }
    }
}
