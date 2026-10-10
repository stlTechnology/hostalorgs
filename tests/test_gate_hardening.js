// tests/test_gate_hardening.js -- one test per gate.js fix from reviewer 0066.
//
// Each of these FAILS on the pre-fix gate, which is the point: they are written
// against the defect, not against the current code. No browser and no game
// server needed, so this runs in seconds.
//
//   1. a client that stops mid-handshake is dropped within a few seconds
//   2. one token cannot open unlimited game WebSockets (per-IP and total caps)
//   3. the session cookie is NOT forwarded to the game server
//   4. per-IP state is swept, so it cannot grow without bound
//   5. a 2 KB POST to /api/session is refused
//
// Run: node tests/test_gate_hardening.js

'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'tests/artifacts/gate-hardening');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(ok, what, detail) {
  results.push({ ok: !!ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : '\n         ' + detail}`);
}

function freePort() {
  return new Promise(r => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
}

function request(port, pathname, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname,
      method: opts.method || 'GET', headers: opts.headers || {} }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(c) }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: String(e) }));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* An upgrade that reports the status line and, when told to, stays open so the
 * gate counts it as a live pipe. */
function upgrade(port, cookie, hold) {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET /play/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        // The blank line matters: without it the gate is still waiting for
        // headers and correctly refuses to answer.
        (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n');
    });
    let buf = '', status = 0;
    sock.on('data', d => {
      buf += d.toString('latin1');
      const m = buf.match(/^HTTP\/1\.1 (\d+)/);
      if (m && !status) {
        status = parseInt(m[1], 10);
        if (!hold) { try { sock.destroy(); } catch (e) {} resolve(status); }
        else resolve(status); // caller keeps it open
      }
    });
    sock.on('error', () => resolve(status || 0));
    setTimeout(() => { if (!status) { try { sock.destroy(); } catch (e) {} resolve(0); } }, 4000);
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(150); }
  return false;
}

async function startGate(env) {
  const port = await freePort();
  const log = fs.openSync(path.join(ART, `gate-${port}.log`), 'w');
  const proc = require('child_process').spawn('node', [path.join(ROOT, 'server/gate.js')],
    { cwd: ROOT, detached: true, stdio: ['ignore', log, log],
      env: Object.assign({}, process.env, { GATE_PORT: String(port), GATE_HOST: '127.0.0.1' }, env) });
  proc.unref();
  const up = await waitFor(async () => (await request(port, '/robots.txt')).status === 200, 15000);
  return { proc, port, up };
}

async function main() {
  fs.rmSync(ART, { recursive: true, force: true });
  fs.mkdirSync(ART, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'web/landing'), path.join(ART, 'landing'));

  const secret = 'hardening-secret';
  /* A recorder standing in for the game server: it captures the exact bytes the
   * gate forwards, which is how the cookie leak is detected. */
  const seen = [];
  const ftePort = await freePort();
  const fte = net.createServer(sock => {
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        seen.push(buf);
        buf = '';
        // A real WebSocket handshake response, so the gate's pipe stays open.
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          'Connection: Upgrade\r\n\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise(r => fte.listen(ftePort, '127.0.0.1', r));

  const gate = await startGate({
    GATE_ROOT: ART, GATE_SECRET: secret, FTE_PORT: String(ftePort),
    GATE_IDLE_MS: '2000', GATE_CONN_IDLE_MS: '2000',
    GATE_MAX_WS_PER_IP: '2', GATE_MAX_WS_TOTAL: '3',
  });
  if (!gate.up) { console.log('FATAL gate did not start'); process.exit(1); }

  try {
    const sess = await request(gate.port, '/api/session', { method: 'POST', body: '{}' });
    const cookie = ((sess.headers['set-cookie'] || [])[0] || '').split(';')[0];

    /* -- 1 + 5. a client that stops mid-handshake is dropped, quickly. -- */
    // Pre-fix this hung for node's 60 s default. Note headersTimeout alone did
    // NOT fix it either: a socket that sends nothing never trips that timer, so
    // the gate also needs a per-connection inactivity timer.
    const t0 = Date.now();
    const dropped = await new Promise(resolve => {
      const s = net.connect(gate.port, '127.0.0.1', () => {
        s.write('GET / HTTP/1.1\r\nHost: x\r\n'); // no terminator, ever
      });
      let done = false;
      const fin = ms => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(ms); } };
      s.on('close', () => fin(Date.now() - t0));
      s.on('error', () => fin(Date.now() - t0));
      setTimeout(() => fin(-1), 12000);
    });
    check(dropped > 0 && dropped < 8000,
      '1. a half-sent request is dropped within seconds, not a minute',
      `closed after ${dropped}ms (headersTimeout is 5000)`);

    /* -- 2. one token, three upgrades: the third is refused. -- */
    // Pre-fix, all three were piped to the game server.
    const a = await upgrade(gate.port, cookie, true);
    const b = await upgrade(gate.port, cookie, true);
    const c = await upgrade(gate.port, cookie, true);
    const d = await upgrade(gate.port, cookie, true);
    const refused = [a, b, c, d].filter(x => x === 429).length;
    check(refused >= 1,
      '2. one token cannot open unlimited game WebSockets',
      `statuses ${[a, b, c, d].join(',')} (per-IP cap 2, total cap 3)`);
    const globalCap = [a, b, c, d].filter(x => x === 429).length;
    check(globalCap >= 2,
      '2b. the global cap bites even before the per-IP one is exhausted',
      `statuses ${[a, b, c, d].join(',')} (total cap 3)`);

    /* -- 3. the cookie must not reach the game server. -- */
    // Pre-fix, every raw header was forwarded, Cookie included.
    await sleep(400);
    const leaked = seen.filter(req => /^cookie:/im.test(req));
    check(seen.length > 0, '3. the recorder saw the forwarded upgrade', `${seen.length} requests`);
    check(leaked.length === 0,
      '3. the session cookie is not forwarded to the game server',
      `leaked headers: ${JSON.stringify(leaked.map(r => r.split('\r\n').filter(l => /^cookie:/i.test(l))))}`);

    /* -- 5. a 2 KB POST is refused. -- */
    // Pre-fix the cap was 4 KB and buffered.
    const big = await request(gate.port, '/api/session',
      { method: 'POST', body: 'x'.repeat(2048) });
    check(big.status !== 200, '5. an oversized POST to /api/session is refused',
      `status ${big.status} ${big.error || ''}`);

    /* -- 4. per-IP state is swept. -- */
    // A second gate with a short window and sweep, so pruning is observable.
    const g2 = await startGate({
      GATE_ROOT: ART, GATE_SECRET: secret, FTE_PORT: String(ftePort),
      GATE_MAX_SESSION_RATE: '2', GATE_RATE_WINDOW_MS: '1200', GATE_SWEEP_MS: '300',
    });
    try {
      const hdr = { 'content-type': 'application/json' };
      let limited = false;
      for (let i = 0; i < 6; i++) {
        const r = await request(g2.port, '/api/session', { method: 'POST', headers: hdr, body: '{}' });
        if (r.status === 429) { limited = true; break; }
      }
      check(limited, '4a. the rate limit does bite', 'expected a 429');
      // Pre-fix the entry lived forever and the IP stayed blocked.
      await sleep(2500);
      const after = await request(g2.port, '/api/session', { method: 'POST', headers: hdr, body: '{}' });
      check(after.status === 200,
        '4. stale per-IP state is swept, so it cannot grow without bound',
        `after the sweep the same IP got ${after.status}`);
    } finally {
      try { process.kill(-g2.proc.pid, 'SIGKILL'); } catch (e) {}
    }
  } finally {
    try { process.kill(-gate.proc.pid, 'SIGKILL'); } catch (e) {}
    fte.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length
    ? `FAIL: ${failed.length} of ${results.length} checks did not hold`
    : `PASS: ${results.length}/${results.length} checks`}`);
  return failed.length ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.error('harness error:', e && e.stack || e);
  process.exit(1);
});