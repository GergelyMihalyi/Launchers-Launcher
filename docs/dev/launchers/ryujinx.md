# Ryujinx (Ryubing fork, Nintendo Switch)

`lib/launchers/ryujinx-library.js`; flatpak `io.github.ryubing.Ryujinx`, config
`flatpakConfigRoot(…, 'Ryujinx')`. Recent: **launch-time recorded** (`recentGames.ryujinx`), network covers.

- **No ROM decoding:** NSP/XCI content is title-key encrypted; reading the title/icon would need real decryption
  with the user's `prod.keys` — beyond the "pure parsing, zero crypto" principle.
- **Scan:** `readGameDirs(configRoot)` = `Config.json` `game_dirs` ∪ `autoload_dirs` (deduplicated, only
  existing folders — a flatpak document-portal path can lose validity). `findInstalledGames` walks them
  (`MAX_SCAN_DEPTH` 3) for `nsp`/`xci`/`nsz`/`xcz`, skipping updates/DLC with `isLikelyUpdateOrDlc(name)`
  (**substring** match on `update|dlc|patch|upd`, deliberately not word-bounded so a separator-less
  "…deluxeupd17.nsp" is caught).
- **Title ID without decoding**, from two sources: `extractTitleIdFromName` (a 16-hex `[XXXXXXXXXXXXXXXX]` in the
  file name — the nxdumptool convention) or `findSidecarInfo(dir)` (an adjacent `.nfo`/`.txt` with a "Title ID"
  line; `[.\s]*` handles dotted-fill ASCII-art formatting; the scene NFOs gave a hit for ~14/16 base games). The
  same sidecar can supply a ready "Title :" line used as the name instead of the file-name cleaner
  `ryujinxGameLabel`. `ryujinxGameId(titleId, filePath)` is the stable id (title id, or a `p:` path hash).
- **Covers:** Ryujinx has no cover cache, so they go to the launcher's own
  `~/.local/share/launchers-launcher/covers/ryujinx/<titleId>.jpg` from **`api.nlib.cc`**
  (`https://api.nlib.cc/nx/<titleId>/icon/<size>`, free, keyless community service, verified 2026-09-13),
  fetched by `ensureRyujinxCovers` through the shared lazy windowed scheme.
- **Panel:** a cover grid (this was the first emulator done as a grid, by user request, later followed by the
  others); no per-system drill-down — a Switch library is one "system" and the whole list is cheap.
- **Launch:** `spawnGame('ryujinx-game-<id>', 'flatpak', ['run', 'io.github.ryubing.Ryujinx', romPath], meta)` — the
  RetroArch model: the spawned process is the running window, `close` = the user fully quit. **⚠️ Never call the
  Ryujinx CLI with an unknown flag (e.g. `--help`)**: it treats the argument as a file path, finds none, and
  starts the whole GUI on the user's screen.
- **Saves:** `bis/user/save` + `saveMeta` + `system/Profiles.json`; `prod.keys`/`title.keys` are deliberately
  not backed up.
- **Known game-side crash, not a launcher bug:** a game that hangs when saving may be hitting an unimplemented
  service. Seen: Zelda TotK 1.4.x calls `PrepoService` command 10107 (Play Report telemetry), unimplemented in
  Ryujinx 1.3.3 → an unhandled exception stops the emulated thread. The save itself goes to local disk, not the
  NAS the ROMs live on (the ROM path is NFS → document portal, read-only). Fix: in Ryujinx, System → Hacks →
  "Ignore missing services" (`"ignore_missing_services": true` in `Config.json`), or update Ryujinx.
