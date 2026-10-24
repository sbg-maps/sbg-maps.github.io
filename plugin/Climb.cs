using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Climbable surfaces (material extras.climbable): players can stand on and walk up them up to MaxSlope,
    /// past the game's own steepness limit (UngroundableGroundPitchThreshold). SM64 lets Mario run up any
    /// floor that is not slippery, so converted levels mark those floors climbable.
    /// The game's limit is one global setting, so it is raised only for the ground check of a player
    /// standing over a climbable collider, and put back right after.
    /// </summary>
    [HarmonyPatch(typeof(PlayerMovement), "PerformGroundCheck")]
    internal static class Climb
    {
        public const float MaxSlope = 80f;

        private static readonly HashSet<Collider> colliders = new HashSet<Collider>();
        private static readonly RaycastHit[] hits = new RaycastHit[8];
        private static readonly MethodInfo setThreshold = AccessTools.PropertySetter(typeof(PlayerMovementSettings), nameof(PlayerMovementSettings.UngroundableGroundPitchThreshold));

        public static void Register(Collider c)
        {
            colliders.RemoveWhere(x => x == null);
            colliders.Add(c);
            c.gameObject.AddComponent<ClimbableSurface>();
        }

        /// <summary>Known climbable, or marked so by an earlier copy of the mod (the level outlives a hot reload, this set does not).</summary>
        private static bool IsClimbable(Collider c)
        {
            if (colliders.Contains(c))
                return true;
            if (c.GetComponent(nameof(ClimbableSurface)) == null)
                return false;
            colliders.Add(c);
            return true;
        }

        private static void Prefix(PlayerMovement __instance, out float __state)
        {
            __state = float.NaN;
            if (setThreshold == null)
                return;
            var settings = GameManager.PlayerMovementSettings;
            if (settings == null || settings.UngroundableGroundPitchThreshold >= MaxSlope || !OverClimbable(__instance.transform.position))
                return;
            __state = settings.UngroundableGroundPitchThreshold;
            setThreshold.Invoke(settings, new object[] { MaxSlope });
        }

        private static void Finalizer(float __state)
        {
            if (!float.IsNaN(__state))
                setThreshold.Invoke(GameManager.PlayerMovementSettings, new object[] { __state });
        }

        private static bool OverClimbable(Vector3 feet)
        {
            int count = Physics.RaycastNonAlloc(feet + Vector3.up, Vector3.down, hits, 2.5f, GameManager.LayerSettings.PlayerGroundableMask, QueryTriggerInteraction.Ignore);
            Collider nearest = null;
            float best = float.PositiveInfinity;
            for (int i = 0; i < count; i++)
                if (hits[i].distance < best)
                    (best, nearest) = (hits[i].distance, hits[i].collider);
            return nearest != null && IsClimbable(nearest);
        }
    }

    /// <summary>Marks a climbable collider by type name, which still matches after the mod is reloaded.</summary>
    internal class ClimbableSurface : MonoBehaviour
    {
    }
}
