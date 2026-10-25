using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Red item boxes: the game's "mobility" boxes, which hand out the better movement items. The hole the mod builds on
    /// has none, so a regular box gets its own settings (a copy whose only pool is the red one) and a red colour.
    /// Every machine does this the same way; the host picks the items, so its settings are the ones that count.
    /// </summary>
    internal static class RedItemBoxes
    {
        /// <summary>
        /// What red boxes give: spring boots and the rocket driver (the fire club), as players see in the game. Equal
        /// weights until the game's own "Mobility item spawner settings" pool shows up in the log (it is logged by
        /// itself on holes that have red boxes).
        /// </summary>
        private static readonly (ItemType item, float weight)[] Pool =
        {
            (ItemType.SpringBoots, 1f),
            (ItemType.RocketDriver, 1f),
        };

        private static readonly Color Red = new Color(0.95f, 0.22f, 0.18f);
        /// <summary>Settings made so far, by item list, so boxes with the same items share them.</summary>
        private static readonly Dictionary<string, ItemSpawnerSettings> made = new Dictionary<string, ItemSpawnerSettings>();

        public static void MakeRed(ItemSpawner box, Dictionary<string, float> items = null)
        {
            var weights = items != null && items.Count > 0 ? Parse(items) : new List<(ItemType, float)>(Pool);
            if (!Swap(box, weights, "red"))
                return;
            box.name = "Red item spawner";
            if (!UseRedLook(box))
                Tint(box.gameObject);
        }

        public const string LookName = "red-item-box";

        /// <summary>Saves the red box's look while a hole that has red boxes is loaded (once per computer).</summary>
        public static void CaptureLookIfHere()
        {
            if (AssetCapture.Has(LookName))
                return;
            foreach (var visuals in Object.FindObjectsByType<ItemSpawnerVisuals>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (Traverse.Create(visuals).Field("type").GetValue<ItemSpawnerVisualType>() != ItemSpawnerVisualType.Mobility)
                    continue;
                try
                {
                    AssetCapture.Save(LookName, visuals.transform);
                }
                catch (System.Exception e)
                {
                    Plugin.Log.LogWarning($"Could not save the red box look: {e}");
                }
                return;
            }
        }

        /// <summary>The red box's parts are named "Mobility Box ..." where the normal box has "Item Box ...".</summary>
        private static string Normalize(string path) => path.Replace("Mobility Box Speed Icon", "Item Box Question Mark").Replace("Mobility Box", "Item Box");

        /// <summary>Gives a normal box the red box's model, materials and effects (saved from the game). False if none are saved.</summary>
        private static bool UseRedLook(ItemSpawner box)
        {
            var look = AssetCapture.Load(LookName);
            var visuals = box.GetComponentInChildren<ItemSpawnerVisuals>(true);
            if (look == null || visuals == null)
                return false;
            var parts = look.parts.ToDictionary(p => Normalize(p.path), p => p);
            int changed = 0;
            foreach (var renderer in visuals.GetComponentsInChildren<Renderer>(true))
            {
                if (!parts.TryGetValue(Normalize(AssetCapture.PathOf(visuals.transform, renderer.transform)), out var part))
                    continue;
                if (part.mesh != null && renderer.TryGetComponent<MeshFilter>(out var filter))
                    filter.sharedMesh = AssetCapture.MeshFor(part.mesh);
                var current = renderer.sharedMaterials;
                renderer.sharedMaterials = part.materials.Select((m, i) => AssetCapture.MaterialFor(m, i < current.Length ? current[i] : null)).ToArray();
                changed++;
            }
            // Spawn and pick-up effects of the red kind.
            Traverse.Create(visuals).Field("type").SetValue(ItemSpawnerVisualType.Mobility);
            return changed > 0;
        }

        /// <summary>A normal box that gives the map's own choice of items.</summary>
        public static void UseItems(ItemSpawner box, Dictionary<string, float> items) => Swap(box, Parse(items), "custom");

        private static List<(ItemType item, float weight)> Parse(Dictionary<string, float> items)
        {
            var list = new List<(ItemType, float)>();
            foreach (var kv in items)
            {
                if (System.Enum.TryParse<ItemType>(kv.Key, true, out var item) && item != ItemType.None && kv.Value > 0f)
                    list.Add((item, kv.Value));
                else if (kv.Value > 0f)
                    Plugin.Log.LogWarning($"Item boxes: unknown item '{kv.Key}'");
            }
            return list;
        }

        private static bool Swap(ItemSpawner box, List<(ItemType item, float weight)> weights, string kind)
        {
            if (weights.Count == 0)
                return false;
            var t = Traverse.Create(box);
            var settings = t.Field("settings").GetValue<ItemSpawnerSettings>();
            if (settings == null)
            {
                Plugin.Log.LogWarning("Item boxes: the box has no settings to copy");
                return false;
            }
            t.Field("settings").SetValue(SettingsFor(settings, weights, kind));
            return true;
        }

        private static ItemSpawnerSettings SettingsFor(ItemSpawnerSettings regular, List<(ItemType item, float weight)> weights, string kind)
        {
            string key = kind + ":" + string.Join(",", weights.Select(w => $"{w.item}={w.weight}"));
            if (made.TryGetValue(key, out var cached) && cached != null)
                return cached;
            var pool = ScriptableObject.CreateInstance<ItemPool>();
            pool.name = $"SbgMaps {kind} item pool";
            pool.hideFlags = HideFlags.DontUnloadUnusedAsset;
            Traverse.Create(pool).Field("spawnChances").SetValue(weights.Select(w => new ItemPool.ItemSpawnChance { item = w.item, spawnChanceWeight = w.weight }).ToArray());
            pool.UpdateTotalWeight();

            var copy = Object.Instantiate(regular);
            copy.name = $"SbgMaps {kind} item spawner settings";
            var settings = Traverse.Create(copy);
            var pools = new List<ItemSpawnerSettings.ItemPoolData>();
            if (regular.ItemPoolsDefaults != null && regular.ItemPoolsDefaults.Count > 0)
            {
                // Keep the titles and tooltips of the first regular pool; only the items change.
                var data = regular.ItemPoolsDefaults[0];
                data.pool = pool;
                data.minDistanceBehindLeader = 0f;
                pools.Add(data);
            }
            else
                pools.Add(new ItemSpawnerSettings.ItemPoolData { pool = pool });
            settings.Field("itemPools").SetValue(pools);
            settings.Field("hasAheadOfBallItemPool").SetValue(false);
            settings.Field("aheadOfBallItemPool").SetValue(null);
            copy.ResetRuntimeData();
            // Kept across holes (scene changes unload unused assets).
            copy.hideFlags = HideFlags.DontUnloadUnusedAsset;
            made[key] = copy;
            return copy;
        }

        /// <summary>Colours the box's visuals red (works on whatever colour property its shaders have).</summary>
        private static void Tint(GameObject box)
        {
            var block = new MaterialPropertyBlock();
            foreach (var renderer in box.GetComponentsInChildren<Renderer>(true))
            {
                foreach (var material in renderer.sharedMaterials)
                {
                    if (material == null)
                        continue;
                    renderer.GetPropertyBlock(block);
                    foreach (var property in new[] { "_BaseColor", "_Color", "_Tint", "_MainColor", "_EmissionColor" })
                        if (material.HasProperty(property))
                            block.SetColor(property, property == "_EmissionColor" ? Red * 0.6f : Red);
                    renderer.SetPropertyBlock(block);
                }
            }
        }
    }
}
