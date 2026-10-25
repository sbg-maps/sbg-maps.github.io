using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using HarmonyLib;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Rendering;

namespace SbgMaps
{
    /// <summary>
    /// The look of a vanilla hole's sky and air: skybox material, ambient light, sun, and the settings of its global
    /// post-processing volumes (the game's fog lives there). Saved once from each vanilla hole into SbgMaps/assets
    /// (sky-&lt;scene&gt;.json), then applied to custom holes that ask for that sky (hole "sky": "&lt;scene&gt;").
    /// </summary>
    internal static class SkyThemes
    {
        public class Theme
        {
            public string scene;
            public AssetCapture.MaterialData skybox;
            public int ambientMode;
            public float[] ambientSky, ambientEquator, ambientGround;
            public float ambientIntensity;
            public float[] ambientProbe; // 27 spherical harmonics coefficients
            public bool fog;
            public int fogMode;
            public float[] fogColor;
            public float fogDensity, fogStart, fogEnd;
            public float[] sunColor;
            public float sunIntensity;
            public float[] sunRotation;
            public List<VolumeData> volumes = new List<VolumeData>();
        }

        public class VolumeData
        {
            public string type;
            public bool active;
            /// <summary>Parameter field name to [overridden, kind, values...]; kind 0 float, 1 int, 2 bool, 3 color, 4 vector.</summary>
            public Dictionary<string, float[]> parameters = new Dictionary<string, float[]>();
        }

        public static string FileFor(string scene) => Path.Combine(AssetCapture.Folder, $"sky-{scene.Replace(' ', '_')}.json");

        // ---------- saving ----------

        /// <summary>
        /// Saves a vanilla hole's sky a moment after it loads, so maps can use the skies of the holes people have played
        /// (the public mod download ships without the game's skies). Custom holes on the donor scene are skipped.
        /// </summary>
        public static System.Collections.IEnumerator SaveWhenVanilla(string scene)
        {
            if (File.Exists(FileFor(scene)))
                yield break;
            yield return new WaitForSeconds(3f);
            if (UnityEngine.SceneManagement.SceneManager.GetActiveScene().name != scene)
                yield break;
            if (scene == MapBuilder.DonorScene && !string.IsNullOrEmpty(HoleSync.Current.mapId))
                yield break;
            SaveCurrent(scene);
        }

        /// <summary>Saves the current scene's sky and air, if it has not been saved before.</summary>
        public static void SaveCurrent(string scene)
        {
            if (File.Exists(FileFor(scene)))
                return;
            try
            {
                var theme = new Theme
                {
                    scene = scene,
                    skybox = RenderSettings.skybox != null ? AssetCapture.SaveMaterialData($"sky-{scene.Replace(' ', '_')}", RenderSettings.skybox) : null,
                    ambientMode = (int)RenderSettings.ambientMode,
                    ambientSky = C(RenderSettings.ambientSkyColor),
                    ambientEquator = C(RenderSettings.ambientEquatorColor),
                    ambientGround = C(RenderSettings.ambientGroundColor),
                    ambientIntensity = RenderSettings.ambientIntensity,
                    ambientProbe = SH(RenderSettings.ambientProbe),
                    fog = RenderSettings.fog,
                    fogMode = (int)RenderSettings.fogMode,
                    fogColor = C(RenderSettings.fogColor),
                    fogDensity = RenderSettings.fogDensity,
                    fogStart = RenderSettings.fogStartDistance,
                    fogEnd = RenderSettings.fogEndDistance,
                };
                var sun = Sun();
                if (sun != null)
                {
                    theme.sunColor = C(sun.color);
                    theme.sunIntensity = sun.intensity;
                    var e = sun.transform.eulerAngles;
                    theme.sunRotation = new[] { e.x, e.y, e.z };
                }
                foreach (var volume in UnityEngine.Object.FindObjectsByType<UnityEngine.Rendering.Volume>(FindObjectsSortMode.None).Where(v => v.isGlobal && v.sharedProfile != null))
                    foreach (var component in volume.sharedProfile.components)
                        theme.volumes.Add(SaveVolume(component));
                Directory.CreateDirectory(AssetCapture.Folder);
                File.WriteAllText(FileFor(scene), JsonConvert.SerializeObject(theme, Formatting.Indented));
                Plugin.Log.LogInfo($"Saved the sky of '{scene}' ({theme.volumes.Count} volume settings)");
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"Could not save the sky of '{scene}': {e}");
            }
        }

        private static Light Sun() =>
            RenderSettings.sun != null ? RenderSettings.sun : UnityEngine.Object.FindObjectsByType<Light>(FindObjectsSortMode.None).FirstOrDefault(l => l.type == LightType.Directional);

