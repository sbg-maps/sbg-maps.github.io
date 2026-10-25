using System.Collections;
using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using Mirror;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.Splines;

namespace SbgMaps
{
    /// <summary>
    /// Turns a loaded vanilla donor hole into a custom hole: re-sculpts and repaints the donor terrain from the
    /// map's grids and moves the donor's networked objects (tees, cup, item boxes, checkpoint) onto the map's markers.
    /// Runs from sceneLoaded, before Mirror spawns scene objects and before the managers' Start, on every machine.
    /// </summary>
    internal static class MapBuilder
    {
        public const string DonorScene = "Twin Beach";
        /// <summary>The donor terrain is 1000 m square; leave room for the beach around the map.</summary>
        public const float MaxMapSize = 900f;
        private const float SeaFloorHeight = 1f;
        private const float BeachWidth = 25f;
        private const float DefaultGreenRadius = 15f;

        // Root objects the hole needs to keep working. Everything else in the donor is decoration.
        private static readonly HashSet<string> KeepRoots = new HashSet<string>
        {
            "Manager container", "Main Camera", "Gameplay screenspace UI", "EventSystem", "Directional Light",
            "Item spawners", "Course item spawner", "Regular main hole", "Checkpoint", "Ocean", "Overview camera track", "Screenshot camera",
        };

