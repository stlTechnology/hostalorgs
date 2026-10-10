/*
 * M4a's flag-to-flag first-person run, asserted from the SERVER's view.
 *
 *   node tests/flag_run.js [--port N] [--headless]
 *
 * PLAN.md M4a: "Check with an overhead screenshot of the layout plus a
 * first-person run from flag to flag."
 *
 * Why this reads the server and not the browser: reviewer 0043 item 2 was about
 * movement being asserted from canvas bytes, which change when the OTHER client
 * moves and so cannot tell a player walking from the view changing. The server's
 * own copy of the player origin is the authoritative position, and it is what
 * the run below is measured on.
 *
 * That position comes from qwtf/probe.qc, which wraps PlayerPostThink (the
 * engine calls it for every client every frame, with self set to that player)
 * and prints:
 *
 *   QWTFPOS [netname] x y z
 *
 * 4 Hz per player, gated on the serverinfo cvar qwtf_trace, which this test
 * turns on with +serverinfo qwtf_trace 1. dprint only reaches stdout with
 * developer set, so that is on too.
 *
 * Checks:
 *   1  the probe fires at all, for the right player, at 4 Hz
 *   2  positions come from the server, not the client (a negative control: the
 *      client's own reported position must never be what is asserted)
 *   3  the player is MOVING: distance travelled over the run is a real number,
 *      and the player actually changes position. This is the assertion that was
 *      impossible before.
 *   4  the run VISITS BOTH flag rooms, from the server's coordinates
 *   5  it stays inside the map (the positions are on navigable ground)
 *   6  screenshots along the way, including one in each base
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const WEB = path.join(ROOT, 'web');
const STAGE = path.join(ART, 'gamedir');
const SHOTS = path.join(ART, 'flag_run');
const LOG = path.join(SHOTS, 'server.log');

/* The map's own constants, read from the generator so the test cannot drift
 * from the map. gen_map.py is the single source of truth for CTF_LEN and the
 * flag positions; parsing them here rather than copying the numbers means a
 * change to the map moves the test with it. */
function mapConstants() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/gen_map.py'), 'utf8');
  const num = (name) => {
    const m = new RegExp('^' + name + '\\s*=\\s*(\\d+)', 'm').exec(src);
    if (!m) throw new Error('gen_map.py has no ' + name);
    return parseInt(m[1], 10);
  };
  const CTF_LEN = num('CTF_LEN');
  const [CTF_Y0, CTF_Y1] = /CTF_Y0,\s*CTF_Y1\s*=\s*(\d+),\s*(\d+)/.exec(src)
    .slice(1).map(Number);
  /* The flag entity line, as entities() emits it:
   *   E.append(["info_ctf_flag", f'"origin" "{X(144)} {CTF_Y0 + 80} 40"', ...])
   * so the flag is at x=144 (mirrored: CTF_LEN-144) and y=CTF_Y0+80. */
  const flagY = CTF_Y0 + 80;
  return {
    CTF_LEN,
    mid: CTF_LEN / 2,
    midY: (CTF_Y0 + CTF_Y1) / 2,
    flagA: { x: 144, y: flagY, z: 40 },
    flagB: { x: CTF_LEN - 144, y: flagY, z: 40 },
    /* How close counts as "was at the flag". The player hull is 32 wide, and a
     * carried key is picked up on touch, so a generous radius is right; too
     * small and the test fails on a pickup that worked. */
    reach: 96,
  };
}

/* The map's own spawn points, from the generator, so "did the player really
 * spawn" is answered by the map rather than by a timeout. */
