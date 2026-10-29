// @ts-check
'use strict';

// Minimal file downloader on the built-in `http`/`https` (zero dependencies) — for cover downloads.
// Best effort: EVERY error (404 / timeout / network / write) returns `false`, never throws. The write is
// atomic (temp file + rename), as in `lib/config.js`.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { DOWNLOAD_TIMEOUT_MS } = require('./timings.js');

const DEFAULT_TIMEOUT_MS = DOWNLOAD_TIMEOUT_MS; // lib/timings.js
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_REDIRECTS = 3;

// downloadFileDetailed(url, destPath, opts) -> Promise<{ ok, status }>
// `status` = the last HTTP status (after redirects), `0` = no HTTP response (network / timeout / invalid
// URL / write error). The negative cover cache uses it to tell a PERMANENT miss (404/410) from a transient
// error (see lib/launchers/shared/cover-miss-cache.js).
function downloadFileDetailed(url, destPath, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    const redirectsLeft = opts.redirects == null ? DEFAULT_REDIRECTS : opts.redirects;

    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (err) {
            resolve({ ok: false, status: 0 });
            return;
        }
        const lib = parsed.protocol === 'http:' ? http : https;

        let settled = false;
        let lastStatus = 0;
        const done = (val) => {
            if (settled) return;
            settled = true;
            resolve(typeof val === 'object' ? val : { ok: val, status: val ? 200 : lastStatus });
        };

        let req;
        try {
            req = lib.get(parsed, (res) => {
                const status = res.statusCode || 0;
                lastStatus = status;

                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) {
                        done(false);
                        return;
                    }
                    let next;
                    try {
                        next = new URL(res.headers.location, parsed).toString();
                    } catch (err) {
                        done(false);
                        return;
                    }
                    downloadFileDetailed(next, destPath, {
                        timeoutMs, maxBytes, redirects: redirectsLeft - 1,
                    }).then(done);
                    return;
                }

                if (status !== 200) {
                    res.resume();
                    done(false);
                    return;
                }

                const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
                let out;
                try {
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    out = fs.createWriteStream(tmp);
                } catch (err) {
                    res.resume();
                    done(false);
                    return;
                }

                let bytes = 0;
                const abort = () => {
                    req.destroy();
                    out.destroy();
                    fs.unlink(tmp, () => {});
                    done(false);
                };

                res.on('data', (chunk) => {
                    bytes += chunk.length;
                    if (bytes > maxBytes) abort();
                });
                res.on('error', abort);
                out.on('error', abort);
                res.pipe(out);
                out.on('finish', () => {
                    if (settled) return;
                    out.close(() => {
                        try {
                            fs.renameSync(tmp, destPath);
                            done(true);
                        } catch (err) {
                            fs.unlink(tmp, () => {});
                            done(false);
                        }
                    });
                });
            });
        } catch (err) {
            done(false);
            return;
        }

        // An interrupted (timeout / connection error) download is not a "permanent miss".
        req.on('error', () => { lastStatus = 0; done(false); });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    });
}

// downloadFile(url, destPath, { timeoutMs, maxBytes, redirects }) -> Promise<boolean>
// `true` only if the full body of a 200 response was written to `destPath`.
function downloadFile(url, destPath, opts = {}) {
    return downloadFileDetailed(url, destPath, opts).then((r) => r.ok);
}

module.exports = { downloadFile, downloadFileDetailed, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, DEFAULT_REDIRECTS };
