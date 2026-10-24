using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Mirror;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace SbgMaps
{
    /// <summary>
    /// Phase 1 proof: turns a vanilla donor hole into a hand-built test hole.
    /// Runs from sceneLoaded, before Mirror spawns scene objects, so moved networked objects
    /// are sent to clients at their new positions.
    /// </summary>
    internal static class TestHole
    {
        // Root objects the hole needs to keep working. Everything else in the donor is decoration.
        private static readonly HashSet<string> KeepRoots = new HashSet<string>
        {
            "Manager container", "Main Camera", "Gameplay screenspace UI", "EventSystem", "Directional Light",
            "Item spawners", "Course item spawner", "Regular main hole", "Checkpoint", "Ocean", "Overview camera track", "Screenshot camera",
        };

        private static readonly Vector3 TeePos = new Vector3(568f, 30f, 300f);
        private static readonly Vector3 CupPos = new Vector3(568f, 30f, 520f);
        private const float FairwayWidth = 30f;
        private const float SeaFloorHeight = 1f;

        public static void Apply(Scene scene)
        {
            Plugin.Log.LogInfo($"TestHole: rebuilding '{scene.name}'");
            var roots = scene.GetRootGameObjects();

            // Copy the physics layer from a vanilla surface so the ball and players collide with ours.
            var donorSurface = Object.FindObjectsByType<TerrainAddition>(FindObjectsInactive.Include, FindObjectsSortMode.None).FirstOrDefault();
            int groundLayer = donorSurface ? donorSurface.gameObject.layer : 0;
            var baseMaterial = FindBaseMaterial(roots);

            foreach (var root in roots)
            {
                if (KeepRoots.Contains(root.name) || root.name.StartsWith("Teeing platform"))
                    continue;
                var terrain = root.GetComponent<Terrain>();
                if (terrain != null)
                {
                    // Managers need a terrain, so keep it but sink it under the water: it becomes the sea around our island.
                    FlattenTerrain(terrain, SeaFloorHeight);
                    PaintTerrainPatch(terrain, CupPos, 8f, TerrainLayer.Green);
                    continue;
                }
                if (root.GetComponentInChildren<NetworkIdentity>(true) != null)
                {
                    Plugin.Log.LogWarning($"TestHole: keeping unknown networked root '{root.name}'");
                    continue;
                }
                root.SetActive(false);
            }

            var parent = new GameObject("SbgMaps test hole");
            SceneManager.MoveGameObjectToScene(parent, scene);

            float length = CupPos.z - TeePos.z;
            float midZ = (TeePos.z + CupPos.z) / 2f;
            float top = TeePos.y;

            // Rough under and around everything, fairway strip on top, sand trap on the side.
            Surface(parent, "Rough", TerrainLayer.Rough, new Color(0.25f, 0.5f, 0.2f), baseMaterial, groundLayer,
                new Vector3(TeePos.x, top - 0.6f, midZ), new Vector3(FairwayWidth * 3f, 1f, length + 80f));
            Surface(parent, "Fairway", TerrainLayer.Fairway, new Color(0.35f, 0.7f, 0.3f), baseMaterial, groundLayer,
                new Vector3(TeePos.x, top - 0.5f, midZ - 15f), new Vector3(FairwayWidth, 1f, length - 30f));
            Surface(parent, "Sand", TerrainLayer.Sand, new Color(0.9f, 0.82f, 0.55f), baseMaterial, groundLayer,
                new Vector3(TeePos.x + FairwayWidth, top - 0.5f, midZ + 40f), new Vector3(15f, 1f, 25f));

            // Green: four slabs leaving a gap where the cup sits.
            var cup = Object.FindObjectsByType<GolfHole>(FindObjectsInactive.Include, FindObjectsSortMode.None).FirstOrDefault(h => h.IsMainHole);
            float gap = 1f;
            if (cup != null)
            {
                cup.transform.position = CupPos;
                // The collider reports empty bounds this early, so size the gap from the cup's visible mesh.
                Physics.SyncTransforms();
                var renderer = cup.GetComponent<MeshRenderer>();
                if (renderer != null)
                {
                    var b = renderer.bounds;
                    gap = Mathf.Clamp(Mathf.Max(b.size.x, b.size.z), 0.3f, 4f);
                    Plugin.Log.LogInfo($"TestHole: cup mesh bounds size={b.size} center={b.center}, collider bounds size={cup.Collider?.bounds.size}, gap={gap}");
                }
            }
            const float greenSize = 30f;
            float slab = (greenSize - gap) / 2f;
            float off = gap / 2f + slab / 2f;
            var green = new Color(0.45f, 0.85f, 0.35f);
            Surface(parent, "Green N", TerrainLayer.Green, green, baseMaterial, groundLayer,
                new Vector3(CupPos.x, top - 0.5f, CupPos.z + off), new Vector3(greenSize, 1f, slab));
            Surface(parent, "Green S", TerrainLayer.Green, green, baseMaterial, groundLayer,
                new Vector3(CupPos.x, top - 0.5f, CupPos.z - off), new Vector3(greenSize, 1f, slab));
            Surface(parent, "Green E", TerrainLayer.Green, green, baseMaterial, groundLayer,
                new Vector3(CupPos.x + off, top - 0.5f, CupPos.z), new Vector3(slab, 1f, gap));
            Surface(parent, "Green W", TerrainLayer.Green, green, baseMaterial, groundLayer,
                new Vector3(CupPos.x - off, top - 0.5f, CupPos.z), new Vector3(slab, 1f, gap));

            // Tees side by side at the start, facing the cup.
            var tees = Object.FindObjectsByType<GolfTeeingPlatform>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            var facing = Quaternion.LookRotation(CupPos - TeePos);
            for (int i = 0; i < tees.Length; i++)
            {
                float side = (i % 2 == 0 ? -1f : 1f) * 6f;
                tees[i].transform.SetPositionAndRotation(TeePos + new Vector3(side, 0f, 0f), facing);
            }

            // Item boxes in two rows along the fairway edges.
            var spawners = Object.FindObjectsByType<ItemSpawner>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            for (int i = 0; i < spawners.Length; i++)
            {
                int row = i / 2;
                float x = TeePos.x + (i % 2 == 0 ? -1f : 1f) * (FairwayWidth / 2f + 4f);
                float z = TeePos.z + 25f + row * (length - 60f) / Mathf.Max(1, spawners.Length / 2 - 1);
                spawners[i].transform.position = new Vector3(x, top, z);
            }

            foreach (var cp in Object.FindObjectsByType<Checkpoint>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                cp.transform.position = new Vector3(TeePos.x, top, midZ);

            ForceTerrainDataRegeneration();

            Plugin.Log.LogInfo($"TestHole: done ({tees.Length} tees, {spawners.Length} item spawners, layer {groundLayer}, material '{(baseMaterial ? baseMaterial.shader.name : "none")}')");
        }

        private static void FlattenTerrain(Terrain terrain, float worldHeight)
        {
            // Work on a copy so the vanilla TerrainData asset stays untouched for the real hole.
            var data = Object.Instantiate(terrain.terrainData);
            terrain.terrainData = data;
            var collider = terrain.GetComponent<TerrainCollider>();
            if (collider != null)
                collider.terrainData = data;

            float h = Mathf.Clamp01((worldHeight - terrain.transform.position.y) / data.size.y);
            int res = data.heightmapResolution;
            var heights = new float[res, res];
            for (int y = 0; y < res; y++)
                for (int x = 0; x < res; x++)
                    heights[y, x] = h;
            data.SetHeights(0, 0, heights);
            Plugin.Log.LogInfo($"TestHole: flattened terrain at y={terrain.transform.position.y + h * data.size.y} (res {res}, size {data.size})");
        }

        /// <summary>
        /// Around the cup the shot preview ignores meshes and uses the terrain's own paint at cup height,
        /// so the terrain must be painted green under the cup like vanilla holes are.
        /// </summary>
        private static void PaintTerrainPatch(Terrain terrain, Vector3 worldCenter, float radius, TerrainLayer layer)
        {
            var data = terrain.terrainData;
            int index = System.Array.FindIndex(data.terrainLayers,
                asset => asset != null && TerrainManager.Settings.LayersPerLayerAsset.TryGetValue(asset, out var l) && l == layer);
            if (index < 0)
            {
                Plugin.Log.LogWarning($"TestHole: donor terrain has no {layer} paint layer");
                return;
            }

            Vector3 local = worldCenter - terrain.transform.position;
            float perX = data.alphamapWidth / data.size.x, perZ = data.alphamapHeight / data.size.z;
            int x0 = Mathf.Clamp(Mathf.FloorToInt((local.x - radius) * perX), 0, data.alphamapWidth - 1);
            int z0 = Mathf.Clamp(Mathf.FloorToInt((local.z - radius) * perZ), 0, data.alphamapHeight - 1);
            int w = Mathf.Clamp(Mathf.CeilToInt(radius * 2f * perX), 1, data.alphamapWidth - x0);
            int h = Mathf.Clamp(Mathf.CeilToInt(radius * 2f * perZ), 1, data.alphamapHeight - z0);

            var weights = new float[h, w, data.alphamapLayers];
            for (int z = 0; z < h; z++)
                for (int x = 0; x < w; x++)
                    weights[z, x, index] = 1f;
            data.SetAlphamaps(x0, z0, weights);
            Plugin.Log.LogInfo($"TestHole: painted {w}x{h} alphamap texels as {layer} (layer index {index})");
        }

        /// <summary>
        /// The shot preview reads baked terrain data stored in the scene. Disposing it makes TerrainManager.Start
        /// regenerate from the live terrain, which also picks up our TerrainAddition meshes.
        /// </summary>
        private static void ForceTerrainDataRegeneration()
        {
            var manager = Object.FindFirstObjectByType<TerrainManager>();
            if (manager == null)
            {
                Plugin.Log.LogWarning("TestHole: no TerrainManager found");
                return;
            }
            var t = Traverse.Create(manager);
            foreach (var field in new[] { "allTerrainLayerWeights", "allTerrainHeights", "allTerrainHeightOverrides" })
            {
                var array = t.Field(field).GetValue<Unity.Collections.NativeArray<float>>();
                if (array.IsCreated)
                    array.Dispose();
                t.Field(field).SetValue(default(Unity.Collections.NativeArray<float>));
            }
            var overrides = t.Field("allTerrainOverrides").GetValue<Unity.Collections.NativeArray<int>>();
            if (overrides.IsCreated)
                overrides.Dispose();
            t.Field("allTerrainOverrides").SetValue(default(Unity.Collections.NativeArray<int>));
        }

        private static Material FindBaseMaterial(GameObject[] roots)
        {
            var lit = Shader.Find("Universal Render Pipeline/Lit");
            if (lit != null)
                return new Material(lit);
            var plane = roots.FirstOrDefault(r => r.name == "BaseGroundPlane");
            var renderer = plane ? plane.GetComponent<MeshRenderer>() : null;
            return renderer ? new Material(renderer.sharedMaterial) : null;
        }

        private static void Surface(GameObject parent, string name, TerrainLayer layer, Color color, Material baseMaterial,
            int physicsLayer, Vector3 center, Vector3 size)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            // TerrainAddition reads its layer in Awake, so set fields while the object is inactive.
            go.SetActive(false);
            go.name = name;
            go.layer = physicsLayer;
            go.transform.SetParent(parent.transform, false);
            go.transform.position = center;
            go.transform.localScale = size;
            if (baseMaterial != null)
            {
                var mat = new Material(baseMaterial);
                mat.SetColor("_BaseColor", color);
                mat.color = color;
                go.GetComponent<MeshRenderer>().sharedMaterial = mat;
            }
            var addition = go.AddComponent<TerrainAddition>();
            Traverse.Create(addition).Field("terrainLayer").SetValue(layer);
            go.SetActive(true);
        }
    }
}
