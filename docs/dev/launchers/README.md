# Launchers and emulators — shared rules

One file per launcher/emulator in this folder; this page holds what they have in common.

| File | Kind |
|---|---|
| [steam.md](steam.md), [heroic.md](heroic.md), [lutris.md](lutris.md) | store clients (merged in the root list) |
| [retroarch.md](retroarch.md) | playlist-based, per-system drill-down |
| [ryujinx.md](ryujinx.md), [cemu.md](cemu.md), [rpcs3.md](rpcs3.md) | Switch / Wii U / PS3 |
| [pcsx2.md](pcsx2.md), [duckstation.md](duckstation.md), [ppsspp.md](ppsspp.md) | PS2 / PS1 / PSP |
| [dolphin.md](dolphin.md), [melonds.md](melonds.md) | GameCube+Wii / Nintendo DS |

## Contents

- [Module layout](#module-layout)
- [Adding an emulator](#adding-an-emulator)
- [Custom ROM folders](#custom-rom-folders)
- [The installed-apps list of the Add-launcher wizard](#the-installed-apps-list-of-the-add-launcher-wizard)
- [Native vs flatpak variant](#native-vs-flatpak-variant)
- [ROM storage](#rom-storage-local-nfs-samba)
- [Flatpak access to ROM folders](#flatpak-access-to-rom-folders)
- [Shared helpers](#shared-helpers-liblaunchersshared)
- [Save backup](#save-backup)
- [Cross-cutting lessons](#cross-cutting-lessons)

## Module layout

`lib/launchers/<id>-library.js` holds one scanner per launcher (tests in `test/launchers/`).
The **data** part of an emulator source lives in the repo-root **`launcher-registry.js`**
(`EMULATOR_REGISTRY`, shared by main and renderer — IIFE + guarded `module.exports`, loaded by
`<script src>` after `controller-id.js` and before the renderer). Per row: `id`, `name`, `chip`,
`idField`, `subheadKey`, `launchParams`, optional `networkCover`, `derivedRecent`. From it derive: the
renderer's `EMULATOR_SOURCES` and `SOURCE_FILTER_LABELS`, the card quick-menu tables, main's
`GAMES_SOURCE_IDS` (`lib/prefs.js`), `DERIVED_RECENT_LAUNCHER_IDS` (`lib/recent/usage.js`) and the
data part of `NETWORK_COVER_SOURCES`. The function-heavy main-side wiring is **one entry per emulator in
`lib/launchers/emulator-sources.js`** (the "descriptor"): `loader`, `ensureCovers`, `nativePlay`,
`recent { fetch, background }`, `cover` (`configKey` = launch-time-recorded list → the main process fills
the cover at once), `invalidateModuleCache`, `onStartup`, `launch`, `romDirArgs`, `library`. `main.js`
has no per-emulator branch and never requires the library modules one by one — new behaviour = a new
descriptor field.

The flatpak app-id is the library's `<ID>_FLATPAK_ID` constant (= the catalog `flathubId`); import it
elsewhere (`save-sources`, `launch-ipc`, …) instead of writing it out (`test/contracts/flatpak-ids.test.js`);
a fork switch (e.g. a Ryujinx fork) = the constant + the catalog.

Every `findRecentlyPlayed()` returns `lastLaunchedAt` as an **ISO string** (`buildRecentEntries` /
`msToLaunchedAt`) — see [config-keys.md](../config-keys.md#games).

## Adding an emulator

**Start with the generator:** `npm run new-emulator -- <id> --name "<Name>" --flatpak <app.id> --ext .a,.b
[--dry-run]` (`tools/new-emulator.js`). It creates the library + test skeleton, inserts the registry row,
the descriptor entry (with the launch descriptor and `<id>GameArgs`), the warm-up id and the i18n keys, and
prints what is left. Its anchors are guarded by `test/tools/new-emulator.test.js` against today's target
files — **if you restructure a target file and that test fails, fix the generator's anchor too.**

The manual list (`test/contracts/launcher-tables.test.js` catches most omissions):

1. The library module + test: scan, covers, recent.
2. One registry row.
3. One descriptor entry. **A scanner that walks a ROM folder must use `workerLoader`** + one line in
   `lib/scan/scan-sources.js`; the main process computes the roots and passes them as arguments (the
   worker's `xdg.js` does not know the selected variant; on NFS it would freeze the main process). The
   module's own `findInstalledGamesCached` only for a source that reads a small metadata file (RPCS3
   `games.yml`). `GAME_WARMUP_ORDER` gets the id.
4. **No new IPC channel** — list / cover / launch go through the shared `{ source }` channels.
5. Launch: for a path-based emulator the descriptor's `launch` field + the library's `<x>GameArgs`
   (flatpak-shaped `run <appid> …`; the native variant is handled by `variantExecSpec`; i18n
   `err.<x>MissingPath`); `launch-ipc.js` is not touched. A non-path-based one needs an explicit handler.
6. Recent: derived → `derivedRecent: true` + the descriptor's `recent`; launch-time-recorded → nothing
   (a registry row that is not `derivedRecent` is recorded from `launchParams`). Save locations →
   `lib/saves/save-sources.js` `SAVE_SOURCE_DEFS`.
7. i18n `games.<x>Subhead` (hu + en), a `data/launcher-catalog.json` entry, `assets/icons/<x>.png`.
8. **Native ↔ flatpak variant** (mandatory): the catalog's `nativeCmd` (string or candidate list), or
   `"flatpakOnly": "<reason>"`; the library root through `appConfigRoot` / `appDataRoot` / `appCacheRoot`;
   the save locations with `bothRoots`.
9. A ROM-folder emulator also needs `romDirArgs` in the descriptor (`launcher-tables` test).

Catalog notes: the Ryujinx entry uses the Ryubing fork `io.github.ryubing.Ryujinx` (the original `org.ryujinx.Ryujinx` is gone from Flathub); catalog icons are the
`dl.flathub.org` appstream icons stored under `assets/icons/`; **ES-DE is not in the catalog** — it is not on Flathub (distributed from its own repo), so no stable flatpak
id and icon; it can be added by hand with the launcher-add wizard. Prism Launcher and Bottles are in as flatpak launcher cards only.

Before changing a library module's flags or formats, read its file here; do not launch an emulator CLI
with an unknown flag to "see what happens" (Ryujinx starts its GUI).

## Custom ROM folders

For a program that is not in the registry (e.g. a downloaded AppImage emulator) the user assigns a folder,
extensions and a `{rom}` argument template to a launcher in its □ menu → "Assign games (ROM folder)…"
(`renderer/settings/settings-launcher-roms.js`: folders → system template / custom extensions → arguments),
stored in `customGameSources`. `lib/launchers/custom-roms-library.js`: `normalizeCustomGameSource`
(absolute, deduplicated folders ≤ 10; lowercase `.ext` ≤ 30; a template without `{rom}` gets `{rom}`; one
per launcher), an **async** walk (depth 4, ≤ 20 000 files, hidden folders skipped; name =
`cleanFilenameLabel`, id = `pathHashId(path, launcherId)`), `buildCustomGameArgs(template, rom)` (`{rom}` is
**one argv element**, replaced even when embedded), `isRomInSource` (the launch gate: the file must be under a
source folder with a matching extension and exist), `customGameMeta` (recent under the launcher's card,
`kind: 'custom'`). In the panel it is the `custom` source (chip MISC, badge = the launcher's name; the last,
`custom: true` row of the renderer's `EMULATOR_SOURCES`); the card menu gets "Open games"
(`customGameLauncherIds`). IPC: `get-custom-game-sources`, `set-custom-game-source` (needs the launcher to
exist), `list-custom-games`, `launch-custom-game`. No covers (the manual override works). `remove-launcher`
also deletes the source. **Quick support = this; full support (covers, playtime) = its own library module.**

## The installed-apps list of the Add-launcher wizard

`list-installed-apps` feeds the "＋ Add launcher" wizard with the programs on the machine, with icons:

- `lib/apps/desktop-entries.js` — discovery of **native** XDG `.desktop` applications (`Exec=` split per the Desktop Entry
  Specification, the `%f/%u/…` field codes dropped; `NoDisplay`/`Hidden`/`Terminal`/non-Application entries and `flatpak run`
  commands are skipped — flatpak apps come from `flatpak list`).
- `lib/apps/app-icons.js` — icon resolution (a `.desktop` `Icon=` name or flatpak appid → the best PNG/SVG in the theme roots:
  hicolor + common themes + `pixmaps`; the index is cached for 5 minutes) and **importing** the chosen icon into the launcher's
  own folder `~/.local/share/launchers-launcher/icons/<id>.<ext>`, so a package update cannot break the card.
- `lib/apps/installed-apps.js` — the **pure** merge of the two lists (flatpak + native, by name) into wizard rows; only native
  rows that `checkLauncherPayload` would accept make the list, `known` marks a program that is already added or in the catalog.

A launcher's `icon` can therefore be a `file://` URL into that folder. The main process copies `add-launcher`'s `iconFile` **only
from an icon-theme/pixmaps root**, and deletes the copy when the launcher is removed. The renderer's `<img src>` handles the URL
as it is — **do not wrap it in `fileUrl()`**.

## Native vs flatpak variant

Every catalog launcher has a native and a flatpak variant (or `flatpakOnly`). The motivation: the machine
had only the flatpak Steam, while the catalog entry was native-only, so the card ran `steam` → `ENOENT`,
the add-launcher flow saw "not installed", and the wizard offered to flatpak-install an app that was already
there. Rules ([config-keys.md](../config-keys.md#launchers) has the surface):

- The catalog entry's `cmd` is the flatpak form; `nativeCmd` (string or candidates, first on `PATH`) and
  `nativeArgs` describe the native one. `launcherVariantOf(launcher, entry)` reads the added variant from
  `cmd` (a hand-edited launcher → `null`). One variant installed → used (startup `repairLauncherVariants()`
  rewrites a stale one); both → flatpak recommended, switchable with □ in Settings → Launchers or the wizard.
- **The variant decides the data root and the launch**: libraries use `appConfigRoot`/`appDataRoot`/
  `appCacheRoot` (the `main.js` `syncAppVariants()` fills them; a switch reloads the lists); launching uses
  `variantExecSpec`; saves look in both roots. For a native melonDS, `meta.flatpakId` is `null` and the
  kill-watch sends `SIGTERM` instead of `flatpak kill`.
- If automatic search misses a program (AppImage / tarball outside `PATH`) the user can point at it:
  `launcherPaths` (see config keys). A Steam adding detail: `defaultSteamRoot()` falls back from
  `~/.steam/steam` to the flatpak data root.

## ROM storage (local, NFS, Samba)

The launcher does not know where a folder comes from: ROM folders are read from each emulator's own settings
(`readGameDirs`) and walked with ordinary file calls; headers (ISO9660, NDS, zip, PARAM.SFO) are read with
small **positioned** reads, so any filesystem works. Extension matching is case-insensitive.

- Local disks (ext4, btrfs, NTFS, exFAT, FAT32) work and are faster than NFS. FAT32 cannot hold files > 4 GB
  (Wii / PS2 DVD9 / PS3 / Switch images often are bigger) — a filesystem limit; FAT/exFAT need the `utf8`
  mount option or accented names may break ("missing file" at launch).
- Samba: an fstab `cifs` mount behaves like NFS (the scan timeout and worker thread protect against an
  unreachable server). A file-manager-mounted share (`/run/user/<uid>/gvfs/smb-share:…`) exists only after
  someone mounted it post-login (the list is silently empty before), is slower, and flatpak emulators need
  `--filesystem=xdg-run/gvfs` — prefer an fstab mount on a kiosk.
- Two bugs found and fixed in the shared walker (see [infrastructure.md](../infrastructure.md#paths-files-and-downloads)):
  **symlinks were skipped** (a `Dirent` symlink is neither file nor directory — a `~/roms/ps2 →
  /mnt/ntfs/PS2` setup gave an empty list) and **junk files counted as games** (macOS `._<name>` AppleDouble
  with the ROM's own extension, `$RECYCLE.BIN`, `System Volume Information`).
- Where the format has no real identifier (non-ISO PS2, `.rvz`, `.pbp` homebrew, custom sources) the id comes
  from the **path** (`pathHashId`): the same ROM at a new path gets a new id (the favorite becomes "missing
  file", launcher-measured playtime is not carried over). Real identifiers (serial, title id, gamecode, Game
  ID) are fine; an unchanged mount path avoids the issue.

## Flatpak access to ROM folders

A flatpak emulator sees only what its `filesystems` permission (plus the user's overrides) opens — a
`/mnt/roms` NFS folder is in the Games panel but the emulator reports "file not found".
`lib/launchers/rom-access.js`:

- **Data:** the descriptor's `romDirArgs()` (the arguments of the library's `readGameDirs`; PCSX2, Dolphin,
  Cemu, Ryujinx, PPSSPP, DuckStation, melonDS + `melondsRomDirs`). **The worker reads the folders**
  (`scan-sources.js` `romDirs` → `readRomDirs`: `readGameDirs` + `realpath` — existence checks on a hung NFS
  would freeze the main process).
- **Permission:** `flatpak info --show-permissions <app-id>` (`readFlatpakFilesystems`), only for the added
  **flatpak-variant** emulator; a failed query = no verdict.
- **Matching** (pure `flatpakSees` / `checkRomDirAccess`): `host` (excluding system folders and
  `$XDG_RUNTIME_DIR` — a file-manager `gvfs` share needs `xdg-run/gvfs`), `host-os`/`host-etc`, `home`,
  `~/…`, `xdg-run/…`, `xdg-config|data|cache/…`, `xdg-download` etc. (via `~/.config/user-dirs.dirs`),
  absolute paths; `:ro`/`:rw`/`:create`; `!` denial; **the most specific entry wins** (later on a tie).
  Always visible: the document portal and the app's own `~/.var/app/<app-id>`. **For a symlinked folder the
  *target* must be visible** (`home` shows `~/roms` but not the `/mnt/ntfs` target), unless an entry names the
  link itself.
- **Surface:** `get-rom-access` → Diagnostics "ROM folder access" and a non-focusable warning on top of the
  Games panel (loaded in the background; "NOT VISIBLE" badge); the TTL cache key is the list of flatpak
  targets. RetroArch, RPCS3 (`games.yml`) and custom sources are excluded.
- **Granting** (Settings → Games → "ROM folder permissions"): a two-step confirm per unseen folder runs
  `flatpak override --user --filesystem=<dir> <app-id>` (rw — the emulator may save next to the ROM), recorded
  in `flatpakGrants` and revocable with `--nofilesystem` (the user's own overrides are never touched). Gates:
  `grant-rom-access` runs only for an (app-id, dir) pair that a fresh `romAccess.check({ refresh })` says is
  unseen; `isSafeGrantDir` (absolute, normalised, no `:`/control chars — flatpak's `path[:mode]` syntax —,
  ≥ 2 deep, not a system folder / `$HOME` / `/run`); the app-id passes `flatpakAppId`. melonDS's automatic
  override for ROM folders outside `$HOME` is booked here too (picking the folder = the confirmation;
  `adoptExisting` at startup). A running emulator sees a grant only after a restart.

## Shared helpers (`lib/launchers/shared/`)

Do not rewrite these per launcher; each has a single test in `test/launchers/shared/`:

- `game-id.js` — `pathHashId(filePath, extra?)` = `p:` + 16 hex of SHA-1 (the fallback id), `cleanFilenameLabel(
  rawName, { stripExtension })` (`_`/`.` → space, collapse, trim; falls back to the raw name). Ryujinx's own
  `ryujinxGameLabel` deliberately does not use it (it also strips brackets/version/scene suffixes).
- `iso9660.js` — PVD + directory-record primitives over a `reader(offset, length)` abstraction (always called
  with a 2048-aligned offset), so plain `.iso`, PPSSPP `.cso` block decoding and DuckStation's raw 2352-byte
  sectors share it: `findDirEntry(dirBuf, name)` (ignores `;N` version suffix and case),
  `readRootDirectory(reader)`.
- `param-sfo.js` — `parseParamSfo` (PS3/PSP/Vita); `ps-game-db.js` — `lookupGameName` (the identical
  `GameIndex.yaml`/`gamedb.yaml` schema), `parseGameListDirs` (`[GameList]` `RecursivePaths`/`Paths`),
  `parsePlaytime` (`<serial> <seconds> <unix s>`) for PCSX2 + DuckStation; `png-encode.js` — `encodePng` (8-bit
  RGBA; Cemu TGA→PNG, melonDS icons).
- `cover-cache.js` — `coverCacheDir(id)` (`~/.local/share/launchers-launcher/covers/<id>`), `coverPath`,
  `resolveCachedCover` (self-healing, disk only, never network), `writeCoverAtomic`, and
  `ensureCoversForEntries(entries, { hasKey, destPath, buildUrl, logKey, logLabel, download, log })` — the
  shared ~25-line loop of the `ensure*Covers` functions (`hasKey`/`destPath`/`buildUrl` get the whole entry,
  because DuckStation/RetroArch need two fields).
- `zip-reader` — a minimal zip reader (stored/deflate, no ZIP64): `listZipEntriesFromFile` (file **end** +
  Central Directory only), `readZipEntryPrefixes(zipPath, cdEntry, onPrefix)` (growing compressed prefixes
  with `Z_SYNC_FLUSH`; the callback's `true` stops). **Never read a whole zip from a file** — it froze the
  main process for minutes on NFS.
- `cover-miss-cache.js` and `cover-override.js`: see [games-panel.md](../games-panel.md#covers).

## Save backup

`lib/saves/save-sources.js` — `SAVE_SOURCE_DEFS` (per emulator, verified on the machine) +
`detectSaveSources({ melondsRomDirs })` → `[{ id, name, bytes, paths }]`, only paths that **exist**; it
follows config overrides: RetroArch `savefile_directory`/`savestate_directory` (`~` expanded, `default` →
`saves/`, `states/`), PCSX2 `[Folders] MemoryCards`/`Savestates`, DuckStation `[MemoryCards] Directory` +
`[Folders] SaveStates` (relative values against the config root), Cemu `<mlc_path>` → `usr/save` (not the GB-size
mlc01), Ryujinx `bis/user/save` + `saveMeta` + `system/Profiles.json` (**`prod.keys`/`title.keys` deliberately
excluded**), RPCS3 native and flatpak `dev_hdd0/home` + `savestates`, melonDS `SaveFilePath`/`SavestatePath` if set,
otherwise the `.sav` files beside the ROMs (its own folder + `melondsRomDirs`, 3 levels). **All I/O async** (the ROM
folder may be NFS). A new emulator = one row there too.

`lib/saves/save-backup.js` — `createSaveBackup({ destDir, sources, compressor })`: `tar -c --zstd` (if `zstd`
exists; else `-z`) into a `.partial`, `-C /` with `/`-relative paths (restore: `tar -xf <file> -C /`), plus a
`launchers-launcher-saves.json` manifest (date, version, the restore command, sources); success → rename to
`launchers-launcher-saves-<date>.tar.zst`, then `pruneSaveBackups` keeps the last 5 (foreign files untouched). GNU
tar exit 1 ("file changed as we read it") is not an error. Timeout `SAVE_BACKUP_TIMEOUT_MS`. Measured: 9 sources,
~75 MB → 6.8 MB zstd, ~0.2 s. IPC (`lib/ipc/saves-ipc.js`): `get-save-backup-state`, `set-save-backup-dir`,
`run-save-backup` (one at a time) → `save-backup-done`.

**Automatic backup:** `saveBackup.auto` = `off`/`afterGame`/`daily`: `afterGame` after a game session ends
(30 s delay) at most hourly; `daily` at startup (2 min delay) and after a game, at most daily; the newest
archive's `mtime` is the yardstick; a running backup / a running game / no source → silently skipped; no toast on
auto success.

**Restore:** ✕ on a previous backup → its contents (the manifest via `tar -xOf`) → one source or "All saves",
two-step confirm (`restore-save-backup` + `save-restore-done`). Protections: the archive name must match
`BACKUP_NAME_RE`; never together with a backup or a launch (`isGameActive`); **a backup of the *current* state
first** (`keep: ∞`, so the archive being restored is not pruned — if that fails there is no restore); only
manifest-listed, `$HOME`-relative, normalised paths are written (`safeRestoreMembers`),
`tar -xf … --no-same-owner -C /`. The emulator must be closed (the launcher only knows its own launches).

## Cross-cutting lessons

- **Never read a whole file during a scan** (a header suffices): melonDS zips on NFS froze the launcher; the
  fix (positioned reads, growing prefix) took 60+ s to 1.6 s. A persisted per-file `mtime+size` metadata cache
  ([infrastructure.md](../infrastructure.md#worker-thread-scans)) took repeat scans to ~7 ms.
- **Derive titles/ids from real data, not substring luck**: the DuckStation `SYSTEM.CNF` can lie hundreds of
  MB from the start of the disc — traverse ISO9660 properly.
- **A launched emulator must exit when the game ends** or the launcher never regains control (DuckStation
  needs `-batch`; the RPCS3 `--no-gui` lesson is the opposite — it suppressed the controller-friendly Big
  Picture Mode).
- **Type-checking gotcha (`@ts-check`):** an evolving `let x = {}` that is conditionally reassigned stays
  typed `{}` on paths where the reassignment did not run, so an explicit `@returns {Meta|null}` raises TS2322.
  Fix with a `/** @type {…} */` annotation (index-signature type) at the declaration, never `@ts-ignore`.
