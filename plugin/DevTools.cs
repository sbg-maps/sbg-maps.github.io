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
    /// F5 and F7 only work for a host alone in the lobby.
    ///   F5  restart the current hole (custom holes re-read their map files, so edits show up)
    ///   F7  skip to the next hole
    ///   F8  dump gameplay object positions to the log
    ///   F9  save your character and the camera view to SbgMaps/my-character.glb for the map editor
    /// </summary>
    internal static class DevTools
    {
        public static void Update()
        {
            var kb = Keyboard.current;
            if (kb == null || !Settings.HotKeys.Value)
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
            if (!NetworkServer.active || !SingletonNetworkBehaviour<CourseManager>.HasInstance)
            {
                Say("Only the host can do that, and only during a match");
                return false;
            }
            // Restarting or skipping a hole is for testing alone: with friends in the lobby it would cut their game short.
            if (NetworkServer.connections.Values.Any(c => c != null && c != NetworkServer.localConnection))
            {
                Say("F5 and F7 only work when you are alone in the lobby");
                return false;
            }
            return true;
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

        /// <summary>
        /// Game values the editor and mod copy (gravity, item pools, jump pad launches), as log lines.
        /// </summary>
        public static string GameFacts()
        {
            var sb = new StringBuilder();
            sb.AppendLine($"  Physics gravity={Physics.gravity} playerGravityFactor={GameManager.PlayerMovementSettings?.BaseGravityFactor} knockedOutFactor={GameManager.PlayerMovementSettings?.KnockOutGravityFactor} jumpPadCooldown={GameManager.HazardSettings?.JumpPadCooldown}");
            sb.AppendLine($"  Player drag air={GameManager.PlayerMovementSettings?.AirHorizontalDrag} default={GameManager.PlayerMovementSettings?.DefaultHorizontalDrag} grounded={GameManager.PlayerMovementSettings?.GroundedHorizontalDrag} fixedDeltaTime={Time.fixedDeltaTime} ballAirDrag={GameManager.GolfBallSettings?.LinearAirDragFactor}");
            var ballBody = Object.FindFirstObjectByType<GolfBall>()?.GetComponent<Rigidbody>();
            if (ballBody != null)
                sb.AppendLine($"  Ball rigidbody drag={ballBody.linearDamping} useGravity={ballBody.useGravity} mass={ballBody.mass}");
            var playerBody = GameManager.LocalPlayerMovement != null ? GameManager.LocalPlayerMovement.GetComponent<Rigidbody>() : null;
            if (playerBody != null)
                sb.AppendLine($"  Player rigidbody drag={playerBody.linearDamping} useGravity={playerBody.useGravity} mass={playerBody.mass}");
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
            // How each kind of item box is built (looking for the red box's own look).
            var seenKinds = new System.Collections.Generic.HashSet<string>();
            foreach (var spawner in Object.FindObjectsByType<ItemSpawner>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                var settings = Traverse.Create(spawner).Field("settings").GetValue<ItemSpawnerSettings>();
                string kind = settings != null ? settings.name : "?";
                if (!seenKinds.Add(kind))
                    continue;
                sb.AppendLine($"  Box '{spawner.name}' settings='{kind}':");
                foreach (var t in spawner.GetComponentsInChildren<Transform>(true))
                {
                    var parts = new System.Collections.Generic.List<string>();
                    foreach (var c in t.GetComponents<Component>())
                        if (!(c is Transform))
                            parts.Add(c.GetType().Name);
                    if (t.TryGetComponent<MeshFilter>(out var mf) && mf.sharedMesh != null)
                        parts.Add($"mesh='{mf.sharedMesh.name}'");
                    if (t.TryGetComponent<Renderer>(out var r))
                        foreach (var m in r.sharedMaterials)
                            if (m != null)
                                parts.Add($"material='{m.name}' shader='{m.shader.name}'" + (m.HasProperty("_BaseColor") ? $" base={m.GetColor("_BaseColor")}" : "") + (m.HasProperty("_Color") ? $" color={m.GetColor("_Color")}" : ""));
                    int depth = 0;
                    for (var p = t; p != spawner.transform && p != null; p = p.parent)
                        depth++;
                    sb.AppendLine($"    {new string(' ', depth * 2)}{t.name} [{string.Join(", ", parts)}] active={t.gameObject.activeSelf}");
                }
                foreach (var f in AccessTools.GetDeclaredFields(typeof(ItemSpawner)))
                    if (typeof(Object).IsAssignableFrom(f.FieldType))
                        sb.AppendLine($"    field {f.Name} = {f.GetValue(spawner)}");
                foreach (var f in AccessTools.GetDeclaredFields(typeof(ItemSpawnerSettings)))
                    if (typeof(Object).IsAssignableFrom(f.FieldType))
                        sb.AppendLine($"    settings field {f.Name} = {f.GetValue(settings)}");
            }
            return sb.ToString();
        }

        private static readonly System.Collections.Generic.HashSet<string> factsLogged = new System.Collections.Generic.HashSet<string>();

        /// <summary>Logs the game values once per hole, a moment after it loads, so nobody has to press F8 for them.</summary>
        public static System.Collections.IEnumerator LogFactsOnce(string sceneName)
        {
            if (!factsLogged.Add(sceneName))
                yield break;
            yield return new WaitForSeconds(3f);
            Plugin.Log.LogInfo($"Game facts in '{sceneName}':\n{GameFacts()}");
            RedItemBoxes.CaptureLookIfHere();
            MapJumpPad.CaptureLookIfHere();
            if (sceneName != "Driving range")
                MapPicker.OnFactsLogged();
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
            sb.Append(GameFacts());
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