function ents_spawns() {
  const r = sh('python3', ['-c', `
import sys, os
sys.path.insert(0, os.path.join(${JSON.stringify(ROOT)}, 'scripts'))
import gen_map as g
out = []
for mirrored in (False, True):
    for fields in g.base_entities(mirrored):
        if fields[0] != 'info_player_deathmatch':
            continue
        o = [f for f in fields if f.startswith('"origin"')][0]
        p = [float(v) for v in o.split('"')[3].split()]
        out.append(p)
print(out)
`]);
  if (r.status !== 0) throw new Error('could not read the spawn points: ' + r.stderr);
  return JSON.parse(r.stdout.trim());
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

/* ---------------------------------------------------------------- the server */
class Server {
  constructor(port) { this.port = port; this.log = ''; this.stderr = ''; }

  async start() {
    fs.mkdirSync(SHOTS, { recursive: true });
    this.out = fs.openSync(LOG, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', STAGE,
      '--demo-subdir', 'demos',
      /* The two switches that turn the probe on. developer is what lets dprint
       * reach stdout at all; qwtf_trace is the probe's own gate. */
      '--map', 'forts',
      '+set', 'developer', '1',
      '+serverinfo', 'qwtf_trace', '1',
      /* no +map here: run_server.sh loads forts by default and appends it
       * itself. Passing it twice was harmless but meant two places to change. */
    ], { cwd: ROOT, stdio: ['pipe', this.out, 'pipe'], detached: true });
    this.proc.stderr.on('data', d => { this.stderr += d.toString(); });
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      this.log = fs.readFileSync(LOG, 'utf8');
      if (/Quake Initialized/.test(this.log)) return true;
      if (this.proc.exitCode !== null) break;
    }
    this.log = fs.readFileSync(LOG, 'utf8');
    return /Quake Initialized/.test(this.log);
  }

  command(cmd) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n'); }

  /* Point the player at a heading, server-side (reviewer 0091 item 2).
   *
   * `serverinfo qwtf_face <yaw>` is read by qwtf/probe.qc's PlayerPreThink
   * wrapper, which sets the player's angle. The client keeps holding W, so the
   * movement is still the ordinary path -- only the heading is dictated, because
   * a headless client cannot turn at all (see the notes in probe.qc).
   *
   * Quake's view angles: 0 looks along +x, 90 along -y. */
  face(yaw) { this.command(`serverinfo qwtf_face ${yaw.toFixed(2)}`); }

  /* Hand steering back: an empty value is how the cvar says "stop". */
  faceNone() { this.command('serverinfo qwtf_face ""'); }

  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {} }
    try { if (this.out) fs.closeSync(this.out); } catch (e) {}
    await sleep(300);
  }
}

/* -------------------------------------------------------------- the positions
 * Parse "QWTFPOS [name] x y z" out of the server's stdout. Returns
 * { name: [ {t, x, y, z}, ... ] } in server order. */
function parsePositions(log) {
  const byName = new Map();
  /* [name] x y z yaw health.
   *
   * The yaw is what lets the test steer (see steer()). The health is what tells
   * a player that has stopped responding apart from one that is wedged on
   * geometry: a dead player or a spectator stops accepting movement and its
   * origin stays put, which from the outside looks identical without it. */
  const re = /QWTFPOS \[([^\]]*)\] (\S+) (\S+) (\S+) (\S+)(?: (\S+)(?: (\S+))?)?/g;
  let m;
  while ((m = re.exec(log)) !== null) {
    const [, name, x, y, z, yaw, health, waterlevel] = m;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({
      t: byName.get(name).length * 0.25,   /* the probe's own 4 Hz rate */
      x: parseFloat(x), y: parseFloat(y), z: parseFloat(z),
      yaw: yaw === undefined ? null : parseFloat(yaw),
      health: health === undefined ? null : parseFloat(health),
      waterlevel: waterlevel === undefined ? null : parseFloat(waterlevel),
    });
  }
  return byName;
}

/* Quake's view angles: 0 looks along +x, 90 along -y, growing clockwise seen
 * from above. So the angle that faces a delta (dx, dy) is atan2(-dy, dx).
 * Getting this backwards sends the player away from the target, which looks
 * like "the input does not work" and is not. */
function bearingToward(fromX, fromY, toX, toY) {
  return Math.atan2(-(toY - fromY), toX - fromX) * 180 / Math.PI;
}

/* The signed shortest turn from `from` to `to`, in (-180, 180]. */
function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

