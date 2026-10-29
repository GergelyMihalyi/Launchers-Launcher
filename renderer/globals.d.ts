// Global declarations of the renderer typecheck (jsconfig.renderer.json). The renderer files are classic <script src>s with a shared
// global scope — TS sees each other's top-level names by itself; only globals coming from OUTSIDE are needed here.

// `window.launcher` — the API exposed by preload.js via `contextBridge`. The type comes from the preload's `api` constant: a mistyped /
// nonexistent `window.launcher.x()` call fails at compile time.
type PreloadApi = typeof import('../preload.js').api;
// Mapped type: the type of an object literal defined in a JS file is "open" (TS JSLiteral — accessing an unknown property on it is NOT an
// error); the copied type is closed, so a mistyped `window.launcher.lisGames()` gives an error.
type LauncherApi = { [K in keyof PreloadApi]: PreloadApi[K] };

interface Window {
    launcher: LauncherApi;
}

// controller-id.js — loads as a <script src> (BEFORE the renderer) and writes its functions onto `window` (IIFE + module.exports guard,
// shared with the main process). `var` (not `const`): controller-id.js writes them as properties of `window`/`globalThis`.
declare var classifyController: typeof import('../controller-id.js').classifyController;
declare var controllerSymbols: typeof import('../controller-id.js').controllerSymbols;
declare var CONTROLLER_SYMBOLS: typeof import('../controller-id.js').CONTROLLER_SYMBOLS;

// launcher-registry.js — the same pattern (the shared registry of the Games panel's emulator sources).
declare var EMULATOR_REGISTRY: typeof import('../launcher-registry.js').EMULATOR_REGISTRY;
declare var launchParamsFor: typeof import('../launcher-registry.js').launchParamsFor;
declare var CUSTOM_GAMES_SOURCE_ID: typeof import('../launcher-registry.js').CUSTOM_GAMES_SOURCE_ID;

// The guards belonging to the Node tests (`if (typeof module !== 'undefined') …`) — `module` does not exist in the browser; this is only
// so the guarded branch can be type checked.
declare var module: { exports: any; require(id: string): any } | undefined;
