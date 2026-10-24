using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json.Linq;

namespace SbgMaps
{
    /// <summary>
    /// Minimal reader for binary glTF (.glb): triangle meshes with positions, normals, first UV set and
    /// base colour textures. Node transforms are applied. Output is in map coordinates: glTF's right-handed
    /// (x, y, z) becomes (x, y, -z), with triangle winding reversed and V flipped for Unity textures.
    /// No Unity types here, so it can be tested outside the game.
    /// </summary>
    public static class GlbReader
    {
        public class Primitive
        {
            public float[] Positions;   // xyz per vertex, map coordinates
            public float[] Normals;     // xyz per vertex, may be null
            public float[] Uvs;         // uv per vertex (Unity convention), may be null
            public int[] Indices;       // triangles, Unity winding
            public int Material = -1;
        }

        public class Material
        {
            public string Name;
            public float[] BaseColor = { 1, 1, 1, 1 };
            public byte[] Image;        // PNG/JPEG bytes of the base colour texture, or null
            public bool DoubleSided;
            public bool AlphaBlend;
            public bool AlphaMask;
            public string Surface;      // from extras.surface
            public bool Invisible;      // extras.invisible: collision only, never drawn
            public bool RenderOnly;     // extras.renderOnly: drawn only, no collision
        }

        /// <summary>A node marked with extras.object: kept separate so the game can move it.</summary>
        public class SceneObject
        {
            public string Name;
            public JObject Extras;
            public float[] Position;    // map coordinates
            public float[] Rotation;    // quaternion xyzw, Unity convention
            public float[] Scale;
            public readonly List<Primitive> Primitives = new List<Primitive>(); // object-local, map axes
        }

        public class Model
        {
            public readonly List<Primitive> Primitives = new List<Primitive>();
            public readonly List<Material> Materials = new List<Material>();
            public readonly List<SceneObject> Objects = new List<SceneObject>();
        }

        public static Model Read(byte[] glb)
        {
            if (glb.Length < 20 || BitConverter.ToUInt32(glb, 0) != 0x46546C67)
                throw new InvalidDataException("not a .glb file");
            int jsonLength = BitConverter.ToInt32(glb, 12);
            if (BitConverter.ToUInt32(glb, 16) != 0x4E4F534A)
                throw new InvalidDataException("glb: first chunk is not JSON");
            var json = JObject.Parse(Encoding.UTF8.GetString(glb, 20, jsonLength));
            int binStart = 20 + jsonLength;
            byte[] bin = null;
            if (binStart + 8 <= glb.Length && BitConverter.ToUInt32(glb, binStart + 4) == 0x004E4942)
            {
                int binLength = BitConverter.ToInt32(glb, binStart);
                bin = new byte[binLength];
                Buffer.BlockCopy(glb, binStart + 8, bin, 0, binLength);
            }
            return new Parser(json, bin).Parse();
        }

        private class Parser
        {
            private readonly JObject gltf;
            private readonly byte[] bin;
            private readonly Model model = new Model();

            public Parser(JObject gltf, byte[] bin)
            {
                this.gltf = gltf;
                this.bin = bin;
            }

            public Model Parse()
            {
                foreach (JObject m in Arr("materials"))
                    model.Materials.Add(ReadMaterial(m));

                var scene = gltf["scenes"]?[(int?)gltf["scene"] ?? 0];
                var roots = scene?["nodes"] as JArray ?? new JArray(Enumerable(Arr("nodes").Count));
                foreach (var n in roots)
                    VisitNode((int)n, Identity());
                return model;
            }

            private static JArray Enumerable(int count)
            {
                var a = new JArray();
                for (int i = 0; i < count; i++)
                    a.Add(i);
                return a;
            }

            private JArray Arr(string key) => gltf[key] as JArray ?? new JArray();

