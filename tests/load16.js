#!/usr/bin/env node
'use strict';
/* M6 requirement rows (PROJECT.md "Requirements"):
 *
 *   | Players  | 16 concurrent players on one server without server frame-time
 *              spikes over 10 ms (the server runs at 72 Hz or more).        |
 *   | Network  | ... Each player uses <= 30 KB/s down.                       |
 *
 * HOW IT MEASURES -- all of it the server's own words, nothing inferred:
 *
 *   Frame time. FTE's `status` prints (sv_main.c, SV_Status_f):
 *       avg response time: X ms (Y max)
 *   where X = 1000*latched_active/latched_count and Y =
 *   1000*latched_maxresponse -- the WORST single server frame in the period,
 *   latched over SVSTATS_PERIOD = 10 s (server.h). Three reads spaced past
 *   that period cover >= 30 s of play and the assertion uses the worst Y.
 *   This figure exists in the build; nothing here patches or parses a debug
 *   overlay, so it is exactly what the owner's server would report.
 *
 *   Per-player down. `status` prints
 *       packets,bytes/sec: in: pi bi  out: po bo
 *   The game clients are the only traffic on this socket, so bo / players is
 *   the server's outbound bytes per player -- what PROJECT.md calls a
 *   player's "down". Asserted <= 30 KB/s.
 *
 *   Movement. A server with 16 parked clients does no work, so the load has
 *   to move. qwtf/probe.qc (qwtf_trace 1, developer 1) prints QWTFPOS per
 *   player at 4 Hz and steers every player toward the world serverinfo
 *   waypoint qwtf_wx/..., so ONE route drives all 16 at once and they
 *   collide with each other on the way -- which is the load. The test
 *   requires that the players' SERVER-SIDE positions actually changed.
 *
 * Run: tests/load16.sh (flock wrapper; the walk suite holds the same lock).
 * Nothing in check_all -- it is a measurement, not a per-commit check, and a
 * 16-browser run on every commit is a cost nobody signed up for. Same
 * relationship to the suite as walk_all.sh has.
 *
 * --pin-cores N-M pins the SERVER process to those cores (taskset -pc) and
 * leaves the 16 browsers wherever the scheduler puts them. The unpinned run
 * co-locates 16 SwiftShader renderers with the server, which no real
 * deployment does; the pinned run is the deployment model (a container's CPU
 * reservation) and the requirement is judged on it. The two are reported
 * side by side so the difference itself is evidence.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const MAPS = path.join(ROOT, 'maps', 'forts.map');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const NCLIENTS = parseInt(arg('--clients', '16'), 10);
const PIN = arg('--pin-cores', null);
/* The browser cores are the complement of the server's, hard-set for the one
 * shape this test uses (16-23). A different pin changes both sides here, in
 * the open, rather than silently. */
const BROWSER_CORES = PIN ? '0-15' : null;
const RUN = path.join(os.tmpdir(), `qwtf-load16-${process.pid}`);
const LOG = path.join(RUN, 'server.log');

/* --- ports: the walk suite's claim discipline, verbatim in shape ------------
 * (tests/walk_routes.js, 0434/0466): an O_EXCL claim file per port under
 * /tmp/qwtf-walk-ports, THEN a probe bind, the claim held until exit. A probe
 * alone leaves a TOCTOU window between close() and the real listener; a claim
 * file is the only thing that closes it. Range stays below
 * net.ipv4.ip_local_port_range (32768+). */
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

/* --- the server: run_server.sh, stdin-driven -------------------------------- */
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
    // maxclients goes through run_server.sh's EXTRA slot, which now sits
    // BEFORE +map -- FTE sizes the client table at map load, so a +set after
    // +map takes effect on the NEXT map and the 17th connect would be refused.
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', stage,
      '--map', 'forts',
      '+set', 'maxclients', String(NCLIENTS),
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
  /* status, read the way mp_smoke reads it: written to stdin AFTER init, the
   * chunk waited for until the player table header arrives. */
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
  /* The server's own CPU time (utime+stime, /proc/<pid>/stat, clock ticks).
   * A spike that is real frame WORK consumes CPU; a spike that is the OS
   * descheduling the server behind 16 SwiftShader renderers does not. This is
   * how the two get told apart, rather than by me asserting which one I have.
   * (run_server.sh execs fteqw-sv, so the bash pid IS the server's pid.) */
  cpuSeconds() {
    try {
      const st = fs.readFileSync(`/proc/${this.proc.pid}/stat`, 'utf8').split(' ');
      return (+st[13] + +st[14]) / 100;
    } catch (e) { return null; }
  }
}
function readFrom(off) {
  const buf = Buffer.alloc(fs.statSync(LOG).size - off);
  const fd = fs.openSync(LOG, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, off); } finally { fs.closeSync(fd); }
  return buf.toString('utf8');
}
function logAll() { return fs.readFileSync(LOG, 'utf8'); }

