# RPCS3 (PlayStation 3)

`lib/launchers/rpcs3-library.js`. Recent + playtime: **derived** from `GuiConfigs/persistent_settings.dat`. Covers:
local `ICON0.PNG`.

- **No folder walk:** RPCS3's own `games.yml` (config root, `<TITLE_ID>: <path>` per line, parsed by the simple
  one-level `parseGamesYaml`) is already the authoritative installed list (Boot Game / Install PKG / disc
  auto-detection all write to it). Config root: `rpcs3ConfigRoot()` = `~/.config/rpcs3` (native AppImage) or
  `rpcs3FlatpakConfigRoot()` = `flatpakConfigRoot('net.rpcs3.RPCS3', 'rpcs3')`; main's `activeRpcs3ConfigRoot()`
  picks by the added launcher's `cmd`.
- **Title + cover:** from `PARAM.SFO` / `ICON0.PNG` at the registered path: `parseParamSfo` (the shared
  `shared/param-sfo.js`: magic `\0PSF`, header → index table → key table → data table, `data_fmt 0x0404` = int32 LE,
  else null-terminated UTF-8) reads `TITLE`. **Two layouts** (`resolveParamSfoPath`/`resolveIconPath` try both):
  disc-based `<path>/PS3_GAME/PARAM.SFO` (verified) and HDD/PKG-installed `<path>/PARAM.SFO` (**not tested on this
  machine**). `ICON0.PNG` is already a browsable PNG, so `cover` points straight at the file.
- **Recent + playtime:** `parsePersistentSettings` — despite the `.dat` extension it is **plain-text Qt `IniFormat`**
  (`[LastPlayed]` / `[Playtime]`, `<TITLE_ID>=<value>`; `LastPlayed` is local time without a zone, `Date.parse`
  reads it as local — enough for ordering). Derived like Steam/RetroArch/PCSX2 (in `DERIVED_RECENT_LAUNCHER_IDS`).
- **Launch:** `"%RPCS3_GAMEID%:<TITLE_ID>"` (`rpcs3GameArgs`; the documented boot-by-title-id form, RPCS3 resolves
  the path from its own `games.yml`), `rpcs3LaunchSpec` chooses native vs flatpak. **⚠️ Deliberately no
  `--no-gui`:** (verified 2026-09-14) with it, after the game closed RPCS3 brought back its own classic
  (not controller-navigable) main window and the user got stuck. RPCS3's controller-friendly **"Big Picture Mode"**
  (2024+ handheld-experience UI) is enabled by a persisted setting inside RPCS3 ("Automatically open Big Picture
  Mode on boot" — **no CLI flag**, the upstream request #19477 is still open) and `--no-gui` suppressed it. The user
  sets it once in RPCS3; this repo does not.
- **Native install:** the Flathub build is an "unofficial Flatpak" and shows a warning dialog at every start — bad
  on a controller-only kiosk. The catalog's `"nativeCmd": "rpcs3"` advertises the official AppImage: download from
  rpcs3.net, `chmod +x`, put on `PATH` as plain `rpcs3` (no version in the file name — `which rpcs3` needs a fixed
  name), e.g. `~/.local/bin/rpcs3`. (On the author's machine `~/.local/bin` was once owned by a foreign UID, so a
  plain `mv` there needed `sudo` — a machine quirk, not a launcher issue.)
- **Saves:** native and flatpak `dev_hdd0/home` + `savestates`.
- A downloaded AppImage must match the machine's architecture: an aarch64 Citron build once landed on an x86_64
  machine ("Exec format error"). Check `uname -m` / `file` first.
