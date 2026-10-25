using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using BepInEx;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Rendering;

namespace SbgMaps
{
    /// <summary>
    /// Saves the look of a game object (meshes, material settings, textures) to SbgMaps/assets, so it can be rebuilt on
    /// holes that don't have it: the red item box only exists in a few holes, never in the one custom maps are built on.
    /// The saved files come from the game itself; they stay on the player's computer (and in the release zip shared
    /// between friends who own the game), never in the public repository.
    /// </summary>
    internal static class AssetCapture
    {
        public static string Folder => Path.Combine(Paths.GameRootPath, "SbgMaps", "assets");

        public class Look
        {
            public List<Part> parts = new List<Part>();
        }

        /// <summary>One renderer, by its path under the captured root.</summary>
        public class Part
        {
            public string path;
            /// <summary>Placement relative to the captured root: position, rotation (quaternion), scale.</summary>
            public float[] position, rotation, scale;
            public MeshData mesh;
            public List<MaterialData> materials = new List<MaterialData>();
        }

        public class MeshData
        {
            public string name;
            public float[] vertices, normals, uv, uv2;
            public float[] colors;
            public int[][] submeshes;
        }

        public class MaterialData
        {
            public string name, shader;
            public int renderQueue;
            public string[] keywords;
            public Dictionary<string, float[]> colors = new Dictionary<string, float[]>();
            public Dictionary<string, float[]> vectors = new Dictionary<string, float[]>();
            public Dictionary<string, float> floats = new Dictionary<string, float>();
            /// <summary>Property name to PNG file in the assets folder, plus its scale and offset.</summary>
            public Dictionary<string, string> textures = new Dictionary<string, string>();
            public Dictionary<string, float[]> textureScaleOffset = new Dictionary<string, float[]>();
        }

        public static bool Has(string name) => File.Exists(Path.Combine(Folder, name + ".json"));

        public static Look Load(string name)
        {
            try
            {
                string file = Path.Combine(Folder, name + ".json");
                return File.Exists(file) ? JsonConvert.DeserializeObject<Look>(File.ReadAllText(file)) : null;
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"Could not read the saved look '{name}': {e.Message}");
                return null;
            }
        }

        /// <summary>Saves every mesh renderer and particle renderer under root as the look called name.</summary>
        public static void Save(string name, Transform root)
        {
            Directory.CreateDirectory(Folder);
            var look = new Look();
            foreach (var renderer in root.GetComponentsInChildren<Renderer>(true))
            {
                var t = renderer.transform;
                var localRotation = Quaternion.Inverse(root.rotation) * t.rotation;
                var lossy = t.lossyScale;
                var rootScale = root.lossyScale;
                var part = new Part
                {
                    path = PathOf(root, t),
                    position = V(root.InverseTransformPoint(t.position)),
                    rotation = new[] { localRotation.x, localRotation.y, localRotation.z, localRotation.w },
                    scale = V(new Vector3(lossy.x / rootScale.x, lossy.y / rootScale.y, lossy.z / rootScale.z)),
                };
                if (renderer.TryGetComponent<MeshFilter>(out var filter) && filter.sharedMesh != null)
                    part.mesh = SaveMesh(filter.sharedMesh);
                foreach (var m in renderer.sharedMaterials)
                    if (m != null)
                        part.materials.Add(SaveMaterial(name, m));
                look.parts.Add(part);
            }
            File.WriteAllText(Path.Combine(Folder, name + ".json"), JsonConvert.SerializeObject(look, Formatting.Indented));
            Plugin.Log.LogInfo($"Saved the look '{name}' ({look.parts.Count} parts) to {Folder}");
        }

        private static float[] V(Vector3 v) => new[] { v.x, v.y, v.z };

