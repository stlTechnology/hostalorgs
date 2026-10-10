#!/usr/bin/env node
'use strict';
/* M6 requirement row (PROJECT.md "Requirements"):
 *
 *   | Network | Playable at 100 ms RTT and 1% packet loss (client-side
 *             | prediction on). Each player uses <= 30 KB/s down.           |
 *
 * This FTE has no net_fakelag / net_fakeloss (grepped the vendored source),
 * so the condition is applied with `tc netem` on loopback, SCOPED to the
 * test's own port -- the live service on :27510 and the page server on
 * :8200 ride the same interface and must not be touched. The scoping and
 * its calibration are measured, not assumed:
 *
 *   dport-only filter, netem delay 50ms  -> measured echo RTT 106 ms
 *   dport+sport filters, delay 50ms      -> measured echo RTT 206 ms
 *
 * i.e. a matched packet traverses the qdisc twice on loopback, so the
 * dport-only form at 50 ms IS the 100 ms RTT condition, and loss is rolled
 * twice per packet too -- 0.5% per pass is ~1% per direction, slightly
 * harsher than the row asks, which is the safe side of the condition.
 *
 * "Playable" is judged the way the walk suite judges it: a real player
 * spawned (the server's own table), holding forward, walking real
 * spawn-to-spawn waypoints (map_route), with arrivals announced by the
 * server's own QWTFWP lines -- plus the server's own ping column saying the
 * delay actually applied, and the connection never dropping through the
 * whole run.
 *
 * The tc state is checked BEFORE anything starts (a root qdisc that is not
 * the default noqueue means something else owns the interface -- bail loudly
 * rather than clobber it) and removed on EVERY exit path, with the removal
 * verified after.
 *
 * Run: tests/netloss.sh (flock wrapper). Not a check_all row: a measurement.
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
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
const WAYPOINTS = parseInt(arg('--waypoints', '4'), 10);
const RUN = path.join(os.tmpdir(), `qwtf-netloss-${process.pid}`);
const LOG = path.join(RUN, 'server.log');
const LIVE_PAGE = process.env.QWTF_LIVE_PAGE || 'http://127.0.0.1:8200/index.html';

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
  removeNetem();
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

/* --- netem, scoped, and always removable ------------------------------------ */
let NETEM_PORT = 0;   // 0 = not applied
function sudo(args) {
  return sh('sudo', args);
}
function rootQdiscIsDefault() {
  const r = sudo(['tc', 'qdisc', 'show', 'dev', 'lo']);
  const out = (r.stdout || '').trim();
  return /noqueue/.test(out) && out.split('\n').length === 1;
}
function applyNetem(port) {
  const steps = [
    ['tc', 'qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio'],
    ['tc', 'qdisc', 'add', 'dev', 'lo', 'parent', '1:3', 'handle', '30:',
      'netem', 'delay', '50ms', 'loss', '0.5%'],
    ['tc', 'filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', 'ip',
      'prio', '3', 'u32', 'match', 'ip', 'dport', String(port), '0xffff',
      'flowid', '1:3'],
  ];
  for (const s of steps) {
    const r = sudo(s);
    if (r.status !== 0) {
      return `tc failed (${s.join(' ')}): ${r.stderr}`;
    }
  }
  NETEM_PORT = port;
  return null;
}
function removeNetem() {
  if (!NETEM_PORT) return true;
  NETEM_PORT = 0;
  const r = sudo(['tc', 'qdisc', 'del', 'dev', 'lo', 'root']);
  const clean = r.status === 0 || /No such file or directory/.test(r.stderr || '');
  if (!clean) console.error('  netem removal FAILED: ' + (r.stderr || r.status));
  return clean;
}
function curlTime(url) {
  const t0 = Date.now();
  const r = sh('curl', ['-s', '-o', '/dev/null', '--max-time', '5', url]);
  return { ms: Date.now() - t0, rc: r.status };
}

