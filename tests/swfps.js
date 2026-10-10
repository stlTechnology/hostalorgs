#!/usr/bin/env node
'use strict';
/* M6 requirement row (PROJECT.md "Requirements"):
 *
 *   | Frame rate | >= 60 fps at 1080p on integrated graphics, measured with
 *                | FTE's showfps; >= 30 fps under SwiftShader at 800x600, as a
 *                | CI sanity floor.                                        |
 *
 * This script measures the SwiftShader floor: one headless chrome at
 * 800x600, --use-gl=swiftshader, connected to our dedicated server and
 * WALKING (a stalled scene is not a frame-rate measurement), with a
 * requestAnimationFrame counter installed in the page and counted over 10 s.
 *
 * WHY A rAF COUNT AND NOT showfps'S DRAWN NUMBER: the glue (ftewebgl.js)
 * exports no JS-callable engine console -- grep finds no ccall/Cmd_ entry
 * point -- so `showfps 1` can only be set through the page's own Module
 * arguments, and its output is drawn GL text, which this harness cannot read
 * without OCR. What the counter counts is every frame the engine PRESENTS:
 * FTE's emscripten main loop renders inside the rAF callback, so a callback
 * that completes is a delivered frame, and callbacks/second IS the frame
 * rate the compositor saw. If the engine one day exposes the counter's
 * value to JS, reading it here instead is a one-line change.
 *
 * The >= 60 fps on real integrated graphics half of the row is NOT
 * measurable on this box (no such GPU in CI); it stays with the owner
 * play-test. Only the 30 fps floor is asserted here, which is what
 * PROJECT.md says the CI floor is for.
 *
 * Run: tests/swfps.sh. Not a check_all row: a measurement, like walk_all,
 * load16 and loadtime.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const SHOTS = path.join(ROOT, 'screens');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const SECONDS = parseInt(arg('--seconds', '10'), 10);
const RUN = path.join(os.tmpdir(), `qwtf-swfps-${process.pid}`);
const LOG = path.join(RUN, 'server.log');

/* --- ports: the walk suite's claim discipline (tests/walk_routes.js) ------- */
const PORTS_DIR = '/tmp/qwtf-walk-ports';
const CLAIMED = [];
function claimReleaseSync() {
  for (const f of CLAIMED) { try { fs.unlinkSync(f); } catch (e) {} }
  CLAIMED.length = 0;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function claimPortFile(p) {
  fs.mkdirSync(PORTS_DIR, { recursive: true });
  const f = path.join(PORTS_DIR, String(p));
  let fd;
  try {
    fd = fs.openSync(f, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') return null;
    try {
      const st = fs.statSync(f);
      const holder = parseInt(fs.readFileSync(f, 'utf8'), 10) || 0;
      if (holder === process.pid ||
          (!pidAlive(holder) && Date.now() - st.mtimeMs > 60000)) {
        fs.unlinkSync(f);
        fd = fs.openSync(f, 'wx');
      } else return null;
    } catch (e2) { return null; }
  }
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  return f;
}
function takePort(start) {
  return new Promise((resolve, reject) => {
    const attempt = (p) => {
      if (p > 65000) return reject(new Error('no free port above ' + start));
      const f = claimPortFile(p);
      if (!f) return attempt(p + 1);
      const srv = net.createServer();
      const bail = () => { try { fs.unlinkSync(f); } catch (e) {} attempt(p + 1); };
      srv.once('error', bail);
      srv.listen(p, '127.0.0.1', () => {
        srv.close(() => { CLAIMED.push(f); resolve(p); });
      });
    };
    attempt(start);
  });
}
function waitListening(port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const once = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - t0 > (timeoutMs || 30000)) return resolve(false);
        setTimeout(once, 250);
      });
    };
    once();
  });
}

/* --- every process this run spawns, killed on every exit path (0359) -------- */
const SPAWNED = new Set();
function track(p) { SPAWNED.add(p.pid); }
function reapSync() {
  for (const pid of SPAWNED) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
  }
  SPAWNED.clear();
  claimReleaseSync();
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', reapSync);
process.on('SIGINT', () => { reapSync(); process.exit(130); });
process.on('SIGTERM', () => { reapSync(); process.exit(143); });
process.on('uncaughtException', (e) => {
  console.error('harness error: ' + (e && e.stack || e));
  reapSync();
  process.exit(3);
});

