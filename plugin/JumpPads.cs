using System.Collections.Generic;
using FMODUnity;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Map jump pads (objects with extras.object "jumppad"): players and balls touching the top are launched along the
    /// pad's forward direction, tilted up by launchPitch degrees, at launchSpeed m/s. Works like the game's own pads:
    /// every machine runs the trigger and the game only moves what that machine controls, so nothing is networked.
    /// </summary>
    internal class MapJumpPad : MonoBehaviour
    {
        /// <summary>How high above the pad's top things are caught, in metres.</summary>
        private const float CatchHeight = 1.2f;

        private float speed = 22f;
        private float pitch = 65f;
        private readonly Dictionary<Hittable, float> lastLaunch = new Dictionary<Hittable, float>();

        public static void Attach(GameObject go, Newtonsoft.Json.Linq.JObject extras)
        {
            var pad = go.AddComponent<MapJumpPad>();
            pad.speed = Mathf.Clamp((float?)extras?["launchSpeed"] ?? 22f, 0f, 200f);
            pad.pitch = Mathf.Clamp((float?)extras?["launchPitch"] ?? 65f, 0f, 180f);
            pad.AddTrigger();
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
            var velocity = Quaternion.AngleAxis(-pitch, right) * forward * speed;
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
