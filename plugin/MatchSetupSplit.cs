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
                hole.gameObject.SetActive(IsMapHole(hole.holeData) == maps);
            foreach (var hole in active.contentRoot.GetComponentsInChildren<MatchSetupHole>(true))
                hole.gameObject.SetActive(true);
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
                int shown = inactive.contentRoot.GetComponentsInChildren<MatchSetupHole>(true).Count(h => IsMapHole(h.holeData) == maps);
                int all = holes.Count(h => h != null && IsMapHole(h.holeData) == maps);
                label.text = $"{Localization.UI.MATCHSETUP_Label_Inactive} ({shown}/{all})";
            }
        }
    }
}
