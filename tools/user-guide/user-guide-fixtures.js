'use strict';

// Sample data for the user guide (docs/user-guide/) screenshots: the e2e fixtures
// (test/e2e/fixtures.js — the REAL response shapes of the main.js handlers) + made-up, "nice"
// game names and generated SVG covers, so the images do not show "Blaster Galaxy 17" + an empty
// cell. Every name is made up (no real game). The covers are written to a temporary folder
// (`coverDir`), and the renderer loads them via `file://`, as in production.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = require('../../test/e2e/fixtures.js');

const coverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-user-guide-covers-'));

// Deterministic "hash" → color pair for the cover (no Math.random — the images are reproducible).
function hue(s, salt) {
    let h = salt;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 2:3 portrait cover: gradient background + a geometric motif + the title.
function writeCover(id, title) {
    const h1 = hue(title, 7);
    const h2 = (h1 + 40 + hue(title, 3) % 80) % 360;
    const shape = hue(title, 11) % 3;
    const motif = [
        '<circle cx="200" cy="250" r="120" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="10"/>',
        '<polygon points="200,110 330,360 70,360" fill="#fff" fill-opacity=".18"/>',
        '<rect x="95" y="150" width="210" height="210" rx="24" transform="rotate(20 200 255)" fill="#fff" fill-opacity=".16"/>',
    ][shape];
    // Wrapped by word (lines ≤ 11 characters), the font size fitted to the longest line.
    const lines = [];
    for (const w of title.toUpperCase().split(' ')) {
        const last = lines[lines.length - 1];
        if (last && (last + ' ' + w).length <= 11) lines[lines.length - 1] = last + ' ' + w;
        else lines.push(w);
    }
    const size = Math.min(40, Math.floor(340 / (Math.max(...lines.map((l) => l.length)) * 0.68)));
    const text = lines.map((l, i) =>
        `<text x="200" y="${440 + i * size * 1.2}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${xmlEsc(l)}</text>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${h1},65%,42%)"/><stop offset="1" stop-color="hsl(${h2},70%,16%)"/></linearGradient></defs>
<rect width="400" height="600" fill="url(#g)"/>${motif}${text}</svg>`;
    const file = path.join(coverDir, `${id}.svg`);
    fs.writeFileSync(file, svg);
    return file;
}

const TITLES = [
    'Stardust Expedition', 'Neon Drift', 'The Last Lighthouse', 'Iron Bird', 'Crystal Cave',
    'Moonlight Courier', 'Pixel Knights', 'Deep Sea Rescue', 'Misty Valley', 'Rocket Garden',
    'Wind Tunnel', 'Shadow City', 'Legend of Fire Mountain', 'Robot Garden', 'Ice Age Rally',
    'Galactic Mail', 'Dragon Heart', 'Skyscraper Sprint', 'Treasure Island 2', 'Midnight Arcade',
    'Planet Hunter', 'Adventurer Club', 'Shield Wall', 'Secret Garden',
];

const steamGames = TITLES.slice(0, 16).map((name, i) => ({
    name, source: 'steam', appid: String(2000 + i), cover: writeCover(`steam-${i}`, name),
}));
const heroicGames = TITLES.slice(16).map((name, i) => ({
    name, source: i % 2 ? 'legendary' : 'gog', appName: `h${i}`, cover: writeCover(`heroic-${i}`, name),
}));

const recent = (g) => ({ key: `steam-game-${g.appid}`, name: g.name, cover: g.cover, kind: 'steam', params: { appid: g.appid } });

const launchers = base.launchers.map((l, i) => ({
    ...l,
    running: false,
    recentGames: i === 0 ? steamGames.slice(0, 3).map(recent) : [],
}));

// RetroArch: a smaller, made-up ROM set (so the system list is readable in the image) —
// adjective × noun pairs, so the ALL list does not repeat the same name.
const ADJ = ['Brave', 'Swift', 'Secret', 'Merry', 'Frosty', 'Golden', 'Silver', 'Hidden', 'Wild', 'Silent', 'Sky', 'Deep'];
const NOUN = ['Knight', 'Rocket', 'Castle', 'Dragon', 'Courier', 'Island', 'Labyrinth', 'Robot', 'Pirate', 'Champion'];
const retroName = (n) => `${ADJ[n % ADJ.length]} ${NOUN[Math.floor(n / ADJ.length) % NOUN.length]}${n >= ADJ.length * NOUN.length ? ' II' : ''}`;
const RETRO_SYSTEMS = ['Nintendo - Nintendo Entertainment System', 'Nintendo - Super Nintendo Entertainment System',
    'Sega - Mega Drive - Genesis', 'Sony - PlayStation'];
const RETRO_ALL = RETRO_SYSTEMS.map((system, s) => ({
    system,
    games: Array.from({ length: 24 + s * 6 }, (_, i) => {
        const n = s * 37 + i;
        return { label: retroName(n), path: `/roms/${s}/${i}.zip`, cover: null };
    }),
}));

const ok = (items) => ({ ok: true, items });
const lastPlayed = (d) => new Date(Date.UTC(2026, 8, d, 19, 30)).toISOString();

const INVOKE = {
    ...base.INVOKE,
    getLanguage: 'en',
    getLaunchers: launchers,
    getContinueGames: steamGames.slice(0, 3).map((g, i) => ({ ...recent(g), lastLaunchedAt: lastPlayed(27 - i) })),
    getFavoriteGames: [recent(steamGames[1])],
    listGames: ok([...steamGames, ...heroicGames]),
    listGamesRecent: ok(steamGames.slice(0, 3).map((g, i) => ({ ...recent(g), lastLaunchedAt: lastPlayed(27 - i) }))),
    listRetroarchSystems: ok(RETRO_ALL.map((g) => ({ system: g.system, count: g.games.length }))),
    listRetroarchAllGames: ok(RETRO_ALL),
    listRetroarchGames: ok(RETRO_ALL[0].games),
    listEmulatorGames: ({ source } = {}) => ({
        pcsx2: ok(TITLES.slice(4, 10).map((name, i) => ({ id: `SLUS-2${i}`, name, path: `/ps2/${i}.iso`, serial: `SLUS-2${i}`, cover: writeCover(`ps2-${i}`, name) }))),
        melonds: ok(TITLES.slice(10, 14).map((name, i) => ({ id: `NDS${i}`, name, path: `/nds/${i}.nds`, gamecode: `A${i}`, cover: writeCover(`nds-${i}`, name) }))),
    }[source] || ok([])),
    getGameDetails: {
        ok: true,
        launcher: { count: 12, totalMs: 14 * 3600000 + 20 * 60000, lastLaunchedAt: lastPlayed(27) },
        native: { playtimeMs: 21 * 3600000, lastPlayedAt: Date.UTC(2026, 8, 27, 19, 30), label: 'Steam' },
        file: null,
        cover: { override: null, suggestion: '~/Pictures/launchers-launcher/covers/steam/2000.png' },
    },
    getUsageStats: ok([
        { key: 'steam', kind: 'launcher', name: 'Steam', count: 42, totalMs: 61 * 3600000, lastSessionMs: 2 * 3600000, lastLaunchedAt: lastPlayed(27) },
        { key: 'retroarch', kind: 'launcher', name: 'RetroArch', count: 17, totalMs: 9 * 3600000, lastSessionMs: 40 * 60000, lastLaunchedAt: lastPlayed(24) },
    ]),
    listBtDevices: ok([
        { mac: 'AA:BB:CC:DD:EE:01', name: 'DualSense Wireless Controller', connected: true, battery: 80, type: 'dualsense' },
        { mac: 'AA:BB:CC:DD:EE:02', name: 'Xbox Wireless Controller', connected: false, battery: null, type: 'xbox' },
    ]),
    listWifi: { ok: true, device: true, radio: true, items: [
        { ssid: 'Home', signal: 82, active: true, security: 'WPA2', secured: true, enterprise: false, saved: true },
        { ssid: 'Living room 5G', signal: 64, active: false, security: 'WPA2 WPA3', secured: true, enterprise: false, saved: true },
        { ssid: 'Guest', signal: 35, active: false, security: '', secured: false, enterprise: false, saved: false },
    ] },
    listInstalledApps: ok([
        { key: 'flatpak:net.supertuxkart.SuperTuxKart', kind: 'flatpak', name: 'SuperTuxKart', appId: 'net.supertuxkart.SuperTuxKart', cmd: 'flatpak', args: ['run', 'net.supertuxkart.SuperTuxKart'], icon: null, known: false },
        { key: 'flatpak:tv.kodi.Kodi', kind: 'flatpak', name: 'Kodi', appId: 'tv.kodi.Kodi', cmd: 'flatpak', args: ['run', 'tv.kodi.Kodi'], icon: null, known: false },
        { key: 'desktop:vlc', kind: 'native', name: 'VLC', desktopId: 'vlc', cmd: 'vlc', args: [], icon: null, known: false },
    ]),
    listAudioSinks: ok([{ name: 'alsa_output.hdmi', description: 'HDMI / TV', isDefault: true }, { name: 'alsa_output.usb', description: 'USB headphones', isDefault: false }]),
    getSelftest: [{ cmd: 'pactl', ok: true }, { cmd: 'kscreen-doctor', ok: true }],
};

module.exports = { INVOKE, coverDir };
