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
        public const string Version = "0.0.1";

        internal static ManualLogSource Log;

        private void Awake()
        {
            Log = Logger;
            new Harmony(Guid).PatchAll();
            SceneManager.sceneLoaded += (scene, mode) => Log.LogInfo($"Scene loaded: '{scene.name}' ({scene.path}) mode={mode}");
            Log.LogInfo($"{Name} {Version} loaded");
        }

        private void Update()
        {
            // Dev hotkey: dump the gameplay objects of the current hole so we can check positions and sceneIds.
            if (Keyboard.current != null && Keyboard.current.f8Key.wasPressedThisFrame)
                DevDump.DumpGameplayObjects();
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

    internal static class DevDump
    {
        public static void DumpGameplayObjects()
        {
            var sb = new StringBuilder($"Gameplay objects in '{SceneManager.GetActiveScene().name}':\n");
            void Add<T>(string label) where T : Component
            {
                foreach (var c in Object.FindObjectsByType<T>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                {
                    var id = c.GetComponent<Mirror.NetworkIdentity>();
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
        }
    }
}