        /// <summary>
        /// Builds a saved look as new objects under parent (meshes with their materials, placed as saved).
        /// Particle effects are left out. False if nothing could be built (e.g. a shader the game has not loaded).
        /// </summary>
        public static bool BuildLook(Look look, Transform parent)
        {
            int built = 0;
            foreach (var part in look.parts)
            {
                if (part.mesh == null || part.position == null)
                    continue;
                var mats = part.materials.Select(m => MaterialFor(m, null)).ToArray();
                if (mats.Length == 0 || mats.Any(m => m == null))
                    continue;
                var go = new GameObject(part.path);
                go.transform.SetParent(parent, false);
                go.transform.localPosition = new Vector3(part.position[0], part.position[1], part.position[2]);
                go.transform.localRotation = new Quaternion(part.rotation[0], part.rotation[1], part.rotation[2], part.rotation[3]);
                go.transform.localScale = new Vector3(part.scale[0], part.scale[1], part.scale[2]);
                go.AddComponent<MeshFilter>().sharedMesh = MeshFor(part.mesh);
                go.AddComponent<MeshRenderer>().sharedMaterials = mats;
                built++;
            }
            return built > 0;
        }

        public static string PathOf(Transform root, Transform t)
        {
            var names = new List<string>();
            for (var p = t; p != null && p != root; p = p.parent)
                names.Add(p.name);
            names.Reverse();
            return string.Join("/", names);
        }

        private static MeshData SaveMesh(Mesh mesh)
        {
            if (!mesh.isReadable)
            {
                try
                {
                    return ReadFromGpu(mesh);
                }
                catch (Exception e)
                {
                    Plugin.Log.LogWarning($"Mesh '{mesh.name}' could not be read back from the graphics card: {e.Message}");
                    return null;
                }
            }
            var data = new MeshData
            {
                name = mesh.name,
                vertices = mesh.vertices.SelectMany(v => new[] { v.x, v.y, v.z }).ToArray(),
                normals = mesh.normals.SelectMany(v => new[] { v.x, v.y, v.z }).ToArray(),
                uv = mesh.uv.SelectMany(v => new[] { v.x, v.y }).ToArray(),
                uv2 = mesh.uv2.SelectMany(v => new[] { v.x, v.y }).ToArray(),
                colors = mesh.colors.SelectMany(c => new[] { c.r, c.g, c.b, c.a }).ToArray(),
                submeshes = Enumerable.Range(0, mesh.subMeshCount).Select(i => mesh.GetTriangles(i)).ToArray(),
            };
            return data;
        }

        /// <summary>
        /// The game ships most meshes "not readable": only the graphics card has their data. Read the vertex and index
        /// buffers back from it and decode them with the mesh's vertex layout.
        /// </summary>
        private static MeshData ReadFromGpu(Mesh mesh)
        {
            int count = mesh.vertexCount;
            var streams = new Dictionary<int, byte[]>();
            byte[] Stream(int s)
            {
                if (!streams.TryGetValue(s, out var bytes))
                {
                    using (var buffer = mesh.GetVertexBuffer(s))
                    {
                        bytes = new byte[buffer.count * buffer.stride];
                        buffer.GetData(bytes);
                    }
                    streams[s] = bytes;
                }
                return bytes;
            }
            float Read(byte[] b, int o, VertexAttributeFormat f) => f switch
            {
                VertexAttributeFormat.Float32 => BitConverter.ToSingle(b, o),
                VertexAttributeFormat.Float16 => Mathf.HalfToFloat(BitConverter.ToUInt16(b, o)),
                VertexAttributeFormat.UNorm8 => b[o] / 255f,
                VertexAttributeFormat.SNorm8 => Mathf.Max((sbyte)b[o] / 127f, -1f),
                VertexAttributeFormat.UNorm16 => BitConverter.ToUInt16(b, o) / 65535f,
                VertexAttributeFormat.SNorm16 => Mathf.Max(BitConverter.ToInt16(b, o) / 32767f, -1f),
                _ => throw new NotSupportedException($"vertex format {f}"),
            };
            int Size(VertexAttributeFormat f) => f switch
            {
                VertexAttributeFormat.Float32 => 4,
                VertexAttributeFormat.Float16 or VertexAttributeFormat.UNorm16 or VertexAttributeFormat.SNorm16 => 2,
                _ => 1,
            };
            float[] Attribute(VertexAttribute attribute, int components)
            {
                if (!mesh.HasVertexAttribute(attribute))
                    return null;
                var format = mesh.GetVertexAttributeFormat(attribute);
                int dim = mesh.GetVertexAttributeDimension(attribute);
                int stream = mesh.GetVertexAttributeStream(attribute);
                int offset = mesh.GetVertexAttributeOffset(attribute);
                int stride = mesh.GetVertexBufferStride(stream);
                var bytes = Stream(stream);
                var result = new float[count * components];
                for (int v = 0; v < count; v++)
                    for (int c = 0; c < components; c++)
                        result[v * components + c] = c < dim ? Read(bytes, v * stride + offset + c * Size(format), format) : (c == 3 ? 1f : 0f);
                return result;
            }
            int[] indices;
            using (var ib = mesh.GetIndexBuffer())
            {
                var bytes = new byte[ib.count * ib.stride];
                ib.GetData(bytes);
                bool wide = mesh.indexFormat == IndexFormat.UInt32;
                indices = new int[ib.count];
                for (int i = 0; i < ib.count; i++)
                    indices[i] = wide ? BitConverter.ToInt32(bytes, i * 4) : BitConverter.ToUInt16(bytes, i * 2);
            }
            var submeshes = new int[mesh.subMeshCount][];
            for (int s = 0; s < mesh.subMeshCount; s++)
            {
                var d = mesh.GetSubMesh(s);
                submeshes[s] = new int[d.indexCount];
                for (int i = 0; i < d.indexCount; i++)
                    submeshes[s][i] = indices[d.indexStart + i] + d.baseVertex;
            }
            Plugin.Log.LogInfo($"Read mesh '{mesh.name}' back from the graphics card ({count} vertices)");
            return new MeshData
            {
                name = mesh.name,
                vertices = Attribute(VertexAttribute.Position, 3),
                normals = Attribute(VertexAttribute.Normal, 3),
                uv = Attribute(VertexAttribute.TexCoord0, 2),
                uv2 = Attribute(VertexAttribute.TexCoord1, 2),
                colors = Attribute(VertexAttribute.Color, 4),
                submeshes = submeshes,
            };
        }

