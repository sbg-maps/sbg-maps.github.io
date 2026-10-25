using System.Linq;
using System.Text;
using HarmonyLib;
using Mirror;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;

namespace SbgMaps
{
    /// <summary>
    /// Host-side dev hotkeys. Feedback goes to the in-game text chat (local only) and the BepInEx log.
    ///   F5  restart the current hole (custom holes re-read their map files, so edits show up)
    ///   F7  skip to the next hole
    ///   F8  dump gameplay object positions to the log
    ///   F9  save your golfer and the camera view to SbgMaps/golfer.glb for the map editor
    /// </summary>
    internal static class DevTools
    {
        public static void Update()
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
                GolferExport.Export();
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
            // Item box kinds the game has loaded (looking for the special red boxes).
            string PoolText(ItemPool pool) => pool == null ? "-" : $"'{pool.name}' [{string.Join(", ", pool.SpawnChances.Select(c => $"{c.item} {c.spawnChanceWeight:0.##}"))}]";
            foreach (var settings in Resources.FindObjectsOfTypeAll<ItemSpawnerSettings>())
            {
                sb.AppendLine($"  ItemSpawnerSettings '{settings.name}' respawn={settings.RespawnTime} pickUpRadius={settings.PickUpRadius} aheadOfBall={PoolText(settings.AheadOfBallItemPoolDefaults)}");
                foreach (var data in settings.ItemPoolsDefaults ?? new System.Collections.Generic.List<ItemSpawnerSettings.ItemPoolData>())
                    sb.AppendLine($"    pool from {data.minDistanceBehindLeader} m behind: {PoolText(data.pool)}");
            }
            foreach (var pad in Object.FindObjectsByType<JumpPad>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                var t = Traverse.Create(pad);
                string Jump(string field)
                {
                    var j = t.Field(field);
                    return $"{field} pitch={j.Field("pitch").GetValue()} speed={j.Field("speed").GetValue()}";
                }
                var bounds = new Bounds(pad.transform.position, Vector3.zero);
                foreach (var r in pad.GetComponentsInChildren<Renderer>(true))
                    bounds.Encapsulate(r.bounds);
                sb.AppendLine($"  JumpPad '{pad.name}' pos={pad.transform.position} rot={pad.transform.eulerAngles} size={bounds.size} {Jump("playerJump")} {Jump("divingPlayerJump")} {Jump("knockedOutPlayerJump")} {Jump("ballJump")} {Jump("defaultJump")}");
            }
            foreach (var visuals in Resources.FindObjectsOfTypeAll<ItemSpawnerVisuals>())
                sb.AppendLine($"  ItemSpawnerVisuals '{visuals.name}' type={HarmonyLib.Traverse.Create(visuals).Field("type").GetValue()} scene='{visuals.gameObject.scene.name}'");
            // Player size, for the editor's scale reference golfer.
            var me = GameManager.LocalPlayerMovement;
            if (me != null)
            {
                foreach (var c in me.GetComponentsInChildren<Collider>())
                    sb.AppendLine($"  Player collider '{c.name}' {c.GetType().Name} trigger={c.isTrigger} bounds={c.bounds.size}" +
                        (c is CapsuleCollider cap ? $" capsule height={cap.height * c.transform.lossyScale.y:F2} radius={cap.radius * c.transform.lossyScale.x:F2}" : ""));
                var renderBounds = new Bounds(me.transform.position, Vector3.zero);
                foreach (var r in me.GetComponentsInChildren<SkinnedMeshRenderer>())
                    renderBounds.Encapsulate(r.bounds);
                sb.AppendLine($"  Player visual size {renderBounds.size}");
            }
            Plugin.Log.LogInfo(sb.ToString());
            Say("Gameplay objects written to the BepInEx log");
        }
    }
}