/* Player table rows: the lines after the dashes rule up to the first blank
 * line (mp_smoke's reader). */
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
/* "avg response time: 3 ms (9 max)" -- latched over SVSTATS_PERIOD (10 s). */
function responseMs(statusText) {
  const m = statusText.match(/avg response time:\s*(\d+)\s*ms\s*\((\d+)\s*max\)/);
  return m ? { avg: +m[1], max: +m[2] } : null;
}
/* "packets,bytes/sec: in: 3 1200  out: 5 9800" */
function outBytes(statusText) {
  const m = statusText.match(/packets,bytes\/sec:\s*in:\s*[\d.e+-]+\s+[\d.e+-]+\s+out:\s*[\d.e+-]+\s+([\d.e+-]+)/);
  return m ? +m[1] : null;
}

/* --- clients: the walk suite's browser, at load-test scale ------------------ */
class Client {
  constructor(name, cdp) {
    this.name = name; this.cdp = cdp;
    this.nextId = 1; this.pending = new Map();
    this.console = []; this.errors = [];
  }
  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-load-'));
    /* With --pin-cores the browsers are pinned OFF the server's cores, so the
     * pinned run measures the server on reserved capacity rather than sharing
     * a scheduler with its own load generators. */
    const chromeCmd = PIN ? 'taskset' : 'google-chrome';
    const chromeArgs = PIN ? ['-c', BROWSER_CORES, 'google-chrome'] : [];
    chromeArgs.push(
      '--headless=new', `--remote-debugging-port=${this.cdp}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=640,480', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank');
    this.proc = spawn(chromeCmd, chromeArgs,
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    if (!info) throw new Error(`${this.name}: no Chrome debugging target`);
    const WS = require('./cdp.js');
    this.ws = await WS.connect(info.webSocketDebuggerUrl, m => this.onMessage(m));
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 480; i++) {
      await sleep(250);
      if (await this.eval(`!!document.getElementById('canvas')`)) return true;
    }
    throw new Error(`${this.name}: no canvas on the page after 120s\n` +
      `  console tail: ${this.console.slice(-8).join(' | ') || '(nothing)'}`);
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
          reject(new Error(`${this.name} CDP timeout: ${method}`));
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
  /* Pointer lock and the held forward key: the walk suite's proven moves
   * (tests/walk_routes.js clickCanvas/hold). The server-side probe steers the
   * player's HEADING every frame; forward motion is the CLIENT's +forward, so
   * a headless client that never holds a key stands still and "16 idle
   * players" is not the load the requirement names. rawKeyDown, not keyDown:
   * FTE's web glue latches movement keys on the raw event, and the press is
   * repeated because a keydown that arrives before the player has spawned is
   * dropped. keyUp is never sent until the measurement is over. */
  async clickCanvas() {
    await this.send('Page.bringToFront').catch(() => {});
    const c = await this.eval(`(() => { const c = document.getElementById('canvas');
      if (!c) return null; const b = c.getBoundingClientRect();
      return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
    if (!c) throw new Error(`${this.name}: no canvas on the page`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    }
  }
  async hold(key, code, keyCode) {
    for (let i = 0; i < 4; i++) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key, code,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
      });
      await sleep(400);
    }
  }
  async rehold(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
  }
  async release(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code,
      windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
  }
  stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* The two spawns the walkers use, read straight out of the emitted map so the
 * load test does not carry its own copy of the spawn coordinates. */
function fortSpawns() {
  const text = fs.readFileSync(MAPS, 'utf8');
  const out = [];
  const re = /"classname"\s+"info_player_deathmatch"\s+"origin"\s+"([\d.]+)\s+([\d.]+)\s+([\d.]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push([+m[1], +m[2], +m[3]]);
  }
  return out;
}
async function routeBetween(a, b) {
  const r = sh('python3', [path.join(ROOT, 'scripts/map_route.py'),
    '--map', 'forts', '--from', a.join(','), '--to', b.join(',')], { cwd: ROOT });
  try { return JSON.parse(r.stdout); } catch (e) { return { ok: false }; }
}

