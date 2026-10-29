// @ts-check
'use strict';

// Data of the Games panel's game details view (`get-game-details`). From a recent/favorite-shaped entry (`{ key, kind, params }`)
// three independent sources: `launcher` (playtime launched from the launcher: `usage[key]`; RetroArch's shared counter is not
// per ROM → none there), `native` (the emulator's/client's OWN bookkeeping, per kind from the caller — `nativePlay`), `file` + `cover`
// (ROM path + size, path of the manual cover override). Never throws: an error in one source only leaves that field empty.
// Background: docs/dev/games-panel.md#details-view

const fs = require('fs');
const {
    findCoverOverride, coverOverrideSuggestion, overrideTargetForKey,
} = require('../launchers/shared/cover-override.js');

// State of a ROM/disc image (or game FOLDER — that is the path for Cemu/RPCS3). No path → `null`.
function fileInfo(p) {
    if (typeof p !== 'string' || !p) return null;
    try {
        const st = fs.statSync(p);
        return { path: p, exists: true, isDir: st.isDirectory(), sizeBytes: st.isDirectory() ? null : st.size };
    } catch {
        return { path: p, exists: false, isDir: false, sizeBytes: null };
    }
}

// Playtime launched from the launcher, from a `usage` map. No entry → `null`.
function launcherPlay(usageMap, key) {
    if (typeof key !== 'string' || !key || key.startsWith('retroarch:')) return null;
    const u = usageMap && usageMap[key];
    if (!u || typeof u !== 'object') return null;
    return {
        count: Number(u.count) || 0,
        totalMs: Number(u.totalMs) || 0,
        lastLaunchedAt: typeof u.lastLaunchedAt === 'string' ? u.lastLaunchedAt : null,
    };
}

/**
 * @param {Object} deps
 * @param {{ get: (key: string, fallback?: any) => any }} deps.config
 * @param {Record<string, (params: Record<string, any>) => any>} [deps.nativePlay] kind →
 *   `{ playtimeMs: number|null, lastPlayedAt: number|null, label: string } | null` (may be a Promise)
 * @param {(msg: string) => void} [deps.log]
 * @param {(kind: string, params: Record<string, any>) => Promise<any>} [deps.metadata] the offline metadata (`lib/games/game-metadata.js`)
 */
function createGameDetails({ config, nativePlay = {}, log = () => {}, metadata = async () => null }) {
    async function getGameDetails(entry) {
        const e = entry && typeof entry === 'object' ? entry : {};
        const params = e.params && typeof e.params === 'object' ? e.params : {};
        let native = null;
        const fn = Object.prototype.hasOwnProperty.call(nativePlay, e.kind) ? nativePlay[e.kind] : null;
        if (fn) {
            try {
                native = (await fn(params)) || null;
            } catch (err) {
                log(`Game details (${e.kind}) error: ${err.message}`);
            }
        }
        let usageMap = {};
        try {
            usageMap = config.get('usage', {});
        } catch (err) {
            log(`Game details (usage) error: ${err.message}`);
        }
        let meta = null;
        try {
            meta = (await metadata(e.kind, params)) || null;
        } catch (err) {
            log(`Game details (metadata) error: ${err.message}`);
        }
        const target = overrideTargetForKey(e.key);
        return {
            metadata: meta,
            launcher: launcherPlay(usageMap, e.key),
            native,
            file: fileInfo(params.path),
            cover: {
                override: target ? findCoverOverride(target.source, target.id) : null,
                suggestion: target ? coverOverrideSuggestion(target.source, target.id) : null,
            },
        };
    }
    return { getGameDetails };
}

module.exports = { createGameDetails, fileInfo, launcherPlay };
