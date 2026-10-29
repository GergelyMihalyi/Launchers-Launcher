# RetroArch

`lib/launchers/retroarch-library.js`. The only source with a per-system **drill-down**.

- **Playlist-based, no ROM-folder walk:** RetroArch (flatpak `org.libretro.RetroArch`, config
  `retroarchConfigRoot()` = `~/.var/app/org.libretro.RetroArch/config/retroarch/`) maintains its own scanned
  playlists per system (`playlists/<System>.lpl`, `items[].path`/`label`, `core_path: "DETECT"`).
  `listPlaylistFiles()` takes only **files with `.lpl`** (the folder also holds `logs`/`builtin`
  subfolders). The playlists' `default_core_path` is empty on the test machine and unusable.
- **Size gotcha:** ~15 700 items in total (NES alone 5000+). `findSystemCounts()` gives per-system totals only
  (`countPlaylistItems` = a `/"path"\s*:/g` match count **without `JSON.parse`**); the full list
  (`findGamesForSystem()`, sorted by `label` with the Hungarian collator, numeric, base sensitivity — the
  `.lpl` order is roughly reversed alphabetical with anomalies, and letter jump needs a sorted list) is fetched
  only when the user enters a system and shown as a cover grid. `findAllGames(root)` (worker, TTL-cached) feeds
  the ALL view ([../games-panel.md](../games-panel.md#all-view-and-the-retroarch-rom-set)).
- **Covers:** `resolveRetroarchThumbnail(root, system, label)` →
  `thumbnails/<System>/Named_Boxarts/<label>.png` (`retroarchThumbnailLabel` replaces `& * / : \ ` < > ? |` with
  `_`); `findGamesForSystem` fills `cover` from the local disk (no network). Missing ones come from
  `https://thumbnails.libretro.com/<System>/Named_Boxarts/<label>.png` (`libretroThumbnailUrl`,
  `encodeURIComponent` per segment) into RetroArch's **own** `thumbnails/` folder (so the RetroArch UI sees them
  too and the resolver finds them synchronously next time), lazily and windowed
  (`ensure-retroarch-game-covers`, `{ system, labels }`, built on `ensureRecentThumbnails`).
- **Launch:** `flatpak run org.libretro.RetroArch -L <core> <rom>` (`retroarchGameArgs`); fits the `launch-app`
  model unchanged. The core: `SYSTEM_CORES` (system name → core file) + `corePathForSystem()` (returns a path
  only if the file really exists) — the table is the intersection of the flatpak's
  `share/libretro/info/*.info` (`display_name`/`systemname`/`supported_extensions`) and the actually installed
  `cores/*.so`, not guesswork. "Sony - PlayStation Portable" has no entry (no PSP core installed; PSP is the
  PPSSPP launcher's job).
- **Recent (derived):** `findRecentGames(root, max)` reads `playlists/builtin/content_history.lpl` (RetroArch's
  own history; also catches ROMs started from RetroArch's UI), `key: retroarch:<system>:<label>`,
  `params: { system, path }`. There is no per-item timestamp, so `lastLaunchedAt` is the `.lpl` **mtime** minus
  `i*1000` ms (a synthetic ordering for the global merge) — which is why it is deliberately not built on
  `buildRecentEntries`. **For unrecognised content (no CRC match in RetroArch's database) `label` and `db_name`
  are empty strings**, so `labelFromPath(path)` (file name without extension) and
  `systemFromCoreName(core_name)` (strips the trailing `" (<core variant>)"`, e.g. `"Sony - PlayStation (Beetle
  PSX HW)"` → `"Sony - PlayStation"`) are the fallback — without them the entry has no name and
  `ensureRecentThumbnails` skips it. **Limitation:** for multi-system cores (Genesis Plus GX: MS/GG/MD/CD/
  SG-1000) the system derived from `core_name` can be wrong → the cover download 404s (no worse than an empty
  field); the name is still right. The missing-cover download for the recent top 3 is fire-and-forget after the
  synchronous list returns (one run at a time `retroThumbFetchInFlight`; the 30 s derived TTL throttles 404
  repeats); on new files `usage.invalidateDerivedRecent()` + `running-changed`.
- **Usage counter:** every RetroArch launch shares the single `retroarch-game` usage id (not per ROM).
- **Per-game launch options** key: `retroarch-rom:<ROM path>` ([../launching.md](../launching.md#per-game-launch-options)).
