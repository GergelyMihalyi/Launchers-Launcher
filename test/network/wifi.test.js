'use strict';

// lib/network/wifi.js — parsers of the `nmcli` terse output (on a sample recorded on the laptop) +
// the connect flow with a fake `exec` (no live nmcli). Key guard: the password must NEVER
// get into the log (the Log sub-view shows it on the UI too).

const test = require('node:test');
const assert = require('node:assert/strict');
const wifi = require('../../lib/network/wifi.js');

// `LC_ALL=C.UTF-8 nmcli -t -f ACTIVE,SSID,SIGNAL,SECURITY dev wifi list` (on the laptop)
// + manual cases: `:` in the SSID, hidden AP, open network, Enterprise, duplicate SSID.
const LIST = [
    'no:Router-a1b2c3-2.4GHz_EXT:100:WPA2',
    'yes:Router-a1b2c3-2.4GHz_5G_EXT:80:WPA2',
    'no:Router-a1b2c3-2.4GHz_5G_EXT:95:WPA2',
    'no:Café 2.4:35:WPA2 WPA3',
    'no:Cafe\\:Guest:60:',
    'no::70:WPA2',
    'no:Corp:50:WPA2 802.1X',
    'no:Open--:40:--',
    '',
].join('\n');

test('splitTerse — `\\:` and `\\\\` escape', () => {
    assert.deepEqual(wifi.splitTerse('no:a\\:b:10:'), ['no', 'a:b', '10', '']);
    assert.deepEqual(wifi.splitTerse('x\\\\y:z'), ['x\\y', 'z']);
});

test('parseWifiList — dedup, hidden dropped, active first, by signal', () => {
    const nets = wifi.parseWifiList(LIST);
    assert.deepEqual(nets.map((n) => n.ssid),
        ['Router-a1b2c3-2.4GHz_5G_EXT', 'Router-a1b2c3-2.4GHz_EXT', 'Cafe:Guest', 'Corp', 'Open--', 'Café 2.4']);
    const active = nets[0];
    assert.equal(active.active, true);
    assert.equal(active.signal, 80, 'for a duplicate SSID the ACTIVE AP wins, not the stronger one');
    const cafe = nets.find((n) => n.ssid === 'Cafe:Guest');
    assert.equal(cafe.secured, false);
    assert.equal(nets.find((n) => n.ssid === 'Open--').secured, false, '`--` = open');
    assert.equal(nets.find((n) => n.ssid === 'Corp').enterprise, true);
    assert.equal(nets.find((n) => n.ssid === 'Café 2.4').security, 'WPA2 WPA3');
});

test('parseWifiUuids + parseSavedSsids — profile name ≠ SSID', () => {
    const uuids = wifi.parseWifiUuids('f6f5:802-11-wireless\ne185:loopback\n');
    assert.deepEqual(uuids, ['f6f5']);
    const saved = wifi.parseSavedSsids([
        'connection.uuid:f6f5',
        '802-11-wireless.ssid:Router-a1b2c3-2.4GHz_5G_EXT',
        '',
        'connection.uuid:39c3',
        '802-11-wireless.ssid:Café Zoë: Crème',
        '',
    ].join('\n'));
    assert.deepEqual(saved.get('Router-a1b2c3-2.4GHz_5G_EXT'), ['f6f5']);
    assert.deepEqual(saved.get('Café Zoë: Crème'), ['39c3'], 'detailed view: every value after the first `:`');
});

test('validPassword / validSsid / classifyConnectError / redact', () => {
    assert.equal(wifi.validPassword(null), true);
    assert.equal(wifi.validPassword('1234567'), false);
    assert.equal(wifi.validPassword('12345678'), true);
    assert.equal(wifi.validPassword('a'.repeat(64)), true, '64 hex = raw PSK');
    assert.equal(wifi.validPassword('z'.repeat(64)), false);
    assert.equal(wifi.validSsid(''), false);
    assert.equal(wifi.validSsid('x'.repeat(33)), false);
    assert.equal(wifi.validSsid('ok\nno'), false);
    const E = (stderr, extra) => Object.assign(new Error('x'), { stderr }, extra);
    assert.equal(wifi.classifyConnectError(E('Error: Connection activation failed: Secrets were required, but not provided.')), 'badPassword');
    assert.equal(wifi.classifyConnectError(E('Error: No network with SSID \'X\' found.')), 'notFound');
    assert.equal(wifi.classifyConnectError(E('Error: Not authorized to control networking.')), 'denied');
    assert.equal(wifi.classifyConnectError(E('', { killed: true })), 'timeout');
    assert.equal(wifi.classifyConnectError(E('Error: something')), 'failed');
    assert.equal(wifi.redact('a secret b secret', 'secret'), 'a *** b ***');
});