            private Material ReadMaterial(JObject m)
            {
                var mat = new Material
                {
                    Name = (string)m["name"] ?? "material",
                    DoubleSided = (bool?)m["doubleSided"] ?? false,
                    AlphaBlend = (string)m["alphaMode"] == "BLEND",
                    AlphaMask = (string)m["alphaMode"] == "MASK",
                    Surface = (string)m["extras"]?["surface"],
                    Invisible = (bool?)m["extras"]?["invisible"] ?? false,
                    RenderOnly = (bool?)m["extras"]?["renderOnly"] ?? false,
                };
                var pbr = m["pbrMetallicRoughness"];
                if (pbr?["baseColorFactor"] is JArray f && f.Count == 4)
                    mat.BaseColor = new[] { (float)f[0], (float)f[1], (float)f[2], (float)f[3] };
                var texIndex = (int?)pbr?["baseColorTexture"]?["index"];
                if (texIndex.HasValue)
                {
                    var source = (int?)Arr("textures")[texIndex.Value]?["source"];
                    if (source.HasValue)
                    {
                        var image = Arr("images")[source.Value];
                        var view = (int?)image["bufferView"];
                        if (view.HasValue)
                            mat.Image = BufferViewBytes(view.Value);
                    }
                }
                return mat;
            }

            private void VisitNode(int index, double[] parent, SceneObject owner = null)
            {
                var node = Arr("nodes")[index];
                var world = Multiply(parent, LocalMatrix(node));
                if (owner == null && node["extras"]?["object"] != null)
                {
                    owner = MakeObject(node, world);
                    model.Objects.Add(owner);
                    world = Identity(); // the object's own geometry is kept in its local space
                }
                var meshIndex = (int?)node["mesh"];
                if (meshIndex.HasValue)
                    foreach (JObject p in (JArray)Arr("meshes")[meshIndex.Value]["primitives"])
                        ReadPrimitive(p, world, owner?.Primitives ?? model.Primitives);
                if (node["children"] is JArray children)
                    foreach (var c in children)
                        VisitNode((int)c, world, owner);
            }

            /// <summary>Converts a glTF world matrix to map/Unity position, rotation and scale (z is flipped on both sides).</summary>
            private static SceneObject MakeObject(JToken node, double[] w)
            {
                // U = C * W * C with C = diag(1, 1, -1): negate the elements that mix z with x/y.
                double[] u = (double[])w.Clone();
                foreach (int i in new[] { 2, 6, 8, 9, 14 })
                    u[i] = -u[i];
                double sx = Math.Sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
                double sy = Math.Sqrt(u[4] * u[4] + u[5] * u[5] + u[6] * u[6]);
                double sz = Math.Sqrt(u[8] * u[8] + u[9] * u[9] + u[10] * u[10]);
                // Rotation matrix rows/cols (column-major input).
                double m00 = u[0] / sx, m10 = u[1] / sx, m20 = u[2] / sx;
                double m01 = u[4] / sy, m11 = u[5] / sy, m21 = u[6] / sy;
                double m02 = u[8] / sz, m12 = u[9] / sz, m22 = u[10] / sz;
                double qw, qx, qy, qz, tr = m00 + m11 + m22;
                if (tr > 0)
                {
                    double s = Math.Sqrt(tr + 1.0) * 2;
                    qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
                }
                else if (m00 > m11 && m00 > m22)
                {
                    double s = Math.Sqrt(1.0 + m00 - m11 - m22) * 2;
                    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
                }
                else if (m11 > m22)
                {
                    double s = Math.Sqrt(1.0 + m11 - m00 - m22) * 2;
                    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
                }
                else
                {
                    double s = Math.Sqrt(1.0 + m22 - m00 - m11) * 2;
                    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
                }
                return new SceneObject
                {
                    Name = (string)node["name"] ?? "object",
                    Extras = (JObject)node["extras"],
                    Position = new[] { (float)u[12], (float)u[13], (float)u[14] },
                    Rotation = new[] { (float)qx, (float)qy, (float)qz, (float)qw },
                    Scale = new[] { (float)sx, (float)sy, (float)sz },
                };
            }

