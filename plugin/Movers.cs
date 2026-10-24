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
                body.MovePosition(pos + Vector3.up * lift);
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
            ball.AddComponent<KnockbackOnTouch>();
            ball.SetActive(true);
            return ball;
        }
    }

    /// <summary>Knocks over the local player when this (a rolling ball, a chomp) hits them, the way the game handles traffic.</summary>
    internal class KnockbackOnTouch : MonoBehaviour
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
                away = Vector3.ProjectOnPlane(-collision.relativeVelocity, Vector3.up);
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

namespace SbgMaps
{
    internal static class Movers
    {
        /// <summary>Gives a visual-only object (a picture, a decoration) a simple solid shape, so it can hit players.</summary>
        public static void EnsureCollider(GameObject go, int layer)
        {
            if (go.GetComponentInChildren<Collider>() != null)
                return;
            var renderers = go.GetComponentsInChildren<Renderer>();
            if (renderers.Length == 0)
                return;
            var bounds = renderers[0].bounds;
            foreach (var r in renderers)
                bounds.Encapsulate(r.bounds);
            var box = go.AddComponent<BoxCollider>();
            var scale = go.transform.lossyScale;
            box.center = go.transform.InverseTransformPoint(bounds.center);
            // Pictures are flat; give them some depth so they can't be walked through.
            var size = new Vector3(bounds.size.x / scale.x, bounds.size.y / scale.y, bounds.size.z / scale.z);
            float depth = Mathf.Max(size.x, size.z) * 0.3f;
            box.size = new Vector3(Mathf.Max(size.x, depth), size.y, Mathf.Max(size.z, depth));
            go.layer = layer;
        }
    }

    /// <summary>Turns an object's look to face the camera around the vertical axis (for pictures).</summary>
    internal class Billboard : MonoBehaviour
    {
        private void LateUpdate()
        {
            var cam = Camera.main;
            if (cam == null)
                return;
            var to = Vector3.ProjectOnPlane(cam.transform.position - transform.position, Vector3.up);
            if (to.sqrMagnitude > 1e-4f)
                transform.rotation = Quaternion.LookRotation(-to.normalized, Vector3.up);
        }
    }

    /// <summary>
    /// Platforms that ride a path, looping or back and forth, like SM64's checkerboard elevators. Positions come
    /// from the shared network clock so every machine agrees; their velocity is set so players ride along.
    /// </summary>
    internal class Mover : MonoBehaviour
    {
        private Vector3[] path;      // the object's local space
        private float[] distances;
        private float length, speed;
        private bool loop;
        private readonly List<Rigidbody> platforms = new List<Rigidbody>();

        public static void Attach(GameObject go, GameObject template, JObject extras, int groundLayer)
        {
            var raw = extras?["path"] as JArray;
            if (raw == null || raw.Count < 2)
            {
                Plugin.Log.LogWarning($"Mover '{go.name}' has no path");
                return;
            }
            var m = go.AddComponent<Mover>();
            // Path points are in the object's local space with glTF axes (z flipped like the vertices).
            m.path = raw.Select(p => new Vector3((float)p[0], (float)p[1], -(float)p[2])).ToArray();
            m.loop = (bool?)extras["loop"] ?? false;
            if (m.loop)
                m.path = m.path.Append(m.path[0]).ToArray();
            m.distances = new float[m.path.Length];
            for (int i = 1; i < m.path.Length; i++)
                m.distances[i] = m.distances[i - 1] + Vector3.Distance(m.path[i - 1], m.path[i]);
            m.length = m.distances[m.distances.Length - 1];
            m.speed = (float?)extras["speed"] ?? 300f;
            int count = Mathf.Clamp((int?)extras["count"] ?? 1, 1, 16);
            bool knocks = (bool?)extras["knocks"] ?? false;
            if (knocks)
                Movers.EnsureCollider(template, groundLayer);
            // Copy the template first, then give every copy its own physics body (a copy made after adding one
            // would already carry it).
            var copies = new List<GameObject> { template };
            for (int i = 1; i < count; i++)
                copies.Add(Instantiate(template, go.transform));
            for (int i = 0; i < copies.Count; i++)
            {
                var platform = copies[i];
                platform.name = $"platform {i}";
                var body = platform.GetComponent<Rigidbody>() ?? platform.AddComponent<Rigidbody>();
                body.isKinematic = true;
                body.interpolation = RigidbodyInterpolation.Interpolate;
                if (knocks && platform.GetComponent<KnockbackOnTouch>() == null)
                    platform.AddComponent<KnockbackOnTouch>();
                m.platforms.Add(body);
            }
            Plugin.Log.LogInfo($"Mover '{go.name}': {count} platform(s), path {m.length * go.transform.lossyScale.x:F1} m, {(m.loop ? "loop" : "back and forth")}");
        }

