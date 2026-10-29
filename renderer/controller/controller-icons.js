// Controller type icons (inline SVG, currentColor) - a SHARED source of the Settings "Controllers" subview (settings-bt.js) AND the home
// screen controller badge (controller-status.js). Type: classifyController() (controller-id.js, shared with main) -> 'dualsense' |
// 'dualshock' | 'xbox' | 'generic'. The DualShock uses the DualSense icon (the PS symbol is the same).
// Load order: after controller-id.js, before controller-status.js + settings-bt.js.
const CONTROLLER_ICONS = {
    xbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M7.5 8.5 12 13l4.5-4.5M7.5 15.5 12 11l4.5 4.5" stroke-width="1.5"/></svg>',
    dualsense: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2.6 14 6h-4z"/><circle cx="18.4" cy="12" r="2.1"/><path d="M3.8 9.9 7.4 13.5M7.4 9.9 3.8 13.5"/><rect x="9.9" y="17.4" width="4.2" height="4.2" rx="0.5"/></svg>',
    generic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 8h10a4.5 4.5 0 0 1 4.43 3.7l1.02 5.6A2.2 2.2 0 0 1 19.1 19l-2-3.4H6.9L4.9 19a2.2 2.2 0 0 1-3.37-1.7l1.02-5.6A4.5 4.5 0 0 1 7 8Zm.5 2.2v1.6H5.9v1.6h1.6v1.6h1.6v-1.6h1.6v-1.6H9.1v-1.6zm9 .3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2m-2 2.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2"/></svg>',
};
CONTROLLER_ICONS.dualshock = CONTROLLER_ICONS.dualsense;
