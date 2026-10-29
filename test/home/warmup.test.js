'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// `renderer/home/warmup.js` uses `$()` (renderer/util.js) at call time — stubbed here.
const spinner = { hidden: true };
global.$ = (id) => (id === 'warmupSpinner' ? spinner : null);

const fs = require('node:fs');
const vm = require('node:vm');
const { warmupAction, WARMUP_SHOW_DELAY_MS } = require('../../renderer/home/warmup.js');

// `applyWarmupState` uses the module's own (unexported) `warmupTimer`/`warmupVisible` state —
// every test gets a FRESH `vm` instance, with the (mocked) timers and the `$` stub.
function freshModule() {
    const src = fs.readFileSync(require.resolve('../../renderer/home/warmup.js'), 'utf8');
    spinner.hidden = true;
    return new vm.Script(`${src}\n;({ applyWarmupState })`)
        .runInNewContext({ $: global.$, setTimeout, clearTimeout, module: undefined });
}

test('warmupAction — the decision table', () => {
    assert.equal(warmupAction(true, false, false), 'schedule', 'a starting run → scheduled display');
    assert.equal(warmupAction(true, true, false), 'none', 'already scheduled');
    assert.equal(warmupAction(true, false, true), 'none', 'already visible');
    assert.equal(warmupAction(false, true, false), 'cancel', 'ended during the delay → never flashes up');
    assert.equal(warmupAction(false, false, true), 'hide');
    assert.equal(warmupAction(false, false, false), 'none');
});

test('applyWarmupState — the indicator appears only after the delay, disappears at the end', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = freshModule();

    ctx.applyWarmupState({ running: true, done: 0, total: 5 });
    assert.equal(spinner.hidden, true, 'still hidden before the delay');
    t.mock.timers.tick(WARMUP_SHOW_DELAY_MS - 1);
    assert.equal(spinner.hidden, true);
    t.mock.timers.tick(1);
    assert.equal(spinner.hidden, false, 'visible after the delay');
    ctx.applyWarmupState({ running: true, done: 3, total: 5 });
    assert.equal(spinner.hidden, false, 'the intermediate state does not hide it');
    ctx.applyWarmupState({ running: false, done: 5, total: 5 });
    assert.equal(spinner.hidden, true, 'hidden at the end');
});

test('applyWarmupState — a run shorter than the delay never flashes up', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ctx = freshModule();

    ctx.applyWarmupState({ running: true, done: 0, total: 5 });
    t.mock.timers.tick(100);
    ctx.applyWarmupState({ running: false, done: 5, total: 5 });
    t.mock.timers.tick(WARMUP_SHOW_DELAY_MS * 2);
    assert.equal(spinner.hidden, true);
});

test('applyWarmupState — a missing/empty state does not throw', () => {
    const ctx = freshModule();
    assert.doesNotThrow(() => ctx.applyWarmupState(undefined));
    assert.doesNotThrow(() => ctx.applyWarmupState(null));
});
