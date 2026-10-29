// @ts-check
'use strict';

// Flatpak helpers in ONE place. The pure parsers (`parse*`, `flatpakErrorLine`, `flatpakRunAppId`, `catalogAppId`)
// do no I/O and are testable; the rest is best effort — never throws, error → empty list / `false` / `null`.
// No `electron` reference (test/contracts/require-smoke.test.js).

const { spawn } = require('child_process');
const { execFileAsync, EXEC_TIMEOUT_MS } = require('./exec.js');
const { checkParsed } = require('./host-deps/format-drift.js');

// Timeouts of the flatpak calls (values in lib/timings.js): the quick queries (`list`/`info`/`ps`) are shorter
// than the general `EXEC_TIMEOUT_MS` (catalog detection runs in parallel for every entry); the `remote-add` +
// `install` steps of the in-app install (`lib/ipc/launcher-manage-ipc.js` `installFlatpak`) get a timeout too,
// so a stuck `flatpak` process cannot keep the caller's "install in progress?" flag set forever.
const {
    FLATPAK_QUERY_TIMEOUT_MS, FLATPAK_REMOTE_TIMEOUT_MS, FLATPAK_INSTALL_TIMEOUT_MS,
} = require('./timings.js');

// --- Pure parsers ---

// The appid from a `flatpak run <appId> …` argument list (the item after `run`), or `null` if there is
// no `run` / nothing after it.
/** @param {unknown} args @returns {string|null} */
function flatpakRunAppId(args) {
    if (!Array.isArray(args)) return null;
    const i = args.indexOf('run');
    return i >= 0 && typeof args[i + 1] === 'string' && args[i + 1] ? args[i + 1] : null;
}

// The app id of a catalog/launcher entry: the arg after `run`, or (no `run`) the last arg. Known limit:
// an option between `run` and the appid (`--branch=…`) would take the appid's place — the catalog has none.
/** @param {{ args?: string[] } | null | undefined} entry */
function catalogAppId(entry) {
    const args = (entry && entry.args) || [];
    return args[args.indexOf('run') + 1] || args[args.length - 1];
}

// The PID of an appid (the wrapper process) from `flatpak ps --columns=application,pid`, or null.
// Locale-independent, tab-separated.
function parseFlatpakPs(psOutput, appId) {
    for (const line of String(psOutput || '').trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === appId) {
            const pid = parseInt(parts[1], 10);
            if (pid) return pid;
        }
    }
    return null;
}

// The appids of the CURRENTLY running flatpak apps from `flatpak ps --columns=application` (one appid
// per line). Only lines containing `.` (an appid is always reverse DNS).
function parseFlatpakAppList(psOutput) {
    return String(psOutput || '').trim().split('\n')
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((id) => id && id.includes('.'));
}

// `flatpak list --app --columns=application,name` output → [{ appId, name }] (flatpak app browsing).
// Tab-separated, locale-independent; lines without `.` (header / junk) are skipped.
function parseFlatpakInstalledApps(listOutput) {
    return String(listOutput || '').trim().split('\n')
        .map((line) => {
            const [appId, ...rest] = line.trim().split('\t');
            return { appId: (appId || '').trim(), name: rest.join(' ').trim() };
        })
        .filter((a) => a.appId.includes('.'))
        .map((a) => ({ appId: a.appId, name: a.name || a.appId }));
}

// The line of a `flatpak install` output to show as the error: flatpak writes the real reason into the
// `error:` (LC_ALL=C) / `hiba:` line; if there is none, the last non-empty line. The `error:`/`hiba:`
// prefix is cut, max 300 chars.
function flatpakErrorLine(out) {
    const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const errLine = [...lines].reverse().find((l) =>
        /^(error|hiba)[:\s]/i.test(l) || /not found|nothing matches|no such|failed|denied|nem található/i.test(l));
    return (errLine || lines[lines.length - 1] || '').replace(/^(error|hiba):\s*/i, '').slice(0, 300);
}

// `flatpak info --show-permissions <appId>` output (the effective permissions WITH the overrides, keyfile
// form: `[Context]` + `filesystems=host:ro;~/Games;!home;`) → `{ sections, filesystems }`. The section
// headers are needed for the format-drift signal (empty output = no permissions, which is legit; non-empty
// output without a section = changed format). Unknown lines are skipped.
/** @param {unknown} text @returns {{ sections: string[], filesystems: string[] }} */
function parseFlatpakPermissions(text) {
    const sections = [];
    const filesystems = [];
    let current = '';
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        const head = /^\[(.+)\]$/.exec(line);
        if (head) { current = head[1]; sections.push(current); continue; }
        if (current !== 'Context') continue;
        const m = /^filesystems\s*=\s*(.*)$/.exec(line);
        if (m) filesystems.push(...m[1].split(';').map((f) => f.trim()).filter(Boolean));
    }
    return { sections, filesystems };
}

