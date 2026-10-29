'use strict';

// Preload of the screenshot maker (user-guide-shots.js) — modeled on test/e2e/preload-stub.js,
// just with the user-guide sample data: `initial*` → value, `on*(cb)` → stored callback, known
// invoke → the fixture, anything else → `Promise.resolve()`. Renderer errors go to `__shots.errors`.

const { INVOKE } = require('./user-guide-fixtures.js');

const listeners = {};
const shots = { errors: [], listeners };
shots.emit = (name, data) => (listeners[name] || []).forEach((cb) => cb(data));

const INITIAL = {
    initialTheme: 'neon',
    initialBackground: {},
    initialLauncherIcons: INVOKE.getLaunchers.map((l) => l.icon),
    initialSafeMode: null,
};

window.launcher = new Proxy({}, {
    get(_, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop in INITIAL) return INITIAL[prop];
        if (prop === 'logClientError') {
            return (payload) => { shots.errors.push(`[logClientError] ${payload && payload.context}: ${payload && payload.message}`); };
        }
        if (/^on[A-Z]/.test(prop)) {
            return (cb) => { (listeners[prop] ||= []).push(cb); };
        }
        return (...args) => {
            if (prop in INVOKE) {
                const v = INVOKE[prop];
                return Promise.resolve(structuredClone(typeof v === 'function' ? v(...args) : v));
            }
            return Promise.resolve(undefined);
        };
    },
});

window.addEventListener('error', (ev) => { shots.errors.push(`[error] ${ev.message} @ ${ev.filename}:${ev.lineno}`); });
window.addEventListener('unhandledrejection', (ev) => { shots.errors.push(`[unhandledrejection] ${ev.reason}`); });

window.__shots = shots;
