// @ts-check
'use strict';

// Recognizing the BlueZ D-Bus "controller connected" event in `gdbus monitor --system --dest org.bluez` output. TESTED CONTRACT MIRROR:
// `bin/launchers-launcher-bt-trigger.sh` matches the same pattern with a bash `case` (the trigger runs early in boot with a minimal PATH).
// If BlueZ changes the signal format, `test/bluetooth/bt-trigger-parse.test.js` fails and BOTH places must be updated.
// No `electron` reference. Background: docs/dev/devices.md#bluetooth

// `gdbus monitor` prints a signal on ONE line. The line we care about (verified on the machine):
//   /org/bluez/hci0/dev_02_00_00_00_00_B2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.bluez.Device1', {'Connected': <true>}, @as [])
// The `.*` is for a property bundle (`{'Connected': <true>, 'ServicesResolved': <false>}`) — the `'Connected': <true>` literal is
// specific enough that another property's `<true>` does not match it.
const CONNECT_RE =
    /^\/org\/bluez\/[^/]+\/dev_([0-9A-Fa-f_]+):\s+org\.freedesktop\.DBus\.Properties\.PropertiesChanged\s+\('org\.bluez\.Device1',.*'Connected':\s*<true>/;

// `AA:BB:CC:DD:EE:FF` MAC (uppercase) from the `dev_AA_BB_CC_DD_EE_FF` segment.
function macFromDevSegment(seg) {
    return String(seg).replace(/_/g, ':').toUpperCase();
}

// The connected device's MAC from a `gdbus monitor` line if it is a "Connected: true" PropertiesChanged signal on the
// `org.bluez.Device1` interface — otherwise `null` (Disconnected, RSSI change, `<false>`, header lines, other objects).
function parseConnectEvent(line) {
    if (typeof line !== 'string') return null;
    const m = line.match(CONNECT_RE);
    return m ? macFromDevSegment(m[1]) : null;
}

module.exports = { parseConnectEvent, macFromDevSegment, CONNECT_RE };
