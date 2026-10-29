// Button layout help: the buttons of the home screen, the PS combos and the Games panel in ONE table — both the setup wizard's "Button
// layout" step AND the Settings → Controllers → "Button layout" subview draw from it. The glyphs follow the ACTIVE controller type through
// `btnIcon()`. The table describes the actual mapping of gamepad.js / games-panel.js — **if a button's role changes there, adjust it HERE
// too**. Load order: AFTER controller-labels.js. Background: docs/dev/renderer/input.md#controls-help

// `keys`: the action names of `btnIcon()` (several = a combo, joined with "+"); `label`: a text button (L1/R1).
const CONTROLS_HELP = [
    {
        titleKey: 'help.home',
        rows: [
            { keys: ['confirm'], textKey: 'help.launch' },
            { keys: ['alt'], textKey: 'help.cardMenu' },
            { keys: ['menu'], textKey: 'help.gamesPanel' },
            // The hold time is the "TV-mode exit time" setting (renderer/gamepad.js `circleHoldMs`).
            { keys: ['back'], textKey: 'help.backTvExit', params: () => ({ s: typeof circleHoldMs === 'number' ? circleHoldMs / 1000 : 5 }) },
            { keys: ['view'], textKey: 'help.settings' },
            { keys: ['start'], textKey: 'help.powerMenu' },
            { label: 'L1 / R1', textKey: 'help.volume' },
        ],
    },
    {
        titleKey: 'help.combos',
        rows: [
            { keys: ['home', 'back'], textKey: 'help.quit' },
            { keys: ['home', 'menu'], textKey: 'help.disconnect' },
            { keys: ['home', 'alt'], textKey: 'help.identify' },
        ],
    },
    {
        titleKey: 'help.games',
        rows: [
            { keys: ['confirm'], textKey: 'help.gamesLaunch' },
            { keys: ['menu'], textKey: 'help.gamesPin' },
            { keys: ['alt'], textKey: 'help.gamesFilter' },
            { label: 'L2 / R2', textKey: 'help.gamesCycle' },
            { keys: ['view'], textKey: 'help.gamesSearch' },
            { label: 'R3', textKey: 'help.gamesSort' },
            { keys: ['start'], textKey: 'help.gamesRefresh' },
        ],
    },
];

// The button part of a row: icon(s) as a combo with "+", or the text label.
function controlsHelpKeysHtml(row) {
    if (row.label) return `<span class="controls-help-label">${esc(row.label)}</span>`;
    return row.keys.map((k) => btnIcon(k)).join('<span class="controls-help-plus">+</span>');
}

// The wizard's compact grid: one column per section, without focus (nothing to choose).
function controlsHelpGridHtml() {
    return `<div class="controls-help">${CONTROLS_HELP.map((sec) => `
        <div class="controls-help-section">
            <div class="settings-subhead">${esc(tr(sec.titleKey))}</div>
            ${sec.rows.map((r) => `
                <div class="controls-help-row">
                    <span class="controls-help-keys">${controlsHelpKeysHtml(r)}</span>
                    <span class="controls-help-text">${esc(tr(r.textKey, r.params ? r.params() : undefined))}</span>
                </div>`).join('')}
        </div>`).join('')}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
    Object.assign(module.exports, { CONTROLS_HELP });
}
