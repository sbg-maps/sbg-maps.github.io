using HarmonyLib;
using Mirror;
using UnityEngine.SceneManagement;

namespace SbgMaps
{
    /// <summary>
    /// Tells every player which custom map hole the next donor scene load should become.
    /// The host sends it right before Mirror's scene change (and to late joiners right before their scene message),
    /// so it always arrives first on the same reliable channel.
    /// </summary>
    internal static class HoleSync
    {
        public struct SelectHoleMessage : NetworkMessage
        {
            public string mapId;   // empty for a vanilla hole
            public int holeIndex;
            public string hash;
        }

        /// <summary>The custom hole the current or next donor scene load should build, if any.</summary>
        public static SelectHoleMessage Current;

        static HoleSync()
        {
            // Our assembly is not processed by Mirror's weaver, so give it the serializers by hand.
            Writer<SelectHoleMessage>.write = (w, m) =>
            {
                w.WriteString(m.mapId);
                w.WriteInt(m.holeIndex);
                w.WriteString(m.hash);
            };
            Reader<SelectHoleMessage>.read = r => new SelectHoleMessage { mapId = r.ReadString(), holeIndex = r.ReadInt(), hash = r.ReadString() };
        }

        public static void Init()
        {
            // Touching the type runs the static constructor.
        }

        private static void OnSelectHole(SelectHoleMessage msg)
        {
            if (NetworkServer.active)
                return; // the host already set it
            Current = msg;
            if (string.IsNullOrEmpty(msg.mapId))
                return;
            var pack = MapLibrary.Find(msg.mapId);
            if (pack == null)
                DevTools.Say($"The host picked map '{msg.mapId}', which you don't have installed");
            else if (pack.Hash != msg.hash)
                DevTools.Say($"Your copy of map '{msg.mapId}' differs from the host's; the hole may not match");
        }

        public static void OnSceneLoaded(Scene scene)
        {
            if (scene.name != MapBuilder.DonorScene || string.IsNullOrEmpty(Current.mapId))
                return;
            var pack = MapLibrary.Find(Current.mapId);
            if (pack == null)
            {
                Plugin.Log.LogError($"Map '{Current.mapId}' is not installed; showing the vanilla hole");
                return;
            }
            try
            {
                pack.Reload();
                MapBuilder.Build(scene, pack, Current.holeIndex);
            }
            catch (System.Exception e)
            {
                Plugin.Log.LogError($"Failed to build '{Current.mapId}' hole {Current.holeIndex + 1}: {e}");
                DevTools.Say($"Failed to build the custom hole: {e.Message}");
            }
        }

        private static SelectHoleMessage MessageFor(string sceneName)
        {
            // CourseManager has already advanced nextHoleIndex past the hole it is loading.
            var course = GameManager.CurrentCourse;
            int index = ServerPersistentCourseData.nextHoleIndex - 1;
            if (course != null && index >= 0 && index < course.Holes.Length && course.Holes[index].Scene.Name == sceneName
                && CustomCourse.TryGetMapHole(course.Holes[index], out var pack, out int holeIndex))
                return new SelectHoleMessage { mapId = pack.Manifest.id, holeIndex = holeIndex, hash = pack.Hash };
            return new SelectHoleMessage { mapId = "", holeIndex = -1, hash = "" };
        }

        /// <summary>Longest the host waits on the loading screen for players still getting the map.</summary>
        private const float MaxWaitSeconds = 120f;
        private static bool waited;

        /// <summary>Holds the scene change until every player has the map, then makes it.</summary>
        private static System.Collections.IEnumerator WaitThenChange(string sceneName, string mapId)
        {
            float start = UnityEngine.Time.realtimeSinceStartup, lastSaid = -10f;
            while (MapTransfer.IsAnyoneGetting(mapId, out string who) && UnityEngine.Time.realtimeSinceStartup - start < MaxWaitSeconds)
            {
                if (UnityEngine.Time.realtimeSinceStartup - lastSaid > 5f)
                {
                    lastSaid = UnityEngine.Time.realtimeSinceStartup;
                    Plugin.Log.LogInfo($"Waiting for {who} to get map '{mapId}'");
                }
                yield return null;
            }
            if (!NetworkServer.active)
                yield break;
            waited = true;
            BNetworkManager.singleton.ServerChangeScene(sceneName);
        }

        [HarmonyPatch(typeof(BNetworkManager), nameof(BNetworkManager.ServerChangeScene))]
        private static class ServerChangeScenePatch
        {
            private static bool Prefix(string newSceneName)
            {
                var next = MessageFor(newSceneName);
                if (!waited && !string.IsNullOrEmpty(next.mapId) && MapTransfer.IsAnyoneGetting(next.mapId, out _))
                {
                    Plugin.Instance.StartCoroutine(WaitThenChange(newSceneName, next.mapId));
                    return false;
                }
                waited = false;
                Current = next;
                if (!string.IsNullOrEmpty(Current.mapId))
                    Plugin.Log.LogInfo($"Next hole is custom: {Current.mapId} hole {Current.holeIndex + 1}");
                NetworkServer.SendToAll(Current);
                return true;
            }
        }

        [HarmonyPatch(typeof(NetworkManager), "OnServerAuthenticated")]
        private static class LateJoinPatch
        {
            private static void Prefix(NetworkConnectionToClient conn)
            {
                // Map list first, so the player can start downloading while the lobby loads.
                MapTransfer.SendListTo(conn);
                conn.Send(Current);
            }
        }

        [HarmonyPatch(typeof(NetworkManager), "RegisterClientMessages")]
        private static class RegisterClientPatch
        {
            private static void Postfix()
            {
                NetworkClient.ReplaceHandler<SelectHoleMessage>(OnSelectHole, requireAuthentication: false);
                Seesaw.RegisterClientHandler();
                MapTransfer.RegisterClientHandlers();
            }
        }
    }
}