        /// <summary>A material's settings and textures (saved next to it) for rebuilding later.</summary>
        public static MaterialData SaveMaterialData(string lookName, Material m)
        {
            Directory.CreateDirectory(Folder);
            return SaveMaterial(lookName, m);
        }

        private static MaterialData SaveMaterial(string lookName, Material m)
        {
            var data = new MaterialData { name = m.name.Replace(" (Instance)", ""), shader = m.shader.name, renderQueue = m.renderQueue, keywords = m.shaderKeywords };
            var shader = m.shader;
            for (int i = 0; i < shader.GetPropertyCount(); i++)
            {
                string p = shader.GetPropertyName(i);
                switch (shader.GetPropertyType(i))
                {
                    case ShaderPropertyType.Color:
                        var c = m.GetColor(p);
                        data.colors[p] = new[] { c.r, c.g, c.b, c.a };
                        break;
                    case ShaderPropertyType.Vector:
                        var v = m.GetVector(p);
                        data.vectors[p] = new[] { v.x, v.y, v.z, v.w };
                        break;
                    case ShaderPropertyType.Float:
                    case ShaderPropertyType.Range:
                        data.floats[p] = m.GetFloat(p);
                        break;
                    case ShaderPropertyType.Texture:
                        var tex = m.GetTexture(p);
                        if (tex is Texture2D t2)
                        {
                            string file = $"{lookName}-{San(data.name)}-{San(p)}.png";
                            File.WriteAllBytes(Path.Combine(Folder, file), ReadablePng(t2));
                            data.textures[p] = file;
                        }
                        var so = m.GetTextureScale(p);
                        var off = m.GetTextureOffset(p);
                        data.textureScaleOffset[p] = new[] { so.x, so.y, off.x, off.y };
                        break;
                }
            }
            return data;
        }

        private static string San(string s) => string.Concat(s.Select(ch => char.IsLetterOrDigit(ch) ? ch : '_'));

