using System.Linq;
using System.Text;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace SbgMaps
{
    [BepInPlugin(Guid, Name, Version)]
    public class Plugin : BaseUnityPlugin
    {
        public const string Guid = "loafer.sbgmaps";
        public const string Name = "SbgMaps";
        public const string Version = "0.0.1";

        internal static ManualLogSource Log;

        private ConfigEntry<string> testHoleScene;
        private Harmony harmony;

        private void Awake()
        {
            Log = Logger;
            testHoleScene = Config.Bind("Dev", "TestHoleScene", "Twin Beach",
                "Vanilla hole that gets replaced by the hand-built test hole when it loads. Empty disables it.");
            harmony = new Harmony(Guid);
            harmony.PatchAll();
            SceneManager.sceneLoaded += OnSceneLoaded;
            Log.LogInfo($"{Name} {Version} loaded");
        }

        // ScriptEngine hot reload destroys and recreates the plugin, so undo everything Awake did.
        private void OnDestroy()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            harmony?.UnpatchSelf();
        }

        private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            Log.LogInfo($"Scene loaded: '{scene.name}' ({scene.path}) mode={mode}");
            if (!string.IsNullOrEmpty(testHoleScene.Value) && scene.name == testHoleScene.Value)
                TestHole.Apply(scene);
        }

        private void Update() => DevTools.Update(testHoleScene);
    }

    [HarmonyPatch(typeof(CourseCollection), nameof(CourseCollection.RuntimeInitialize))]
    internal static class LogCoursesPatch
    {
        private static void Postfix(CourseCollection __instance)
        {
            var sb = new StringBuilder("Courses:\n");
            foreach (var course in __instance.Courses)
                sb.AppendLine($"  {course.name}: {course.Holes.Length} holes, initCourses={course.ShouldInitCourses}");
            sb.Append($"  {__instance.allHoles.Count} holes registered globally");
            Plugin.Log.LogInfo(sb.ToString());
        }
    }
}
