using System.Collections.Generic;
using System.Linq;
using HarmonyLib;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Builds a model-based level (map format 2) in the scene: one GameObject per material and zone, with
    /// textures, colliders and the game's surface tagging. Cuts the cup hole into the ground under the cup and
    /// turns the ground within the green radius into putting green.
    /// </summary>
    internal static class LevelBuilder
    {
        /// <summary>Half the side of the hole left open under the cup (the cup's own plate covers 2.5 m).</summary>
        private const float CupCutHalf = 1.0f;
        /// <summary>The cup plate is flat and 2.5 m wide; the apron is flat out to this half-width...</summary>
        private const float ApronFlatHalf = 1.3f;
        /// <summary>...and blends back into the level's own slope by this half-width.</summary>
        private const float ApronHalf = 3f;
        private const float ApronStep = 0.25f;
        /// <summary>Only ground this close (vertically) to the cup is cut or turned into green, so bridges above stay.</summary>
        private const float CupCutHeight = 3f;
        private const float GreenZoneHeight = 8f;
        private const int GreenZoneSides = 32;
        private static readonly Color GreenTint = new Color(0.85f, 1f, 0.75f, 1f);

        public static GameObject Build(GlbReader.Model model, Vector3 origin, Vector3 cup, float greenRadius, int groundLayer, Transform parent, float cupOpeningHalf = 0f)
        {
            // The opening the game's cup sits in: as wide as the one vanilla terrain cuts for it.
            float openingHalf = cupOpeningHalf > 0.1f ? Mathf.Min(cupOpeningHalf, CupCutHalf) : CupCutHalf;
            Plugin.Log.LogInfo($"LevelBuilder: cup opening {openingHalf * 2f:F2} m wide");
            var root = new GameObject("SbgMaps level");
            root.transform.SetParent(parent, false);
            root.transform.position = origin;
            var ctx = new Context { Model = model, GroundLayer = groundLayer };
            var localCup = cup - origin;
            var zone = new CupZone(localCup, greenRadius, openingHalf);
            // Static props the cup sits on or next to (a cannon lid, a crate) become level ground for this hole,
            // so the cup is cut through them and the apron covers them like any other ground.
            var ground = new List<GlbReader.Primitive>(model.Primitives);
            var objects = new List<GlbReader.SceneObject>();
            var props = new HashSet<GlbReader.Primitive>();
            foreach (var obj in model.Objects)
            {
                var baked = IsStaticGround(obj) ? InMapSpace(obj) : null;
                if (baked != null && baked.Any(p => TouchesCup(p, zone)))
                {
                    ground.AddRange(baked);
                    props.UnionWith(baked);
                    Plugin.Log.LogInfo($"LevelBuilder: '{obj.Name}' is at the cup, built as level ground");
                }
                else
                    objects.Add(obj);
            }
            // Already flat around the cup (a platform, a floor): only the opening is cut, and everything else stays as
            // it is. Otherwise the ground around the cup is rebuilt as a flattened apron that eases into the slope.
            bool flat = IsFlatAroundCup(model, ground, zone);
            if (flat)
                zone = new CupZone(localCup, greenRadius, openingHalf, cutHalf: openingHalf);
            Plugin.Log.LogInfo(flat ? "LevelBuilder: flat around the cup, only the opening is cut" : "LevelBuilder: sloped around the cup, building an apron");
            BuildParts(ctx, root.transform, ground, "level", zone);
            if (!flat)
                BuildCupApron(ctx, root.transform, ground, zone, props);

            int seesaws = 0, rollers = 0, movers = 0, chomps = 0;
            foreach (var obj in objects)
            {
                try
                {
                    BuildObject(ctx, root, obj, groundLayer, ref seesaws, ref rollers, ref movers, ref chomps);
                }
                catch (System.Exception e)
                {
                    // One broken object must not stop the hole from building.
                    Plugin.Log.LogError($"LevelBuilder: skipped object '{obj.Name}': {e}");
                }
            }
            Plugin.Log.LogInfo($"LevelBuilder: {model.Objects.Count} objects ({seesaws} see-saws, {rollers} rollers, {movers} movers, {chomps} chomps)");
            root.AddComponent<SlideController>();
            Physics.SyncTransforms();
            return root;
        }

        private static bool IsStaticGround(GlbReader.SceneObject obj) =>
            ((string)obj.Extras?["object"] ?? "static") == "static" && !((bool?)obj.Extras?["billboard"] ?? false) && !((bool?)obj.Extras?["knocks"] ?? false);

        /// <summary>The object's parts with its position, rotation and scale applied (map coordinates).</summary>
        private static List<GlbReader.Primitive> InMapSpace(GlbReader.SceneObject obj)
        {
            var pos = new Vector3(obj.Position[0], obj.Position[1], obj.Position[2]);
            var rot = new Quaternion(obj.Rotation[0], obj.Rotation[1], obj.Rotation[2], obj.Rotation[3]);
            var scale = new Vector3(obj.Scale[0], obj.Scale[1], obj.Scale[2]);
            bool mirrored = scale.x * scale.y * scale.z < 0f;
            var result = new List<GlbReader.Primitive>();
            foreach (var p in obj.Primitives)
            {
                var q = new GlbReader.Primitive { Material = p.Material, Uvs = p.Uvs, Positions = new float[p.Positions.Length], Indices = (int[])p.Indices.Clone() };
                for (int i = 0; i < p.Positions.Length; i += 3)
                {
                    var v = pos + rot * Vector3.Scale(scale, new Vector3(p.Positions[i], p.Positions[i + 1], p.Positions[i + 2]));
                    (q.Positions[i], q.Positions[i + 1], q.Positions[i + 2]) = (v.x, v.y, v.z);
                }
                if (p.Normals != null)
                {
                    q.Normals = new float[p.Normals.Length];
                    for (int i = 0; i < p.Normals.Length; i += 3)
                    {
                        var n = (rot * new Vector3(p.Normals[i] / scale.x, p.Normals[i + 1] / scale.y, p.Normals[i + 2] / scale.z)).normalized;
                        (q.Normals[i], q.Normals[i + 1], q.Normals[i + 2]) = (n.x, n.y, n.z);
                    }
                }
                if (mirrored)
                    for (int t = 0; t < q.Indices.Length; t += 3)
                        (q.Indices[t + 1], q.Indices[t + 2]) = (q.Indices[t + 2], q.Indices[t + 1]);
                result.Add(q);
            }
            return result;
        }

        /// <summary>Does any triangle's bounding box reach into the apron square near cup height?</summary>
        private static bool TouchesCup(GlbReader.Primitive p, CupZone zone)
        {
            var c = zone.Cup;
            for (int t = 0; t < p.Indices.Length; t += 3)
            {
                Vector3 min = Vector3.positiveInfinity, max = Vector3.negativeInfinity;
                for (int k = 0; k < 3; k++)
                {
                    int i = p.Indices[t + k] * 3;
                    var v = new Vector3(p.Positions[i], p.Positions[i + 1], p.Positions[i + 2]);
                    min = Vector3.Min(min, v);
                    max = Vector3.Max(max, v);
                }
                if (min.x <= c.x + ApronHalf && max.x >= c.x - ApronHalf && min.z <= c.z + ApronHalf && max.z >= c.z - ApronHalf
                    && min.y <= c.y + CupCutHeight && max.y >= c.y - CupCutHeight)
                    return true;
            }
            return false;
        }

        private static void BuildObject(Context ctx, GameObject root, GlbReader.SceneObject obj, int groundLayer, ref int seesaws, ref int rollers, ref int movers, ref int chomps)
        {
            {
                var go = new GameObject(obj.Name);
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = new Vector3(obj.Position[0], obj.Position[1], obj.Position[2]);
                go.transform.localRotation = new Quaternion(obj.Rotation[0], obj.Rotation[1], obj.Rotation[2], obj.Rotation[3]);
                go.transform.localScale = new Vector3(obj.Scale[0], obj.Scale[1], obj.Scale[2]);
                string behaviour = (string)obj.Extras?["object"] ?? "static";
                bool billboard = (bool?)obj.Extras?["billboard"] ?? false;
                switch (behaviour)
                {
                    case "seesaw":
                        BuildParts(ctx, go.transform, obj.Primitives, obj.Name, null);
                        Seesaw.Attach(go, seesaws++);
                        break;
                    case "roller":
                        // The parts are the ball's look; the roller clones it for every ball it rolls.
                        var template = new GameObject("ball template");
                        template.transform.SetParent(go.transform, false);
                        BuildParts(ctx, template.transform, obj.Primitives, obj.Name, null, forceSurface: "none");
                        Roller.Attach(go, template, obj.Extras, rollers++, groundLayer);
                        break;
                    case "mover":
                        var platform = new GameObject("platform template");
                        platform.transform.SetParent(go.transform, false);
                        BuildParts(ctx, platform.transform, obj.Primitives, obj.Name, null);
                        Mover.Attach(go, platform, obj.Extras, groundLayer);
                        movers++;
                        break;
                    case "chomp":
                        var look = new GameObject("chomp look");
                        look.transform.SetParent(go.transform, false);
                        BuildParts(ctx, look.transform, obj.Primitives, obj.Name, null, forceSurface: "none");
                        Chomp.Attach(go, look, obj.Extras, chomps++, groundLayer);
                        break;
                    case "jumppad":
                        BuildParts(ctx, go.transform, obj.Primitives, obj.Name, null);
                        MapJumpPad.Attach(go, obj.Extras);
                        break;
                    case "outofbounds":
                        BuildParts(ctx, go.transform, obj.Primitives, obj.Name, null, forceSurface: "none");
                        MapOutOfBoundsZone.Attach(go);
                        break;
                    default:
                        if (billboard && obj.Extras?["hitbox"] is Newtonsoft.Json.Linq.JObject hitbox)
                        {
                            // A picture that turns to the camera (an SM64 tree): its look must not collide (each player
                            // sees it turned differently), so it gets the game object's own cylinder hitbox instead.
                            BuildParts(ctx, go.transform, obj.Primitives, obj.Name, null, forceSurface: "none");
                            float radius = (float?)hitbox["radius"] ?? 80f, height = (float?)hitbox["height"] ?? 400f;
                            var trunk = go.AddComponent<CapsuleCollider>();
                            trunk.radius = radius;
                            trunk.height = Mathf.Max(height, radius * 2f);
                            trunk.center = new Vector3(0f, height / 2f, 0f);
                            go.layer = groundLayer;
                            break;
                        }
                        BuildParts(ctx, go.transform, obj.Primitives, obj.Name, null);
                        if ((bool?)obj.Extras?["knocks"] ?? false)
                        {
                            Movers.EnsureCollider(go, groundLayer);
                            go.AddComponent<KnockbackOnTouch>();
                        }
                        break;
                }
                if (billboard)
                    foreach (var r in go.GetComponentsInChildren<MeshRenderer>(true))
                        if (r.GetComponent<Billboard>() == null)
                            r.gameObject.AddComponent<Billboard>();
            }
        }

        private class Context
        {
            public GlbReader.Model Model;
            public int GroundLayer;
            public readonly Dictionary<int, Material> Materials = new Dictionary<int, Material>();
            public readonly Dictionary<int, Material> GreenMaterials = new Dictionary<int, Material>();
        }

        /// <summary>Where the cup is cut out and the green drawn, in the parts' local space.</summary>
        private class CupZone
        {
            public readonly Vector3 Cup;
            public readonly float OpeningHalf;
            public readonly List<Edge> Cut;
            public readonly List<Edge> Green;

            /// <summary>Half the width of the square cut out of the level around the cup.</summary>
            public readonly float CutHalf;

            public CupZone(Vector3 cup, float greenRadius, float openingHalf, float cutHalf = ApronHalf)
            {
                Cup = cup;
                OpeningHalf = openingHalf;
                CutHalf = cutHalf;
                Cut = Square(cup.x, cup.z, cutHalf);
                Green = Circle(cup.x, cup.z, greenRadius, GreenZoneSides);
            }
        }

        private static void BuildParts(Context ctx, Transform parent, List<GlbReader.Primitive> prims, string label, CupZone zone, string forceSurface = null)
        {
            var model = ctx.Model;
            int index = 0;
            foreach (var prim in prims)
            {
                var mat = prim.Material >= 0 && prim.Material < model.Materials.Count ? model.Materials[prim.Material] : null;
                bool renderOnly = mat?.RenderOnly ?? false;
                bool invisible = mat?.Invisible ?? false;
                string surface = forceSurface ?? (renderOnly ? "none" : mat?.Surface ?? "rough");
                if (!Surfaces.ContainsKey(surface))
                    surface = "rough";
                // Collision gets a green surface near the cup; render-only ground gets the green look instead.
                string greenSurface = renderOnly ? null : GreenFor(surface);

                var main = new MeshData();
                var green = new MeshData();
                for (int t = 0; t < prim.Indices.Length; t += 3)
                {
                    var tri = new List<Vertex> { Vertex.From(prim, prim.Indices[t]), Vertex.From(prim, prim.Indices[t + 1]), Vertex.From(prim, prim.Indices[t + 2]) };
                    var pieces = new List<List<Vertex>> { tri };
                    if (zone != null)
                    {
                        // Ground around the cup is replaced by a flattened apron (BuildCupApron).
                        if ((surface != "none" || renderOnly) && FacesUp(tri) && NearHeight(tri, zone.Cup.y, CupCutHeight))
                            pieces = SubtractAll(pieces, zone.Cut, out _);
                        bool greenLook = renderOnly && FacesUp(tri);
                        if ((greenSurface != null || greenLook) && NearHeight(tri, zone.Cup.y, GreenZoneHeight))
                        {
                            pieces = SubtractAll(pieces, zone.Green, out var inside);
                            foreach (var p in inside)
                                green.AddPolygon(p);
                        }
                    }
                    foreach (var p in pieces)
                        main.AddPolygon(p);
                }

                string name = $"{label} {index++:D3} {mat?.Name ?? "unnamed"} [{surface}]";
                if (main.Count > 0)
                    CreatePart(parent, name, main, invisible ? null : MaterialFor(ctx.Materials, model, prim.Material, false, main), surface, ctx.GroundLayer, mat?.Climbable ?? false);
                if (green.Count > 0)
                    CreatePart(parent, name + " green", green, invisible ? null : MaterialFor(ctx.GreenMaterials, model, prim.Material, true, green),
                        greenSurface ?? "none", ctx.GroundLayer, mat?.Climbable ?? false);
            }
        }

        /// <summary>
        /// Fills the square cut around the cup with a fine grid: flat where the cup's plate sits, blending back into the
        /// level's original slope at the edge, like vanilla greens. Samples the original ground for heights, UVs and
        /// materials, so textures continue seamlessly. Visual and collision meshes each get their own apron.
        /// </summary>
        private static void BuildCupApron(Context ctx, Transform parent, List<GlbReader.Primitive> prims, CupZone zone, HashSet<GlbReader.Primitive> props)
        {
            var model = ctx.Model;
            GlbReader.Material MatOf(GlbReader.Primitive p) => p.Material >= 0 && p.Material < model.Materials.Count ? model.Materials[p.Material] : null;
            // Invisible and drawn-only together is an effect that is never there at all, not a collision mesh.
            bool hasCollisionMesh = model.Materials.Any(m => m.Invisible && !m.RenderOnly);

            // Visual ground: drawn triangles. Collision ground: the invisible mesh, or the drawn one if there is none.
            // Solid opaque ground first, then drawn-only, then cut-out, then see-through layers.
            int Rank(int index)
            {
                var m = index >= 0 && index < model.Materials.Count ? model.Materials[index] : null;
                if (m == null)
                    return 0;
                return (m.AlphaBlend || m.Additive ? 3 : m.AlphaMask ? 2 : 0) + (m.RenderOnly ? 1 : 0);
            }
            var visual = new Sampler(prims.Where(p => !(MatOf(p)?.Invisible ?? false) && ((MatOf(p)?.RenderOnly ?? false) || Surfaces.ContainsKey(MatOf(p)?.Surface ?? "rough") && (MatOf(p)?.Surface ?? "rough") != "none")), zone, Rank);
            // Props built into the ground at the cup have no separate collision mesh: their drawn mesh is their collision.
            var collision = hasCollisionMesh ? new Sampler(prims.Where(p => (MatOf(p)?.Invisible ?? false) || props.Contains(p) && !(MatOf(p)?.RenderOnly ?? false)), zone, Rank) : visual;

            BuildApronMesh(ctx, parent, zone, visual, drawn: true, collides: !hasCollisionMesh);
            if (hasCollisionMesh)
                BuildApronMesh(ctx, parent, zone, collision, drawn: false, collides: true);
        }

        /// <summary>
        /// Is the drawn ground within the apron square level with the cup and unbroken? Then the cup needs no apron.
        /// </summary>
        private static bool IsFlatAroundCup(GlbReader.Model model, List<GlbReader.Primitive> prims, CupZone zone)
        {
            var sampler = VisualSampler(model, prims, zone);
            const float step = 0.5f, tolerance = 0.12f;
            for (float dx = -ApronHalf; dx <= ApronHalf + 0.01f; dx += step)
                for (float dz = -ApronHalf; dz <= ApronHalf + 0.01f; dz += step)
                {
                    var hit = sampler.Sample(zone.Cup.x + dx, zone.Cup.z + dz);
                    if (hit == null || Mathf.Abs(hit.Value.Vertex.Pos.y - zone.Cup.y) > tolerance || hit.Value.Vertex.Normal.y < 0.97f)
                        return false;
                }
            return true;
        }

        /// <summary>Drawn ground near the cup, where stacked layers prefer solid opaque ground (see Sampler).</summary>
        private static Sampler VisualSampler(GlbReader.Model model, IEnumerable<GlbReader.Primitive> prims, CupZone zone)
        {
            GlbReader.Material MatOf(GlbReader.Primitive p) => p.Material >= 0 && p.Material < model.Materials.Count ? model.Materials[p.Material] : null;
            int Rank(int index)
            {
                var m = index >= 0 && index < model.Materials.Count ? model.Materials[index] : null;
                if (m == null)
                    return 0;
                return (m.AlphaBlend || m.Additive ? 3 : m.AlphaMask ? 2 : 0) + (m.RenderOnly ? 1 : 0);
            }
            return new Sampler(prims.Where(p => !(MatOf(p)?.Invisible ?? false) && ((MatOf(p)?.RenderOnly ?? false) || Surfaces.ContainsKey(MatOf(p)?.Surface ?? "rough") && (MatOf(p)?.Surface ?? "rough") != "none")), zone, Rank);
        }

        private static void BuildApronMesh(Context ctx, Transform parent, CupZone zone, Sampler sampler, bool drawn, bool collides)
        {
            int n = Mathf.RoundToInt(ApronHalf * 2 / ApronStep);
            var grid = new Sampler.Hit?[n + 1, n + 1];
            var cup = zone.Cup;
            for (int i = 0; i <= n; i++)
                for (int j = 0; j <= n; j++)
                {
                    float dx = -ApronHalf + i * ApronStep, dz = -ApronHalf + j * ApronStep;
                    var hit = sampler.Sample(cup.x + dx, cup.z + dz);
                    if (hit == null)
                        continue;
                    var h = hit.Value;
                    // Flat at cup height under the plate, easing back to the original ground at the edge.
                    float d = Mathf.Max(Mathf.Abs(dx), Mathf.Abs(dz));
                    float t = Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(ApronFlatHalf, ApronHalf, d));
                    h.Vertex.Pos = new Vector3(cup.x + dx, Mathf.Lerp(cup.y, h.Vertex.Pos.y, t), cup.z + dz);
                    h.Vertex.Normal = Vector3.Slerp(Vector3.up, h.Vertex.Normal, t);
                    grid[i, j] = h;
                }

            // The flat plate around the hole is always solid, even over a gap in the ground (a pit under a lid).
            Sampler.Hit? any = null;
            foreach (var h in grid)
                if (h != null) { any = h; break; }
            if (any != null)
                for (int i = 0; i <= n; i++)
                    for (int j = 0; j <= n; j++)
                    {
                        float dx = -ApronHalf + i * ApronStep, dz = -ApronHalf + j * ApronStep;
                        if (grid[i, j] != null || Mathf.Max(Mathf.Abs(dx), Mathf.Abs(dz)) > ApronFlatHalf)
                            continue;
                        var h = any.Value;
                        h.Vertex.Pos = new Vector3(cup.x + dx, cup.y, cup.z + dz);
                        h.Vertex.Normal = Vector3.up;
                        grid[i, j] = h;
                    }

            // One mesh per source material, so textures stay right.
            var byMaterial = new Dictionary<int, MeshData>();
            for (int i = 0; i < n; i++)
                for (int j = 0; j < n; j++)
                {
                    float cx = -ApronHalf + (i + 0.5f) * ApronStep, cz = -ApronHalf + (j + 0.5f) * ApronStep;
                    if (Mathf.Abs(cx) < zone.OpeningHalf && Mathf.Abs(cz) < zone.OpeningHalf)
                        continue; // the hole itself
                    var a = grid[i, j];
                    var b = grid[i + 1, j];
                    var c = grid[i + 1, j + 1];
                    var d = grid[i, j + 1];
                    if (a == null || b == null || c == null || d == null)
                        continue;
                    int material = a.Value.Material;
                    if (!byMaterial.TryGetValue(material, out var mesh))
                        byMaterial[material] = mesh = new MeshData();
                    // Clockwise seen from above (a, d, c, b) faces up in Unity.
                    mesh.AddPolygon(new List<Vertex> { a.Value.Vertex, d.Value.Vertex, c.Value.Vertex, b.Value.Vertex });
                }

            foreach (var kv in byMaterial)
            {
                var src = kv.Key >= 0 && kv.Key < ctx.Model.Materials.Count ? ctx.Model.Materials[kv.Key] : null;
                // Golf ground turns green around the cup; anything else (stone, a roof, a road) keeps its look and surface.
                string own = src?.Surface ?? "rough";
                string green = GreenFor(own);
                string surface = green ?? (Surfaces.ContainsKey(own) && own != "none" ? own : "green");
                var material = drawn ? MaterialFor(green != null ? ctx.GreenMaterials : ctx.Materials, ctx.Model, kv.Key, green != null, kv.Value) : null;
                CreatePart(parent, $"cup apron {(drawn ? "visual" : "collision")} {src?.Name}", kv.Value, material, collides ? surface : "none", ctx.GroundLayer);
            }
        }

        /// <summary>Finds the ground triangle under a point near the cup and interpolates its vertex.</summary>
        private class Sampler
        {
            public struct Hit
            {
                public Vertex Vertex;
                public int Material;
            }

            private readonly List<(Vertex a, Vertex b, Vertex c, int material)> tris = new List<(Vertex, Vertex, Vertex, int)>();
            private readonly float cupY;
            private readonly System.Func<int, int> rank;
            /// <summary>Surfaces this close in height count as one spot (ground plus decals or blend layers on it).</summary>
            private const float LayerGap = 0.08f;

            /// <param name="rank">Which material wins where layers are stacked: lower is preferred.</param>
            public Sampler(IEnumerable<GlbReader.Primitive> prims, CupZone zone, System.Func<int, int> rank)
            {
                cupY = zone.Cup.y;
                this.rank = rank;
                float reach = ApronHalf + 0.5f;
                foreach (var p in prims)
                    for (int t = 0; t < p.Indices.Length; t += 3)
                    {
                        var a = Vertex.From(p, p.Indices[t]);
                        var b = Vertex.From(p, p.Indices[t + 1]);
                        var c = Vertex.From(p, p.Indices[t + 2]);
                        float minX = Mathf.Min(a.Pos.x, Mathf.Min(b.Pos.x, c.Pos.x)), maxX = Mathf.Max(a.Pos.x, Mathf.Max(b.Pos.x, c.Pos.x));
                        float minZ = Mathf.Min(a.Pos.z, Mathf.Min(b.Pos.z, c.Pos.z)), maxZ = Mathf.Max(a.Pos.z, Mathf.Max(b.Pos.z, c.Pos.z));
                        if (maxX < zone.Cup.x - reach || minX > zone.Cup.x + reach || maxZ < zone.Cup.z - reach || minZ > zone.Cup.z + reach)
                            continue;
                        if (!NearHeight(new List<Vertex> { a, b, c }, cupY, CupCutHeight + 1f) || !FacesUp(new List<Vertex> { a, b, c }))
                            continue;
                        tris.Add((a, b, c, p.Material));
                    }
            }

            public Hit? Sample(float x, float z)
            {
                Hit? best = null;
                float bestDy = float.MaxValue;
                int bestRank = int.MaxValue;
                foreach (var (a, b, c, material) in tris)
                {
                    // Barycentric coordinates in XZ.
                    float d = (b.Pos.z - c.Pos.z) * (a.Pos.x - c.Pos.x) + (c.Pos.x - b.Pos.x) * (a.Pos.z - c.Pos.z);
                    if (Mathf.Abs(d) < 1e-8f)
                        continue;
                    float u = ((b.Pos.z - c.Pos.z) * (x - c.Pos.x) + (c.Pos.x - b.Pos.x) * (z - c.Pos.z)) / d;
                    float v = ((c.Pos.z - a.Pos.z) * (x - c.Pos.x) + (a.Pos.x - c.Pos.x) * (z - c.Pos.z)) / d;
                    float w = 1f - u - v;
                    const float eps = -1e-4f;
                    if (u < eps || v < eps || w < eps)
                        continue;
                    var vert = new Vertex
                    {
                        Pos = a.Pos * u + b.Pos * v + c.Pos * w,
                        Normal = (a.Normal * u + b.Normal * v + c.Normal * w).normalized,
                        Uv = a.Uv * u + b.Uv * v + c.Uv * w,
                        Color = a.Color * u + b.Color * v + c.Color * w,
                    };
                    // Prefer the ground closest to the cup's height (not a bridge above or a cave below).
                    // Where layers lie on top of each other (decals, blend layers), take the plain ground, so the
                    // apron is one material instead of a patchwork of whichever layer happened to be on top.
                    float dy = Mathf.Abs(vert.Pos.y - cupY);
                    int r = rank(material);
                    bool sameSpot = Mathf.Abs(dy - bestDy) <= LayerGap;
                    if (sameSpot ? r < bestRank : dy < bestDy)
                    {
                        bestDy = dy;
                        bestRank = r;
                        best = new Hit { Vertex = vert, Material = material };
                    }
                }
                return best;
            }
        }

        private static bool FacesUp(List<Vertex> tri)
        {
            var n = Vector3.Cross(tri[1].Pos - tri[0].Pos, tri[2].Pos - tri[0].Pos);
            return n.sqrMagnitude > 0 && n.normalized.y > 0.5f;
        }

        /// <summary>Map surface ids and the game layer each plays as. Null: collider only (no golf surface).</summary>
        private static readonly Dictionary<string, TerrainLayer?> Surfaces = new Dictionary<string, TerrainLayer?>
        {
            ["rough"] = TerrainLayer.Rough,
            ["fairway"] = TerrainLayer.Fairway,
            ["green"] = TerrainLayer.Green,
            ["sand"] = TerrainLayer.Sand,
            ["path"] = TerrainLayer.DirtPath,
            ["snow-fairway"] = TerrainLayer.SnowFairway,
            ["snow-rough"] = TerrainLayer.SnowRough,
            ["snow-green"] = TerrainLayer.SnowGreen,
            ["ice"] = TerrainLayer.Ice,
            ["desert-sand"] = TerrainLayer.DesertSand,
            ["dry-fairway"] = TerrainLayer.DryFairway,
            ["dry-green"] = TerrainLayer.DryGreen,
            ["sand-rough"] = TerrainLayer.SandRough,
            ["road"] = TerrainLayer.Road,
            ["sidewalk"] = TerrainLayer.Sidewalk,
            ["bridge"] = TerrainLayer.WoodenBridge,
            ["building"] = TerrainLayer.Building,
            ["slide"] = TerrainLayer.Ice, // slippery, plus a downhill pull on players (SlideController)
            ["oob"] = TerrainLayer.OutOfBounds,
            ["solid"] = null,
            ["none"] = null,
        };

        /// <summary>What a surface turns into inside the green zone around the cup, or null if it stays as it is.</summary>
        private static string GreenFor(string surface) => surface switch
        {
            "rough" or "fairway" or "green" or "sand" or "path" or "road" or "sidewalk" => "green",
            "snow-fairway" or "snow-rough" or "snow-green" or "ice" => "snow-green",
            "desert-sand" or "dry-fairway" or "dry-green" or "sand-rough" => "dry-green",
            _ => null,
        };

        private static void CreatePart(Transform parent, string name, MeshData data, Material material, string surface, int groundLayer, bool climbable = false)
        {
            var go = new GameObject(name);
            // TerrainAddition reads its layer in Awake, so fill everything in while inactive.
            go.SetActive(false);
            go.layer = groundLayer;
            go.transform.SetParent(parent, false);
            var mesh = data.ToMesh(name);
            // A null material means collision only (an invisible collision mesh).
            if (material != null)
            {
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                go.AddComponent<MeshRenderer>().sharedMaterial = material;
            }
            if (surface != "none")
            {
                var collider = go.AddComponent<MeshCollider>();
                collider.sharedMesh = mesh;
                if (surface == "slide")
                    SlideController.Register(collider);
                if (climbable)
                    Climb.Register(collider);
            }
            var layer = Surfaces[surface];
            if (layer.HasValue)
            {
                var addition = go.AddComponent<TerrainAddition>();
                Traverse.Create(addition).Field("terrainLayer").SetValue(layer.Value);
            }
            go.SetActive(true);
        }

        private const string VertexColorShader = "Universal Render Pipeline/Particles/Lit";
        private static Shader vertexColorShader;
        private static bool vertexColorShaderLooked;

        /// <summary>
        /// The material for a part. Parts with vertex colours (baked shading, layers that fade out) need a shader that
        /// uses them; the game's lit particle shader does. Without it, a fading layer would be a solid copy over the
        /// ground under it, so it is not drawn (returns null: collision only).
        /// </summary>
        private static Material MaterialFor(Dictionary<int, Material> cache, GlbReader.Model model, int index, bool greenZone, MeshData mesh)
        {
            if (!mesh.HasColors)
                return MaterialFor(cache, model, index, greenZone);
            if (!vertexColorShaderLooked)
            {
                vertexColorShaderLooked = true;
                vertexColorShader = Shader.Find(VertexColorShader);
                Plugin.Log.LogInfo($"LevelBuilder: vertex colours {(vertexColorShader != null ? "drawn with " + VertexColorShader : "not supported (shader missing); fading layers are hidden")}");
            }
            if (vertexColorShader == null)
                return mesh.HasVertexAlpha ? null : MaterialFor(cache, model, index, greenZone);
            int key = -1000 - (index + 1) * 2 - (mesh.HasVertexAlpha ? 1 : 0);
            if (cache.TryGetValue(key, out var cached))
                return cached;
            var mat = MaterialFor(new Dictionary<int, Material>(), model, index, greenZone, vertexColorShader);
            if (mesh.HasVertexAlpha)
                MakeTransparent(mat, additive: false);
            cache[key] = mat;
            return mat;
        }

        private static void MakeTransparent(Material mat, bool additive)
        {
            mat.SetFloat("_Surface", 1f);
            // URP blend modes: 0 alpha, 2 additive.
            mat.SetFloat("_Blend", additive ? 2f : 0f);
            mat.SetOverrideTag("RenderType", "Transparent");
            mat.SetFloat("_SrcBlend", (float)(additive ? UnityEngine.Rendering.BlendMode.One : UnityEngine.Rendering.BlendMode.SrcAlpha));
            mat.SetFloat("_DstBlend", (float)(additive ? UnityEngine.Rendering.BlendMode.One : UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha));
            mat.SetFloat("_ZWrite", 0f);
            mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
        }

        private static Material MaterialFor(Dictionary<int, Material> cache, GlbReader.Model model, int index, bool greenZone, Shader shaderOverride = null)
        {
            if (cache.TryGetValue(index, out var cached))
                return cached;
            var src = index >= 0 && index < model.Materials.Count ? model.Materials[index] : null;
            var shader = shaderOverride ?? Shader.Find("Universal Render Pipeline/Lit");
            var mat = new Material(shader) { name = src?.Name ?? "sbgmaps" };
            var color = src != null ? new Color(src.BaseColor[0], src.BaseColor[1], src.BaseColor[2], src.BaseColor[3]) : Color.white;
            if (greenZone)
                color *= GreenTint;
            mat.SetColor("_BaseColor", color);
            mat.SetFloat("_Smoothness", src != null ? Mathf.Clamp01(1f - src.Roughness) : 0f);
            mat.SetFloat("_Metallic", src != null ? Mathf.Clamp01(src.Metallic) : 0f);
            if (src?.Image != null)
            {
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, mipChain: true);
                if (ImageConversion.LoadImage(tex, src.Image))
                {
                    tex.wrapModeU = WrapMode(src.WrapS);
                    tex.wrapModeV = WrapMode(src.WrapT);
                    tex.filterMode = FilterMode.Bilinear;
                    tex.anisoLevel = 4;
                    mat.SetTexture("_BaseMap", tex);
                }
            }
            if (src == null || src.DoubleSided)
                mat.SetFloat("_Cull", 0f);
            if (src != null && src.AlphaMask)
            {
                // Cut-out textures (tree leaves, fences): URP alpha clipping.
                mat.SetFloat("_AlphaClip", 1f);
                mat.SetFloat("_Cutoff", Mathf.Clamp01(src.AlphaCutoff));
                mat.EnableKeyword("_ALPHATEST_ON");
                mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.AlphaTest;
            }
            else if (src != null && (src.AlphaBlend || src.Additive))
                MakeTransparent(mat, src.Additive);
            cache[index] = mat;
            return mat;
        }

        private static TextureWrapMode WrapMode(int gl) => gl switch
        {
            33071 => TextureWrapMode.Clamp,
            33648 => TextureWrapMode.Mirror,
            _ => TextureWrapMode.Repeat,
        };

        // ---------- geometry ----------

        private struct Vertex
        {
            public Vector3 Pos;
            public Vector3 Normal;
            public Vector2 Uv;
            public Color Color;

            public static Vertex From(GlbReader.Primitive p, int i) => new Vertex
            {
                Pos = new Vector3(p.Positions[i * 3], p.Positions[i * 3 + 1], p.Positions[i * 3 + 2]),
                Normal = p.Normals != null ? new Vector3(p.Normals[i * 3], p.Normals[i * 3 + 1], p.Normals[i * 3 + 2]) : Vector3.up,
                Uv = p.Uvs != null ? new Vector2(p.Uvs[i * 2], p.Uvs[i * 2 + 1]) : Vector2.zero,
                Color = p.Colors != null ? new Color(p.Colors[i * 4], p.Colors[i * 4 + 1], p.Colors[i * 4 + 2], p.Colors[i * 4 + 3]) : Color.white,
            };

            public static Vertex Lerp(Vertex a, Vertex b, float t) => new Vertex
            {
                Pos = Vector3.Lerp(a.Pos, b.Pos, t),
                Normal = Vector3.Lerp(a.Normal, b.Normal, t).normalized,
                Uv = Vector2.Lerp(a.Uv, b.Uv, t),
                Color = Color.Lerp(a.Color, b.Color, t),
            };
        }

        private class MeshData
        {
            private readonly List<Vector3> positions = new List<Vector3>();
            private readonly List<Vector3> normals = new List<Vector3>();
            private readonly List<Vector2> uvs = new List<Vector2>();
            private readonly List<Color> colors = new List<Color>();
            private readonly List<int> indices = new List<int>();

            public int Count => indices.Count;
            /// <summary>Any vertex colour other than solid white (shading or see-through parts).</summary>
            public bool HasColors { get; private set; }
            public bool HasVertexAlpha { get; private set; }

            /// <summary>Adds a convex polygon (in winding order) as a triangle fan.</summary>
            public void AddPolygon(List<Vertex> poly)
            {
                if (poly.Count < 3)
                    return;
                int start = positions.Count;
                foreach (var v in poly)
                {
                    positions.Add(v.Pos);
                    normals.Add(v.Normal);
                    uvs.Add(v.Uv);
                    colors.Add(v.Color);
                    HasColors |= v.Color.r < 0.99f || v.Color.g < 0.99f || v.Color.b < 0.99f || v.Color.a < 0.99f;
                    HasVertexAlpha |= v.Color.a < 0.99f;
                }
                for (int i = 1; i + 1 < poly.Count; i++)
                {
                    indices.Add(start);
                    indices.Add(start + i);
                    indices.Add(start + i + 1);
                }
            }

            public Mesh ToMesh(string name)
            {
                var mesh = new Mesh { name = name };
                if (positions.Count > 65535)
                    mesh.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
                mesh.SetVertices(positions);
                mesh.SetNormals(normals);
                mesh.SetUVs(0, uvs);
                if (HasColors)
                    mesh.SetColors(colors);
                mesh.SetTriangles(indices, 0);
                mesh.RecalculateBounds();
                return mesh;
            }
        }

        private static bool NearHeight(List<Vertex> tri, float y, float range)
        {
            float min = float.MaxValue, max = float.MinValue;
            foreach (var v in tri)
            {
                min = Mathf.Min(min, v.Pos.y);
                max = Mathf.Max(max, v.Pos.y);
            }
            return max >= y - range && min <= y + range;
        }

        /// <summary>A half-plane in XZ: points with a*x + b*z + c &lt;= 0 are inside.</summary>
        private struct Edge
        {
            public float A, B, C;
            public float Eval(Vector3 p) => A * p.x + B * p.z + C;
        }

        /// <summary>Edges of a convex polygon given counter-clockwise in XZ (seen from above, +z forward).</summary>
        private static List<Edge> ConvexEdges(List<Vector2> pts)
        {
            var edges = new List<Edge>();
            for (int i = 0; i < pts.Count; i++)
            {
                var p = pts[i];
                var q = pts[(i + 1) % pts.Count];
                // Inside is to the left of p->q when going counter-clockwise.
                float a = q.y - p.y, b = -(q.x - p.x);
                edges.Add(new Edge { A = a, B = b, C = -(a * p.x + b * p.y) });
            }
            return edges;
        }

        private static List<Edge> Square(float cx, float cz, float h) => ConvexEdges(new List<Vector2>
        {
            new Vector2(cx - h, cz - h), new Vector2(cx + h, cz - h), new Vector2(cx + h, cz + h), new Vector2(cx - h, cz + h),
        });

        private static List<Edge> Circle(float cx, float cz, float r, int sides)
        {
            var pts = new List<Vector2>();
            // Circumscribe so the polygon covers the whole circle.
            float R = r / Mathf.Cos(Mathf.PI / sides);
            for (int i = 0; i < sides; i++)
            {
                float a = i * 2f * Mathf.PI / sides;
                pts.Add(new Vector2(cx + R * Mathf.Cos(a), cz + R * Mathf.Sin(a)));
            }
            return ConvexEdges(pts);
        }

        /// <summary>
        /// Subtracts a convex region from every polygon. Returns the pieces outside the region; the pieces inside
        /// come back through <paramref name="inside"/>. All pieces stay convex.
        /// </summary>
        private static List<List<Vertex>> SubtractAll(List<List<Vertex>> polys, List<Edge> region, out List<List<Vertex>> inside)
        {
            var outside = new List<List<Vertex>>();
            inside = new List<List<Vertex>>();
            foreach (var poly in polys)
            {
                var rest = poly;
                foreach (var edge in region)
                {
                    Split(rest, edge, out var keep, out var cut);
                    if (cut.Count >= 3)
                        outside.Add(cut);
                    rest = keep;
                    if (rest.Count < 3)
                        break;
                }
                if (rest.Count >= 3)
                    inside.Add(rest);
            }
            return outside;
        }

        /// <summary>Splits a convex polygon by a half-plane into the inside part and the outside part.</summary>
        private static void Split(List<Vertex> poly, Edge edge, out List<Vertex> inside, out List<Vertex> outside)
        {
            inside = new List<Vertex>();
            outside = new List<Vertex>();
            for (int i = 0; i < poly.Count; i++)
            {
                var a = poly[i];
                var b = poly[(i + 1) % poly.Count];
                float da = edge.Eval(a.Pos), db = edge.Eval(b.Pos);
                if (da <= 0)
                    inside.Add(a);
                else
                    outside.Add(a);
                if ((da < 0 && db > 0) || (da > 0 && db < 0))
                {
                    var v = Vertex.Lerp(a, b, da / (da - db));
                    inside.Add(v);
                    outside.Add(v);
                }
            }
        }
    }
}
