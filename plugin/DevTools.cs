using System.Text;
using BepInEx.Configuration;
using HarmonyLib;
using Mirror;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace SbgMaps
{
    /// <summary>
    /// Host-side dev hotkeys. Feedback goes to the in-game text chat (local only) and the BepInEx log.
    ///   F5  restart the current hole
    ///   F7  skip to the next hole
    ///   F8  dump gameplay object positions to the log
    ///   F9  toggle the test hole on/off and restart the hole
    /// </summary>
    internal static class DevTools
    {
        public static void Update(ConfigEntry<string> testHoleScene)
        {
            var kb = Keyboard.current;
            if (kb == null)
                return;

            if (kb.f5Key.wasPressedThisFrame)
                RestartHole();
            else if (kb.f7Key.wasPressedThisFrame)
                SkipHole();
            else if (kb.f8Key.wasPressedThisFrame)
                DumpGameplayObjects();
            else if (kb.f9Key.wasPressedThisFrame)
                ToggleTestHole(testHoleScene);
        }

        public static void Say(string message)
        {
            Plugin.Log.LogInfo(message);
            try
            {
                TextChatUi.ShowMessage($"[SbgMaps] {message}");
            }
            catch
            {
                // Chat UI is not available in every scene (main menu); the log line is enough there.
            }
        }

        private static bool RequireHost()
        {
            if (NetworkServer.active && SingletonNetworkBehaviour<CourseManager>.HasInstance)
                return true;
            Say("Only the host can do that, and only during a match");
            return false;
        }

        public static void RestartHole()
        {
            if (!RequireHost())
                return;
            if (SingletonBehaviour<DrivingRangeManager>.HasInstance || ServerPersistentCourseData.nextHoleIndex <= 0)
            {
                Say("Not on a course hole");
                return;
            }
            // The next match loads Holes[nextHoleIndex], which already points past the current hole.
            ServerPersistentCourseData.SetNextHoleIndex(ServerPersistentCourseData.nextHoleIndex - 1);
            Say($"Restarting '{SceneManager.GetActiveScene().name}'");
            StartNextMatch();
        }

        public static void SkipHole()
        {
            if (!RequireHost())
                return;
            Say("Skipping to the next hole");
            StartNextMatch();
        }

        private static void StartNextMatch() =>
            Traverse.Create(SingletonNetworkBehaviour<CourseManager>.Instance)
                .Method("ServerStartNextMatch", new[] { typeof(bool) })
                .GetValue(false);

        private static void ToggleTestHole(ConfigEntry<string> testHoleScene)
        {
            testHoleScene.Value = string.IsNullOrEmpty(testHoleScene.Value) ? "Twin Beach" : "";
            Say(string.IsNullOrEmpty(testHoleScene.Value) ? "Test hole OFF" : $"Test hole ON (replaces '{testHoleScene.Value}')");
            if (NetworkServer.active && SceneManager.GetActiveScene().name == "Twin Beach")
                RestartHole();
        }

        public static void DumpGameplayObjects()
        {
            var sb = new StringBuilder($"Gameplay objects in '{SceneManager.GetActiveScene().name}':\n");
            void Add<T>(string label) where T : Component
            {
                foreach (var c in Object.FindObjectsByType<T>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                {
                    var id = c.GetComponent<NetworkIdentity>();
                    sb.AppendLine($"  {label} '{c.name}' pos={c.transform.position} rot={c.transform.eulerAngles} active={c.gameObject.activeInHierarchy} sceneId={(id ? id.sceneId.ToString("X") : "-")}");
                }
            }
            Add<GolfTeeingPlatform>("Tee");
            Add<GolfHole>("Hole");
            Add<ItemSpawner>("ItemSpawner");
            Add<Checkpoint>("Checkpoint");
            Add<MainOutOfBoundsHazard>("MainOOB");
            Add<TerrainAddition>("TerrainAddition");
            Plugin.Log.LogInfo(sb.ToString());
            Say("Gameplay objects written to the BepInEx log");
        }
    }
}
