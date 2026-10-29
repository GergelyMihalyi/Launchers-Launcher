'use strict';

// renderer/controller/controller-labels.js — button labels matching the active controller type.
// A classic <script> in the browser (`controllerSymbols` is a global of controller-id.js);
// here we require controller-id.js first (it sets globalThis.controllerSymbols),
// then the module. module.exports guard at the bottom of the file.

const test = require('node:test');
const assert = require('node:assert/strict');

require('../../controller-id.js'); // globalThis.controllerSymbols
const labels = require('../../renderer/controller/controller-labels.js');
const {
    activeControllerType, btnIcon, btnGlyph, setMainControllerType, noteActivePadType, setControllerTypeChangeHandler,
} = labels;

test('default: no main controller and no active pad -> playstation', () => {
    setMainControllerType(null);
    assert.equal(activeControllerType(), 'playstation');
    assert.equal(btnGlyph('confirm'), '✕');
    assert.equal(btnGlyph('back'), '○');
});

test('the type of the last active pad wins over the default', () => {
    setMainControllerType(null);
    noteActivePadType('xbox');
    assert.equal(activeControllerType(), 'xbox');
    assert.equal(btnGlyph('confirm'), 'A');
});

test('the type of the configured main controller wins over the active pad', () => {
    noteActivePadType('xbox');
    setMainControllerType('dualsense');
    assert.equal(activeControllerType(), 'dualsense');
    assert.equal(btnGlyph('confirm'), '✕');
    setMainControllerType(null); // back to the active pad (xbox)
    assert.equal(activeControllerType(), 'xbox');
});

test('btnIcon — the .btn-icon CSS class stays STABLE, only the glyph depends on the type', () => {
    setMainControllerType(null);
    noteActivePadType('dualsense');
    assert.equal(btnIcon('confirm'), '<span class="btn-icon btn-x">✕</span>');
    assert.equal(btnIcon('back'), '<span class="btn-icon btn-ps">○</span>');
    assert.equal(btnIcon('menu'), '<span class="btn-icon btn-triangle">△</span>');
    assert.equal(btnIcon('alt'), '<span class="btn-icon btn-square">□</span>');
    assert.equal(btnIcon('view'), '<span class="btn-icon btn-view">⧉</span>');
    assert.equal(btnIcon('start'), '<span class="btn-icon btn-start">☰</span>');
    noteActivePadType('xbox');
    assert.equal(btnIcon('confirm'), '<span class="btn-icon btn-x">A</span>');
    assert.equal(btnIcon('alt'), '<span class="btn-icon btn-square">X</span>');
});

test('onControllerTypeChange — fires only when the ACTUAL active type changes', () => {
    setMainControllerType(null);
    noteActivePadType('dualsense');
    let calls = 0;
    setControllerTypeChangeHandler(() => { calls += 1; });
    noteActivePadType('dualsense'); // no change
    assert.equal(calls, 0);
    noteActivePadType('xbox');      // dualsense -> xbox
    assert.equal(calls, 1);
    setMainControllerType('xbox');  // the result stays 'xbox'
    assert.equal(calls, 1);
    setMainControllerType('generic'); // xbox -> generic
    assert.equal(calls, 2);
    setControllerTypeChangeHandler(null);
});
