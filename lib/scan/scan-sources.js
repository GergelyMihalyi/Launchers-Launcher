// @ts-check
'use strict';

// Table of the HEAVY library scans runnable in the worker thread (`scan-worker.js` + `scan-pool.js`): each is the launcher module's RAW
// (uncached) scan — the TTL cache stays in the main process, the worker is stateless (apart from the modules' own file-signature caches).
// A new heavy source: 1 row here (main's `workerScans` builds the TTL caches from it); arguments and result go through structured clone.
// The launcher modules are required LAZILY. Background: docs/dev/infrastructure.md#worker-thread-scans

/** @type {Record<string, (...args: any[]) => any>} */
const SCAN_SOURCES = {
    melonds: (configRoot, manualDirs) => require('../launchers/melonds-library.js').findInstalledGames(configRoot, manualDirs),
    ppsspp: (configRoot) => require('../launchers/ppsspp-library.js').findInstalledGames(configRoot),
    duckstation: (configRoot) => require('../launchers/duckstation-library.js').findInstalledGames(configRoot),
    // EVERY ROM-folder-walking emulator scanner goes here (a ROM folder on NFS would freeze the UI on the main process). The roots are
    // computed by main (by the added variant).
    pcsx2: (configRoot) => require('../launchers/pcsx2-library.js').findInstalledGames(configRoot),
    dolphin: (configRoot, cacheRoot) => require('../launchers/dolphin-library.js').findInstalledGames(configRoot, cacheRoot),
    cemu: (configRoot, dataRoot) => require('../launchers/cemu-library.js').findInstalledGames(configRoot, dataRoot),
    ryujinx: (configRoot) => require('../launchers/ryujinx-library.js').findInstalledGames(configRoot),
    // ROM folders of the flatpak emulators + realpath (lib/launchers/rom-access.js — the existence filter would block on NFS).
    romDirs: (id, ...args) => require('../launchers/rom-access.js').readRomDirs(id, args),
    retroAll: (retroarchRoot) => require('../launchers/retroarch-library.js').findAllGames(retroarchRoot),
};

/**
 * Runs a source synchronously (the shared core of the worker AND the in-process fallback).
 * @param {string} source
 * @param {any[]} args
 */
function runScan(source, args) {
    const fn = SCAN_SOURCES[source];
    if (!fn) throw new Error(`unknown scan source: ${source}`);
    return fn(...(Array.isArray(args) ? args : []));
}

module.exports = { SCAN_SOURCES, runScan };
