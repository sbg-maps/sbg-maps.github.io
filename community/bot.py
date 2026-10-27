"""Community map pack bot.

Watches one Discord thread where people post .sbgmap files and keeps a pack of them: every map on its own, an
index.json, an all.zip and a small web page, in SITE_DIR (served by Tailscale Funnel). The thread is the source of
truth: every sync re-reads it, so maps posted while the bot was off are picked up and deleted posts drop out.

Rules:
- Files whose name starts with "private" are skipped, like the mod does.
- A map is known by the id in its map.json. A later post of the same id by the same person replaces it; someone else
  posting that id is refused (the bot says so in the thread).
- Optionally copies the maps into the game's maps folder, never touching files it did not put there.

The pack is served on 127.0.0.1:PORT for Funnel to forward. Funnel is slow (well under 1 MB/s), so with
CLOUDFLARED set the bot also runs a free Cloudflare quick tunnel to the same server and sends map and zip downloads
there: the Funnel link stays the one people keep (the page and index.json come from it), and its downloads redirect
to the tunnel, whose address changes whenever the tunnel restarts. Settings come from the environment (see sbg-maps-bot.service); the token is read from TOKEN_FILE.
"""

import asyncio
import datetime
import hashlib
import html
import json
import logging
import os
import re
import shutil
from urllib.parse import quote
import zipfile
from pathlib import Path

import discord
from aiohttp import web

THREAD_ID = int(os.environ["THREAD_ID"])
DATA_DIR = Path(os.environ["DATA_DIR"])
PUBLIC_URL = os.environ["PUBLIC_URL"].rstrip("/")
TOKEN_FILE = Path(os.environ.get("TOKEN_FILE", Path.home() / ".config/sbg-maps-bot/token"))
GAME_MAPS = Path(os.environ["GAME_MAPS"]) if os.environ.get("GAME_MAPS") else None
PORT = int(os.environ.get("PORT", "3790"))  # Tailscale Funnel forwards the public link here
CLOUDFLARED = os.environ.get("CLOUDFLARED")  # optional: a Cloudflare tunnel carries the downloads, much faster

CACHE_DIR = DATA_DIR / "cache"
SITE_DIR = DATA_DIR / "site"
STATE_FILE = DATA_DIR / "state.json"

MAX_FILE = 1024**3  # biggest .sbgmap accepted
MAX_UNPACKED = 4 * 1024**3  # guards against zip bombs
QUIET_SECONDS = 20  # wait this long after the last change in the thread before syncing
RESYNC_SECONDS = 3600  # full re-read now and then, in case an event was missed

log = logging.getLogger("sbg-maps-bot")


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except FileNotFoundError:
        return None


def save_state(state):
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    os.replace(tmp, STATE_FILE)


def read_map(path):
    """map.json of a .sbgmap, or a reason it is not a usable map."""
    try:
        with zipfile.ZipFile(path) as z:
            if sum(i.file_size for i in z.infolist()) > MAX_UNPACKED:
                return None, "it unpacks to more than 4 GB"
            names = [n for n in z.namelist() if n == "map.json" or n.endswith("/map.json")]
            if not names:
                return None, "there is no map.json in it"
            name = min(names, key=len)
            if z.getinfo(name).file_size > 16 * 1024**2:
                return None, "its map.json is too big"
            meta = json.loads(z.read(name))
    except zipfile.BadZipFile:
        return None, "it is not a map file from the editor"
    except (ValueError, UnicodeDecodeError):
        return None, "its map.json is broken"
    if not isinstance(meta, dict) or not isinstance(meta.get("id"), str) or not meta["id"].strip():
        return None, "its map.json has no id"
    if not isinstance(meta.get("holes"), list) or not meta["holes"]:
        return None, "it has no holes"
    return meta, None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name if name.lower().endswith(".sbgmap") else name + ".sbgmap"


def mb(size):
    return f"{size / 1024**2:.0f} MB" if size >= 1024**2 else f"{max(size / 1024, 1):.0f} KB"


def map_ids_in(folder, skip):
    """Ids of the maps in the game folder that are not ours (files and unpacked map folders)."""
    ids = set()
    for p in folder.iterdir():
        if p.name in skip:
            continue
        meta = None
        if p.is_file() and p.suffix.lower() == ".sbgmap":
            meta, _ = read_map(p)
        elif p.is_dir() and (p / "map.json").is_file():
            try:
                meta = json.loads((p / "map.json").read_text())
            except (ValueError, OSError):
                pass
        if isinstance(meta, dict) and isinstance(meta.get("id"), str):
            ids.add(meta["id"].lower())
    return ids


