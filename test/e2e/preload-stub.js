'use strict';

// Preload of the e2e smoke (NOT the real preload.js — its contextBridge would not work without
// IPC). It runs with `contextIsolation: false` + `sandbox: false`, so it can require the fixtures
// and write to `window` directly. Every `window.launcher.x(...)`:
//   - `initial*` → a plain value,
//   - `on*(cb)` → the callback is stored (called by `__e2e.emit(name, data)`),
//   - known invoke (`fixtures.INVOKE`) → a Promise with the fixture (function fixture: called with the arguments),
//   - anything else (send-like action) → recorded in `__e2e.calls`, `Promise.resolve()`.
// Renderer errors (window error / unhandledrejection / logClientError) go to `__e2e.errors`.

const { INVOKE } = require('./fixtures.js');

const listeners = {};
const e2e = { errors: [], calls: [], listeners };
e2e.emit = (name, data) => (listeners[name] || []).forEach((cb) => cb(data));

const INITIAL = {
    initialTheme: 'neon',
    initialBackground: {},
    initialLauncherIcons: (INVOKE.getLaunchers || []).map((l) => l.icon),
    initialSafeMode: null,
};

window.launcher = new Proxy({}, {
    get(_, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in INITIAL) return INITIAL[prop];
        if (prop === 'logClientError') {
            return (payload) => { e2e.errors.push(`[logClientError] ${payload && payload.context}: ${payload && payload.message}`); };
        }
        if (/^on[A-Z]/.test(prop)) {
            return (cb) => { (listeners[prop] ||= []).push(cb); };
        }
        return (...args) => {
            e2e.calls.push({ name: prop, args });
            if (prop in INVOKE) {
                const v = INVOKE[prop];
                return Promise.resolve(structuredClone(typeof v === 'function' ? v(...args) : v));
            }
            return Promise.resolve(undefined);
        };
    },
});

window.addEventListener('error', (ev) => {
    e2e.errors.push(`[error] ${ev.message} @ ${ev.filename}:${ev.lineno}`);
});
window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    e2e.errors.push(`[unhandledrejection] ${r && r.stack ? r.stack.split('\n').slice(0, 3).join(' | ') : r}`);
});

window.__e2e = e2e;