/* --------------------------------------------------------------- the route
 * A walkable path from one point to another, computed from the map's own box
 * list by scripts/map_route.py: a flood fill of the hull-sized free space.
 *
 * Why not hardcode waypoints, and why not just hold W: the map is two mirrored
 * castles with three routes between them, so the straight line from one key to
 * the other is inside solid rock for most of its length. Holding W walks into
 * the wall -- measured: 112 units in the first second, then stopped for the rest
 * of the run. Steering needs to know where the door is, and the door is
 * wherever the generator put it, so the route comes from the generator too.
 *
 * If the flood fill finds no route, that is the answer, not a straight line
 * through a wall: the caller reports it. */
function route(from, to) {
  const r = sh('python3', [path.join(ROOT, 'scripts/map_route.py'),
    '--from', from.join(','), '--to', to.join(',')]);
  let out;
  try { out = JSON.parse(r.stdout); } catch (e) {
    throw new Error('map_route.py did not print JSON: ' + r.stdout + r.stderr);
  }
  if (!out.ok) {
    throw new Error(`no walkable route from ${from} to ${to}: ${out.reason}`);
  }
  return out.waypoints;
}

/* Total distance travelled, summed over consecutive samples. */
function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += distance(pts[i - 1], pts[i]);
  return d;
}

