#!/usr/bin/env node
/*
 * tests/test_gate_stats.js -- the front door's daily usage line.
 *
 * Starts server/gate.js with GATE_STATS_SECONDS=1 and a fake game server (a
 * plain TCP listener, so a game WebSocket can be opened through the gate), then:
 *   1  two sessions, one refused /play request and one game connection show up
 *      as "gate stats <date> sessions=2 refused=1 plays=1 peak=1"
 *   2  SIGTERM prints the totals once more
 *   3  no line the gate prints contains anything that looks like an IP address
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GATE = 21900 + (process.pid % 500), FTE = GATE + 1;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (c, what, d) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${what}` + (c || !d ? '' : `\n       ${d}`)); if (!c) failed++; };

function req(method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: GATE, path: p, method,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) }, (res) => {
      res.resume(); res.on('end', () => resolve(res));
    });
    r.on('error', () => resolve(null));
    r.end(method === 'POST' ? '{}' : undefined);
  });
}

(async () => {
  const fake = net.createServer((s) => s.on('error', () => {})).listen(FTE, '127.0.0.1');
  let out = '';
  const g = spawn('node', [path.join(ROOT, 'server/gate.js')], { cwd: ROOT,
    env: Object.assign({}, process.env, { GATE_PORT: String(GATE), GATE_HOST: '127.0.0.1',
      FTE_PORT: String(FTE), GATE_ROOT: path.join(ROOT, 'web'), GATE_SECRET: 'test-secret',
      GATE_STATS_SECONDS: '1' }) });
  g.stdout.on('data', d => { out += d; });
  g.stderr.on('data', d => { out += d; });
  try {
    for (let i = 0; i < 50 && !/gate listening/.test(out); i++) await sleep(100);
    const a = await req('POST', '/api/session');
    const b = await req('POST', '/api/session');
    const cookie = (b && b.headers['set-cookie'] || [''])[0].split(';')[0];
    await req('GET', '/play/index.html');                       // no cookie: refused
    // one game connection through the gate, with the session cookie
    const ws = net.connect(GATE, '127.0.0.1', () => ws.write(
      'GET /play/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
      `Cookie: ${cookie}\r\n\r\n`));
    ws.on('error', () => {});
    await sleep(2500);
    const lines = out.split('\n').filter(l => l.startsWith('gate stats '));
    const lastLine = lines[lines.length - 1] || '';
    check(a && b && a.statusCode === 200 && b.statusCode === 200, 'two sessions were issued');
    check(/^gate stats \d{4}-\d{2}-\d{2} sessions=2 refused=1 plays=1 peak=1$/.test(lastLine),
          `the hourly line counts them (${lastLine || 'no stats line'})`);
    ws.destroy();
    g.kill('SIGTERM');
    for (let i = 0; i < 30 && g.exitCode === null; i++) await sleep(100);
    const after = out.split('\n').filter(l => l.startsWith('gate stats ')).length;
    check(after > lines.length, 'SIGTERM prints the totals once more');
    const ipish = out.split('\n').filter(l => /\b\d{1,3}(\.\d{1,3}){3}\b/.test(l) && !/^ {2}(fte|root)/.test(l) && !/gate listening/.test(l));
    check(ipish.length === 0, 'no line printed by the gate carries an IP address', ipish.slice(0, 3).join(' | '));
  } finally {
    try { g.kill('SIGKILL'); } catch (e) {}
    fake.close();
  }
  console.log(failed ? `FAIL: ${failed}` : 'PASS: 4 checks');
  process.exit(failed ? 1 : 0);
})();
