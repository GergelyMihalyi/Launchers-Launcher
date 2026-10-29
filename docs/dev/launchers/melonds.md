# melonDS (Nintendo DS / DSi)

`lib/launchers/melonds-library.js`; flatpak `net.kuribo64.melonDS`. Recent: **launch-time recorded**
(`recentGames.melonds`; its `RecentROM` is MRU order with no timestamp, so it cannot be derived). Covers: **local
decoding**. Scanned in a worker with a persisted file-metadata cache. The only **killable** emulator
([../launching.md](../launching.md#kill-watch-sessions-melonds)). The plain "melonDS" launcher card stays alongside —
the panel is an additional launch path, not a replacement.

melonDS has no controller-browsable game list (only a native "Open ROM" dialog and a plain Recent menu), so the
launcher scans a ROM folder itself and launches the ROM directly on the CLI.

- **ROM folders = a union of two sources** (its config has no "GamePaths"-like list): (1) auto-derived from
  `melonDS.toml` — `parseTomlString`/`parseTomlStringArray` (a line regex for `LastROMFolder`/`RecentROM`, **not** a
  TOML parser; `RecentROM` entries are `<path>` or `<archive>|<inner file>`, `parseRecentEntry`) — the parent folders of
  `LastROMFolder` + the MRU; the flatpak permission is `filesystems=home`, wider than most; (2) the **`melondsRomDirs`**
  config key (Settings → Launchers → "melonDS ROM folders", the shared `createDirBrowser`). `readGameDirs(configRoot,
  manualDirs)` = the deduplicated union of existing folders.
- **⚠️ ROM folders outside `$HOME`** (a separately mounted/network share): the launcher scans fine (unsandboxed) but the
  melonDS flatpak (`filesystems=home`) does not see the file at *launch* ("No such file" under `flatpak run --command=ls`) —
  found live 2026-09-15: only ROMs previously opened from melonDS (portal-granted) launched. `syncFlatpakOverrides(prev,
  next, { log })` therefore runs `flatpak override --user --filesystem=<dir>` / `--nofilesystem=<dir>` (best-effort,
  fire-and-forget; `isInsideDir` decides "under `$HOME`") on every save of the folder list **and** once at startup for
  folders added before the feature. Now booked through the generic grants ([README.md](README.md#flatpak-access-to-rom-folders)).
- **Header, no crypto** (GBATEK, verified with a real `.nds` by hexdump and by rendering the icon): title @0x00 (12 bytes
  ASCII), gamecode @0x0C (4), icon/title block pointer @0x68 (4, LE); from the block: the English title (@+0x340, 256
  bytes UTF-16LE, often multi-line — `cleanNdsTitle` takes the first non-empty line), the 32×32 4bpp icon bitmap (@+0x20,
  0x200 bytes, 4×4 tiles of 8×8, standard GBA/NDS nibble order — `decodeNdsIcon`) and a 16-colour BGR555 palette
  (@+0x220, index 0 transparent).
- **Zip ROMs** (melonDS opens them natively with `-a`/`--archive-file`) with a **minimal custom zip reader** (now
  `shared/zip-reader.js`). Every ROM found in an archive is its own entry (`expandToRomEntries`); melonDS is launched with
  the inner file via `-a`. **⚠️ This froze the launcher live (2026-09-15):** the first zip handling read the *whole* zip file
  twice (list entries, then extract the header) — on ~137 zips (~5.8 GB) on NFS the main process's synchronous loop was blocked
  for **minutes**. The fix is positioned reading: `listZipRomEntriesFromFile` reads only the file end (EOCD, ≤ ~64 KB) + the
  Central Directory range (`parseCentralDirectory` got an optional `baseOffset`); `extractNdsMetaFromZipEntry` reads a
  **growing compressed prefix** (`ZIP_PREFIX_SIZES`: 64 KB → 256 KB → 1 MB → 4 MB → 16 MB) and decodes it with
  `zlib.inflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })` (the documented way to decode a truncated
  deflate stream without throwing); the header + icon sit at the start of the ROM, so one 64 KB read almost always
  suffices (all 137 first try). Result: 60+ s (timeout) → ~1.6 s. **Any future scanner that would read a whole file, not
  a header, must remember this.**
- **Persisted metadata cache:** even with positioned reads, the 60 s TTL meant any panel open less often than that
  re-read the whole collection (139 zips on NFS ≈ 1.6 s of UI blocking each time). A second, TTL-independent layer —
  an `mtime`+`size` signature per file — returns the old entry for an unchanged zip/ROM with only an `fs.statSync`
  (measured: cold ~1.6 s, every later scan ~7–8 ms, ~200×). Since 2026-09-24 it is the shared
  `lib/scan/scan-meta-cache.js` and persists to disk (`scan-cache/melonds.json`), so it survives restarts. The cache is
  replaced by a fresh `Map` on each scan, so removed files fall out. The regression test patches `fs.openSync`/`readSync`
  and counts bytes read.
- **Cover:** local decode via the shared `encodePng` into `covers/melonds/<gamecode>.png` (`ensureMelondsCover`,
  synchronous per scanned entry, like Cemu).
- **Id:** `melondsGameId(gamecode, filePath, archiveEntry)` — gamecode, else a `p:` hash of path + archive entry (two ROMs
  in one zip do not collide).
- **Launch:** `flatpak run net.kuribo64.melonDS --fullscreen <rom>` (melonDS's **own** `--fullscreen` flag, verified in
  `--help` — no config-override trick needed); for a zip ROM `-a <inner file>` goes **after** `--fullscreen` and before the
  path. The recent `meta` carries `killable: true` + `flatpakId` (the only launcher that does).
- **Saves:** `SaveFilePath`/`SavestatePath` if set, otherwise the `.sav` files beside the ROMs.