        public static void Build(Scene scene, MapPack pack, int holeIndex)
        {
            var def = pack.Manifest.holes[holeIndex];
            Plugin.Log.LogInfo($"MapBuilder: building '{pack.Manifest.name}' hole {holeIndex + 1} '{def.name}' in '{scene.name}'");
            var grids = pack.LoadGrids(holeIndex);
            var model = pack.LoadModel();

            // The donor's own surfaces tell us which physics layer the ball treats as ground.
            var donorSurface = Object.FindObjectsByType<TerrainAddition>(FindObjectsInactive.Include, FindObjectsSortMode.None).FirstOrDefault();
            int groundLayer = donorSurface ? donorSurface.gameObject.layer : 8;

            Terrain terrain = null;
            foreach (var root in scene.GetRootGameObjects())
            {
                if (KeepRoots.Contains(root.name) || root.name.StartsWith("Teeing platform"))
                    continue;
                if (root.TryGetComponent<Terrain>(out var t))
                {
                    terrain = t;
                    continue;
                }
                if (root.GetComponentInChildren<NetworkIdentity>(true) != null)
                {
                    Plugin.Log.LogWarning($"MapBuilder: keeping unknown networked root '{root.name}'");
                    continue;
                }
                root.SetActive(false);
            }
            if (terrain == null)
            {
                Plugin.Log.LogError("MapBuilder: donor scene has no terrain");
                return;
            }

            // Centre the map on the donor terrain.
            var tSize = terrain.terrainData.size;
            var origin = new Vector2(terrain.transform.position.x + (tSize.x - def.size[0]) / 2f, terrain.transform.position.z + (tSize.z - def.size[1]) / 2f);
            var area = new Rect(origin, def.Size);
            int groundMask = 1 << groundLayer;

            // Ground height at a map point: the heightmap, else the level model below `fromY`, else the water.
            float GroundY(float x, float z, float fromY = 2000f)
            {
                if (grids != null)
                    return grids.HeightAt(x, z);
                if (Physics.Raycast(new Vector3(origin.x + x, fromY + 5f, origin.y + z), Vector3.down, out var hit, fromY + 1000f, groundMask, QueryTriggerInteraction.Ignore))
                    return hit.point.y;
                return def.water;
            }
            Vector3 WorldOf(PointDef p) => new Vector3(origin.x + p.x, p.y ?? GroundY(p.x, p.z), origin.y + p.z);

            var cup = Object.FindObjectsByType<GolfHole>(FindObjectsInactive.Include, FindObjectsSortMode.None).FirstOrDefault(h => h.IsMainHole);
            var builder = new TerrainBuilder(terrain);
            // Copy the cutout vanilla made for its own cup before the cup moves, then stamp it under ours.
            bool[,] cupCutout = cup != null ? builder.ReadHoles(cup.transform.position, 3f) : null;
            // Model holes cut an opening of the same size into the level, so the cup fills it with no gap around it.
            float opening = cupCutout != null ? builder.OpeningHalf(cupCutout) : 0f;
            if (grids == null)
                cupCutout = null;

            builder.SculptAll(SeaFloorHeight);
            if (model != null)
            {
                var parent = new GameObject("SbgMaps map");
                SceneManager.MoveGameObjectToScene(parent, scene);
                // The cup cut and green zone need the cup height; the editor always saves it for model maps.
                float cupY = def.cup.y ?? def.water;
                LevelBuilder.Build(model, new Vector3(origin.x, 0f, origin.y), new Vector3(origin.x + def.cup.x, cupY, origin.y + def.cup.z),
                    def.greenRadius, groundLayer, parent.transform, opening);
                Plugin.Log.LogInfo($"MapBuilder: built level model with {model.Primitives.Count} parts");
            }
            var cupPos = WorldOf(def.cup);

            if (grids != null)
            {
                builder.Sculpt(area, BeachWidth, (wx, wz) => grids.HeightAt(wx - origin.x, wz - origin.y), SeaFloorHeight);
                builder.Paint(area, BeachWidth, (wx, wz) =>
                {
                    if (!area.Contains(new Vector2(wx, wz)))
                        return TerrainLayer.Sand;
                    // The shot preview uses the terrain paint right around the cup, so it is always green there.
                    if ((new Vector2(wx, wz) - new Vector2(cupPos.x, cupPos.z)).sqrMagnitude < 9f)
                        return TerrainLayer.Green;
                    return grids.SurfaceAt(wx - origin.x, wz - origin.y).ToTerrainLayer();
                });
                if (cupCutout != null)
                    builder.StampHoles(cupPos, cupCutout);
            }
            else
            {
                // Model maps: the terrain is only sea floor, but the shot preview still reads its paint at the cup.
                builder.Paint(new Rect(cupPos.x, cupPos.z, 0f, 0f), 4f, (wx, wz) => TerrainLayer.Green);
            }

            if (cup != null)
            {
                cup.transform.position = cupPos;
                LiftCupPlate(cup);
            }

            var teePos = new Vector3(origin.x + def.tee.x, def.tee.y ?? GroundY(def.tee.x, def.tee.z), origin.y + def.tee.z);
            var toCup = Vector3.ProjectOnPlane(cupPos - teePos, Vector3.up);
            var facing = def.tee.yaw.HasValue ? Quaternion.Euler(0f, def.tee.yaw.Value, 0f) : Quaternion.LookRotation(toCup);
            var tees = Object.FindObjectsByType<GolfTeeingPlatform>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            if (tees.Length > 0)
            {
                // Keep the donor's own arrangement of its platforms (side by side, stair variants behind), turned to
                // face our way. Overlapping them makes their surfaces flicker against each other.
                var donorCentre = Vector3.zero;
                foreach (var t in tees)
                    donorCentre += t.transform.position;
                donorCentre /= tees.Length;
                var donorRotation = Quaternion.Euler(0f, tees[0].transform.eulerAngles.y, 0f);
                foreach (var t in tees)
                {
                    var rel = Quaternion.Inverse(donorRotation) * (t.transform.position - donorCentre);
                    var p = teePos + facing * new Vector3(rel.x, 0f, rel.z);
                    var bounds = PlatformBounds(t);
                    // Sit on the highest ground under the platform, so slopes never poke through its surface.
                    float y = teePos.y;
                    float hx = Mathf.Max(1f, bounds.extents.x), hz = Mathf.Max(1f, bounds.extents.z);
                    foreach (var corner in new[] { Vector3.zero, new Vector3(hx, 0, hz), new Vector3(-hx, 0, hz), new Vector3(hx, 0, -hz), new Vector3(-hx, 0, -hz) })
                    {
                        var c = p + facing * corner;
                        float g = GroundY(c.x - origin.x, c.z - origin.y, teePos.y + 3f);
                        if (g <= teePos.y + 3f)
                            y = Mathf.Max(y, g);
                    }
                    t.transform.SetPositionAndRotation(new Vector3(p.x, y, p.z), facing);
                }
            }

            var spawners = Object.FindObjectsByType<ItemSpawner>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            // Regular boxes first, then the red ones (copies of a regular box with the red item pool and colour).
            var boxPoints = def.itemBoxes.Concat(def.redItemBoxes ?? new List<PointDef>()).ToList();
            var boxes = WithCopies(spawners, boxPoints.Count, 1);
            PlaceOrRemove(boxes, boxPoints, WorldOf, "item boxes");
            for (int i = def.itemBoxes.Count; i < boxPoints.Count && i < boxes.Length; i++)
                RedItemBoxes.MakeRed(boxes[i]);
            var checkpoints = WithCopies(Object.FindObjectsByType<Checkpoint>(FindObjectsInactive.Include, FindObjectsSortMode.None), def.checkpoints.Count, 2);
            // Players keep the furthest checkpoint they touched: the map lists them from start to flag.
            for (int i = 0; i < checkpoints.Length; i++)
                Traverse.Create(checkpoints[i]).Field("order").SetValue(i);
            PlaceOrRemove(checkpoints, def.checkpoints, WorldOf, "checkpoints");

            var ocean = Object.FindFirstObjectByType<MainOutOfBoundsHazard>(FindObjectsInactive.Include);
            if (ocean != null)
            {
                var p = ocean.transform.position;
                ocean.transform.position = new Vector3(p.x, def.water, p.z);
            }

            var levelBounds = SetBounds(def, origin, cupPos, teePos);
            RebuildBoundsWall(levelBounds, (x, z) => GroundY(x - origin.x, z - origin.y));
            SetOverviewCamera(teePos, cupPos);
            ForceTerrainDataRegeneration();

            Plugin.Log.LogInfo($"MapBuilder: done (tee {teePos}, cup {cupPos}, {def.itemBoxes.Count} item boxes, water {def.water})");
        }

