using System.Linq;
using System.Collections.Generic;
using FMODUnity;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Map jump pads (objects with extras.object "jumppad"): players and balls touching the top are launched along the
    /// pad's forward direction, tilted up by launchPitch degrees, at launchSpeed m/s (players standing). Balls, diving and
    /// knocked-out players get weaker, steeper launches in the same proportions as the game's own pads (103 m/s at 35
    /// degrees for players). Works like the game's pads: every machine runs the trigger and the game only moves what
    /// that machine controls, so nothing is networked.
    /// </summary>
    internal class MapJumpPad : MonoBehaviour
    {
        /// <summary>How high above the pad's top things are caught, in metres.</summary>
        private const float CatchHeight = 1.2f;

        private float speed = GamePlayerSpeed;
        private float pitch = GamePlayerPitch;

        // The game's own pad (Vertigo): launch speed and pitch per kind of thing launched.
        private const float GamePlayerSpeed = 103f, GamePlayerPitch = 35f;
        private const float GameDivingSpeed = 67f, GameKnockedOutSpeed = 78f, GameBallSpeed = 33f, GameOtherSpeed = 27f;
        private const float GameOtherPitchesUp = 10f; // the others launch at 45 instead of 35 degrees
        private readonly Dictionary<Hittable, float> lastLaunch = new Dictionary<Hittable, float>();

        public static void Attach(GameObject go, Newtonsoft.Json.Linq.JObject extras)
        {
            var pad = go.AddComponent<MapJumpPad>();
            pad.speed = Mathf.Clamp((float?)extras?["launchSpeed"] ?? GamePlayerSpeed, 0f, 250f);
            pad.pitch = Mathf.Clamp((float?)extras?["launchPitch"] ?? GamePlayerPitch, 0f, 180f);
            pad.AddTrigger();
            pad.UseGameLook();
        }

        public const string LookName = "jump-pad";

        /// <summary>Saves the game's jump pad look while a hole that has one is loaded (once per computer).</summary>
        public static void CaptureLookIfHere()
        {
            if (AssetCapture.Has(LookName))
                return;
            var pad = Object.FindFirstObjectByType<JumpPad>(FindObjectsInactive.Include);
            if (pad == null)
                return;
            try
            {
                AssetCapture.Save(LookName, pad.transform);
            }
            catch (System.Exception e)
            {
                Plugin.Log.LogWarning($"Could not save the jump pad look: {e}");
            }
        }

        /// <summary>
        /// Swaps the map's stand-in pad for the game's own pad look (saved from the game), sized to the stand-in's
        /// footprint. The stand-in keeps colliding; only its drawing is turned off.
        /// </summary>
        private void UseGameLook()
        {
            var look = AssetCapture.Load(LookName);
            if (look == null)
                return;
            var holder = new GameObject("game jump pad look");
            holder.transform.SetParent(transform, false);
            if (!AssetCapture.BuildLook(look, holder.transform))
            {
                Object.Destroy(holder);
                return;
            }
            var mine = GetComponentsInChildren<MeshRenderer>(true).Where(r => !r.transform.IsChildOf(holder.transform)).ToList();
            var bounds = new Bounds();
            bool any = false;
            foreach (var r in mine)
            {
                if (!any)
                    bounds = r.bounds;
                else
                    bounds.Encapsulate(r.bounds);
                any = true;
            }
            var gameBounds = new Bounds(holder.transform.position, Vector3.zero);
            foreach (var r in holder.GetComponentsInChildren<MeshRenderer>(true))
                gameBounds.Encapsulate(r.bounds);
            if (any && gameBounds.size.x > 0.01f && gameBounds.size.z > 0.01f)
            {
                float fit = Mathf.Max(bounds.size.x, bounds.size.z) / Mathf.Max(gameBounds.size.x, gameBounds.size.z);
                holder.transform.localScale *= fit;
            }
            foreach (var r in mine)
                r.enabled = false;
        }

        /// <summary>A trigger box over the top of the pad's meshes, in the pad's own space.</summary>
        private void AddTrigger()
        {
            var bounds = new Bounds();
            bool any = false;
            foreach (var filter in GetComponentsInChildren<MeshFilter>(true))
            {
                if (filter.sharedMesh == null)
                    continue;
                var b = filter.sharedMesh.bounds;
                for (int i = 0; i < 8; i++)
                {
                    var corner = b.center + Vector3.Scale(b.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1));
                    var local = transform.InverseTransformPoint(filter.transform.TransformPoint(corner));
                    if (!any)
                        bounds = new Bounds(local, Vector3.zero);
                    else
                        bounds.Encapsulate(local);
                    any = true;
                }
            }
            if (!any)
                bounds = new Bounds(Vector3.zero, new Vector3(4f, 0.5f, 4f));
            float scaleY = Mathf.Max(0.0001f, transform.lossyScale.y);
            var trigger = new GameObject("jump pad trigger");
            trigger.transform.SetParent(transform, false);
            var box = trigger.AddComponent<BoxCollider>();
            box.isTrigger = true;
            float height = CatchHeight / scaleY;
            box.center = new Vector3(bounds.center.x, bounds.max.y + height / 2f - 0.1f / scaleY, bounds.center.z);
            box.size = new Vector3(bounds.size.x, height, bounds.size.z);
            box.includeLayers = GameManager.LayerSettings.JumpPadHittablesMask;
            box.excludeLayers = ~(int)GameManager.LayerSettings.JumpPadHittablesMask;
            trigger.AddComponent<MapJumpPadTrigger>().Pad = this;
        }

        /// <summary>Speed and pitch for what is being launched, scaled from the pad's player setting like the game's pads.</summary>
        private (float speed, float pitch) LaunchFor(Hittable hittable)
        {
            float steeper = Mathf.Min(90f, pitch + GameOtherPitchesUp);
            var entity = hittable.AsEntity;
            if (entity.IsPlayer)
            {
                var movement = entity.PlayerInfo.Movement;
                if (movement.DivingState != DivingState.None)
                    return (speed * GameDivingSpeed / GamePlayerSpeed, steeper);
                if (movement.IsKnockedOut || hittable.FrozenState == FrozenState.Frozen)
                    return (speed * GameKnockedOutSpeed / GamePlayerSpeed, steeper);
                return (speed, pitch);
            }
            if (entity.IsGolfBall)
                return (speed * GameBallSpeed / GamePlayerSpeed, steeper);
            return (speed * GameOtherSpeed / GamePlayerSpeed, steeper);
        }

        public void OnTouch(Collider other)
        {
            if (other.gameObject.layer == GameManager.LayerSettings.StationaryBallLayer)
                return;
            var body = other.attachedRigidbody;
            // Already flying up and away: leave it be (the game's pads do the same).
            if (body != null && Vector3.Dot(body.linearVelocity, transform.up) > 0f)
                return;
            Hittable hittable = body != null ? body.GetComponentInParent<Hittable>(true) : other.GetComponentInParent<Hittable>(true);
            if (hittable == null)
                return;
            float cooldown = GameManager.HazardSettings != null ? GameManager.HazardSettings.JumpPadCooldown : 0.5f;
            if (lastLaunch.TryGetValue(hittable, out float last) && Time.time - last < cooldown)
                return;
            lastLaunch[hittable] = Time.time;
            var forward = Vector3.ProjectOnPlane(transform.forward, Vector3.up);
            if (forward.sqrMagnitude < 1e-4f)
                forward = Vector3.forward;
            forward.Normalize();
            var right = Vector3.Cross(Vector3.up, forward);
            var (launchSpeed, launchPitch) = LaunchFor(hittable);
            var velocity = Quaternion.AngleAxis(-launchPitch, right) * forward * launchSpeed;
            hittable.HitWithJumpPadLocalOnly(velocity);
            try
            {
                RuntimeManager.PlayOneShot(GameManager.AudioSettings.JumpPadTriggeredEvent, transform.position);
            }
            catch
            {
                // Sound is a nicety.
            }
        }
    }

    internal class MapJumpPadTrigger : MonoBehaviour
    {
        public MapJumpPad Pad;

        private void OnTriggerStay(Collider other)
        {
            if (Pad != null)
                Pad.OnTouch(other);
        }
    }
}
