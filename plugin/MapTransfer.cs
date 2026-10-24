using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using HarmonyLib;
using Mirror;
using UnityEngine;

namespace SbgMaps
{
    /// <summary>
    /// Looks into the game's Steam transport (FizzyFacepunch) to see how many bytes are still queued on a player's
    /// connection, and raises Steam's conservative default send limits. Returns -1 when that isn't possible.
    /// </summary>
    internal static class SteamQueue
    {
        private static bool limitsRaised;
        private static System.Reflection.FieldInfo serverField, connMapField;
        private static System.Reflection.MethodInfo tryGetConnection;

        /// <summary>Lets Steam send faster than its default and buffer more (applies to connections made afterwards).</summary>
        public static void RaiseLimits()
        {
            if (limitsRaised)
                return;
            try
            {
                if (!Steamworks.SteamClient.IsValid)
                    return;
                Steamworks.SteamNetworkingUtils.SendRateMax = 16 * 1024 * 1024;
                Steamworks.SteamNetworkingUtils.SendBufferSize = 4 * 1024 * 1024;
                limitsRaised = true;
                Plugin.Log.LogInfo("Raised Steam send limits for map transfers");
            }
            catch (Exception e)
            {
                limitsRaised = true;
                Plugin.Log.LogWarning($"Could not raise Steam send limits: {e.Message}");
            }
        }