        /// <summary>How far above its collider the cup's grass plate is drawn.</summary>
        private const float CupPlateLift = 0.03f;

        /// <summary>
        /// The game's cup brings a grass plate around the hole. Vanilla ground lies a little below it; ours is exactly
        /// level with it, so the two flicker. The plate is drawn a few centimetres higher by a copy of its look on a
        /// child; its collider stays where it is, so the ball rolls on the same surface as before.
        /// </summary>
        private static void LiftCupPlate(GolfHole cup)
        {
            var filter = cup.GetComponent<MeshFilter>();
            var renderer = cup.GetComponent<MeshRenderer>();
            if (filter == null || renderer == null || !renderer.enabled || cup.transform.Find("SbgMaps plate look") != null)
                return;
            var look = new GameObject("SbgMaps plate look");
            look.layer = cup.gameObject.layer;
            look.transform.SetParent(cup.transform, false);
            look.transform.position = cup.transform.position + Vector3.up * CupPlateLift;
            look.AddComponent<MeshFilter>().sharedMesh = filter.sharedMesh;
            var copy = look.AddComponent<MeshRenderer>();
            copy.sharedMaterials = renderer.sharedMaterials;
            copy.shadowCastingMode = renderer.shadowCastingMode;
            copy.receiveShadows = renderer.receiveShadows;
            renderer.enabled = false;
        }

        private static Bounds PlatformBounds(Component platform)
        {
            var rot = platform.transform.rotation;
            platform.transform.rotation = Quaternion.identity;
            var b = new Bounds(platform.transform.position, Vector3.zero);
            foreach (var r in platform.GetComponentsInChildren<Renderer>(true))
                b.Encapsulate(r.bounds);
            platform.transform.rotation = rot;
            return b;
        }

        /// <summary>Most item boxes or checkpoints a hole can have.</summary>
        public const int MaxCopies = 64;

        /// <summary>
        /// The donor's networked objects of a kind, in the same order on every machine, plus copies when the map wants
        /// more than the donor has. Mirror pairs scene objects between host and players by scene id, so each copy gets
        /// an id derived from the donor's (same scene hash, a fixed pattern for the rest) that every machine computes alike.
        /// </summary>
        private static T[] WithCopies<T>(T[] found, int wanted, int kind) where T : Component
        {
            var objects = found.OrderBy(o => o.GetComponent<NetworkIdentity>()?.sceneId ?? 0UL).ToList();
            if (objects.Count == 0)
                return objects.ToArray();
            var template = objects[0];
            var templateId = template.GetComponent<NetworkIdentity>();
            wanted = Mathf.Min(wanted, MaxCopies);
            for (int i = objects.Count; i < wanted; i++)
            {
                var copy = Object.Instantiate(template.gameObject, template.transform.parent);
                copy.name = $"{template.name} (SbgMaps {i + 1})";
                if (templateId != null && copy.TryGetComponent<NetworkIdentity>(out var id))
                    id.sceneId = (templateId.sceneId & 0xFFFFFFFF00000000UL) | (0x5B6D0000UL + (ulong)(kind << 12) + (ulong)i);
                objects.Add(copy.GetComponent<T>());
            }
            return objects.ToArray();
        }

