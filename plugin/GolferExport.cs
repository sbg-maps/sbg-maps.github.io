using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using BepInEx;
using Newtonsoft.Json;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Saves the local player's golfer (as currently dressed and posed) plus the live camera setup to
    /// &lt;game&gt;/SbgMaps/my-character.glb, so the map editor can show the real character and the real player view.
    /// The file stays on the player's own computer.
    /// </summary>
    internal static class GolferExport
    {
        public static string OutputPath => Path.Combine(Paths.GameRootPath, "SbgMaps", "my-character.glb");

        public static void Export()
        {
            var player = GameManager.LocalPlayerMovement;
            if (player == null)
            {
                DevTools.Say("Join a match first, then press F9 to save your character");
                return;
            }
            var root = player.transform;
            var toLocal = Matrix4x4.TRS(root.position, root.rotation, Vector3.one).inverse;
            var writer = new GlbBuilder();
            int parts = 0, skipped = 0;

            foreach (var renderer in root.GetComponentsInChildren<Renderer>())
            {
                if (!renderer.enabled || !renderer.gameObject.activeInHierarchy || renderer is ParticleSystemRenderer || renderer is TrailRenderer || renderer is LineRenderer)
                    continue;
                Mesh mesh;
                Matrix4x4 toRoot;
                if (renderer is SkinnedMeshRenderer skinned)
                {
                    mesh = new Mesh();
                    try
                    {
                        skinned.BakeMesh(mesh, true);
                    }
                    catch (Exception e)
                    {
                        Plugin.Log.LogWarning($"Golfer export: can't bake '{renderer.name}': {e.Message}");
                        skipped++;
                        continue;
                    }
                    // A baked mesh is in the renderer's space with its scale already applied.
                    toRoot = toLocal * Matrix4x4.TRS(renderer.transform.position, renderer.transform.rotation, Vector3.one);
                }
                else if (renderer is MeshRenderer && renderer.TryGetComponent<MeshFilter>(out var filter) && filter.sharedMesh != null)
                {
                    mesh = filter.sharedMesh;
                    toRoot = toLocal * renderer.transform.localToWorldMatrix;
                }
                else
                    continue;
                if (!mesh.isReadable && !(renderer is SkinnedMeshRenderer))
                {
                    skipped++;
                    continue;
                }
                var materials = renderer.sharedMaterials;
                for (int sub = 0; sub < mesh.subMeshCount; sub++)
                {
                    var mat = sub < materials.Length ? materials[sub] : null;
                    if (writer.AddPart(renderer.name, mesh, sub, toRoot, mat))
                        parts++;
                }
            }

            // How the player sees the world right now: camera relative to the golfer, in glTF axes.
            var cam = Camera.main;
            object camera = null;
            if (cam != null)
            {
                var localPos = Quaternion.Inverse(root.rotation) * (cam.transform.position - root.position);
                var localRot = Quaternion.Inverse(root.rotation) * cam.transform.rotation;
                camera = new
                {
                    fov = cam.fieldOfView,
                    position = new[] { localPos.x, localPos.y, -localPos.z },
                    // Mirroring z: (x, y, z, w) becomes (-x, -y, z, w).
                    rotation = new[] { -localRot.x, -localRot.y, localRot.z, localRot.w },
                };
            }
            float height = 0f;
            foreach (var c in root.GetComponentsInChildren<Collider>())
                if (!c.isTrigger)
                    height = Mathf.Max(height, c.bounds.max.y - root.position.y);

            Directory.CreateDirectory(Path.GetDirectoryName(OutputPath));
            File.WriteAllBytes(OutputPath, writer.Build(new { sbgGolfer = 1, playerHeight = height, camera }));
            DevTools.Say($"Character saved in the game folder: SbgMaps/my-character.glb ({parts} parts{(skipped > 0 ? $", {skipped} skipped" : "")}). Load it in the map editor's Model tab.");
        }

        /// <summary>Minimal glTF binary writer for a handful of textured meshes.</summary>
        private class GlbBuilder
        {
            private readonly List<byte> bin = new List<byte>();
            private readonly List<object> views = new List<object>(), accessors = new List<object>(), meshes = new List<object>(),
                materials = new List<object>(), textures = new List<object>(), images = new List<object>(), nodes = new List<object>();
            private readonly Dictionary<Material, int> materialIndex = new Dictionary<Material, int>();

            public bool AddPart(string name, Mesh mesh, int sub, Matrix4x4 toRoot, Material material)
            {
                var indices = mesh.GetIndices(sub);
                if (indices.Length < 3 || mesh.GetTopology(sub) != MeshTopology.Triangles)
                    return false;
                var srcPos = mesh.vertices;
                var srcNrm = mesh.normals;
                var srcUv = mesh.uv;
                // Only the vertices this submesh uses, converted to glTF axes (z flipped).
                var remap = new Dictionary<int, int>();
                var pos = new List<float>();
                var nrm = new List<float>();
                var uv = new List<float>();
                var idx = new List<int>();
                foreach (int i in indices)
                {
                    if (!remap.TryGetValue(i, out int j))
                    {
                        j = remap.Count;
                        remap[i] = j;
                        var p = toRoot.MultiplyPoint3x4(srcPos[i]);
                        pos.AddRange(new[] { p.x, p.y, -p.z });
                        var n = srcNrm.Length > i ? toRoot.MultiplyVector(srcNrm[i]).normalized : Vector3.up;
                        nrm.AddRange(new[] { n.x, n.y, -n.z });
                        var t = srcUv.Length > i ? srcUv[i] : Vector2.zero;
                        uv.AddRange(new[] { t.x, 1f - t.y });
                    }
                    idx.Add(j);
                }
                // Flipping z mirrors the mesh, so reverse the winding.
                for (int t = 0; t + 2 < idx.Count; t += 3)
                    (idx[t + 1], idx[t + 2]) = (idx[t + 2], idx[t + 1]);

                int vertexCount = remap.Count;
                var min = new float[] { float.MaxValue, float.MaxValue, float.MaxValue };
                var max = new float[] { float.MinValue, float.MinValue, float.MinValue };
                for (int v = 0; v < vertexCount; v++)
                    for (int k = 0; k < 3; k++)
                    {
                        min[k] = Math.Min(min[k], pos[v * 3 + k]);
                        max[k] = Math.Max(max[k], pos[v * 3 + k]);
                    }
                int posAcc = Accessor(Floats(pos), 5126, vertexCount, "VEC3", 34962, min, max);
                int nrmAcc = Accessor(Floats(nrm), 5126, vertexCount, "VEC3", 34962);
                int uvAcc = Accessor(Floats(uv), 5126, vertexCount, "VEC2", 34962);
                int idxAcc = Accessor(idx.SelectMany(BitConverter.GetBytes).ToArray(), 5125, idx.Count, "SCALAR", 34963);
                meshes.Add(new
                {
                    name,
                    primitives = new[] { new { attributes = new Dictionary<string, int> { ["POSITION"] = posAcc, ["NORMAL"] = nrmAcc, ["TEXCOORD_0"] = uvAcc }, indices = idxAcc, material = MaterialFor(material), mode = 4 } },
                });
                nodes.Add(new { name, mesh = meshes.Count - 1 });
                return true;
            }

            private int MaterialFor(Material m)
            {
                if (m == null)
                    m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
                if (materialIndex.TryGetValue(m, out int existing))
                    return existing;
                var color = m.HasProperty("_BaseColor") ? m.GetColor("_BaseColor") : m.HasProperty("_Color") ? m.GetColor("_Color") : Color.white;
                var pbr = new Dictionary<string, object>
                {
                    ["baseColorFactor"] = new[] { color.r, color.g, color.b, 1f },
                    ["metallicFactor"] = 0,
                    ["roughnessFactor"] = 1,
                };
                var png = TexturePng(m);
                if (png != null)
                {
                    images.Add(new { bufferView = View(png), mimeType = "image/png" });
                    textures.Add(new { source = images.Count - 1 });
                    pbr["baseColorTexture"] = new { index = textures.Count - 1 };
                }
                materials.Add(new { name = m.name, pbrMetallicRoughness = pbr, doubleSided = true });
                return materialIndex[m] = materials.Count - 1;
            }

            /// <summary>The material's colour texture as PNG. Game textures aren't CPU-readable, so copy through the GPU.</summary>
            private static byte[] TexturePng(Material m)
            {
                Texture tex = null;
                foreach (var prop in new[] { "_BaseMap", "_MainTex", "_BaseColorMap", "_Albedo", "_AlbedoMap", "_Texture" })
                    if (m.HasProperty(prop) && m.GetTexture(prop) != null)
                    {
                        tex = m.GetTexture(prop);
                        break;
                    }
                if (tex == null)
                    tex = m.GetTexturePropertyNames().Select(m.GetTexture).FirstOrDefault(t => t is Texture2D && !t.name.ToLowerInvariant().Contains("normal"));
                if (tex == null)
                    return null;
                var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                var previous = RenderTexture.active;
                try
                {
                    Graphics.Blit(tex, rt);
                    RenderTexture.active = rt;
                    var copy = new Texture2D(tex.width, tex.height, TextureFormat.RGBA32, false);
                    copy.ReadPixels(new Rect(0, 0, tex.width, tex.height), 0, 0);
                    copy.Apply();
                    var png = ImageConversion.EncodeToPNG(copy);
                    UnityEngine.Object.Destroy(copy);
                    return png;
                }
                finally
                {
                    RenderTexture.active = previous;
                    RenderTexture.ReleaseTemporary(rt);
                }
            }

            private static byte[] Floats(List<float> values)
            {
                var bytes = new byte[values.Count * 4];
                Buffer.BlockCopy(values.ToArray(), 0, bytes, 0, bytes.Length);
                return bytes;
            }

            private int View(byte[] data, int? target = null)
            {
                while (bin.Count % 4 != 0)
                    bin.Add(0);
                var view = new Dictionary<string, object> { ["buffer"] = 0, ["byteOffset"] = bin.Count, ["byteLength"] = data.Length };
                if (target.HasValue)
                    view["target"] = target.Value;
                bin.AddRange(data);
                views.Add(view);
                return views.Count - 1;
            }

            private int Accessor(byte[] data, int componentType, int count, string type, int target, float[] min = null, float[] max = null)
            {
                var acc = new Dictionary<string, object> { ["bufferView"] = View(data, target), ["componentType"] = componentType, ["count"] = count, ["type"] = type };
                if (min != null)
                {
                    acc["min"] = min;
                    acc["max"] = max;
                }
                accessors.Add(acc);
                return accessors.Count - 1;
            }

            public byte[] Build(object extras)
            {
                while (bin.Count % 4 != 0)
                    bin.Add(0);
                var gltf = new Dictionary<string, object>
                {
                    ["asset"] = new { version = "2.0", generator = "SbgMaps golfer export" },
                    ["scene"] = 0,
                    ["scenes"] = new[] { new { nodes = Enumerable.Range(0, nodes.Count).ToArray(), extras } },
                    ["nodes"] = nodes,
                    ["meshes"] = meshes,
                    ["materials"] = materials,
                    ["buffers"] = new[] { new { byteLength = bin.Count } },
                    ["bufferViews"] = views,
                    ["accessors"] = accessors,
                };
                if (images.Count > 0)
                {
                    gltf["images"] = images;
                    gltf["textures"] = textures;
                }
                var json = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(gltf));
                int jsonPadded = (json.Length + 3) / 4 * 4;
                using var ms = new MemoryStream();
                using var w = new BinaryWriter(ms);
                w.Write(0x46546C67u);
                w.Write(2u);
                w.Write((uint)(12 + 8 + jsonPadded + 8 + bin.Count));
                w.Write((uint)jsonPadded);
                w.Write(0x4E4F534Au);
                w.Write(json);
                for (int i = json.Length; i < jsonPadded; i++)
                    w.Write((byte)0x20);
                w.Write((uint)bin.Count);
                w.Write(0x004E4942u);
                w.Write(bin.ToArray());
                return ms.ToArray();
            }
        }
    }
}
