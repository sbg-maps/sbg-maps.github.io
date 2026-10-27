using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace SbgMaps
{
    /// <summary>
    /// Community maps: the list a group's pack bot keeps (its index.json), shown in Custom maps, so players fetch the
    /// maps they are missing with a click. The link is pasted once in Mod settings. Maps land in the downloaded folder
    /// like maps from a host, so the player's own copies still win and the title screen picks them up by itself.
    /// </summary>
    internal static class Community
    {
#pragma warning disable CS0649 // filled from JSON
        private class Index
        {
            public List<Entry> maps = new List<Entry>();
        }

        private class Entry
        {
            public string id, name, author, file, url, sha256;
            public int holes;
            public long size;
        }

#pragma warning restore CS0649

        private enum Status { Get, Update, Installed, OwnCopy }

        private static Index index;
        private static string loadedFrom;
        private static string error;
        private static bool loading;
        private static readonly Queue<Entry> queue = new Queue<Entry>();
        private static Entry downloading;
        private static UnityWebRequest request;
        private static string lastResult;
        private static Vector2 scroll;
        private static Dictionary<Entry, Status> statuses;
        private static float statusesAt = -10f;
        private static readonly Dictionary<string, (long size, long time, string sha)> hashes = new Dictionary<string, (long, long, string)>();

        /// <summary>The pack's address from whatever link was pasted: the page, the zip, index.json or one map.</summary>
        public static string BaseUrl(string link)
        {
            link = (link ?? "").Trim();
            if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || (uri.Scheme != "https" && uri.Scheme != "http"))
                return null;
            string path = uri.AbsolutePath;
            int maps = path.IndexOf("/maps/", StringComparison.Ordinal);
            if (maps >= 0)
                path = path.Substring(0, maps);
            else if (Path.HasExtension(path))
                path = path.Substring(0, path.LastIndexOf('/'));
            return $"{uri.Scheme}://{uri.Authority}{path.TrimEnd('/')}";
        }

        /// <summary>Called when Custom maps switches to the community list.</summary>
        public static void Opened()
        {
            string baseUrl = BaseUrl(Settings.CommunityLink.Value);
            if (baseUrl != null && baseUrl != loadedFrom && !loading)
                Plugin.Instance.StartCoroutine(Load(baseUrl));
        }

        private static IEnumerator Load(string baseUrl)
        {
            loading = true;
            error = null;
            using (var r = UnityWebRequest.Get(baseUrl + "/index.json"))
            {
                r.timeout = 20;
                yield return r.SendWebRequest();
                loading = false;
                if (r.result != UnityWebRequest.Result.Success)
                {
                    error = $"Could not reach the community list ({r.error}). The computer that shares it may be off.";
                    yield break;
                }
                try
                {
                    index = JsonConvert.DeserializeObject<Index>(r.downloadHandler.text) ?? new Index();
                    index.maps.RemoveAll(m => string.IsNullOrWhiteSpace(m?.id) || string.IsNullOrWhiteSpace(m.url));
                    loadedFrom = baseUrl;
                }
                catch (Exception e)
                {
                    error = "That link is not a community map list.";
                    Plugin.Log.LogWarning($"Community list at {baseUrl}: {e.Message}");
                }
            }
        }

        private static string Sha256(string path)
        {
            var info = new FileInfo(path);
            if (hashes.TryGetValue(path, out var known) && known.size == info.Length && known.time == info.LastWriteTimeUtc.Ticks)
                return known.sha;
            using var sha = SHA256.Create();
            using var stream = File.OpenRead(path);
            string hex = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            hashes[path] = (info.Length, info.LastWriteTimeUtc.Ticks, hex);
            return hex;
        }

        private static Status StatusOf(Entry e)
        {
            var pack = MapLibrary.Find(e.id);
            if (pack == null)
                return Status.Get;
            bool same = pack.IsZip && string.Equals(Sha256(pack.Path), e.sha256, StringComparison.OrdinalIgnoreCase);
            if (same)
                return Status.Installed;
            bool downloaded = Path.GetFullPath(pack.Path).StartsWith(Path.GetFullPath(MapLibrary.DownloadsFolder));
            return downloaded ? Status.Update : Status.OwnCopy;
        }

        private static void Enqueue(Entry e)
        {
            if (downloading != e && !queue.Contains(e))
                queue.Enqueue(e);
            if (downloading == null)
                Plugin.Instance.StartCoroutine(DownloadAll());
        }

        private static IEnumerator DownloadAll()
        {
            while (queue.Count > 0)
            {
                downloading = queue.Dequeue();
                yield return Download(downloading);
            }
            downloading = null;
            request = null;
        }

        private static IEnumerator Download(Entry e)
        {
            string safe = new string(e.id.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray());
            string final = Path.Combine(MapLibrary.DownloadsFolder, safe + ".sbgmap");
            string part = final + ".part";
            Directory.CreateDirectory(MapLibrary.DownloadsFolder);
            float started = Time.realtimeSinceStartup;
            using (request = new UnityWebRequest(e.url, UnityWebRequest.kHttpVerbGET, new DownloadHandlerFile(part) { removeFileOnAbort = true }, null))
            {
                yield return request.SendWebRequest();
                if (request.result != UnityWebRequest.Result.Success)
                {
                    lastResult = $"Could not download {e.name}: {request.error}";
                    TryDelete(part);
                    yield break;
                }
            }
            try
            {
                if (!string.IsNullOrEmpty(e.sha256) && !string.Equals(Sha256(part), e.sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("the file arrived damaged");
                var pack = MapPack.Load(part);
                if (pack.Manifest.id != e.id)
                    throw new InvalidDataException("it is a different map than the list says");
                if (File.Exists(final))
                    File.Delete(final);
                File.Move(part, final);
                float seconds = Mathf.Max(0.001f, Time.realtimeSinceStartup - started);
                lastResult = $"Got {e.name} ({Size(e.size)} in {seconds:F0} s)";
                Plugin.Log.LogInfo($"Community map '{e.id}' downloaded from {e.url} ({e.size / 1024} KB in {seconds:F1} s)");
                MapWatcher.CheckNow();
            }
            catch (Exception ex)
            {
                lastResult = $"Could not use {e.name}: {ex.Message}";
                Plugin.Log.LogWarning($"Community map '{e.id}' from {e.url}: {ex}");
                TryDelete(part);
            }
        }

        private static void TryDelete(string path)
        {
            try
            {
                File.Delete(path);
            }
            catch
            {
                // nothing to clean up
            }
        }

        /// <summary>Dev autorun ("community &lt;link&gt;"): fetches every missing map, logs the outcome and quits.</summary>
        public static IEnumerator AutoTest(string link)
        {
            Settings.CommunityLink.Value = link;
            Opened();
            yield return new WaitWhile(() => loading);
            Plugin.Log.LogInfo($"Autorun community: {index?.maps.Count ?? -1} maps listed, error: {error ?? "none"}");
            if (index != null)
            {
                foreach (var m in index.maps.Where(m => StatusOf(m) == Status.Get || StatusOf(m) == Status.Update))
                    Enqueue(m);
                yield return new WaitWhile(() => downloading != null);
                MapWatcher.CheckNow();
                foreach (var m in index.maps)
                    Plugin.Log.LogInfo($"Autorun community: {m.id} {StatusOf(m)}");
                Plugin.Log.LogInfo($"Autorun community: last result: {lastResult}");
            }
            Plugin.Log.LogInfo("Autorun: done, quitting");
            Application.Quit();
        }

        private static string Size(long bytes) => bytes >= 1024 * 1024 ? $"{bytes / (1024f * 1024f):F0} MB" : $"{Math.Max(1, bytes / 1024)} KB";

        /// <summary>The community list inside the Custom maps window. False when the player asks to go to Mod settings.</summary>
        public static bool Draw(GUIStyle row, GUIStyle note)
        {
            if (BaseUrl(Settings.CommunityLink.Value) == null)
            {
                GUILayout.FlexibleSpace();
                GUILayout.Label("Paste your group's community maps link in Mod settings. The pack bot posts it in your Discord's map thread.", note);
                GUILayout.Space(8);
                bool stay = !GUILayout.Button("Mod settings", row, GUILayout.Height(40));
                GUILayout.FlexibleSpace();
                return stay;
            }
            if (loading || index == null)
            {
                GUILayout.FlexibleSpace();
                GUILayout.Label(loading ? "Loading the community list..." : error ?? "", note);
                if (!loading && GUILayout.Button("Try again", row, GUILayout.Height(40)))
                {
                    loadedFrom = null;
                    Opened();
                }
                GUILayout.FlexibleSpace();
                return true;
            }

            if (statuses == null || Time.realtimeSinceStartup - statusesAt > 1f || statuses.Count != index.maps.Count)
            {
                statuses = index.maps.ToDictionary(m => m, StatusOf);
                statusesAt = Time.realtimeSinceStartup;
            }
            var missing = index.maps.Where(m => statuses[m] == Status.Get || statuses[m] == Status.Update).ToList();
            if (downloading != null && request != null)
            {
                float done = Mathf.Clamp01(request.downloadProgress);
                GUILayout.Label($"Downloading {downloading.name}: {Mathf.RoundToInt(done * 100)}% of {Size(downloading.size)}{(queue.Count > 0 ? $", {queue.Count} more after it" : "")}", note);
            }
            else if (lastResult != null)
                GUILayout.Label(lastResult, note);
            else
                GUILayout.Label(missing.Count == 0 ? "You have every community map." : $"{missing.Count} of {index.maps.Count} maps to get.", note);

            GUILayout.BeginHorizontal();
            GUI.enabled = missing.Count > 0;
            if (GUILayout.Button(missing.Count > 0 ? $"Get all missing ({Size(missing.Sum(m => m.size))})" : "Get all missing", row, GUILayout.Height(40)))
                foreach (var m in missing)
                    Enqueue(m);
            GUI.enabled = downloading == null;
            if (GUILayout.Button("Refresh", row, GUILayout.Height(40), GUILayout.Width(120)))
            {
                loadedFrom = null;
                lastResult = null;
                Opened();
            }
            GUI.enabled = true;
            GUILayout.EndHorizontal();
            GUILayout.Space(6);

            scroll = GUILayout.BeginScrollView(scroll);
            foreach (var m in index.maps.OrderBy(m => m.name, StringComparer.OrdinalIgnoreCase))
            {
                var status = statuses[m];
                bool busy = downloading == m || queue.Contains(m);
                string state = busy ? "Downloading" : status switch
                {
                    Status.Get => "Get",
                    Status.Update => "Update",
                    Status.Installed => "Installed",
                    _ => "Your own copy",
                };
                string by = string.IsNullOrWhiteSpace(m.author) ? "" : $" by {m.author}";
                GUILayout.BeginHorizontal();
                GUILayout.Label($"{m.name}{by}   {m.holes} hole{(m.holes == 1 ? "" : "s")}, {Size(m.size)}", row, GUILayout.Height(40));
                GUI.enabled = !busy && (status == Status.Get || status == Status.Update);
                if (GUILayout.Button(state, row, GUILayout.Height(40), GUILayout.Width(150)))
                    Enqueue(m);
                GUI.enabled = true;
                GUILayout.EndHorizontal();
            }
            GUILayout.EndScrollView();
            return true;
        }
    }
}