        /// <summary>
        /// Moves donor objects onto the map's points. Spare ones are removed on the host once Mirror has spawned them,
        /// which also removes them for clients. There are enough of them (see WithCopies) up to MaxCopies.
        /// </summary>
        private static void PlaceOrRemove<T>(T[] objects, List<PointDef> points, System.Func<PointDef, Vector3> worldOf, string what) where T : Component
        {
            if (points.Count > objects.Length)
                Plugin.Log.LogWarning($"MapBuilder: map has {points.Count} {what}, at most {objects.Length} are used");
            var spare = new List<GameObject>();
            for (int i = 0; i < objects.Length; i++)
            {
                if (i < points.Count)
                    objects[i].transform.position = worldOf(points[i]);
                else
                {
                    // Park it out of the way until the host can remove it.
                    objects[i].transform.position = new Vector3(0f, -1000f, 0f);
                    spare.Add(objects[i].gameObject);
                }
            }
            if (spare.Count > 0)
                Plugin.Instance.StartCoroutine(DestroyWhenSpawned(spare));
        }

        private static IEnumerator DestroyWhenSpawned(List<GameObject> objects)
        {
            // Wait until the server has spawned the scene objects (netId assigned).
            float timeout = Time.realtimeSinceStartup + 30f;
            while (Time.realtimeSinceStartup < timeout)
            {
                if (!NetworkServer.active)
                    yield break; // clients get the destroy from the host
                if (objects.All(o => o == null || (o.TryGetComponent<NetworkIdentity>(out var id) && id.netId != 0)))
                    break;
                yield return null;
            }
            foreach (var o in objects)
                if (o != null && NetworkServer.active)
                    NetworkServer.Destroy(o);
        }

        /// <summary>Points the game's level, green and return-path splines at this hole. Returns the level bounds (world XZ).</summary>
        private static List<Vector2> SetBounds(HoleDef def, Vector2 origin, Vector3 cupPos, Vector3 teePos)
        {
            IEnumerable<Vector2> Local(List<float[]> pts) => pts.Select(p => new Vector2(origin.x + p[0], origin.y + p[1]));

            var level = (def.bounds != null && def.bounds.Count >= 3
                ? Local(def.bounds)
                : new[] { origin, origin + new Vector2(def.size[0], 0f), origin + def.Size, origin + new Vector2(0f, def.size[1]) }).ToList();
            var manager = Object.FindFirstObjectByType<BoundsManager>();
            if (manager == null)
            {
                Plugin.Log.LogWarning("MapBuilder: no BoundsManager");
                return level;
            }
            var t = Traverse.Create(manager);
            ReplaceSpline(t.Field("levelBounds").GetValue<SplineContainer>(), level, closed: true);

            var green = def.green != null && def.green.Count >= 3
                ? Local(def.green)
                : Enumerable.Range(0, 24).Select(i => new Vector2(cupPos.x, cupPos.z) + DefaultGreenRadius * new Vector2(Mathf.Cos(i * Mathf.PI / 12f), Mathf.Sin(i * Mathf.PI / 12f)));
            ReplaceSpline(t.Field("greenBounds").GetValue<SplineContainer>(), green, closed: true);

            var ret = def.returnPath != null && def.returnPath.Count >= 2
                ? Local(def.returnPath)
                : new[] { new Vector2(teePos.x, teePos.z), new Vector2(cupPos.x, cupPos.z) };
            ReplaceSpline(t.Field("returnSplines").GetValue<SplineContainer>(), ret, closed: false);
            return level;
        }

        private const float WallStep = 2f;

