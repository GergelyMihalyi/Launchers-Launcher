'use strict';

// `applyStartupOutputs`: a missing startup sink starts a BACKGROUND wait (the returned promise does not wait for it).

const test = require('node:test');
const assert = require('node:assert/strict');

const audio = require('../../lib/output/audio.js');
const displays = require('../../lib/output/displays.js');
const startupOutputs = require('../../lib/output/startup-outputs.js');

function stub(obj, name, fn) {
    const orig = obj[name];
    obj[name] = fn;
    return () => { obj[name] = orig; };
}

async function run(applied) {
    const calls = { wait: [] };
    const restore = [
        stub(displays, 'listMonitors', async () => []),
        stub(displays, 'captureDesktopSnapshot', async () => {}),
        stub(displays, 'readDisplayConfig', () => ({ monitor: null, sink: 'tv-sink' })),
        stub(audio, 'applyStartupSink', async () => applied),
        stub(audio, 'waitForStartupSink', () => { calls.wait.push('tv-sink'); return new Promise(() => {}); }),
    ];
    try {
        await startupOutputs.applyStartupOutputs(() => {});
    } finally {
        restore.forEach((r) => r());
    }
    return calls;
}

test('sink missing → the wait starts in the background and does not block', async () => {
    const calls = await run(false); // resolves although the (stub) wait never settles
    assert.deepEqual(calls.wait, ['tv-sink']);
});

test('sink applied → no wait', async () => {
    const calls = await run(true);
    assert.deepEqual(calls.wait, []);
});
