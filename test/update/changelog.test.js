'use strict';

// lib/update/changelog.js — extracting the latest section of CHANGELOG.md for the "What's new"
// panel. Pure parser, no temp file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLatestSection } = require('../../lib/update/changelog.js');

const SAMPLE = [
    '# Changelog',
    '',
    'Intro paragraph, this is NOT the section.',
    '',
    '## [Unreleased]',
    '',
    '### Changed',
    '',
    '- A change.',
    '',
    '### Added',
    '- A new thing.',
    '- Another one.',
    '',
    '## [1.0.0] - 2026-09-08',
    '',
    '- First release.',
].join('\n');

test('parseLatestSection — returns the first ## section, stops before the next ##', () => {
    const { heading, lines } = parseLatestSection(SAMPLE);
    assert.equal(heading, '[Unreleased]');
    assert.deepEqual(lines, [
        '### Changed', '', '- A change.', '', '### Added', '- A new thing.', '- Another one.',
    ]);
});

test('parseLatestSection — trims the leading/trailing empty lines', () => {
    const { lines } = parseLatestSection('## X\n\n\n- a\n\n\n## Y\n- b');
    assert.deepEqual(lines, ['- a']);
});

test('parseLatestSection — no ## header -> empty', () => {
    assert.deepEqual(parseLatestSection('# title only\n\ntext'), { heading: '', lines: [] });
    assert.deepEqual(parseLatestSection(''), { heading: '', lines: [] });
    assert.deepEqual(parseLatestSection(null), { heading: '', lines: [] });
});

test('parseLatestSection — on the real CHANGELOG.md of the repo: a non-empty [Unreleased] section', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
    const { heading, lines } = parseLatestSection(md);
    assert.match(heading, /Unreleased|\d+\.\d+\.\d+/);
    assert.ok(lines.length > 0);
});
