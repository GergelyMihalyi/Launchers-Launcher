// @ts-check
'use strict';

// Per-game launch options: one line of text — `NAME=value` env variables + extra arguments (e.g. `MANGOHUD=1 --fullscreen`), in the
// `gameLaunchOptions` config key; main parses it at launch. SECURITY: no shell (split into tokens, `spawn` arg array), narrow env names +
// a denylist (`LD_*`, `BASH_ENV`, `PATH`, `NODE_OPTIONS` …), size limits. For flatpak the env goes as `--env=`, the extra arguments AFTER
// the app id, BEFORE the ROM path. Background: docs/dev/launching.md#per-game-launch-options

const MAX_TEXT = 300;
const MAX_ARGS = 24;
const MAX_ENV = 8;
const MAX_TOKEN = 200;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// Loader/interpreter/system variables: can never be set this way.
const ENV_DENY = /^(LD_|BASH|ENV$|SHELL$|PATH$|IFS$|NODE_|ELECTRON|PYTHON|PERL|RUBY|JAVA|_JAVA|HOME$|USER$|XDG_|DBUS_|WAYLAND|DISPLAY$|XAUTHORITY$|FLATPAK|SUDO|GCONV|LOCPATH|TMPDIR$)/;

/**
 * Shell-like word splitting (with quotes; no escapes inside single quotes; `\"` and `\\` inside double quotes). No
 * evaluation (`$`, `` ` ``, `*` are plain characters). Unterminated quote → `null`.
 * @param {string} text
 * @returns {string[] | null}
 */
function splitWords(text) {
    /** @type {string[]} */
    const words = [];
    let cur = '';
    let inWord = false;
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) { quote = ''; continue; }
            if (quote === '"' && ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { cur += text[++i]; continue; }
            cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            inWord = true;
        } else if (/\s/.test(ch)) {
            if (inWord) { words.push(cur); cur = ''; inWord = false; }
        } else {
            cur += ch;
            inWord = true;
        }
    }
    if (quote) return null;
    if (inWord) words.push(cur);
    return words;
}

/**
 * @param {unknown} text
 * @returns {{ ok: boolean, env?: Record<string, string>, args?: string[], text?: string, error?: string }}
 */
function parseLaunchOptions(text) {
    if (typeof text !== 'string') return { ok: false, error: 'invalid' };
    const trimmed = text.trim();
    if (trimmed.length > MAX_TEXT) return { ok: false, error: 'too-long' };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(trimmed)) return { ok: false, error: 'control-chars' };
    const words = splitWords(trimmed);
    if (!words) return { ok: false, error: 'unclosed-quote' };
    /** @type {Record<string, string>} */
    const env = {};
    const args = [];
    let envPhase = true;
    for (const w of words) {
        if (w.length > MAX_TOKEN) return { ok: false, error: 'token-too-long' };
        const m = envPhase ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w) : null;
        if (m) {
            const name = m[1];
            if (!ENV_NAME.test(name) || ENV_DENY.test(name)) return { ok: false, error: 'bad-env-name' };
            if (Object.keys(env).length >= MAX_ENV && !(name in env)) return { ok: false, error: 'too-many-env' };
            env[name] = m[2];
        } else {
            envPhase = false;
            args.push(w);
            if (args.length > MAX_ARGS) return { ok: false, error: 'too-many-args' };
        }
    }
    return { ok: true, env, args, text: trimmed };
}

/**
 * Builds the options into a launch command.
 * @param {string} cmd @param {string[]} args @param {string|null} romPath the ROM path (the extra arguments go before it)
 * @param {{ env?: Record<string, string>, args?: string[] }} opts a successful `parseLaunchOptions` result
 * @returns {{ cmd: string, args: string[], env: Record<string, string> }}
 */
function applyLaunchOptions(cmd, args, romPath, opts) {
    const out = [...args];
    const optArgs = opts.args || [];
    const optEnv = opts.env || {};
    const isFlatpak = cmd === 'flatpak' && out[0] === 'run';
    if (optArgs.length) {
        let idx = romPath ? out.lastIndexOf(romPath) : -1;
        if (idx < 0) idx = out.length;
        else if (out[idx - 1] === '--') idx -= 1;
        // Flatpak: the extra arguments go AFTER the app id (`run <app-id> …`), never as flatpak options.
        if (isFlatpak) idx = Math.max(idx, 2);
        out.splice(idx, 0, ...optArgs);
    }
    const envEntries = Object.entries(optEnv);
    if (isFlatpak && envEntries.length) {
        out.splice(1, 0, ...envEntries.map(([k, v]) => `--env=${k}=${v}`));
        return { cmd, args: out, env: {} };
    }
    return { cmd, args: out, env: { ...optEnv } };
}

module.exports = { parseLaunchOptions, applyLaunchOptions, splitWords, MAX_TEXT };
