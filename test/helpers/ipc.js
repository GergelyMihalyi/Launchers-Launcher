'use strict';

// Fake `ipcMain` for the tests of the `register*Ipc({ ipcMain, … })` functions in `lib/ipc`: records
// the registered channels and makes them callable (`invoke` = handle, `send` = on, `sendSync` = on +
// `event.returnValue`).
function fakeIpcMain() {
    const handlers = new Map();
    const listeners = new Map();
    return {
        handle(ch, fn) {
            if (handlers.has(ch)) throw new Error(`handle registered twice: ${ch}`);
            handlers.set(ch, fn);
        },
        on(ch, fn) {
            if (listeners.has(ch)) throw new Error(`on registered twice: ${ch}`);
            listeners.set(ch, fn);
        },
        channels: () => [...handlers.keys(), ...listeners.keys()].sort(),
        invoke(ch, payload) {
            if (!handlers.has(ch)) throw new Error(`no handle: ${ch}`);
            return handlers.get(ch)({}, payload);
        },
        send(ch, payload) {
            if (!listeners.has(ch)) throw new Error(`no on: ${ch}`);
            return listeners.get(ch)({}, payload);
        },
        sendSync(ch, payload) {
            const event = { returnValue: undefined };
            listeners.get(ch)(event, payload);
            return event.returnValue;
        },
    };
}

// A logger that collects the lines (with `.warn`/`.error` markers, like `createLogger`).
function fakeLog() {
    const lines = [];
    const log = (msg) => { lines.push(msg); };
    log.warn = (msg) => lines.push(`WARN ${msg}`);
    log.error = (msg) => lines.push(`ERROR ${msg}`);
    log.lines = lines;
    return log;
}

module.exports = { fakeIpcMain, fakeLog };
