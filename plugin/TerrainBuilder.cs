using System;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Sculpts, paints and cuts holes in a terrain using world coordinates.
    /// Works on a private copy of the TerrainData so the vanilla asset stays untouched.
    /// </summary>
    internal class TerrainBuilder
    {
        private readonly Terrain terrain;
        private readonly TerrainData data;
        private readonly Vector3 origin;

        public TerrainBuilder(Terrain terrain)
        {
            this.terrain = terrain;
            data = UnityEngine.Object.Instantiate(terrain.terrainData);
            terrain.terrainData = data;
            var collider = terrain.GetComponent<TerrainCollider>();
            if (collider != null)
                collider.terrainData = data;
            origin = terrain.transform.position;
            Plugin.Log.LogInfo($"TerrainBuilder: size={data.size} heightmap={data.heightmapResolution} alphamap={data.alphamapWidth}x{data.alphamapHeight} layers={data.alphamapLayers}");
        }

        private float ToNormalizedHeight(float worldY) => Mathf.Clamp01((worldY - origin.y) / data.size.y);

        public void SculptAll(float worldY)
        {
            int res = data.heightmapResolution;
            var heights = new float[res, res];
            float h = ToNormalizedHeight(worldY);
            for (int z = 0; z < res; z++)
                for (int x = 0; x < res; x++)
                    heights[z, x] = h;
            data.SetHeights(0, 0, heights);
        }

        /// <summary>
        /// Raises the area to heightAt(x, z) and blends down to falloffY over falloff metres outside it.
        /// </summary>
        public void Sculpt(Rect area, float falloff, Func<float, float, float> heightAt, float falloffY)
        {
            int res = data.heightmapResolution;
            float step = data.size.x / (res - 1);
            GridWindow(area, falloff, step, res, out int x0, out int z0, out int w, out int h);
            var heights = new float[h, w];
            for (int z = 0; z < h; z++)
            {
                for (int x = 0; x < w; x++)
                {
                    float wx = origin.x + (x0 + x) * step, wz = origin.z + (z0 + z) * step;
                    float d = DistanceOutside(area, wx, wz);
                    float inside = heightAt(Mathf.Clamp(wx, area.xMin, area.xMax), Mathf.Clamp(wz, area.yMin, area.yMax));
                    float y = Mathf.Lerp(inside, falloffY, Mathf.SmoothStep(0f, 1f, d / falloff));
                    heights[z, x] = ToNormalizedHeight(y);
                }
            }
            data.SetHeights(x0, z0, heights);
        }

        /// <summary>Paints the area (plus margin) with one surface type per texel.</summary>
        public void Paint(Rect area, float margin, Func<float, float, TerrainLayer> layerAt)
        {
            int layers = data.alphamapLayers;
            var indexPerLayer = new int[Enum.GetValues(typeof(TerrainLayer)).Length];
            for (int i = 0; i < indexPerLayer.Length; i++)
                indexPerLayer[i] = -1;
            for (int i = 0; i < data.terrainLayers.Length; i++)
                if (data.terrainLayers[i] != null && TerrainManager.Settings.LayersPerLayerAsset.TryGetValue(data.terrainLayers[i], out var l))
                    indexPerLayer[(int)l] = i;

            float step = data.size.x / data.alphamapWidth;
            GridWindow(area, margin, step, data.alphamapWidth, out int x0, out int z0, out int w, out int h);
            var weights = new float[h, w, layers];
            var missing = new System.Collections.Generic.HashSet<TerrainLayer>();
            for (int z = 0; z < h; z++)
            {
                for (int x = 0; x < w; x++)
                {
                    // Sample at the texel centre.
                    var layer = layerAt(origin.x + (x0 + x + 0.5f) * step, origin.z + (z0 + z + 0.5f) * step);
                    int index = indexPerLayer[(int)layer];
                    if (index < 0)
                    {
                        missing.Add(layer);
                        index = 0;
                    }
                    weights[z, x, index] = 1f;
                }
            }
            data.SetAlphamaps(x0, z0, weights);
            if (missing.Count > 0)
                Plugin.Log.LogWarning($"TerrainBuilder: donor terrain has no paint layer for {string.Join(", ", missing)}");
        }

        /// <summary>Reads the hole mask (true = solid) in a square around a world point.</summary>
        public bool[,] ReadHoles(Vector3 worldCenter, float radius)
        {
            int res = data.holesResolution;
            float step = data.size.x / res;
            GridWindow(new Rect(worldCenter.x, worldCenter.z, 0f, 0f), radius, step, res, out int x0, out int z0, out int w, out int h);
            var holes = data.GetHoles(x0, z0, w, h);
            int cut = 0;
            foreach (bool solid in holes)
                if (!solid)
                    cut++;
            Plugin.Log.LogInfo($"TerrainBuilder: vanilla cup cutout is {cut} of {w}x{h} hole texels ({step:F2} m each)");
            return holes;
        }

        /// <summary>Half the width of the opening in a hole mask, in metres (0 when nothing is cut).</summary>
        public float OpeningHalf(bool[,] mask)
        {
            float step = data.size.x / data.holesResolution;
            int minX = int.MaxValue, maxX = int.MinValue, minZ = int.MaxValue, maxZ = int.MinValue;
            for (int z = 0; z < mask.GetLength(0); z++)
                for (int x = 0; x < mask.GetLength(1); x++)
                    if (!mask[z, x])
                        (minX, maxX, minZ, maxZ) = (Mathf.Min(minX, x), Mathf.Max(maxX, x), Mathf.Min(minZ, z), Mathf.Max(maxZ, z));
            return maxX < minX ? 0f : Mathf.Max(maxX - minX + 1, maxZ - minZ + 1) * step / 2f;
        }

        /// <summary>Cuts the given hole mask centred on a world point.</summary>
        public void StampHoles(Vector3 worldCenter, bool[,] mask)
        {
            int res = data.holesResolution;
            float step = data.size.x / res;
            int h = mask.GetLength(0), w = mask.GetLength(1);
            int x0 = Mathf.RoundToInt((worldCenter.x - origin.x) / step) - w / 2;
            int z0 = Mathf.RoundToInt((worldCenter.z - origin.z) / step) - h / 2;
            data.SetHoles(Mathf.Clamp(x0, 0, res - w), Mathf.Clamp(z0, 0, res - h), mask);
        }

        private static float DistanceOutside(Rect r, float x, float z)
        {
            float dx = Mathf.Max(r.xMin - x, 0f, x - r.xMax);
            float dz = Mathf.Max(r.yMin - z, 0f, z - r.yMax);
            return Mathf.Sqrt(dx * dx + dz * dz);
        }

        private void GridWindow(Rect area, float margin, float step, int res, out int x0, out int z0, out int w, out int h)
        {
            x0 = Mathf.Clamp(Mathf.FloorToInt((area.xMin - margin - origin.x) / step), 0, res - 1);
            z0 = Mathf.Clamp(Mathf.FloorToInt((area.yMin - margin - origin.z) / step), 0, res - 1);
            int x1 = Mathf.Clamp(Mathf.CeilToInt((area.xMax + margin - origin.x) / step), x0 + 1, res);
            int z1 = Mathf.Clamp(Mathf.CeilToInt((area.yMax + margin - origin.z) / step), z0 + 1, res);
            w = x1 - x0;
            h = z1 - z0;
        }
    }
}