class Bot(discord.Client):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True  # attachments are part of the content
        super().__init__(intents=intents)
        self.wake = asyncio.Event()
        self.first_sync = asyncio.Event()

    async def setup_hook(self):
        app = web.Application(middlewares=[self.to_tunnel])
        app.router.add_get("/", lambda _: web.FileResponse(SITE_DIR / "index.html"))
        app.router.add_static("/", SITE_DIR)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", PORT).start()
        self.loop.create_task(self.worker())
        if CLOUDFLARED:
            self.loop.create_task(self.tunnel())

    fast_url = None

    @web.middleware
    async def to_tunnel(self, request, handler):
        """Downloads asked of the Funnel link go to the tunnel."""
        heavy = request.path.startswith("/maps/") or request.path == "/all.zip"
        if heavy and self.fast_url and not request.host.endswith(".trycloudflare.com"):
            raise web.HTTPFound(self.fast_url + request.path_qs)
        return await handler(request)

    async def tunnel(self):
        """Keeps a Cloudflare quick tunnel to the web server running and remembers its address."""
        while not self.is_closed():
            proc = await asyncio.create_subprocess_exec(
                CLOUDFLARED, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            url = None
            async for line in proc.stderr:
                text = line.decode(errors="replace")
                found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", text)
                if found and not url:
                    url = found.group(0)
                if url and "Registered tunnel connection" in text and self.fast_url != url:
                    await asyncio.sleep(5)  # the new name takes a moment to resolve everywhere
                    self.fast_url = url
                    log.info("downloads go through %s", url)
            self.fast_url = None
            log.warning("the Cloudflare tunnel stopped (exit %s), starting it again", await proc.wait())
            await asyncio.sleep(10)

    async def on_ready(self):
        log.info("logged in as %s", self.user)
        self.wake.set()

    def in_thread(self, channel_id):
        return channel_id == THREAD_ID

    async def on_message(self, message):
        if self.in_thread(message.channel.id) and not message.author.bot and message.attachments:
            self.wake.set()

    async def on_raw_message_delete(self, payload):
        if self.in_thread(payload.channel_id):
            self.wake.set()

    async def on_raw_bulk_message_delete(self, payload):
        if self.in_thread(payload.channel_id):
            self.wake.set()

    async def on_raw_message_edit(self, payload):
        # Removing an attachment from a post is an edit.
        if self.in_thread(payload.channel_id):
            self.wake.set()

    async def worker(self):
        await self.wait_until_ready()
        while not self.is_closed():
            try:
                await asyncio.wait_for(self.wake.wait(), RESYNC_SECONDS)
            except asyncio.TimeoutError:
                pass
            # Let a burst of posts settle into one sync and one announcement.
            while True:
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), QUIET_SECONDS)
                except asyncio.TimeoutError:
                    break
            try:
                await self.sync()
            except Exception:
                log.exception("sync failed")

    async def sync(self):
        thread = self.get_channel(THREAD_ID) or await self.fetch_channel(THREAD_ID)
        state = load_state()
        first_run = state is None
        state = state or {"maps": {}, "answered": [], "game": {}, "packSignature": None}
        answered = set(state["answered"])

        maps = {}  # id -> entry; posts are read oldest first so later posts replace earlier ones
        problems = []  # (message, text) to answer
        async for message in thread.history(limit=None, oldest_first=True):
            if message.author.bot:
                continue
            for a in message.attachments:
                if not a.filename.lower().endswith(".sbgmap") or a.filename.lower().startswith("private"):
                    continue
                key = str(a.id)
                if a.size > MAX_FILE:
                    problems.append((message, key, f"{a.filename} is bigger than 1 GB, so it is not in the pack."))
                    continue
                cached = CACHE_DIR / f"{a.id}.sbgmap"
                meta_file = CACHE_DIR / f"{a.id}.json"
                if not meta_file.exists():
                    tmp = cached.with_suffix(".part")
                    await a.save(tmp)
                    os.replace(tmp, cached)
                    meta, why = await asyncio.to_thread(read_map, cached)
                    info = {"why": why} if why else {
                        "id": meta["id"].strip(),
                        "name": str(meta.get("name") or a.filename[:-7]),
                        "author": str(meta.get("author") or ""),
                        "version": str(meta.get("version") or ""),
                        "holes": len(meta["holes"]),
                        "sha256": await asyncio.to_thread(sha256, cached),
                    }
                    if why:
                        cached.unlink(missing_ok=True)
                    meta_file.write_text(json.dumps(info))
                info = json.loads(meta_file.read_text())
                if info.get("why"):
                    problems.append((message, key, f"{a.filename} is not in the pack: {info['why']}."))
                    continue
                entry = {
                    **info,
                    "attachment": a.id,
                    "file": safe_name(a.filename),
                    "size": a.size,
                    "poster": message.author.id,
                    "posterName": message.author.display_name,
                    "posted": message.created_at.isoformat(),
                    "message": message.jump_url,
                }
                mid = info["id"].lower()
                owner = maps.get(mid)
                if owner and owner["poster"] != message.author.id:
                    problems.append((message, key,
                        f"{a.filename} is not in the pack: {owner['posterName']} already posted a map with the id "
                        f"\"{info['id']}\". Give yours its own id in the map editor and post it again."))
                    continue
                maps[mid] = entry

        # Two different maps posted under one file name: number the later one.
        used = set()
        for e in sorted(maps.values(), key=lambda e: e["posted"]):
            stem, n = e["file"][:-7], 2
            while e["file"].lower() in used:
                e["file"] = f"{stem} ({n}).sbgmap"
                n += 1
            used.add(e["file"].lower())

        before = state["maps"]
        added = [e["name"] for k, e in maps.items() if k not in before]
        replaced = [e["name"] for k, e in maps.items() if k in before and before[k]["sha256"] != e["sha256"]]
        removed = [e["name"] for k, e in before.items() if k not in maps]

        await asyncio.to_thread(self.write_site, maps, state)
        if GAME_MAPS:
            await asyncio.to_thread(self.copy_to_game, maps, state)
        self.prune_cache(maps, problems)

        for message, key, text in problems:
            if key in answered:
                continue
            answered.add(key)
            if not first_run:
                try:
                    await message.reply(text, mention_author=False)
                except discord.HTTPException:
                    log.exception("could not answer in the thread")
        state["answered"] = sorted(answered)
        state["maps"] = maps
        save_state(state)

        if (added or replaced or removed) and not first_run:
            def link(e):
                return f"[{e['name']}](<{PUBLIC_URL}/maps/{quote(e['file'])}>)"

            lines = [f"Added: {link(maps[k])}" for k in maps if k not in before]
            lines += [f"Updated: {link(maps[k])}" for k in maps if k in before and before[k]["sha256"] != maps[k]["sha256"]]
            if removed:
                lines.append("Removed: " + ", ".join(removed))
            total = sum(e["size"] for e in maps.values())
            tail = [f"[All {len(maps)} maps in one zip ({mb(total)})](<{PUBLIC_URL}/all.zip>)",
                    f"[Every map on its own](<{PUBLIC_URL}/>)"]
            # Discord allows 2000 characters; a big batch is cut short, the page has the rest.
            more = []
            while lines and len("\n".join(["**Map pack updated**", *lines, *more, *tail])) > 1950:
                lines.pop()
                more = ["..."]
            lines += more + tail
            await thread.send("**Map pack updated**\n" + "\n".join(lines), suppress_embeds=True)
        log.info("synced: %d maps, +%d ~%d -%d", len(maps), len(added), len(replaced), len(removed))
        self.first_sync.set()

    def prune_cache(self, maps, problems):
        keep = {str(e["attachment"]) for e in maps.values()} | {key for _, key, _ in problems}
        for p in CACHE_DIR.iterdir():
            if p.stem not in keep and p.suffix in (".sbgmap", ".json"):
                p.unlink()

    def write_site(self, maps, state):
        (SITE_DIR / "maps").mkdir(parents=True, exist_ok=True)
        entries = sorted(maps.values(), key=lambda e: e["name"].lower())
        wanted = {e["file"] for e in entries}
        for e in entries:
            target = SITE_DIR / "maps" / e["file"]
            source = CACHE_DIR / f"{e['attachment']}.sbgmap"
            if target.exists() and os.path.samefile(target, source):
                continue
            tmp = target.with_name(target.name + ".tmp")
            tmp.unlink(missing_ok=True)
            os.link(source, tmp)
            os.replace(tmp, target)
        for p in (SITE_DIR / "maps").iterdir():
            if p.name not in wanted:
                p.unlink()

        signature = hashlib.sha256(json.dumps([[e["file"], e["sha256"]] for e in entries]).encode()).hexdigest()
        if signature != state.get("packSignature") or not (SITE_DIR / "all.zip").exists():
            tmp = SITE_DIR / "all.zip.tmp"
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:  # maps are zips already
                for e in entries:
                    z.write(SITE_DIR / "maps" / e["file"], e["file"])
            os.replace(tmp, SITE_DIR / "all.zip")
            state["packSignature"] = signature

        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        index = {
            "updated": now,
            "maps": [{
                "id": e["id"], "name": e["name"], "author": e["author"] or e["posterName"], "version": e["version"],
                "holes": e["holes"], "file": e["file"], "url": f"{PUBLIC_URL}/maps/{e['file']}", "size": e["size"],
                "sha256": e["sha256"], "posted": e["posted"],
            } for e in entries],
        }
        self.write_text(SITE_DIR / "index.json", json.dumps(index, indent=1))
        self.write_text(SITE_DIR / "index.html", page(index))

    @staticmethod
    def write_text(path, text):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)

    def copy_to_game(self, maps, state):
        """Keeps the community maps in the game's maps folder. Only files the bot put there are ever replaced or
        removed, and only while they are as the bot left them."""
        if not GAME_MAPS.is_dir():
            return
        owned = state.setdefault("game", {})

        def untouched(name):
            p = GAME_MAPS / name
            if name not in owned or not p.is_file():
                return False
            st = p.stat()
            return [st.st_size, st.st_mtime_ns] == owned[name]

        for name in list(owned):
            if not untouched(name):
                del owned[name]  # changed or deleted by someone else: not ours any more
        others = map_ids_in(GAME_MAPS, set(owned))
        wanted = {}
        for e in maps.values():
            if e["id"].lower() in others:
                continue  # the player has their own copy of this map
            wanted[e["file"]] = e
        for name in list(owned):
            if name not in wanted:
                (GAME_MAPS / name).unlink()
                del owned[name]
                log.info("removed %s from the game folder", name)
        for name, e in wanted.items():
            target = GAME_MAPS / name
            if target.exists() and name not in owned:
                continue  # a file of the player's with the same name
            if name in owned and sha256(target) == e["sha256"]:
                continue
            tmp = target.with_name(target.name + ".part")
            shutil.copyfile(CACHE_DIR / f"{e['attachment']}.sbgmap", tmp)
            os.replace(tmp, target)
            st = target.stat()
            owned[name] = [st.st_size, st.st_mtime_ns]
            log.info("copied %s into the game folder", name)


