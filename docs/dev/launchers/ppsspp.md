# PPSSPP (PSP)

`lib/launchers/ppsspp-library.js`; flatpak `org.ppsspp.PPSSPP`. Recent + playtime: **derived** from the `[PlayTime]`
ini section. Covers: **local extraction** of the embedded `ICON0.PNG`. Scanned in a worker.

- **Sandbox:** the flatpak requests `filesystems=host:ro`, so the (unsandboxed) launcher reads any host path.
- **ROM folders = a union of sources:** (1) PPSSPP's own **`[PinnedPaths]`** (`Path0`/`Path1`/…, `parsePinnedPaths`);
  (2) the **parent folders** of `[Recent]` `FileName0`/`FileName1`/… (`parseRecentFiles`) in `PSP/SYSTEM/ppsspp.ini`;
  (3) PPSSPP's emulated Memory Stick homebrew folder `PSP/GAME/` under the config root (always scanned, no setup —
  the Cemu `mlc01` dual-source pattern).
- **⚠️ Corrected wrong assumption (found live, 2026-09-14):** the original plan excluded `[Recent]` because a file
  opened with the native GTK picker gets a **document-portal path** (`/run/flatpak/doc/<token>/…`), which I assumed the
  launcher could not resolve. False: `/run/flatpak/doc/` is the in-sandbox bind mount of the same document-portal
  instance that on the host is a plain user-session FUSE mount at `/run/user/<uid>/doc/<token>/…`
  (`portal on /run/user/1000/doc type fuse.portal`). **`translateFlatpakDocPath(p)`** converts the prefix; the grant
  turned out to be **folder-level** (the whole parent folder, ~50 ROMs, became readable, not just the one opened
  file). That is the practical case for a user who never "pinned" anything.
- **Three formats**, each yielding `PARAM.SFO` + `ICON0.PNG`: **`.pbp`** (homebrew `PSP/GAME/<dir>/EBOOT.PBP`: both
  embedded via the 40-byte header's offset table, `extractPbpMeta`, magic `\0PBP`); **`.iso`** (plain ISO9660,
  `PSP_GAME/PARAM.SFO` + `PSP_GAME/ICON0.PNG` — `findIsoSfoAndIcon`: root → `PSP_GAME` subdir → entry; the shared
  `findDirEntry` works on any directory extent); **`.cso`** (compressed ISO — **most real PSP collections use it**, not
  raw `.iso`): `readCsoHeader`/`readCsoBlock`/`csoByteReader` — a 24-byte header (`CISO`, `header_size`, `total_bytes`
  u64, `block_size` (~2048), `version`, `align`), then an index of `(blocks+1)×u32` (bit 31 = "raw/uncompressed", the
  rest `<< align` = file offset), contents in **raw deflate** (`zlib.inflateRawSync`, no zlib header). The `.iso` and
  `.cso` paths both sit behind the shared `reader(offset, length)` abstraction.
- **Recent:** `parsePlayTime` — `<DISC_ID> = <total seconds>,<last played unix s>` (live line:
  `ULES00789 = 274,1789401775`). A `.pbp` homebrew has no `DISC_ID`, so it never shows in the recent strips.
- **Cover:** `ICON0.PNG` is a ready PNG but **embedded** (PBP offset / ISO-CSO filesystem), not addressable by
  `file://`, so `ensurePpssppCover` writes it into `covers/ppsspp/<id>.png` (synchronous per scanned entry, like Cemu).
- **Id:** `ppssppGameId(discId, filePath)` — the `DISC_ID`, else a `p:` path hash (always the case for `.pbp`).
- **Launch:** `flatpak run org.ppsspp.PPSSPP --fullscreen <discPath>` (the SDL frontend accepts a positional
  ISO/CSO/PBP and `--fullscreen`); no `meta`.
- **Type-check gotcha:** see [README.md](README.md#cross-cutting-lessons) (an evolving `let x = {}` and an explicit
  `@returns` give TS2322).