        private void FixedUpdate()
        {
            if (path == null)
                return;
            double now = NetworkClient.active || NetworkServer.active ? NetworkTime.time : Time.timeAsDouble;
            for (int i = 0; i < platforms.Count; i++)
            {
                double s = now * speed + i * (double)length / platforms.Count;
                float along;
                if (loop)
                    along = (float)(s % length);
                else
                {
                    // Back and forth.
                    double phase = s % (2 * length);
                    along = (float)(phase < length ? phase : 2 * length - phase);
                }
                // Kinematic: MovePosition gives the platform a velocity for whatever touches it.
                platforms[i].MovePosition(transform.TransformPoint(Sample(along)));
            }
        }

        private Vector3 Sample(float s)
        {
            int i = Array.BinarySearch(distances, s);
            if (i < 0)
                i = ~i;
            i = Mathf.Clamp(i, 1, path.Length - 1);
            float seg = distances[i] - distances[i - 1];
            return Vector3.Lerp(path[i - 1], path[i], seg > 0 ? Mathf.Clamp01((s - distances[i - 1]) / seg) : 0f);
        }
    }

    /// <summary>
    /// A chain chomp tied to its post: hops around, then lunges. The lunge schedule and direction come from the
    /// shared network clock, so everyone sees the same chomp. Touching it knocks players over.
    /// </summary>
    internal class Chomp : MonoBehaviour
    {
        private const float Cycle = 5f;
        private const int ChainLinks = 5;

        private Transform look;
        private Rigidbody body;
        private readonly List<Transform> links = new List<Transform>();
        private float radius, reach, idleReach, lungeSpeed;
        private float halfHeight = 80f;
        private int id;

        public static void Attach(GameObject go, GameObject look, JObject extras, int id, int groundLayer)
        {
            var c = go.AddComponent<Chomp>();
            c.id = id;
            c.radius = (float?)extras?["radius"] ?? 80f;
            c.reach = (float?)extras?["reach"] ?? 900f;
            c.idleReach = (float?)extras?["idleReach"] ?? 450f;
            c.lungeSpeed = (float?)extras?["lungeSpeed"] ?? 3000f;

            // The moving part: the chomp's look plus a solid sphere that knocks players over.
            var mover = new GameObject("chomp");
            mover.layer = groundLayer;
            mover.transform.SetParent(go.transform, false);
            // Centre the look on the moving part, and size things from the model itself.
            var bounds = new Bounds(look.transform.position, Vector3.zero);
            bool any = false;
            foreach (var r in look.GetComponentsInChildren<Renderer>())
            {
                if (!any)
                    bounds = r.bounds;
                else
                    bounds.Encapsulate(r.bounds);
                any = true;
            }
            look.transform.SetParent(mover.transform, true);
            look.transform.position -= bounds.center - go.transform.position;
            float unit = Mathf.Max(0.0001f, go.transform.lossyScale.y);
            c.halfHeight = bounds.extents.y / unit;
            c.look = mover.transform;
            c.body = mover.AddComponent<Rigidbody>();
            c.body.isKinematic = true;
            c.body.interpolation = RigidbodyInterpolation.Interpolate;
            var sphere = mover.AddComponent<SphereCollider>();
            sphere.radius = Mathf.Max(bounds.extents.x, bounds.extents.z) / unit * 0.85f;
            c.radius = sphere.radius;
            mover.AddComponent<KnockbackOnTouch>();

            // Chain: dark iron balls from the post to the chomp.
            var iron = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            iron.SetColor("_BaseColor", new Color(0.15f, 0.15f, 0.17f));
            iron.SetFloat("_Metallic", 0.8f);
            iron.SetFloat("_Smoothness", 0.6f);
            for (int i = 0; i < ChainLinks; i++)
            {
                var link = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                Destroy(link.GetComponent<Collider>());
                link.name = $"chain {i}";
                link.transform.SetParent(go.transform, false);
                link.transform.localScale = Vector3.one * c.radius * 0.45f;
                link.GetComponent<MeshRenderer>().sharedMaterial = iron;
                c.links.Add(link.transform);
            }
        }

