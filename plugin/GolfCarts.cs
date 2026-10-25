using System.Collections;
using System.Collections.Generic;
using Mirror;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Golf carts a map parks on a hole: the game's own cart (the one the Golf cart item brings), spawned by the host
    /// once the hole is running, so every player gets it through the game's networking and anyone can drive it.
    /// </summary>
    internal static class GolfCarts
    {
        /// <summary>Most carts one hole may park.</summary>
        public const int Max = 16;

        public static void SpawnWhenReady(List<(Vector3 position, float? yaw)> carts, Vector3 cup)
        {
            Plugin.Instance.StartCoroutine(Spawn(carts, cup));
        }

        private static IEnumerator Spawn(List<(Vector3 position, float? yaw)> carts, Vector3 cup)
        {
            // Only the host spawns; players get the carts from it. Wait until the hole's network objects are up.
            float give = Time.realtimeSinceStartup + 30f;
            while (Time.realtimeSinceStartup < give && !(NetworkServer.active && SingletonNetworkBehaviour<CourseManager>.HasInstance))
                yield return null;
            if (!NetworkServer.active)
                yield break;
            yield return new WaitForSeconds(1f);
            var prefab = GameManager.GolfCartSettings != null ? GameManager.GolfCartSettings.Prefab : null;
            if (prefab == null)
            {
                Plugin.Log.LogWarning("Golf carts: the game's cart is not available");
                yield break;
            }
            int spawned = 0;
            foreach (var (position, yaw) in carts)
            {
                if (spawned >= Max)
                    break;
                var toCup = Vector3.ProjectOnPlane(cup - position, Vector3.up);
                var rotation = yaw.HasValue ? Quaternion.Euler(0f, yaw.Value, 0f) : (toCup.sqrMagnitude > 0.01f ? Quaternion.LookRotation(toCup) : Quaternion.identity);
                var cart = Object.Instantiate(prefab, position + Vector3.up * 0.5f, rotation);
                NetworkServer.Spawn(cart.gameObject);
                spawned++;
            }
            Plugin.Log.LogInfo($"Golf carts: parked {spawned}");
        }
    }
}
