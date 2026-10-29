'use strict';

// lib/launchers/shared/ps-game-db.js — the BYTE-IDENTICAL formats of PCSX2 and DuckStation:
// GameIndex.yaml/gamedb.yaml title lookup, the `[GameList]` INI section, `playtime.dat`. The sample
// texts come from both emulators' files seen on the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupGameName, parseGameListDirs, parsePlaytime } = require('../../../lib/launchers/shared/ps-game-db.js');

test('parseGameListDirs — the RecursivePaths/Paths lines of [GameList] (PCSX2.ini AND DuckStation settings.ini)', () => {
    const pcsx2Ini = [
        '[Folders]', 'Bios = bios', '',
        '[GameList]',
        'RecursivePaths = /run/user/1000/doc/xyz/Ps2',
        'RecursivePaths = /home/user/PS2-ROMs',
        '', '',
        '[GameListTableView]', 'HeaderState = AAAA',
    ].join('\n');
    assert.deepEqual(parseGameListDirs(pcsx2Ini), ['/run/user/1000/doc/xyz/Ps2', '/home/user/PS2-ROMs']);

    const duckIni = [
        '[Main]', 'SettingsVersion = 3', '',
        '[GameList]',
        'RecursivePaths = /run/user/1000/doc/xyz/Sony - Playstation',
        'Paths = /home/user/PS1-ROMs',
        '',
        '[AutoUpdater]', 'LastVersion = abc',
    ].join('\n');
    assert.deepEqual(parseGameListDirs(duckIni), ['/run/user/1000/doc/xyz/Sony - Playstation', '/home/user/PS1-ROMs']);
});

test('parseGameListDirs — no [GameList] section -> empty list', () => {
    assert.deepEqual(parseGameListDirs('[Folders]\nBios = bios\n'), []);
    assert.deepEqual(parseGameListDirs(''), []);
});

test('lookupGameName — with the YAML schema regex (not a YAML parser), with nested keys too', () => {
    const yaml = [
        'SCUS-97472:',
        '  name: "Shadow of the Colossus"',
        '  region: "NTSC-U"',
        'SCES-01420:',
        '  name: "Crash Bandicoot 3 - Warped (Europe) (En,Fr,De,Es,It)"',
        '  compatibility:',
        '    rating: NoIssues',
        'SCUS-97473:',
        '  name: "World Tour Soccer 2006 [Demo]"',
    ].join('\n');
    assert.equal(lookupGameName(yaml, 'SCUS-97472'), 'Shadow of the Colossus');
    assert.equal(lookupGameName(yaml, 'SCES-01420'), 'Crash Bandicoot 3 - Warped (Europe) (En,Fr,De,Es,It)');
    assert.equal(lookupGameName(yaml, 'SCUS-97473'), 'World Tour Soccer 2006 [Demo]');
    assert.equal(lookupGameName(yaml, 'UNKNOWN-00000'), null);
    assert.equal(lookupGameName(yaml, null), null);
    assert.equal(lookupGameName('', 'SCUS-97472'), null);
});

test('parsePlaytime — the space-padded line format seen on the machine (serial / s / unix s)', () => {
    const map = parsePlaytime('SCUS-97472                       263                  1789323676          ');
    assert.deepEqual(map.get('SCUS-97472'), { seconds: 263, lastPlayedAt: 1789323676000 });
    assert.equal(map.size, 1);
});

test('parsePlaytime — several lines, bad/incomplete lines skipped, does not throw', () => {
    const map = parsePlaytime(['SLUS-20409  120  1700000000', 'meaningless-line', 'SCES-99999  60', ''].join('\n'));
    assert.deepEqual(map.get('SLUS-20409'), { seconds: 120, lastPlayedAt: 1700000000000 });
    assert.equal(map.has('SCES-99999'), false);
    assert.equal(map.size, 1);
});

test('the launcher modules re-export the same functions', () => {
    for (const mod of ['pcsx2-library.js', 'duckstation-library.js']) {
        const lib = require(`../../../lib/launchers/${mod}`);
        assert.equal(lib.lookupGameName, lookupGameName, mod);
        assert.equal(lib.parseGameListDirs, parseGameListDirs, mod);
        assert.equal(lib.parsePlaytime, parsePlaytime, mod);
    }
});
