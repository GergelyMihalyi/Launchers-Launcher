'use strict';

// renderer/a11y.js — the pure parts of announcing the focused element.

const test = require('node:test');
const assert = require('node:assert/strict');
const { a11yLabelOf, focusedFromMutations } = require('../renderer/a11y.js');

function el({ aria = null, text = '', classes = [], child = null } = {}) {
    return {
        nodeType: 1,
        textContent: text,
        getAttribute: (n) => (n === 'aria-label' ? aria : null),
        classList: { contains: (c) => classes.includes(c) },
        querySelector: (sel) => (sel === '.focused' ? child : null),
    };
}

test('a11yLabelOf — aria-label takes precedence, otherwise the text (whitespace collapsed)', () => {
    assert.equal(a11yLabelOf(el({ aria: 'Steam, Big Picture', text: 'x' })), 'Steam, Big Picture');
    assert.equal(a11yLabelOf(el({ text: '  Audio output \n  (CURRENT) ' })), 'Audio output (CURRENT)');
    assert.equal(a11yLabelOf(null), '');
    assert.equal(a11yLabelOf(el({ text: 'a'.repeat(300) })).length, 200);
});

test('focusedFromMutations — the element that most recently received focus (class change or new content)', () => {
    const card = el({ classes: ['card', 'focused'] });
    const inner = el({ classes: ['settings-item', 'focused'] });
    const list = el({ classes: ['settings-list'], child: inner });
    assert.equal(focusedFromMutations([{ type: 'attributes', target: card }]), card);
    assert.equal(focusedFromMutations([
        { type: 'attributes', target: card },
        { type: 'childList', addedNodes: [{ nodeType: 3 }, list] },
    ]), inner);
    assert.equal(focusedFromMutations([{ type: 'attributes', target: el({ classes: ['card'] }) }]), null);
    assert.equal(focusedFromMutations([{ type: 'childList', addedNodes: [el({ classes: ['x'] })] }]), null);
});