/* --- server / client: the proven shapes ------------------------------------- */
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
/* The row naming this player, with the trailing hz/ping numbers. */
function playerRow(statusText, name) {
  return tableRows(statusText).find(r => r.includes(name)) || null;
}
function rowPing(row) {
  if (!row) return null;
  const nums = row.trim().match(/(\d+)\s+(\d+)\s*$/);
  return nums ? +nums[2] : null;
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
      return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
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
  stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
  }
}

/* Waypoints: the walk suite's steering keys, read through map_route. */
async function routeBetween(a, b) {
  const r = sh('python3', [path.join(ROOT, 'scripts/map_route.py'),
    '--map', 'forts', '--from', a.join(','), '--to', b.join(',')], { cwd: ROOT });
  try { return JSON.parse(r.stdout); } catch (e) { return { ok: false }; }
}
function fortSpawns() {
  const text = fs.readFileSync(path.join(ROOT, 'maps', 'forts.map'), 'utf8');
  const out = [];
  const re = /"classname"\s+"info_player_deathmatch"\s+"origin"\s+"([\d.]+)\s+([\d.]+)\s+([\d.]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push([+m[1], +m[2], +m[3]]);
  return out;
}
/* Max QWTFWP seq the server has announced (per-player, one line each). */
function maxArrivalSeq() {
  const re = /QWTFWP (\d+) /g;
  const txt = logAll();
  let m, mx = 0;
  while ((m = re.exec(txt)) !== null) mx = Math.max(mx, +m[1]);
  return mx;
}

