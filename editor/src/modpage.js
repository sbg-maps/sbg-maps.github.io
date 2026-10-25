import { MOD_VERSIONS, MOD_VERSION, downloadUrl, downloadedVersion, markDownloaded } from "./mod.js";

const download = document.getElementById("download");
download.href = downloadUrl(MOD_VERSION);
download.textContent = `Download mod ${MOD_VERSION}`;
const had = downloadedVersion();
document.getElementById("download-note").textContent =
  had && had !== MOD_VERSION ? `Released ${MOD_VERSIONS[0].date}. You have ${had}.` : `Released ${MOD_VERSIONS[0].date}.`;
download.addEventListener("click", () => markDownloaded(MOD_VERSION));

const versions = document.getElementById("versions");
for (const entry of MOD_VERSIONS) {
  const block = document.createElement("div");
  block.className = "version";
  const title = document.createElement("h3");
  title.textContent = entry.version;
  const date = document.createElement("span");
  date.className = "muted";
  date.textContent = ` ${entry.date}`;
  title.append(date);
  const list = document.createElement("ul");
  for (const item of entry.items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  }
  block.append(title, list);
  versions.append(block);
}