        public static int QueuedBytes(int connectionId)
        {
            try
            {
                if (!(Transport.active is Mirror.FizzySteam.FizzyFacepunch))
                    return -1;
                serverField ??= typeof(Mirror.FizzySteam.FizzyFacepunch).GetField("server", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
                var server = serverField?.GetValue(null);
                if (server == null)
                    return -1;
                connMapField ??= server.GetType().GetField("connToMirrorID", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                var map = connMapField?.GetValue(server);
                if (map == null)
                    return -1;
                // BidirectionalDictionary<Connection, int>.TryGetValue(int, out Connection)
                tryGetConnection ??= map.GetType().GetMethods().FirstOrDefault(m => m.Name == "TryGetValue" && m.GetParameters()[0].ParameterType == typeof(int));
                var args = new object[] { connectionId, null };
                if (tryGetConnection == null || !(bool)tryGetConnection.Invoke(map, args))
                    return -1;
                var status = ((Steamworks.Data.Connection)args[1]).QuickStatus();
                return status.PendingReliable + status.SentUnackedReliable;
            }
            catch
            {
                return -1;
            }
        }
    }

    /// <summary>
    /// Shares the host's custom maps with players in the lobby. On join the host sends its map list; players ask for
    /// any map they are missing (or have another version of) and receive it in chunks over the game's connection.
    /// Received maps are checked against the host's hash, saved to SbgMaps/maps/downloaded and added to the Custom
    /// Maps course straight away.
    /// </summary>
    internal static class MapTransfer
    {
        private const int ChunkSize = 16 * 1024;
        /// <summary>How much may be queued on a Steam connection before we wait for it to drain.</summary>
        private const int MaxInFlight = 384 * 1024;
        /// <summary>Pace for transports where we can't see the queue (LAN/KCP).</summary>
        private const int FallbackBytesPerSecond = 2 * 1024 * 1024;
        /// <summary>Largest map a player accepts from a host.</summary>
        private const long MaxMapBytes = 128L * 1024 * 1024;

        public struct MapListMessage : NetworkMessage
        {
            public string[] ids;
            public string[] hashes;
            public long[] sizes;
        }

        public struct MapRequestMessage : NetworkMessage
        {
            public string id;
        }

        public struct MapChunkMessage : NetworkMessage
        {
            public string id;
            public int index;
            public int total;
            public byte[] data;
        }

        static MapTransfer()
        {
            // Our assembly is not processed by Mirror's weaver, so give it the serializers by hand.
            Writer<MapListMessage>.write = (w, m) =>
            {
                w.WriteInt(m.ids.Length);
                for (int i = 0; i < m.ids.Length; i++)
                {
                    w.WriteString(m.ids[i]);
                    w.WriteString(m.hashes[i]);
                    w.WriteLong(m.sizes[i]);
                }
            };
            Reader<MapListMessage>.read = r =>
            {
                int n = Mathf.Clamp(r.ReadInt(), 0, 1000);
                var m = new MapListMessage { ids = new string[n], hashes = new string[n], sizes = new long[n] };
                for (int i = 0; i < n; i++)
                {
                    m.ids[i] = r.ReadString();
                    m.hashes[i] = r.ReadString();
                    m.sizes[i] = r.ReadLong();
                }
                return m;
            };
            Writer<MapRequestMessage>.write = (w, m) => w.WriteString(m.id);
            Reader<MapRequestMessage>.read = r => new MapRequestMessage { id = r.ReadString() };
            Writer<MapChunkMessage>.write = (w, m) =>
            {
                w.WriteString(m.id);
                w.WriteInt(m.index);
                w.WriteInt(m.total);
                w.WriteBytesAndSize(m.data);
            };
            Reader<MapChunkMessage>.read = r => new MapChunkMessage { id = r.ReadString(), index = r.ReadInt(), total = r.ReadInt(), data = r.ReadBytesAndSize() };
        }

        public static void Init()
        {
            // Touching the type runs the static constructor.
        }

        // ---------- host ----------

        private static readonly Dictionary<string, byte[]> zipCache = new Dictionary<string, byte[]>();

        public static void SendListTo(NetworkConnectionToClient conn)
        {
            var maps = MapLibrary.Maps;
            conn.Send(new MapListMessage
            {
                ids = maps.Select(m => m.Manifest.id).ToArray(),
                hashes = maps.Select(m => m.Hash).ToArray(),
                sizes = maps.Select(m => (long)ZipFor(m).Length).ToArray(),
            });
        }

        private static byte[] ZipFor(MapPack pack)
        {
            string key = pack.Manifest.id + "/" + pack.Hash;
            if (!zipCache.TryGetValue(key, out var bytes))
                zipCache[key] = bytes = pack.ToZipBytes();
            return bytes;
        }

        private static void OnRequest(NetworkConnectionToClient conn, MapRequestMessage msg)
        {
            var pack = MapLibrary.Find(msg.id);
            if (pack == null)
                return;
            var bytes = ZipFor(pack);
            Plugin.Log.LogInfo($"Sending map '{pack.Manifest.id}' ({bytes.Length / 1024} KB) to connection {conn.connectionId}");
            Plugin.Instance.StartCoroutine(SendChunks(conn, pack.Manifest.id, bytes));
        }

        private static IEnumerator SendChunks(NetworkConnectionToClient conn, string id, byte[] bytes)
        {
            int total = Mathf.Max(1, (bytes.Length + ChunkSize - 1) / ChunkSize);
            var started = Time.realtimeSinceStartup;
            float allowance = 0f;
            int i = 0;
            while (i < total)
            {
                // Stop if the player left or the lobby closed.
                if (!NetworkServer.active || !NetworkServer.connections.ContainsKey(conn.connectionId))
                    yield break;
                // Send as much as the connection can take right now. Steam drops messages that overflow its send
                // buffer, so with Steam we watch its queue; otherwise we keep to a fixed pace.
                int budget;
                int queued = SteamQueue.QueuedBytes(conn.connectionId);
                if (queued >= 0)
                    budget = MaxInFlight - queued;
                else
                {
                    allowance = Mathf.Min(allowance + FallbackBytesPerSecond * Time.unscaledDeltaTime, MaxInFlight);
                    budget = (int)allowance;
                }
                while (budget >= ChunkSize && i < total)
                {
                    int offset = i * ChunkSize;
                    int length = Math.Min(ChunkSize, bytes.Length - offset);
                    var data = new byte[length];
                    Buffer.BlockCopy(bytes, offset, data, 0, length);
                    conn.Send(new MapChunkMessage { id = id, index = i, total = total, data = data });
                    budget -= ChunkSize;
                    if (queued < 0)
                        allowance -= ChunkSize;
                    i++;
                }
                yield return null;
            }
            float seconds = Mathf.Max(0.001f, Time.realtimeSinceStartup - started);
            Plugin.Log.LogInfo($"Sent map '{id}' ({bytes.Length / 1024} KB) in {seconds:F1} s ({bytes.Length / 1024f / seconds:F0} KB/s)");
        }

        // ---------- player ----------

        private class Download
        {
            public float Started = Time.realtimeSinceStartup;
            public string Hash;
            public byte[][] Chunks;
            public int Received;
            public int LastReported;
        }

        private static readonly Dictionary<string, string> hostHashes = new Dictionary<string, string>();
        private static readonly Queue<string> queue = new Queue<string>();
        private static readonly Dictionary<string, Download> active = new Dictionary<string, Download>();
        private static List<string> hostOrder = new List<string>();

        private static void OnList(MapListMessage msg)
        {
            if (NetworkServer.active)
                return; // the host uses its own maps
            hostHashes.Clear();
            queue.Clear();
            active.Clear();
            hostOrder = msg.ids.ToList();
            var missing = new List<string>();
            for (int i = 0; i < msg.ids.Length; i++)
            {
                if (!SafeId(msg.ids[i]) || msg.sizes[i] > MaxMapBytes)
                    continue;
                hostHashes[msg.ids[i]] = msg.hashes[i];
                var local = MapLibrary.Find(msg.ids[i]);
                if (local == null || local.Hash != msg.hashes[i])
                    missing.Add(msg.ids[i]);
            }
            CustomCourse.UseHostMaps(hostOrder);
            if (missing.Count == 0)
                return;
            long totalBytes = missing.Sum(id => msg.sizes[Array.IndexOf(msg.ids, id)]);
            DevTools.Say($"Getting {missing.Count} map{(missing.Count == 1 ? "" : "s")} from the host ({totalBytes / 1024} KB)...");
            foreach (var id in missing)
                queue.Enqueue(id);
            RequestNext();
        }

        private static void RequestNext()
        {
            if (active.Count > 0 || queue.Count == 0)
                return;
            string id = queue.Dequeue();
            active[id] = new Download { Hash = hostHashes[id] };
            NetworkClient.Send(new MapRequestMessage { id = id });
        }

        private static void OnChunk(MapChunkMessage msg)
        {
            if (NetworkServer.active || !active.TryGetValue(msg.id, out var dl))
                return;
            if (msg.total <= 0 || (long)msg.total * ChunkSize > MaxMapBytes + ChunkSize || msg.index < 0 || msg.index >= msg.total)
            {
                Fail(msg.id, "the host sent a broken transfer");
                return;
            }
            dl.Chunks ??= new byte[msg.total][];
            if (dl.Chunks.Length != msg.total || dl.Chunks[msg.index] != null)
                return;
            dl.Chunks[msg.index] = msg.data;
            dl.Received++;
            int percent = dl.Received * 100 / msg.total;
            if (msg.total > 8 && percent / 25 > dl.LastReported / 25 && percent < 100)
            {
                dl.LastReported = percent;
                DevTools.Say($"Map '{msg.id}': {percent}%");
            }
            if (dl.Received == msg.total)
                Finish(msg.id, dl);
        }

        private static void Finish(string id, Download dl)
        {
            active.Remove(id);
            string final = Path.Combine(MapLibrary.DownloadsFolder, id + ".sbgmap");
            string part = final + ".part";
            try
            {
                Directory.CreateDirectory(MapLibrary.DownloadsFolder);
                using (var file = File.Create(part))
                    foreach (var chunk in dl.Chunks)
                        file.Write(chunk, 0, chunk.Length);
                var pack = MapPack.Load(part);
                if (pack.Hash != dl.Hash || pack.Manifest.id != id)
                {
                    File.Delete(part);
                    Fail(id, "it did not match the host's copy");
                    return;
                }
                if (File.Exists(final))
                    File.Delete(final);
                File.Move(part, final);
                MapLibrary.Replace(MapPack.Load(final));
                CustomCourse.UseHostMaps(hostOrder);
                float seconds = Mathf.Max(0.001f, Time.realtimeSinceStartup - dl.Started);
                long size = new FileInfo(final).Length;
                Plugin.Log.LogInfo($"Received map '{id}' ({size / 1024} KB) in {seconds:F1} s ({size / 1024f / seconds:F0} KB/s)");
                DevTools.Say($"Got map '{pack.Manifest.name}' from the host ({size / 1024} KB in {seconds:F1} s)");
            }
            catch (Exception e)
            {
                try
                {
                    File.Delete(part);
                }
                catch
                {
                    // nothing to clean up
                }
                Fail(id, e.Message);
            }
            RequestNext();
        }

        private static void Fail(string id, string why)
        {
            active.Remove(id);
            Plugin.Log.LogError($"Map download '{id}' failed: {why}");
            DevTools.Say($"Could not get map '{id}' from the host: {why}");
            RequestNext();
        }

        /// <summary>Map ids become file names, so only allow plain characters.</summary>
        private static bool SafeId(string id) => !string.IsNullOrEmpty(id) && id.Length <= 100 && Regex.IsMatch(id, @"^[A-Za-z0-9._-]+$") && !id.Contains("..");

        // ---------- hooks ----------

        [HarmonyPatch(typeof(NetworkManager), "RegisterServerMessages")]
        private static class RegisterServerPatch
        {
            private static void Postfix() => NetworkServer.ReplaceHandler<MapRequestMessage>(OnRequest);
        }

        public static void RegisterClientHandlers()
        {
            NetworkClient.ReplaceHandler<MapListMessage>(OnList, requireAuthentication: false);
            NetworkClient.ReplaceHandler<MapChunkMessage>(OnChunk, requireAuthentication: false);
        }
    }
}