async function main() {
  if (NCLIENTS < 2 || NCLIENTS > 16) {
    console.log('--clients must be 2..16 (MAX_CLIENTS)'); return 2;
  }
  console.log(`load16: ${NCLIENTS} headless clients on one fteqw-sv, map forts`);
  const svPort = await takePort(20000 + (process.pid % 12000));
  const httpPort = await takePort(svPort + 1);
  console.log(`  ports claimed: game ${svPort}, static ${httpPort} (run dir ${RUN})`);

  const server = new Server(svPort);
  if (!await server.start()) {
    bad('the dedicated server initialised',
      fs.existsSync(LOG) ? logAll().slice(-1200) : '(no server log)');
    return 1;
  }
  ok(`dedicated server initialised on :${svPort} (maxclients ${NCLIENTS})`);

  /* --pin-cores models deployment: a container gets a CPU reservation, and 16
   * co-located SwiftShader renderers do not exist in production -- each
   * player's browser renders on the player's own machine. The SERVER is
   * pinned to the named cores and the BROWSERS are pinned to 0-15, so the
   * server owns its cores exclusively. Both runs are reported; the
   * requirement is judged on the pinned one, with the unpinned numbers kept
   * for what they say about scheduling. */
  if (PIN) {
    const r = sh('taskset', ['-pc', PIN, String(server.proc.pid)]);
    check(r.status === 0,
      `server pinned to cores ${PIN}, browsers to ${BROWSER_CORES}`, r.stderr);
  }

  /* The static server: the same tools/serve.js the walk suite uses, probed
   * before anything navigates (0466). */
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
  ok(`static server up on :${httpPort}`);

  /* Connect NCLIENTS browsers in waves of 4. */
  const clients = [];
  const names = [];
  for (let i = 0; i < NCLIENTS; i++) names.push(`p${String(i).padStart(2, '0')}`);
  let cdpSeed = 21000 + (process.pid % 8000);
  const wave = 4;
  let startFail = null;
  const t0 = Date.now();
  for (let i = 0; i < names.length && !startFail; i += wave) {
    const batch = names.slice(i, i + wave);
    const res = await Promise.all(batch.map(async (n) => {
      const cdp = await takePort(cdpSeed++);
      const c = new Client(n, cdp);
      const url = `http://127.0.0.1:${httpPort}/index.html?server=` +
        encodeURIComponent(`ws://127.0.0.1:${svPort}`) + `&name=${n}`;
      try { await c.start(url); return c; }
      catch (e) { try { c.stop(); } catch (e2) {}; return e; }
    }));
    for (const r of res) {
      if (r instanceof Client) clients.push(r);
      else startFail = startFail || r;
    }
    console.log(`  connected ${clients.length}/${NCLIENTS}` +
                ` (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  if (startFail || clients.length !== NCLIENTS) {
    bad(`all ${NCLIENTS} clients started`, String(startFail || `only ${clients.length}`));
    server.stop();
    return 1;
  }
  ok(`all ${NCLIENTS} clients started and reached a canvas`);

  /* Wait until the SERVER's own table lists every name (mp_smoke's rule: the
   * server's table is the truth and cannot be satisfied by a client talking
   * to itself). */
  const urlFor = (n) => `?server=ws://127.0.0.1:${svPort}&name=${n}`;
  let table = '';
  {
    const end = Date.now() + 90000;
    while (Date.now() < end) {
      const st = await server.status();
      const rows = tableRows(st);
      if (rows.length === NCLIENTS && rows.every(r =>
          names.some(n => r.includes(n)))) { table = st; break; }
      table = st;
      await sleep(1500);
    }
  }
  const rowsNow = tableRows(table);
  check(rowsNow.length === NCLIENTS,
    `the server's status lists ${NCLIENTS} players (found ${rowsNow.length})`,
    'status tail:\n' + table.trim().split('\n').slice(-16).join('\n'));
  if (rowsNow.length !== NCLIENTS) {
    server.stop();
    return 1;
  }

  /* Pointer lock and +forward on every client, now that everyone has spawned
   * (a keydown before spawn is dropped -- walk_routes' lesson). */
  /* THE LOBBY (2026-10-09): a join is held until both picks are made, and a
   * waiter is a noclip observer -- 16 noclip ghosts is not the load the
   * requirement names. Every client picks `auto` + Soldier through the
   * overlay's own entry point, and the class_stats lines say the bodies are
   * real before the measurement starts. */
  for (const c of clients) {
    await c.eval('window.QWTF_MENU.do("team_auto")').catch(() => null);
  }
  await sleep(700);
  for (const c of clients) {
    await c.eval('window.QWTF_MENU.do("cls_soldier")').catch(() => null);
  }
  {
    const end = Date.now() + 90000;
    let dressed = 0;
    while (Date.now() < end) {
      dressed = names.filter(n =>
        logAll().includes(`QWTF_EVENT class_stats ${n} class=soldier`)).length;
      if (dressed === NCLIENTS) break;
      await sleep(1000);
    }
    check(dressed === NCLIENTS,
      `every client's lobby spawn landed (${dressed}/${NCLIENTS} class_stats lines)`,
      'the walkers below must be real bodies; a waiter is noclip and bodiless');
  }
  for (const c of clients) {
    await c.clickCanvas();
    await c.hold('w', 'KeyW', 87);
  }
  ok(`all ${NCLIENTS} clients pointer-locked and holding +forward`);

  /* MOVEMENT LOAD: one route, spawn of one fort to the spawn of the other,
   * cycled every 20 s through every player at once (probe.qc reads the world
   * serverinfo in each player's own think). If the map says there is no route,
   * the test fails rather than steering into walls silently. */
  const spawns = fortSpawns();
  if (spawns.length < 2) {
    bad('two spawn entities in maps/forts.map', `found ${spawns.length}`);
    server.stop(); return 1;
  }
  let a = spawns[0], b = spawns[spawns.length - 1];
  for (const s of spawns) for (const t of spawns) {
    if (Math.hypot(s[0] - t[0], s[1] - t[1]) >
        Math.hypot(a[0] - b[0], a[1] - b[1])) { a = s; b = t; }
  }
  const rt = await routeBetween(a, b);
  if (!rt.ok || !rt.waypoints || rt.waypoints.length < 2) {
    bad('map_route found a spawn-to-spawn route',
      `from ${a} to ${b}: ${JSON.stringify(rt).slice(0, 200)}`);
    server.stop(); return 1;
  }
  const wps = rt.waypoints;
  ok(`movement route: spawn-to-spawn, ${wps.length} waypoints, ` +
     `${wps[0].map(v => v.toFixed(0))} -> ${wps[wps.length - 1].map(v => v.toFixed(0))}`);

  let wpSeq = 0;
  const sendWp = (w, jump) => {
    wpSeq += 1;
    server.command(`serverinfo qwtf_wx ${w[0].toFixed(0)}`);
    server.command(`serverinfo qwtf_wy ${w[1].toFixed(0)}`);
    server.command(`serverinfo qwtf_wz ${w.length > 2 ? w[2].toFixed(0) : ''}`);
    server.command(`serverinfo qwtf_wjump ${jump ? 1 : 0}`);
    server.command(`serverinfo qwtf_wseq ${wpSeq}`);
  };
  let wpi = 0;
  sendWp(wps[0], false);
  const wpTimer = setInterval(() => {
    wpi = (wpi + 1) % wps.length;
    sendWp(wps[wpi], false);
  }, 20000);

  /* MEASURE. Wait past one latch (10 s), then three reads 11 s apart: the
   * windows barely overlap, covering ~30 s of moving players, and the
   * assertion uses the worst "max" of the three. */
  /* MEASURE. Wait past one latch (10 s), then three reads 12 s apart: the
   * windows barely overlap, covering ~30 s of moving players, and the
   * assertion uses the worst "max" of the three.
   *
   * The rehold that re-asserts a possibly unlatched key is a burst of CDP
   * traffic to 16 browsers RIGHT before a read, so it is done before read 2
   * ONLY: read 3 then sits in a window with no harness traffic in it, and a
   * spike that appears at reads 1 and 2 but not 3 is the harness's own, not
   * the game's. Read 1 has the original hold burst in its window. */
  let cpuLast = server.cpuSeconds();
  console.log('  measuring: 3 status reads, 12s apart, while all players walk');
  const samples = [];
  for (let i = 0; i < 3; i++) {
    if (i === 1) {
      // A held key can be unlatched by focus churn between headless pages;
      // re-assert it cheaply rather than spend 30 s measuring 16 spectators.
      for (const c of clients) await c.rehold('w', 'KeyW', 87);
    }
    await sleep(12000);
    const cpuBefore = cpuLast; cpuLast = server.cpuSeconds();
    const st = await server.status();
    const rows = tableRows(st);
    samples.push({
      i,
      rows: rows.length,
      names: rows.map(r => r.split(/\s{2,}/).pop()).filter(Boolean),
      resp: responseMs(st),
      out: outBytes(st),
      cpu: (cpuLast !== null && cpuBefore !== null) ? cpuLast - cpuBefore : null,
    });
    console.log(`    read ${i + 1}: rows=${rows.length}` +
      (samples[i].resp ? ` avg=${samples[i].resp.avg}ms max=${samples[i].resp.max}ms` : ' (no response line)') +
      (samples[i].out !== null ? ` out=${(samples[i].out / 1000).toFixed(1)} KB/s total` : '') +
      (samples[i].cpu !== null ?
        ` cpu=${(samples[i].cpu * 1000).toFixed(0)}ms in 12s (${(samples[i].cpu / 12 * 100).toFixed(1)}% of a core)` : ''));
  }
  clearInterval(wpTimer);

  /* Assertions, worst-case across the samples. */
  check(samples.every(s => s.rows === NCLIENTS),
    `all ${NCLIENTS} players stayed connected through the measurement`,
    `row counts: ${samples.map(s => s.rows).join(', ')}`);
  const worst = Math.max(...samples.map(s => (s.resp ? s.resp.max : -1)));
  check(samples.every(s => s.resp),
    'status reported a response-time line on every read',
    'lines seen: ' + JSON.stringify(samples.map(s => s.resp)));
  if (samples.every(s => s.resp)) {
    check(worst <= 10,
      `worst server frame over ${samples.length} latched windows: ${worst} ms (<= 10)`,
      `per read: ${samples.map(s => s.resp.max).join(', ')} ms max`);
  }
  const outs = samples.map(s => s.out).filter(v => v !== null);
  if (outs.length === samples.length) {
    const perPlayer = Math.max(...outs) / NCLIENTS;
    check(perPlayer <= 30 * 1024,
      `worst per-player out ${(perPlayer / 1024).toFixed(1)} KB/s (<= 30 KB/s down)`,
      `per read total: ${outs.map(v => (v / 1000).toFixed(1)).join(', ')} KB/s`);
  } else {
    check(false, 'status reported a packets,bytes/sec line on every read',
      'missing on reads ' + samples.map((s, i) => s.out === null ? i : null)
        .filter(v => v !== null).join(','));
  }

  /* MOVEMENT HAPPENED, on the server's own numbers: the position probe prints
   * every player at 4 Hz; require at least half the players to have covered
   * real ground (32+ units) during the window, and name the ones that did
   * not, so a jam is visible rather than guessed. */
  const txt = logAll();
  const moved = [], still = [];
  for (const n of names) {
    const re = new RegExp(`QWTFPOS \\[${n}\\] (\\S+) (\\S+) (\\S+)`, 'g');
    let m, first = null, last = null;
    while ((m = re.exec(txt)) !== null) {
      const p = [+m[1], +m[2], +m[3]];
      if (!first) first = p;
      last = p;
    }
    if (first && last &&
        Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) > 32) {
      moved.push(n);
    } else still.push(n);
  }
  check(moved.length >= Math.ceil(NCLIENTS / 2),
    `players moved under their own steam: ${moved.length}/${NCLIENTS} (>= half)`,
    'did not move: ' + (still.join(' ') || '(none)') +
    '\n       (the waypoint is the same for everyone; players blocked by the ' +
    'crowd count as load, but half the server must travel)');

  /* Client health, mp_smoke's noise rules. */
  const noise = /Download of|Couldn't find file|sound/i;
  const FAIL_WORDS = ["couldn't load", 'not found', 'unable to', 'referenceerror',
    'is not defined', 'failed to', 'error:', 'unsupported'];
  for (const c of clients) {
    const badLines = c.console.filter(l => !noise.test(l) &&
      FAIL_WORDS.some(w => l.toLowerCase().includes(w)));
    check(badLines.length === 0,
      `${c.name}: no load failures in ${c.console.length} console lines`,
      badLines.slice(0, 4).join(' | '));
    check(c.errors.length === 0, `${c.name}: no uncaught exceptions`,
      c.errors.slice(0, 3).join(' | '));
  }

  for (const c of clients) await c.release('w', 'KeyW', 87).catch(() => {});
  server.command('quit');
  await sleep(1000);
  server.stop();
  for (const c of clients) c.stop();

  console.log(`\n${failed ? `FAIL: ${failed} of ${passed + failed} checks`
                          : `PASS: ${passed}/${passed + failed} checks`}`);
  return failed ? 1 : 0;
}

main().then(c => process.exit(c === 0 ? 0 : c || 1));