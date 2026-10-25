using System.Collections.Generic;
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
        /// What red boxes give, with weights. A first guess from what players see (spring boots, the rocket driver);
        /// replace with the game's own "Mobility item spawner settings" pool once it is logged (F8 on a hole with red boxes).
        /// </summary>
        private static readonly (ItemType item, float weight)[] Pool =
        {
            (ItemType.SpringBoots, 1f),
            (ItemType.RocketDriver, 1f),
        };

        private static readonly Color Red = new Color(0.95f, 0.22f, 0.18f);
        private static ItemSpawnerSettings redSettings;

        public static void MakeRed(ItemSpawner box)
        {
            var t = Traverse.Create(box);
            var settings = t.Field("settings").GetValue<ItemSpawnerSettings>();
            if (settings == null)
            {
                Plugin.Log.LogWarning("Red item box: the box has no settings to copy");
                return;
            }
            t.Field("settings").SetValue(RedSettingsFrom(settings));
            box.name = "Red item spawner";
            Tint(box.gameObject);
        }

        private static ItemSpawnerSettings RedSettingsFrom(ItemSpawnerSettings regular)
        {
            if (redSettings != null)
                return redSettings;
            var pool = ScriptableObject.CreateInstance<ItemPool>();
            pool.name = "SbgMaps red item pool";
            pool.hideFlags = HideFlags.DontUnloadUnusedAsset;
            var chances = new ItemPool.ItemSpawnChance[Pool.Length];
            for (int i = 0; i < Pool.Length; i++)
                chances[i] = new ItemPool.ItemSpawnChance { item = Pool[i].item, spawnChanceWeight = Pool[i].weight };
            Traverse.Create(pool).Field("spawnChances").SetValue(chances);
            pool.UpdateTotalWeight();

            redSettings = Object.Instantiate(regular);
            redSettings.name = "SbgMaps red item spawner settings";
            var settings = Traverse.Create(redSettings);
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
            redSettings.ResetRuntimeData();
            // Kept across holes (scene changes unload unused assets).
            redSettings.hideFlags = HideFlags.DontUnloadUnusedAsset;
            return redSettings;
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
