# Heroic (GOG / Epic / Amazon)

`lib/launchers/heroic-library.js`. Part of the merged root list.

- **Config root:** Heroic is a flatpak here (`com.heroicgameslauncher.hgl`), so the config is
  `heroicConfigRoot()` = `~/.var/app/com.heroicgameslauncher.hgl/config/heroic/` (through `appConfigRoot`).
- **The installed fact comes from the install-info file, never from the library cache.** Each store has two
  files: an install-info file (GOG `gog_store/installed.json` → `installed[].appName`, DLCs skipped; Epic/Amazon
  `store_cache/{legendary,nile}_install_info.json` → the keys without `__timestamp`) and a library cache
  (`store_cache/{gog,legendary,nile}_library.json`) used only for titles/images. **The cache's own
  `is_installed` is unreliable** (a GOG DLC package said `true`; of 11 Epic entries marked installed only 2
  were). A store that was never used (Amazon) is skipped best-effort.
- **Covers:** Heroic downloads the library's `art_square` (portrait) → `art_cover` (fallback) URL into
  `<heroicRoot>/images-cache/`, the file name being **`sha256(<url>)` hex** (reverse-engineered from
  `app.asar`'s `getImageFromCache`). Epic's `art_square` is often not cached → `art_cover` (landscape).
  `libraryEntriesByName(data, listKey)` (`'games'` GOG, `'library'` legendary + nile) feeds the lookup.
- **Launch:** `flatpak run com.heroicgameslauncher.hgl --no-gui heroic://launch?appName=<appName>&runner=<runner>`.
  The `heroic://` URL format was found by searching Heroic's `app.asar` (`strings`/byte offsets; no docs).
  `--no-gui` (which Heroic itself uses for its non-Steam shortcut generator) = headless, and the process
  **blocks until the game closes**, so `close` really means the game ended and the normal `spawnGame`
  model fits (unlike Steam). `runner` ∈ `gog`/`legendary`/`nile` equals the `runner` field in Heroic's own
  cache, no translation. Verified for GOG and Epic; Amazon not available for testing.
- **Recent:** launch-time recorded (`recentGames.heroic`), `meta` built by `heroicMeta(appName, runner, name,
  cover)`. In the recent bar the Heroic item's `kind` is always `heroic`; the store is `params.runner`.
- **Metadata** for the details view: `legendary_library.json` (developer, description, store URL) — see
  [../games-panel.md](../games-panel.md#details-view).
