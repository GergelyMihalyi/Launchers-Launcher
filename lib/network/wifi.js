// @ts-check
'use strict';

// Wi-Fi network picker (`nmcli`) — Settings → Power and network → Wi-Fi. No `BrowserWindow` reference. Verified on the machine (NM 1.52):
// `LC_ALL=C.UTF-8` is needed (a Hungarian locale translates the terse `ACTIVE`, plain `C` mangles an accented SSID into `?`); in `-t`
// output a `:` inside a field is `\:`, a `\` is `\\`; the profile name ≠ SSID — saved networks are matched by `802-11-wireless.ssid`.
// ⚠️ PASSWORD: in `device wifi connect … password <pwd>` it is a command-line arg, so the `err.message` of an `execFile` error contains it
// RAW — NEVER log `err.message` / `args`, only the first line of the `redact()`-ed stderr. Background: docs/dev/devices.md#wi-fi-nmcli

const { execFileAsync, toLogger } = require('../exec.js');
const { checkParsed } = require('../host-deps/format-drift.js');
const { EXEC_TIMEOUT_MS, WIFI_SCAN_TIMEOUT_MS, WIFI_CONNECT_TIMEOUT_MS } = require('../timings.js');

const NMCLI_ENV = { ...process.env, LC_ALL: 'C.UTF-8' };
// `nmcli --wait` (s) is its own activation wait — it stays below the process timeout so the error comes from nmcli (with a meaningful
// message), not from the kill.
const CONNECT_WAIT_S = Math.max(5, Math.floor(WIFI_CONNECT_TIMEOUT_MS / 1000) - 5);

