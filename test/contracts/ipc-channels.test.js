'use strict';

// IPC channel consistency: every channel the preload uses is also handled by main
// (and vice versa, for the notifications). Based on source text (the preload cannot be
// required under node because of contextBridge). This catches typo'd channel names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listJsFiles } = require('../helpers/fs.js');

const root = path.join(__dirname, '..', '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
// Part of the main-side `sendToRenderer` calls live in the lib/ modules (main passes them the
// guarded `sendToRenderer` via DI: launch-controller, *-ipc.js, system-power, running-poll, recent-covers
// …) — EVERY `lib/**/*.js` that calls `sendToRenderer(` goes into the channel scan. Recursive
// discovery, NOT a manual list: a manual list once silently missed two sending modules
// (recent-covers, recent-games-merge).
const libDir = path.join(root, 'lib');
const senderSrcs = listJsFiles(libDir)
    .map((rel) => fs.readFileSync(path.join(libDir, rel), 'utf8'))
    .filter((src) => src.includes('sendToRenderer('));
const mainSideSrc = [mainSrc, ...senderSrcs].join('\n');
const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
const uniq = (xs) => [...new Set(xs)];

// Main-side registration: every `lib/**/*.js` that registers by itself — the `register*Ipc({ ipcMain, … })`
// functions of `lib/ipc/<domain>-ipc.js` (main.js only calls them). The channel name is a
// verbatim literal at the call site, so the regex sees it.
//
// `registerPrefChannel(getChan, setChan, changedEvent, {...})` (lib/ipc/prefs-ipc.js — the shared
// factory of trivial get/set prefs IPC pairs) gets the 3 channel names AS ARGUMENTS — a separate
// regex extracts them. Recursive discovery, not a manual list.
const registrarSrcs = listJsFiles(libDir)
    .map((rel) => fs.readFileSync(path.join(libDir, rel), 'utf8'))
    .filter((src) => src.includes('ipcMain.') || src.includes('registerPrefChannel('));
const registerSideSrc = [mainSrc, ...registrarSrcs].join('\n');
const prefChannelCalls = [...registerSideSrc.matchAll(
    /registerPrefChannel\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g,
)];
const mainHandlers = uniq([
    ...matchAll(registerSideSrc, /ipcMain\.(?:on|handle)\(\s*['"]([^'"]+)['"]/g),
    ...prefChannelCalls.flatMap((m) => [m[1], m[2]]),
]);
const mainSends = uniq([
    ...matchAll(mainSideSrc, /sendToRenderer\(\s*['"]([^'"]+)['"]/g),
    ...prefChannelCalls.map((m) => m[3]),
]);

// preload.js
const preloadInvokeSend = uniq(matchAll(preloadSrc, /ipcRenderer\.(?:invoke|send)\(\s*CH\.([A-Za-z0-9_]+)/g));
const preloadOn = uniq(matchAll(preloadSrc, /ipcRenderer\.on\(\s*CH\.([A-Za-z0-9_]+)/g));

// Extract the CH map key -> channel name from the source
const CH = Object.fromEntries(
    [...preloadSrc.matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']+)',/gm)].map((m) => [m[1], m[2]]),
);

test('every CH.<key> reference in the preload is an existing key in the CH map', () => {
    for (const key of [...preloadInvokeSend, ...preloadOn]) {
        assert.ok(CH[key], `preload CH.${key} is not in the CH map`);
    }
});

test('main handles every preload invoke/send channel (ipcMain.on/handle)', () => {
    for (const key of preloadInvokeSend) {
        assert.ok(
            mainHandlers.includes(CH[key]),
            `preload sends/invokes '${CH[key]}' (CH.${key}), but main.js registers no ipcMain.on/handle for it`,
        );
    }
});

test('every preload on() feedback is sent by main (sendToRenderer)', () => {
    for (const key of preloadOn) {
        assert.ok(
            mainSends.includes(CH[key]),
            `preload listens to '${CH[key]}' (CH.${key}), but main.js never sends it with sendToRenderer`,
        );
    }
});

test('the preload listens to every sendToRenderer channel of main', () => {
    const listened = new Set(preloadOn.map((k) => CH[k]));
    for (const ch of mainSends) {
        assert.ok(listened.has(ch), `main.js sendToRenderer('${ch}'), but the preload exposes no on() for it`);
    }
});

// main.js is the composition root: the channel is registered in the domain module.
test('main.js does not register IPC channels directly; every channel is registered exactly once', () => {
    const code = mainSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /ipcMain\.(on|handle)\(/, 'a new channel goes into the register*Ipc of lib/ipc/<domain>-ipc.js');
    const all = [
        ...matchAll(registerSideSrc, /ipcMain\.(?:on|handle)\(\s*['"]([^'"]+)['"]/g),
        ...prefChannelCalls.flatMap((m) => [m[1], m[2]]),
    ];
    const dup = all.filter((ch, i) => all.indexOf(ch) !== i);
    assert.deepEqual(dup, [], `channels registered more than once: ${dup.join(', ')}`);
});
