using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Keeps map holes and the game's holes apart in match setup: the Custom Maps tab lists only map holes, every other
    /// tab (the game's own Custom tab too) only the game's. The game's lists hold every hole; the other kind is hidden.
    /// A custom course that already has map holes in it counts as a maps course.
    /// </summary>
    internal static class MatchSetupSplit
    {
        private static bool IsMapHole(HoleData h) => h != null && CustomCourse.TryGetMapHole(h, out _, out _);

        private static bool Shown(HoleData h, bool maps) => !CustomCourse.IsPlaceholder(h) && IsMapHole(h) == maps;

        private static bool MapsMode(MatchSetupMenu menu)
        {
            var current = Traverse.Create(menu).Method("GetCurrentCourseData").GetValue<CourseData>();
            if (CustomCourse.IsMapsCourse(current))
                return true;
            return current == MatchSetupMenu.CustomCourseData && current.Holes.Any(IsMapHole);
        }

        private static void Apply(MatchSetupMenu menu)
        {
            var inactive = menu.inactiveHoles;
            var active = menu.activeHoles;
            if (inactive == null || active == null)
                return;
            bool maps = MapsMode(menu);
            foreach (var hole in inactive.contentRoot.GetComponentsInChildren<MatchSetupHole>(true))
                hole.gameObject.SetActive(Shown(hole.holeData, maps));
            foreach (var hole in active.contentRoot.GetComponentsInChildren<MatchSetupHole>(true))
                hole.gameObject.SetActive(!CustomCourse.IsPlaceholder(hole.holeData));
        }

        /// <summary>
        /// Match setup builds one entry per hole when the lobby loads, and finds them by global number. Maps added
        /// in the lobby (downloaded, or renumbered like the host's) get their entries here, and a Custom Maps tab if
        /// the course is new.
        /// </summary>
        public static void Sync()
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<MatchSetupMenu>(FindObjectsInactive.Include);
            var collection = GameManager.AllCourses;
            if (menu == null || collection == null)
                return;
            try
            {
                var t = Traverse.Create(menu);
                var buttons = t.Field("cachedCourseButtons").GetValue<List<MatchSetupMenuCourseButton>>();
                var courses = collection.Courses;
                bool newTab = false;
                while (buttons != null && buttons.Count > 0 && buttons.Count < courses.Length + 1)
                {
                    int index = buttons.Count - 1;
                    var b = UnityEngine.Object.Instantiate(menu.categoryPrefab);
                    b.transform.SetParent(menu.categoryRoot);
                    b.transform.localScale = Vector3.one;
                    b.transform.SetSiblingIndex(buttons[buttons.Count - 1].transform.GetSiblingIndex());
                    if (courses[index].CategoryIcon != null)
                        b.icon.sprite = courses[index].CategoryIcon;
                    b.button.onClick.AddListener(() => t.Method("SetCourse", new[] { typeof(int), typeof(bool) }).GetValue(index, false));
                    buttons.Insert(index, b);
                    newTab = true;
                }
                if (newTab)
                    t.Method("UpdateCourseTooltips").GetValue();

                var list = t.Field("holes").GetValue<List<MatchSetupHole>>();
                var all = collection.allHoles;
                if (list == null || (list.Count == all.Count && !list.Where((h, i) => h == null || h.holeData != all[i]).Any()))
                    return;
                var byData = new Dictionary<HoleData, MatchSetupHole>();
                foreach (var h in list)
                    if (h != null && h.holeData != null && !byData.ContainsKey(h.holeData))
                        byData[h.holeData] = h;
                var result = all.Select(d => byData.TryGetValue(d, out var h) ? h : NewEntry(menu, d)).ToList();
                foreach (var h in list.Except(result))
                    if (h != null)
                        UnityEngine.Object.Destroy(h.gameObject);
                list.Clear();
                list.AddRange(result);
                foreach (var h in list)
                    h.holeNumber.text = (h.holeData.ParentCourseIndex + 1).ToString();
                if (menu.isServer)
                {
                    // The course's holes may have changed: show it again if it is the one picked.
                    int picked = t.Field("activeCourse").GetValue<int>();
                    if (picked >= 0 && picked < courses.Length && CustomCourse.IsMapsCourse(courses[picked]))
                        t.Method("SetCourse", new[] { typeof(int), typeof(bool) }).GetValue(picked, false);
                    else
                    {
                        t.Method("SortInactiveHoles").GetValue();
                        t.Method("UpdateHoleLabels").GetValue();
                    }
                }
                else
                    t.Method("ClientRebuildCourseList").GetValue();
                t.Method("UpdateNewHolesNotifications").GetValue();
                Plugin.Log.LogInfo($"Match setup now lists {list.Count} holes");
            }
            catch (System.Exception e)
            {
                Plugin.Log.LogError($"Could not update match setup: {e}");
            }
        }

        /// <summary>What the game's RegisterHole does for each hole when the lobby loads.</summary>
        private static MatchSetupHole NewEntry(MatchSetupMenu menu, HoleData holeData)
        {
            var hole = UnityEngine.Object.Instantiate(menu.holePrefab);
            hole.transform.SetParent(menu.inactiveHoles.contentRoot);
            hole.transform.localScale = Vector3.one;
            hole.holeData = holeData;
            hole.menu = menu;
            hole.holeNameLocalizeStringEvent.StringReference = holeData.LocalizedName;
            hole.holeNumber.text = (holeData.ParentCourseIndex + 1).ToString();
            if (holeData.ParentCourse != null)
            {
                hole.holeNumber.color = holeData.ParentCourse.HoleLabelColor;
                hole.background.sprite = holeData.ParentCourse.MenuBackground;
            }
            for (int j = 0; j < hole.difficultyIcons.Length; j++)
            {
                bool on = (int)holeData.Difficulty >= j;
                hole.difficultyIcons[j].gameObject.SetActive(on);
                if (on)
                    hole.difficultyIcons[j].sprite = hole.difficultyIconSprites[(int)holeData.Difficulty];
            }
            hole.GetComponent<ReorderableListElement>().enabled = menu.isServer;
            hole.gameObject.SetActive(!CustomCourse.IsPlaceholder(holeData));
            return hole;
        }

        [HarmonyPatch(typeof(MatchSetupMenu), "SortInactiveHoles")]
        private static class SortPatch
        {
            private static void Postfix(MatchSetupMenu __instance) => Apply(__instance);
        }

        /// <summary>"Inactive (shown/all)" counts only the kind of hole the tab shows.</summary>
        [HarmonyPatch(typeof(MatchSetupMenu), "UpdateHoleLabels")]
        private static class LabelPatch
        {
            private static void Postfix(MatchSetupMenu __instance)
            {
                var inactive = __instance.inactiveHoles;
                var label = __instance.inactiveLabel;
                var holes = Traverse.Create(__instance).Field("holes").GetValue<List<MatchSetupHole>>();
                if (inactive == null || label == null || holes == null)
                    return;
                bool maps = MapsMode(__instance);
                int shown = inactive.contentRoot.GetComponentsInChildren<MatchSetupHole>(true).Count(h => Shown(h.holeData, maps));
                int all = holes.Count(h => h != null && Shown(h.holeData, maps));
                label.text = $"{Localization.UI.MATCHSETUP_Label_Inactive} ({shown}/{all})";
            }
        }
    }

    /// <summary>
    /// "New" stamps on maps this player has not played yet, in match setup (the game's own stamp) and in Custom maps.
    /// The game remembers new holes by scene, and every map hole shares one scene, so maps are remembered by id in
    /// SbgMaps/played-maps.txt. Maps there when the mod first keeps the list count as played.
    /// </summary>
    internal static class NewMaps
    {
        private static string File => System.IO.Path.Combine(BepInEx.Paths.GameRootPath, "SbgMaps", "played-maps.txt");
        private static HashSet<string> played;

        public static bool IsNew(string id)
        {
            if (played == null)
            {
                if (System.IO.File.Exists(File))
                    played = new HashSet<string>(System.IO.File.ReadAllLines(File).Select(l => l.Trim()).Where(l => l.Length > 0));
                else
                {
                    played = new HashSet<string>(MapLibrary.Maps.Select(m => m.Manifest.id));
                    Save();
                }
            }
            return !played.Contains(id);
        }

        public static void MarkPlayed(string id)
        {
            if (!IsNew(id))
                return;
            played.Add(id);
            Save();
        }

        private static void Save()
        {
            try
            {
                System.IO.File.WriteAllLines(File, played.OrderBy(x => x));
            }
            catch (System.Exception e)
            {
                Plugin.Log.LogWarning($"Could not save the played maps: {e.Message}");
            }
        }

        [HarmonyPatch(typeof(MatchSetupMenu), "UpdateNewHolesNotifications")]
        private static class StampPatch
        {
            private static void Postfix(MatchSetupMenu __instance)
            {
                var t = Traverse.Create(__instance);
                var holes = t.Field("holes").GetValue<List<MatchSetupHole>>();
                var buttons = t.Field("cachedCourseButtons").GetValue<List<MatchSetupMenuCourseButton>>();
                var courses = GameManager.AllCourses.Courses;
                bool any = false;
                foreach (var hole in holes)
                {
                    if (hole == null || !CustomCourse.TryGetMapHole(hole.holeData, out var pack, out _))
                        continue;
                    bool isNew = IsNew(pack.Manifest.id);
                    hole.SetAcknowledged(!isNew);
                    if (!isNew)
                        continue;
                    any = true;
                    int index = System.Array.IndexOf(courses, hole.holeData.ParentCourse);
                    if (index >= 0 && index < buttons.Count)
                        buttons[index].newNotification.SetActive(true);
                }
                if (any)
                {
                    __instance.newHolesNotification.SetActive(true);
                    Plugin.Log.LogInfo($"New stamps on {holes.Count(h => h != null && CustomCourse.TryGetMapHole(h.holeData, out var p, out _) && IsNew(p.Manifest.id))} map holes");
                }
            }
        }

        /// <summary>Playing a hole of a map clears its stamp (the game calls this when a hole starts).</summary>
        [HarmonyPatch(typeof(MatchSetupMenu), nameof(MatchSetupMenu.AcknowledgeHole))]
        private static class PlayedPatch
        {
            private static bool Prefix(MatchSetupMenu __instance, HoleData holeData)
            {
                if (!CustomCourse.TryGetMapHole(holeData, out var pack, out _))
                    return true;
                if (IsNew(pack.Manifest.id))
                {
                    MarkPlayed(pack.Manifest.id);
                    Traverse.Create(__instance).Method("UpdateNewHolesNotifications").GetValue();
                }
                return false;
            }
        }
    }
}
