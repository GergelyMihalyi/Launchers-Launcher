// @ts-check
'use strict';

// OFFLINE metadata of the game details view (no network): Heroic/Epic — developer, description, store link from
// `store_cache/legendary_library.json`; Steam — the `appcache/librarycache/<appid>/library_hero.jpg` background (the description/genre
// is in the binary `appinfo.vdf`, which we do not read). The 7 MB legendary file is read asynchronously and cached by mtime;
// error/missing → `null`, never throws. Background: docs/dev/games-panel.md#details-view

const fsp = require('fs/promises');
const path = require('path');

const MAX_DESCRIPTION = 700;

/** @param {unknown} v @param {number} max */
function clip(v, max) {
    const s = typeof v === 'string' ? v.replace(/\r/g, '').trim() : '';
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * `appName → { developer, description, storeUrl }` from the text of `legendary_library.json`. Pure.
 * @param {string} text
 * @returns {Map<string, { developer: string, description: string, storeUrl: string }>}
 */
function parseLegendaryLibrary(text) {
    const map = new Map();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return map;
    }
    const lib = parsed && Array.isArray(parsed.library) ? parsed.library : [];
    for (const g of lib) {
        if (!g || typeof g.app_name !== 'string') continue;
        const about = g.extra && g.extra.about ? g.extra.about : {};
        const description = clip(about.description || about.shortDescription, MAX_DESCRIPTION);
        const developer = clip(g.developer, 120);
        const storeUrl = clip((g.extra && g.extra.storeUrl) || g.store_url, 300);
        // The "description" is often just the title repeated — that is not metadata.
        const useful = description && description.toLowerCase() !== String(g.title || '').toLowerCase() ? description : '';
        if (developer || useful || storeUrl) map.set(g.app_name, { developer, description: useful, storeUrl });
    }
    return map;
}

/**
 * @param {Object} deps
 * @param {() => string} deps.defaultSteamRoot
 * @param {() => string} deps.heroicConfigRoot
 */
function createGameMetadata({ defaultSteamRoot, heroicConfigRoot }) {
    /** @type {{ file: string, mtimeMs: number, map: Map<string, any> } | null} */
    let legendaryCache = null;

    async function legendaryMap() {
        const file = path.join(heroicConfigRoot(), 'store_cache', 'legendary_library.json');
        const st = await fsp.stat(file);
        if (legendaryCache && legendaryCache.file === file && legendaryCache.mtimeMs === st.mtimeMs) return legendaryCache.map;
        const map = parseLegendaryLibrary(await fsp.readFile(file, 'utf8'));
        legendaryCache = { file, mtimeMs: st.mtimeMs, map };
        return map;
    }

    /**
     * @param {string} kind the `kind` of the details view's entry
     * @param {Record<string, any>} params
     * @returns {Promise<{ developer?: string, description?: string, storeUrl?: string, hero?: string } | null>}
     */
    async function get(kind, params) {
        try {
            if (kind === 'steam' && params && /^\d+$/.test(String(params.appid))) {
                const hero = path.join(defaultSteamRoot(), 'appcache', 'librarycache', String(params.appid), 'library_hero.jpg');
                await fsp.access(hero);
                return { hero };
            }
            if (kind === 'heroic' && params && typeof params.appName === 'string') {
                return (await legendaryMap()).get(params.appName) || null;
            }
        } catch {
            /* no file / unreadable → no metadata */
        }
        return null;
    }

    return { get };
}

module.exports = { createGameMetadata, parseLegendaryLibrary };