let passed = 0, failed = 0;
const ok = (what) => { console.log(`  ok   ${what}`); passed++; };
const bad = (what, detail) => {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${String(detail).replace(/^/gm, '       ')}`);
  failed++;
};
const check = (c, what, detail) => (c ? ok(what) : bad(what, detail));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sh = (cmd, args, opts) =>
  spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));

class Server {
  constructor(port) { this.port = port; }
  async start() {
    fs.mkdirSync(RUN, { recursive: true });
    const stage = path.join(RUN, 'gamedir');
    fs.mkdirSync(stage, { recursive: true });
    for (const e of fs.readdirSync(WEB)) {
      if (e === 'id1') continue;
      fs.symlinkSync(path.join(WEB, e), path.join(stage, e));
    }
    fs.mkdirSync(path.join(stage, 'id1'), { recursive: true });
    for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
      fs.symlinkSync(path.join(WEB, 'id1', e), path.join(stage, 'id1', e));
    }
    this.out = fs.openSync(LOG, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', stage,
      '--map', 'forts',
      '+set', 'maxclients', '2',
      '+set', 'developer', '1',
      '+set', 'qwtf_trace', '1',
      '+serverinfo', 'qwtf_trace', '1',
    ], { cwd: ROOT, stdio: ['pipe', this.out, 'pipe'], detached: true });
    track(this.proc);
    for (let i = 0; i < 200; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(fs.readFileSync(LOG, 'utf8'))) return true;
      if (this.proc.exitCode !== null) break;
    }
    return false;
  }
  command(c) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(c + '\n');
  }
  async status() {
    const before = fs.statSync(LOG).size;
    this.command('status');
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const chunk = readFrom(before);
      if (/frags\s+userid\s+address\s+name/i.test(chunk)) {
        await sleep(300);
        return readFrom(before);
      }
    }
    return readFrom(before);
  }
  stop() {
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { fs.closeSync(this.out); } catch (e) {}
  }
}
function readFrom(off) {
  const buf = Buffer.alloc(fs.statSync(LOG).size - off);
  const fd = fs.openSync(LOG, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, off); } finally { fs.closeSync(fd); }
  return buf.toString('utf8');
}
function logAll() { return fs.readFileSync(LOG, 'utf8'); }
function tableRows(statusText) {
  const lines = statusText.split('\n');
  const dash = lines.findIndex(l => /^\s*-+(\s+-+)+\s*$/.test(l));
  if (dash < 0) return [];
  const out = [];
  for (let i = dash + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) break;
    out.push(l);
  }
  return out;
}

class Client {
  constructor(cdp, stderrPath) {
    this.cdp = cdp; this.nextId = 1; this.pending = new Map();
    this.console = []; this.errors = [];
    this.stderrPath = stderrPath;
  }
  async start(profile, url) {
    this.profile = profile;
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.cdp}`,
      `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=800,600', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', fs.openSync(this.stderrPath, 'w')],
         detached: true });
    track(this.proc);
    let info = null;
    for (let i = 0; i < 150; i++) {
      const r = sh('curl', ['-s', `http://127.0.0.1:${this.cdp}/json/list`]);
      if (r.status === 0) {
        try {
          info = JSON.parse(r.stdout).find(t => t.type === 'page');
          if (info) break;
        } catch (e) {}
      }
      await sleep(200);
    }
    if (!info) throw new Error('no Chrome debugging target');
    const WS = require('./cdp.js');
    this.ws = await WS.connect(info.webSocketDebuggerUrl, m => this.onMessage(m));
    this.ws.on('close', () => {
      if (this.dead) return;
      this.dead = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      this.console.push((m.params.args || []).map(a =>
        a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      this.errors.push(d.exception ? (d.exception.description || d.text) : d.text);
    }
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }
  async eval(expr) {
    try {
      const r = await this.send('Runtime.evaluate',
        { expression: expr, returnByValue: true });
      return r && r.result ? r.result.value : null;
    } catch (e) { return null; }
  }
  async clickCanvas() {
    await this.send('Page.bringToFront').catch(() => {});
    const c = await this.eval(`(() => { const c = document.getElementById('canvas');
      if (!c) return null; const b = c.getBoundingClientRect();
      return { x: b.left + b.width/2, y: c ? c.getBoundingClientRect().top + c.getBoundingClientRect().height/2 : 0 }; })()`);
    if (!c) throw new Error('no canvas on the page');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    }
  }
  async pressForward() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'w', code: 'KeyW',
      windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
    });
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
  }
}

