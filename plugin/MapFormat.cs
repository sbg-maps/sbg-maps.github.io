using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using UnityEngine;

namespace SbgMaps
{
    // JSON model of map.json, formats 1 and 2. See FORMAT.md in the repo root.

    public class MapManifest
    {
        public int format;
        public string id;
        public string name;
        public string author;
        public string credits;
        public string version;
        /// <summary>Format 2: area shared by all holes, in metres [x, z]. Holes may still give their own.</summary>
        public float[] size;
        /// <summary>Format 2: a level model (.glb) shared by all holes, in map coordinates.</summary>
        public ModelDef model;
        /// <summary>Optional song (a file in the map: .mp3, .ogg, .wav or .flac) played on every hole.</summary>
        public string music;
        /// <summary>Optional settings per song file, e.g. its volume.</summary>
        public Dictionary<string, SongDef> songs;
        public List<HoleDef> holes = new List<HoleDef>();

        /// <summary>How loud a song in the map plays, 0 to 1.</summary>
        public float VolumeOf(string file) => songs != null && file != null && songs.TryGetValue(file, out var s) && s != null ? Mathf.Clamp01(s.volume) : 1f;
    }

    public class SongDef
    {
        public float volume = 1f;
    }

    public class ModelDef
    {
        public string file;
    }

    public class HoleDef
    {
        public string name;
        public int par = 4;
        public string difficulty = "none";
        public string theme = "coast";
        /// <summary>Optional song for this hole only, overriding the map's.</summary>
        public string music;
        /// <summary>Optional picture of the hole (a .jpg or .png in the map) shown in match setup.</summary>
        public string preview;
        /// <summary>Playable area in metres, [x, z]. Map-local coordinates run from (0,0) to size.</summary>
        public float[] size;
        /// <summary>
        /// Optional: this hole's own level model (a piece of a bigger level cut out around it), used instead of the
        /// map's. Its coordinates are this hole's, like its points.
        /// </summary>
        public ModelDef model;
        /// <summary>Where this hole's area sits in the level it was cut from [x, z] (for the editor to put pieces back).</summary>
        public float[] origin;
        public GridDef heightmap;
        public GridDef paintmap;
        public float water = 5f;
        /// <summary>Model maps: ground within this distance of the cup plays as green.</summary>
        public float greenRadius = 10f;
        public TeeDef tee;
        public PointDef cup;
        public List<PointDef> itemBoxes = new List<PointDef>();
        /// <summary>Red item boxes: the better movement items (the game's "mobility" boxes).</summary>
        public List<PointDef> redItemBoxes = new List<PointDef>();
        /// <summary>Optional: what normal boxes give, item name to weight (default: the game's own pools by distance).</summary>
        public Dictionary<string, float> items;
        /// <summary>Optional: what red boxes give, item name to weight (default: spring boots and the rocket driver).</summary>
        public Dictionary<string, float> redItems;
        public List<PointDef> checkpoints = new List<PointDef>();
        /// <summary>Optional polygons/paths in map-local [x, z] pairs; sensible defaults are derived when missing.</summary>
        public List<float[]> bounds;
        public List<float[]> green;
        public List<float[]> returnPath;

        [JsonIgnore] public Vector2 Size => new Vector2(size[0], size[1]);
    }

    public class GridDef
    {
        public string file;
        /// <summary>Samples along x and z.</summary>
        public int width;
        public int depth;
        /// <summary>Heightmap only: world heights that 0 and 65535 map to.</summary>
        public float min;
        public float max;
    }

    public class TeeDef
    {
        public float x;
        public float? y;
        public float z;
        /// <summary>Degrees clockwise from +z. When missing, the tee faces the cup.</summary>
        public float? yaw;
    }

    public class PointDef
    {
        public float x;
        /// <summary>World height. Optional: when missing it comes from the ground below.</summary>
        public float? y;
        public float z;
    }

    /// <summary>Surface ids used in paintmaps. Stable on our side, mapped to the game's enum by name.</summary>
    public enum Surface : byte
    {
        Rough = 0,
        Fairway = 1,
        Green = 2,
        Sand = 3,
        DirtPath = 4,
        OutOfBounds = 5,
    }

    public static class SurfaceExtensions
    {
        public static TerrainLayer ToTerrainLayer(this Surface s) => s switch
        {
            Surface.Fairway => TerrainLayer.Fairway,
            Surface.Green => TerrainLayer.Green,
            Surface.Sand => TerrainLayer.Sand,
            Surface.DirtPath => TerrainLayer.DirtPath,
            Surface.OutOfBounds => TerrainLayer.OutOfBounds,
            _ => TerrainLayer.Rough,
        };
    }

    /// <summary>A hole's decoded grids, sampled in map-local metres.</summary>
    public class HoleGrids
    {
        private readonly HoleDef def;
        private readonly ushort[] heights;
        private readonly byte[] paint;

        public HoleGrids(HoleDef def, byte[] heightBytes, byte[] paintBytes)
        {
            this.def = def;
            int expectedHeights = def.heightmap.width * def.heightmap.depth;
            if (heightBytes.Length != expectedHeights * 2)
                throw new FormatException($"heightmap '{def.heightmap.file}' has {heightBytes.Length} bytes, expected {expectedHeights * 2} ({def.heightmap.width}x{def.heightmap.depth} uint16)");
            heights = new ushort[expectedHeights];
            Buffer.BlockCopy(heightBytes, 0, heights, 0, heightBytes.Length);

            if (def.paintmap != null)
            {
                int expectedPaint = def.paintmap.width * def.paintmap.depth;
                if (paintBytes.Length != expectedPaint)
                    throw new FormatException($"paintmap '{def.paintmap.file}' has {paintBytes.Length} bytes, expected {expectedPaint}");
                paint = paintBytes;
            }
        }

        /// <summary>Bilinear world height at a map-local point (clamped to the area).</summary>
        public float HeightAt(float x, float z)
        {
            var g = def.heightmap;
            float fx = Mathf.Clamp01(x / def.size[0]) * (g.width - 1);
            float fz = Mathf.Clamp01(z / def.size[1]) * (g.depth - 1);
            int x0 = Mathf.Min((int)fx, g.width - 2), z0 = Mathf.Min((int)fz, g.depth - 2);
            float tx = fx - x0, tz = fz - z0;
            float h00 = heights[z0 * g.width + x0], h10 = heights[z0 * g.width + x0 + 1];
            float h01 = heights[(z0 + 1) * g.width + x0], h11 = heights[(z0 + 1) * g.width + x0 + 1];
            float v = Mathf.Lerp(Mathf.Lerp(h00, h10, tx), Mathf.Lerp(h01, h11, tx), tz);
            return g.min + v / 65535f * (g.max - g.min);
        }

        public Surface SurfaceAt(float x, float z)
        {
            if (paint == null)
                return Surface.Rough;
            var g = def.paintmap;
            int px = Mathf.Clamp((int)(x / def.size[0] * g.width), 0, g.width - 1);
            int pz = Mathf.Clamp((int)(z / def.size[1] * g.depth), 0, g.depth - 1);
            byte v = paint[pz * g.width + px];
            return Enum.IsDefined(typeof(Surface), v) ? (Surface)v : Surface.Rough;
        }
    }
}