        private static VolumeData SaveVolume(VolumeComponent component)
        {
            var data = new VolumeData { type = component.GetType().FullName, active = component.active };
            foreach (var field in component.GetType().GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance))
            {
                if (!(field.GetValue(component) is VolumeParameter p))
                    continue;
                float o = p.overrideState ? 1f : 0f;
                switch (p)
                {
                    case VolumeParameter<float> f:
                        data.parameters[field.Name] = new[] { o, 0f, f.value };
                        break;
                    case VolumeParameter<int> i:
                        data.parameters[field.Name] = new[] { o, 1f, i.value };
                        break;
                    case VolumeParameter<bool> b:
                        data.parameters[field.Name] = new[] { o, 2f, b.value ? 1f : 0f };
                        break;
                    case VolumeParameter<Color> c:
                        data.parameters[field.Name] = new[] { o, 3f, c.value.r, c.value.g, c.value.b, c.value.a };
                        break;
                    case VolumeParameter<Vector4> v:
                        data.parameters[field.Name] = new[] { o, 4f, v.value.x, v.value.y, v.value.z, v.value.w };
                        break;
                }
            }
            return data;
        }

        private static float[] C(Color c) => new[] { c.r, c.g, c.b, c.a };

        private static float[] SH(SphericalHarmonicsL2 sh)
        {
            var a = new float[27];
            for (int ch = 0; ch < 3; ch++)
                for (int k = 0; k < 9; k++)
                    a[ch * 9 + k] = sh[ch, k];
            return a;
        }

        // ---------- applying ----------

        public static Theme Load(string scene)
        {
            try
            {
                string file = FileFor(scene);
                return File.Exists(file) ? JsonConvert.DeserializeObject<Theme>(File.ReadAllText(file)) : null;
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"Could not read the sky '{scene}': {e.Message}");
                return null;
            }
        }

        /// <summary>Gives the current (donor) scene the saved sky and air of another hole. False if it was never saved.</summary>
        public static bool Apply(string scene)
        {
            var theme = Load(scene);
            if (theme == null)
            {
                Plugin.Log.LogWarning($"The sky of '{scene}' is not saved on this computer (play that hole once, or get the mod's release zip)");
                return false;
            }
            if (theme.skybox != null)
                RenderSettings.skybox = AssetCapture.MaterialFor(theme.skybox, RenderSettings.skybox);
            RenderSettings.ambientMode = (AmbientMode)theme.ambientMode;
            RenderSettings.ambientSkyColor = Col(theme.ambientSky);
            RenderSettings.ambientEquatorColor = Col(theme.ambientEquator);
            RenderSettings.ambientGroundColor = Col(theme.ambientGround);
            RenderSettings.ambientIntensity = theme.ambientIntensity;
            if (theme.ambientProbe?.Length == 27)
            {
                var sh = new SphericalHarmonicsL2();
                for (int ch = 0; ch < 3; ch++)
                    for (int k = 0; k < 9; k++)
                        sh[ch, k] = theme.ambientProbe[ch * 9 + k];
                RenderSettings.ambientProbe = sh;
            }
            RenderSettings.fog = theme.fog;
            RenderSettings.fogMode = (FogMode)theme.fogMode;
            RenderSettings.fogColor = Col(theme.fogColor);
            RenderSettings.fogDensity = theme.fogDensity;
            RenderSettings.fogStartDistance = theme.fogStart;
            RenderSettings.fogEndDistance = theme.fogEnd;
            var sun = Sun();
            if (sun != null && theme.sunColor != null)
            {
                sun.color = Col(theme.sunColor);
                sun.intensity = theme.sunIntensity;
                sun.transform.rotation = Quaternion.Euler(theme.sunRotation[0], theme.sunRotation[1], theme.sunRotation[2]);
            }
            ApplyVolumes(theme.volumes);
            DynamicGI.UpdateEnvironment();
            Plugin.Log.LogInfo($"Sky: using the sky of '{scene}'");
            return true;
        }

        /// <summary>Sets the saved settings on this scene's global volumes (on their own copy of the profile).</summary>
        private static void ApplyVolumes(List<VolumeData> saved)
        {
            var volumes = UnityEngine.Object.FindObjectsByType<UnityEngine.Rendering.Volume>(FindObjectsSortMode.None).Where(v => v.isGlobal && v.sharedProfile != null).ToList();
            if (volumes.Count == 0)
                return;
            var profiles = volumes.Select(v => v.profile).ToList(); // .profile makes a scene copy
            foreach (var data in saved)
            {
                var type = AccessTools.TypeByName(data.type);
                if (type == null)
                    continue;
                // The volume that has this kind of setting, else the first one.
                var profile = profiles.FirstOrDefault(p => p.components.Any(c => c.GetType() == type)) ?? profiles[0];
                var component = profile.components.FirstOrDefault(c => c.GetType() == type);
                if (component == null)
                {
                    component = (VolumeComponent)ScriptableObject.CreateInstance(type);
                    profile.components.Add(component);
                    profile.isDirty = true;
                }
                component.active = data.active;
                foreach (var kv in data.parameters)
                {
                    var field = type.GetField(kv.Key);
                    if (!(field?.GetValue(component) is VolumeParameter p) || kv.Value.Length < 3)
                        continue;
                    p.overrideState = kv.Value[0] > 0.5f;
                    var v = kv.Value;
                    switch (p)
                    {
                        case VolumeParameter<float> f:
                            f.value = v[2];
                            break;
                        case VolumeParameter<int> i:
                            i.value = (int)v[2];
                            break;
                        case VolumeParameter<bool> b:
                            b.value = v[2] > 0.5f;
                            break;
                        case VolumeParameter<Color> c when v.Length >= 6:
                            c.value = new Color(v[2], v[3], v[4], v[5]);
                            break;
                        case VolumeParameter<Vector4> vec when v.Length >= 6:
                            vec.value = new Vector4(v[2], v[3], v[4], v[5]);
                            break;
                    }
                }
            }
        }

        /// <summary>
        /// A map's own sky: a panorama picture on a sphere around the camera, drawn behind everything. The game has no
        /// panoramic skybox shader, so the picture goes on an unlit sphere that follows the camera.
        /// </summary>
        public static void UsePicture(MapPack pack, string file)
        {
            try
            {
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, true) { name = file, wrapModeU = TextureWrapMode.Repeat, wrapModeV = TextureWrapMode.Clamp };
                if (!tex.LoadImage(pack.ReadFile(file)))
                    throw new IOException("not a picture");
                // URP's unlit shader can skip writing depth, so the level still draws over the sphere.
                var shader = Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Texture");
                var mat = new Material(shader) { name = "SbgMaps sky picture" };
                mat.SetTexture("_BaseMap", tex);
                mat.SetTexture("_MainTex", tex);
                mat.SetFloat("_Cull", 0f); // seen from inside: draw both sides
                mat.SetFloat("_ZWrite", 0f);
                // A small sphere drawn before everything else and writing no depth: the level draws over it, and it is
                // close enough that the scene's fog barely touches it. The game's own sky would paint over it, so it goes.
                mat.renderQueue = (int)RenderQueue.Background;
                RenderSettings.skybox = null;
                var dome = new GameObject("SbgMaps sky picture");
                dome.AddComponent<MeshFilter>().sharedMesh = SphereMesh();
                var r = dome.AddComponent<MeshRenderer>();
                r.sharedMaterial = mat;
                r.shadowCastingMode = ShadowCastingMode.Off;
                r.receiveShadows = false;
                dome.AddComponent<FollowCamera>();
                Plugin.Log.LogInfo($"Sky: using the map's picture '{file}' ({tex.width}x{tex.height})");
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"Could not use the sky picture '{file}': {e.Message}");
            }
        }

        /// <summary>A unit sphere with latitude-longitude UVs for an equirectangular picture.</summary>
        private static Mesh SphereMesh()
        {
            const int lon = 64, lat = 32;
            var verts = new List<Vector3>();
            var uvs = new List<Vector2>();
            var tris = new List<int>();
            for (int y = 0; y <= lat; y++)
                for (int x = 0; x <= lon; x++)
                {
                    float u = x / (float)lon, v = y / (float)lat;
                    float theta = u * Mathf.PI * 2f, phi = v * Mathf.PI;
                    verts.Add(new Vector3(-Mathf.Sin(phi) * Mathf.Sin(theta), -Mathf.Cos(phi), -Mathf.Sin(phi) * Mathf.Cos(theta)));
                    uvs.Add(new Vector2(u, v));
                }
            for (int y = 0; y < lat; y++)
                for (int x = 0; x < lon; x++)
                {
                    int a = y * (lon + 1) + x, b = a + lon + 1;
                    // Both sides, so it shows from inside whatever the shader culls.
                    tris.AddRange(new[] { a, a + 1, b, b, a + 1, b + 1, a, b, a + 1, b, b + 1, a + 1 });
                }
            var mesh = new Mesh { name = "SbgMaps sky sphere", indexFormat = IndexFormat.UInt32 };
            mesh.SetVertices(verts);
            mesh.SetUVs(0, uvs);
            mesh.SetTriangles(tris, 0);
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            return mesh;
        }

        /// <summary>Keeps the sky sphere centred on the camera.</summary>
        private class FollowCamera : MonoBehaviour
        {
            private void LateUpdate()
            {
                var cam = Camera.main;
                if (cam == null || !cam.isActiveAndEnabled)
                    cam = Camera.allCameras.Where(c => c.isActiveAndEnabled && c.targetTexture == null).OrderByDescending(c => c.depth).FirstOrDefault();
                if (cam == null)
                    return;
                transform.position = cam.transform.position;
                transform.localScale = Vector3.one * Mathf.Min(50f, cam.farClipPlane * 0.5f);
            }
        }

        private static Color Col(float[] a) => a != null && a.Length >= 4 ? new Color(a[0], a[1], a[2], a[3]) : Color.gray;
    }
}
