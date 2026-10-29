#!/usr/bin/env node
'use strict';

// Skeleton generator for a new, FULL (library-module) emulator integration (docs/dev/launchers/README.md).
// Creates the `lib/launchers/<id>-library.js` + `test/launchers/<id>-library.test.js` +
// `docs/dev/launchers/<id>.md` skeleton (ROM directory walk by extension, path-hash id, name from the
// file name — like the custom ROM-folder source), and inserts the rows: `launcher-registry.js` (registry
// row), `lib/launchers/emulator-sources.js` (descriptor, including the `launch` starter),
// `lib/scan/scan-sources.js` (worker scan), `lib/ipc/games-ipc.js` (`GAME_WARMUP_ORDER`), i18n
// (subhead + missing-path error, hu + en). The rest (catalog entry + icon, save locations, the real
// format logic) is printed — those cannot be filled in meaningfully by a machine.
//
//   npm run new-emulator -- <id> --name "<Name>" --flatpak <app.id> --ext .nsp,.xci [--dry-run]
//
// Insertion is bound to anchor texts: if an anchor is not found (the target file's structure changed),
// the generator writes NOTHING and reports which anchor is missing.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ID_RE = /^[a-z][a-z0-9]{1,20}$/;
const FLATPAK_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){2,}$/;
const EXT_RE = /^\.[a-z0-9]{1,10}$/;

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** @param {string[]} argv */
function parseArgs(argv) {
    const out = { id: '', name: '', flatpak: '', exts: /** @type {string[]} */ ([]), dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name') out.name = argv[++i] || '';
        else if (a === '--flatpak') out.flatpak = argv[++i] || '';
        else if (a === '--ext') out.exts = String(argv[++i] || '').split(/[\s,]+/).filter(Boolean).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
        else if (a === '--dry-run') out.dryRun = true;
        else if (!a.startsWith('-') && !out.id) out.id = a;
    }
    return out;
}

/** @param {{ id: string, name: string, flatpak: string, exts: string[] }} o @returns {string[]} errors */
function validateArgs(o) {
    const errs = [];
    if (!ID_RE.test(o.id)) errs.push(`invalid id (lowercase + digits, 2-21 chars): ${o.id || '(empty)'}`);
    if (!o.name) errs.push('missing --name');
    if (!FLATPAK_RE.test(o.flatpak)) errs.push(`invalid --flatpak appid: ${o.flatpak || '(empty)'}`);
    if (!o.exts.length || !o.exts.every((e) => EXT_RE.test(e))) errs.push(`invalid --ext list: ${o.exts.join(',') || '(empty)'}`);
    return errs;
}

/** @param {{ id: string, name: string, flatpak: string, exts: string[] }} o */
function docTemplate(o) {
    return `# ${o.name}

\`lib/launchers/${o.id}-library.js\`; flatpak \`${o.flatpak}\`. TODO: the format gotchas, the verified facts (and what is NOT verified),
the cover source, how "recently played" works, the launch CLI flags.
`;
}

/** @param {{ id: string, name: string, flatpak: string, exts: string[] }} o */
function libraryTemplate(o) {
    const C = o.id.toUpperCase();
    const appName = o.flatpak.split('.').pop();
    return `// @ts-check
'use strict';

// ${o.name} game discovery — GENERATED SKELETON (tools/new-emulator.js).
// TODO for the real integration (see docs/dev/launchers/README.md "Adding an emulator"):
//   - the ROM folders from the emulator's OWN config (now: \`<configRoot>/roms\` + the \`romDirs\` parameter);
//   - a real id (serial / title ID) from the file header → first argument of \`${o.id}GameId\`;
//   - cover (local decoding or network \`ensure${cap(o.id)}Covers\` → registry \`networkCover\`);
//   - "recently played" (the emulator's own bookkeeping → registry \`derivedRecent\`, or launch-time
//     bookkeeping — a registry row that is NOT \`derivedRecent\` → launch-ipc records it automatically);
//   - the launch CLI flags (\`${o.id}GameArgs\`: fullscreen, batch mode) — verify live!
//   - the native root, if it differs from the XDG equivalent (the \`native\` option of \`appConfigRoot\`).

const path = require('path');
const { appConfigRoot } = require('../xdg.js');
const { filterExistingDirs, walkFilesByExtension } = require('../dir-browse.js');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');

const ${C}_FLATPAK_ID = '${o.flatpak}';
const ${C}_APP_NAME = '${appName}';
const ROM_EXTENSIONS = new Set(${JSON.stringify(o.exts)});

function ${o.id}ConfigRoot() {
    return appConfigRoot(${C}_FLATPAK_ID, ${C}_APP_NAME);
}

// TODO: read the game folders from the emulator's own config.
/** @param {string} configRoot */
function readRomDirs(configRoot) {
    return [path.join(configRoot, 'roms')];
}

// Stable id: the real one (serial / title ID), otherwise a path-hash substitute.
/** @param {string|null} realId @param {string} romPath */
function ${o.id}GameId(realId, romPath) {
    return realId || pathHashId(romPath);
}

// The launch argument list (flatpak form: \`run <appid> …\` — for the native variant
// \`variantExecSpec\` in lib/ipc/launch-ipc.js strips the prefix). Called by the descriptor's
// \`launch.args\` (lib/launchers/emulator-sources.js).
/** @param {string} romPath */
function ${o.id}GameArgs(romPath) {
    return ['run', ${C}_FLATPAK_ID, romPath];
}

/** @param {string} configRoot @param {string[]} [romDirs] */
function findInstalledGames(configRoot, romDirs = readRomDirs(configRoot)) {
    const games = [];
    const seen = new Set();
    for (const dir of filterExistingDirs(romDirs)) {
        for (const file of walkFilesByExtension(dir, ROM_EXTENSIONS)) {
            const id = ${o.id}GameId(null, file);
            if (seen.has(id)) continue;
            seen.add(id);
            games.push({ id, name: cleanFilenameLabel(path.basename(file)), path: file, cover: null });
        }
    }
    games.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true, sensitivity: 'base' }));
    return games;
}


module.exports = {
    ${C}_FLATPAK_ID, ${o.id}ConfigRoot, readRomDirs, ${o.id}GameId, ${o.id}GameArgs, findInstalledGames,
};
`;
}

