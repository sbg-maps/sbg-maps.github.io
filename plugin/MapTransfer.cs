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
    /// Shares the host's custom maps with players in the lobby. On join (and when the host's maps change) the host
    /// sends its map list, its community maps link and its hole numbers. Players get what they are missing (or have
    /// another version of) from the community link, which is fast; a map that is not there comes in chunks over the
    /// game's connection instead. Maps are checked against the host's hash, saved to SbgMaps/maps/downloaded and
    /// added to the Custom Maps course straight away.
    /// </summary>
    internal static class MapTransfer
    {
        private const int ChunkSize = 16 * 1024;
        /// <summary>
        /// How much may be sent and not yet confirmed by the player. The player confirms every few chunks, so this
        /// paces the transfer to what actually arrives, whatever the transport (Steam drops messages that overflow
        /// its send buffer, and that dropped players before).
        /// </summary>
        private const int Window = 512 * 1024;
        /// <summary>
        /// Most map data handed to one player per frame. Mirror packs everything sent to a player in a frame into one
        /// Steam message, and Steam refuses messages over 512 KB; the game's transport then drops that player.
        /// </summary>
        private const int MaxBytesPerFrame = 128 * 1024;
        private const int AckEvery = 8;
        /// <summary>Give up on a player who confirms nothing for this long.</summary>
        private const float StallSeconds = 30f;
        /// <summary>Largest map a player accepts from a host.</summary>
        private const long MaxMapBytes = 128L * 1024 * 1024;

        public struct MapListMessage : NetworkMessage
        {
            public string[] ids;
            public string[] hashes;
            public long[] sizes;
            public string version; // the host's SbgMaps version
            public string link; // the host's community maps link, from 0.7.0
            public int[][] indices; // the host's global number of every hole of each map, from 0.7.0
        }

        /// <summary>Player to host, answering the map list: its SbgMaps version and the maps it is going to fetch.</summary>
        public struct ClientInfoMessage : NetworkMessage
        {
            public string version;
            public string[] needs;
        }

        /// <summary>Player to host: how many chunks of a map have arrived.</summary>
        public struct MapAckMessage : NetworkMessage
        {
            public string id;
            public int received;
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
                w.WriteString(m.version);
                // Newer fields go last: older players stop reading before them.
                w.WriteString(m.link ?? "");
                w.WriteInt(m.indices?.Length ?? 0);
                foreach (var numbers in m.indices ?? new int[0][])
                {
                    w.WriteInt(numbers.Length);
                    foreach (int n in numbers)
                        w.WriteInt(n);
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
                m.version = r.Remaining > 0 ? r.ReadString() : "0.0.1";
                m.link = r.Remaining > 0 ? r.ReadString() : "";
                if (r.Remaining > 0)
                {
                    m.indices = new int[Mathf.Clamp(r.ReadInt(), 0, 1000)][];
                    for (int i = 0; i < m.indices.Length; i++)
                    {
                        m.indices[i] = new int[Mathf.Clamp(r.ReadInt(), 0, 1000)];
                        for (int j = 0; j < m.indices[i].Length; j++)
                            m.indices[i][j] = r.ReadInt();
                    }
                }
                return m;
            };
            Writer<ClientInfoMessage>.write = (w, m) =>
            {
                w.WriteString(m.version);
                w.WriteInt(m.needs.Length);
                foreach (var id in m.needs)
                    w.WriteString(id);
            };
            Reader<ClientInfoMessage>.read = r =>
            {
                var m = new ClientInfoMessage { version = r.ReadString() };
                m.needs = new string[Mathf.Clamp(r.ReadInt(), 0, 1000)];
                for (int i = 0; i < m.needs.Length; i++)
                    m.needs[i] = r.ReadString();
                return m;
            };
            Writer<MapAckMessage>.write = (w, m) =>
            {
                w.WriteString(m.id);
                w.WriteInt(m.received);
            };
            Reader<MapAckMessage>.read = r => new MapAckMessage { id = r.ReadString(), received = r.ReadInt() };
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
            var maps = MapLibrary.Maps.Where(m => !m.IsPrivate).ToList();
            conn.Send(new MapListMessage
            {
                ids = maps.Select(m => m.Manifest.id).ToArray(),
                hashes = maps.Select(m => m.Hash).ToArray(),
                sizes = maps.Select(m => (long)ZipFor(m).Length).ToArray(),
                version = Plugin.Version,
                link = Community.BaseUrl(Settings.CommunityLink.Value) ?? "",
                indices = maps.Select(CustomCourse.GlobalIndices).ToArray(),
            });
        }

        /// <summary>After the host's maps changed in the lobby: everyone gets the new list and fetches what is new.</summary>
        public static void SendListToAll()
        {
            foreach (var conn in NetworkServer.connections.Values.ToList())
                if (conn != NetworkServer.localConnection)
                    SendListTo(conn);
        }

        /// <summary>Per player: the maps it still has to get, and how far each running send has been confirmed.</summary>
        private class Peer
        {
            public string Version;
            public readonly HashSet<string> Needs = new HashSet<string>();
            public readonly Dictionary<string, int> Acked = new Dictionary<string, int>();
            public readonly Dictionary<string, int> Totals = new Dictionary<string, int>();
        }

        private static readonly Dictionary<int, Peer> peers = new Dictionary<int, Peer>();

        private static Peer PeerOf(NetworkConnectionToClient conn)
        {
            if (!peers.TryGetValue(conn.connectionId, out var peer))
                peers[conn.connectionId] = peer = new Peer();
            return peer;
        }

        private static void OnClientInfo(NetworkConnectionToClient conn, ClientInfoMessage msg)
        {
            var peer = PeerOf(conn);
            bool had = peer.Needs.Count > 0;
            peer.Version = msg.version;
            peer.Needs.Clear();
            peer.Needs.UnionWith(msg.needs.Where(SafeId));
            string who = PlayerName(conn);
            if (msg.version != Plugin.Version)
                DevTools.Say($"{who} has SbgMaps {msg.version}, you have {Plugin.Version}. Use the same version, or holes may differ.");
            // Players say again as each map arrives; only the start is news.
            if (peer.Needs.Count > 0 && !had)
                DevTools.Say($"{who} is getting {peer.Needs.Count} map{(peer.Needs.Count == 1 ? "" : "s")}");
        }

        private static void OnAck(NetworkConnectionToClient conn, MapAckMessage msg)
        {
            var peer = PeerOf(conn);
            if (!peer.Acked.TryGetValue(msg.id, out int acked) || msg.received <= acked)
                return;
            peer.Acked[msg.id] = msg.received;
            if (peer.Totals.TryGetValue(msg.id, out int total) && msg.received >= total)
                peer.Needs.Remove(msg.id);
        }

        /// <summary>
        /// Is a player still getting this map? Then the hole must wait, or that player loads it without the map.
        /// </summary>
        public static bool IsAnyoneGetting(string mapId, out string status)
        {
            status = null;
            foreach (var kv in peers.ToList())
            {
                if (!NetworkServer.connections.TryGetValue(kv.Key, out var conn))
                {
                    peers.Remove(kv.Key);
                    continue;
                }
                if (!kv.Value.Needs.Contains(mapId))
                    continue;
                // Maps from the community link report no progress to the host, only when they are done.
                status = kv.Value.Totals.TryGetValue(mapId, out int total) && total > 0 && kv.Value.Acked.TryGetValue(mapId, out int acked)
                    ? $"{PlayerName(conn)} ({acked * 100 / total}%)" : PlayerName(conn);
                return true;
            }
            return false;
        }

        private static string PlayerName(NetworkConnectionToClient conn)
        {
            try
            {
                var id = conn.identity != null ? conn.identity.GetComponent<PlayerId>() : null;
                if (id != null && !string.IsNullOrEmpty(id.PlayerName))
                    return id.PlayerName;
            }
            catch
            {
                // fall back to the connection number
            }
            return $"Player {conn.connectionId}";
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
            if (pack == null || pack.IsPrivate)
                return;
            var bytes = ZipFor(pack);
            Plugin.Log.LogInfo($"Sending map '{pack.Manifest.id}' ({bytes.Length / 1024} KB) to connection {conn.connectionId}");
            Plugin.Instance.StartCoroutine(SendChunks(conn, pack.Manifest.id, bytes));
        }

        private static IEnumerator SendChunks(NetworkConnectionToClient conn, string id, byte[] bytes)
        {
            int total = Mathf.Max(1, (bytes.Length + ChunkSize - 1) / ChunkSize);
            var peer = PeerOf(conn);
            peer.Needs.Add(id);
            peer.Totals[id] = total;
            peer.Acked[id] = 0;
            var started = Time.realtimeSinceStartup;
            float lastProgress = started;
            int lastAcked = 0;
            int i = 0;
            while (peer.Acked[id] < total)
            {
                // Stop if the player left or the lobby closed.
                if (!NetworkServer.active || !NetworkServer.connections.ContainsKey(conn.connectionId))
                    yield break;
                int acked = peer.Acked[id];
                if (acked != lastAcked)
                    (lastAcked, lastProgress) = (acked, Time.realtimeSinceStartup);
                else if (Time.realtimeSinceStartup - lastProgress > StallSeconds)
                {
                    peer.Needs.Remove(id);
                    Plugin.Log.LogError($"Map '{id}' to connection {conn.connectionId}: nothing confirmed for {StallSeconds:F0} s, giving up at {acked}/{total}");
                    DevTools.Say($"Could not send map '{id}' to {PlayerName(conn)}; they can install it by hand");
                    yield break;
                }
                // Keep at most a window of unconfirmed data on the way, and little enough per frame.
                int sentThisFrame = 0;
                while (i < total && (i - acked) * ChunkSize < Window && sentThisFrame < MaxBytesPerFrame)
                {
                    int offset = i * ChunkSize;
                    int length = Math.Min(ChunkSize, bytes.Length - offset);
                    var data = new byte[length];
                    Buffer.BlockCopy(bytes, offset, data, 0, length);
                    conn.Send(new MapChunkMessage { id = id, index = i, total = total, data = data });
                    sentThisFrame += length;
                    i++;
                }
                yield return null;
            }
            peer.Needs.Remove(id);
            float seconds = Mathf.Max(0.001f, Time.realtimeSinceStartup - started);
            Plugin.Log.LogInfo($"Sent map '{id}' ({bytes.Length / 1024} KB) in {seconds:F1} s ({bytes.Length / 1024f / seconds:F0} KB/s)");
        }

        // ---------- progress bar ----------

        private static GUIStyle barLabel;

        /// <summary>A bar at the top of the screen for every map on its way: to this player, or from this host.</summary>
        public static void DrawProgress()
        {
            var bars = new List<(string label, float done)>();
            if (Community.Progress(out string communityMap, out float communityDone))
                bars.Add(($"Getting map '{communityMap}'", communityDone));
            foreach (var kv in active)
                if (kv.Value.Chunks != null)
                    bars.Add(($"Getting map '{kv.Key}' from the host", kv.Value.Received / (float)kv.Value.Chunks.Length));
            if (NetworkServer.active)
                foreach (var kv in peers)
                    if (NetworkServer.connections.TryGetValue(kv.Key, out var conn))
                        foreach (var id in kv.Value.Needs)
                            if (kv.Value.Totals.TryGetValue(id, out int total) && total > 0)
                                bars.Add(($"Sending map '{id}' to {PlayerName(conn)}", kv.Value.Acked.TryGetValue(id, out int acked) ? acked / (float)total : 0f));
            if (bars.Count == 0)
                return;
            barLabel ??= new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontSize = 18, fontStyle = FontStyle.Bold };
            float width = Mathf.Min(560f, Screen.width - 40f), x = (Screen.width - width) / 2f, y = 16f;
            foreach (var (label, done) in bars)
            {
                GUI.color = new Color(0f, 0f, 0f, 0.6f);
                GUI.DrawTexture(new Rect(x, y, width, 34f), Texture2D.whiteTexture);
                GUI.color = new Color(0.35f, 0.8f, 0.3f, 0.95f);
                GUI.DrawTexture(new Rect(x + 3f, y + 3f, (width - 6f) * Mathf.Clamp01(done), 28f), Texture2D.whiteTexture);
                GUI.color = Color.white;
                GUI.Label(new Rect(x, y, width, 34f), $"{label}  {Mathf.FloorToInt(done * 100f)}%", barLabel);
                y += 40f;
            }
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

        private static List<int[]> hostIndices;
        /// <summary>Maps this player still has to get for the host's lobby.</summary>
        private static readonly HashSet<string> pending = new HashSet<string>();
        /// <summary>Maps asked of the community link and not answered yet.</summary>
        private static readonly HashSet<string> fetching = new HashSet<string>();

        private static void OnList(MapListMessage msg)
        {
            if (NetworkServer.active)
                return; // the host uses its own maps
            hostHashes.Clear();
            hostOrder = msg.ids.ToList();
            hostIndices = msg.indices?.ToList();
            var missing = new List<string>();
            var sizes = new Dictionary<string, long>();
            for (int i = 0; i < msg.ids.Length; i++)
            {
                if (!SafeId(msg.ids[i]) || msg.sizes[i] > MaxMapBytes)
                    continue;
                hostHashes[msg.ids[i]] = msg.hashes[i];
                sizes[msg.ids[i]] = msg.sizes[i];
                var local = MapLibrary.Find(msg.ids[i]);
                if (local == null || local.Hash != msg.hashes[i])
                    missing.Add(msg.ids[i]);
            }
            // A list sent again (the host's maps changed) keeps what is already on its way.
            foreach (var id in active.Keys.ToList())
                if (!missing.Contains(id) || active[id].Hash != hostHashes[id])
                    active.Remove(id);
            var stillQueued = queue.Where(missing.Contains).ToList();
            queue.Clear();
            foreach (var id in stillQueued)
                queue.Enqueue(id);
            var fresh = missing.Where(id => !fetching.Contains(id) && !active.ContainsKey(id) && !queue.Contains(id)).ToList();
            pending.Clear();
            pending.UnionWith(missing);
            RefreshCourse();
            if (msg.version != Plugin.Version)
                DevTools.Say($"The host has SbgMaps {msg.version}, you have {Plugin.Version}. Use the same version, or holes may differ.");
            NetworkClient.Send(new ClientInfoMessage { version = Plugin.Version, needs = missing.ToArray() });
            if (fresh.Count == 0)
                return;
            long totalBytes = fresh.Sum(id => sizes[id]);
            DevTools.Say($"Getting {fresh.Count} map{(fresh.Count == 1 ? "" : "s")} for this lobby ({totalBytes / 1024} KB)...");

            string hostLink = Community.BaseUrl(msg.link);
            string ownLink = Community.BaseUrl(Settings.CommunityLink.Value);
            if (hostLink != null && ownLink == null)
            {
                Settings.CommunityLink.Value = hostLink; // the host's group: their community maps from now on
                Plugin.Log.LogInfo($"Using the host's community maps link {hostLink}");
            }
            string link = hostLink ?? ownLink;
            if (link == null)
            {
                foreach (var id in fresh)
                    queue.Enqueue(id);
                RequestNext();
                return;
            }
            fetching.UnionWith(fresh);
            Community.FetchForLobby(link, fresh, OnFetched);
        }

        /// <summary>A map from the community link arrived (path) or could not be had there (null): then the host sends it.</summary>
        private static void OnFetched(string id, string path)
        {
            fetching.Remove(id);
            if (NetworkServer.active || !NetworkClient.active || !pending.Contains(id) || !hostHashes.TryGetValue(id, out var hash))
                return;
            if (path != null)
            {
                try
                {
                    var pack = MapPack.Load(path);
                    if (pack.Hash == hash)
                    {
                        MapLibrary.Replace(pack);
                        Arrived(id);
                        DevTools.Say($"Got map '{pack.Manifest.name}'");
                        return;
                    }
                    Plugin.Log.LogInfo($"The community copy of '{id}' differs from the host's; getting the host's");
                }
                catch (Exception e)
                {
                    Plugin.Log.LogWarning($"Community copy of '{id}': {e.Message}");
                }
            }
            if (!active.ContainsKey(id) && !queue.Contains(id))
                queue.Enqueue(id);
            RequestNext();
        }

        /// <summary>A map for the lobby is here: into the course, and the host hears it is one less to wait for.</summary>
        private static void Arrived(string id)
        {
            pending.Remove(id);
            RefreshCourse();
            NetworkClient.Send(new ClientInfoMessage { version = Plugin.Version, needs = pending.ToArray() });
        }

        /// <summary>The course as the host has it: its maps, numbered its way, and match setup to match.</summary>
        public static void RefreshCourse()
        {
            CustomCourse.UseHostMaps(hostOrder, hostIndices);
            MatchSetupSplit.Sync();
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
            if (dl.Received % AckEvery == 0 || dl.Received == msg.total)
                NetworkClient.Send(new MapAckMessage { id = msg.id, received = dl.Received });
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
                Arrived(id);
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
            private static void Postfix()
            {
                NetworkServer.ReplaceHandler<MapRequestMessage>(OnRequest);
                NetworkServer.ReplaceHandler<ClientInfoMessage>(OnClientInfo);
                NetworkServer.ReplaceHandler<MapAckMessage>(OnAck);
            }
        }

        public static void RegisterClientHandlers()
        {
            NetworkClient.ReplaceHandler<MapListMessage>(OnList, requireAuthentication: false);
            NetworkClient.ReplaceHandler<MapChunkMessage>(OnChunk, requireAuthentication: false);
        }
    }
}
