// @ts-check
'use strict';

// Dependency hygiene: `npm outdated --json` + `npm audit --json` at the repo root — ONLY a signal in the Update subview (installs / changes
// nothing). Both need the network; `npm outdated` exits with 1 if there is an outdated package (the JSON is still on stdout), `npm audit`
// is non-zero on vulnerabilities — so we look at the stdout JSON instead of the exit code. Offline / npm error → that part is `null`, never
// throws.

const { execFileAsync } = require('../exec.js');
const { NPM_QUERY_TIMEOUT_MS } = require('../timings.js');

function majorOf(v) {
    const m = /^(\d+)/.exec(String(v || ''));
    return m ? Number(m[1]) : null;
}

/**
 * `npm outdated --json` → the outdated packages, major-version lag marked (empty stdout = nothing outdated). Broken / error JSON /
 * `null` (the call itself failed) → `null`. Pure.
 * @param {string|null} text
 * @returns {Array<{ name: string, current: string|null, wanted: string|null, latest: string|null, major: boolean }> | null}
 */
function parseNpmOutdated(text) {
    if (text == null) return null;
    let data;
    try {
        data = JSON.parse(String(text || '').trim() || '{}');
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object' || data.error) return null;
    return Object.entries(data).map(([name, v]) => {
        const current = v && v.current ? String(v.current) : null;
        const latest = v && v.latest ? String(v.latest) : null;
        const cm = majorOf(current);
        const lm = majorOf(latest);
        return {
            name, current, wanted: v && v.wanted ? String(v.wanted) : null, latest,
            major: cm !== null && lm !== null && lm > cm,
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `npm audit --json` → number of vulnerabilities by severity. Broken / error JSON → `null`.
 * @param {string|null} text
 * @returns {{ total: number, critical: number, high: number, moderate: number, low: number } | null}
 */
function parseNpmAudit(text) {
    let data;
    try {
        data = JSON.parse(String(text || '').trim());
    } catch {
        return null;
    }
    const v = data && data.metadata && data.metadata.vulnerabilities;
    if (!v || data.error) return null;
    const n = (k) => Number(v[k]) || 0;
    return { total: n('total'), critical: n('critical'), high: n('high'), moderate: n('moderate'), low: n('low') };
}

// The stdout of an npm command regardless of the exit code (a non-zero code is not an error here); if the call failed WITHOUT stdout
// (no npm / timeout) → `null`.
async function npmJson(exec, repoRoot, args) {
    try {
        const { stdout } = await exec('npm', args, { cwd: repoRoot, timeout: NPM_QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
        return stdout;
    } catch (err) {
        return err && typeof err.stdout === 'string' && err.stdout.trim() ? err.stdout : null;
    }
}

/**
 * The two queries in parallel. Never throws.
 * @param {string} repoRoot
 * @param {{ exec?: typeof execFileAsync }} [opts]
 */
async function checkDependencyHealth(repoRoot, { exec = execFileAsync } = {}) {
    const [outdatedText, auditText] = await Promise.all([
        npmJson(exec, repoRoot, ['outdated', '--json']),
        npmJson(exec, repoRoot, ['audit', '--json']),
    ]);
    const outdated = parseNpmOutdated(outdatedText);
    const audit = parseNpmAudit(auditText);
    return { ok: outdated !== null || audit !== null, outdated, audit };
}

module.exports = { parseNpmOutdated, parseNpmAudit, checkDependencyHealth };
