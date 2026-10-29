'use strict';

// lib/net.js — minimal file downloader (for the RetroArch top-3 covers). With a local http server
// (like the temp files of test/exec.test.js), no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/fs.js');
const http = require('http');
const { downloadFile } = require('../lib/net.js');

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

function tmpDest(name = 'out.png') {
    return path.join(tmpDir('gl-net-'), name);
}

test('downloadFile — 200: the whole body is written to the target path, true', async () => {
    const { server, base } = await startServer((req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('PNG-BYTES');
    });
    const dest = tmpDest();
    const ok = await downloadFile(`${base}/x.png`, dest);
    server.close();

    assert.equal(ok, true);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'PNG-BYTES');
});

test('downloadFile — creates a missing parent folder', async () => {
    const { server, base } = await startServer((req, res) => res.end('data'));
    const dest = path.join(tmpDir('gl-net-'), 'a', 'b', 'c.png');
    const ok = await downloadFile(`${base}/x`, dest);
    server.close();

    assert.equal(ok, true);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'data');
});

test('downloadFile — 404: false, no file is created', async () => {
    const { server, base } = await startServer((req, res) => {
        res.writeHead(404);
        res.end('nope');
    });
    const dest = tmpDest();
    const ok = await downloadFile(`${base}/missing.png`, dest);
    server.close();

    assert.equal(ok, false);
    assert.equal(fs.existsSync(dest), false);
});

test('downloadFile — follows a 302 redirect', async () => {
    let hits = 0;
    const { server, base } = await startServer((req, res) => {
        hits += 1;
        if (req.url === '/start') {
            res.writeHead(302, { location: `${base}/final` });
            res.end();
            return;
        }
        res.writeHead(200);
        res.end('redirected-body');
    });
    const dest = tmpDest();
    const ok = await downloadFile(`${base}/start`, dest);
    server.close();

    assert.equal(ok, true);
    assert.equal(hits, 2);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'redirected-body');
});

test('downloadFile — the redirect chain is limited, too deep -> false', async () => {
    const { server, base } = await startServer((req, res) => {
        res.writeHead(302, { location: `${base}/again` });
        res.end();
    });
    const dest = tmpDest();
    const ok = await downloadFile(`${base}/loop`, dest, { redirects: 2 });
    server.close();

    assert.equal(ok, false);
});

test('downloadFile — timeout: false (the server does not respond)', async () => {
    const { server, base } = await startServer(() => { /* never answers */ });
    const dest = tmpDest();
    const ok = await downloadFile(`${base}/hang`, dest, { timeoutMs: 60 });
    server.close();

    assert.equal(ok, false);
    assert.equal(fs.existsSync(dest), false);
});

test('downloadFile — aborts above maxBytes, false', async () => {
    const { server, base } = await startServer((req, res) => {
        res.writeHead(200);
        res.end('x'.repeat(5000));
    });
    const dest = tmpDest();
    const ok = await downloadFile(`${base}/big`, dest, { maxBytes: 100 });
    server.close();

    assert.equal(ok, false);
});

test('downloadFile — invalid URL: false, does not throw', async () => {
    assert.equal(await downloadFile('not-a-url', tmpDest()), false);
});

test('downloadFileDetailed — the status distinguishes a permanent miss (404) from a transient error', async () => {
    const { downloadFileDetailed } = require('../lib/net.js');
    const srv = await startServer((req, res) => {
        if (req.url === '/gone') { res.statusCode = 404; res.end('missing'); return; }
        if (req.url === '/moved') { res.statusCode = 302; res.setHeader('Location', '/gone'); res.end(); return; }
        res.statusCode = 200; res.end('ok');
    });
    try {
        assert.deepEqual(await downloadFileDetailed(`${srv.base}/ok`, tmpDest()), { ok: true, status: 200 });
        assert.deepEqual(await downloadFileDetailed(`${srv.base}/gone`, tmpDest()), { ok: false, status: 404 });
        assert.deepEqual(await downloadFileDetailed(`${srv.base}/moved`, tmpDest()), { ok: false, status: 404 });
        assert.deepEqual(await downloadFileDetailed('not a url', tmpDest()), { ok: false, status: 0 });
        assert.deepEqual(await downloadFileDetailed('http://127.0.0.1:1/x', tmpDest()), { ok: false, status: 0 });
    } finally {
        srv.server.close();
    }
});
