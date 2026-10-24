using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Mirror;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace SbgMaps
{
    /// <summary>
    /// Phase 1 proof: turns a vanilla donor hole into a hand-built test hole by re-sculpting and repainting
    /// the donor terrain, the same way vanilla holes are built.
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
        private const float GreenRadius = 16f;
        private const float SeaFloorHeight = 1f;
        private const float BeachWidth = 20f;

        // Island footprint (world XZ) and the surface areas painted on it.
        private static readonly Rect Island = Rect.MinMaxRect(TeePos.x - 45f, TeePos.z - 40f, TeePos.x + 45f, CupPos.z + 40f);
        private static readonly Rect Fairway = Rect.MinMaxRect(TeePos.x - FairwayWidth / 2f, TeePos.z + 15f, TeePos.x + FairwayWidth / 2f, CupPos.z - GreenRadius);
        private static readonly Rect SandTrap = Rect.MinMaxRect(TeePos.x + 22f, 440f, TeePos.x + 37f, 465f);

        public static void Apply(Scene scene)
        {
            Plugin.Log.LogInfo($"TestHole: rebuilding '{scene.name}'");
            var roots = scene.GetRootGameObjects();

            Terrain terrain = null;
            foreach (var root in roots)
            {
                if (KeepRoots.Contains(root.name) || root.name.StartsWith("Teeing platform"))
                    continue;
                if (root.GetComponent<Terrain>() != null)
                {
                    terrain = root.GetComponent<Terrain>();
                    continue;
                }
                if (root.GetComponentInChildren<NetworkIdentity>(true) != null)
                {
                    Plugin.Log.LogWarning($"TestHole: keeping unknown networked root '{root.name}'");
                    continue;
                }
                root.SetActive(false);
            }
            if (terrain == null)
            {
                Plugin.Log.LogError("TestHole: donor scene has no terrain");
                return;
            }

            var cup = Object.FindObjectsByType<GolfHole>(FindObjectsInactive.Include, FindObjectsSortMode.None).FirstOrDefault(h => h.IsMainHole);
            var builder = new TerrainBuilder(terrain);

            // Copy the cutout vanilla made for its own cup before the cup moves, then stamp it under ours.
            bool[,] cupCutout = cup != null ? builder.ReadHoles(cup.transform.position, 3f) : null;

            builder.SculptAll(SeaFloorHeight);
            builder.Sculpt(Island, BeachWidth, (x, z) => TeePos.y, SeaFloorHeight);
            builder.Paint(Island, BeachWidth, PaintLayerAt);
            if (cupCutout != null)
                builder.StampHoles(CupPos, cupCutout);

            if (cup != null)
            {
                cup.transform.position = CupPos;
                LogCup(cup);
            }

            // Tees side by side at the start, facing the cup.
            var tees = Object.FindObjectsByType<GolfTeeingPlatform>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            var facing = Quaternion.LookRotation(CupPos - TeePos);
            for (int i = 0; i < tees.Length; i++)
            {
                float side = (i % 2 == 0 ? -1f : 1f) * 6f;
                tees[i].transform.SetPositionAndRotation(TeePos + new Vector3(side, 0f, 0f), facing);
            }

            // Item boxes in two rows along the fairway edges.
            float length = CupPos.z - TeePos.z;
            var spawners = Object.FindObjectsByType<ItemSpawner>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            for (int i = 0; i < spawners.Length; i++)
            {
                int row = i / 2;
                float x = TeePos.x + (i % 2 == 0 ? -1f : 1f) * (FairwayWidth / 2f + 4f);
                float z = TeePos.z + 25f + row * (length - 60f) / Mathf.Max(1, spawners.Length / 2 - 1);
                spawners[i].transform.position = new Vector3(x, TeePos.y, z);
            }

            foreach (var cp in Object.FindObjectsByType<Checkpoint>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                cp.transform.position = new Vector3(TeePos.x, TeePos.y, (TeePos.z + CupPos.z) / 2f);

            ForceTerrainDataRegeneration();

            Plugin.Log.LogInfo($"TestHole: done ({tees.Length} tees, {spawners.Length} item spawners)");
        }

        private static TerrainLayer PaintLayerAt(float x, float z)
        {
            if (!Island.Contains(new Vector2(x, z)))
                return TerrainLayer.Sand; // beach slope down to the sea
            if (new Vector2(x - CupPos.x, z - CupPos.z).sqrMagnitude <= GreenRadius * GreenRadius)
                return TerrainLayer.Green;
            if (SandTrap.Contains(new Vector2(x, z)))
                return TerrainLayer.Sand;
            if (Fairway.Contains(new Vector2(x, z)))
                return TerrainLayer.Fairway;
            return TerrainLayer.Rough;
        }

        private static void LogCup(GolfHole cup)
        {
            foreach (var c in cup.GetComponentsInChildren<Collider>(true))
            {
                string mesh = c is MeshCollider mc ? $" mesh={(mc.sharedMesh ? mc.sharedMesh.name : "null")}" : "";
                Plugin.Log.LogInfo($"TestHole: cup collider '{c.name}' {c.GetType().Name} trigger={c.isTrigger} enabled={c.enabled}{mesh}");
            }
        }

        /// <summary>
        /// The shot preview reads baked terrain data stored in the scene. Disposing it makes TerrainManager.Start
        /// regenerate from the live terrain.
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
    }
}
