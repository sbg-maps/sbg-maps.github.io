using System;
using System.IO;
using System.Linq;
using BepInEx;
using FMODUnity;
using HarmonyLib;

namespace SbgMaps
{
    /// <summary>
    /// Custom holes can bring their own song (map.json "music", or a hole's own "music"): a file inside the map.
    /// It replaces the hole music the game would play, goes through the game's Music bus (so the music volume
    /// slider applies) and loops. "Hurry up" speeds it up a little, since a plain file has no hurry-up version.
    /// Every player has the map (the host sends it), so each one plays the song locally.
    /// </summary>
    [HarmonyPatch]
    internal static class HoleMusic
    {
        private const float HurryPitch = 1.12f;
        private const float FadeSeconds = 1f;

        private static FMOD.Sound sound;
        private static FMOD.Channel channel;
        private static FMOD.Sound fading;

        private static string CacheFolder => Path.Combine(Paths.GameRootPath, "SbgMaps", "cache");

        [HarmonyPrefix, HarmonyPatch(typeof(CourseManager), "TryPlayHoleMusic")]
        private static bool PlayPrefix(int ___currentHoleGlobalIndex, ref bool ___isPlayingHoleMusic, bool hurryUpInstantly)
        {
            if (___isPlayingHoleMusic || SingletonBehaviour<DrivingRangeManager>.HasInstance || ___currentHoleGlobalIndex < 0)
                return true;
            try
            {
                var hole = GameManager.AllCourses.allHoles[___currentHoleGlobalIndex];
                if (!CustomCourse.TryGetMapHole(hole, out var pack, out int index))
                    return true;
                string file = pack.Manifest.holes[index].music ?? pack.Manifest.music;
                if (string.IsNullOrEmpty(file))
                    return true;
                Play(CachedPath(pack, file), hurryUpInstantly);
                ___isPlayingHoleMusic = true;
                return false;
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"Could not play the map's music, using the game's: {e.Message}");
                return true;
            }
        }

        [HarmonyPrefix, HarmonyPatch(typeof(CourseManager), "HurryUpHoleMusic")]
        private static bool HurryPrefix()
        {
            if (!IsPlaying)
                return true;
            channel.setPitch(HurryPitch);
            return false;
        }

        [HarmonyPostfix, HarmonyPatch(typeof(CourseManager), "OnDestroy")]
        private static void StopPostfix() => Stop();

        /// <summary>Any scene change ends the hole, so the song too (a new hole starts its own after loading).</summary>
        public static void OnSceneLoaded() => Stop();

        /// <summary>
        /// The mod is being unloaded (a hot reload): stop at once. The handles are also kept in the AppDomain,
        /// so a reloaded copy of the mod can still stop a song an older copy started.
        /// </summary>
        public static void OnUnload() => Stop(fade: false);

        private const string SharedKey = "SbgMaps.HoleMusic.handles";

        private static bool IsPlaying => channel.hasHandle() && channel.isPlaying(out bool playing) == FMOD.RESULT.OK && playing;

        /// <summary>FMOD streams from a file, so the song is unpacked once per map version into SbgMaps/cache.</summary>
        private static string CachedPath(MapPack pack, string file)
        {
            string name = $"{pack.Hash.Substring(0, 16)}-{string.Concat(Path.GetFileName(file).Select(c => char.IsLetterOrDigit(c) || c == '.' || c == '-' ? c : '_'))}";
            string path = Path.Combine(CacheFolder, name);
            if (!File.Exists(path))
            {
                Directory.CreateDirectory(CacheFolder);
                File.WriteAllBytes(path + ".part", pack.ReadFile(file));
                File.Move(path + ".part", path);
            }
            return path;
        }

        private static void Play(string path, bool hurry)
        {
            Stop();
            var core = RuntimeManager.CoreSystem;
            Check(core.createSound(path, FMOD.MODE.CREATESTREAM | FMOD.MODE.LOOP_NORMAL | FMOD.MODE._2D, out sound), "open");
            var bus = RuntimeManager.GetBus("bus:/Music");
            bus.lockChannelGroup();
            RuntimeManager.StudioSystem.flushCommands();
            bus.getChannelGroup(out var group);
            Check(core.playSound(sound, group, false, out channel), "play");
            AppDomain.CurrentDomain.SetData(SharedKey, new[] { channel.handle, sound.handle });
            if (hurry)
                channel.setPitch(HurryPitch);
        }

        /// <summary>Fades the song out over a second; the sound is released when the next one starts.</summary>
        private static void Stop(bool fade = true)
        {
            if (fading.hasHandle())
                fading.release();
            fading = default;
            // A song started by an earlier copy of the mod (before a hot reload) that this copy does not know about.
            if (!channel.hasHandle() && AppDomain.CurrentDomain.GetData(SharedKey) is IntPtr[] old && old.Length == 2)
            {
                channel = new FMOD.Channel(old[0]);
                sound = new FMOD.Sound(old[1]);
            }
            AppDomain.CurrentDomain.SetData(SharedKey, null);
            if (!fade)
            {
                if (channel.hasHandle())
                    channel.stop();
                if (sound.hasHandle())
                    sound.release();
            }
            else if (IsPlaying && RuntimeManager.CoreSystem.getSoftwareFormat(out int rate, out _, out _) == FMOD.RESULT.OK)
            {
                channel.getDSPClock(out _, out ulong now);
                ulong end = now + (ulong)(rate * FadeSeconds);
                channel.addFadePoint(now, 1f);
                channel.addFadePoint(end, 0f);
                channel.setDelay(0, end, true);
                fading = sound;
            }
            else if (sound.hasHandle())
            {
                sound.release();
            }
            sound = default;
            channel = default;
        }

        private static void Check(FMOD.RESULT result, string what)
        {
            if (result != FMOD.RESULT.OK)
                throw new IOException($"FMOD could not {what} the song ({result})");
        }
    }
}