// --- Queries / actions (best effort) ---

// The raw `flatpak ps --columns=application,pid` output — `null` if the call failed. The run poller of
// `lib/launch/running.js` calls it ONCE per tick and reuses it for every launcher.
async function flatpakPsOutput() {
    try {
        const { stdout } = await execFileAsync('flatpak', ['ps', '--columns=application,pid'], { timeout: FLATPAK_QUERY_TIMEOUT_MS });
        return stdout;
    } catch (err) {
        return null;
    }
}

async function listRunningFlatpakApps() {
    const out = await flatpakPsOutput();
    return out === null ? [] : [...new Set(parseFlatpakAppList(out))].sort();
}

async function listInstalledFlatpakApps() {
    try {
        const { stdout } = await execFileAsync(
            'flatpak', ['list', '--app', '--columns=application,name'], { timeout: FLATPAK_QUERY_TIMEOUT_MS });
        const seen = new Set();
        const apps = parseFlatpakInstalledApps(stdout);
        checkParsed('flatpak-list', stdout, apps.length);
        return apps
            .filter((a) => (seen.has(a.appId) ? false : seen.add(a.appId)))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
        return [];
    }
}

// The effective `filesystems` permissions of a flatpak app (see `parseFlatpakPermissions`), or `null` if
// the query failed (no flatpak / no such app / timeout) — the caller makes no judgement then.
/** @param {string} appId @returns {Promise<string[]|null>} */
async function readFlatpakFilesystems(appId) {
    try {
        const { stdout } = await execFileAsync(
            'flatpak', ['info', '--show-permissions', appId], { timeout: FLATPAK_QUERY_TIMEOUT_MS });
        const parsed = parseFlatpakPermissions(stdout);
        checkParsed('flatpak-permissions', stdout, parsed.sections.length);
        return parsed.filesystems;
    } catch (err) {
        return null;
    }
}

// Is a flatpak app installed (`flatpak info <appId>` exit 0).
async function flatpakAppInstalled(appId) {
    try {
        await execFileAsync('flatpak', ['info', appId], { timeout: FLATPAK_QUERY_TIMEOUT_MS });
        return true;
    } catch (err) {
        return false;
    }
}

// IMMEDIATE stop of the given flatpak app (`flatpak kill <appId>`) — the Node counterpart of
// `close_flatpak()` in `bin/tv-mode-enter.sh`. Only `flatpak kill` reliably stops a whole flatpak sandbox
// (`child.kill()` of the spawned `flatpak run` wrapper does NOT necessarily reach the app inside the
// sandbox). `false` for an app that is not running / on error.
async function killFlatpakApp(appId) {
    try {
        await execFileAsync('flatpak', ['kill', appId], { timeout: EXEC_TIMEOUT_MS });
        return true;
    } catch (err) {
        return false;
    }
}

// Streaming run of `flatpak <verb>`. NOT `execFileAsync` (that buffers the whole output and only returns
// when the process ends) — `install --user` writes % progress lines WHILE running; the caller's `onLine`
// gets them (source of the `flatpak-install-progress` push), hence a manual `spawn` + timer. `LC_ALL=C`:
// error message in English (parsed by `flatpakErrorLine`). Never throws — always returns `{ code, out,
// timedOut? }` (`code !== 0` = error).
function runFlatpak(args, onLine, timeoutMs = EXEC_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let child;
        let out = '';
        let settled = false;
        let timer = null;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        try {
            child = spawn('flatpak', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
        } catch (err) {
            finish({ code: -1, out: err.message });
            return;
        }
        timer = setTimeout(() => {
            out += '\n[timeout] flatpak did not answer in time, aborted';
            child.kill('SIGKILL');
            finish({ code: -1, out: out.trim(), timedOut: true });
        }, timeoutMs);
        const onData = (d) => { const s = String(d); out += s; if (onLine) onLine(s); };
        if (child.stdout) child.stdout.on('data', onData);
        if (child.stderr) child.stderr.on('data', onData);
        child.on('error', (err) => finish({ code: -1, out: (out + '\n' + err.message).trim() }));
        child.on('close', (code) => finish({ code, out: out.trim() }));
    });
}

module.exports = {
    FLATPAK_QUERY_TIMEOUT_MS, FLATPAK_REMOTE_TIMEOUT_MS, FLATPAK_INSTALL_TIMEOUT_MS,
    flatpakRunAppId, catalogAppId, parseFlatpakPs, parseFlatpakAppList, parseFlatpakInstalledApps,
    parseFlatpakPermissions, readFlatpakFilesystems, flatpakErrorLine, flatpakPsOutput, listRunningFlatpakApps,
    listInstalledFlatpakApps,
    flatpakAppInstalled, killFlatpakApp, runFlatpak,
};