def page(index):
    rows = []
    for m in index["maps"]:
        holes = f"{m['holes']} hole" + ("s" if m["holes"] != 1 else "")
        rows.append(
            f'<li><a href="maps/{html.escape(m["file"], quote=True)}" download>{html.escape(m["name"])}</a>'
            f'<span>{html.escape(m["author"])} · {holes} · {mb(m["size"])}</span></li>')
    total = sum(m["size"] for m in index["maps"])
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Community maps</title>
<style>
:root{{--bg:#eaf7ee;--card:#fff;--ink:#183322;--muted:#5b7564;--accent:#2f9e57;--line:#cfe6d6}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0f1a14;--card:#16251c;--ink:#e3f2e8;--muted:#9bb7a5;--accent:#5fd18a;--line:#25402f}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}}
main{{max-width:640px;margin:0 auto;padding:32px 16px}}
h1{{margin:0 0 4px;font-size:28px}} p{{margin:0 0 20px;color:var(--muted)}}
.all{{display:inline-block;background:var(--accent);color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;margin-bottom:20px}}
ul{{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:14px}}
li{{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:12px 16px;border-top:1px solid var(--line)}}
li:first-child{{border-top:0}} li a{{color:var(--ink);font-weight:600}} li span{{color:var(--muted);font-size:14px}}
</style></head><body><main>
<h1>Community maps</h1>
<p>Put the files in Super Battle Golf/SbgMaps/maps/. Needs the <a href="https://sbg-maps.github.io/mod/">SBG Maps mod</a>.</p>
<a class="all" href="all.zip" download>All {len(index["maps"])} maps ({mb(total)})</a>
<ul>{"".join(rows) or "<li>No maps yet</li>"}</ul>
</main></body></html>
"""


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for d in (CACHE_DIR, SITE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    Bot().run(TOKEN_FILE.read_text().strip(), log_handler=None)


if __name__ == "__main__":
    main()
