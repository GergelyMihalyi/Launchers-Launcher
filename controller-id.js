// @ts-check
/// <reference lib="dom" />
// Controller type (dualsense / dualshock / xbox / generic) — from ONE source.
//
// - main process:  require('./controller-id.js')  — from the Modalias + Name fields of `bluetoothctl info`
// - renderer:      <script src="controller-id.js"> — from the Gamepad API `pad.id` string
//
// Both inputs are a lowercase text blob that may contain:
//   * a compact USB id:      "usb:v054Cp0CE6d0100..."   (Modalias)
//   * a spaced id:           "... Vendor: 054c Product: 0ce6 ..."  (Chromium gamepad id)
//   * or just a name:        "Wireless Controller", "Xbox Wireless Controller", ...
//
// Vendor: 054c = Sony (PlayStation), 045e = Microsoft (Xbox).
// Product: 0ce6 = DualSense; every other Sony = DualShock 4 (09cc / 05c4).

(function (root) {
    function classifyController(text) {
        const s = String(text == null ? '' : text).toLowerCase();
        const vp = s.match(/v(?:endor)?[:\s]*([0-9a-f]{4}).*?p(?:roduct)?[:\s]*([0-9a-f]{4})/);
        const vendor = vp ? vp[1] : '';
        const product = vp ? vp[2] : '';
        const has = (...xs) => xs.some((x) => s.includes(x));

        if (vendor === '054c' || (!vendor && has('054c'))) {
            return (product === '0ce6' || has('0ce6', 'dualsense')) ? 'dualsense' : 'dualshock';
        }
        if (vendor === '045e' || has('045e', 'xbox', 'xinput')) return 'xbox';
        if (has('dualsense')) return 'dualsense';
        if (has('dualshock', 'playstation', 'wireless controller')) return 'dualshock';
        return 'generic';
    }

    // --- Button SYMBOLS per type (the WORD comes from the caller / tr()) ---
    // confirm / back / menu / alt follow the PHYSICAL position of the W3C standard mapping: confirm = buttons[0] (bottom), back = buttons[1] (right),
    // alt = buttons[2] (left), menu = buttons[3] (top) — A / B / X / Y on Xbox. The Nintendo A/B swap is a separate question: `classifyController`
    // does not return `nintendo` today, the `nintendo` row is forward-looking. `view`/`start` are the buttons[8]/[9] "system" pair
    // (PS Share/Create · Xbox View · Switch "−" / PS Options · Xbox Menu · Switch "+"); glyphs: ⧉ / ☰.
    const CONTROLLER_SYMBOLS = {
        playstation: { confirm: '✕', back: '○', menu: '△', alt: '□', home: 'PS', view: '⧉', start: '☰' },
        xbox: { confirm: 'A', back: 'B', menu: 'Y', alt: 'X', home: '❐', view: '⧉', start: '☰' },
        nintendo: { confirm: 'A', back: 'B', menu: 'X', alt: 'Y', home: '⌂', view: '－', start: '＋' },
        generic: { confirm: '①', back: '②', menu: '④', alt: '③', home: '≡', view: '⧉', start: '☰' },
    };

    // classifyController() result -> symbol set. Sony pads (dualsense/dualshock) get the PlayStation symbols.
    function controllerSymbols(type) {
        if (type === 'xbox') return CONTROLLER_SYMBOLS.xbox;
        if (type === 'nintendo') return CONTROLLER_SYMBOLS.nintendo;
        if (type === 'generic') return CONTROLLER_SYMBOLS.generic;
        return CONTROLLER_SYMBOLS.playstation;
    }

    root.classifyController = classifyController;
    root.controllerSymbols = controllerSymbols;
    root.CONTROLLER_SYMBOLS = CONTROLLER_SYMBOLS;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { classifyController, controllerSymbols, CONTROLLER_SYMBOLS };
    }
})(typeof window !== 'undefined' ? window : globalThis);
