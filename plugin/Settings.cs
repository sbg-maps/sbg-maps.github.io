using System;
using System.Linq;
using BepInEx.Configuration;
using HarmonyLib;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace SbgMaps
{
    /// <summary>
    /// The mod's own settings, saved in BepInEx/config/loafer.sbgmaps.cfg, and the "Mod settings" window (opened from
    /// Custom maps on the title screen) that changes them.
    /// </summary>
    internal static class Settings
    {
        public static ConfigEntry<bool> SkipIntro;
        public static ConfigEntry<bool> HotKeys;
        public static ConfigEntry<float> MusicVolume;
        public static ConfigEntry<string> CommunityLink;

        private static bool open;
        private static GUIStyle title, label, note, toggle;
        private static MainMenu skippedFor;

        public static void Init(ConfigFile config)
        {
            SkipIntro = config.Bind("General", "SkipIntro", true, "Go straight to the title screen when the game starts.");
            HotKeys = config.Bind("General", "HotKeys", true, "F5 restarts the hole and F7 skips it (only when you are alone in the lobby), F8 logs object positions, F9 saves your character for the map editor.");
            MusicVolume = config.Bind("General", "MusicVolume", 1f, new ConfigDescription("Volume of songs that maps bring, 0 to 1.", new AcceptableValueRange<float>(0f, 1f)));
            MusicVolume.SettingChanged += (_, __) => HoleMusic.ApplyVolume();
            CommunityLink = config.Bind("General", "CommunityLink", "", "Your group's community maps link, from the pack bot in your Discord. Shown under Community in Custom maps.");
        }

        public static void Update()
        {
            if (!SingletonBehaviour<MainMenu>.HasInstance)
            {
                open = false;
                return;
            }
            var menu = SingletonBehaviour<MainMenu>.Instance;
            // The game's own skip switch; its intro checks it every frame, so it works even when the mod loads late.
            if (SkipIntro.Value && skippedFor != menu)
            {
                Traverse.Create(menu).Field("debugSkipIntro").SetValue(true);
                skippedFor = menu;
            }
            if (open && Keyboard.current != null && Keyboard.current.escapeKey.wasPressedThisFrame)
                open = false;
        }

        public static void Open() => open = true;

        public static void OnGUI()
        {
            if (!open)
                return;
            title ??= new GUIStyle(GUI.skin.label) { fontSize = 26, fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            label ??= new GUIStyle(GUI.skin.label) { fontSize = 18 };
            note ??= new GUIStyle(GUI.skin.label) { fontSize = 14, wordWrap = true };
            toggle ??= new GUIStyle(GUI.skin.toggle) { fontSize = 18, padding = new RectOffset(26, 6, 4, 4) };

            GUI.color = new Color(0f, 0f, 0f, 0.75f);
            GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
            GUI.color = Color.white;
            float width = Mathf.Min(620f, Screen.width - 40f), height = Mathf.Min(540f, Screen.height - 40f);
            GUILayout.BeginArea(new Rect((Screen.width - width) / 2f, (Screen.height - height) / 2f, width, height), GUI.skin.box);
            GUILayout.Label($"SbgMaps {Plugin.Version}", title, GUILayout.Height(44));
            GUILayout.Space(8);

            SkipIntro.Value = GUILayout.Toggle(SkipIntro.Value, " Skip the intro when the game starts", toggle);
            GUILayout.Space(6);
            HotKeys.Value = GUILayout.Toggle(HotKeys.Value, " Keys: F5 restart and F7 skip the hole (alone only), F9 save my character", toggle);
            GUILayout.Space(12);
            GUILayout.Label($"Map music volume: {Mathf.RoundToInt(MusicVolume.Value * 100)}%", label);
            float v = GUILayout.HorizontalSlider(MusicVolume.Value, 0f, 1f);
            if (Mathf.Abs(v - MusicVolume.Value) > 0.001f)
                MusicVolume.Value = Mathf.Round(v * 20f) / 20f;
            GUILayout.Label("Songs that maps bring. The game's own music has its own setting.", note);
            GUILayout.Space(12);
            GUILayout.Label("Community maps link", label);
            GUILayout.BeginHorizontal();
            CommunityLink.Value = GUILayout.TextField(CommunityLink.Value ?? "", GUILayout.Height(30)).Trim();
            if (GUILayout.Button("Paste", GUILayout.Width(80), GUILayout.Height(30)))
                CommunityLink.Value = (GUIUtility.systemCopyBuffer ?? "").Trim();
            GUILayout.EndHorizontal();
            GUILayout.Label(CommunityLink.Value.Length == 0 ? "From the pack bot in your Discord's map thread."
                : Community.BaseUrl(CommunityLink.Value) == null ? "That is not a web link." : "Open Community in Custom maps to get the maps.", note);

            GUILayout.FlexibleSpace();
            GUILayout.Label("Saved in BepInEx/config/loafer.sbgmaps.cfg.", note);
            if (GUILayout.Button("Close", GUILayout.Height(40)))
                open = false;
            GUILayout.EndArea();
        }
    }

    /// <summary>Extra buttons on the title screen, made from the game's own lobby browser button.</summary>
    internal static class TitleButtons
    {
        /// <summary>The menu buttons are wired up in the scene; the lobby browser one is copied for ours.</summary>
        private const string TemplateMethod = "OpenLobbyBrowser";

        /// <summary>Adds (or finds) a button `after` places below the lobby browser button; null until the menu is up.</summary>
        public static GameObject Add(string name, string text, int after, Action onClick)
        {
            var template = UnityEngine.Object.FindObjectsByType<Button>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .FirstOrDefault(b => Enumerable.Range(0, b.onClick.GetPersistentEventCount()).Any(i => b.onClick.GetPersistentMethodName(i) == TemplateMethod));
            if (template == null)
                return null;
            var parent = template.transform.parent;
            var existing = parent.Find(name);
            if (existing != null)
            {
                SetText(existing.gameObject, text);
                return existing.gameObject;
            }
            var go = UnityEngine.Object.Instantiate(template.gameObject, parent);
            go.name = name;
            go.transform.SetSiblingIndex(Mathf.Min(template.transform.GetSiblingIndex() + after, parent.childCount - 1));
            // Localized labels would put the template's text back.
            foreach (var c in go.GetComponentsInChildren<MonoBehaviour>(true))
                if (c.GetType().Name.Contains("Localize"))
                    UnityEngine.Object.DestroyImmediate(c);
            SetText(go, text);
            var b = go.GetComponent<Button>();
            b.onClick = new Button.ButtonClickedEvent();
            b.onClick.AddListener(() => onClick());
            Plugin.Log.LogInfo($"Added '{text}' to the title screen");
            return go;
        }

        private static void SetText(GameObject go, string text)
        {
            foreach (var t in go.GetComponentsInChildren<TMP_Text>(true))
                t.text = text;
        }
    }
}
