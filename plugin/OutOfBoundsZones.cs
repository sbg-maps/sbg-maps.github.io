using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;
using Mirror;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Out of bounds zones (objects with extras.object "outofbounds"): invisible boxes. Balls go back to their player
    /// with a penalty stroke: the game's own ball trigger returns one that lands on ground inside, and the host returns
    /// one that drops out through the bottom (into a pit) or stays inside a moment without touching ground. Players
    /// whose chest is inside the box are knocked out like players falling into the game's fog pits, and respawn. Only
    /// the box counts: below it (a doorway under a pit) is in bounds. The game's own pit hazards reach down forever,
    /// which is why they are not used here.
    /// </summary>
    internal class MapOutOfBoundsZone : MonoBehaviour
    {
        /// <summary>How long a ball may be inside a zone, without touching ground, before it is sent back (seconds).</summary>
        private const float FallingFor = 1.5f;

        private static readonly MethodInfo ReturnToBounds = AccessTools.Method(typeof(GolfBall), "ServerReturnToBounds");
        private readonly Dictionary<GolfBall, float> inside = new Dictionary<GolfBall, float>();

        /// <summary>Turns the object's parts into a trigger box of their size; nothing of them is drawn or collides.</summary>
        public static void Attach(GameObject go)
        {
            var bounds = new Bounds();
            bool any = false;
            foreach (var filter in go.GetComponentsInChildren<MeshFilter>(true))
            {
                if (filter.sharedMesh == null)
                    continue;
                var b = filter.sharedMesh.bounds;
                for (int i = 0; i < 8; i++)
                {
                    var corner = b.center + Vector3.Scale(b.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1));
                    var local = go.transform.InverseTransformPoint(filter.transform.TransformPoint(corner));
                    if (!any)
                        bounds = new Bounds(local, Vector3.zero);
                    else
                        bounds.Encapsulate(local);
                    any = true;
                }
            }
            for (int i = go.transform.childCount - 1; i >= 0; i--)
                Object.DestroyImmediate(go.transform.GetChild(i).gameObject);
            foreach (var c in go.GetComponents<Component>())
                if (c is Renderer || c is MeshFilter || c is Collider)
                    Object.DestroyImmediate(c);
            if (!any)
                return;

            EnsureManager();
            var zone = new GameObject("out of bounds zone");
            zone.transform.SetParent(go.transform, false);
            var box = zone.AddComponent<BoxCollider>();
            box.isTrigger = true;
            box.center = bounds.center;
            box.size = bounds.size;
            zone.AddComponent<BallOutOfBoundsTrigger>(); // the game's own: only sees balls, returns those that land inside
            zone.AddComponent<MapOutOfBoundsZone>();
        }

        /// <summary>The game's trigger needs its manager, which only some holes have.</summary>
        private static void EnsureManager()
        {
            if (!SingletonBehaviour<BallOutOfBoundsTriggerManager>.HasInstance)
                new GameObject("ball out of bounds triggers").AddComponent<BallOutOfBoundsTriggerManager>();
        }

        private void OnTriggerEnter(Collider other)
        {
            var ball = other.GetComponentInParent<GolfBall>(true);
            if (ball != null && !inside.ContainsKey(ball))
                inside[ball] = Time.time;
        }

        private void OnTriggerExit(Collider other)
        {
            var ball = other.GetComponentInParent<GolfBall>(true);
            if (ball == null || !inside.Remove(ball))
                return;
            // Out through the bottom: it is falling into whatever the zone covers, so it goes back now.
            var zone = GetComponent<BoxCollider>().bounds;
            if (ball.transform.position.y < zone.min.y + 0.5f)
                SendBack(ball);
        }

        /// <summary>How often the host looks for players in the zone (seconds).</summary>
        private const float PlayerCheckInterval = 0.1f;
        private float nextPlayerCheck;
        /// <summary>Players just knocked out, until their respawn has begun.</summary>
        private readonly Dictionary<PlayerInfo, float> knockedOut = new Dictionary<PlayerInfo, float>();

        private void Update()
        {
            if (!NetworkServer.active || Time.time < nextPlayerCheck)
                return;
            nextPlayerCheck = Time.time + PlayerCheckInterval;
            var box = GetComponent<BoxCollider>();
            if (box == null || PlayerMovement.NoClipEnabled)
                return;
            foreach (var player in Object.FindObjectsByType<PlayerInfo>(FindObjectsSortMode.None))
            {
                if (knockedOut.TryGetValue(player, out var at) && Time.time - at < 3f)
                    continue;
                if (player == null || player.Movement == null || player.AsGolfer == null || !player.AsGolfer.IsInitialized || player.Movement.IsRespawning || player.ActiveGolfCartSeat.IsValid())
                    continue;
                var chest = player.ChestBone != null ? player.ChestBone.position : player.transform.position + Vector3.up;
                var local = transform.InverseTransformPoint(chest) - box.center;
                var half = box.size / 2f;
                if (Mathf.Abs(local.x) > half.x || Mathf.Abs(local.y) > half.y || Mathf.Abs(local.z) > half.z)
                    continue;
                Plugin.Log.LogInfo($"Out of bounds zone: {player.name} went in, knocked out");
                knockedOut[player] = Time.time;
                player.AsGolfer.ServerEliminate(EliminationReason.FellIntoFog);
            }
        }

        private void FixedUpdate()
        {
            if (inside.Count == 0)
                return;
            List<GolfBall> due = null;
            foreach (var pair in inside)
                if (pair.Key == null || Time.time - pair.Value > FallingFor)
                    (due ??= new List<GolfBall>()).Add(pair.Key);
            if (due == null)
                return;
            foreach (var ball in due)
            {
                inside.Remove(ball);
                SendBack(ball);
            }
        }

        private static void SendBack(GolfBall ball)
        {
            // Only the host sends balls back (it owns the match); already returning or held balls are left alone.
            if (ball == null || !NetworkServer.active || ball.IsHidden || ball.OutOfBoundsReturnState != BallOutOfBoundsReturnState.None)
                return;
            try
            {
                ReturnToBounds?.Invoke(ball, new object[] { false });
            }
            catch (System.Exception e)
            {
                Plugin.Log.LogWarning($"Out of bounds zone could not send a ball back: {e.InnerException?.Message ?? e.Message}");
            }
        }
    }
}
