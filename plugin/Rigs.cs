using System;
using System.Collections.Generic;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Animated objects: a model's node tree with its skinned meshes, playing one looping clip (an idle, a walk). Only
    /// the look moves; the object's collision is its pose as exported (LevelBuilder builds that from the flat parts).
    /// </summary>
    public static class Rigs
    {
        /// <summary>Clip data by rig root name. Movers and rollers copy their look with Instantiate, which keeps names
        /// but not plugin fields, so each copy finds its clip here.</summary>
        internal static readonly Dictionary<string, RigPlayer.Data> Registry = new Dictionary<string, RigPlayer.Data>();
        private static int next;

        public static void Build(Transform parent, GlbReader.Rig rig, Func<int, Material> materialFor)
        {
            if (Registry.Count > 2000)
                Registry.Clear(); // from levels long gone
            var root = new GameObject($"rig {next++}");
            root.transform.SetParent(parent, false);
            var nodes = new Transform[rig.Nodes.Count];
            var paths = new string[rig.Nodes.Count];
            for (int i = 0; i < rig.Nodes.Count; i++)
            {
                var n = rig.Nodes[i];
                // Numbered, so paths stay unique even when bones share a name.
                var go = new GameObject($"{i} {n.Name}".Replace('/', '_'));
                var parentTransform = n.Parent >= 0 ? nodes[n.Parent] : root.transform;
                go.transform.SetParent(parentTransform, false);
                go.transform.localPosition = new Vector3(n.Position[0], n.Position[1], n.Position[2]);
                go.transform.localRotation = new Quaternion(n.Rotation[0], n.Rotation[1], n.Rotation[2], n.Rotation[3]);
                go.transform.localScale = new Vector3(n.Scale[0], n.Scale[1], n.Scale[2]);
                nodes[i] = go.transform;
                paths[i] = n.Parent >= 0 ? $"{paths[n.Parent]}/{go.name}" : go.name;
            }

            foreach (var m in rig.Meshes)
            {
                var material = materialFor(m.Primitive.Material);
                if (material == null)
                    continue;
                var mesh = ToMesh(m.Primitive, root.name);
                if (m.Joints != null && m.Bones != null)
                {
                    int count = m.Primitive.Positions.Length / 3;
                    var weights = new BoneWeight[count];
                    for (int v = 0; v < count; v++)
                    {
                        // Unity wants the influences heaviest first and summing to one.
                        var influences = new List<(int bone, float weight)>(4);
                        for (int k = 0; k < 4; k++)
                        {
                            int j = m.Joints[v * 4 + k];
                            float w = m.Weights[v * 4 + k];
                            if (w > 0 && j >= 0 && j < m.Bones.Length && m.Bones[j] >= 0)
                                influences.Add((j, w));
                        }
                        influences.Sort((a, b) => b.weight.CompareTo(a.weight));
                        float sum = 0;
                        foreach (var x in influences)
                            sum += x.weight;
                        var bw = new BoneWeight();
                        if (influences.Count == 0 || sum <= 0)
                            influences = new List<(int, float)> { (0, 1f) };
                        else
                            for (int k = 0; k < influences.Count; k++)
                                influences[k] = (influences[k].bone, influences[k].weight / sum);
                        if (influences.Count > 0) { bw.boneIndex0 = influences[0].bone; bw.weight0 = influences[0].weight; }
                        if (influences.Count > 1) { bw.boneIndex1 = influences[1].bone; bw.weight1 = influences[1].weight; }
                        if (influences.Count > 2) { bw.boneIndex2 = influences[2].bone; bw.weight2 = influences[2].weight; }
                        if (influences.Count > 3) { bw.boneIndex3 = influences[3].bone; bw.weight3 = influences[3].weight; }
                        weights[v] = bw;
                    }
                    mesh.boneWeights = weights;
                    var bindposes = new Matrix4x4[m.Bones.Length];
                    var bones = new Transform[m.Bones.Length];
                    for (int j = 0; j < m.Bones.Length; j++)
                    {
                        var b = m.Bindposes[j];
                        bindposes[j] = new Matrix4x4(new Vector4(b[0], b[1], b[2], b[3]), new Vector4(b[4], b[5], b[6], b[7]),
                            new Vector4(b[8], b[9], b[10], b[11]), new Vector4(b[12], b[13], b[14], b[15]));
                        bones[j] = m.Bones[j] >= 0 ? nodes[m.Bones[j]] : root.transform;
                    }
                    mesh.bindposes = bindposes;
                    var go = new GameObject("skinned mesh");
                    go.transform.SetParent(root.transform, false);
                    var smr = go.AddComponent<SkinnedMeshRenderer>();
                    smr.sharedMesh = mesh;
                    smr.bones = bones;
                    smr.rootBone = root.transform;
                    smr.sharedMaterial = material;
                    smr.updateWhenOffscreen = true;
                }
                else
                {
                    var go = new GameObject("mesh");
                    go.transform.SetParent(nodes[m.Node], false);
                    go.AddComponent<MeshFilter>().sharedMesh = mesh;
                    go.AddComponent<MeshRenderer>().sharedMaterial = material;
                }
            }

            var channels = new RigPlayer.Channel[rig.Channels.Count];
            for (int i = 0; i < channels.Length; i++)
            {
                var c = rig.Channels[i];
                channels[i] = new RigPlayer.Channel { Path = paths[c.Node], Kind = c.Path == "translation" ? 0 : c.Path == "rotation" ? 1 : 2, Times = c.Times, Values = c.Values, Step = c.Step };
            }
            Registry[root.name] = new RigPlayer.Data { Channels = channels, Duration = Mathf.Max(rig.Duration, 0.01f) };
            root.AddComponent<RigPlayer>();
            Plugin.Log.LogInfo($"Animated object {parent.name}: {rig.Nodes.Count} nodes, {rig.Meshes.Count} meshes, {channels.Length} channels, {rig.Duration:0.00} s");
        }

        private static Mesh ToMesh(GlbReader.Primitive p, string name)
        {
            int count = p.Positions.Length / 3;
            var mesh = new Mesh { name = name };
            if (count > 65535)
                mesh.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
            var verts = new Vector3[count];
            for (int i = 0; i < count; i++)
                verts[i] = new Vector3(p.Positions[i * 3], p.Positions[i * 3 + 1], p.Positions[i * 3 + 2]);
            mesh.vertices = verts;
            if (p.Normals != null)
            {
                var normals = new Vector3[count];
                for (int i = 0; i < count; i++)
                    normals[i] = new Vector3(p.Normals[i * 3], p.Normals[i * 3 + 1], p.Normals[i * 3 + 2]);
                mesh.normals = normals;
            }
            if (p.Uvs != null)
            {
                var uvs = new Vector2[count];
                for (int i = 0; i < count; i++)
                    uvs[i] = new Vector2(p.Uvs[i * 2], p.Uvs[i * 2 + 1]);
                mesh.uv = uvs;
            }
            mesh.triangles = p.Indices;
            if (p.Normals == null)
                mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }
    }

    /// <summary>Plays a rig's clip on a loop. Copies start at different points so a row of them does not move in step.</summary>
    public class RigPlayer : MonoBehaviour
    {
        public class Channel
        {
            public string Path;
            public int Kind; // 0 position, 1 rotation, 2 scale
            public float[] Times;
            public float[] Values;
            public bool Step;
        }

        public class Data
        {
            public Channel[] Channels;
            public float Duration;
        }

        private Data data;
        private Transform[] targets;
        private float offset;

        private void Start()
        {
            if (!Rigs.Registry.TryGetValue(name, out data))
            {
                enabled = false;
                return;
            }
            targets = new Transform[data.Channels.Length];
            for (int i = 0; i < targets.Length; i++)
                targets[i] = transform.Find(data.Channels[i].Path);
            offset = UnityEngine.Random.value * data.Duration;
        }

        private void Update()
        {
            float t = (Time.time + offset) % data.Duration;
            for (int i = 0; i < targets.Length; i++)
            {
                var target = targets[i];
                if (target == null)
                    continue;
                var c = data.Channels[i];
                int n = c.Times.Length;
                if (n == 0)
                    continue;
                // The last key at or before t, and how far toward the next one.
                int lo = 0, hi = n - 1;
                if (t <= c.Times[0])
                    hi = 0;
                else if (t >= c.Times[n - 1])
                    lo = hi = n - 1;
                else
                {
                    while (hi - lo > 1)
                    {
                        int mid = (lo + hi) / 2;
                        if (c.Times[mid] <= t)
                            lo = mid;
                        else
                            hi = mid;
                    }
                }
                if (hi == 0)
                    lo = 0;
                float f = c.Step || hi == lo ? 0f : (t - c.Times[lo]) / Mathf.Max(c.Times[hi] - c.Times[lo], 1e-6f);
                if (c.Kind == 1)
                {
                    var a = new Quaternion(c.Values[lo * 4], c.Values[lo * 4 + 1], c.Values[lo * 4 + 2], c.Values[lo * 4 + 3]);
                    var b = new Quaternion(c.Values[hi * 4], c.Values[hi * 4 + 1], c.Values[hi * 4 + 2], c.Values[hi * 4 + 3]);
                    target.localRotation = Quaternion.Slerp(a, b, f);
                }
                else
                {
                    var a = new Vector3(c.Values[lo * 3], c.Values[lo * 3 + 1], c.Values[lo * 3 + 2]);
                    var b = new Vector3(c.Values[hi * 3], c.Values[hi * 3 + 1], c.Values[hi * 3 + 2]);
                    var v = Vector3.Lerp(a, b, f);
                    if (c.Kind == 0)
                        target.localPosition = v;
                    else
                        target.localScale = v;
                }
            }
        }
    }
}
