import { MOD_VERSIONS, MOD_VERSION, downloadUrl } from "./mod.js";

const download = document.getElementById("download");
download.href = downloadUrl(MOD_VERSION);
download.textContent = `Download mod ${MOD_VERSION}`;
document.getElementById("download-note").textContent = `Released ${MOD_VERSIONS[0].date}. Windows, Linux and Steam Deck.`;

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
