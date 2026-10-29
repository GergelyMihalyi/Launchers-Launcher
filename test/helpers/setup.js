'use strict';

// `npm test` PRELOADS this into every test process (`node --test --require ./test/helpers/setup.js`).
// It sets a fresh, empty temp `HOME` and clears the XDG variables (so they also fall back to
// defaults derived from the temp `HOME`) — so a test can NEVER write/read the machine's real
// `~/.config/launchers-launcher/` or `~/.local/share/launchers-launcher/` (e.g. the cover cache),
// and cannot depend on what is there. The temp folder is deleted at process exit.
//
// `--require` is also loaded into the tests' worker threads (e.g. lib/scan/scan-pool.js) — there
// we skip it: the worker gets a copy of the parent's (already temp) env, and the `exit` handler of a
// `terminate()`-ed worker does not run, so its temp folder would stay behind.

const { isMainThread } = require('worker_threads');
const { tmpDir } = require('./fs.js');

if (isMainThread) {
    process.env.HOME = tmpDir('gl-test-home-');
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
}
