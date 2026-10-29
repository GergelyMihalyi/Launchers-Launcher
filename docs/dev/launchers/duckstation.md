# DuckStation (PlayStation 1)

`lib/launchers/duckstation-library.js`; flatpak `org.duckstation.DuckStation`, config
`flatpakConfigRoot(…, 'duckstation')`. Recent: **derived** from `<configRoot>/playtime.dat` (in the config root, **not**
under `inis/` like PCSX2; byte-identical format, `parsePlaytime` shared). Network covers. Scanned in a worker.

- **Sandbox/paths:** the flatpak requests only `filesystems=xdg-config/kdeglobals:ro` (no `host`), so ROM access is purely
  document-portal — but `settings.ini` already stores the **host-side** portal path (`/run/user/<uid>/doc/<token>/…`),
  so the unsandboxed launcher reads it with no translation (verified 2026-09-15). ROM folders: `settings.ini`
  `[GameList]` `RecursivePaths`/`Paths` (`parseGameListDirs`, shared with PCSX2).
- **Serial/title by real ISO9660 traversal, not text search.** An early "SYSTEM.CNF is at the disc start, a big-window
  substring search will do" assumption **failed live**: on the user's "Street Fighter Alpha 3" / "Tekken 3" discs the
  `SYSTEM.CNF` *contents* were hundreds of MB from its directory entry (the authoring tool scatters files).
  `detectSectorGeometry()` tries the `CD001` PVD at plain 2048-byte sectors (`.iso`) **and** raw 2352-byte sectors
  (Mode2/Form1 data offset 24 and Mode1 offset 16 — `.bin`, most of the user's collection, per the `.cue`
  `TRACK 01 MODE2/2352`), `readLogical()` reads sector by sector (max 2048 bytes, concatenated — in raw geometry the
  logical bytes are **not** contiguous in the file), then the PCSX2-style PVD → root → `SYSTEM.CNF` traversal.
- **Second live gotcha:** the boot file is not always in the cdrom root (`BOOT = cdrom:\TEKKEN3\SLUS_004.02;1`), so
  `BOOT_RE` allows zero or more `<dir>\` segments `(?:[^\\;]+\\)*` before the `<PREFIX>_<n>.<n>` name.
- **`.cue` is not the image:** `resolveCueDataFile()` takes the **first `FILE "…"`** line (relative to the `.cue`'s
  folder); a broken cue/bin pairing (the referenced file missing — seen on "Worms Armageddon") returns `null` and the
  caller falls back to a file-name title.
- **No bare `.bin`/`.img`-only scan:** the scan whitelist is `.cue`/`.chd`/`.pbp`/`.iso`/`.img` — a `.bin` always sits
  beside a `.cue`, and adding bare `.bin` would list one game twice. A compressed container (e.g. PSX2PSP `.pbp`) →
  `detectSectorGeometry` returns `null` early → file-name title, no serial/cover (accepted).
- **Title:** from DuckStation's own `files/bin/resources/gamedb.yaml` (`duckstationResourcesDirs()`; `lookupGameName` has
  the schema identical to PCSX2's `GameIndex.yaml`).
- **Cover:** the already-working `thumbnails.libretro.com` under the `"Sony - PlayStation"` system (same name as the user's
  RetroArch playlist), searched by the `gamedb.yaml` official name (Redump/No-Intro convention) —
  `duckstationThumbnailUrl()` mirrors `libretroThumbnailUrl`.
- **Launch:** `flatpak run org.duckstation.DuckStation -fullscreen -batch -- <discPath>` (`discPath` = the `.cue` or a
  standalone `.chd`/`.pbp`/`.iso`/`.img`). **`-batch` ("exits after powering off") is essential:** it was first omitted
  out of RPCS3-lesson caution, and without it the process did **not** exit after the game closed (DuckStation switched to
  its own controller menu and stayed alive), so the launcher never regained control. This is *not* the RPCS3 `--no-gui`
  problem (that suppressed the Big Picture Mode at start-up; `-batch` does not touch the GUI mode, only the exit
  behaviour). No `meta`; id from the serial or a `duckstationGameId` path hash.
