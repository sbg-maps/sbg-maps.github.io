#!/usr/bin/env bash
# Builds the mod and packs the release zips, named with the mod version (from plugin/Plugin.cs):
#   release/SbgMaps-mod-<version>.zip   the mod, no maps
#   release/SbgMaps-test-<version>.zip  the mod plus the sample map
# The red item box look saved from the game (SbgMaps/assets, see plugin/AssetCapture.cs) goes in too when present:
# it comes from the game, so it is shared only in these zips between friends, never committed.
# Does not touch the game folder.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(grep -oP 'Version = "\K[^"]+' "$repo/plugin/Plugin.cs")"

(cd "$repo/plugin" && dotnet build -c Release -p:NoDeploy=true -v quiet -nologo)
dll="$repo/plugin/bin/Release/netstandard2.1/SbgMaps.dll"

cd "$repo/release"
for kind in modonly:mod stage:test; do
  dir="${kind%%:*}"
  name="SbgMaps-${kind##*:}-$version.zip"
  cp "$dll" "$dir/BepInEx/plugins/SbgMaps/SbgMaps.dll"
  assets="/media/G/SteamLibrary/steamapps/common/Super Battle Golf/SbgMaps/assets"
  rm -rf "$dir/SbgMaps/assets"
  [ -d "$assets" ] && cp -r "$assets" "$dir/SbgMaps/assets"
  rm -f "$name"
  (cd "$dir" && zip -qr "../$name" .)
  echo "release/$name"
done