/* ------------------------------------------------------------------ the client */
class Client {
  constructor(name, cdpPort) { this.name = name; this.port = cdpPort; this.logs = []; this.errors = []; }

  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `qwtf-${this.name}-`));
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1024,576', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let info = null;
    for (let i = 0; i < 150; i++) {
      const r = sh('curl', ['-s', `http://127.0.0.1:${this.port}/json/list`]);
      if (r.status === 0) {
        try { info = JSON.parse(r.stdout).find(t => t.type === 'page'); if (info) break; } catch (e) {}
      }
      await sleep(200);
    }
    if (!info) throw new Error(`${this.name}: chrome debugger never came up`);
    const WS = require('./cdp.js');
    this.ws = await WS.connect(info.webSocketDebuggerUrl, m => this.onMessage(m));
    this.nextId = 1; this.pending = new Map();
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
    await this.send('Page.navigate', { url });
  }

  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      this.logs.push((m.params.args || []).map(a =>
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${this.name} CDP timeout: ${method}`)); }
      }, 60000);
    });
  }

  said(re) { return this.logs.some(l => re.test(l)); }
  text() { return this.logs.join('\n'); }

  /* One Runtime.evaluate, for the lobby's picks (2026-10-09). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async focus() {
    await this.send('Page.bringToFront').catch(() => {});
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { const c = document.getElementById('canvas');
        if (!c) return null; const b = c.getBoundingClientRect();
        return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`,
      returnByValue: true,
    });
    const c = r.result.value;
    if (!c) throw new Error(`${this.name}: no canvas on the page`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    }
    return c;
  }

  /* Press a key and keep it pressed.
   *
   * FTE THROWS AWAY held buttons when the player spawns: a keydown that arrives
   * before the spawn is dropped on the floor. That is the same trap as the fire
   * bind (see .team/STATE.md), and it is why a run that pressed W once and held
   * it did nothing at all -- the press landed while the client was still a
   * spectator, and the player spawned afterwards with nothing held down.
   *
   * So this re-issues the keydown periodically. keydown without a keyup does not
   * confuse the engine: KeyDown_Scan latches on the transition, and the repeat
   * is the same state the engine is already in.
   */
  async holdKey(key, ms) {
    const period = 400;
    const end = Date.now() + ms;
    await this.keyDown([key]);
    while (Date.now() < end) {
      await sleep(Math.min(period, end - Date.now()));
      await this.keyDown([key]);
    }
    await this.keyUp([key]);
  }

  async keyDown(keys) {
    const vk = { w: 87, a: 65, s: 83, d: 68, ' ': 32, ArrowLeft: 37, ArrowRight: 39 };
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
          windowsVirtualKeyCode: vk[k] || 0, nativeVirtualKeyCode: vk[k] || 0 });
    }
  }
  async keyUp(keys) {
    const vk = { w: 87, a: 65, s: 83, d: 68, ' ': 32, ArrowLeft: 37, ArrowRight: 39 };
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent',
        { type: 'keyUp', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
          windowsVirtualKeyCode: vk[k] || 0, nativeVirtualKeyCode: vk[k] || 0 });
    }
  }

  /* Steer along `waypoints`, holding W the whole way.
   *
   * The heading is dictated by the SERVER (reviewer 0091 item 2), not by the
   * client. Three client-side attempts all failed, measured: headless Chrome
   * never grants pointer lock, so mouse-look is off, and FTE's web glue drops the
   * arrow keys, so only W reaches the engine. The test owns the server's stdin
   * anyway, and the server is authoritative over the player entity, so it writes
   * `serverinfo qwtf_face <yaw>` and qwtf/probe.qc's PlayerPreThink wrapper turns
   * the player. Movement, collision and the positions asserted here are all still
   * the ordinary client path; only the heading is dictated.
   *
   * Two earlier client-side versions, for the record: one held W and guessed
   * (walked 709 units past a waypoint 144 units away), and one steered on the
   * probe's yaw with the arrow keys and never changed yaw at all.
   *
   * Returns the waypoints it actually reached, so the caller can report how far
   * along it got rather than only pass or fail. */
  async steer(waypoints, server, logPath, playerName, opts) {
    const o = opts || {};
    const total = o.timeoutMs || 120000;
    const arriveWithin = o.arriveWithin || 56;
    const name = o.player || playerName;
    const deadline = Date.now() + total;
    const reached = [];
    let last = null;
    let facedOnce = false;

    let i = 1;
    while (i < waypoints.length) {
      const wp = waypoints[i];
      /* The direction of travel through this waypoint, used to notice that the
       * player has gone PAST it. Without this the player oscillates: at 400 u/s
       * a 200 ms pulse covers ~80 units, which is wider than the arrival window,
       * so the player overshoots, the bearing flips, and it walks back and forth
       * over the same stretch. Measured: 1266 units travelled to end up 128 units
       * from where it started. */
      const prev = waypoints[i - 1];
      const vx = wp[0] - prev[0], vy = wp[1] - prev[1];
      const vlen = Math.hypot(vx, vy) || 1;
      const ux = vx / vlen, uy = vy / vlen;
      const legDeadline = Math.min(deadline,
        Date.now() + Math.max(10000, total / waypoints.length));
      let arrived = false;
      while (Date.now() < legDeadline && Date.now() < deadline) {
        const pts = parsePositions(fs.readFileSync(logPath, 'utf8')).get(name);
        if (!pts || !pts.length || pts[pts.length - 1].yaw === null) {
          await sleep(200); continue;         /* no probe data yet: do not flail */
        }
        last = pts[pts.length - 1];
        const flat = Math.hypot(last.x - wp[0], last.y - wp[1]);
        /* How far past the waypoint, along the direction of travel. */
        const past = (last.x - wp[0]) * ux + (last.y - wp[1]) * uy;
        if (flat <= arriveWithin || past >= -arriveWithin) {
          arrived = true;
          reached.push(wp);
          break;
        }

        /* Tell the server which way to face, and keep holding W. */
        server.face(bearingToward(last.x, last.y, wp[0], wp[1]));
        facedOnce = true;
        await this.holdKey('w', o.walkMs || 120);
        if (o.onTick) await o.onTick(i, last, arrived);
      }
      if (o.onLeg) await o.onLeg(i, wp, arrived);
      i++;
    }
    await this.keyUp(['w']);
    server.faceNone();
    return { reached, last, facedOnce };
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    await sleep(400);
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* --------------------------------------------------------------- the staging */
function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const entry of fs.readdirSync(WEB)) {
    if (entry === 'id1') continue;
    fs.symlinkSync(path.join(WEB, entry), path.join(STAGE, entry));
  }
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(WEB, 'id1'))) {
    fs.symlinkSync(path.join(WEB, 'id1', entry), path.join(STAGE, 'id1', entry));
  }
  return STAGE;
}

