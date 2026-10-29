# The Games panel and "recently played"

Code: `renderer/games-panel/*` (UI), `lib/ipc/games-ipc.js`, `recent-ipc.js`, `game-sources-ipc.js`
(IPC, wired together by `registerGamesDomainIpc`), `lib/games/*`, `lib/recent/*`, `lib/scan/*`.
Per-emulator library details are in [launchers/](launchers/README.md); the config keys involved are
in [config-keys.md](config-keys.md#games).

## Contents

- [Data flow and the single source table](#data-flow-and-the-single-source-table)
- [Warm-up and caches](#warm-up-and-caches)
- [Covers](#covers)
- [Recently played, Continue bar, favorites](#recently-played-continue-bar-favorites)
- [The panel UI](#the-panel-ui)
- [ALL view and the RetroArch ROM set](#all-view-and-the-retroarch-rom-set)
- [Search](#search)
- [Filter popup, view/sort modes, hidden, NEW](#filter-popup-viewsort-modes-hidden-new)
- [Details view](#details-view)
- [Playtime reminder, place memory](#playtime-reminder-place-memory)
- [Steam and Heroic launch notes](#steam-and-heroic-launch-notes)

## Data flow and the single source table

**`GAME_LOADERS` in `lib/ipc/games-ipc.js` is the single place of every source** (for emulators it is
built from the descriptor in `lib/launchers/emulator-sources.js`). The `list-*` handlers *and* the
warm-up call the **same thunks** — `createTtlCache` keys on the JSON of the arguments, so a separately
built argument list would silently leave a cold cache. A new source = one line in `GAME_LOADERS` + one
in `GAME_WARMUP_ORDER` (and a `gameListHandler(label, GAME_LOADERS.x)`); the table consistency test
`test/contracts/launcher-tables.test.js` reports which table was missed.

- Handlers: `list-games` (Steam + Heroic + Lutris merged by `lib/games/games-list.js`
  `combineGamesList` — ids `steam:<appid>`, `heroic:<runner>:<appName>`, `lutris:<id>`, the renderer
  decides the launch IPC from them; every row carries `cover: <abs path>|null`; **async** because of
  the Lutris CLI), `list-retroarch-systems` (per-system counts), `list-retroarch-games`,
  `list-retroarch-all-games`, and the shared **`list-emulator-games { source }`** /
  `ensure-emulator-covers { source, ids }` / `launch-emulator-game { source, … }` for every registry
  emulator (the `source` is whitelisted against the registry; a new emulator needs **no new channel**).
- `recent-ipc.js`: favorites, Continue bar, `list-games-recent`, usage stats, `get-game-details`;
  `game-sources-ipc.js`: custom ROM sources, melonDS folders, `browse-dir`. After a source is edited
  it calls `invalidateGameSource(id)`; `loadGames(id)` is handed out so recent-ipc can read native
  playtime from the same loaders.
- `refresh-games` (the manual Refresh, Start/Options in the panel) = `run('manual', { invalidate: true })`
  for every source; the promise resolves after the full rescan, then derived recent is invalidated and
  `running-changed` is pushed.

## Warm-up and caches

`lib/games/games-warmup.js` `createGamesWarmup({ steps, … })` pre-heats the TTL caches so the first
panel open is instant. Steps run in order with a `gapMs` pause (scans were synchronous I/O in the main
process — cold melonDS ~1.7 s); the `async` step (Lutris CLI) starts first and is awaited last; one
step's failure does not stop the rest; no concurrent runs (an `invalidate: true` request during a run
books an extra round, requests union, `true` swallows ids); with `invalidate`, each step does
`invalidate()` + `run()` in the same tick (no "empty cache" window). Heavy sources (melonDS, PPSSPP,
DuckStation, RetroArch ALL) are scanned in a worker ([infrastructure.md](infrastructure.md#worker-thread-scans)),
so the old "cold scan blocks the main process" limit is gone. No network is used in warm-up.

Triggers: `did-finish-load` + 2 s; the return from a game/app (+1.5 s) — **targeted**:
`warmupSourcesForAppId(appId)` invalidates only the closed launcher's source plus the
`steam`/`heroic`/`lutris` client caches (other steps only refresh what has expired; earlier, every
source was rescanned = 8 synchronous scans); and the manual Refresh. Indicator: `games-warmup-state`
push `{ running, done, total }` (+ `get-games-warmup-state`) drives a spinning launcher icon in the
bottom-left (`#warmupSpinner`: `games.svg` painted as a **CSS mask** with `var(--accent)` — the file has
no fill and would be black as an `<img>`); it appears only after 400 ms of running, and is hidden
under Settings / Games panel / screensaver. The `ensure-*-covers` handlers invalidate their own cache
after a successful download (else the next open shows a list without covers for up to 10 minutes).

`lib/games/games-cache.js` — measure/clear the launcher's own rebuildable caches
(`~/.local/share/launchers-launcher/covers` + `scan-cache`); never deletes manual covers, config, log or
`cover-misses.json` (the negative cover cache is cleared via `coverMisses.clear()` — memory **and**
file, otherwise a delayed flush would write it back); then `invalidateDerivedRecent()` + a background
`refreshGames()`. Safe because scans self-heal (a meta-cache hit pointing at a missing cover file is
re-extracted).

## Covers

- Local-decoding sources (Cemu, RPCS3, PPSSPP, melonDS) never touch the network. **Network-cover
  sources** (RetroArch libretro thumbnails, Ryujinx `api.nlib.cc`, PCSX2, Dolphin GameTDB, DuckStation)
  fetch lazily and windowed: renderer `COVER_FETCH_WINDOW` (±24 around the focus),
  `COVER_FETCH_DEBOUNCE_MS` (200 ms), a per-source dedup `Set` reset on every panel open; main
  `COVER_FETCH_MAX_IDS` (60) and the `NETWORK_COVER_SOURCES` table with `buildNetworkCoverHandler`
  (narrows the cached list to the requested ids, runs the library's `ensureCovers` for missing ones
  only, then invalidates). RetroArch uses the same scheme per system (`ensure-retroarch-game-covers`,
  `{ system, labels }`). No `IntersectionObserver`: controller navigation jumps in discrete steps, so a
  focus-centred window is cheaper than re-observing thousands of cells.
- **Negative cache** (`cover-miss-cache`): 404/410 covers are remembered 7 days; transient errors are
  not. The shared downloader serves both cover paths.
- **Manual override**: `~/Pictures/launchers-launcher/covers/<source>/<id>.png`, applied at the **main-side
  IPC boundary** (games lists, recent/Continue, favorites — `applyCoverOverrides` /
  `applyCoverOverridesToEntries`), not inside the `resolve*Cover` functions. Use those helpers on any new
  cover path. The details view's "Choose cover…" lists image files that are **direct children** of
  `~/Pictures/launchers-launcher`, `~/Pictures`, `~/Downloads` (≤ 200, ≤ 20 MB, `.png/.jpg/.jpeg/.webp`);
  `installCoverOverride` accepts only such a file (`realpath` — a symlink pointing outside a listed
  folder is refused), copies it (the original stays; a differently-suffixed old override is removed) and
  builds the destination from the game key (`overrideDestParts` sanitises, `.`/`..` forbidden).
- **Recent covers** from a single table: `COVER_LAUNCHERS` in `lib/recent/recent-covers.js`
  (`{ kind, logLabel, hasParams, ensure, resolve, configKey? }`) generates the recent fetchers
  (fire-and-forget download for the quick bar), `withResolvedAllCovers` (live disk resolution for favorites)
  and the favorite fetchers. **For a new emulator it is the descriptor's `cover` field, not a new call**
  (`configKey` only for launch-time-recorded lists, i.e. Ryujinx/Dolphin).

## Recently played, Continue bar, favorites

Three sources of "recent", merged in `lib/recent/usage.js`:

1. **Derived** (`DERIVED_RECENT_LAUNCHER_IDS` = Steam, RetroArch + registry emulators flagged
   `derivedRecent`): read from the launcher's own data (Steam `LastPlayed`, RetroArch
   `content_history.lpl`, PCSX2/DuckStation `playtime.dat`, RPCS3 `persistent_settings.dat`, PPSSPP
   `[PlayTime]`), 30 s TTL cache; **stale-while-revalidate** for the four emulator sources
   (`backgroundSources`, `refreshDelayMs`, `onDerivedChanged`) — an expired cache returns the old list at
   once and one `running-changed` push follows after the background fetch, so the first `get-launchers`
   never waits for a library scan.
2. **Launch-time recorded** (`recentGames` config) for Heroic, Ryujinx, Cemu, Dolphin, melonDS.
3. **Lutris**, whose async CLI is mirrored into `recentGames.lutris` (`lib/recent/recent-games-merge.js`,
   `refreshLutrisRecentMirror`; written/pushed only on change, one run at a time) because the CLI call
   (~0.6–0.7 s) does not fit the synchronous `usage.js` API — hence a separate module.

Helpers: `pushRecentGame(list, entry, max)` (dedupe by `key`, newest first, cap 6),
`buildRecentEntries(games, { timeMs, max, key, kind, params })` (the shared core of the "recent list"
building in six library modules; it does the `msToLaunchedAt` conversion itself, which structurally
prevents the ISO-string bug described in [config-keys.md](config-keys.md#games); the unit of `timeMs(g)` is
the caller's responsibility — Steam's `LastPlayed` is in seconds; RetroArch's `findRecentGames` is
deliberately **not** built on it: its timestamps are index-based and synthetic),
`mergeRecentGameLists(lists, max)` (sort by `Date.parse(lastLaunchedAt)` desc, then dedupe by `key`, cut),
`globalRecentGames(max)` (all sources in one list: the Continue bar uses 3, the panel's "Recently played"
strip 10). `recordUsage` spreads `...prev` (otherwise the next launch would drop `totalMs`);
`recordUsageDuration(appId, ms)` accepts `0 < ms ≤ 24 h`, called from `bringToFront()` with the playtime
session of a real `spawn`/`switchToRunning`; `todayPlaytimeMs()` feeds the reminder; `buildUsageStats`
resolves the Statistics sub-view rows.

**Favorites** (`getFavoriteGames` / `toggleFavoriteGame` → `{ favorited, list }`; IPC `invoke` only): the
key is the `recentGames` key (`steam-game-<appid>` / `heroic-game-<appName>` /
`retroarch:<system>:<label>`); △ pins/unpins; `★ FAVORITE` chip.

**Continue bar** (home screen `#continueBar`): `get-continue-games` = `globalRecentGames(3)` merged with
the Lutris list; a live launcher-started game adds the "▶ BACK" item
([launching.md](launching.md#cancel-resume-session-summary)).

`lib/recent/session-refresh.js` does the bookkeeping around one game/launcher session: `recordRecentGame(meta)` books the
launch-time recent and, for a network-cover emulator (the descriptor's `cover.configKey`: Ryujinx/Dolphin) that just landed on
the bar, fires off the missing cover download — without a branch per emulator name; `afterSession(appId)` runs the **targeted**
cache invalidation and the return warm-up once the session closes (the launch controller's `recordRecentGame` /
`invalidateRecent` callbacks).

## The panel UI

- A **separate overlay** (`#gamesOverlay`, reusing the `.settings-overlay` / `.settings-panel` /
  `.settings-list` CSS — no dedicated CSS), not a Settings sub-view; **fullscreen** (`100vw/100vh`, no
  frame/radius/shadow). Entry points: the "Games" pseudo-card (`GAMES_CARD`, id `__games__`, appended by
  `renderCards()` — **deliberately not in the global `launchers`**, which Settings' launcher/order
  sub-views share and which expect real editable launchers) and the △ button on the home screen.
  Rejected alternative: mixing per-game cards into the carousel (33+ items would scale badly).
- When closing, **sync the physical state of both the closing and the opening button**
  (`closeGamesPanel(gp)` → `syncEdge(buttonStates, gp, ['cross','ps'])`), otherwise PS-closing the panel
  makes the main navigation see a fresh PS press on the next frame and `quit()`.
- **Launch:** one `startGameLaunch({ kind, params, name, cover, fromPanel })` maps `kind` → launch IPC in
  a single place (the panel and `renderer/gamepad.js` `launchRecentGame()` both use it; it contains the
  `isLaunching` guard, feedback, `showLoading`, `armLaunchWatchdog`).
- Sources: `GAME_SOURCES` (steam, gog, legendary, nile, lutris; `launch(row)`) and `EMULATOR_SOURCES`
  (from the registry; `grid`, `networkCover`, `background` flags). The `SOURCE_FILTER_LABELS` chips and
  `availableSources()` derive from them. Filter row: `ALL`, `★ FAVORITE` (if any), the present sources,
  `RETRO`; **L2/R2 cycles the chip** (`cycleSource`). **Focus moves on the filtered
  `gamesPanelVisibleRows`**, not the raw rows.
- **Grid vs list:** per source, see `gamesViewMode`. The grid is `.games-grid` (`auto-fill`,
  `minmax(clamp(120px,15vh,200px),1fr)`, covers `2/3` `object-fit: cover`, lazy `<img>`,
  `.game-cell-noart` placeholder, source badge, 2-line title; **an even gap, no overlap** — the earlier
  overlapping "solitaire cascade" was removed on request; `content-visibility:auto` does not work here
  because `contain-intrinsic-size` clashes with `aspect-ratio`). Navigation:
  `gridNavIndex(idx, dir, cols, nGames, total, headRows)` (◀▶ ±1 without crossing rows, ▲▼ ±columns;
  from the grid's last row down to the first list row and back; `headRows` 1 for the Recent strip); the
  column count is **measured after render** (`afterGamesPanelRender()`, cell `offsetTop`). `isGridRow`
  counts grid cells (an earlier bug excluded the ★ FAVORITE rows).
- **⚠️ `.games-grid` is deliberately `flex: 0 0 auto`, not `flex: 1; overflow-y: auto`.** Every sibling
  section in `#gamesPanelContent` is also non-shrinking; with the grid as the only shrinkable one, the
  flex algorithm put the whole shortfall on it and squashed it to 0 height (cells existed in the DOM, nothing
  visible — reproduced with offscreen Electron). Scrolling belongs to `#gamesPanelContent` alone, for all
  sections together. `.games-retro-list` has no `max-height` / inner scroll (a 30vh cap once boxed the
  RetroArch list into a small window in a fullscreen panel); the rule is unconditional because in the ALL
  view there is no `.games-grid` sibling for a sibling selector to match.
- **RetroArch drill-down** (only RetroArch has one; for single-"system" emulators the intermediate step
  was removed on request): `list-retroarch-games` → label-sorted full list shown as a cover grid;
  L2/R2 = **letter jump** (`nextLetterIndex`: forward to the next initial's start; backward first to the
  current group's start, then the previous group); ○/PS steps back to the root (and resets the cover-fetch
  state) instead of closing. The core for a ROM comes from `SYSTEM_CORES` / `corePathForSystem` (see
  [launchers/retroarch.md](launchers/retroarch.md)).
- **"Recently played" strip** in ALL (a single `{ type: 'recent', items }` row at the head, ◀▶ moves a
  sub-index across the 10 mini covers, ✕ launches by the item's own `kind`); △ pin on it is a no-op.
  `refreshGamesPanelRecentIfOpen()` re-queries on `running-changed`, so an open panel updates when a
  missing cover arrives. Hidden while a search is active.
- **melonDS loads in the background:** the registry's `background: true` sources are taken out of the
  opening `Promise.all`, so the panel opens at once with the fast sources and
  `refreshEmulatorGamesInBackground(src)` appends the rows when they arrive (the `MELONDS` chip appears
  then; a stale result is a no-op if the panel closed or a RetroArch system was entered). The first cold
  scan of a large network ROM set took ~1.6 s. The quick-menu path
  (`LAUNCHER_GAMES_COUNT_CHECK.melonds`) still waits for the full list because it must know whether there
  are any games.

## ALL view and the RetroArch ROM set

In **ALL** every source — Steam/GOG/Epic/Amazon/Lutris and all registry emulators — is turned by
`toUnifiedRow(row)` into `{ type:'unified', name, sourceLabel, cover, favKey, launch }` and merged into
one alphabetical list (`Intl.Collator`, 'hu', numeric, base sensitivity — **one shared collator**, since
`localeCompare(…, opts)` constructs a new one on each call and took seconds at 16 000 items). In the ALL
view `gameRows` and `emulatorRows` are empty, so `nGames` is 0 and `gridNavIndex` degrades to plain ▲▼
list stepping with no extra branch.

The **whole RetroArch ROM set (~15 700 titles)** is part of that list. `list-retroarch-all-games` returns
`[{ system, games:[{label,path,cover}] }]` grouped per system, loaded **in the background** on panel open
(until then the per-system summary shows; afterwards the ROMs appear and the summary disappears;
unchanged `system:count` signatures drop the reload). ROMs are persistent `'unified'` rows
(`retroGroupsToUnifiedRows`: `favKey: retroarch:<system>:<label>`, `launch: { kind:'retroarch', params:
{system,path} }`, badge `RETRO · <system>`); the `RETRO` chip / □ filter excludes them. **Performance —
the "re-render on every navigation step" model cannot work with 16 000 rows:**

1. The merged, sorted list is **memoised** (`buildUnifiedRows(grid)`, key = row/retro-group references +
   excluded ids + mode); the small non-RetroArch part is sorted and merged linearly with the pre-sorted
   RetroArch array (`mergeSortedByName`).
2. **Windowed rendering** above `VIRT_THRESHOLD` (300): only a `VIRT_HALF_WINDOW` (120)-radius window
   around the focus is in the DOM (`unifiedSectionHtml`, `virtualWindow` aligned to full rows for a grid);
   skipped rows are replaced by inline `padding-top/bottom` (`virtualPadding`). The row pitch is **measured**
   by `afterGamesPanelRender()` (`data-virt="start,end,total"` → `applyVirtPadding`) and the next render uses
   it — the padding must exist at render time, or the `innerHTML` swap would collapse the scroll height for a
   frame and lose `scrollTop`.
3. `nGames` (`filter(isGridRow)`) is recomputed only on edge changes.
Verified offscreen with 16 000 fake ROMs (grid and list, deep jumps, ▲▼◀▶, ends): the focused element is
always visible, the DOM stays at ~120–250 cells, worst navigation step ~35–55 ms. **No letter-jump in ALL**
(L2/R2 cycle the chip there); RETRO chip → system drill-down is the fast path.
Covers in the ALL grid: `scheduleUnifiedRetroCoverFetch()` — a focus-windowed, debounced batch,
**one `ensure-retroarch-game-covers` call per system** (the window may span systems), writing into the
persistent row objects (`system\0label` session dedup; none in list mode).

## Search

Renderer-only (no main/IPC/config/lib change). **Select/View** opens it in the root view and in the
RetroArch drill-down (`openKeyboard({ layout:'compact', dock:'bottom', live:true, onChange, onConfirm,
onCancel, ownerStates })`, see [renderer/overview.md](renderer/overview.md)). It filters the **active chip's** rows
**after** chip filtering (all branches: ★, ALL, single sources).

- Pure helpers (`module.exports`, tested): `normalizeSearchText` (lowercase, NFD accent strip, non-alphanumerics →
  space), `searchTokens`, `isSearchActive` (threshold `SEARCH_MIN_CHARS = 3` on the **normalised,
  space-free** characters, so "a b" is not active yet), `searchRows(items, query, nameOf?)`: every token a
  substring (order-independent AND), two-level stable rank (all tokens at word starts first, in-word matches
  after; both keep alphabetical order). The key `" <normalised name> |<without spaces>"` is cached on the
  object (`_sk`, carried by `{...row}` copies); the space-free segment lets `megaman` / `fzero` find "Mega
  Man" / "F-Zero". Measured on 15 700 titles: key build once ~22 ms, one filter ~0.5 ms — no index/IPC needed.
- Semantics: `gamesPanelQuery` lives per panel session (reset by `openGamesPanel()`), **survives chip
  changes**, is cleared on entering/leaving a RetroArch drill-down. **RETRO chip + active search** → a flat
  cross-system ROM list from `gamesPanelRetroUnified` (rows are `{ ...r, grid, _src: r }` **copies** because the
  persistent row's `.grid` belongs to ALL — don't mutate it; lazy cover patches write back to the persistent
  row through `_src`, or every render would lose them); until the ROM set loads it filters the system *names*.
  **○/PS with a non-empty search first only clears the search** (hint `games.hintClearSearch`). The system
  drill-down uses `systemGamesView()` (a one-element memo keyed by source-array reference + query)
  **everywhere the raw array was indexed** — render, ✕ launch, favorite toggle, letter jump, cover batches;
  **new drill-down code must not index the raw array**. `fetchUnifiedRetroCovers()` computes from the last
  rendered rows (`gamesPanelShownUnified`), not the unfiltered cache, and also runs on the `retro` chip.
- UI: a sticky `.games-search` bar under the chips (`🔍 text▏ · N results` / `· N more characters`), empty
  result → `emptyState(games.searchEmpty)`. Under a docked keyboard `#gamesOverlay` gets `kb-docked` and
  `--kb-h` (the measured keyboard height → panel bottom padding, so the list stays above the keyboard; the
  panel hint is hidden). A physical keyboard also works (`gamesSearchKey`, Esc clears).

## Filter popup, view/sort modes, hidden, NEW

- **□ Square** opens `#gamesFilterOverlay` (a nested overlay above `#gamesOverlay`, from the root view when
  `filterableSources().length > 1`): a persistent on/off list of which sources take part in **ALL** (the
  `gamesHiddenSources` key via `registerPrefChannel`). The exclusion narrows **only the ALL aggregation**
  (`sourceIncluded`, `includeSource`) — a source's own chip and the card quick-menu still reach it (user
  decision); the ALL-only "Recently played" strip follows it (`recentItemSourceId(item)` resolves a recent
  item's source: Heroic's `kind` is always `heroic`, the store is `params.runner` → `gog`/`legendary`/`nile`;
  `retroarch` → `retro`). If every present source is excluded, `games.allHiddenEmpty` shows. The popup also
  has "Show hidden games" (per run).
- **View mode** (`gamesViewMode`, Settings → Games → "Grid or list"): per source, independent; the renderer
  marks each row with `row.grid` (`effectiveViewMode` mirrors the pure `resolveGamesViewMode`); the list rows
  are rendered by `gameRowsListHtml()` / `emulatorSourceHtml()`. The ★ FAVORITE filter follows the ALL setting;
  the RetroArch root summary is not switchable.
- **Sort mode** (`gamesSortMode`, R3 cycles name → recent → playtime → recently added): data from
  `get-games-sort-stats` (`buildGamesSortStats` from `usage` — **games launched through the launcher only**;
  `partitionBySortMode` puts the measurable ones first, the rest and the RetroArch ROM set by name).
- **Hidden games** (`hiddenGames`): filtered renderer-side (`isGameFiltered`); the ALL memo keys on the Set
  identity (create a new Set on each change); ★ FAVORITE is not filtered (pinning is explicit intent).
- **NEW badge / recently added** (`lib/recent/games-first-seen.js`, `note-games-seen`): the launcher keeps its
  own "first seen" record, independent of any library's mtime. Games seen in the **first 10 minutes** (baseline)
  get `0` = old (the whole library must not be "new" on the first run); later keys get the time seen. NEW = seen
  within 7 days **and** never launched (`usage[key].count`); the grid cell gets `.game-cell-new`, a list row a
  `NEW · ` prefix. RetroArch ROMs are not tracked (≤ 5000 keys).

## Details view

Long-press ✕ (`edgeHold`, `HOLD_MS` 550 — the same gesture as the home card menu) on a game anywhere
(root grid/list, ★, a Recently-played item, a RetroArch ROM). A short ✕ still opens/launches, but now on
**release**. □ is taken by the source filter here, hence not □. Where there is nothing to show (a RetroArch
system row) `openGameDetailsForFocused()` returns `false` and the hold falls back to a short press.
`focusedGameEntry({ includeRecent })` builds the recent/favorite-shaped `{ key, name, cover, kind, params }`
(△ pin uses it too).

`get-game-details` → `lib/games/game-details.js`: `launcher` (the `usage[key]` entry — a game's `spawnGame`
appId is exactly the key; RetroArch's shared counter is not per ROM, so none), `native` (the `NATIVE_PLAY`
table in `recent-ipc.js`: PCSX2/DuckStation `playtime.dat`, PPSSPP `[PlayTime]`, RPCS3
`persistent_settings.dat`, Steam `LastPlayed`, Lutris `lastplayed`), `file` (path + size; a folder for
Cemu/RPCS3), `cover` (override path + whether active), `metadata`. UI (`games-panel-details.js`,
`gamesDetails` overlay): big cover, source badge, ★ state, facts (playtime — the native measurement wins and
its source is named, otherwise the launcher-started one; last played = the later of the two; launches;
file + size or "NOT FOUND"; custom cover path), actions Launch / Pin–Unpin / Hide / Choose cover / Launch
options / Back (▲▼ + ✕, △ = pin, ○/PS back).

**Offline metadata** (`lib/games/game-metadata.js`): Heroic/Epic `store_cache/legendary_library.json`
(≈ 7 MB; first read ~80 ms, then an mtime cache ~1 ms): `developer`, `extra.about.description` (≤ 700 chars; a
description that merely repeats the title is skipped), `extra.storeUrl`; Steam `appcache/librarycache/<appid>/
library_hero.jpg` as a blurred background. **Not available:** GOG/Nile (library files hold only title/cover),
Steam description/genre (in the binary `appinfo.vdf` — format-sensitive, a separate item), screenshots,
RetroArch libretro-database `.rdb`.

## Playtime reminder, place memory

- **Reminder** (`playtimeReminder`, 0 / 1–4 h): when **today's** (local date) launcher-started playtime reaches
  the threshold, returning from a game shows a toast ("TODAY 2h 5m OF PLAY — TIME FOR A BREAK",
  `playtimeReminderText`, from `onAppClosed`; the `app-closed` payload carries `todayMs`). **Deliberately no
  notification during play:** the launcher is hidden then, "Do not disturb" would mute it, and a
  `notify-send` would clash with it.
- **Place memory:** on close (○ or a game launched from the panel) `createOverlay`'s `onClose` saves the source,
  query, focused row **by key** (`gamesRowKey()`) and the RetroArch drill-down system + ROM
  (`captureGamesPanelMemory()`); the next **parameterless** `openGamesPanel()` returns there (a card-menu open
  of a specific source starts fresh). This run only (user decision, no config key). `applyPendingGamesFocus()`
  keeps looking for the key until the row appears (the RetroArch set loads in the background); any user
  navigation clears the pending key. Settings also keeps its category + item focus. **In e2e, any scenario
  that assumes a fresh panel opens with `gamesPanelMemory = null;`.**

## Steam and Heroic launch notes

- **Steam:** the first design bypassed `child.on('close')` with a manual "PS = back to the launcher", because
  `steam steam://rungameid/<appid>` returns at once with `exit 0` when a Steam client is already running (the
  `/usr/bin/steam` wrapper forwards over `~/.steam/steam.pipe`), so `close` does not mean the game closed. The
  user did not want that; the final solution follows the existing "Steam Big Picture" launcher card: the normal
  `spawnGame()` with `-gamepadui -tenfoot steam://rungameid/<appid>` — it starts Big Picture **and** the chosen
  game, and on exit the launcher returns via the usual `bringToFront()`. Verified with a controller.
  `isSteamRunning()` (`steam.pid` + `kill(pid, 0)`) is only used for logging. Seen, launcher-independent: a KDE
  crash dialog from Proton's `wine64-preloader` after closing a game — harmless, Proton/Wine level.
- **Heroic:** `heroic://launch?appName=<appName>&runner=<runner>` (found by inspecting Heroic's `app.asar`;
  `parseHeroicUrl` finds the `heroic://` arg anywhere in argv) with **`--no-gui`**, which Heroic itself uses in
  its non-Steam shortcut generator: headless, and the launch **blocks until the game closes**, then exits — so
  here, unlike Steam, `close` really means the game closed and the normal `spawnGame` model fits. `runner`
  values (`gog`/`legendary`/`nile`) equal the `runner` fields in Heroic's `store_cache/*_library.json`, so no
  translation. Verified with GOG + Epic; Amazon was not installed on the test machine.
- **RetroArch:** `flatpak run org.libretro.RetroArch -L <core> <rom>`; fits the `launch-app` model unchanged (the
  `retroarch` process is the running emulator). `SYSTEM_CORES` is the intersection of the flatpak's
  `share/libretro/info/*.info` and the actually installed `cores/*.so` — not guesswork; the playlists' own
  `default_core_path` is empty everywhere on the test machine. No PSP core is installed; PSP goes through the
  separate PPSSPP launcher.
