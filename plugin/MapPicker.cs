using System;
using System.Linq;
using Mirror;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace SbgMaps
{
    /// <summary>
    /// "Test a map" on the title screen: pick any installed map hole and play it straight away. It hosts a lobby
    /// as usual and, once the driving range is up, starts a course of just that hole.
    /// </summary>
    internal static class MapPicker
    {
        private const string ButtonName = "SbgMaps Test Map Button";
        private const string Label = "Test a map";
        /// <summary>The menu buttons are wired up in the scene; the lobby browser one is copied for ours.</summary>
        private const string TemplateMethod = "OpenLobbyBrowser";
        private const float StartTimeoutSeconds = 60f;

        private static GameObject button;
        private static bool open;
        private static Vector2 scroll;
        private static string pendingMap;
        private static int pendingHole;
        private static float pendingSince;
        private static float readySince = -1f;
        private static GUIStyle title, row, note;

        public static void Update()
        {
            if (SingletonBehaviour<MainMenu>.HasInstance && button == null)
            {
                TryAddButton();
                if (pendingMap == null)
                    TryAutorun();
            }
            if (!SingletonBehaviour<MainMenu>.HasInstance)
                open = false;
            if (open && Keyboard.current != null && Keyboard.current.escapeKey.wasPressedThisFrame)
                open = false;
            if (pendingMap != null)
                TryStart();
        }

        private static void TryAddButton()
        {
            var template = UnityEngine.Object.FindObjectsByType<Button>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .FirstOrDefault(b => Enumerable.Range(0, b.onClick.GetPersistentEventCount()).Any(i => b.onClick.GetPersistentMethodName(i) == TemplateMethod));
            if (template == null)
                return;
            var parent = template.transform.parent;
            var existing = parent.Find(ButtonName);
            if (existing != null)
            {
                button = existing.gameObject;
                return;
            }
            button = UnityEngine.Object.Instantiate(template.gameObject, parent);
            button.name = ButtonName;
            button.transform.SetSiblingIndex(template.transform.GetSiblingIndex() + 1);
            // Localized labels would put the template's text back.
            foreach (var c in button.GetComponentsInChildren<MonoBehaviour>(true))
                if (c.GetType().Name.Contains("Localize"))
                    UnityEngine.Object.DestroyImmediate(c);
            foreach (var text in button.GetComponentsInChildren<TMP_Text>(true))
                text.text = Label;
            var copy = button.GetComponent<Button>();
            copy.onClick = new Button.ButtonClickedEvent();
            copy.onClick.AddListener(() =>
            {
                MapWatcher.CheckNow();
                open = true;
            });
            Plugin.Log.LogInfo("Added 'Test a map' to the title screen");
        }

        public static void OnGUI()
        {
            if (!open)
                return;
            title ??= new GUIStyle(GUI.skin.label) { fontSize = 26, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            row ??= new GUIStyle(GUI.skin.button) { fontSize = 18, alignment = TextAnchor.MiddleLeft, padding = new RectOffset(14, 14, 8, 8) };
            note ??= new GUIStyle(GUI.skin.label) { fontSize = 15, alignment = TextAnchor.MiddleCenter, wordWrap = true };

            GUI.color = new Color(0f, 0f, 0f, 0.75f);
            GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
            GUI.color = Color.white;
            float width = Mathf.Min(720f, Screen.width - 40f), height = Mathf.Min(640f, Screen.height - 40f);
            var area = new Rect((Screen.width - width) / 2f, (Screen.height - height) / 2f, width, height);
            GUILayout.BeginArea(area, GUI.skin.box);
            GUILayout.Label("Test a map", title, GUILayout.Height(44));
            GUILayout.Label("Click a hole to play it right away. Your lobby works as usual, so friends can still join.", note);
            GUILayout.Space(8);
            scroll = GUILayout.BeginScrollView(scroll);
            if (MapLibrary.Maps.Count == 0)
                GUILayout.Label($"No maps installed. Put .sbgmap files in {MapLibrary.MapsFolder}", note);
            foreach (var pack in MapLibrary.Maps)
            {
                for (int i = 0; i < pack.Manifest.holes.Count; i++)
                {
                    var hole = pack.Manifest.holes[i];
                    string name = string.IsNullOrWhiteSpace(hole.name) ? $"Hole {i + 1}" : hole.name;
                    if (GUILayout.Button($"{pack.Manifest.name}   {i + 1}. {name}   (par {Mathf.Max(1, hole.par)})", row, GUILayout.Height(40)))
                        Play(pack.Manifest.id, i);
                }
            }
            GUILayout.EndScrollView();
            GUILayout.Space(8);
            if (GUILayout.Button("Back", row, GUILayout.Height(40)))
                open = false;
            GUILayout.EndArea();
        }

        /// <summary>A vanilla hole to start instead of a map hole (autorun), by scene or hole name.</summary>
        private static string pendingVanilla;
        private static bool quitAfterFacts;

        /// <summary>
        /// Dev autorun: if SbgMaps/autorun.txt names a hole ("Vertigo"), host it straight from the title screen,
        /// log the game values there and quit. The file is removed first, so it runs once. Used to read game values
        /// in a hidden game window without anyone playing.
        /// </summary>
        public static void TryAutorun()
        {
            string file = System.IO.Path.Combine(BepInEx.Paths.GameRootPath, "SbgMaps", "autorun.txt");
            if (!System.IO.File.Exists(file))
                return;
            string hole = System.IO.File.ReadAllText(file).Trim();
            System.IO.File.Delete(file);
            if (string.IsNullOrEmpty(hole))
                return;
            Plugin.Log.LogInfo($"Autorun: hosting '{hole}', then quitting");
            pendingVanilla = hole;
            quitAfterFacts = true;
            pendingMap = "";
            pendingSince = Time.realtimeSinceStartup;
            readySince = -1f;
            SingletonBehaviour<MainMenu>.Instance.StartHost();
        }

        public static void OnFactsLogged()
        {
            if (!quitAfterFacts)
                return;
            Plugin.Log.LogInfo("Autorun: done, quitting");
            Application.Quit();
        }

        private static void Play(string mapId, int hole)
        {
            open = false;
            pendingMap = mapId;
            pendingHole = hole;
            pendingSince = Time.realtimeSinceStartup;
            readySince = -1f;
            Plugin.Log.LogInfo($"Testing map '{mapId}' hole {hole + 1}");
            SingletonBehaviour<MainMenu>.Instance.StartHost();
        }

        /// <summary>Once the host's driving range is ready, start a course of just the picked hole.</summary>
        private static void TryStart()
        {
            if (Time.realtimeSinceStartup - pendingSince > StartTimeoutSeconds)
            {
                Plugin.Log.LogError($"Could not start map '{pendingMap}': the lobby did not come up");
                pendingMap = null;
                return;
            }
            bool ready = NetworkServer.active && SingletonBehaviour<DrivingRangeManager>.HasInstance
                && SingletonNetworkBehaviour<CourseManager>.HasInstance && GameManager.LocalPlayerMovement != null;
            if (!ready)
            {
                readySince = -1f;
                return;
            }
            // Give the game a moment to finish setting up the player.
            if (readySince < 0f)
                readySince = Time.realtimeSinceStartup;
            if (Time.realtimeSinceStartup - readySince < 0.5f)
                return;

            string mapId = pendingMap;
            pendingMap = null;
            try
            {
                string name = CustomCourse.HoleName(mapId, pendingHole);
                // The newest copy, in case the map changed since the game started.
                var hole = pendingVanilla != null
                    ? GameManager.AllCourses.allHoles.FirstOrDefault(h => h != null && (h.Scene.Name == pendingVanilla || h.name == pendingVanilla))
                    : GameManager.AllCourses.allHoles.LastOrDefault(h => h != null && h.name == name);
                pendingVanilla = null;
                if (hole == null)
                {
                    DevTools.Say($"Map '{mapId}' hole {pendingHole + 1} is not in the custom course");
                    return;
                }
                var course = MatchSetupMenu.CustomCourseData;
                course.OverrideHoles(new[] { hole });
                CourseManager.ServerSetCourse(course);
                CourseManager.StartCourse();
            }
            catch (Exception e)
            {
                Plugin.Log.LogError($"Could not start map '{mapId}': {e}");
                DevTools.Say($"Could not start the map: {e.Message}");
            }
        }
    }

    /// <summary>
    /// Picks up maps added to or changed in the maps folder without restarting the game. Only on the title screen:
    /// match setup builds its hole list when the lobby loads, so holes added during a lobby would not match it, and
    /// a player in someone else's lobby uses the host's maps anyway.
    /// </summary>
    internal static class MapWatcher
    {
        private const float IntervalSeconds = 2f;
        private static float next;

        public static void Update()
        {
            if (Time.realtimeSinceStartup < next)
                return;
            next = Time.realtimeSinceStartup + IntervalSeconds;
            if (SingletonBehaviour<MainMenu>.HasInstance)
                CheckNow();
        }

        public static void CheckNow()
        {
            try
            {
                if (!MapLibrary.RescanIfChanged())
                    return;
                CustomCourse.UseLocalMaps();
            }
            catch (Exception e)
            {
                Plugin.Log.LogError($"Could not reload maps: {e}");
            }
        }
    }
}
