using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;
using Mirror;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Out of bounds zones (objects with extras.object "outofbounds"): invisible boxes that send balls back to their
    /// player with a penalty stroke. They use the game's own ball trigger, so a ball that lands on ground inside one
    /// is returned exactly like the game's out of bounds areas. The host also returns a ball that drops out through
    /// the zone's bottom (into a pit) or is still inside after a moment without touching ground. Players pass through.
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