        /// <summary>PNG bytes of any texture, readable or not (drawn through a render texture).</summary>
        private static byte[] ReadablePng(Texture2D tex)
        {
            var rt = RenderTexture.GetTemporary(tex.width, tex.height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var previous = RenderTexture.active;
            Graphics.Blit(tex, rt);
            RenderTexture.active = rt;
            var copy = new Texture2D(tex.width, tex.height, TextureFormat.RGBA32, false);
            copy.ReadPixels(new Rect(0, 0, tex.width, tex.height), 0, 0);
            copy.Apply();
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(rt);
            byte[] png = copy.EncodeToPNG();
            UnityEngine.Object.Destroy(copy);
            return png;
        }

        // ---------- rebuilding ----------

        private static readonly Dictionary<string, Mesh> meshes = new Dictionary<string, Mesh>();
        private static readonly Dictionary<string, Material> materials = new Dictionary<string, Material>();
        private static readonly Dictionary<string, Texture2D> textures = new Dictionary<string, Texture2D>();

        public static Mesh MeshFor(MeshData data)
        {
            if (data == null)
                return null;
            if (meshes.TryGetValue(data.name, out var cached) && cached != null)
                return cached;
            var mesh = new Mesh { name = data.name + " (SbgMaps)" };
            Vector3[] V3(float[] a) => Enumerable.Range(0, a.Length / 3).Select(i => new Vector3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2])).ToArray();
            Vector2[] V2(float[] a) => Enumerable.Range(0, a.Length / 2).Select(i => new Vector2(a[i * 2], a[i * 2 + 1])).ToArray();
            mesh.vertices = V3(data.vertices);
            if (data.normals?.Length == data.vertices.Length)
                mesh.normals = V3(data.normals);
            if (data.uv?.Length > 0)
                mesh.uv = V2(data.uv);
            if (data.uv2?.Length > 0)
                mesh.uv2 = V2(data.uv2);
            if (data.colors?.Length > 0)
                mesh.colors = Enumerable.Range(0, data.colors.Length / 4).Select(i => new Color(data.colors[i * 4], data.colors[i * 4 + 1], data.colors[i * 4 + 2], data.colors[i * 4 + 3])).ToArray();
            mesh.subMeshCount = data.submeshes.Length;
            for (int i = 0; i < data.submeshes.Length; i++)
                mesh.SetTriangles(data.submeshes[i], i);
            mesh.RecalculateBounds();
            mesh.hideFlags = HideFlags.DontUnloadUnusedAsset;
            meshes[data.name] = mesh;
            return mesh;
        }

        /// <summary>The saved material, made from the given one (same shader, which the game has loaded) with the saved settings.</summary>
        public static Material MaterialFor(MaterialData data, Material basedOn)
        {
            if (materials.TryGetValue(data.name, out var cached) && cached != null)
                return cached;
            var shader = Shader.Find(data.shader) ?? basedOn?.shader;
            if (shader == null)
            {
                Plugin.Log.LogWarning($"Shader '{data.shader}' is not loaded here; '{data.name}' can't be rebuilt");
                return basedOn;
            }
            var m = basedOn != null && basedOn.shader == shader ? new Material(basedOn) : new Material(shader);
            m.name = data.name + " (SbgMaps)";
            foreach (var kv in data.colors)
                m.SetColor(kv.Key, new Color(kv.Value[0], kv.Value[1], kv.Value[2], kv.Value[3]));
            foreach (var kv in data.vectors)
                m.SetVector(kv.Key, new Vector4(kv.Value[0], kv.Value[1], kv.Value[2], kv.Value[3]));
            foreach (var kv in data.floats)
                m.SetFloat(kv.Key, kv.Value);
            foreach (var kv in data.textures)
            {
                var tex = TextureFor(kv.Value);
                if (tex != null)
                    m.SetTexture(kv.Key, tex);
            }
            foreach (var kv in data.textureScaleOffset)
            {
                m.SetTextureScale(kv.Key, new Vector2(kv.Value[0], kv.Value[1]));
                m.SetTextureOffset(kv.Key, new Vector2(kv.Value[2], kv.Value[3]));
            }
            if (data.keywords != null)
                m.shaderKeywords = data.keywords;
            m.renderQueue = data.renderQueue;
            m.hideFlags = HideFlags.DontUnloadUnusedAsset;
            materials[data.name] = m;
            return m;
        }

        private static Texture2D TextureFor(string file)
        {
            if (textures.TryGetValue(file, out var cached) && cached != null)
                return cached;
            string path = Path.Combine(Folder, file);
            if (!File.Exists(path))
                return null;
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, true) { name = file };
            if (!tex.LoadImage(File.ReadAllBytes(path)))
                return null;
            tex.hideFlags = HideFlags.DontUnloadUnusedAsset;
            textures[file] = tex;
            return tex;
        }
    }
}