async function main() {
  console.log('netloss: playability at ~100 ms RTT and ~1% loss, scoped tc netem');
  const svPort = await takePort(20000 + (process.pid % 12000));
  const httpPort = await takePort(svPort + 1);
  const cdpPort = await takePort(svPort + 2);
  console.log(`  ports claimed: game ${svPort}, static ${httpPort} (run dir ${RUN})`);

  if (!rootQdiscIsDefault()) {
    bad('loopback\'s root qdisc is the default (nothing to clobber)',
      sudo(['tc', 'qdisc', 'show', 'dev', 'lo']).stdout);
    return 2;
  }
  const beforePage = curlTime(LIVE_PAGE);
  ok(`untouched-port sanity before: ${LIVE_PAGE} answered in ${beforePage.ms} ms`);

  const err = applyNetem(svPort);
  if (err) { bad('scoped netem applied', err); return 2; }
  ok(`netem on dport ${svPort} only: 50 ms/pass x2, loss 0.5%/pass ` +
     '(calibrated: echo RTT ~106 ms; live ports untouched)');

  const server = new Server(svPort);
  if (!await server.start()) {
    bad('the dedicated server initialised',
      fs.existsSync(LOG) ? logAll().slice(-800) : '(no server log)');
    removeNetem();
    return 1;
  }
  const serve = spawn('node', [path.join(ROOT, 'tools/serve.js'),
    '--port', String(httpPort), '--root', 'web'],
    { cwd: ROOT, stdio: ['ignore', fs.openSync(path.join(RUN, 'serve.log'), 'w'), 'ignore'],
      detached: true });
  track(serve);
  if (!await waitListening(httpPort, 30000)) {
    bad('the static server started on its port', `port ${httpPort}`);
    server.stop(); removeNetem();
    return 1;
  }

  const client = new Client(cdpPort, path.join(RUN, 'chrome.stderr'));
  const url = `http://127.0.0.1:${httpPort}/index.html?server=` +
    encodeURIComponent(`ws://127.0.0.1:${svPort}`) + `&name=lag0`;
  try {
    await client.start(fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-loss-')), url);
  } catch (e) {
    bad('the client started', String(e.message || e));
    server.stop(); removeNetem();
    return 1;
  }

  /* Spawned under the delay. */
  const spawnEnd = Date.now() + 45000;
  let spawned = false;
  while (Date.now() < spawnEnd) {
    const st = await server.status();
    if (tableRows(st).some(r => r.includes('lag0'))) { spawned = true; break; }
    await sleep(500);
  }
  check(spawned, 'the client spawned under 100 ms RTT / ~1% loss');
  if (!spawned) {
    client.stop(); server.stop(); removeNetem();
    return 1;
  }

  /* The ping the SERVER reports for this player, mid-run: the condition has
   * to be visible in the game's own numbers, not only in tc's config. */
  await client.clickCanvas();
  await client.pressForward();
  let ping = null;
  const pingEnd = Date.now() + 20000;
  while (Date.now() < pingEnd && ping === null) {
    ping = rowPing(playerRow(await server.status(), 'lag0'));
    if (ping === null) await sleep(500);
  }
  check(ping !== null && ping >= 60 && ping <= 300,
    `the server's own ping column says ${ping === null ? '?' : ping} ms (60..300)`,
    'status row: ' + playerRow(await server.status(), 'lag0'));
  await sleep(2000);   // a moment of walking before the route starts

  /* PLAYABLE: walk real waypoints and count the server's own arrivals. */
  const spawns = fortSpawns();
  if (spawns.length < 2) {
    bad('two spawn entities in maps/forts.map', `found ${spawns.length}`);
    client.stop(); server.stop(); removeNetem();
    return 1;
  }
  let a = spawns[0], b = spawns[spawns.length - 1];
  for (const s of spawns) for (const t of spawns) {
    if (Math.hypot(s[0] - t[0], s[1] - t[1]) >
        Math.hypot(a[0] - b[0], a[1] - b[1])) { a = s; b = t; }
  }
  const rt = await routeBetween(a, b);
  if (!rt.ok || !rt.waypoints || rt.waypoints.length < WAYPOINTS) {
    bad('map_route found enough spawn-to-spawn waypoints',
      `from ${a} to ${b}: ${JSON.stringify(rt).slice(0, 160)}`);
    client.stop(); server.stop(); removeNetem();
    return 1;
  }
  let seq = 0;
  const sendWp = (w) => {
    seq += 1;
    server.command(`serverinfo qwtf_wx ${w[0].toFixed(0)}`);
    server.command(`serverinfo qwtf_wy ${w[1].toFixed(0)}`);
    server.command('serverinfo qwtf_wz ""');
    server.command('serverinfo qwtf_wjump 0');
    server.command(`serverinfo qwtf_wseq ${seq}`);
  };
  const target = WAYPOINTS;
  sendWp(rt.waypoints[0]);
  const wpEnd = Date.now() + 60 * 1000 * target;
  let arrivals = maxArrivalSeq();
  let sent = 1;
  while (Date.now() < wpEnd) {
    const now = maxArrivalSeq();
    if (now > arrivals) {
      arrivals = now;
      if (arrivals >= target) break;
      if (arrivals < rt.waypoints.length) {
        sendWp(rt.waypoints[arrivals]);
        sent++;
      }
    }
    await sleep(500);
  }
  check(arrivals >= target,
    `playable: ${arrivals} of ${target} waypoints walked to arrival under the condition` +
    ` (${sent} sent)`,
    'route: spawn-to-spawn via map_route; arrivals are the server\'s own QWTFWP lines');

  /* Still connected, and the outside world untouched. */
  const still = tableRows(await server.status());
  check(still.some(r => r.includes('lag0')),
    'the client stayed connected the whole run');
  const afterPage = curlTime(LIVE_PAGE);
  check(afterPage.ms < 200,
    `untouched-port sanity after: ${LIVE_PAGE} answered in ${afterPage.ms} ms (< 200)`);

  client.stop();
  server.command('quit');
  await sleep(1000);
  server.stop();
  check(removeNetem(), 'netem removed on the way out');
  ok('loopback back to: ' + sudo(['tc', 'qdisc', 'show', 'dev', 'lo']).stdout.trim());

  console.log(`\n${failed ? `FAIL: ${failed} of ${passed + failed} checks`
                          : `PASS: ${passed}/${passed + failed} checks`}`);
  return failed ? 1 : 0;
}

main().then(c => process.exit(c === 0 ? 0 : c || 1));