        private void FixedUpdate()
        {
            if (look == null)
                return;
            double now = NetworkClient.active || NetworkServer.active ? NetworkTime.time : Time.timeAsDouble;
            now += id * 1.7;
            long cycle = (long)Math.Floor(now / Cycle);
            float t = (float)(now - cycle * Cycle);
            float idleAngle = (float)(now * 0.9);
            // Lunge direction from a hash of the cycle number, identical on every machine.
            uint h = (uint)(cycle * 2654435761L ^ (id * 40503L));
            float lungeAngle = (h % 3600) / 10f * Mathf.Deg2Rad;

            Vector3 Flat(float angle, float dist) => new Vector3(Mathf.Cos(angle) * dist, 0f, Mathf.Sin(angle) * dist);
            var idle = Flat(idleAngle, idleReach * 0.6f);
            float lungeTime = reach / lungeSpeed;
            Vector3 local;
            float hop;
            if (t < 3.2f)
            {
                local = idle;
                hop = Mathf.Abs(Mathf.Sin(t * Mathf.PI * 2.2f)) * radius * 0.6f; // little hops
            }
            else if (t < 3.6f)
            {
                local = Vector3.Lerp(idle, Flat(lungeAngle + Mathf.PI, idleReach * 0.3f), Mathf.SmoothStep(0, 1, (t - 3.2f) / 0.4f)); // wind up
                hop = 0f;
            }
            else if (t < 3.6f + lungeTime)
            {
                local = Vector3.Lerp(Flat(lungeAngle + Mathf.PI, idleReach * 0.3f), Flat(lungeAngle, reach), (t - 3.6f) / lungeTime); // lunge
                hop = radius * 0.3f;
            }
            else if (t < 4.1f + lungeTime)
            {
                local = Flat(lungeAngle, reach);
                hop = 0f;
            }
            else
            {
                float back = Mathf.SmoothStep(0, 1, (t - 4.1f - lungeTime) / (Cycle - 4.1f - lungeTime));
                local = Vector3.Lerp(Flat(lungeAngle, reach), Flat(idleAngle, idleReach * 0.6f), back);
                hop = 0f;
            }
            // Stand on the ground (the model's own half height), plus the hop.
            local.y = halfHeight + hop;

            var world = transform.TransformPoint(local);
            body.MovePosition(world);
            var heading = Vector3.ProjectOnPlane(world - transform.position, Vector3.up);
            // Face away from the post, the way it is pulling. Models face local -z here (SM64's +z, mirrored).
            if (heading.sqrMagnitude > 0.01f)
                body.MoveRotation(Quaternion.LookRotation(-heading.normalized));

            // Chain sags between the post top and the chomp.
            var postTop = transform.TransformPoint(new Vector3(0f, halfHeight * 0.75f, 0f));
            for (int i = 0; i < links.Count; i++)
            {
                float f = (i + 1f) / (links.Count + 1f);
                var p = Vector3.Lerp(postTop, world, f);
                p.y -= Mathf.Sin(f * Mathf.PI) * radius * transform.lossyScale.y * 0.4f;
                links[i].position = p;
            }
        }
    }

    /// <summary>
    /// Makes Slide ground slippery and hard to climb for the local player: pulls them downhill and bleeds off
    /// uphill speed, scaled by steepness. The ground stays solid, so nothing falls through.
    /// </summary>
    [DefaultExecutionOrder(10000)]
    internal class SlideController : MonoBehaviour
    {
        private static readonly HashSet<Collider> slideColliders = new HashSet<Collider>();

        public static void Register(Collider c) => slideColliders.Add(c);

        private void OnDestroy() => slideColliders.RemoveWhere(c => c == null);

        private void FixedUpdate()
        {
            var player = GameManager.LocalPlayerMovement;
            if (player == null || slideColliders.Count == 0)
                return;
            if (!Physics.Raycast(player.transform.position + Vector3.up * 0.4f, Vector3.down, out var hit, 1.2f, ~0, QueryTriggerInteraction.Ignore))
                return;
            if (!slideColliders.Contains(hit.collider))
                return;
            float slope = Vector3.Angle(hit.normal, Vector3.up);
            if (slope < 3f)
                return;
            var body = player.GetComponent<Rigidbody>();
            if (body == null || body.isKinematic)
                return;
            var downhill = Vector3.ProjectOnPlane(Vector3.down, hit.normal).normalized;
            var v = body.linearVelocity;
            float uphill = Vector3.Dot(v, -downhill);
            if (uphill > 0f)
                v += downhill * uphill * 0.12f; // climbing loses speed
            v += downhill * (Physics.gravity.magnitude * 1.2f * Mathf.Sin(slope * Mathf.Deg2Rad) * Time.fixedDeltaTime);
            body.linearVelocity = v;
        }
    }
}