/* ---------------------------------------------------------------------- main */
async function main() {
  /* A free port pair derived from our own PID, on offsets mp_combat.js and
   * mp_smoke.js do not use, so suites can run side by side and none of them
   * touches the ports the owner plays on. */
  const PORT = Number(arg('--port', 27530 + (process.pid % 40)));
  const HTTP = PORT + 1;
  const M = mapConstants();
  const results = [];
  let failed = 0;
  const ok = (msg) => { results.push(['ok', msg]); console.log('  ok   ' + msg); };
  const bad = (msg) => { results.push(['FAIL', msg]); failed++; console.log('  FAIL ' + msg); };

  console.log('== M4a flag-to-flag run (positions from the server)');
  console.log(`   map ctf: len=${M.CTF_LEN} mid=${M.mid} midY=${M.midY}`);
  console.log(`   flag A (${M.flagA.x}, ${M.flagA.y}, ${M.flagA.z})  ` +
              `flag B (${M.flagB.x}, ${M.flagB.y}, ${M.flagB.z})`);
  console.log(`   server :${PORT}  page :${HTTP}`);

  stage();
  const server = new Server(PORT);
  if (!await server.start()) {
    console.log(server.log.slice(-2000));
    throw new Error('the server did not start; see ' + LOG);
  }
  ok('the server started and loaded ctf');

  let page = null, client = null;
  try {
    page = spawn('node', [path.join(ROOT, 'tools/serve.js'),
      '--port', String(HTTP), '--root', STAGE],
      { cwd: ROOT, stdio: 'ignore', detached: true });
    await sleep(1200);

    const url = `http://127.0.0.1:${HTTP}/index.html?server=` +
      encodeURIComponent(`ws://127.0.0.1:${PORT}`) + '&name=runner&autojoin=1';
    client = new Client('runner', 9222 + (process.pid % 500));
    await client.start(url);

    /* Wait for the spawn. The probe prints nothing until a player exists, so
     * "the probe fired" and "the player spawned" are the same event, and that
     * is check 1. */
    let spawned = false;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      server.log = fs.readFileSync(LOG, 'utf8');
      if (parsePositions(server.log).has('runner')) { spawned = true; break; }

    }
    if (!spawned) {
      bad('the probe never printed a position for "runner"');
      console.log('--- server log tail ---');
      console.log(server.log.slice(-1500));
      console.log('--- client log tail ---');
      console.log(client.text().split('\n').slice(-25).join('\n'));
      return;
    }
    ok('the probe printed positions for "runner" (so the player spawned)');

    /* THE LOBBY (2026-10-09): the probe prints for the lobby waiter too (it is
     * still a player entity, noclip and bodiless), so "the probe fired" no
     * longer means "the player exists". Both picks go out through the page's
     * own overlay entry point, and the class_stats line is the body. */
    await client.eval('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await client.eval('window.QWTF_MENU.do("cls_soldier")');
    let dressed = false;
    for (let i = 0; i < 60 && !dressed; i++) {
      await sleep(500);
      try { dressed = /QWTF_EVENT class_stats runner class=soldier/.test(fs.readFileSync(LOG, 'utf8')); } catch (e) {}
    }
    if (!dressed) {
      bad('the lobby spawn landed for the runner (class_stats runner/soldier)');
      return;
    }
    ok('the runner picked both and spawned (class_stats runner/soldier)');

    /* Let the player actually spawn before touching the keyboard.
     *
     * The probe starts printing while the client is still a spectator -- FTE
     * calls PlayerPostThink for that state too (sv_user.c:8026 has no spectator
     * guard, unlike sv_phys.c:2374) -- so "the probe fired" does NOT mean "the
     * player exists". Measured: a run that pressed W as soon as the probe fired
     * did nothing at all, and the server log showed "runner joined the server"
     * several seconds later.
     *
     * The check that the player has spawned is its position being one of the
     * map's own spawn points, read from gen_map.py, so it cannot drift. */
    const spawnCells = ents_spawns();
    const atSpawnPoint = async () => {
      const pts = parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner');
      if (!pts || !pts.length) return false;
      const p0 = pts[0];
      return spawnCells.some(c => Math.abs(c[0] - p0.x) <= 24 &&
                                  Math.abs(c[1] - p0.y) <= 24 &&
                                  Math.abs(c[2] - p0.z) <= 24);
    };
    for (let i = 0; i < 40 && !(await atSpawnPoint()); i++) await sleep(500);
    if (!(await atSpawnPoint())) {
      const p0 = parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner')[0];
      bad(`the player never spawned: the probe reports it at ` +
          `(${p0.x}, ${p0.y}, ${p0.z}), which is not one of the map's ` +
          `${spawnCells.length} spawn points -- it is still a spectator`);
    } else {
      ok('the player spawned at one of the map\'s own spawn points');
    }
    /* And give the spawn a moment to settle before the first keypress, for the
     * same reason: FTE drops buttons held across the spawn. */
    await sleep(2500);
    await client.focus();
    await sleep(1000);

    /* Check 1b: the rate. 4 Hz means samples ~0.25 s apart. A probe that fired
     * every frame would be ~30 samples in 7 s; one that fired once would be 1.
     * Asserting the RATE as well as the presence is what stops "it printed
     * something" from being the whole test. */
    const early = parsePositions(server.log).get('runner').length;
    await sleep(7000);
    server.log = fs.readFileSync(LOG, 'utf8');
    const all = parsePositions(server.log);
    const pts = all.get('runner');
    const rate = (pts.length - early) / 7;
    /* Lower bound only. The probe's own gate is "at most every 0.25 s", but FTE
     * calls PlayerPostThink from two places -- sv_phys.c:2374 (once per physics
     * step, with a spectator guard) and sv_user.c:8026 (no guard) -- so the
     * observed rate is between 4 and about 12 per second depending on how the
     * client is being ticked. Asserting a narrow band tested FTE's call sites,
     * not the probe. What matters is that it fires continuously, not once. */
    if (rate > 3) ok(`the probe fires continuously (${rate.toFixed(1)}/s, gated at 4 Hz)`);
    else bad(`the probe rate is only ${rate.toFixed(1)}/s: it should fire continuously`);

    /* Check 2: the positions are the SERVER's. The client never sends them, and
     * the only path into this array is the server's stdout. Assert the marker
     * is in the server log and that the client log has no position lines at
     * all -- if someone later "helpfully" moves the assertion to the client,
     * this fails. */
    if (/QWTFPOS/.test(server.log)) ok('the positions came from the server log');
    else bad('no QWTFPOS in the server log');
    if (/QWTFPOS/.test(client.text())) {
      bad('the CLIENT is printing QWTFPOS: the assertion would be client-side');
    } else {
      ok('the client prints no positions, so the assertion cannot be client-side');
    }

    /* Check 5 first, while the player is still at its spawn: the positions must
     * be on the map. A probe reading the wrong field (say velocity, or a stale
     * origin) shows up here immediately. */
    const spawnPt = pts[0];
    const inBounds = spawnPt.x >= 0 && spawnPt.x <= M.CTF_LEN &&
                     spawnPt.y >= 100 && spawnPt.y <= 900 &&
                     spawnPt.z > -200 && spawnPt.z < 400;
    if (inBounds) ok(`the spawn position (${spawnPt.x.toFixed(0)}, ${spawnPt.y.toFixed(0)}, ${spawnPt.z.toFixed(0)}) is on the map`);
    else bad(`the spawn position is off the map: ${JSON.stringify(spawnPt)}`);

    await client.screenshot(path.join(SHOTS, '00-spawn.png'));

    /* Check 3, the one that used to be impossible: the player really moves,
     * measured by the SERVER. This is what reviewer 0043 item 2 asked for and
     * could not be had: canvas bytes change when the other client moves, so they
     * cannot tell a player walking from the view changing.
     *
     * Retried a few times, because the first press can still be swallowed if it
     * lands within a frame or two of the spawn. */
    let walked = 0, displacement = 0;
    for (let attempt = 0; attempt < 3 && walked < 100; attempt++) {
      const before = (parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner') || []).length;
      await client.holdKey('w', 2200);
      await sleep(600);
      const after = parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner') || [];
      const seg = after.slice(Math.max(0, before - 2));
      walked = pathLength(seg);
      displacement = seg.length ? distance(seg[0], seg[seg.length - 1]) : 0;
      if (walked < 100) await client.focus().catch(() => {});
    }
    await client.screenshot(path.join(SHOTS, '01-after-forward.png'));
    /* 3 s of running at 400 u/s is hundreds of units; the floor is a "did
     * anything happen" check, not a speed claim, because acceleration and the
     * spawn delay eat the first second. Measured: 240-320 units per attempt. */
    if (walked > 100) ok(`the player travelled ${walked.toFixed(0)} units on the server's positions`);
    else bad(`the player only travelled ${walked.toFixed(0)} units -- input did not reach the map`);
    if (displacement > 50) ok(`and ended up ${displacement.toFixed(0)} units from where it started`);
    else bad(`displacement was only ${displacement.toFixed(0)} units`);

    /* Which way did it go, and did it get OUT of the spawn room? That is the
     * part of the run that is reproducible without turning, and it is what
     * proved the spawn-room door was unusable: the old 96-wide door with the
     * spawns on its edge stopped the player dead against the jamb. */
    const endNow = (parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner') || []).pop();
    if (endNow) {
      const leftRoom = Math.abs(endNow.x - spawnPt.x) > 96;
      if (leftRoom) {
        ok(`the player left the spawn room on its own: ${spawnPt.x.toFixed(0)} -> ` +
           `${endNow.x.toFixed(0)} on x, which means it went through the team door`);
      } else {
        bad(`the player is still in the spawn room (${spawnPt.x.toFixed(0)} -> ` +
            `${endNow.x.toFixed(0)}): the door is blocked`);
      }
    }

    /* Check 4: the flag-to-flag RUN, for real.
     *
     * Each leg is a walkable route from scripts/map_route.py (a hull-sized flood
     * fill over the map's own boxes, so it cannot pass through a wall), walked by
     * holding W with the heading dictated server-side. The positions asserted are
     * the server's own.
     *
     * A leg only counts as walked when the SERVER saw the player within `reach` of
     * the key. If the steering is broken -- and it was, three times -- this is where
     * it shows up, as a leg that stops short rather than as a pass. */
    const startHere = { x: spawnPt.x, y: spawnPt.y, z: spawnPt.z };
    const inBaseA = startHere.x < M.mid;
    const ownKey = inBaseA ? M.flagA : M.flagB;
    const enemyKey = inBaseA ? M.flagB : M.flagA;
    ok(`the player spawned in base ${inBaseA ? 'A' : 'B'} at ` +
       `(${startHere.x.toFixed(0)}, ${startHere.y.toFixed(0)}), so its own key is ` +
       `(${ownKey.x}, ${ownKey.y}) and the enemy's is (${enemyKey.x}, ${enemyKey.y})`);

    async function leg(from, to, label, shotIndex) {
      let wps;
      try {
        wps = route([from.x, from.y, from.z], [to.x, to.y, to.z]);
      } catch (e) {
        bad(`${label}: ${e.message}`);
        return false;
      }
      const len = wps.reduce((acc, p, i) =>
        i ? acc + Math.hypot(p[0] - wps[i - 1][0], p[1] - wps[i - 1][1]) : 0, 0);
      ok(`${label}: a walkable route exists (${wps.length} waypoints, ` +
         `${len.toFixed(0)} units)`);

      const before = (parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner') || []).length;
      const r = await client.steer(wps, server, LOG, 'runner',
        { timeoutMs: 150000, arriveWithin: 56 });
      server.log = fs.readFileSync(LOG, 'utf8');
      const pts = parsePositions(server.log).get('runner') || [];
      const during = pts.slice(before);
      const moved = pathLength(during);

      /* The steering has to actually turn the player, or "walked" means
       * "walked in a straight line until something stopped it". The probe's yaw
       * is the server's own view of the player, so a follow here is proof. */
      const yaws = new Set(during.map(p => Math.round(p.yaw / 15) * 15));
      if (yaws.size > 1) {
        ok(`${label}: the server turned the player (${yaws.size} distinct headings ` +
           `in the probe: ${[...yaws].sort((a, b) => a - b).join(', ')} deg)`);
      } else {
        bad(`${label}: the player's heading never changed (one heading, ` +
            `${[...yaws].join(',')} deg): the steering did not take`);
      }
      if (moved > 100) ok(`${label}: travelled ${moved.toFixed(0)} units on the server's positions`);
      else bad(`${label}: only travelled ${moved.toFixed(0)} units`);
      if (shotIndex) await client.screenshot(path.join(SHOTS, `${shotIndex}-${label}.png`));

      /* The point of the leg: the server saw the player AT the key. */
      let best = null, bd = Infinity;
      for (const p of during.length ? during : pts) {
        const d = Math.hypot(p.x - to.x, p.y - to.y, p.z - to.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (bd <= M.reach) {
        ok(`${label}: the server saw the player at the key ` +
           `(${best.x.toFixed(0)}, ${best.y.toFixed(0)}, ${best.z.toFixed(0)}), ` +
           `${bd.toFixed(0)}u from it`);
        return true;
      }
      bad(`${label}: the player never reached the key; closest ${bd.toFixed(0)}u at ` +
          `(${best ? best.x.toFixed(0) : '?'}, ${best ? best.y.toFixed(0) : '?'}, ` +
          `${best ? best.z.toFixed(0) : '?'}), reached ${r.reached.length}/${wps.length - 1} waypoints`);
      return false;
    }

    const walkedOwn = await leg(startHere, ownKey, 'spawn-to-our-key', '03');
    /* Each leg starts where the player ACTUALLY is, not at the key the previous
     * leg aimed for. A leg that fell short otherwise aims the next route at a
     * place the player never was, and the run wanders: measured, the second leg
     * started 259 units from where the player was standing. */
    const here = () => {
      const p = (parsePositions(fs.readFileSync(LOG, 'utf8')).get('runner') || []);
      return p.length ? { x: p[p.length - 1].x, y: p[p.length - 1].y, z: p[p.length - 1].z }
                      : startHere;
    };
    const walkedEnemy = await leg(here(), enemyKey, 'our-key-to-enemy-key', '04');
    const walkedHome = await leg(here(), ownKey, 'enemy-key-back-home', '05');

    if (walkedOwn && walkedEnemy && walkedHome) {
      ok('FLAG TO FLAG AND BACK: all three legs reached on the server\'s own positions');
    } else {
      bad('the flag-to-flag run did not complete (see the legs above)');
    }

    await client.screenshot(path.join(SHOTS, '02-after-run.png'));

    /* Record the whole trace, so the run can be inspected and not only asserted. */
    const finalPos = parsePositions(server.log);
    const trace = [];
    for (const [name, seq] of finalPos) {
      for (const p of seq) trace.push({ player: name, ...p });
    }
    fs.writeFileSync(path.join(SHOTS, 'trace.json'), JSON.stringify({
      map: 'ctf', flags: { A: M.flagA, B: M.flagB }, samples: trace.length,
      points: trace,
    }, null, 1));
    ok(`wrote ${trace.length} server-side position samples to ` +
       `tests/artifacts/flag_run/trace.json`);

    /* Check 5b: the whole trace is inside the map. One sample outside means the
     * probe is reading something other than the player origin. */
    const outside = trace.filter(p => p.x < -64 || p.x > M.CTF_LEN + 64 ||
                                      p.y < 0 || p.y > 1024 || p.z < -300 || p.z > 512);
    if (!outside.length) ok('every server-side sample is inside the map bounds');
    else bad(`${outside.length} samples are outside the map: ${JSON.stringify(outside.slice(0, 3))}`);

    /* Check 6: screenshots exist and are not blank. A blank PNG is a black
     * canvas, which is what a client that never connected produces. */
    for (const f of fs.readdirSync(SHOTS).filter(f => f.endsWith('.png'))) {
      const buf = fs.readFileSync(path.join(SHOTS, f));
      /* A uniform image compresses tiny; a real view of a lit map does not. */
      if (buf.length > 20000) ok(`screenshots/${f} is ${(buf.length / 1024).toFixed(0)} KB, not a blank canvas`);
      else bad(`screenshots/${f} is only ${buf.length} bytes -- probably a black canvas`);
    }

  } finally {
    if (client) await client.stop();
    if (page) { try { process.kill(-page.pid, 'SIGKILL'); } catch (e) { try { page.kill('SIGKILL'); } catch (e2) {} } }
    await server.stop();
  }

  console.log('');
  console.log(failed ? `FAIL: ${failed} checks` : 'PASS');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });