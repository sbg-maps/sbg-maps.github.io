using System.Linq;
using System.Text;
using BepInEx;
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
        public const string Version = "0.6.0";

        internal static ManualLogSource Log;
        internal static Plugin Instance;

        private Harmony harmony;

        private void Awake()
        {
            Log = Logger;
            Instance = this;
            Settings.Init(Config);
            MapLibrary.Scan();
            HoleSync.Init();
            MapTransfer.Init();
            harmony = new Harmony(Guid);
            harmony.PatchAll();
            SceneManager.sceneLoaded += OnSceneLoaded;
            CustomCourse.InjectLate();
            foreach (var name in new[] { "Skybox/Panoramic", "Skybox/6 Sided", "Skybox/Cubemap", "Skybox/Procedural", "Universal Render Pipeline/Unlit", "Universal Render Pipeline/Simple Lit", "Unlit/Texture" })
                Log.LogInfo($"Shader check: '{name}' {(Shader.Find(name) != null ? "available" : "missing")}");
                        Log.LogInfo($"Shader check: lit particles {(Shader.Find("Universal Render Pipeline/Particles/Lit") != null ? "available" : "missing")}; physics gravity {Physics.gravity}; player gravity factor {GameManager.PlayerMovementSettings?.BaseGravityFactor}");
                        Log.LogInfo($"{Name} {Version} loaded");
        }

        // ScriptEngine hot reload destroys and recreates the plugin, so undo everything Awake did.
        private void OnDestroy()
        {
            SceneManager.sceneLoaded -= OnSceneLoaded;
            harmony?.UnpatchSelf();
            HoleMusic.OnUnload();
        }

        private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            Log.LogInfo($"Scene loaded: '{scene.name}' ({scene.path}) mode={mode}");
            if (mode == LoadSceneMode.Single)
                HoleMusic.OnSceneLoaded();
            CustomCourse.InjectLate();
            HoleSync.OnSceneLoaded(scene);
            if (mode == LoadSceneMode.Single && scene.name != "Main menu")
            {
                StartCoroutine(DevTools.LogFactsOnce(scene.name));
                if (scene.name != "Driving range")
                    StartCoroutine(SkyThemes.SaveWhenVanilla(scene.name));
            }
        }

        private void Update()
        {
            // Steam comes up a moment after the main menu loads; raise its send limits before any lobby is hosted.
            SteamQueue.RaiseLimits();
            DevTools.Update();
            MapPicker.Update();
            Settings.Update();
            MapWatcher.Update();
        }

        private void OnGUI()
        {
            MapTransfer.DrawProgress();
            MapPicker.OnGUI();
            Settings.OnGUI();
        }
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
