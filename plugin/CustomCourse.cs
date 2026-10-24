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
        private const string CourseName = "SbgMaps custom";

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

        private static CourseData course;
        private static HoleData donor;
        /// <summary>Holes made so far, by name + map hash, so the same hole keeps its HoleData (and global index).</summary>
        private static readonly Dictionary<string, HoleData> holeCache = new Dictionary<string, HoleData>();

        /// <summary>
        /// When the plugin loads after the game built its course list (ScriptEngine hot reload loads plugins late),
        /// append the course now and give its holes global indices the way RuntimeInitialize would have.
        /// Safe to call repeatedly.
        /// </summary>
        public static void InjectLate()
        {
            var collection = GameManager.AllCourses;
            if (collection == null || collection.allHoles.Count == 0)
                return;
            if (Attach(collection))
                return;
            if (MapLibrary.Maps.Count > 0)
                Apply(collection, LocalHoles(), initialize: true);
        }

        /// <summary>
        /// In a lobby, use exactly the host's maps in the host's order, so course and hole numbers match theirs.
        /// Maps still downloading are added when they arrive (call again).
        /// </summary>
        public static void UseHostMaps(IList<string> hostMapIds)
        {
            var collection = GameManager.AllCourses;
            if (collection == null)
                return;
            Attach(collection);
            var holes = new List<(MapPack, int)>();
            foreach (var id in hostMapIds)
            {
                var pack = MapLibrary.Find(id);
                if (pack != null)
                    for (int i = 0; i < pack.Manifest.holes.Count; i++)
                        holes.Add((pack, i));
            }
            if (holes.Count > 0 || course != null)
                Apply(collection, holes, initialize: true);
        }

        private static List<(MapPack, int)> LocalHoles() =>
            MapLibrary.Maps.SelectMany(p => Enumerable.Range(0, p.Manifest.holes.Count).Select(i => (p, i))).ToList();

        /// <summary>Finds our course if it is already in the list (e.g. after a hot reload). True if found.</summary>
        private static bool Attach(CourseCollection collection)
        {
            if (course != null && collection.Courses.Contains(course))
                return true;
            course = collection.Courses.FirstOrDefault(c => c.name == CourseName);
            if (course == null)
                return false;
            foreach (var h in course.Holes)
                if (TryGetMapHole(h, out var pack, out _))
                    holeCache[h.name + "/" + pack.Hash] = h;
            return true;
        }

        private static CourseData Inject(CourseCollection collection)
        {
            if (collection.Courses.Any(c => c.name == CourseName))
                return null;
            if (MapLibrary.Maps.Count == 0)
            {
                Plugin.Log.LogInfo($"No maps installed in {MapLibrary.MapsFolder}");
                return null;
            }
            // The game's own RuntimeInitialize (running next) gives these holes their indices.
            return Apply(collection, LocalHoles(), initialize: false);
        }

        /// <summary>Creates or updates the course with these holes. `initialize` gives new holes their global indices.</summary>
        private static CourseData Apply(CourseCollection collection, List<(MapPack pack, int index)> wanted, bool initialize)
        {
            var template = collection.Courses.FirstOrDefault(c => c.ShouldInitCourses && c.name != CourseName);
            donor ??= collection.Courses.SelectMany(c => c.Holes).FirstOrDefault(h => h.Scene.Name == MapBuilder.DonorScene && !h.name.StartsWith(HoleNamePrefix));
            if (template == null || donor == null)
            {
                Plugin.Log.LogError($"Could not find a course template or the donor hole '{MapBuilder.DonorScene}'");
                return null;
            }
            var holes = wanted.Select(w => HoleFor(w.pack, w.index)).ToArray();
            if (course == null || !collection.Courses.Contains(course))
            {
                course = UnityEngine.Object.Instantiate(template);
                course.name = CourseName;
                Strings.Add(CourseKey, "Custom Maps");
                course.SetLocalizedName(new LocalizedString("UI", CourseKey));
                Traverse.Create(collection).Property("Courses").SetValue(collection.Courses.Append(course).ToArray());
            }
            course.OverrideHoles(holes);
            if (initialize)
            {
                foreach (var hole in holes)
                {
                    if (hole.ParentCourse != null)
                        continue;
                    hole.RuntimeInitialize(course, collection.allHoles.Count);
                    collection.allHoles.Add(hole);
                }
            }
            Strings.Inject();
            Plugin.Log.LogInfo($"Custom course has {holes.Length} hole(s)");
            return course;
        }

        private static HoleData HoleFor(MapPack pack, int i)
        {
            string name = HoleName(pack.Manifest.id, i);
            string key = name + "/" + pack.Hash;
            if (holeCache.TryGetValue(key, out var cached))
                return cached;
            var def = pack.Manifest.holes[i];
            var hole = UnityEngine.Object.Instantiate(donor);
            hole.name = name;
            // A fresh copy of the donor carries no course yet.
            Traverse.Create(hole).Property("ParentCourse").SetValue(null);
            string label = $"SBGMAPS_{pack.Manifest.id}_{i}";
            Strings.Add(label, string.IsNullOrWhiteSpace(def.name) ? $"{pack.Manifest.name} {i + 1}" : def.name);
            var t = Traverse.Create(hole);
            t.Property("LocalizedName").SetValue(new LocalizedString("UI", label));
            t.Property("Par").SetValue(Mathf.Max(1, def.par));
            t.Property("Difficulty").SetValue(ParseDifficulty(def.difficulty));
            t.Property("DontShowNewHoleNotification").SetValue(true);
            holeCache[key] = hole;
            return hole;
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
