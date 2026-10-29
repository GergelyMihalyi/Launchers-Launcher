# Dolphin (GameCube / Wii)

`lib/launchers/dolphin-library.js`; flatpak `org.DolphinEmu.dolphin-emu`. Recent: **launch-time recorded**
(`recentGames.dolphin`; `TimePlayed.ini` has only total playtime, `<GameID> = 0x<hex s>`, no timestamp). Network covers.

- **ROM folders:** Dolphin's own `Dolphin.ini` `[General]` `ISOPath0..N` + `RecursiveISOPaths` (`readGameDirs` /
  `parseIsoPaths`). The flatpak also requests `filesystems=host:ro`; on the machine `ISOPath0` is already host-side
  (`/run/user/<uid>/doc/…`) and readable, but the in-sandbox `/run/flatpak/doc/…` form is handled defensively
  (`translateFlatpakDocPath`). **Gotcha:** a real empty-value line `ISOPath1 = ` made a lazy `.+?` capture a
  whitespace-only "value" — the fix is `.*` plus a separate `trim()` check.
- **Two formats with full title + ID**, verified by hexdump: `.iso`/`.gcm` (native disc header at the file start: Game
  ID 6 bytes @0, Wii magic `0x5D1C9EA3` @0x18 / GC magic `0xC2339F3D` @0x1C, title ≤ 64 bytes ASCII @0x20 —
  `parseDiscHeader`/`extractIsoDiscMeta`) and `.wbfs` (`WBFS` magic @0, `hd_sec_sz_s` exponent @8 →
  `hd_sector_size = 2^n` (512 here), the first disc's header is **byte-identical** at exactly that offset —
  `extractWbfsDiscMeta` reuses `parseDiscHeader`). **`.rvz`/`.wia`/`.gcz`/`.ciso`/`.wad` get a file-name title only**
  (no ID/cover). Real Wii U dumps mixed into the folder (`meta/meta.xml`, `content_platform: WUP`) are skipped
  automatically by the extension filter.
- **Cover:** Dolphin itself (with `UseGameCovers = True`, the default) downloads from GameTDB into
  `cache/dolphin-emu/GameCovers/<GameID>.png` (`flatpakCacheRoot`, `dolphinCacheRoot()`); `resolveDolphinCover`
  reads that **first** (self-healing, no network), otherwise `ensureDolphinCovers` fetches
  `https://art.gametdb.com/wii/cover/<region>/<GameID>.png` into the launcher's `covers/dolphin/` (region from the Game
  ID's 4th character, `gametdbRegion()`: `P→EN`, `E→US`, `J→JA`, `EN` fallback; GameCube discs also live under
  `wii/cover/`).
- **Id:** `dolphinGameId(gameId, filePath)` (Game ID, else a `p:` path hash).
- **Launch:** `flatpak run org.DolphinEmu.dolphin-emu -b -e <discPath> -C Dolphin.Display.Fullscreen=True`.
  `-b`/`--batch` ("run without the UI, requires `--exec`", verified in `--help`) is presumably Heroic's `--no-gui` model;
  Dolphin's CLI has **no** `--fullscreen`, `-C <System>.<Section>.<Key>=<Value>` is the generic config override.
  **Verified live** on the machines (2026-10-29 manual test round): a game started from the Games panel runs
  in fullscreen and the batch run ends with the game.
