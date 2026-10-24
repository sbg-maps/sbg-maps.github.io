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

        public static GameObject Build(GlbReader.Model model, Vector3 origin, Vector3 cup, float greenRadius, int groundLayer, Transform parent)
        {
            var root = new GameObject("SbgMaps level");
            root.transform.SetParent(parent, false);
            root.transform.position = origin;
            var ctx = new Context { Model = model, GroundLayer = groundLayer };
            var localCup = cup - origin;
            var zone = new CupZone(localCup, greenRadius);
            BuildParts(ctx, root.transform, model.Primitives, "level", zone);
            BuildCupApron(ctx, root.transform, model.Primitives, zone);

            int seesaws = 0, rollers = 0, movers = 0, chomps = 0;
            foreach (var obj in model.Objects)
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
                    default:
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
            Plugin.Log.LogInfo($"LevelBuilder: {model.Objects.Count} objects ({seesaws} see-saws, {rollers} rollers, {movers} movers, {chomps} chomps)");
            root.AddComponent<SlideController>();
            Physics.SyncTransforms();
            return root;
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
            public readonly List<Edge> Cut;
            public readonly List<Edge> Green;

            public CupZone(Vector3 cup, float greenRadius)
            {
                Cup = cup;
                Cut = Square(cup.x, cup.z, ApronHalf);
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
                    CreatePart(parent, name, main, invisible ? null : MaterialFor(ctx.Materials, model, prim.Material, false), surface, ctx.GroundLayer);
                if (green.Count > 0)
                    CreatePart(parent, name + " green", green, invisible ? null : MaterialFor(ctx.GreenMaterials, model, prim.Material, true),
                        greenSurface ?? "none", ctx.GroundLayer);
            }
        }

        /// <summary>
        /// Fills the square cut around the cup with a fine grid: flat where the cup's plate sits, blending back into the
        /// level's original slope at the edge, like vanilla greens. Samples the original ground for heights, UVs and
        /// materials, so textures continue seamlessly. Visual and collision meshes each get their own apron.
        /// </summary>
        private static void BuildCupApron(Context ctx, Transform parent, List<GlbReader.Primitive> prims, CupZone zone)
        {
            var model = ctx.Model;
            GlbReader.Material MatOf(GlbReader.Primitive p) => p.Material >= 0 && p.Material < model.Materials.Count ? model.Materials[p.Material] : null;
            bool hasCollisionMesh = model.Materials.Any(m => m.Invisible);

            // Visual ground: drawn triangles. Collision ground: the invisible mesh, or the drawn one if there is none.
            var visual = new Sampler(prims.Where(p => !(MatOf(p)?.Invisible ?? false) && ((MatOf(p)?.RenderOnly ?? false) || Surfaces.ContainsKey(MatOf(p)?.Surface ?? "rough") && (MatOf(p)?.Surface ?? "rough") != "none")), zone);
            var collision = hasCollisionMesh ? new Sampler(prims.Where(p => MatOf(p)?.Invisible ?? false), zone) : visual;

            BuildApronMesh(ctx, parent, zone, visual, drawn: true, collides: !hasCollisionMesh);
            if (hasCollisionMesh)
                BuildApronMesh(ctx, parent, zone, collision, drawn: false, collides: true);
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

            // One mesh per source material, so textures stay right.
            var byMaterial = new Dictionary<int, MeshData>();
            for (int i = 0; i < n; i++)
                for (int j = 0; j < n; j++)
                {
                    float cx = -ApronHalf + (i + 0.5f) * ApronStep, cz = -ApronHalf + (j + 0.5f) * ApronStep;
                    if (Mathf.Abs(cx) < CupCutHalf && Mathf.Abs(cz) < CupCutHalf)
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
                string surface = GreenFor(src?.Surface ?? "rough") ?? "green";
                var material = drawn ? MaterialFor(ctx.GreenMaterials, ctx.Model, kv.Key, true) : null;
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

            public Sampler(IEnumerable<GlbReader.Primitive> prims, CupZone zone)
            {
                cupY = zone.Cup.y;
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
                    };
                    // Prefer the ground closest to the cup's height (not a bridge above or a cave below).
                    float dy = Mathf.Abs(vert.Pos.y - cupY);
                    if (dy < bestDy)
                    {
                        bestDy = dy;
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

        private static void CreatePart(Transform parent, string name, MeshData data, Material material, string surface, int groundLayer)
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
            }
            var layer = Surfaces[surface];
            if (layer.HasValue)
            {
                var addition = go.AddComponent<TerrainAddition>();
                Traverse.Create(addition).Field("terrainLayer").SetValue(layer.Value);
            }
            go.SetActive(true);
        }

        private static Material MaterialFor(Dictionary<int, Material> cache, GlbReader.Model model, int index, bool greenZone)
        {
            if (cache.TryGetValue(index, out var cached))
                return cached;
            var src = index >= 0 && index < model.Materials.Count ? model.Materials[index] : null;
            var shader = Shader.Find("Universal Render Pipeline/Lit");
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
                mat.SetFloat("_Cutoff", 0.5f);
                mat.EnableKeyword("_ALPHATEST_ON");
                mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.AlphaTest;
            }
            else if (src != null && src.AlphaBlend)
            {
                mat.SetFloat("_Surface", 1f);
                mat.SetFloat("_Blend", 0f);
                mat.SetOverrideTag("RenderType", "Transparent");
                mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_ZWrite", 0f);
                mat.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
                mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
            }
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

            public static Vertex From(GlbReader.Primitive p, int i) => new Vertex
            {
                Pos = new Vector3(p.Positions[i * 3], p.Positions[i * 3 + 1], p.Positions[i * 3 + 2]),
                Normal = p.Normals != null ? new Vector3(p.Normals[i * 3], p.Normals[i * 3 + 1], p.Normals[i * 3 + 2]) : Vector3.up,
                Uv = p.Uvs != null ? new Vector2(p.Uvs[i * 2], p.Uvs[i * 2 + 1]) : Vector2.zero,
            };

            public static Vertex Lerp(Vertex a, Vertex b, float t) => new Vertex
            {
                Pos = Vector3.Lerp(a.Pos, b.Pos, t),
                Normal = Vector3.Lerp(a.Normal, b.Normal, t).normalized,
                Uv = Vector2.Lerp(a.Uv, b.Uv, t),
            };
        }

        private class MeshData
        {
            private readonly List<Vector3> positions = new List<Vector3>();
            private readonly List<Vector3> normals = new List<Vector3>();
            private readonly List<Vector2> uvs = new List<Vector2>();
            private readonly List<int> indices = new List<int>();

            public int Count => indices.Count;

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