// Splits a terse (`nmcli -t`) line into fields, honoring the escapes (`\:` / `\\`).
function splitTerse(line) {
    const out = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
        if (ch === ':') { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

const isEnterprise = (security) => /802\.1X/i.test(security || '');
const isSecured = (security) => !!security && security !== '--';

// `nmcli -t -f ACTIVE,SSID,SIGNAL,SECURITY dev wifi list` → one row per network. Hidden (empty SSID) APs are skipped; several APs with the
// same SSID (mesh / 2.4+5 GHz) are ONE row: the active one wins, otherwise the stronger signal. Order: active first, then by signal
// strength descending.
/** @returns {{ ssid: string, signal: number, active: boolean, security: string, secured: boolean, enterprise: boolean }[]} */
function parseWifiList(stdout) {
    const bySsid = new Map();
    for (const line of String(stdout || '').split('\n')) {
        if (!line.trim()) continue;
        const [active, ssid, signal, security = ''] = splitTerse(line);
        if (!ssid) continue;
        const sec = security.trim();
        const net = {
            ssid,
            signal: Math.max(0, Math.min(100, parseInt(signal, 10) || 0)),
            active: active === 'yes',
            security: isSecured(sec) ? sec : '',
            secured: isSecured(sec),
            enterprise: isEnterprise(sec),
        };
        const prev = bySsid.get(ssid);
        if (!prev) { bySsid.set(ssid, net); continue; }
        if (net.active && !prev.active) bySsid.set(ssid, net);
        else if (net.active === prev.active && net.signal > prev.signal) bySsid.set(ssid, net);
    }
    return [...bySsid.values()].sort((a, b) =>
        (Number(b.active) - Number(a.active)) || (b.signal - a.signal) || a.ssid.localeCompare(b.ssid));
}

// `nmcli -t -f UUID,TYPE con show [--active]` → a Wi-Fi profilok UUID-jai.
function parseWifiUuids(stdout) {
    return String(stdout || '').split('\n')
        .map(splitTerse)
        .filter(([uuid, type]) => uuid && type === '802-11-wireless')
        .map(([uuid]) => uuid);
}

// `nmcli -t -f connection.uuid,802-11-wireless.ssid con show <uuid…>` (several profiles, separated by empty lines) → Map<ssid, uuid[]>.
// The detail view's values are NOT escaped: everything after the first `:` is the value.
function parseSavedSsids(stdout) {
    const map = new Map();
    let uuid = null;
    for (const line of String(stdout || '').split('\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i);
        const val = line.slice(i + 1);
        if (key === 'connection.uuid') uuid = val;
        else if (key === '802-11-wireless.ssid' && uuid && val) {
            if (!map.has(val)) map.set(val, []);
            map.get(val).push(uuid);
            uuid = null;
        }
    }
    return map;
}

// Every occurrence of `secret` in a text masked with asterisks (a safeguard before logging).
function redact(text, secret) {
    const s = String(text || '');
    return secret ? s.split(secret).join('***') : s;
}

// The first meaningful line of a failed `nmcli` call's stderr, without the password.
function nmcliErrorLine(err, secret) {
    const lines = String((err && err.stderr) || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return redact(lines[0] || (err && err.killed ? 'timeout' : 'unknown error'), secret);
}

// Error → i18n key suffix (renderer: `sv.wifiErr.<key>`).
function classifyConnectError(err) {
    if (err && err.killed) return 'timeout';
    const text = String((err && err.stderr) || '');
    if (/secrets were required|psk: property is invalid|invalid passphrase|password/i.test(text)) return 'badPassword';
    if (/no network with SSID/i.test(text)) return 'notFound';
    if (/not authorized|insufficient privileges|permission denied/i.test(text)) return 'denied';
    return 'failed';
}

// WPA-PSK: 8–63 printable ASCII, or exactly 64 hex digits. `null` = no password.
function validPassword(pwd) {
    if (pwd == null) return true;
    if (typeof pwd !== 'string') return false;
    if (/^[0-9a-fA-F]{64}$/.test(pwd)) return true;
    return pwd.length >= 8 && pwd.length <= 63 && /^[\x20-\x7e]+$/.test(pwd);
}

function validSsid(ssid) {
    return typeof ssid === 'string' && ssid.length > 0 && Buffer.byteLength(ssid) <= 32 && !/[\n\r\0]/.test(ssid);
}

/**
 * @param {{ exec?: typeof execFileAsync, log?: (msg: string) => void }} [deps]
 */
function createWifi({ exec = execFileAsync, log } = {}) {
    const emit = toLogger(log);
    const nmcli = (args, timeout = EXEC_TIMEOUT_MS) => exec('nmcli', args, { env: NMCLI_ENV, timeout });

    async function hasWifiDevice() {
        const { stdout } = await nmcli(['-t', '-f', 'TYPE', 'device', 'status']);
        return String(stdout).split('\n').some((l) => l.trim() === 'wifi');
    }

    async function radioEnabled() {
        const { stdout } = await nmcli(['radio', 'wifi']);
        return String(stdout).trim() === 'enabled';
    }

    // Saved profiles: Map<ssid, uuid[]>. Best effort — error → empty Map.
    async function savedProfiles() {
        try {
            const { stdout } = await nmcli(['-t', '-f', 'UUID,TYPE', 'connection', 'show']);
            const uuids = parseWifiUuids(stdout);
            if (!uuids.length) return new Map();
            const det = await nmcli(['-t', '-f', 'connection.uuid,802-11-wireless.ssid', 'connection', 'show', ...uuids]);
            return parseSavedSsids(det.stdout);
        } catch (_) {
            return new Map();
        }
    }

    async function activeWifiUuid() {
        try {
            const { stdout } = await nmcli(['-t', '-f', 'UUID,TYPE', 'connection', 'show', '--active']);
            return parseWifiUuids(stdout)[0] || null;
        } catch (_) {
            return null;
        }
    }

    // `rescan`: `true`/`'yes'` = always a fresh scan; `'no'` = NetworkManager's cached result (~40 ms — the subview's instant first
    // paint); otherwise `'auto'` (a fresh scan only if the last one is older than ~30 s — that one takes ~6 s on the machine).
    async function scan(rescan) {
        const mode = rescan === true ? 'yes' : (rescan === 'yes' || rescan === 'no') ? rescan : 'auto';
        const { stdout } = await nmcli(['-t', '-f', 'ACTIVE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list',
            '--rescan', mode], WIFI_SCAN_TIMEOUT_MS);
        const list = parseWifiList(stdout);
        checkParsed('nmcli-wifi', stdout, list.length);
        return list;
    }

    // Data of the Wi-Fi subview. `device: false` → no Wi-Fi hardware; `radio: false` → it is turned off (the list is empty then). Throws if
    // nmcli itself does not run (the caller turns it into `ok: false`).
    // `rescan`: see `scan()`.
    async function listNetworks({ rescan = /** @type {boolean | string} */ (false) } = {}) {
        if (!(await hasWifiDevice())) return { device: false, radio: false, items: [] };
        if (!(await radioEnabled())) return { device: true, radio: false, items: [] };
        const [nets, saved] = await Promise.all([scan(rescan), savedProfiles()]);
        return { device: true, radio: true, items: nets.map((n) => ({ ...n, saved: saved.has(n.ssid) })) };
    }

    async function setRadio(on) {
        try {
            await nmcli(['radio', 'wifi', on ? 'on' : 'off']);
            emit(`Wi-Fi radio: ${on ? 'on' : 'off'}`);
            return { ok: true };
        } catch (err) {
            emit(`Wi-Fi radio error: ${nmcliErrorLine(err, null)}`);
            return { ok: false };
        }
    }

    // Connect. For a saved profile without a password `connection up` (with the stored password); for a new network / one given with a
    // password `device wifi connect`. On error: (1) the broken profile JUST created is deleted (otherwise autoconnect would keep trying the
    // wrong password), (2) if the previous Wi-Fi connection dropped meanwhile, it is reconnected (it keeps the network up on a Wi-Fi-only machine).
    //
    // `hidden: true` — hidden SSID (not on the list): the network's presence/security is unknown, so the list checks are skipped;
    // `device wifi connect <ssid> [password <p>] hidden yes` (without a password it tries as an open network). Same cleanup on error.
    // A rejection BEFORE any nmcli connect call — logged too (SSID + reason only, never the password), otherwise the log shows nothing.
    function reject(ssid, errorKey) {
        emit(`Wi-Fi connect rejected (${ssid || '?'}): ${errorKey}`);
        return { ok: false, errorKey, ssid };
    }

    async function connect(ssid, password, { hidden = false } = {}) {
        const pwd = password === '' ? null : password;
        if (!validSsid(ssid)) return reject('', 'failed');
        if (!validPassword(pwd)) return reject(ssid, 'badPasswordFormat');

        let net = null;
        if (!hidden) {
            const nets = await scan(false).catch(() => []);
            net = nets.find((n) => n.ssid === ssid);
            if (!net) return reject(ssid, 'notFound');
            if (net.enterprise) return reject(ssid, 'unsupported');
            if (net.active) return { ok: true, already: true, ssid };
        }

        const savedBefore = await savedProfiles();
        const savedUuids = savedBefore.get(ssid) || [];
        if (net && net.secured && !pwd && !savedUuids.length) return reject(ssid, 'needPassword');

        const prevUuid = await activeWifiUuid();
        const args = (!pwd && savedUuids.length)
            ? ['--wait', String(CONNECT_WAIT_S), 'connection', 'up', 'uuid', savedUuids[0]]
            : ['--wait', String(CONNECT_WAIT_S), 'device', 'wifi', 'connect', ssid, ...(pwd ? ['password', pwd] : []), ...(hidden ? ['hidden', 'yes'] : [])];
        emit(`Wi-Fi connect: ${ssid}${pwd ? ' (with password)' : ''}`);
        try {
            await nmcli(args, WIFI_CONNECT_TIMEOUT_MS);
            emit(`Wi-Fi csatlakozva: ${ssid}`);
            return { ok: true, ssid };
        } catch (err) {
            const errorKey = classifyConnectError(err);
            emit(`Wi-Fi connect error (${ssid}): ${nmcliErrorLine(err, pwd)}`);
            await cleanupAfterFailure(ssid, savedUuids, prevUuid);
            return { ok: false, errorKey, ssid };
        }
    }

    // Forget a saved network: delete EVERY saved profile of the SSID (`connection delete uuid`). Forgetting a currently active network drops
    // the connection. `{ ok, removed }`; no saved profile → `ok: false`.
    async function forget(ssid) {
        if (!validSsid(ssid)) return { ok: false, removed: 0 };
        const uuids = (await savedProfiles()).get(ssid) || [];
        if (!uuids.length) return { ok: false, removed: 0 };
        let removed = 0;
        for (const uuid of uuids) {
            try {
                await nmcli(['connection', 'delete', 'uuid', uuid]);
                removed++;
            } catch (err) {
                emit(`Wi-Fi forget profile error (${ssid}): ${nmcliErrorLine(err, null)}`);
            }
        }
        emit(`Wi-Fi: forgot network: ${ssid} (${removed}/${uuids.length} profiles)`);
        return { ok: removed > 0, removed };
    }

    async function cleanupAfterFailure(ssid, savedUuidsBefore, prevUuid) {
        const after = await savedProfiles();
        const fresh = (after.get(ssid) || []).filter((u) => !savedUuidsBefore.includes(u));
        for (const uuid of fresh) {
            await nmcli(['connection', 'delete', 'uuid', uuid])
                .then(() => emit(`Wi-Fi: the failed new profile was deleted (${ssid})`))
                .catch((e) => emit(`Wi-Fi profile delete error: ${nmcliErrorLine(e, null)}`));
        }
        if (prevUuid && !fresh.includes(prevUuid) && (await activeWifiUuid()) !== prevUuid) {
            await nmcli(['--wait', String(CONNECT_WAIT_S), 'connection', 'up', 'uuid', prevUuid], WIFI_CONNECT_TIMEOUT_MS)
                .then(() => emit('Wi-Fi: the previous connection was restored'))
                .catch((e) => emit(`Wi-Fi: restoring the previous connection failed: ${nmcliErrorLine(e, null)}`));
        }
    }

    return { listNetworks, connect, setRadio, forget };
}

module.exports = {
    createWifi,
    splitTerse, parseWifiList, parseWifiUuids, parseSavedSsids,
    redact, classifyConnectError, validPassword, validSsid,
};
