#!/usr/bin/env node
'use strict';
/* M6 requirement rows (PROJECT.md "Requirements"):
 *
 *   | Time to play    | Cold cache, LAN: URL opened -> controlling a player in
 *                     <= 10 s. Warm cache <= 3 s.                          |
 *   | Download size   | First load <= 8 MB gzipped in total (engine +
 *                     content). Content beyond that loads lazily.           |
 *
 * HOW IT MEASURES:
 *
 *   Cold / warm. A fresh chrome profile is the COLD case (no cache at all);
 *   the SAME profile navigating again is the WARM case (engine and content
 *   come from disk cache). The clock starts at Page.navigate and stops at the
 *   SERVER's own player table listing the client (spawned), then again at the
 *   server's own QWTFPOS trail showing the player MOVED under the held
 *   forward key -- "controlling a player", not merely connected. Both
 *   numbers are printed; the row is judged on the second (time-to-control),
 *   and the gap between them says how much of the cold budget the download
 *   is.
 *
 *   Download size. CDP's Network.loadingFinished reports encodedDataLength
 *   per response -- the bytes that actually crossed the wire, gzipped, which
 *   is exactly what the row names. Summed over the cold load and asserted
 *   <= 8 MB.
 *
 * Loopback, not LAN: the transfer itself is ~free here, so the cold number
 * UNDERSTATES a LAN load by the transfer time of whatever the cache misses.
 * That gap is why the download-size row exists next to this one; both are
 * reported together.
 *
 * Run: tests/loadtime.sh (flock wrapper). Not a check_all row: it is a
 * measurement, same relationship to the suite as walk_all/load16.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const RUNS = parseInt(arg('--runs', '3'), 10);
const RUN = path.join(os.tmpdir(), `qwtf-loadtime-${process.pid}`);
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

/* --- server: run_server.sh, stdin-driven, with the position probe on -------- */
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
      '+set', 'maxclients', '4',
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

/* --- one browser, CDP-driven, with network byte accounting ------------------ */
class Client {
  constructor(cdp, stderrPath) {
    this.cdp = cdp; this.nextId = 1; this.pending = new Map();
    this.console = []; this.errors = [];
    this.wire = new Map();   // requestId -> encodedDataLength
    this.urls = new Map();   // requestId -> url, for the size breakdown
    this.total = 0;          // sum of encodedDataLength, the gzipped bytes
    this.stderrPath = stderrPath;
  }
  async start(profile) {
    this.profile = profile;
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.cdp}`,
      `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=640,480', '--hide-scrollbars',
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
    /* A closed CDP socket must fail the pending calls NOW: otherwise a
     * browser that dies mid-command leaves every later call to hang until
     * its own timeout, which reads as a mystery hang (that is what the first
     * run of this suite did -- a 60 s Page.navigate timeout with no other
     * symptom). The chrome stderr file is the evidence side of the same
     * fix. */
    this.ws.on('close', () => {
      if (this.dead) return;
      this.dead = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP connection closed (chrome stderr: ' +
          this.stderrTail() + ')'));
      }
      this.pending.clear();
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
  }
  stderrTail() {
    try {
      return fs.readFileSync(this.stderrPath, 'utf8')
        .split('\n').filter(l => l.trim()).slice(-3).join(' | ').slice(0, 300);
    } catch (e) { return '(none)'; }
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
    } else if (m.method === 'Log.entryAdded') {
      if (m.params.entry.level === 'error') this.errors.push(m.params.entry.text);
    } else if (m.method === 'Network.responseReceived') {
      /* The URL per request, so the wire total can be broken down by file --
       * a red size row that says "11.60 MB" without naming the files is only
       * half a finding. */
      this.urls.set(m.params.requestId,
        (m.params.response && m.params.response.url) || '(unknown)');
    } else if (m.method === 'Network.loadingFinished') {
      /* encodedDataLength is what crossed the wire -- gzipped, exactly what
       * the <= 8 MB row names. Cached (warm) loads report length 0 here and
       * the warm sum therefore says what the WIRE saw, which is the point. */
      const n = m.params.encodedDataLength || 0;
      this.wire.set(m.params.requestId, n);
      this.total += n;
    }
  }
  breakdown() {
    const byUrl = new Map();
    for (const [id, n] of this.wire) {
      if (!n) continue;
      const u = this.urls.get(id) || '(unknown)';
      byUrl.set(u, (byUrl.get(u) || 0) + n);
    }
    return [...byUrl.entries()].sort((a, b) => b[1] - a[1]);
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
  async navigate(url) {
    this.total = 0;
    this.wire.clear();
    this.t0 = Date.now();
    await this.send('Page.navigate', { url });
  }
  /* Pointer lock + held forward key (walk_routes' proven moves). */
  async clickCanvas() {
    await this.send('Page.bringToFront').catch(() => {});
    const c = await this.eval(`(() => { const c = document.getElementById('canvas');
      if (!c) return null; const b = c.getBoundingClientRect();
      return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
    if (!c) throw new Error('no canvas on the page');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    }
  }
  /* One press, no sleeps: the key is pressed AFTER the server's table has
   * listed the player (spawned), which is the only case walk_routes' 4x400 ms
   * repeat defends against (FTE drops a keydown that arrives before spawn).
   * Sleeping in the measured path would be measuring the harness. If the
   * first press did not latch, press again -- that latency is honestly
   * inside the control time. */
  async pressForward() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'w', code: 'KeyW',
      windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
    });
  }
  async release() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87,
      nativeVirtualKeyCode: 87,
    });
  }
  stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
  }
}

/* The server's own position trail for one name (probe.qc, 4 Hz). */
function positions(name) {
  const txt = logAll();
  const re = new RegExp(`QWTFPOS \\[${name}\\] (\\S+) (\\S+) (\\S+)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(txt)) !== null) out.push([+m[1], +m[2], +m[3]]);
  return out;
}

