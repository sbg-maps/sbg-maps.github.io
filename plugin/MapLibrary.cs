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

        public HoleGrids LoadGrids(int holeIndex)
        {
            var hole = Manifest.holes[holeIndex];
            return new HoleGrids(hole, ReadFile(hole.heightmap.file), hole.paintmap != null ? ReadFile(hole.paintmap.file) : null);
        }

        private string ComputeHash()
        {
            using var sha = SHA256.Create();
            if (IsZip)
                return BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(Path))).Replace("-", "").ToLowerInvariant();
            // Folder: hash relative paths and contents in a stable order.
            foreach (var file in Directory.GetFiles(Path, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
            {
                var name = System.Text.Encoding.UTF8.GetBytes(System.IO.Path.GetRelativePath(Path, file).Replace('\\', '/'));
                sha.TransformBlock(name, 0, name.Length, null, 0);
                var data = File.ReadAllBytes(file);
                sha.TransformBlock(data, 0, data.Length, null, 0);
            }
            sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
            return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        }

        private static void Validate(MapManifest m)
        {
            if (m == null)
                throw new InvalidDataException("map.json is empty");
            if (m.format != 1)
                throw new InvalidDataException($"unsupported map format {m.format} (this mod reads format 1)");
            if (string.IsNullOrWhiteSpace(m.id))
                throw new InvalidDataException("map.json has no id");
            if (m.holes == null || m.holes.Count == 0)
                throw new InvalidDataException("map.json has no holes");
            for (int i = 0; i < m.holes.Count; i++)
            {
                var h = m.holes[i];
                string where = $"hole {i + 1}";
                if (h.size == null || h.size.Length != 2 || h.size[0] <= 0 || h.size[1] <= 0)
                    throw new InvalidDataException($"{where}: size must be [x, z] in metres");
                if (h.size[0] > MapBuilder.MaxMapSize || h.size[1] > MapBuilder.MaxMapSize)
                    throw new InvalidDataException($"{where}: size {h.size[0]}x{h.size[1]} is larger than the {MapBuilder.MaxMapSize} m limit");
                if (h.heightmap == null || h.heightmap.width < 2 || h.heightmap.depth < 2)
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

        public static void Scan()
        {
            Maps.Clear();
            Directory.CreateDirectory(MapsFolder);
            var candidates = Directory.GetDirectories(MapsFolder).Where(d => File.Exists(System.IO.Path.Combine(d, "map.json")))
                .Concat(Directory.GetFiles(MapsFolder, "*.sbgmap"));
            foreach (var path in candidates)
            {
                try
                {
                    var pack = MapPack.Load(path);
                    if (Maps.Any(m => m.Manifest.id == pack.Manifest.id))
                    {
                        Plugin.Log.LogWarning($"Skipping {path}: another map already uses id '{pack.Manifest.id}'");
                        continue;
                    }
                    Maps.Add(pack);
                    Plugin.Log.LogInfo($"Map '{pack.Manifest.name}' ({pack.Manifest.id}) with {pack.Manifest.holes.Count} hole(s), hash {pack.Hash.Substring(0, 12)}");
                }
                catch (Exception e)
                {
                    Plugin.Log.LogError($"Could not load map {path}: {e.Message}");
                }
            }
            // Same order on every machine, so global hole indices line up between players.
            Maps.Sort((a, b) => string.CompareOrdinal(a.Manifest.id, b.Manifest.id));
        }

        public static MapPack Find(string id) => Maps.FirstOrDefault(m => m.Manifest.id == id);
    }
}
