'use strict';

// Escaping of the "data-like" interpolations (name, label, path, MAC, SSID …) in the renderer's
// HTML templates. The renderer uses manual `esc()` chains, where a missing `esc` would let a
// ROM name / SSID / BT name through as raw HTML. This is a HEURISTIC: it looks at the template
// literals that contain an HTML tag, and in them at the `${…}` expressions that reference a
// data-like member/variable — these must be wrapped in an `esc(`/`tr(`/`fileUrl(`/… call. The
// ALLOWLIST holds the intentionally raw cases (internal constant / already escaped), with reasons.
// `safeHtml` tagged templates (renderer/util.js) escape by themselves — they are skipped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

// Data-like identifiers: member names of text coming from an external source (ROM file name, BT device, SSID, config).
const DATA_NAME = /(?:^|[^\w$])(?:name|label|title|description|desc|ssid|path|text|message|error|subtitle|mac|dir|cmd|appName)\b/;
// These calls escape / encode, or return a number.
const SAFE_CALL = /^(?:esc|tr|rawHtml|attr|escAttr|fileUrl|safeHtml|String)\(|\.length\b|^Math\./;

// Intentionally raw expressions. Key: `<file>|<start of expression>`.
const ALLOWLIST = new Set([
    // Compound (ternary / map) expressions: the inner data text is inside `esc(...)`, the outer name is only a condition.
    'renderer/controller/controller-help.js|CONTROLS_HELP.map(',    // static table; the texts are in `esc(tr(...))`
    'renderer/games-panel/games-panel-details.js|facts.map(',
    'renderer/home/carousel.js|g.cover ?',                           // `fileUrl(g.cover)` + `esc(g.name)` inside
    'renderer/settings/settings-bt.js|CONTROLLER_ICONS[classifyController(f.name)]', // internal SVG constant for the type key
    'renderer/settings/settings-launcher-add.js|thumb(',             // `thumb()` itself writes `esc(src)`
    'renderer/settings/settings-launchers.js|path',                  // `path` = `esc(manual.manualPath)`
]);

function walk(d) {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
}

/** The source's backtick templates: { text (\0 in place of ${}), exprs, tag (the identifier before the opening `) }. */
function templateLiterals(src) {
    const out = [];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (src[i] === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
        if (src[i] === '\'' || src[i] === '"') {
            const q = src[i]; i++;
            while (i < src.length && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
            continue;
        }
        if (src[i] !== '`') continue;
        const tag = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, i - 20), i));
        let j = i + 1, text = '';
        const exprs = [];
        while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '`') break;
            if (src[j] === '$' && src[j + 1] === '{') {
                let k = j + 2, depth = 1;
                while (k < src.length && depth) {
                    if (src[k] === '`') { // nested template: skip it (its own ${} too)
                        k++;
                        while (k < src.length && src[k] !== '`') { if (src[k] === '\\') k++; k++; }
                    } else if (src[k] === '{') depth++;
                    else if (src[k] === '}') depth--;
                    k++;
                }
                exprs.push(src.slice(j + 2, k - 1));
                text += '\0';
                j = k;
                continue;
            }
            text += src[j++];
        }
        out.push({ text, exprs, tag: tag ? tag[1] : '' });
        i = j;
    }
    return out;
}

test('data-like interpolations in the renderer HTML templates are escaped', () => {
    const problems = [];
    const used = new Set();
    for (const file of walk(path.join(root, 'renderer'))) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        for (const tpl of templateLiterals(fs.readFileSync(file, 'utf8'))) {
            if (tpl.tag === 'safeHtml' || !/<[a-zA-Z/]/.test(tpl.text)) continue;
            for (const raw of tpl.exprs) {
                const expr = raw.replace(/\s+/g, ' ').trim();
                if (!DATA_NAME.test(expr) || SAFE_CALL.test(expr)) continue;
                const key = [...ALLOWLIST].find((k) => k.startsWith(rel + '|') && expr.startsWith(k.slice(rel.length + 1)));
                if (key) { used.add(key); continue; }
                problems.push(`${rel}: \${${expr.slice(0, 80)}}`);
            }
        }
    }
    assert.deepStrictEqual(problems, [], 'data-like interpolation without escaping (wrap it in `esc(...)`, or put it in the ALLOWLIST with a justification)');
    const stale = [...ALLOWLIST].filter((k) => !used.has(k));
    assert.deepStrictEqual(stale, [], 'superfluous (no longer occurring) entry in the ALLOWLIST');
});

test('the guard test really catches an interpolation without escaping (self-check)', () => {
    const tpls = templateLiterals('x.innerHTML = `<b>${row.name}</b>${esc(row.label)}`; y = `no html ${name}`;');
    assert.strictEqual(tpls.length, 2);
    assert.deepStrictEqual(tpls[0].exprs, ['row.name', 'esc(row.label)']);
    assert.ok(DATA_NAME.test(tpls[0].exprs[0]) && !SAFE_CALL.test(tpls[0].exprs[0]));
    assert.ok(SAFE_CALL.test(tpls[0].exprs[1]));
});
