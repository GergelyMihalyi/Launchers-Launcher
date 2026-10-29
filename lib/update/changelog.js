// @ts-check
'use strict';

// Extracts the latest section of CHANGELOG.md for the "What's new" panel. Pure parser — called by the `get-changelog` handler. The format
// is loosely Keep a Changelog: `## [version] - date` headers with `### Added` / `### Changed` / … subsections of `- item` lists.

/**
 * @param {string} md  the whole content of CHANGELOG.md
 * @returns {{ heading: string, lines: string[] }}
 *   heading — text of the first `## …` header (without `## `), e.g. "[Unreleased]" or "[1.2.0] - 2026-09-11"
 *   lines   — the section's lines with leading/trailing empty lines trimmed (`### ` subheaders + `- ` items kept)
 */
function parseLatestSection(md) {
    const all = String(md == null ? '' : md).split(/\r?\n/);
    let start = -1;
    for (let i = 0; i < all.length; i++) {
        if (/^##\s+/.test(all[i])) { start = i; break; }
    }
    if (start < 0) return { heading: '', lines: [] };
    const heading = all[start].replace(/^##\s+/, '').trim();
    let end = all.length;
    for (let i = start + 1; i < all.length; i++) {
        if (/^##\s+/.test(all[i])) { end = i; break; }
    }
    let lines = all.slice(start + 1, end);
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return { heading, lines };
}

module.exports = { parseLatestSection };
