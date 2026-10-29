# Testing and development limits

## Running the tests

- **`npm test`** = `node --test --require ./test/helpers/setup.js "test/**/*.test.js"` (Node's built-in runner, no
  dependency; the glob needs Node ≥ 21, and Electron 44's install script needs **Node ≥ 22.12** — `engines`). A single
  file: `node --test --require ./test/helpers/setup.js test/x.test.js`. **Never run a bare `node --test`**: it matches
  `test/**/*.js` and would run the helpers as tests — that is why the glob is in the script.
- The agent shell's `node` can be an old nvm Node (v20), on which the glob fails with "Could not find 'test/**/*.test.js'":
  run `/usr/bin/node --test --require ./test/helpers/setup.js "test/**/*.test.js"` (22.x).
- **Everything is English** (2026-10-28): code, comments, log lines, error reasons, test titles and fixtures, and the docs. Hungarian lives
  only in the program's own UI table (`renderer/i18n/i18n-hu.js`). `test/contracts/english-only.test.js` enforces it (the Hungarian-specific letters and a
  word list); a file that must hold Hungarian *samples* (a Hungarian-locale command output, legacy log lines, the HU UI table) is listed in
  its `ALLOWED` map with the reason. A new test is titled in English from the start.
- **`npm run typecheck`** ([architecture.md](architecture.md#typing-without-a-build-step)); **`npm run lint:shell`**
  (shellcheck through the npx cache — not installed system-wide, and deliberately not a devDependency).
- **Git hooks** (`.githooks/`, switched on automatically at every `npm install` by `prepare`; manually `npm run setup-hooks`):
  pre-commit runs `test/contracts/` (~15 s, including the typecheck), pre-push the whole test + `lint:shell`. They look for
  Node ≥ 22 themselves (`/usr/bin/node` first). Escape hatch: `--no-verify`. The agent's commits pass through them too.
- What is **not** tested: GUI/Electron logic (`main.js` and `bootstrap.js` cannot be `require`d in a sandbox because of their
  `electron` dependency — which is why logic is extracted into `lib/*.js`, the testable layer; `node --check bootstrap.js` /
  `main.js` at least checks syntax). Changing a data file, schema, IPC channel, `preload.js`, `lib/*.js` or `renderer/*.js`:
  run and extend the tests; GUI behaviour the unit tests do not cover must be validated on real data/commands, not by eye.

## Structure

The test tree mirrors `lib/` and `renderer/` subfolders ([architecture.md](architecture.md#folder-organisation-rules) rule 6).

- **`test/helpers/`** — not test files. `setup.js` (preloaded into every test process): a fresh temp `HOME` and the
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` cleared, so a test **never** reads or writes the machine's real
  `~/.config/launchers-launcher/` or `~/.local/share/launchers-launcher/` (cover cache, scan cache) — skipped inside a worker thread (a
  `terminate()`d worker's `exit` handler would not run and the temp folder would stay). `fs.js`: `tmpDir(prefix)` (auto-removed at
  process end — **do not call `fs.mkdtempSync` directly**, it would linger in `/tmp`), `withTempHome(fn)` (sync or async, then
  restores; lib modules' call-time `os.homedir()` sees it — **never monkey-patch `os.homedir`**), `useTempConfigHome()` (before
  `lib/config.js` is required; `reset()`), `mkdirp`, `writeFile(dir, rel, data)`, `listJsFiles(dir)`, `writeRawConfigKey` (a hand-broken
  config). `fixtures.js`: synthetic binary fixtures — `buildFakeIso(tree, { noMagic, rawSectors })` (an ISO9660 from a tree
  description, plain 2048 or raw 2352/Mode2-Form1 sectors), `isoDirRecord`, `buildFakeParamSfo`, `serialToBootLine(serial, { ps2,
  subdir })`, `inflatePngPixels`, `buildFakeZip(entries)` (stored/deflate); look here before writing a new launcher fixture.
  `ipc.js`: `fakeIpcMain()` (`channels()`, `invoke`/`send`/`sendSync`) + `fakeLog()` (collects lines, `.warn`/`.error`
  marked). `launcher-list-deps.js`: `fakeDeps()` for the launcher-manage/variant IPC tests.
- **`test/contracts/`** — repo-level, source-text contract tests (not unit tests of one module): `ipc-channels` (preload ↔ main),
  `dom-ids`, `i18n-keys`, `settings-views`, `launcher-tables` (the game-source tables' mutual consistency: `EMULATOR_SOURCES` ↔
  `GAMES_SOURCE_IDS` ↔ `GAME_LOADERS`/`GAME_WARMUP_ORDER` ↔ the `startGameLaunch` kind map ↔ the descriptor's `launch` ↔
  `NETWORK_COVER_SOURCES`/`ensure-*-covers`/`COVER_LAUNCHERS` ↔ `LAUNCHER_ID_TO_GAMES_SOURCE` — **for a new emulator this tells you which
  table was missed**), `renderer-smoke` (the bundle in `index.html` order compiled with `vm.Script`, plus a DOM-stub run that
  calls the main render functions on fake data — it catches an `undefined.map`), `require-smoke` (every `lib/**/*.js` required
  in a sandbox), `typecheck`, `shell`, `install-sh`, `host-packages-mirror`, `desktop-entry`, `docs-links`, `data` (catalog schema
  + existing icons, background SVG pairing), `themes`, `timings`, `window-hardening`, `csp`, `css-links`, `html-escape`,
  `flatpak-ids`, `main-size`, `tv-mode-enter-trust`, `user-guide`, `english-only`. Repo root from there: `path.join(__dirname, '..', '..')`.
- **`test/launchers/shared/`** — the single test of the shared format parsers; the launcher tests only check launcher-specific
  wiring (the re-export identity is checked by the shared test).
- **Table-driven where the source is a table** (e.g. a per-emulator `launch-ipc` case table — a new emulator = one row).
- **Notable regression guards:** `melonds-library.test.js` monkey-patches `fs.readSync` to **measure bytes read** on a > 6 MB zip entry
  (a whole-file read fails it) and `fs.openSync` to count calls on an unchanged second scan; the `playtime.dat` /
  `persistent_settings.dat` launchers' `lastLaunchedAt` ISO-string assertion; `cemu-library.test.js`'s fixture **writes the
  `iconTex.tga` itself** — the test once passed only because the machine's real cover cache held the same title id; the `setup.js`
  isolation exists against such hidden machine dependencies.
- **Deliberately live, machine-dependent calls:** `isLauncherInstalled` in `launcher-list.test.js` (`which`/`flatpak info`) and
  `host-deps/selftest.test.js` (`which node`).
- Tests that use the network are mocked (`download` injected); a live `systemctl`/`cec-ctl`/`bluetoothctl` call is never tested —
  only the pure parsers and state machines (the `cec.js`/`bluetooth.js` pattern); every timer test ends with an immediate clear so no
  `setTimeout` stays alive in the runner's event loop.
- The end-user guide has its own contract: `test/contracts/user-guide.test.js` — a new scene = an image + a reference in the guide.

## End-to-end smoke

**`npm run test:e2e`** loads the **real** `index.html` into an offscreen `BrowserWindow` with a `window.launcher` Proxy stub
(`test/e2e/preload-stub.js`; fake data in `test/e2e/fixtures.js`, shaped like the real handler replies — **for a new invoke channel
add a row there**, or the renderer gets `undefined`). Scenarios: boot + carousel centring, round-robin navigation, all 15 themes,
the fixed Settings panel + **every** sub-view opening, the Games panel with 16 000 RetroArch ROMs (virtualisation + deep focus visible),
search with the docked keyboard (the list sits above it), UI scale `large`, the screen-reader announcement, game details. It fails on any
renderer error (`error`/`unhandledrejection`/`logClientError`/`console.error`). It is **not** part of `npm test` (`e2e.spec.js`, not
`*.test.js`; ~7 s, starts an Electron binary; the child env drops `ELECTRON_RUN_AS_NODE`, so it runs from the agent sandbox too). Options:
`E2E_WIDTH`/`E2E_HEIGHT` (e.g. 3840×2160, 2560×1080) and `E2E_SHOTS=<folder>` (PNG screenshots, for before/after an Electron upgrade).
Directly: `env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron test/e2e/harness.js --headless --no-sandbox` → an
`E2E_RESULT <json>` line. **In e2e, any scenario that assumes a fresh Games panel starts with `gamesPanelMemory = null;`.**

**⚠️ Do not measure an animated element after a fixed `sleep()`:** the offscreen window gets frames less often on a loaded machine and an
animation advances with frames (after 700 ms of wall clock a 0.42 s transition was still at 300 ms) — wait for the animations'
`finished` as `settleCarousel(win)` does.

## Reproducing CSS/layout bugs without a GUI: offscreen Electron render

The agent shell has `ELECTRON_RUN_AS_NODE=1` (so `electron .` / `npm start` runs as plain Node, with no window — presumably a deliberate
guard); a real GUI/gamepad test must be done by the user from a normal terminal (`npm start`). The restriction can be bypassed for
**layout debugging** with a separate **agent-written** script (kept in the scratchpad, **not in the repo**) that starts the *real*
Electron binary with `env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron <script.js> --headless --no-sandbox`, creating
`new BrowserWindow({ show: false, webPreferences: { offscreen: true } })` — this runs the real Chromium layout engine without GPU or a
display. `win.loadFile(...)` loads the real `index.html` (read-only from the repo) with its own `webPreferences.preload`
(`contextIsolation: false`) installing a Proxy-stubbed `window.launcher` (every call returns `Promise.resolve(...)`; the real
`preload.js` `contextBridge` cannot work without IPC). With `win.webContents.executeJavaScript(...)` the global (non-module) `<script>`
top-level `let`s (e.g. `gamesPanelRows`) are directly readable/writable and callable (the same shared lexical scope as the DevTools
console), and `element.getBoundingClientRect().toJSON()` returns exact pixel data (**a raw `DOMRect` is not structured-cloneable**, `.toJSON()` is
needed). **Gotcha:** do not measure a CSS-`transition`ed property (e.g. `.settings-overlay.visible .settings-panel { transform: scale(1) }`)
in the same synchronous `executeJavaScript` call in which you added `.visible` — the measured value is still the transition's *start*; use a
second, separate call with a real `setTimeout` in the main process (≥ the transition duration) between the two. This is how the `.games-grid`
`flex: 1` collapse-to-zero-height bug was found.

## The end-user guide screenshots

`npm run user-guide-shots` (`tools/user-guide/`) renders the real UI offscreen with invented sample data into `docs/user-guide/img/`.
**After a visible UI change, run it again and commit the images.** A new scene = an image + a reference in the guide
(`test/contracts/user-guide.test.js`). Tests: `test/tools/`.

## Documentation upkeep

`test/contracts/docs-links.test.js` keeps the documentation honest: every internal link and `#anchor` in `docs/dev/` resolves, every
`lib/**` module is mentioned in `docs/dev/`, every `docs/dev/<page>.md#anchor` referenced from the code exists, and the repo contains
no reference to the retired planning-notes folder.
