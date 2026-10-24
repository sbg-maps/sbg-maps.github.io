using System;
using System.IO;
using System.Linq;
using BepInEx;
using UnityEngine;

namespace SbgMaps.DevReloader
{
    /// <summary>
    /// ScriptEngine's FileSystemWatcher does not fire under Proton, so poll the scripts folder
    /// and ask ScriptEngine to reload when a DLL there changes.
    /// </summary>
    [BepInPlugin("loafer.sbgmaps.devreloader", "SbgMaps DevReloader", "0.0.1")]
    [BepInDependency("com.bepis.bepinex.scriptengine")]
    public class DevReloader : BaseUnityPlugin
    {
        private string scriptsDir;
        private DateTime lastSeen;
        private DateTime changedAt = DateTime.MaxValue;
        private float nextPoll;

        private void Awake()
        {
            scriptsDir = Path.Combine(Paths.BepInExRootPath, "scripts");
            lastSeen = NewestWrite();
        }

        private DateTime NewestWrite() =>
            Directory.Exists(scriptsDir)
                ? Directory.GetFiles(scriptsDir, "*.dll").Select(File.GetLastWriteTimeUtc).DefaultIfEmpty(DateTime.MinValue).Max()
                : DateTime.MinValue;

        private void Update()
        {
            if (Time.unscaledTime < nextPoll)
                return;
            nextPoll = Time.unscaledTime + 1f;

            var newest = NewestWrite();
            if (newest != lastSeen)
            {
                // Wait until the build has finished writing before reloading.
                lastSeen = newest;
                changedAt = DateTime.UtcNow;
                return;
            }
            if (DateTime.UtcNow - changedAt < TimeSpan.FromSeconds(1.5))
                return;
            changedAt = DateTime.MaxValue;

            var engine = FindObjectsByType<MonoBehaviour>(FindObjectsSortMode.None).FirstOrDefault(b => b.GetType().FullName == "ScriptEngine.ScriptEngine");
            if (engine == null)
            {
                Logger.LogWarning("ScriptEngine not found, can't reload");
                return;
            }
            Logger.LogInfo("Scripts changed, reloading");
            engine.GetType().GetMethod("ReloadPlugins", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public)
                ?.Invoke(engine, null);
        }
    }
}