            private void ReadPrimitive(JObject p, double[] world, List<Primitive> into)
            {
                int mode = (int?)p["mode"] ?? 4;
                if (mode != 4)
                    return; // only triangle lists
                var attrs = (JObject)p["attributes"];
                var pos = ReadFloats((int)attrs["POSITION"], 3);
                int count = pos.Length / 3;
                var nrm = attrs["NORMAL"] != null ? ReadFloats((int)attrs["NORMAL"], 3) : null;
                var uv = attrs["TEXCOORD_0"] != null ? ReadFloats((int)attrs["TEXCOORD_0"], 2) : null;
                int[] idx;
                if (p["indices"] != null)
                    idx = ReadInts((int)p["indices"]);
                else
                {
                    idx = new int[count];
                    for (int i = 0; i < count; i++)
                        idx[i] = i;
                }

                bool mirrored = Determinant3(world) < 0;
                var prim = new Primitive { Material = (int?)p["material"] ?? -1, Positions = new float[count * 3] };
                for (int i = 0; i < count; i++)
                {
                    Transform(world, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 1, out var x, out var y, out var z);
                    prim.Positions[i * 3] = (float)x;
                    prim.Positions[i * 3 + 1] = (float)y;
                    prim.Positions[i * 3 + 2] = (float)-z;
                }
                if (nrm != null)
                {
                    prim.Normals = new float[count * 3];
                    for (int i = 0; i < count; i++)
                    {
                        // Good enough for rotation + uniform scale, which is what exporters produce.
                        Transform(world, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2], 0, out var x, out var y, out var z);
                        double len = Math.Sqrt(x * x + y * y + z * z);
                        if (len < 1e-9)
                            len = 1;
                        prim.Normals[i * 3] = (float)(x / len);
                        prim.Normals[i * 3 + 1] = (float)(y / len);
                        prim.Normals[i * 3 + 2] = (float)(-z / len);
                    }
                }
                if (uv != null)
                {
                    prim.Uvs = new float[count * 2];
                    for (int i = 0; i < count; i++)
                    {
                        prim.Uvs[i * 2] = uv[i * 2];
                        prim.Uvs[i * 2 + 1] = 1f - uv[i * 2 + 1];
                    }
                }
                // Flipping z mirrors the mesh, so reverse the winding (unless the node transform already mirrored it).
                prim.Indices = new int[idx.Length - idx.Length % 3];
                for (int t = 0; t + 2 < idx.Length; t += 3)
                {
                    prim.Indices[t] = idx[t];
                    prim.Indices[t + 1] = mirrored ? idx[t + 1] : idx[t + 2];
                    prim.Indices[t + 2] = mirrored ? idx[t + 2] : idx[t + 1];
                }
                into.Add(prim);
            }

            // ---------- accessors ----------

            private byte[] BufferViewBytes(int viewIndex)
            {
                var view = Arr("bufferViews")[viewIndex];
                if (((int?)view["buffer"] ?? 0) != 0 || bin == null)
                    throw new InvalidDataException("glb: external buffers are not supported");
                int offset = (int?)view["byteOffset"] ?? 0;
                int length = (int)view["byteLength"];
                var bytes = new byte[length];
                Buffer.BlockCopy(bin, offset, bytes, 0, length);
                return bytes;
            }

            private (int start, int stride, int componentType, int count, bool normalized) Accessor(int index, int components)
            {
                var acc = Arr("accessors")[index];
                if (acc["sparse"] != null)
                    throw new InvalidDataException("glb: sparse accessors are not supported");
                var view = Arr("bufferViews")[(int)acc["bufferView"]];
                int componentType = (int)acc["componentType"];
                int size = ComponentSize(componentType) * components;
                int stride = (int?)view["byteStride"] ?? size;
                int start = ((int?)view["byteOffset"] ?? 0) + ((int?)acc["byteOffset"] ?? 0);
                return (start, stride, componentType, (int)acc["count"], (bool?)acc["normalized"] ?? false);
            }

