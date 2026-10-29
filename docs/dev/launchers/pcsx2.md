# PCSX2 (PlayStation 2)

`lib/launchers/pcsx2-library.js`; flatpak `net.pcsx2.PCSX2`, config `flatpakConfigRoot(…, 'PCSX2')`. Recent:
**derived** from `inis/playtime.dat`. Network covers.

- **No crypto:** PS2 images are not encrypted. `extractSerialFromIso(isoPath)` is a minimal ISO9660 parser
  (PVD at sector 16 → root directory → `SYSTEM.CNF;1` → `BOOT2 = cdrom0:\<PREFIX>_<mid>.<suffix>;1` regex) using
  a few small **positioned** `fs.readSync` calls — fast even on a 2.7 GB ISO (verified: "Shadow of the Colossus"
  → `SCUS-97472`). Non-ISO formats (`.cue`/`.mdf`/`.nrg`/`.chd`/`.cso`/`.zso`) get a file-name-based title only
  (accepted limitation).
- **ROM folders:** `inis/PCSX2.ini` `[GameList]` `RecursivePaths =` / `Paths =` via `parseGameListDirs`, **line by
  line** — an earlier single capture-regex with a `(?=\r?\n\[|$)` lookahead captured only the first line (multiline
  `$` matches before every newline); it hid because the live config had one `RecursivePaths` line.
- **Title:** serial → official name from PCSX2's own installed `GameIndex.yaml`
  (`findPcsx2ResourcesDir()` tries the user and system flatpak `…/files/bin/resources/`; `lookupGameName` is a
  regex lookup, not a YAML parser; cached once per process — the ~2.6 MB file only changes with a PCSX2 update).
  Read live, **not copied into the repo** (version-dependent).
- **Recent:** `parsePlaytime`/`readPlaytime` read `inis/playtime.dat` (`<serial> <seconds> <unix s>`) →
  derived, like Steam/RetroArch.
- **Covers:** from the `xlenore/ps2-covers` GitHub repo
  (`https://raw.githubusercontent.com/xlenore/ps2-covers/main/covers/default/<serial>.jpg` — the de facto
  community/wiki source, free, keyless, verified with the user's real serial), cached in the launcher's own
  folder (`ensurePcsx2Covers`, lazy windowed).
- **Launch:** `flatpak run net.pcsx2.PCSX2 <path>` (`pcsx2GameArgs`; **no `meta`**). Id from the serial, or a
  `pcsx2GameId` path hash.
- Tests build a synthetic ISO9660 image (`test/helpers/fixtures.js` `buildFakeIso`) with a root `SYSTEM.CNF`.