/* One cold+warm pair. Returns { coldSpawn, coldControl, coldBytes,
 * warmSpawn, warmControl, warmBytes } in ms / bytes, or an error that names
 * itself.
 *
 * ONE LOAD PER BROWSER. The first version reused the browser for the warm
 * reload, and every second Page.navigate timed out at 60 s with the socket
 * alive: a target already running FTE's main loop under SwiftShader never
 * answers CDP again -- the protocol is served on the renderer's main thread
 * the engine is saturating. Every harness in this repo (mp_smoke, walk_routes)
 * already does one load per browser, for its own reasons; this is the same
 * rule with its reason. Warm is still the SAME PROFILE -- a fresh browser on
 * the same user-data-dir shares the disk cache, which is what "warm" means. */
async function navigateWithRetry(client, url, what) {
  try {
    await client.navigate(url);
  } catch (e) {
    if (client.dead) throw e;
    console.log(`  retrying the first load (${what}: ${e.message})`);
    await client.navigate(url);
  }
}
async function onePair(server, newClient, profile, name, svPort, httpPort) {
  const res = {};
  const url = `http://127.0.0.1:${httpPort}/index.html?server=` +
    encodeURIComponent(`ws://127.0.0.1:${svPort}`) + `&name=${name}`;

  const waitForSpawn = async (client, budget) => {
    const end = Date.now() + budget;
    while (Date.now() < end) {
      const st = await server.status();
      if (tableRows(st).some(r => r.includes(name))) {
        return Date.now() - client.t0;
      }
      await sleep(300);
    }
    return null;
  };
  const waitForControl = async (client, who, budget) => {
    const end = Date.now() + budget;
    let lastPress = Date.now(), presses = 1;
    while (Date.now() < end) {
      const p = positions(who);
      if (p.length >= 2) {
        const a = p[0], b = p[p.length - 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 16) {
          return Date.now() - client.t0;
        }
      }
      if (Date.now() - lastPress > 2000 && presses < 4) {
        // The press did not latch (focus churn between headless pages);
        // re-assert it rather than measure a spectator.
        await client.pressForward();
        lastPress = Date.now();
        presses++;
      }
      await sleep(200);
    }
    return null;
  };
  const driveLoad = async (client, who, what) => {
    await navigateWithRetry(client, url.replace(name, who), what);
    const spawned = await waitForSpawn(client, 30000);
    if (spawned === null) {
      throw new Error(`${what}: the server never listed ${who}\n` +
        client.console.slice(-8).join(' | '));
    }
    await client.clickCanvas();
    await client.pressForward();
    const controlled = await waitForControl(client, who, 30000);
    const bytes = client.total;
    await client.release();
    return { spawned, controlled, bytes, presses: undefined };
  };

  /* COLD: a fresh profile is the COLD case (no cache at all). */
  let cold = null, warm = null;
  let c = newClient();
  try {
    await c.start(profile);
    cold = await driveLoad(c, name, 'cold');
  } catch (e) { res.error = String(e.message || e); c.stop(); return res; }
  res.coldFiles = c.breakdown();   // the size red must name its files
  c.stop();
  await sleep(1000);   // the old browser lets go of its profile

  /* WARM: same profile (same disk cache), fresh browser. */
  const warmName = name + 'w';
  c = newClient();
  try {
    await c.start(profile);
    warm = await driveLoad(c, warmName, 'warm');
  } catch (e) { res.error = String(e.message || e); c.stop(); return res; }
  c.stop();
  await sleep(1000);

  res.coldSpawn = cold.spawned;
  res.coldControl = cold.controlled;
  res.coldBytes = cold.bytes;
  res.warmSpawn = warm.spawned;
  res.warmControl = warm.controlled;
  res.warmBytes = warm.bytes;
  return res;
}