/** @param {{ id: string, name: string, flatpak: string, exts: string[] }} o */
function testTemplate(o) {
    const ext = o.exts[0];
    return `'use strict';

// lib/launchers/${o.id}-library.js — GENERATED SKELETON test (tools/new-emulator.js); extend it
// together with the real format logic (for fixtures: test/helpers/fixtures.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, writeFile } = require('../helpers/fs.js');
const lib = require('../../lib/launchers/${o.id}-library.js');

test('findInstalledGames — the ${o.exts.join('/')} files of the ROM folder, the name from the file name, a path-hash id', () => {
    const root = tmpDir();
    writeFile(root, 'roms/Some_Game${ext}', 'x');
    writeFile(root, 'roms/readme.txt', 'x');
    const games = lib.findInstalledGames(root);
    assert.deepEqual(games.map((g) => g.name), ['Some Game']);
    assert.equal(games[0].path, path.join(root, 'roms', 'Some_Game${ext}'));
    assert.equal(games[0].id, lib.${o.id}GameId(null, games[0].path));
    assert.deepEqual(lib.findInstalledGames(path.join(root, 'missing')), []);
});
`;
}

// The insertions: { file, anchor, text, where: 'before'|'after' } — the anchor is exact text.
/** @param {{ id: string, name: string, flatpak: string, exts: string[] }} o */
function plannedEdits(o) {
    const chip = o.name.toUpperCase().replace(/[^A-Z0-9 ]/g, '');
    return [
        {
            file: 'launcher-registry.js',
            anchor: "    ];\n\n    // The non-emulator (\"store\") sources",
            where: 'before',
            text: `        {
            id: '${o.id}', name: '${o.name}', chip: '${chip}', idField: 'id', subheadKey: 'games.${o.id}Subhead',
            launchParams: ['path'],
        },
`,
        },
        {
            file: 'lib/launchers/emulator-sources.js',
            anchor: '};\n\nconst RECENT_MAX',
            where: 'before',
            text: `    ${o.id}: () => require('./${o.id}-library.js'),\n`,
        },
        {
            file: 'lib/launchers/emulator-sources.js',
            anchor: '    };\n    for (const [id, s] of Object.entries(SOURCES)) {',
            where: 'before',
            text: `        ${o.id}: {
            // GENERATED (tools/new-emulator.js) — cover / native playtime / derived recent: see the library TODOs
            // worker scan (the ROM folder may be on NFS — it would freeze the main process)
            loader: workerLoader('${o.id}', libs.${o.id}.${o.id}ConfigRoot),
            launch: {
                gameId: (p) => libs.${o.id}.${o.id}GameId(null, p.path),
                args: (p) => libs.${o.id}.${o.id}GameArgs(p.path),
                missingReason: 'Missing ${o.name} ROM path',
            },
        },
`,
        },
        {
            file: 'lib/scan/scan-sources.js',
            anchor: '    retroAll: (retroarchRoot) =>',
            where: 'before',
            text: `    ${o.id}: (configRoot) => require('../launchers/${o.id}-library.js').findInstalledGames(configRoot),\n`,
        },
        {
            file: 'lib/ipc/games-ipc.js',
            anchor: "'custom', 'melonds',\n    ];",
            where: 'before',
            text: `'${o.id}', `,
        },
        {
            file: 'renderer/i18n/i18n-hu.js',
            anchor: "    'games.customSubhead':",
            where: 'before',
            text: `    'games.${o.id}Subhead': '${o.name}',\n`,
        },
        {
            file: 'renderer/i18n/i18n-en.js',
            anchor: "    'games.customSubhead':",
            where: 'before',
            text: `    'games.${o.id}Subhead': '${o.name}',\n`,
        },
        {
            file: 'renderer/i18n/i18n-hu.js',
            anchor: "    'err.customNoSource':",
            where: 'before',
            text: `    'err.${o.id}MissingPath': 'Hiányzó ${o.name} ROM-útvonal',\n`,
        },
        {
            file: 'renderer/i18n/i18n-en.js',
            anchor: "    'err.customNoSource':",
            where: 'before',
            text: `    'err.${o.id}MissingPath': 'Missing ${o.name} ROM path',\n`,
        },
    ];
}