        /// <summary>
        /// The see-through wall players meet at the edge of the level is a mesh made for the donor hole's bounds.
        /// Replace it with one along this hole's bounds, standing on the ground, as tall as the donor's.
        /// </summary>
        private static void RebuildBoundsWall(List<Vector2> world, System.Func<float, float, float> groundAt)
        {
            var wall = Object.FindFirstObjectByType<LevelBoundsWall>(FindObjectsInactive.Include);
            var renderer = wall != null ? Traverse.Create(wall).Field("renderer").GetValue<MeshRenderer>() : null;
            var filter = renderer != null ? renderer.GetComponent<MeshFilter>() : null;
            if (filter == null || world.Count < 3)
            {
                Plugin.Log.LogWarning("MapBuilder: no level bounds wall to move");
                return;
            }
            float height = filter.sharedMesh != null ? Mathf.Clamp(filter.sharedMesh.bounds.size.y * filter.transform.lossyScale.y, 5f, 60f) : 10f;
            var tr = filter.transform;
            var verts = new List<Vector3>();
            var uvs = new List<Vector2>();
            var tris = new List<int>();
            float along = 0f;
            for (int e = 0; e < world.Count; e++)
            {
                Vector2 a = world[e], b = world[(e + 1) % world.Count];
                float len = Vector2.Distance(a, b);
                int steps = Mathf.Max(1, Mathf.CeilToInt(len / WallStep));
                int first = verts.Count;
                for (int s = 0; s <= steps; s++)
                {
                    var p = Vector2.Lerp(a, b, s / (float)steps);
                    // A little below the ground, so slopes between samples do not leave a gap under the wall.
                    float y = groundAt(p.x, p.y) - 1f;
                    float u = (along + len * s / steps) / height;
                    verts.Add(tr.InverseTransformPoint(new Vector3(p.x, y, p.y)));
                    verts.Add(tr.InverseTransformPoint(new Vector3(p.x, y + height + 1f, p.y)));
                    uvs.Add(new Vector2(u, 0f));
                    uvs.Add(new Vector2(u, 1f));
                }
                for (int s = 0; s < steps; s++)
                {
                    int i = first + s * 2;
                    // Both sides, so it shows from inside and outside.
                    tris.AddRange(new[] { i, i + 1, i + 2, i + 2, i + 1, i + 3 });
                    tris.AddRange(new[] { i, i + 2, i + 1, i + 2, i + 3, i + 1 });
                }
                along += len;
            }
            var mesh = new Mesh { name = "SbgMaps level bounds wall", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            mesh.SetVertices(verts);
            mesh.SetUVs(0, uvs);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            filter.sharedMesh = mesh;
            if (renderer.TryGetComponent<MeshCollider>(out var collider))
                collider.sharedMesh = mesh;
            Plugin.Log.LogInfo($"MapBuilder: level bounds wall rebuilt ({along:F0} m around, {height:F0} m tall)");
        }

        /// <summary>Replaces a container's splines with one straight-edged spline through the given world XZ points.</summary>
        private static void ReplaceSpline(SplineContainer container, IEnumerable<Vector2> worldPoints, bool closed)
        {
            if (container == null)
                return;
            float y = container.transform.position.y;
            var knots = worldPoints.Select(p => new BezierKnot((float3)container.transform.InverseTransformPoint(new Vector3(p.x, y, p.y)))).ToList();
            var splines = container.Splines;
            for (int i = 0; i < splines.Count; i++)
                splines[i].Clear();
            if (splines.Count == 0)
                container.AddSpline();
            var spline = container.Splines[0];
            foreach (var k in knots)
                spline.Add(k, TangentMode.Linear);
            spline.Closed = closed;
        }

        /// <summary>The hole intro flies from start to end; point it down the hole from behind the cup to the tee.</summary>
        private static void SetOverviewCamera(Vector3 teePos, Vector3 cupPos)
        {
            var track = GameObject.Find("Overview camera track");
            if (track == null)
                return;
            var start = track.transform.Find("Overview camera start");
            var end = track.transform.Find("Overview camera end");
            if (start == null || end == null)
                return;
            var dir = Vector3.ProjectOnPlane(cupPos - teePos, Vector3.up).normalized;
            start.position = cupPos + dir * 20f + Vector3.up * 30f;
            start.rotation = Quaternion.LookRotation(teePos - start.position);
            end.position = teePos - dir * 25f + Vector3.up * 20f;
            end.rotation = Quaternion.LookRotation(cupPos - end.position);
        }

        /// <summary>
        /// The shot preview reads baked terrain data stored in the scene. Disposing it makes TerrainManager.Start
        /// regenerate from the live terrain.
        /// </summary>
        private static void ForceTerrainDataRegeneration()
        {
            var manager = Object.FindFirstObjectByType<TerrainManager>();
            if (manager == null)
            {
                Plugin.Log.LogWarning("MapBuilder: no TerrainManager found");
                return;
            }
            var t = Traverse.Create(manager);
            foreach (var field in new[] { "allTerrainLayerWeights", "allTerrainHeights", "allTerrainHeightOverrides" })
            {
                var array = t.Field(field).GetValue<Unity.Collections.NativeArray<float>>();
                if (array.IsCreated)
                    array.Dispose();
                t.Field(field).SetValue(default(Unity.Collections.NativeArray<float>));
            }
            var overrides = t.Field("allTerrainOverrides").GetValue<Unity.Collections.NativeArray<int>>();
            if (overrides.IsCreated)
                overrides.Dispose();
            t.Field("allTerrainOverrides").SetValue(default(Unity.Collections.NativeArray<int>));
        }
    }
}
