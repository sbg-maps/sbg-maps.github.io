#!/usr/bin/env bash
# Publishes the mod download for the mod page (https://sbg-maps.github.io/mod/):
# builds the release zips, then uploads release/SbgMaps-<version>.zip as GitHub release mod-<version>.
# The public zip leaves out SbgMaps/assets (looks and skies saved from the game): the mod saves those itself as
# people play the normal holes. The friends zips from make_release.sh keep them.
# Before running: bump Version in plugin/Plugin.cs and add the same version on top of editor/src/mod.js.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(grep -oP 'Version = "\K[^"]+' "$repo/plugin/Plugin.cs")"
listed="$(grep -oP 'version: "\K[^"]+' "$repo/editor/src/mod.js" | head -1)"
if [ "$version" != "$listed" ]; then
  echo "Plugin.cs is $version but the newest entry in editor/src/mod.js is $listed" >&2
  exit 1
fi
if gh release view "mod-$version" --repo sbg-maps/sbg-maps.github.io >/dev/null 2>&1; then
  echo "Release mod-$version already exists: bump the version for a new release" >&2
  exit 1
fi

"$repo/tools/make_release.sh"
name="SbgMaps-$version.zip"
cd "$repo/release/modonly"
rm -f "../$name"
zip -qr "../$name" . -x 'SbgMaps/assets/*'
cd "$repo/release"
gh release create "mod-$version" "$name" --repo sbg-maps/sbg-maps.github.io \
  --title "Mod $version" --notes "Install steps and changes: https://sbg-maps.github.io/mod/"
echo "release/$name published"
