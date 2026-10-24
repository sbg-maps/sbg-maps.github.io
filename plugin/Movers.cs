using System;
using System.Collections.Generic;
using System.Linq;
using Mirror;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// A platform that tilts toward the players standing on it, like SM64's see-saw bridge.
    /// The host simulates it and sends the angle to everyone; clients ease toward it.
    /// </summary>
    internal class Seesaw : MonoBehaviour
    {
        // SM64 tilts at up to ~8 degrees/s; a little livelier suits golf.
        private const float Acceleration = 120f;     // deg/s^2 with a player at the very end
        private const float MaxSpeed = 15f;          // deg/s
        private const float ReturnAcceleration = 20f;
        private const float MaxPitch = 30f;
        private const float SendInterval = 0.1f;

        private static readonly List<Seesaw> active = new List<Seesaw>();
        private static readonly List<PlayerMovement> players = new List<PlayerMovement>();
        private static float nextPlayerScan;

        public int Id;
        private Rigidbody body;
        private Collider[] colliders;
        private Quaternion baseRotation;
        private float halfLength = 1f;
        private float pitch, speed, targetPitch, nextSend;

        public struct StateMessage : NetworkMessage
        {
            public int id;
            public float pitch;
        }

        static Seesaw()
        {
            Writer<StateMessage>.write = (w, m) =>
            {
                w.WriteInt(m.id);
                w.WriteFloat(m.pitch);
            };
            Reader<StateMessage>.read = r => new StateMessage { id = r.ReadInt(), pitch = r.ReadFloat() };
        }

        public static void RegisterClientHandler() => NetworkClient.ReplaceHandler<StateMessage>(OnState, requireAuthentication: false);

        private static void OnState(StateMessage msg)
        {
            if (NetworkServer.active)
                return;
            var s = active.FirstOrDefault(x => x.Id == msg.id);
            if (s != null)
                s.targetPitch = msg.pitch;
        }

        public static void Attach(GameObject go, int id)
        {
            var body = go.AddComponent<Rigidbody>();
            body.isKinematic = true;
            body.interpolation = RigidbodyInterpolation.Interpolate;
            var s = go.AddComponent<Seesaw>();
            s.Id = id;
            s.body = body;
        }

        private void Start()
        {
            baseRotation = transform.rotation;
            colliders = GetComponentsInChildren<Collider>();
            // Tilt axis is local x; the platform's length runs along local z.
            var bounds = new Bounds();
            bool first = true;
            foreach (var f in GetComponentsInChildren<MeshFilter>())
            {
                var b = f.sharedMesh.bounds;
                if (first)
                    bounds = b;
                else
                    bounds.Encapsulate(b);
                first = false;
            }
            if (!first)
                halfLength = Mathf.Max(0.5f, Mathf.Max(Mathf.Abs(bounds.min.z), Mathf.Abs(bounds.max.z)) * transform.lossyScale.z);
            active.Add(this);
        }

        private void OnDestroy() => active.Remove(this);

        private void FixedUpdate()
        {
            float dt = Time.fixedDeltaTime;
            if (NetworkServer.active)
            {
                Simulate(dt);
                if (Time.time >= nextSend)
                {
                    nextSend = Time.time + SendInterval;
                    NetworkServer.SendToAll(new StateMessage { id = Id, pitch = pitch }, Channels.Unreliable);
                }
            }
            else
            {
                pitch = Mathf.MoveTowards(pitch, targetPitch, MaxSpeed * 2f * dt);
            }
            body.MoveRotation(baseRotation * Quaternion.Euler(pitch, 0f, 0f));
        }

        private void Simulate(float dt)
        {
            if (Time.time >= nextPlayerScan)
            {
                nextPlayerScan = Time.time + 1f;
                players.Clear();
                players.AddRange(FindObjectsByType<PlayerMovement>(FindObjectsSortMode.None));
            }
            // Push toward every player standing on it, more the further they are from the middle (SM64 style).
            float push = 0f;
            foreach (var p in players)
            {
                if (p == null || !Physics.Raycast(p.transform.position + Vector3.up, Vector3.down, out var hit, 3f, ~0, QueryTriggerInteraction.Ignore))
                    continue;
                if (Array.IndexOf(colliders, hit.collider) < 0)
                    continue;
                push += Mathf.Clamp(transform.InverseTransformPoint(p.transform.position).z * transform.lossyScale.z / halfLength, -1f, 1f);
            }
            if (push != 0f)
            {
                float accel = push * Acceleration;
                if (speed * accel < 0f)
                    accel *= 2f; // slowing down is quicker than speeding up
                speed = Mathf.Clamp(speed + accel * dt, -MaxSpeed, MaxSpeed);
            }
            else
            {
                // Ease back to level.
                float toward = -Mathf.Sign(pitch) * ReturnAcceleration * dt;
                speed = Mathf.Abs(pitch) < 0.5f && Mathf.Abs(speed) < 1f ? 0f : Mathf.Clamp(speed + toward, -MaxSpeed, MaxSpeed) * 0.98f;
            }
            pitch = Mathf.Clamp(pitch + speed * dt, -MaxPitch, MaxPitch);
            if (Mathf.Abs(pitch) >= MaxPitch)
                speed = 0f;
        }
    }

    /// <summary>
    /// Rolls balls along a path on a fixed schedule, like SM64's rolling bowling balls. Ball positions come from the
    /// shared network clock, so every machine shows the same balls without sending anything. Each player is knocked
    /// over by the balls on their own machine, the same way the game handles traffic.
    /// </summary>
    internal class Roller : MonoBehaviour
    {
        private Vector3[] path;       // world positions
        private float[] distances;    // cumulative distance at each point
        private float speed, radius, interval, travelTime;
        private GameObject template;
        private float lift;           // from the path (on the ground) up to the ball's centre
        private readonly Dictionary<long, GameObject> balls = new Dictionary<long, GameObject>();
        private int groundLayer;

        public static void Attach(GameObject go, GameObject template, JObject extras, int id, int groundLayer)
        {
            var r = go.AddComponent<Roller>();
            r.template = template;
            r.groundLayer = groundLayer;
            float scale = go.transform.lossyScale.x;
            var raw = extras?["path"] as JArray;
            if (raw == null || raw.Count < 2)
            {
                Plugin.Log.LogWarning($"Roller '{go.name}' has no path");
                return;
            }
            // Path points are in the object's local space with glTF axes (z flipped like the vertices).
            r.path = raw.Select(p => go.transform.TransformPoint(new Vector3((float)p[0], (float)p[1], -(float)p[2]))).ToArray();
            r.distances = new float[r.path.Length];
            for (int i = 1; i < r.path.Length; i++)
                r.distances[i] = r.distances[i - 1] + Vector3.Distance(r.path[i - 1], r.path[i]);
            r.speed = ((float?)extras["speed"] ?? 750f) * scale;
            r.radius = ((float?)extras["radius"] ?? 100f) * scale;
            r.interval = Mathf.Max(0.5f, (float?)extras["interval"] ?? 3.5f);
            r.travelTime = r.distances[r.distances.Length - 1] / Mathf.Max(0.01f, r.speed);

            // Ball look: centre the template's visuals and sit the ball on the path.
            var bounds = new Bounds(template.transform.position, Vector3.zero);
            foreach (var rend in template.GetComponentsInChildren<Renderer>())
                bounds.Encapsulate(rend.bounds);
            r.lift = r.radius;
            foreach (Transform child in template.transform)
                child.position -= bounds.center - template.transform.position;
            float visualRadius = Mathf.Max(bounds.extents.x, bounds.extents.y, bounds.extents.z);
            if (visualRadius > 0.001f)
                template.transform.localScale *= r.radius / visualRadius;
            template.SetActive(false);
            Plugin.Log.LogInfo($"Roller '{go.name}': {r.path.Length} points, {r.distances[r.distances.Length - 1]:F0} m, speed {r.speed:F1} m/s, radius {r.radius:F1} m, every {r.interval:F1} s");
        }

        private void FixedUpdate()
        {
            if (path == null)
                return;
            double now = NetworkClient.active || NetworkServer.active ? NetworkTime.time : Time.timeAsDouble;
            long first = (long)Math.Floor((now - travelTime) / interval) + 1;
            long last = (long)Math.Floor(now / interval);
            // Retire balls that finished their run.
            foreach (var k in balls.Keys.Where(k => k < first || k > last).ToList())
            {
                Destroy(balls[k]);
                balls.Remove(k);
            }
            for (long k = first; k <= last; k++)
            {
                float travelled = (float)((now - k * interval) * speed);
                var (pos, dir) = Sample(travelled);
                if (!balls.TryGetValue(k, out var ball))
                    balls[k] = ball = SpawnBall(pos);
                var body = ball.GetComponent<Rigidbody>();
                var centre = pos + Vector3.up * lift;
                body.linearVelocity = dir * speed;
                body.MovePosition(centre);
                // Roll: rotate about the axis across the direction of travel.
                var axis = Vector3.Cross(Vector3.up, dir);
                if (axis.sqrMagnitude > 1e-4f)
                    body.MoveRotation(Quaternion.AngleAxis(travelled / radius * Mathf.Rad2Deg, axis.normalized));
            }
        }

        private (Vector3 pos, Vector3 dir) Sample(float s)
        {
            int i = Array.BinarySearch(distances, s);
            if (i < 0)
                i = ~i;
            i = Mathf.Clamp(i, 1, path.Length - 1);
            float seg = distances[i] - distances[i - 1];
            float t = seg > 0 ? Mathf.Clamp01((s - distances[i - 1]) / seg) : 0f;
            var dir = (path[i] - path[i - 1]).normalized;
            return (Vector3.Lerp(path[i - 1], path[i], t), dir);
        }

        private GameObject SpawnBall(Vector3 pos)
        {
            var ball = Instantiate(template, pos + Vector3.up * lift, Quaternion.identity, transform.parent);
            ball.name = "rolling ball";
            // The template sits under the roller (which may be scaled); the clone sits beside it.
            var parentScale = transform.parent.lossyScale;
            var want = template.transform.lossyScale;
            ball.transform.localScale = new Vector3(want.x / parentScale.x, want.y / parentScale.y, want.z / parentScale.z);
            ball.layer = groundLayer;
            var body = ball.AddComponent<Rigidbody>();
            body.isKinematic = true;
            body.interpolation = RigidbodyInterpolation.Interpolate;
            var sphere = ball.AddComponent<SphereCollider>();
            sphere.radius = radius / Mathf.Max(0.001f, ball.transform.lossyScale.x);
            ball.AddComponent<RollingBallHit>();
            ball.SetActive(true);
            return ball;
        }
    }

    /// <summary>Knocks over the local player when a rolling ball hits them (mirrors the game's traffic hits).</summary>
    internal class RollingBallHit : MonoBehaviour
    {
        private float cooldownUntil;

        private void OnCollisionEnter(Collision collision) => Handle(collision);

        private void OnCollisionStay(Collision collision) => Handle(collision);

        private void Handle(Collision collision)
        {
            var player = collision.collider.GetComponentInParent<PlayerMovement>();
            if (player == null)
                return;
            if (!player.isLocalPlayer)
            {
                // Other players are moved by their own machines; don't shove our copy of them.
                Physics.IgnoreCollision(GetComponent<Collider>(), collision.collider);
                return;
            }
            if (Time.time < cooldownUntil)
                return;
            cooldownUntil = Time.time + 0.75f;

            var settings = GameManager.TrafficSettings;
            var body = GetComponent<Rigidbody>();
            float t = Mathf.InverseLerp(settings.RunOverPlayerKnockoutMinRelativeSpeed, settings.RunOverPlayerKnockoutMaxRelativeSpeed, collision.relativeVelocity.magnitude);
            float horizontal = Mathf.Lerp(settings.RunOverPlayerKnockoutMinHorizontalKnockback, settings.RunOverPlayerKnockoutMaxHorizontalKnockback, t);
            float vertical = Mathf.Lerp(settings.RunOverPlayerKnockoutMinVerticalKnockback, settings.RunOverPlayerKnockoutMaxVerticalKnockback, t);
            var away = Vector3.ProjectOnPlane(player.transform.position - transform.position, Vector3.up);
            if (away.sqrMagnitude < 1e-4f)
                away = Vector3.ProjectOnPlane(body.linearVelocity, Vector3.up);
            var knockback = player.PlayerInfo.AsHittable.ApplyVehicleHitKnockbackReduction(horizontal * away.normalized + vertical * Vector3.up);
            player.TryKnockOut(null, KnockoutType.TrafficVehicle, false, player.transform.InverseTransformPoint(transform.position), 0f, knockback,
                ElectromagnetShieldHitBlockType.FullyBlocked, ItemUseId.Invalid, false, true, out _, out _);
            var playerBody = player.GetComponent<Rigidbody>();
            if (playerBody != null && !playerBody.isKinematic)
                playerBody.linearVelocity += knockback;
            player.PlayCollisionKnockoutEffectsForAllClients(player.transform.InverseTransformPoint(collision.GetContact(0).point));
        }
    }
}