// Fake nmcli: answers based on the command args; the `connect` branch is decided by `connectResult`.
function fakeNmcli({ list = LIST, saved = [], active = null, connectFails = null } = {}) {
    const calls = [];
    const state = { saved: [...saved], active };
    const exec = async (cmd, args) => {
        calls.push(args);
        const a = args.join(' ');
        if (a.includes('device wifi list')) return { stdout: list };
        if (a.includes('connection show --active')) return { stdout: state.active ? `${state.active}:802-11-wireless\n` : '' };
        if (a.startsWith('-t -f UUID,TYPE connection show')) return { stdout: state.saved.map((s) => `${s.uuid}:802-11-wireless`).join('\n') };
        if (a.includes('connection.uuid,802-11-wireless.ssid')) {
            return { stdout: state.saved.map((s) => `connection.uuid:${s.uuid}\n802-11-wireless.ssid:${s.ssid}\n`).join('\n') };
        }
        if (a.includes('device wifi connect') || a.includes('connection up')) {
            if (connectFails && !a.includes(`uuid ${active}`)) {
                if (a.includes('device wifi connect')) state.saved.push({ uuid: 'new-1', ssid: args[args.indexOf('connect') + 1] });
                state.active = null;
                // The real execFile error message contains the FULL command line (including the password).
                throw Object.assign(new Error(`Command failed: nmcli ${a}`), { stderr: connectFails });
            }
            state.active = active;
            return { stdout: '' };
        }
        if (a.startsWith('connection delete uuid')) {
            state.saved = state.saved.filter((s) => s.uuid !== args[3]);
            return { stdout: '' };
        }
        throw new Error('unexpected nmcli call: ' + a);
    };
    return { exec, calls, state };
}

test('connect — active network: no nmcli connect call', async () => {
    const f = fakeNmcli();
    const res = await wifi.createWifi({ exec: f.exec }).connect('Router-a1b2c3-2.4GHz_5G_EXT', null);
    assert.deepEqual(res, { ok: true, already: true, ssid: 'Router-a1b2c3-2.4GHz_5G_EXT' });
    assert.ok(!f.calls.some((a) => a.includes('connect') || a.includes('up')));
});

test('connect — password-protected, not saved, without a password → needPassword; Enterprise → unsupported', async () => {
    const w = wifi.createWifi({ exec: fakeNmcli().exec });
    assert.equal((await w.connect('Café 2.4', null)).errorKey, 'needPassword');
    assert.equal((await w.connect('Corp', 'password123')).errorKey, 'unsupported');
    assert.equal((await w.connect('No such', null)).errorKey, 'notFound');
    assert.equal((await w.connect('Café 2.4', 'short')).errorKey, 'badPasswordFormat');
});

test('connect — saved network without a password: `connection up uuid <saved>`', async () => {
    const f = fakeNmcli({ saved: [{ uuid: 'u-cafe', ssid: 'Café 2.4' }] });
    const res = await wifi.createWifi({ exec: f.exec }).connect('Café 2.4', null);
    assert.equal(res.ok, true);
    assert.ok(f.calls.some((a) => a.join(' ').endsWith('connection up uuid u-cafe')));
});

test('connect — wrong password: the password is NOT in the log, the new profile is deleted, the previous connection is restored', async () => {
    const secret = 'SuperSecret#42';
    const f = fakeNmcli({ active: 'u-prev', saved: [{ uuid: 'u-prev', ssid: 'Router-a1b2c3-2.4GHz_5G_EXT' }],
        connectFails: `Error: Connection activation failed: Secrets were required (${secret}).` });
    const logs = [];
    const res = await wifi.createWifi({ exec: f.exec, log: (m) => logs.push(m) }).connect('Café 2.4', secret);
    assert.deepEqual(res, { ok: false, errorKey: 'badPassword', ssid: 'Café 2.4' });
    assert.ok(logs.length > 0);
    for (const line of logs) assert.ok(!line.includes(secret), `password in the log: ${line}`);
    assert.ok(f.calls.some((a) => a.join(' ') === 'connection delete uuid new-1'), 'the broken new profile deleted');
    assert.ok(!f.calls.some((a) => a.join(' ') === 'connection delete uuid u-prev'), 'the existing profile stays');
    assert.ok(f.calls.some((a) => a.join(' ').endsWith('connection up uuid u-prev')), 'the previous connection back');
});