            private float[] ReadFloats(int index, int components)
            {
                var (start, stride, type, count, normalized) = Accessor(index, components);
                var result = new float[count * components];
                int size = ComponentSize(type);
                for (int i = 0; i < count; i++)
                    for (int c = 0; c < components; c++)
                        result[i * components + c] = ReadComponent(start + i * stride + c * size, type, normalized);
                return result;
            }

            private int[] ReadInts(int index)
            {
                var (start, stride, type, count, _) = Accessor(index, 1);
                var result = new int[count];
                for (int i = 0; i < count; i++)
                {
                    int o = start + i * stride;
                    result[i] = type switch
                    {
                        5121 => bin[o],
                        5123 => BitConverter.ToUInt16(bin, o),
                        5125 => (int)BitConverter.ToUInt32(bin, o),
                        _ => throw new InvalidDataException($"glb: unsupported index type {type}"),
                    };
                }
                return result;
            }

            private float ReadComponent(int o, int type, bool normalized) => type switch
            {
                5126 => BitConverter.ToSingle(bin, o),
                5121 => normalized ? bin[o] / 255f : bin[o],
                5120 => normalized ? Math.Max((sbyte)bin[o] / 127f, -1f) : (sbyte)bin[o],
                5123 => normalized ? BitConverter.ToUInt16(bin, o) / 65535f : BitConverter.ToUInt16(bin, o),
                5122 => normalized ? Math.Max(BitConverter.ToInt16(bin, o) / 32767f, -1f) : BitConverter.ToInt16(bin, o),
                _ => throw new InvalidDataException($"glb: unsupported component type {type}"),
            };

            private static int ComponentSize(int type) => type switch
            {
                5120 => 1,
                5121 => 1,
                5122 => 2,
                5123 => 2,
                5125 => 4,
                5126 => 4,
                _ => throw new InvalidDataException($"glb: unsupported component type {type}"),
            };

            // ---------- matrices (column-major 4x4, like glTF) ----------

            private static double[] Identity() => new double[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };

            private static double[] LocalMatrix(JToken node)
            {
                if (node["matrix"] is JArray m && m.Count == 16)
                {
                    var r = new double[16];
                    for (int i = 0; i < 16; i++)
                        r[i] = (double)m[i];
                    return r;
                }
                double[] t = Vec(node["translation"], 0, 0, 0);
                double[] q = Vec(node["rotation"], 0, 0, 0, 1);
                double[] s = Vec(node["scale"], 1, 1, 1);
                double x = q[0], y = q[1], z = q[2], w = q[3];
                return new[]
                {
                    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
                    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
                    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
                    t[0], t[1], t[2], 1,
                };
            }

            private static double[] Vec(JToken token, params double[] fallback)
            {
                if (!(token is JArray a) || a.Count != fallback.Length)
                    return fallback;
                var r = new double[a.Count];
                for (int i = 0; i < a.Count; i++)
                    r[i] = (double)a[i];
                return r;
            }

            private static double[] Multiply(double[] a, double[] b)
            {
                var r = new double[16];
                for (int col = 0; col < 4; col++)
                    for (int row = 0; row < 4; row++)
                    {
                        double sum = 0;
                        for (int k = 0; k < 4; k++)
                            sum += a[k * 4 + row] * b[col * 4 + k];
                        r[col * 4 + row] = sum;
                    }
                return r;
            }

            private static void Transform(double[] m, double x, double y, double z, double w, out double ox, out double oy, out double oz)
            {
                ox = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
                oy = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
                oz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
            }

            private static double Determinant3(double[] m) =>
                m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
        }
    }
}
