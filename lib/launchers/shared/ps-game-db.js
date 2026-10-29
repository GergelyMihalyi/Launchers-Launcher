// @ts-check
'use strict';

// Shared PCSX2/DuckStation "PS disc-image database" logic. There is NO real format difference between the two emulators here (which
// justifies a shared module, unlike the independent launcher parsers): the `GameIndex.yaml`/`gamedb.yaml` schema, the `playtime.dat`
// format (`<serial>  <seconds>  <unix s>`) and the `.ini` `[GameList]` `RecursivePaths =`/`Paths =` section are BYTE-IDENTICAL.
// Re-exported by `pcsx2-library.js`/`duckstation-library.js`.

const { escapeRegExp } = require('../../parse.js');

// Pure, regex-based lookup — NOT a full YAML parser (the files are several MB, a parser dependency is not justified for reading one
// field).
function lookupGameName(yamlText, serial) {
    if (!yamlText || !serial) return null;
    const re = new RegExp(`^${escapeRegExp(serial)}:\\s*$`, 'm');
    const m = re.exec(yamlText);
    if (!m) return null;
    const rest = yamlText.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const nameMatch = /^\s*name:\s*"([^"]*)"/m.exec(rest);
    return nameMatch ? nameMatch[1] : null;
}

// The `RecursivePaths =`/`Paths =` lines of the `[GameList]` section — line-by-line processing (NOT one big capture regex — a multiline
// `$` lookahead only caught the first line in an earlier version), from the `[GameList]` line to the next `[...]` section header (or the
// end of the file).
function parseGameListDirs(iniText) {
    const lines = String(iniText == null ? '' : iniText).split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.trim() === '[GameList]');
    if (startIdx < 0) return [];
    const dirs = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\[.*\]$/.test(line.trim())) break; // next section -> done
        const m = /^(?:RecursivePaths|Paths)\s*=\s*(.+?)\s*$/.exec(line);
        if (m && m[1]) dirs.push(m[1]);
    }
    return dirs;
}

// `<serial>  <total seconds>  <last played, unix s>` per line (fixed-width, space-separated fields). `Map<serial,{seconds,lastPlayedAt}>`
// (`lastPlayedAt` in ms epoch, the convention of the other `recentGames` sources).
function parsePlaytime(text) {
    const map = new Map();
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const [serial, secondsStr, tsStr] = parts;
        const seconds = Number(secondsStr);
        const ts = Number(tsStr);
        if (!serial || !Number.isFinite(seconds) || !Number.isFinite(ts)) continue;
        map.set(serial, { seconds, lastPlayedAt: ts * 1000 });
    }
    return map;
}

module.exports = { lookupGameName, parseGameListDirs, parsePlaytime };
