# Cemu (Wii U)

`lib/launchers/cemu-library.js`; flatpak `info.cemu.Cemu`. Recent: **launch-time recorded**
(`recentGames.cemu`; Cemu has no timestamped bookkeeping — `<RecentLaunchFiles>` is just a path list). Covers:
**local conversion, no network**.

- **Own scan, not Cemu's cache:** Cemu's `title_list_cache.xml` (the GameList UI cache) was verified **stale** (a
  title started directly with `-g`/`-t` was missing), so the module scans two sources itself:
  (1) `readGameDirs(configRoot)` = the `<GamePaths>` of `settings.xml` (`parseGamePaths`, a regex parser), walked
  with a `meta/meta.xml` marker (`walkGameDirs`, depth 3; a hit = one game folder, no deeper);
  (2) `findMlcBaseGameDirs(mlc)` = Cemu's virtual NAND, `mlcRoot(configRoot, dataRoot)` (the `<mlc_path>` override or
  the default `dataRoot/mlc01`, large content lives under `data/`, hence `appDataRoot`) → `usr/title/**00050000**`
  only. The `0005000C` / `0005000E` groups (DLC / updates) are skipped — an update group's `meta.xml` carries the
  *base* game's `title_id` but holds an incomplete content delta, not a game.
- **`meta/meta.xml`** (fixed-name Wii U XML): `parseMetaXml` → 16-hex `<title_id>` (always present — no filename/NFO
  fallback needed, unlike Ryujinx) + a localised `<longname_*>` / `<shortname_*>` title (`en` first, then the first
  filled locale; a multi-line title such as "THE LEGEND OF ZELDA\nThe Wind Waker HD" is joined to one line).
  `findInstalledGames(configRoot, dataRoot)` merges both sources, deduplicating on `title_id` (the `GamePaths`
  source wins; verified: one title existed in both).
- **Cover:** `meta/iconTex.tga` (128×128, uncompressed 32-bit TGA) → `decodeTga` (minimal: image type 2 only,
  24/32 bpp, no colormap, else `null`; descriptor bit 5 decides row order) → shared `encodePng` →
  `ensureCemuCover(gameDir, titleId)` into the launcher's `covers/cemu/<titleId>.png` (atomic, self-healing). The
  conversion is synchronous and cheap, so it runs for **every** scanned entry — hence no `ensure…Covers` /
  `withResolved…Covers` counterpart in main, and recorded recents always get a ready `cover`. Verified on the
  user's own dumps: icons are correctly oriented and coloured.
- **Launch:** `flatpak run info.cemu.Cemu -f -g <gamePath>` (`-g` = "path of game to launch", a folder is accepted;
  `-f` fullscreen). Id from `title_id` or `cemuGameId` path hash. Saves: `<mlc_path>` → `usr/save` (the whole mlc01
  is GBs of game content and is **not** backed up).
- Tests: `buildFakeTga` synthetic fixture, the PNG output inflated back to exact pixels, temp
  `settings.xml`/`meta.xml`/mlc01 trees.
