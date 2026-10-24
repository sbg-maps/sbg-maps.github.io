using System;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using UnityEngine;
using UnityEngine.Localization;
using UnityEngine.Localization.Settings;

namespace SbgMaps
{
    /// <summary>
    /// Adds a "Custom" course tab holding every installed map hole. Each custom hole is a copy of the donor hole's
    /// HoleData (same scene), named "sbgmaps:&lt;mapId&gt;#&lt;holeIndex&gt;" so it can be recognised after a hot reload.
    /// </summary>
    internal static class CustomCourse
    {
        private const string HoleNamePrefix = "sbgmaps:";
        private const string CourseKey = "SBGMAPS_Course";

        public static bool TryGetMapHole(HoleData hole, out MapPack pack, out int holeIndex)
        {
            pack = null;
            holeIndex = -1;
            if (hole == null || !hole.name.StartsWith(HoleNamePrefix))
                return false;
            var rest = hole.name.Substring(HoleNamePrefix.Length);
            int hash = rest.LastIndexOf('#');
            if (hash < 0 || !int.TryParse(rest.Substring(hash + 1), out holeIndex))
                return false;
            pack = MapLibrary.Find(rest.Substring(0, hash));
            return pack != null && holeIndex < pack.Manifest.holes.Count;
        }

        public static string HoleName(string mapId, int holeIndex) => $"{HoleNamePrefix}{mapId}#{holeIndex}";

        [HarmonyPatch(typeof(CourseCollection), nameof(CourseCollection.RuntimeInitialize))]
        private static class InjectCoursePatch
        {
            private static void Prefix(CourseCollection __instance)
            {
                try
                {
                    Inject(__instance);
                }
                catch (Exception e)
                {
                    Plugin.Log.LogError($"Could not add the custom course: {e}");
                }
            }
        }

        private static void Inject(CourseCollection collection)
        {
            if (MapLibrary.Maps.Count == 0)
            {
                Plugin.Log.LogInfo($"No maps installed in {MapLibrary.MapsFolder}");
                return;
            }
            var template = collection.Courses.FirstOrDefault(c => c.ShouldInitCourses);
            var donor = collection.Courses.SelectMany(c => c.Holes).FirstOrDefault(h => h.Scene.Name == MapBuilder.DonorScene);
            if (template == null || donor == null)
            {
                Plugin.Log.LogError($"Could not find a course template or the donor hole '{MapBuilder.DonorScene}'");
                return;
            }

            var holes = new List<HoleData>();
            foreach (var pack in MapLibrary.Maps)
            {
                for (int i = 0; i < pack.Manifest.holes.Count; i++)
                {
                    var def = pack.Manifest.holes[i];
                    var hole = UnityEngine.Object.Instantiate(donor);
                    hole.name = HoleName(pack.Manifest.id, i);
                    string key = $"SBGMAPS_{pack.Manifest.id}_{i}";
                    Strings.Add(key, string.IsNullOrWhiteSpace(def.name) ? $"{pack.Manifest.name} {i + 1}" : def.name);
                    var t = Traverse.Create(hole);
                    t.Property("LocalizedName").SetValue(new LocalizedString("UI", key));
                    t.Property("Par").SetValue(Mathf.Max(1, def.par));
                    t.Property("Difficulty").SetValue(ParseDifficulty(def.difficulty));
                    t.Property("DontShowNewHoleNotification").SetValue(true);
                    holes.Add(hole);
                }
            }

            var course = UnityEngine.Object.Instantiate(template);
            course.name = "SbgMaps custom";
            Strings.Add(CourseKey, "Custom");
            course.SetLocalizedName(new LocalizedString("UI", CourseKey));
            course.OverrideHoles(holes.ToArray());
            Traverse.Create(collection).Property("Courses").SetValue(collection.Courses.Append(course).ToArray());
            Strings.Inject();
            Plugin.Log.LogInfo($"Added custom course with {holes.Count} hole(s)");
        }

        private static HoleData.DifficultyLevel ParseDifficulty(string s) =>
            Enum.TryParse<HoleData.DifficultyLevel>(s, ignoreCase: true, out var d) ? d : HoleData.DifficultyLevel.None;

        /// <summary>Adds our display names to the game's "UI" string table, for every language the player picks.</summary>
        private static class Strings
        {
            private static readonly Dictionary<string, string> entries = new Dictionary<string, string>();
            private static bool subscribed;

            public static void Add(string key, string value) => entries[key] = value;

            public static void Inject()
            {
                if (!subscribed)
                {
                    subscribed = true;
                    LocalizationSettings.SelectedLocaleChanged += _ => Inject();
                }
                var init = LocalizationSettings.InitializationOperation;
                if (!init.IsDone)
                {
                    init.Completed += _ => Inject();
                    return;
                }
                LocalizationSettings.StringDatabase.GetTableAsync("UI").Completed += op =>
                {
                    var table = op.Result;
                    if (table == null)
                    {
                        Plugin.Log.LogWarning("UI string table not found; custom names will show as keys");
                        return;
                    }
                    foreach (var kv in entries)
                    {
                        if (table.GetEntry(kv.Key) == null)
                            table.AddEntry(kv.Key, kv.Value);
                    }
                };
            }
        }
    }
}