// The full plan (new files + insertions) for a repo root — pure apart from reading files; on error
// `{ ok: false, errors }`, and nothing is written.
/** @param {{ id: string, name: string, flatpak: string, exts: string[] }} o @param {string} [root] */
function planNewEmulator(o, root = ROOT) {
    const errors = validateArgs(o);
    if (errors.length) return { ok: false, errors };
    const registry = fs.readFileSync(path.join(root, 'launcher-registry.js'), 'utf8');
    if (registry.includes(`id: '${o.id}'`)) return { ok: false, errors: [`such an id already exists in the registry: ${o.id}`] };
    const creates = [
        { file: `lib/launchers/${o.id}-library.js`, content: libraryTemplate(o) },
        { file: `test/launchers/${o.id}-library.test.js`, content: testTemplate(o) },
        { file: `docs/dev/launchers/${o.id}.md`, content: docTemplate(o) },
    ];
    for (const c of creates) {
        if (fs.existsSync(path.join(root, c.file))) errors.push(`already exists: ${c.file}`);
    }
    /** @type {Map<string, string>} */
    const contents = new Map();
    for (const e of plannedEdits(o)) {
        const cur = contents.has(e.file) ? contents.get(e.file) : fs.readFileSync(path.join(root, e.file), 'utf8');
        const idx = cur.indexOf(e.anchor);
        if (idx < 0) {
            errors.push(`anchor not found (${e.file}): ${JSON.stringify(e.anchor.slice(0, 60))}`);
            continue;
        }
        const at = e.where === 'before' ? idx : idx + e.anchor.length;
        contents.set(e.file, cur.slice(0, at) + e.text + cur.slice(at));
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, creates, edits: [...contents.entries()].map(([file, content]) => ({ file, content })) };
}

/** @param {{ creates: Array<{file: string, content: string}>, edits: Array<{file: string, content: string}> }} plan @param {string} [root] */
function applyPlan(plan, root = ROOT) {
    for (const f of [...plan.creates, ...plan.edits]) fs.writeFileSync(path.join(root, f.file), f.content);
}

/** @param {{ id: string, name: string }} o */
function manualSteps(o) {
    return [
        `data/launcher-catalog.json — the catalog entry (\`${o.id}\`, flatpak + \`nativeCmd\` OR \`flatpakOnly\`) + assets/icons/${o.id}.png`,
        `lib/launchers/${o.id}-library.js — the TODOs (ROM folders from the config, real id, cover, recent)`,
        `lib/saves/save-sources.js — SAVE_SOURCE_DEFS: the save locations of ${o.name} (verified on a machine)`,
        `lib/launchers/${o.id}-library.js — ${o.id}GameArgs: the launch CLI flags, verified live (the generated one is only \`flatpak run <id> <rom>\`)`,
        'test/ipc/launch-ipc.test.js — EMULATOR_CASES: one row for the new emulator',
        `docs/dev/launchers/${o.id}.md — the format gotchas (the skeleton is generated) + a row in the page list of docs/dev/README.md`,
        'npm test (test/contracts/launcher-tables.test.js tells you if a table was left out)',
    ];
}

function main() {
    const o = parseArgs(process.argv.slice(2));
    const plan = planNewEmulator(o);
    if (!plan.ok) {
        process.stderr.write(`new-emulator: ${plan.errors.join('\n  ')}\n\nUsage: npm run new-emulator -- <id> --name "<Name>" --flatpak <app.id> --ext .a,.b [--dry-run]\n`);
        process.exit(1);
    }
    const files = [...plan.creates.map((c) => `+ ${c.file}`), ...plan.edits.map((e) => `~ ${e.file}`)];
    if (o.dryRun) {
        process.stdout.write(`(dry-run) would write:\n  ${files.join('\n  ')}\n`);
        return;
    }
    applyPlan(plan);
    process.stdout.write(`Done:\n  ${files.join('\n  ')}\n\nStill to do by hand:\n  - ${manualSteps(o).join('\n  - ')}\n`);
}

if (require.main === module) main();

module.exports = { parseArgs, validateArgs, planNewEmulator, applyPlan, manualSteps, libraryTemplate, testTemplate };
