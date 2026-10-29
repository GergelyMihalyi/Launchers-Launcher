# Lutris

`lib/launchers/lutris-library.js`. Part of the merged root list; **the only CLI-based, async source**.

- **Library:** `lutris --list-games --installed --json` (no SQLite dependency: the `pga.db` is not read) gives
  the full installed list, the `lastplayed` timestamp and Lutris's own downloaded `coverPath`
  (`~/.local/share/lutris/coverart/<slug>.jpg`). ~0.6–0.7 s per call, no lingering process.
  `lutrisListSpec(lutrisLauncher)` chooses native (`lutris …`) or flatpak (`flatpak run net.lutris.Lutris …`)
  from the added launcher's `cmd`/`args` (the `steamExecSpec` pattern, `catalogAppId`).
  `parseLutrisTimestamp` turns `"YYYY-MM-DD HH:MM:SS"` into ms (`Date.parse` with the space replaced by `T`);
  `parseLutrisGamesJson` is a pure parser (`fs.existsSync` guard on `coverPath`).
  `findInstalledGames(lutrisLauncher)` returns an empty list when the launcher is not added or the CLI fails —
  **never throws**.
- **Output shape (verified 2026-09-13):** a JSON array of `{ id, slug, name, runner, platform, year, directory, playtime, playtimeSeconds, lastplayed, coverPath }`; `lastplayed` is `null` if never run, and Vulkan/lsfg-vk warnings go to **stderr**, stdout is clean JSON. `--installed` already restricts to installed games, so no `fs.existsSync` stale-entry guard is needed.
- **Async constraint, and its consequence:** because the call is async it cannot fit the synchronous
  `usage.js` API (`derivedRecentGames()` / `decorateLaunchers()` are called from the 4 s running poller,
  `add-launcher`, …). So Lutris recent is merged next to the global list by
  `mergeRecentGameLists` in `lib/recent/recent-games-merge.js`, and the per-launcher-card strip reads a
  **mirror**: `refreshLutrisRecentMirror()` writes the queried top 3 into `recentGames.lutris`
  (fire-and-forget, at startup and after every game close), only when it actually changed (otherwise
  it would push noise). This also catches games started from Lutris's own UI.
- **Cache gotcha (found on the machine):** the Lutris CLI result has its own 10-minute TTL cache
  (`findInstalledGamesCached`); it must be invalidated on every game close (the `invalidateRecent` callback)
  **independently** of the Steam/RetroArch derived cache, otherwise a fresh `lastplayed` can stay invisible
  in every recent strip.
- **Launch:** `lutris:rungameid/<id>` (`lutrisGameArgs`, `lutrisLaunchSpec` native/flatpak). **The launch
  syntax was derived from `lutris --help` and verified live in the 2026-10-29 manual test round.**
- **Variants:** Lutris was the first dual-path catalog entry (`isLauncherInstalled` →
  `'native'|'flatpak'|'both'|false`, `combineInstallState`); with both installed the user is offered a variant
  chooser (flatpak recommended).