async function main() {
  console.log(`swfps: SwiftShader frame rate at 800x600, counted over ${SECONDS}s while walking`);
  const svPort = await takePort(20000 + (process.pid % 12000));
  const httpPort = await takePort(svPort + 1);
  const cdpPort = await takePort(svPort + 2);
  console.log(`  ports claimed: game ${svPort}, static ${httpPort} (run dir ${RUN})`);

  const server = new Server(svPort);
  if (!await server.start()) {
    bad('the dedicated server initialised',
      fs.existsSync(LOG) ? logAll().slice(-800) : '(no server log)');
    return 1;
  }
  const serve = spawn('node', [path.join(ROOT, 'tools/serve.js'),
    '--port', String(httpPort), '--root', 'web'],
    { cwd: ROOT, stdio: ['ignore', fs.openSync(path.join(RUN, 'serve.log'), 'w'), 'ignore'],
      detached: true });
  track(serve);
  if (!await waitListening(httpPort, 30000)) {
    bad('the static server started on its port', `port ${httpPort}`);
    server.stop();
    return 1;
  }

  const client = new Client(cdpPort, path.join(RUN, 'chrome.stderr'));
  const url = `http://127.0.0.1:${httpPort}/index.html?server=` +
    encodeURIComponent(`ws://127.0.0.1:${svPort}`) + `&name=fps0`;
  try {
    await client.start(fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-fps-')), url);
  } catch (e) {
    bad('the client started', String(e.message || e));
    server.stop();
    return 1;
  }

  /* Spawned, server's own table. */
  const end = Date.now() + 30000;
  let spawned = false;
  while (Date.now() < end) {
    const st = await server.status();
    if (tableRows(st).some(r => r.includes('fps0'))) { spawned = true; break; }
    await sleep(400);
  }
  check(spawned, 'the client spawned (the server\'s own table lists it)');
  if (!spawned) {
    client.stop(); server.stop();
    return 1;
  }

  /* Walking: pointer lock, hold forward, and confirm movement from the
   * server's own position trail -- a stalled scene renders nothing new and
   * would flatter the number. */
  await client.clickCanvas();
  await client.pressForward();
  const moveEnd = Date.now() + 15000;
  let moved = false;
  while (Date.now() < moveEnd) {
    const re = /QWTFPOS \[fps0\] (\S+) (\S+) (\S+)/g;
    const txt = logAll();
    const ps = [];
    let m;
    while ((m = re.exec(txt)) !== null) ps.push([+m[1], +m[2], +m[3]]);
    if (ps.length >= 2) {
      const a = ps[0], b = ps[ps.length - 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 16) { moved = true; break; }
    }
    if (Date.now() - moveEnd > 0 && (ps.length < 2 ||
        Math.hypot(ps[ps.length - 1][0] - ps[0][0],
                   ps[ps.length - 1][1] - ps[0][1], 0) < 2)) {
      await client.pressForward();   // re-assert the press (latch churn)
    }
    await sleep(300);
  }
  check(moved, 'the player is moving (the server\'s own trail confirms it)');
  if (!moved) {
    client.stop(); server.stop();
    return 1;
  }

  /* The counter: installed in the page, settled 2 s, counted SECONDS. */
  await client.eval(`window.__raf = 0;
    (function loop(){ window.__raf++;
      requestAnimationFrame(loop); })();
    1`);
  await sleep(2000);
  await client.eval('window.__raf = 0; 1');
  await sleep(SECONDS * 1000);
  const frames = await client.eval('window.__raf');
  const fps = frames ? frames / SECONDS : 0;

  check(frames !== null, 'the in-page frame counter answered');
  check(fps >= 30,
    `SwiftShader 800x600, walking: ${fps.toFixed(1)} fps over ${SECONDS}s (>= 30 floor)`,
    `frames counted: ${frames}`);
  await client.screenshot(path.join(SHOTS, 'm6-fps.png'));
  ok(`screenshot for the record: screens/m6-fps.png`);

  client.stop();
  server.command('quit');
  await sleep(1000);
  server.stop();

  console.log(`\n${failed ? `FAIL: ${failed} of ${passed + failed} checks`
                          : `PASS: ${passed}/${passed + failed} checks`}`);
  return failed ? 1 : 0;
}

main().then(c => process.exit(c === 0 ? 0 : c || 1));