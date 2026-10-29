# Steam

`lib/launchers/steam-library.js`. Part of the merged root list (see [../games-panel.md](../games-panel.md)).

- **Library:** `parseLibraryFolders(vdf)` extracts every `"path"` key of
  `steamapps/libraryfolders.vdf` with a regex (the `apps` sub-block holds appid:size pairs, not `"path"`, so
  no tree parser is needed); `parseAppManifest(acf)` reads `appid`/`name`/`StateFlags`/`LastPlayed` of
  `appmanifest_<id>.acf` (`LastPlayed` in **seconds**, `0` = never played).
- **`isInstalled` tests `StateFlags & 4`, not `=== 4`** — a real installed game also shows `6` (`4|2`,
  "update required" + installed). `isLikelyTool()` is a best-effort name filter for Valve's runtime/compat
  packages (Steam Linux Runtime, Proton*, Steamworks Common Redistributables) that have their own manifests but
  are not games (not perfect: "Lossless Scaling" slips through).
- **Native → flatpak auto-detection:** `defaultSteamRoot()` tries `~/.steam/steam`, then
  `~/.var/app/com.valvesoftware.Steam/.local/share/Steam`. **`isSteamLauncher(l)` is the single definition
  of "is this launcher Steam"** (id `steam`, or `cmd: steam`, or the flatpak `com.valvesoftware.Steam`,
  with any id); `launch-ipc`, `running` and `launch-controller` all call it (three diverging variants used
  to exist).
- **Running:** `steamClientPid(homeDir)` reads `~/.steam/steam.pid` (native). **The flatpak Steam's
  `steam.pid` is a sandbox-namespace PID — meaningless on the host**; use `flatpak ps` there
  ([../launching.md](../launching.md#running-detection-and-the--running-badge)).
- **Covers:** `resolveSteamCover(cacheDir, appid)` over `<steamRoot>/appcache/librarycache`; the Steam client
  has two layouts side by side — flat `<appid>/library_600x900.jpg` **and** hash-subfolder
  `<appid>/<sha1>/library_capsule.jpg` (300×450) — with landscape fallbacks `library_header.jpg` /
  `header.jpg`; none → `null`.
- **Recent:** `findRecentlyPlayed(steamRoot, max)` (`LastPlayed > 0`, `key: steam-game-<appid>`,
  `params: { appid }`) — **it also catches games started from Steam Big Picture itself**, not only from the
  panel. Derived (read-time), so Steam has no launch-time `meta`.
- **Launch:** `steam -gamepadui -tenfoot steam://rungameid/<id>` through the normal `spawnGame`
  (details and the history of this decision in [../games-panel.md](../games-panel.md#steam-and-heroic-launch-notes)).
  `steamExecSpec` is the single native-vs-flatpak decision, also used for `steam://open/bigpicture` when
  switching to a running Steam.
- **Variant gotcha (the reason for the variant layer):** on a machine with only the flatpak Steam, a
  native-shaped launcher entry (`cmd: steam`) produced `spawn steam ENOENT`; the library list and launch
  worked once the entry was flatpak-shaped. See [README.md](README.md#native-vs-flatpak-variant).
