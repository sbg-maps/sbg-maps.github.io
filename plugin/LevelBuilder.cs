using System.Collections.Generic;
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
        /// <summary>Half the side of the square cut out under the cup (the cup's own mesh covers 2.5 m).</summary>
        private const float CupCutHalf = 1.0f;
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
            var localCup = cup - origin;

            var materials = new Dictionary<int, Material>();
            var greenMaterials = new Dictionary<int, Material>();
            var cutSquare = Square(localCup.x, localCup.z, CupCutHalf);
            var greenCircle = Circle(localCup.x, localCup.z, greenRadius, GreenZoneSides);

            int index = 0;
            foreach (var prim in model.Primitives)
            {
                var mat = prim.Material >= 0 && prim.Material < model.Materials.Count ? model.Materials[prim.Material] : null;
                string surface = mat?.Surface ?? "rough";
                if (!Surfaces.ContainsKey(surface))
                    surface = "rough";
                string greenSurface = GreenFor(surface);

                var main = new MeshData();
                var green = new MeshData();
                for (int t = 0; t < prim.Indices.Length; t += 3)
                {
                    var tri = new List<Vertex> { Vertex.From(prim, prim.Indices[t]), Vertex.From(prim, prim.Indices[t + 1]), Vertex.From(prim, prim.Indices[t + 2]) };
                    var pieces = new List<List<Vertex>> { tri };

                    if (surface != "none" && NearHeight(tri, localCup.y, CupCutHeight))
                        pieces = SubtractAll(pieces, cutSquare, out _);

                    if (greenSurface != null && NearHeight(tri, localCup.y, GreenZoneHeight))
                    {
                        pieces = SubtractAll(pieces, greenCircle, out var inside);
                        foreach (var p in inside)
                            green.AddPolygon(p);
                    }
                    foreach (var p in pieces)
                        main.AddPolygon(p);
                }

                string name = $"{index++:D3} {mat?.Name ?? "unnamed"} [{surface}]";
                if (main.Count > 0)
                    CreatePart(root.transform, name, main, MaterialFor(materials, model, prim.Material, false), surface, groundLayer);
                if (green.Count > 0)
                    CreatePart(root.transform, name + " green", green, MaterialFor(greenMaterials, model, prim.Material, true), greenSurface, groundLayer);
            }
            Physics.SyncTransforms();
            return root;
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
            ["slide"] = TerrainLayer.Rough,
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

        private static int? slideLayer;

        /// <summary>
        /// A physics layer that players and balls collide with but players can't stand on, so they slide off like
        /// on a steep slope. Picked from the game's own layer setup; falls back to the ground layer if none fits.
        /// </summary>
        private static int SlideLayer(int groundLayer)
        {
            if (slideLayer.HasValue)
                return slideLayer.Value;
            var ls = GameManager.LayerSettings;
            int[] taken = { ls.StationaryBallLayer, ls.DynamicBallLayer, ls.HittablesLayer, ls.GolfCartPassengersLayer, ls.ElectromagnetShieldLayer,
                ls.PlayerLayer, ls.GolfCartLayer, ls.FoliageLayer, ls.VfxLayer, ls.ItemsLayer, ls.IceBlockLayer };
            int best = -1;
            for (int l = 0; l < 32; l++)
            {
                if (System.Array.IndexOf(taken, l) >= 0 || (ls.PlayerGroundableMask & (1 << l)) != 0)
                    continue;
                if (Physics.GetIgnoreLayerCollision(l, ls.PlayerLayer) || Physics.GetIgnoreLayerCollision(l, ls.DynamicBallLayer))
                    continue;
                // Prefer a layer the ball still treats as ground, so it rolls rather than skids.
                if (best < 0 || ((ls.BallGroundableMask & (1 << l)) != 0 && (ls.BallGroundableMask & (1 << best)) == 0))
                    best = l;
            }
            Plugin.Log.LogInfo($"Slide surface uses physics layer {best} ('{(best >= 0 ? LayerMask.LayerToName(best) : "")}'); " +
                $"player groundable mask {ls.PlayerGroundableMask.value:X8}, ball groundable mask {ls.BallGroundableMask.value:X8}");
            slideLayer = best >= 0 ? best : groundLayer;
            return slideLayer.Value;
        }

        private static void CreatePart(Transform parent, string name, MeshData data, Material material, string surface, int groundLayer)
        {
            var go = new GameObject(name);
            // TerrainAddition reads its layer in Awake, so fill everything in while inactive.
            go.SetActive(false);
            go.layer = surface == "slide" ? SlideLayer(groundLayer) : groundLayer;
            go.transform.SetParent(parent, false);
            var mesh = data.ToMesh(name);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterial = material;
            if (surface != "none")
                go.AddComponent<MeshCollider>().sharedMesh = mesh;
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
            mat.SetFloat("_Smoothness", 0f);
            mat.SetFloat("_Metallic", 0f);
            if (src?.Image != null)
            {
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, mipChain: true);
                if (ImageConversion.LoadImage(tex, src.Image))
                {
                    tex.wrapMode = TextureWrapMode.Repeat;
                    tex.filterMode = FilterMode.Bilinear;
                    tex.anisoLevel = 4;
                    mat.SetTexture("_BaseMap", tex);
                }
            }
            if (src == null || src.DoubleSided)
                mat.SetFloat("_Cull", 0f);
            cache[index] = mat;
            return mat;
        }

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
