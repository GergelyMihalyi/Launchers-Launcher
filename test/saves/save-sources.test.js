'use strict';

// lib/saves/save-sources.js — discovery of the save folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withTempHome, writeFile } = require('../helpers/fs.js');
const { detectSaveSources, iniValue, expandHome, SAVE_SOURCE_DEFS } = require('../../lib/saves/save-sources.js');

test('iniValue — section filtering, quotes, a similarly named key does not match', () => {
    const ini = '[BIOS]\nSearchDirectory = bios\n[MemoryCards]\nDirectory = memcards\n[Folders]\nSaveStates = "states dir"\n';
    assert.equal(iniValue(ini, 'Directory', 'MemoryCards'), 'memcards');
    assert.equal(iniValue(ini, 'Directory', 'BIOS'), null);
    assert.equal(iniValue(ini, 'SaveStates', 'Folders'), 'states dir');
    assert.equal(iniValue('savefile_directory = "~/x"', 'savefile_directory'), '~/x');
    assert.equal(iniValue(null, 'x'), null);
});

test('expandHome — ~ and ~/… to the home folder', () => {
    assert.equal(expandHome('~', '/h'), '/h');
    assert.equal(expandHome('~/a/b', '/h'), '/h/a/b');
    assert.equal(expandHome('/abs', '/h'), '/abs');
});

test('SAVE_SOURCE_DEFS — unique ids, every source has a name', () => {
    const ids = SAVE_SOURCE_DEFS.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const d of SAVE_SOURCE_DEFS) assert.equal(typeof d.name, 'string');
});

test('detectSaveSources — following the config overrides, only the existing paths, with sizes', async () => {
    await withTempHome(async (home) => {
        const app = (id, ...rest) => path.join('.var/app', id, ...rest);
        // RetroArch: a custom saves folder with `~` in the cfg; states is the default, does NOT exist.
        writeFile(home, app('org.libretro.RetroArch', 'config/retroarch/retroarch.cfg'),
            'savefile_directory = "~/rasaves"\nsavestate_directory = "default"\n');
        writeFile(home, 'rasaves/Tekken 3.srm', 'abcd');
        // PCSX2: `[Folders] MemoryCards` is relative to the config root.
        writeFile(home, app('net.pcsx2.PCSX2', 'config/PCSX2/inis/PCSX2.ini'), '[Folders]\nMemoryCards = mc\n');
        writeFile(home, app('net.pcsx2.PCSX2', 'config/PCSX2/mc/Mcd001.ps2'), Buffer.alloc(8));
        // DuckStation: `[MemoryCards] Directory` ([BIOS] SearchDirectory does not interfere).
        writeFile(home, app('org.duckstation.DuckStation', 'config/duckstation/settings.ini'),
            '[BIOS]\nSearchDirectory = bios\n[MemoryCards]\nDirectory = cards\n');
        writeFile(home, app('org.duckstation.DuckStation', 'config/duckstation/cards/shared.mcd'), Buffer.alloc(16));
        // Cemu: mlc01/usr/save (NOT the whole mlc01).
        writeFile(home, app('info.cemu.Cemu', 'data/Cemu/mlc01/usr/save/00050000/x/user/save.dat'), 'xx');
        writeFile(home, app('info.cemu.Cemu', 'data/Cemu/mlc01/usr/title/00050000/big.rpx'), Buffer.alloc(64));
        // Ryujinx: a file path (Profiles.json) can be a source too; the keys cannot.
        writeFile(home, app('io.github.ryubing.Ryujinx', 'config/Ryujinx/system/Profiles.json'), '{}');
        writeFile(home, app('io.github.ryubing.Ryujinx', 'config/Ryujinx/system/prod.keys'), 'secret');
        // melonDS: no SaveFilePath → the `.sav` is in the (manual) ROM folder.
        writeFile(home, app('net.kuribo64.melonDS', 'config/melonDS/melonDS.toml'), 'SaveFilePath = ""\n');
        writeFile(home, 'nds/Mario.nds', Buffer.alloc(4));
        writeFile(home, 'nds/sub/Mario.sav', Buffer.alloc(3));

        const found = await detectSaveSources({ melondsRomDirs: [path.join(home, 'nds')] });
        const byId = Object.fromEntries(found.map((s) => [s.id, s]));
        assert.deepEqual(Object.keys(byId).sort(), ['cemu', 'duckstation', 'melonds', 'pcsx2', 'retroarch', 'ryujinx']);
        assert.deepEqual(byId.retroarch.paths, [{ path: path.join(home, 'rasaves'), bytes: 4 }]);
        assert.equal(byId.pcsx2.bytes, 8);
        assert.equal(byId.duckstation.paths[0].path, path.join(home, app('org.duckstation.DuckStation', 'config/duckstation/cards')));
        assert.equal(byId.cemu.bytes, 2, 'only usr/save, not the game content');
        assert.deepEqual(byId.ryujinx.paths.map((p) => path.basename(p.path)), ['Profiles.json']);
        assert.deepEqual(byId.melonds.paths, [{ path: path.join(home, 'nds/sub/Mario.sav'), bytes: 3 }]);
    });
});

test('detectSaveSources — empty HOME: no source, does not throw', async () => {
    await withTempHome(async () => {
        assert.deepEqual(await detectSaveSources(), []);
    });
});

// Native ↔ flatpak: the saves of the native (`~/.config/<app>`) root are included too,
// if they exist — no save is missed after a variant switch.
test('detectSaveSources — the saves of the native root too (PPSSPP ~/.config/ppsspp, DuckStation ~/.local/share/duckstation)', async () => {
    await withTempHome(async (home) => {
        writeFile(home, '.config/ppsspp/PSP/SAVEDATA/ULUS10000/DATA.BIN', 'x');
        writeFile(home, '.var/app/org.ppsspp.PPSSPP/config/ppsspp/PSP/SAVEDATA/ULUS20000/DATA.BIN', 'yy');
        writeFile(home, '.local/share/duckstation/memcards/shared_card_1.mcd', 'zzz');
        const res = await detectSaveSources({ homeDir: home });
        const ppsspp = res.find((r) => r.id === 'ppsspp');
        assert.deepEqual(ppsspp.paths.map((p) => p.path).sort(), [
            path.join(home, '.config/ppsspp/PSP/SAVEDATA'),
            path.join(home, '.var/app/org.ppsspp.PPSSPP/config/ppsspp/PSP/SAVEDATA'),
        ].sort());
        const duck = res.find((r) => r.id === 'duckstation');
        assert.deepEqual(duck.paths.map((p) => p.path), [path.join(home, '.local/share/duckstation/memcards')]);
    });
});