async function main() {
  console.log(`loadtime: cold/warm time-to-play and gzipped first-load size, ${RUNS} run(s)`);
  const svPort = await takePort(20000 + (process.pid % 12000));
  const httpPort = await takePort(svPort + 1);
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
  ok('server and static server up');

  /* One browser per load (see onePair): every launch takes a fresh CDP port
   * so nothing races a dying browser for the port, and each gets its own
   * stderr file so a dead browser says why. */
  let cdpSeed = svPort + 2;
  let stderrSeed = 0;
  const newClient = () => new Client(cdpSeed++,
    path.join(RUN, `chrome-${stderrSeed++}.stderr`));

  const pairs = [];
  for (let i = 0; i < RUNS; i++) {
    const name = `t${i}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-time-'));
    const r = await onePair(server, newClient, profile, name, svPort, httpPort);
    if (r.error) {
      bad(`run ${i + 1}/${RUNS}: cold+warm pair completed`, r.error);
      continue;
    }
    pairs.push(r);
    const ms = v => v === null ? 'never' : `${(v / 1000).toFixed(1)}s`;
    console.log(`  run ${i + 1}: cold spawn ${ms(r.coldSpawn)}, ` +
      `cold control ${ms(r.coldControl)}, wire ${(r.coldBytes / 1048576).toFixed(2)} MB | ` +
      `warm spawn ${ms(r.warmSpawn)}, warm control ${ms(r.warmControl)}, ` +
      `wire ${(r.warmBytes / 1024).toFixed(0)} KB`);
    if (r.coldFiles && (r.coldBytes > 8 * 1048576 || process.env.QWTF_LOADTIME_DUMP)) {
      const list = process.env.QWTF_LOADTIME_DUMP ? r.coldFiles : r.coldFiles.slice(0, 6);
      for (const [u, n] of list) {
        console.log(`      ${(n / 1048576).toFixed(2)} MB  ` +
          u.replace(/^http:\/\/127\.0\.0\.1:\d+\//, '/'));
      }
      if (!process.env.QWTF_LOADTIME_DUMP) {
        const rest = r.coldFiles.slice(6).reduce((s, e) => s + e[1], 0);
        if (rest > 0) console.log(`      ${(rest / 1048576).toFixed(2)} MB  (${r.coldFiles.length - 6} more files)`);
      }
    }
  }

  /* The rows, judged on the worst pair seen (a median would let one slow
   * cold load hide inside three fast ones). */
  if (pairs.length) {
    const worstCold = Math.max(...pairs.map(p => p.coldControl));
    const worstWarm = Math.max(...pairs.map(p => p.warmControl));
    const worstBytes = Math.max(...pairs.map(p => p.coldBytes));
    const everNoControl = pairs.some(p => p.coldControl === null || p.warmControl === null);
    check(!everNoControl && worstCold <= 10000,
      `cold cache: controlling a player in ${(worstCold / 1000).toFixed(1)} s (<= 10 s)`,
      'per run: ' + pairs.map(p => (p.coldControl / 1000).toFixed(1)).join(', ') + ' s' +
      (everNoControl ? ' (a run never reached control)' : ''));
    check(!everNoControl && worstWarm <= 3000,
      `warm cache: controlling a player in ${(worstWarm / 1000).toFixed(2)} s (<= 3 s)`,
      'per run: ' + pairs.map(p => (p.warmControl / 1000).toFixed(2)).join(', ') + ' s');
    check(worstBytes <= 8 * 1048576,
      `first load on the wire: ${(worstBytes / 1048576).toFixed(2)} MB gzipped (<= 8 MB)`,
      'per run: ' + pairs.map(p => (p.coldBytes / 1048576).toFixed(2)).join(', ') + ' MB');
  } else {
    bad('at least one cold+warm pair completed', 'see the per-run failures above');
  }

  server.command('quit');
  await sleep(1000);
  server.stop();

  console.log(`\n${failed ? `FAIL: ${failed} of ${passed + failed} checks`
                          : `PASS: ${passed}/${passed + failed} checks`}`);
  return failed ? 1 : 0;
}

main().then(c => process.exit(c === 0 ? 0 : c || 1));