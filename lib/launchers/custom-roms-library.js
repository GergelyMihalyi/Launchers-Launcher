// @ts-check
'use strict';

// Generic, data-driven "ROM folder" game source for an ADDED launcher, WITHOUT a library module: in the launcher's □ menu the user sets
// folders, extensions and an argument template (`{rom}` = the ROM's absolute path). The Games panel's `custom` source (chip: OTHER),
// the name comes from the file name; launch with the launcher's own `cmd`/`args` + the arguments built from the template. No cover (the
// manual override works). Config: `customGameSources: [{ launcherId, dirs, exts, argsTemplate }]`. The walk is ASYNC (may be NFS), with a
// depth and count limit. Background: docs/dev/launchers/README.md#custom-rom-folders

const fs = require('fs');
const path = require('path');
const { pathHashId, cleanFilenameLabel } = require('./shared/game-id.js');
const { isInsideDir, isJunkEntry, entryKindAsync, firstVisitAsync } = require('../dir-browse.js');

const LAUNCHER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const EXT_RE = /^\.[a-z0-9]{1,10}$/;
const MAX_DIRS = 10;
const MAX_EXTS = 30;
const MAX_TEMPLATE_LEN = 300;
const DEFAULT_TEMPLATE = '{rom}';
const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_FILES = 20000;

// Normalizes a config entry → the storable shape, or `null` if unusable. A template without `{rom}` is meaningless (the ROM would
// never reach the program) → the default. Pure.
/** @param {any} raw */
function normalizeCustomGameSource(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const launcherId = raw.launcherId;
    if (typeof launcherId !== 'string' || !LAUNCHER_ID_RE.test(launcherId)) return null;
    const dirs = [...new Set((Array.isArray(raw.dirs) ? raw.dirs : [])
        .filter((d) => typeof d === 'string' && path.isAbsolute(d))
        .map((d) => path.resolve(d)))].slice(0, MAX_DIRS);
    const exts = [...new Set((Array.isArray(raw.exts) ? raw.exts : [])
        .filter((e) => typeof e === 'string')
        .map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())
        .filter((e) => EXT_RE.test(e)))].slice(0, MAX_EXTS);
    if (!dirs.length || !exts.length) return null;
    let argsTemplate = typeof raw.argsTemplate === 'string' ? raw.argsTemplate.trim().slice(0, MAX_TEMPLATE_LEN) : '';
    if (!argsTemplate.includes('{rom}')) argsTemplate = DEFAULT_TEMPLATE;
    return { launcherId, dirs, exts, argsTemplate };
}

// The whole config list normalized, at most one per launcher (the last wins). Pure.
/** @param {any} list */
function normalizeCustomGameSources(list) {
    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const raw of Array.isArray(list) ? list : []) {
        const s = normalizeCustomGameSource(raw);
        if (s) byId.set(s.launcherId, s);
    }
    return [...byId.values()];
}

/** @param {{ get: (key: string, fallback: any) => any }} config */
function readCustomGameSources(config) {
    return normalizeCustomGameSources(config.get('customGameSources', []));
}

// Template → argv items: split on spaces, every `{rom}` occurrence replaced with the ROM path (one `{rom}` token = ONE argv item, a path
// with spaces does not fall apart; `--rom={rom}` works too). No shell — `spawn` gets it directly. Pure.
/** @param {string} template @param {string} romPath */
function buildCustomGameArgs(template, romPath) {
    const tpl = typeof template === 'string' && template.includes('{rom}') ? template : DEFAULT_TEMPLATE;
    return tpl.split(/\s+/).filter(Boolean).map((tok) => tok.split('{rom}').join(romPath));
}

// Does a file to launch belong to the source: it is UNDER one of the source's folders, its extension is on the list, and it exists
// (the renderer must not launch an arbitrary file with the launcher).
/** @param {any} source @param {any} romPath */
function isRomInSource(source, romPath) {
    if (!source || typeof romPath !== 'string' || !path.isAbsolute(romPath)) return false;
    if (!source.exts.includes(path.extname(romPath).toLowerCase())) return false;
    if (!source.dirs.some((d) => isInsideDir(romPath, d))) return false;
    try {
        return fs.statSync(romPath).isFile();
    } catch (err) {
        return false;
    }
}

// The stable game id (favorite/recent key): a path hash salted with the launcher id (two launchers on the same folder do not collide).
/** @param {string} launcherId @param {string} romPath */
function customGameId(launcherId, romPath) {
    return pathHashId(romPath, launcherId);
}

// Games of one source, sorted by name. Never throws (an unreadable folder is skipped).
/** @param {any} source @param {{ maxDepth?: number, maxFiles?: number }} [o] */
async function scanCustomSource(source, { maxDepth = SCAN_MAX_DEPTH, maxFiles = SCAN_MAX_FILES } = {}) {
    const exts = new Set(source.exts);
    /** @type {string[]} */
    const files = [];
    /** @type {Set<string>} */
    const seen = new Set();
    const visit = async (dir, depth) => {
        if (depth > maxDepth || files.length >= maxFiles || !(await firstVisitAsync(seen, dir))) return;
        let ents = [];
        try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (err) { return; }
        for (const e of ents) {
            if (files.length >= maxFiles) return;
            if (e.name.startsWith('.') || isJunkEntry(e.name)) continue;
            const full = path.join(dir, e.name);
            const kind = await entryKindAsync(dir, e); // symlink resolved
            if (kind === 'dir') await visit(full, depth + 1);
            else if (kind === 'file' && exts.has(path.extname(e.name).toLowerCase())) files.push(full);
        }
    };
    for (const d of source.dirs) await visit(d, 0);
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    return [...new Set(files)]
        .map((p) => ({
            id: customGameId(source.launcherId, p), launcherId: source.launcherId,
            name: cleanFilenameLabel(path.basename(p)) || path.basename(p), path: p, cover: null,
        }))
        .sort((a, b) => collator.compare(a.name, b.name));
}

// Games of all sources in one flat list (the Games panel's `custom-game` rows).
/** @param {any[]} sources */
async function findAllCustomGames(sources) {
    const out = [];
    for (const s of Array.isArray(sources) ? sources : []) out.push(...await scanCustomSource(s));
    return out;
}

// "Recently played" booked at launch time (into the bar under the launcher's own card).
/** @param {string} launcherId @param {string} id @param {string} name @param {string} romPath */
function customGameMeta(launcherId, id, name, romPath) {
    return {
        launcherId, key: `custom-game-${id}`, name: name || cleanFilenameLabel(path.basename(romPath)), cover: null,
        kind: 'custom', params: { launcherId, path: romPath },
    };
}

module.exports = {
    normalizeCustomGameSource, normalizeCustomGameSources, readCustomGameSources, buildCustomGameArgs,
    isRomInSource, customGameId, scanCustomSource, findAllCustomGames, customGameMeta, DEFAULT_TEMPLATE,
};