test('listNetworks — no device / radio off / saved marking', async () => {
    const mk = (status, radio) => async (cmd, args) => {
        const a = args.join(' ');
        if (a === '-t -f TYPE device status') return { stdout: status };
        if (a === 'radio wifi') return { stdout: radio };
        return fakeNmcli({ saved: [{ uuid: 'u1', ssid: 'Café 2.4' }] }).exec(cmd, args);
    };
    assert.deepEqual(await wifi.createWifi({ exec: mk('ethernet\nloopback\n', 'enabled\n') }).listNetworks(),
        { device: false, radio: false, items: [] });
    assert.deepEqual(await wifi.createWifi({ exec: mk('wifi\n', 'disabled\n') }).listNetworks(),
        { device: true, radio: false, items: [] });
    const res = await wifi.createWifi({ exec: mk('wifi\nethernet\n', 'enabled\n') }).listNetworks();
    assert.equal(res.items.find((n) => n.ssid === 'Café 2.4').saved, true);
    assert.equal(res.items.find((n) => n.ssid === 'Corp').saved, false);
});

// --- Hidden SSID + forget ---

test('connect hidden — no list check; `hidden yes` + password; the password is not in the log', async () => {
    const f = fakeNmcli();
    const logs = [];
    const res = await wifi.createWifi({ exec: f.exec, log: (m) => logs.push(m) }).connect('Secret', 'SuperSecret#42', { hidden: true });
    assert.deepEqual(res, { ok: true, ssid: 'Secret' });
    const call = f.calls.find((a) => a.includes('connect'));
    assert.ok(call.join(' ').endsWith('connect Secret password SuperSecret#42 hidden yes'));
    assert.ok(!f.calls.some((a) => a.join(' ').includes('device wifi list')), 'the hidden connect does not list');
    for (const line of logs) assert.ok(!line.includes('SuperSecret#42'));
});

test('connect hidden — works without a password (open) too; invalid SSID / short password rejected; after an error the new profile is deleted', async () => {
    const f = fakeNmcli();
    const w = wifi.createWifi({ exec: f.exec });
    assert.equal((await w.connect('Nyilt', null, { hidden: true })).ok, true);
    assert.ok(f.calls.find((a) => a.includes('connect')).join(' ').endsWith('connect Nyilt hidden yes'));
    assert.equal((await w.connect('', null, { hidden: true })).ok, false);
    assert.equal((await w.connect('Secret', 'short', { hidden: true })).errorKey, 'badPasswordFormat');
    const g = fakeNmcli({ connectFails: 'Error: Connection activation failed: Secrets were required.' });
    const bad = await wifi.createWifi({ exec: g.exec }).connect('Secret', 'JoJelszo123', { hidden: true });
    assert.equal(bad.errorKey, 'badPassword');
    assert.ok(g.calls.some((a) => a.join(' ') === 'connection delete uuid new-1'));
});

test('forget — every saved profile of the SSID is deleted; none saved → ok:false', async () => {
    const f = fakeNmcli({ saved: [{ uuid: 'u1', ssid: 'Haz' }, { uuid: 'u2', ssid: 'Haz' }, { uuid: 'u3', ssid: 'Mas' }] });
    const w = wifi.createWifi({ exec: f.exec });
    assert.deepEqual(await w.forget('Haz'), { ok: true, removed: 2 });
    assert.deepEqual(f.state.saved.map((s) => s.uuid), ['u3']);
    assert.deepEqual(await w.forget('Haz'), { ok: false, removed: 0 });
    assert.deepEqual(await w.forget(''), { ok: false, removed: 0 });
});

test('connect — the early rejections are logged too (SSID + reason, without a password)', async () => {
    const logs = [];
    const w = wifi.createWifi({ exec: fakeNmcli().exec, log: (m) => logs.push(m) });
    await w.connect('Café 2.4', 'short');
    await w.connect('No such', null);
    assert.ok(logs.some((l) => l.includes('Café 2.4') && l.includes('badPasswordFormat')), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('No such') && l.includes('notFound')), logs.join('\n'));
    assert.ok(!logs.join('\n').includes('short'));
});

test('listNetworks — `--rescan` mode: true → yes, \'no\' → no (cache), default → auto', async () => {
    const modes = [];
    const exec = async (cmd, args) => {
        const a = args.join(' ');
        if (a === '-t -f TYPE device status') return { stdout: 'wifi\n' };
        if (a === 'radio wifi') return { stdout: 'enabled\n' };
        if (a.includes('device wifi list')) modes.push(args[args.indexOf('--rescan') + 1]);
        return fakeNmcli().exec(cmd, args);
    };
    const w = wifi.createWifi({ exec });
    await w.listNetworks({ rescan: true });
    await w.listNetworks({ rescan: 'no' });
    await w.listNetworks();
    assert.deepEqual(modes, ['yes', 'no', 'auto']);
});
