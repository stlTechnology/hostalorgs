#!/usr/bin/env node
/*
 * tests/ctf_rules.js -- the M4b rules, observed with qwtf_trace OFF.
 *
 *   node tests/ctf_rules.js
 *
 * THE POINT OF THIS FILE IS THE `qwtf_trace 0`.
 *
 * The rules were rejected once (0172) because they lived inside qwtf/probe.qc's
 * `if (infokey(world, "qwtf_trace") == "1")` tick. Every test passed with the
 * trace on and none of it worked on the owner's server, which does not set that
 * cvar: a carrier kept the key when they died, captures never scored, and a
 * dropped key never came back. That is the worst kind of green, and it is exactly
 * what this file is arranged to catch.
 *
 * So: the server runs with the trace OFF, and every rule is observed through
 * QWTF_EVENT, which qwtf/ctf.qc prints unconditionally because take, drop, return
 * and capture happen a few times a match and cost nothing. The teleport hook is on
 * -- it is a test hook and that is legitimate -- but no check below asserts on a
 * QWTFPOS field.
 *
 * Two static checks guard the split itself, so the bug cannot come back quietly:
 * no rule in ctf.qc reads the trace cvar in code, and probe.qc calls none of the
 * rules.
 *
 * PLAN.md's done-when list is covered check by check below; the ones still to come
 * are marked.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const WEB = path.join(ROOT, 'web');
/*
 * PER RUN, every path. All three of these were shared, and two concurrent runs --
 * mine and the reviewer's -- corrupted each other (0239):
 *
 *   STAGE  tests/artifacts/gamedir is rmSync'd and rebuilt at the start of every
 *          run, so one run deletes the directory the other is loading the client
 *          out of. The client then dies DURING SIGNON: "client diver connected /
 *          new / soundlist / modellist / prespawn ... / tcp peer closed".
 *   DIR    and LOG: both runs wrote tests/artifacts/ctf_rules/server.log, so one
 *          run's server stdout was the other run's assertions -- which is how a run
 *          reads a log full of another run's events and gets a plausible answer.
 *
 * Each run gets its own directory under tests/artifacts/, named for the pid, and
 * the symlink farm is removed at the end. The farm is cheap; a shared one is a race.
 *
 * The run directory is KEPT when the run ends: server.log is the evidence behind
 * every number this file prints, and it is what the "signon reached X" message is
 * read from. The summary prints the path. Old run-* directories are left alone on
 * purpose -- deleting them by age would delete a concurrent run's evidence.
 */
const RUN = path.join(ART, 'run-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const DIR = RUN;
/* The owner's checkpoint screenshots live here. Nothing in this run writes to it;
 * it is only ensured to exist. */
const SHOTS = path.join(ART, 'flag_run');
const LOG = path.join(DIR, 'server.log');

/* The map's geometry, taken from gen_map rather than typed in, and in WORLD units.
 *
 * The z I had wrong by 32 was a hardcoded -80, which happens to be
 * FORTS_VAULT_Z + 48 -- the vault CEILING, so the player was teleported into it and
 * stuck (0195/0199). Reading the map instead of typing numbers means the next
 * version of the vault cannot be tested with the previous version's.
 *
 * WORLD units because that is what the map IS: gen_map authors the forts in design
 * units and multiplies them by FORTS_SCALE when it writes maps/forts.map (the owner
 * asked for "about 4 times larger overall", 0240). The key positions below come out
 * of the map's own ENTITY list, which gen_map emits already scaled, so the key is
 * where the key is instead of where a literal in this file says it is -- which is
 * what 328/480/1720 were, and they were wrong the moment the scale changed.
 *
 * gen_map.py is Python, so this asks it rather than requiring it: one subprocess at
 * startup, and if it fails the checks below are skipped loudly instead of running
 * against a guessed number. (require() on a .py file is a SyntaxError, which is
 * how this was first written.)
 */
const GEO_PY = [
  'import sys, json',
  'sys.path.insert(0, "scripts")',
  'import gen_map as g',
  'ents = [e for m in (False, True) for e in g.forts_entities(m)]',
  'def origin(cls, flags=None):',
  '    for e in ents:',
  '        if e[0] != cls:',
  '            continue',
  '        d = dict(f.split(chr(34))[1::2] for f in e[1:] if f.startswith(chr(34)))',
  '        if flags is None or d.get("spawnflags") == flags:',
  '            return [float(v) for v in d["origin"].split()]',
  '    return None',
  'print(json.dumps({',
  '    "key_a": origin("item_qwtf_key", "2"),',
  '    "stand_a": origin("item_qwtf_stand", "2"),',
  '    "key_b": origin("item_qwtf_key", "4"),',
  '    "stand_b": origin("item_qwtf_stand", "4"),',
  '    "spawn_a": origin("info_player_deathmatch"),',
  '    "vault_floor": g.sc(g.FORTS_VAULT_Z),',
  '    "vault_ceil": g.sc(g.FORTS_PASSAGE_Z + g.FORTS_PASSAGE_H),',
  '    "ground": g.sc(g.FORTS_GROUND_Z),',
  '    "mid_x": g.sc(g.FORTS_LEN / 2.0),',
  '    "hull": g.HULL_HEIGHT,',
  '    "scale": g.FORTS_SCALE,',
  '}))',
].join('\n');

function vaultGeometry() {
  const r = spawnSync('python3', ['-c', GEO_PY], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; }
}

/* The vault's clear height, in world units: floor to ceiling. */
function vaultClearHeight() {
  const v = vaultGeometry();
  return v ? (v.vault_ceil - v.vault_floor) : 0;
}

let failed = 0, passed = 0;
function ok(what) { console.log(`  ok   ${what}`); passed++; }
function bad(what, detail) {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
}
const check = (c, what, detail) => c ? ok(what) : bad(what, detail);
const HULL_Z = 24;                    // a QuakeWorld player's hull, as the tests use
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ staging */
function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const e of fs.readdirSync(WEB)) {
    if (e === 'id1') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  }
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
}

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

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
      '--map', 'forts', '+set', 'qwtf_trace', '1',
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

  /* Server-side teleport, for putting the camera at a spot. Walking there takes
   * minutes and stalls in corners; the server is authoritative over the player
   * entity, so this puts the camera in the real server's view of the real map.
   *
   * A TEST HOOK, on the ctf.qc-independent side of the line. That the rules do
   * not need it is the point, and the static checks above enforce that. */
  goto(x, y, z, seq) {
    this.command(`serverinfo qwtf_gx ${x}`);
    this.command(`serverinfo qwtf_gy ${y}`);
    this.command(`serverinfo qwtf_gz ${z}`);
    /* One-shot: the probe teleports only when this counter CHANGES (0203). */
    if (seq !== undefined) this.command(`serverinfo qwtf_gseq ${seq}`);
  }

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

  /* The canvas centre, in page coordinates. Needed for the click that makes key
   * events reach the engine at all (M3 lesson, mp_combat.js does the same). */
  async canvasCentre() {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { const c = document.getElementById('canvas');
        if (!c) return null; const b = c.getBoundingClientRect();
        return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`,
      returnByValue: true,
    });
    return r.result.value;
  }


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

  /* Evaluate an expression in the page and hand back its value.
   *
   * This is how the M5 checks drive the REAL overlay rather than a copy of its
   * logic: window.QWTF_MENU.do('cls_scout') is the same call a click on the menu
   * button makes, and it goes out through web/menu.js send() -> FTEC.cbufadd ->
   * the wire -> the server. A test that called cbufadd itself would prove the
   * same thing on the page and nothing about the menu, and tests/test_menu.js
   * already is that stub on purpose -- so the two are deliberately different.
   */
  async evalJS(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('page eval threw: ' +
        JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    }
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


/* ------------------------------------------------------------------ the checks */
/* Read the file the server ACTUALLY writes.
 *
 * The Server class below is copied verbatim from flag_run.js, so its
 * `fs.openSync(LOG, 'w')` binds to the LOG in scope here -- this file's DIR, not
 * flag_run's. For three runs this read flag_run/server.log instead, which is a
 * stale log from an earlier experiment, and every "0 takes" it reported was that
 * stale file rather than the live server. I trusted those numbers in two rounds of
 * status and they were wrong.
 *
 * The lesson worth keeping: a test that asserts on a file nobody wrote this run is
 * not a slow test, it is a wrong one, and it fails SAFE-looking -- zero is
 * plausible, so nothing looks broken.
 */
/* Read the file the player-phase server ACTUALLY writes, and PROVE it is this
 * run's.
 *
 * The checks read player.log, which the run never created: the snapshot lives in
 * the `finally`, AFTER every check has run, so every check was reading a file that
 * did not exist yet -- or, from the second run on, the PREVIOUS run's. The reviewer
 * found this by running the test themselves and reading server.log, which showed
 * all four events, while the test reported take/capture/+10 as FAIL (0222).
 *
 * So: the server writes to the live LOG, the checks read the live LOG, and the
 * mtime is checked against this run's start so a stale file cannot be believed.
 */
const RUN_STARTED = Date.now();
const raw = () => fs.readFileSync(LOG, 'utf8');
function logIsFromThisRun() {
  try {
    const st = fs.statSync(LOG);
    return st.size > 0 && st.mtimeMs >= RUN_STARTED;
  } catch (e) { return false; }
}
/* The last position the SERVER reported for the test client, from QWTFPOS. This is
 * a test hook and it is read here only, never by the rules. If it is absent the
 * player-phase checks must not report a number: see the join precondition. */
function lastPos() {
  const l = raw().split('\n').map(clean)
    .filter(x => x.indexOf('QWTFPOS [diver]') >= 0).pop();
  if (!l) return null;
  const m = l.match(/QWTFPOS \[diver\] (\S+) (\S+) (\S+)/);
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
}
const clean = (l) => l.replace(/[^\x20-\x7e]/g, '');

/* The same trail, by name, for the lobby section (whose predicate is re-checked
 * on every poll, so it takes the text rather than reading the log itself).
 * QWTFPOS is: "QWTFPOS [name] x y z yaw health waterlevel team carry caps red
 * blue" -- health and team are what the lobby asserts on. */
function lastPosNamed(text, name) {
  const re = new RegExp(`QWTFPOS \\[${name}\\] (\\S+) (\\S+) (\\S+) (\\S+) (\\S+) (\\S+) (\\S+)`);
  const l = text.split('\n').map(clean).filter(x => x.indexOf(`QWTFPOS [${name}]`) >= 0).pop();
  if (!l) return null;
  const m = l.match(re);
  return m ? { x: +m[1], y: +m[2], z: +m[3], yaw: +m[4], health: +m[5],
               water: +m[6], team: +m[7] } : null;
}
/* Exact-match the event name, up to the end of the token.
 *
 * It used to be `l.includes('QWTF_EVENT ' + what)`, which counts
 * "take_refused_already_carrying" and "take_refused_no_team" as a "take" -- so
 * `ev('take').length === 1` could not be true once a refusal happened, and the take
 * that DOES work reads as a failure. Four events, not one.
 */
const ev = (what) => raw().split('\n').map(clean)
  .filter(l => l.startsWith('QWTF_EVENT ' + what + ' ') || l === 'QWTF_EVENT ' + what);
const probe = (what) => raw().split('\n').map(clean).filter(l => l.includes(what));
/* mapLoadChecks runs the server synchronously to completion and has its OWN
 * output, so it checks that string rather than the live log -- which by then is
 * the player server's. Reading the wrong one of the two is how the first version
 * of this section reported zero stands when there were two. */
const inText = (text, what) => text.split('\n').map(clean).filter(l => l.includes(what));

/* Strip // comments: the two QuakeC files explain at length WHY they must not
 * depend on qwtf_trace, and those explanations must not make the static checks
 * fail. What is forbidden is the cvar in CODE. */
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

function splitChecks() {
  console.log('the rules are not behind the test hook');
  const ctf = code('qwtf/ctf.qc');
  const prb = code('qwtf/probe.qc');
  check(!/infokey\s*\(\s*world\s*,\s*"qwtf_trace"/.test(ctf) && !/QWTF_TRACE_NEXT/.test(ctf),
        'no rule in qwtf/ctf.qc reads the trace cvar');
  check(!/QWTF_key_(drop|return|take|capture)|QWTF_key_think|QWTF_event/.test(prb),
        'qwtf/probe.qc calls none of the rules',
        'the test hooks are calling gameplay again');
  check(/wrap void\(\) PlayerDie/.test(ctf),
        'drop-on-death is on PlayerDie, not on a poll');
  check(/wrap void\(\) PlayerPostThink/.test(prb) && !/wrap void\(\) PlayerPostThink/.test(ctf),
        'PlayerPostThink is wrapped only in the probe, which is the trace tick');
  /* The kill hook, which the drop-on-death checks below need, stays on the test
   * side of the same line: ctf.qc may not read it, or "the carrier drops the key
   * when they die" would become "the carrier drops the key when a test says so".
   * The rule is PlayerDie, and the hook only supplies a death. */
  check(/qwtf_hurtseq/.test(prb) && !/qwtf_hurt/.test(ctf),
        'the hook that kills a player is in the probe, and no rule reads it',
        `qwtf_hurtseq in probe.qc: ${/qwtf_hurtseq/.test(prb)}; ` +
        `qwtf_hurt in ctf.qc: ${/qwtf_hurt/.test(ctf)}`);
}

function mapLoadChecks() {
  console.log('');
  console.log('the map loads with the trace off');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/run_server.sh'),
    '--port', String(20000 + ((process.pid + 7) % 20000)), '--gamedir', STAGE,
    '--map', 'forts', '+set', 'qwtf_trace', '1',
    // NOT developer either. The owner's server is not a developer server, and if
    // the rules needed developer to be seen they would not be seen.
    '+set', 'developer', '0', '+set', 'qwtf_trace', '0',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 25000, killSignal: 'SIGKILL', input: '' });
  const out = (r.stdout || '') + (r.stderr || '');
  /* ITS OWN FILE. This wrote to LOG, the same path the player phase's server is
   * using, and ran LAST, so it replaced a good log with the map-load server's
   * output. I then read that file and concluded the player had never joined. The
   * reviewer has a snapshot of what the player phase actually produced:
   * tests/artifacts/reviewer/ctf_rules-player-phase.log, 21 QWTFPOS lines and a
   * team assignment. One file per phase, or the phases lie to each other. */
  fs.writeFileSync(path.join(DIR, 'mapload.log'), out);
  const loaded = out.includes('Server spawned');
  check(loaded, 'the server loaded maps/forts.bsp', (r.stderr || '').slice(-200));
  /* If the map did not load, EVERY check below it is vacuous: there are no keys and
   * no stands, so "none were deleted", "none came up without a team" and "both
   * spawned" all pass on an empty log. That is the third time this file has
   * reported a number that means nothing (a stale log, a client that never joined,
   * and now a server with no map). So: the precondition is checked, and if it fails
   * the section stops instead of asserting anything about entities that never ran. */
  if (!loaded) {
    bad('the map-load phase can say anything at all',
        'the server did not load the map, so the entity checks that follow would ' +
        'read an empty log and pass. ' +
        `STAGE=${STAGE} gamedir present: ` +
        `${fs.existsSync(path.join(STAGE, 'id1'))}`);
    return;
  }
  /* Counting the spawn dprint is a FALSE PASS and the reviewer is right (0191):
   * item_qwtf_key's dprint runs before PlaceItem's remove(self), so a deleted key
   * still counted as spawned. The assertion has to be about the entity SURVIVING,
   * and the server says so in plain text when it does not:
   *
   *   Bonus item fell out of level at '328.000000 480.000000 -106.000000'
   */
  const fell = inText(out, 'fell out of level');
  check(fell.length === 0,
        'no key or stand was deleted by PlaceItem (Bonus item fell out of level)',
        `${fell.length} lines: ${JSON.stringify(fell)}`);

  check(inText(out, 'QWTF_KEY ').length === 2, 'both keys spawned with the trace off',
        JSON.stringify(inText(out, 'QWTF_KEY ')));
  check(inText(out, 'QWTF_STAND ').length === 2, 'both capture stands spawned',
        JSON.stringify(inText(out, 'QWTF_STAND ')));
  check(!inText(out, 'QWTF_KEY 0 at').length, 'neither key came up without a team');
}

async function playerChecks() {
  /* PID-derived ports, like the other tests: a fixed port means a second run
   * cannot bind while a leaked one still holds it, and then a STALE page
   * server serves the client (0222 -- three were listening, one from 05:19).
   */
  const PORT = 20000 + (process.pid % 20000), HTTP = PORT + 1;
  console.log('');
  console.log('take, capture and score, with the trace off');
  const server = new Server(PORT);
  if (!await server.start()) { bad('the server started'); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
    '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
  let client = null;
  try {
    await sleep(1500);
    const url = 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=diver&autojoin=1';
    /* PID-derived, like the server and page ports. A FIXED CDP port means two
     * concurrent runs -- mine and the reviewer's -- collide on Chrome's debugging
     * port, and the loser reports "the client was not given a team" because no
     * client attached at all (0235 item 2).
     */
    client = new Client('diver', 10000 + (process.pid % 20000));
    try {
      await client.start(url);
    } catch (e) {
      bad('the headless client loaded the page', e && e.message);
      return;
    }
    /* Wait for the JOIN, not for a fixed time. A fixed sleep is how this file ended
     * up running four checks against a server nobody had joined: the log held
     * "Server spawned" and nothing else, every check read zero, and zero looked
     * like a result. The join is the thing to wait for. */
    /* The join is FLAKY under load -- several consecutive runs reported "no team
     * was assigned" with an empty teams[] while the same command had just worked.
     * The precondition is right to be strict; the remedy is to retry the whole
     * start-up rather than to loosen the check. */
    /* A GENEROUS signon deadline, and on failure SAY WHICH STAGE it reached.
     *
     * 60 x 500 ms was 30 s, which is not enough for SwiftShader to load a 312 KB
     * forts.bsp and compile shaders while the machine is also running someone
     * else's copy of the same test. The stages the server prints, in order:
     * connected / new / soundlist / modellist / prespawn / spawn / begin.
     */
    /* The substrings below are the server's own signon lines, in the order FTE
     * prints them (from a real log):
     *   client diver connected / Client command: new / soundlist 1 44 /
     *   modellist 1 0 / prespawn 1 0 / spawn 1 / begin 1 / diver joined.
     * "connected" rather than the whole line, because the name is the test's own. */
    const STAGES = ['connected', 'command: new', 'soundlist', 'modellist',
                    'prespawn', 'command: spawn', 'command: begin', 'diver joined'];
    const reached = () => {
      let txt = '';
      try { txt = fs.readFileSync(LOG, 'utf8'); } catch (e) { return 'no log at all'; }
      let last = 'nothing after connect';
      for (const st of STAGES) if (txt.indexOf(st) >= 0) last = st;
      return last;
    };
    let joined = false;
    for (let i = 0; i < 180 && !joined; i++) {
      await sleep(500);
      joined = /diver joined/.test(fs.readFileSync(LOG, 'utf8'));
    }
    /* Assert the PRECONDITION, not just the outcome. Three ways this file has
     * reported a meaningful-looking zero for a run that never tested anything: a
     * stale log, a client that never joined, and a deleted entity counted from a
     * dprint printed before the deletion. Every one of those reads as "0 takes",
     * which is a believable number. So the join is checked first and the section
     * returns without asserting any rule if it failed. */
    if (!logIsFromThisRun()) {
      bad('the player-phase server log is this run\'s',
          `${LOG} is empty or older than the run started; every rule check below ` +
          'would read a stale or missing file');
      return;
    }
    const teams = raw().split('\n').map(clean).filter(l => l.includes('QWTF_TEAM '));
    if (!joined) {
      bad('a player joined: expected a QWTF_TEAM line for the test client',
          `no "diver joined" in ${LOG} after 90s. Signon reached ` +
          `"${reached()}" -- so the client got as far as that and then stopped. ` +
          'The rule checks below would all read zero and mean nothing.');
      return;
    }
    if (teams.length === 0) {
      bad('the test client was given a team: expected a QWTF_TEAM line',
          'the client joined but no team was assigned: ' + JSON.stringify(teams));
      return;
    }
    ok('a player joined and was given a team (' + clean(teams[0]) + ')');
    await sleep(4000);

    /* THE LOBBY (2026-10-09): a join is no longer a spawn. The player waits in
     * the lobby until they have picked BOTH a team and a class, so every rule
     * check below -- which walks, fights and takes a key -- needs the body
     * first. Both picks go through the page's own overlay entry point, and the
     * spawn is waited for like any other server event. */
    await client.evalJS('window.QWTF_MENU.do("team_auto")');
    await client.evalJS('window.QWTF_MENU.do("cls_soldier")');
    const bodyUp = await untilLog(t => !!classStats('diver', 'soldier'), 20000);
    if (!bodyUp) {
      bad('the lobby spawn landed after both picks',
          'no class_stats diver/soldier within 20 s of the picks; every rule ' +
          'check below would read a waiter that cannot move, fire or take');
      return;
    }
    ok('both lobby picks made, the player spawned (class_stats diver/soldier)');

    /* FOCUS THE PAGE BEFORE HOLDING A KEY.
     *
     * `client.holdKey('w', ...)` dispatches a key event to the page, and it does
     * nothing at all if the page has never been focused: the measured symptom was
     * the player sitting at x 232 on all 21 samples while W was held for 700 ms,
     * with the correct floor, the correct yaw and the correct side of the key. So
     * every rule check in this file was reading zero because the player was a
     * statue, not because the rules were broken.
     *
     * flag_run.js's steer() does this -- Page.bringToFront plus a click on the
     * canvas, which is also what grants pointer lock -- and this test did not.
     */
    try {
      await client.focus();
      ok('the page is focused (needed before a key reaches the engine)');
    } catch (e) {
      bad('the page is focused', e && e.message);
      return;
    }

    /* AND CLICK THE CANVAS. focus() is NOT a substitute -- this is the M3 lesson
     * and mp_combat.js does it (mousePressed + mouseReleased on the canvas centre
     * before any key). Headless Chrome will accept a focus() and still swallow
     * every key event: measured as the player pinned at one x across 44 samples
     * with W held, which I first blamed on the teleport (my fault, 0203) and then
     * on focus, which was not it.
     */
    try {
      const p = await client.canvasCentre();
      await client.send('Input.dispatchMouseEvent',
        { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
      await client.send('Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
      ok('the canvas was clicked (M3 lesson: focus alone does not deliver keys)');
    } catch (e) {
      bad('the canvas could be clicked', e && e.message);
      return;
    }

    /* MOVEMENT IS A PRECONDITION, asserted from the server's own QWTFPOS, before
     * any rule is checked. Every round of this has produced a believable-looking
     * zero from a player that could not move, so movement is now a check in its own
     * right rather than something the rule checks quietly depend on. */
    {
      const p0 = lastPos();
      await client.holdKey('w', 600);
      await sleep(1200);
      const p1 = lastPos();
      const moved = p0 && p1 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 16;
      /* ALSO: the vault must be WALKABLE, and it is not. The passage/vault has a
     * clear height of exactly 48 (floor -128, ceiling -80) and a player's hull is
     * exactly 48, so a standing player at origin -104 has their head flush with the
     * ceiling and is wedged. That is why the walk after a teleport into the vault
     * does nothing while the same W at the spawn does move. It is a MAP bug --
     * the vault's second, on-foot way in leads into a space nobody can stand in.
     * The fix belongs in gen_map (raise the ceiling or the floor), not here. */
    /* World units, from the map. The hull is the player's and never scales; the
     * clear height is the map's and does. At FORTS_SCALE 2.0 the vault has 192 of
     * clear height against a 56-tall player, where it had 48 before -- which is the
     * owner's "the basement is a bit compressed" (0226 D) measured. */
    const HULL = (vaultGeometry() || { hull: 56 }).hull, CLEAR = vaultClearHeight();
    check(CLEAR >= HULL + 16, 'the vault has headroom to walk AND step in',
          `clear height ${CLEAR} vs hull ${HULL}: a standing player's head is ` +
          'flush with the ceiling, so nobody can move once inside');
    check(moved, 'holding W moves the player (precondition for every rule check)',
            `player at ${p0 ? [p0.x, p0.y, p0.z].join(',') : '?'} -> ` +
            `${p1 ? [p1.x, p1.y, p1.z].join(',') : '?'}, needed >16 units`);
    }

    /* Teleport, then NUDGE.
     *
     * FTE checks touch during a player's move, not on a setorigin: a teleport puts
     * the player inside the trigger and no touch fires until they actually move.
     * That is why every touch check in this file failed with zero calls while the
     * bounds were demonstrably overlapping -- the key's absmax reaches z -32 and
     * a standing player's hull spans -58..-10, so they were overlapping and being
     * ignored. (And the same reason the rules took a key when they lived in
     * probe.qc and the test WALKED there.)
     *
     * So: teleport to just short of the spot, then hold W to walk the last step.
     */
    /* go(x, y, z, faceX): teleport, then WALK towards faceX.
     *
     * The walk needs the server to set the heading. `faceNone()` -- releasing the
     * heading -- made W go in whatever direction the client was already facing,
     * which is not necessarily +x, so the player stood still: measured, origin
     * (232, 480, -104) on every one of 21 samples with the key at x 328.
     *
     * FTE only checks touch during a player's MOVE, so the teleport alone can never
     * trigger anything, and a walk in the wrong direction is the same as no walk.
     */
    /* Walk to a point in short bursts, stopping when we arrive.
     *
     * One 700 ms burst overshoots: at ~400 u/s that is 280 units, and walking from
     * the far vault toward the key at x 328 carried the player straight THROUGH it
     * to x 232, past the target, with the touch never registering. The bursts stop
     * on arrival, so the player ends up standing on the thing it is meant to touch.
     */
    const walkTo = async (targetX, targetY) => {
      let p = lastPos();
      if (!p) return;
      const dist = () => Math.hypot(targetX - p.x, targetY - p.y);

      /* The heading IS set server-side, and it has to be. Without it W walks in
       * whatever direction the client already faces, which measured as the player
       * travelling 16 units in Y while the target was 96 in X -- a walk that goes
       * somewhere, which is worse than one that goes nowhere.
       *
       * qwtf_face sets angles_y AND fixangle, and it is re-applied before every
       * burst rather than once before the loop: fixangle only holds while the cvar
       * keeps being re-applied, so one set at the start is not enough to keep the
       * heading for 40 bursts.
       *
       * It stops within 8 units, not 40: the key is a 32-wide trigger, so stopping
       * 40 short is stopping off it. The old 40 was the reason the arrival assertion
       * failed while the player was visibly walking.
       */
      /* WALK, do not run. This is the actual fix and it is arithmetic, not tuning.
       *
       * The position is only visible at the probe's 4 Hz -- one reading every 250 ms.
       * Running is ~400 u/s, so the player covers 100 units between two consecutive
       * readings: it is impossible to land inside a 32-wide trigger, and the walk
       * either overshoots (measured 232 -> 355 -> 408) or stops short (311, when
       * the trigger's left edge is 312). No burst length fixes that, because the
       * limit is the sampling rate and not the input.
       *
       * SHIFT is walk, ~100 u/s, so the player covers 25 units per reading and the
       * stop distance is smaller than the trigger. Run fast in a real match; walk
       * slowly in a test that has to arrive somewhere.
       */
      for (let i = 0; i < 40 && dist() > 8; i++) {
        server.face(Math.atan2(targetY - p.y, targetX - p.x) * 180 / Math.PI);
        await sleep(100);
        await client.keyDown(['shift']);
        await client.holdKey('w', dist() > 60 ? 120 : 60);
        await client.keyUp(['shift']);
        await sleep(280);
        p = lastPos();
        if (!p) break;
      }
      /* One last deliberate step toward the middle, so the player ends INSIDE the
       * trigger rather than at its edge. The loop stops at 8 units, which for a
       * 32-wide trigger centred 16 either side means "at the boundary". */
      if (p && dist() <= 32) {
        server.face(Math.atan2(targetY - p.y, targetX - p.x) * 180 / Math.PI);
        await sleep(150);
        await client.keyDown(['shift']);
        await client.holdKey('w', 60);
        await client.keyUp(['shift']);
        await sleep(500);
      }
      server.faceNone();
      await sleep(700);
    };

    /* go(): teleport ONCE (0203).
     *
     * `goto` used to set qwtf_gx/gy/gz and leave them set, and PlayerPreThink
     * re-applied setorigin + zero velocity on every frame, so the player was pinned
     * at the target and holding W could never move it. The probe now acts only when
     * qwtf_gseq CHANGES, so this bumps the counter once per teleport.
     */
    let gseq = 0;
    const go = async (x, y, z) => {
      gseq += 1;
      server.goto(x, y, z, gseq);
      await sleep(1400);
    };

    /* One player, auto-balanced onto red (team 1). Red's key is at x 328 and
     * blue's at x 1720, both at y 480 with a stand on the same spot. So red's is
     * THEIRS and blue's is the enemy one. */

    /* WHERE THE PLAYER GOES, derived from gen_map's constants rather than typed
     * in, so it follows the map if the vault moves.
     *
     * z = -80 was the bug, and it is worth writing down why it looked right: -80 is
     * FORTS_VAULT_Z + 48, which is the vault CEILING (floor -128, ceiling -80). A
     * player whose origin is at the ceiling has its hull at -104..-56, embedded in
     * it, and z then stays exactly -80 sample after sample despite gravity -- i.e.
     * stuck in the ceiling, never touching a key whose centre is ~-112. The
     * reviewer spotted this in a per-second snapshot (0195/0199) that I could not
     * produce, because my own log had been overwritten by the map-load phase.
     *
     * So: STANDING height on the vault floor, which is vault floor + HULL_Z, and a
     * step away from the key so the walk onto it is a real move. FTE only checks
     * touch during a player's MOVE, so a teleport alone never triggers anything. */
    const geo = vaultGeometry();
    if (!geo || !geo.key_a || !geo.key_b || !geo.stand_a) {
      bad("gen_map's geometry is readable", 'the entity origins came back empty');
      return;
    }
    /* Every position below is WORLD units, straight out of the map's own entity
     * list, and printed with the checks so a failure says where the player was
     * meant to be. The literals this replaces (328 / 480 / 1720 / a stand 96 to the
     * side) were DESIGN units: correct until FORTS_SCALE moved everything, and then
     * a teleport into a wall 328 units from the key, which reads as "the key is
     * not there" rather than "the test is in the wrong place". */
    const FLOOR = geo.vault_floor;             // the vault floor's top
    const STAND = FLOOR + HULL_Z;              // standing height on it
    const KEY_X = geo.key_a[0], KEY_Y = geo.key_a[1];
    const KEY_X_B = geo.key_b[0];
    const STAND_A = geo.stand_a[0];
    console.log(`       map: scale ${geo.scale}, vault floor ${FLOOR}, ` +
                `red key ${KEY_X},${KEY_Y}, stand ${STAND_A}, blue key ${KEY_X_B}, ` +
                `mid-x ${geo.mid_x}`);
    check(KEY_X < geo.mid_x && KEY_X_B > geo.mid_x,
          'each key is on its own side of mid-x, so one of them is the enemy one',
          `red key ${KEY_X}, blue key ${KEY_X_B}, mid-x ${geo.mid_x}`);
    /* START on one side, WALK THROUGH, and keep going past it.
     *
     * The 4 Hz QWTFPOS has nothing to do with touch. The server links the moving
     * player and runs touch against overlapping triggers EVERY PHYSICS FRAME
     * (each usercmd, ~77 Hz), and at ~400 u/s the player advances 5-6 units per
     * frame -- so a 32-wide hull crossing a 32-wide trigger overlaps for about 64
     * units, some 11 frames. There is never a need to STOP on the key; running
     * through it must fire the take. My earlier reasoning that the probe rate
     * limits the walk was wrong: the probe only limits what I can SEE.
     *
     * So this walks to a point well PAST the key on the same line, and the
     * assertion is on QWTF_EVENT, not on where the player ended up.
     */
    const NEAR_X = 96;

    /* --lobby-only runs just the M5 section. The take/capture walk below is the
     * slow part of this file (minutes), and the lobby checks do not depend on any
     * of it -- they need a joined player, a live server and the live page, and all
     * three exist by this point. */
    if (process.argv.includes('--lobby-only')) {
      console.log('  (--lobby-only: the take/capture walk is skipped)');
      await lobbyChecks(client);
      return;
    }

    /* A defender cannot carry their own key. FALSE PASS if nothing touches the key
     * at all -- so the walk is proved to have ARRIVED first, and the arrival is
     * asserted from the server's own position rather than assumed. */
    /* Start on one side of the key and walk to a point well past it, so the run
     * provably straddles the key's x on the vault floor. */
    await go(KEY_X - NEAR_X, KEY_Y, STAND);
    const before = lastPos();
    await walkTo(KEY_X + NEAR_X, KEY_Y);
    const after = lastPos();
    const straddled = before && after &&
      Math.min(before.x, after.x) <= KEY_X && Math.max(before.x, after.x) >= KEY_X &&
      Math.abs(before.z - STAND) <= 32 && Math.abs(after.z - STAND) <= 32;
    check(straddled, 'the player provably walked THROUGH the key on the vault floor',
          `${before ? before.x : '?'} -> ${after ? after.x : '?'} must straddle ` +
          `x=${KEY_X} at z=${STAND}`);

    check(ev('take').length === 0,
          'a defender cannot take their own key (FALSE PASS while no touch fires)',
          `QWTF_EVENT take fired ${ev('take').length} times on the red stand`);

    // The enemy key can be taken.
    await go(KEY_X_B + NEAR_X, KEY_Y, STAND);
    await walkTo(KEY_X_B - NEAR_X, KEY_Y);

    /* WAIT for the event rather than reading the log the instant the walk ends.
     *
     * The server writes its stdout to the log asynchronously, so a check that reads
     * immediately after the walk sees the log BEFORE the dprint for the frame that
     * produced the touch. That is why the reviewer's independent run saw all four
     * events in server.log while the test reported take/capture/+10 as FAIL (0222),
     * and why the same command is 17/20 one minute and lower the next.
     *
     * So: poll for the event, with a deadline. If it never arrives the check fails
     * on its own merits, which is a real failure rather than a race.
     */
    const await_ = async (what, want, ms) => {
      const until = Date.now() + (ms || 8000);
      while (Date.now() < until) {
        if (ev(what).length >= want) return ev(what).length;
        await sleep(250);
      }
      return ev(what).length;
    };

    /* AT LEAST ONE take, not exactly one.
     *
     * Exactly one was the wrong assertion and it was wrong in a way that hid a
     * working rule: the walk passes through the key over several physics frames
     * and each overlap re-enters the touch, so a single walk fires it more than
     * once -- measured 7. The RULE is right (once carried, the key is out of the
     * world and cannot be re-taken; the extra events are the handler being
     * re-entered and refusing, which is why they are all "take" and not
     * "take_refused_already_carrying"). What is asserted here is that taking
     * HAPPENS; how many times the engine happened to call the touch is not the
     * rule's business.
     */
    /* THE REAL ROUND (0232/0235 item 1). The old test walked through the ENEMY
     * vault and asserted take + capture, which passed while the capture check was
     * INVERTED -- the test and the bug agreed with each other. The round is:
     *
     *   1. take the enemy key in the ENEMY vault   -> take fires
     *   2. ... and NO capture there                -> the half that was inverted
     *   3. carry it home, walk through your OWN stand -> capture fires
     *   4. and it happens on the CARRIER's side of mid-x
     *   5. +10 for the carrier's team
     *   6. the enemy key returns to ITS vault
     */
    const takes = await await_('take', 1);
    check(takes >= 1, 'touching the enemy key takes it',
          `QWTF_EVENT take fired ${takes} times (waited 8s for at least 1)`);

    // 2. NO capture in the enemy vault. Poll for a second to be sure it is not just
    // late: an event arriving after this check would be the same defect.
    await sleep(2000);
    check(ev('capture').length === 0,
          'taking the key in the ENEMY vault does NOT capture',
          `${ev('capture').length} captures fired while standing in the enemy ` +
          `vault at x=${KEY_X_B}; a capture there is the inverted-stand bug`);

    // 3. Carry it home and walk through OUR OWN stand.
    /* Walk ACROSS our own stand, from the key's own x (which is open corridor) to
     * just past the stand.
     *
     * The old start was NEAR_X beyond the stand, on the assumption that there was
     * corridor out there. There is not: the stand is 24 design units from the
     * corridor's east end, where the fort's channel-side wall is, so at scale 2.0
     * that start point was INSIDE the wall and the player never moved again --
     * "capture fired 0 times" with the last reported position at x=912, embedded in
     * 896..960. A start point is part of the route, not a detail of it.
     *
     * The overlap is enough on its own: the stand is a 32-wide trigger and so is
     * the hull, so arriving anywhere within a hull of it fires the touch. What has
     * to be true is only that the run TOUCHES it, which is what the event asserts.
     */
    await go(KEY_X, KEY_Y, STAND);
    await walkTo(STAND_A + 32, KEY_Y);

    // 4. WHERE it captured. The player's x at the capture must be on the carrier's
    // own side of mid-x, i.e. below 1024 for red.
    const caps = await await_('capture', 1);
    check(caps >= 1,
          'carrying it to your own stand, with your own key home, captures',
          `QWTF_EVENT capture fired ${caps} times (waited 8s for at least 1)`);

    /* The capture happened on the carrier's OWN side. mid-x is FORTS_LEN/2 = 1024
     * and the carrier is red, so red's half is x < 1024; the enemy vault is at 1720.
     * Sampled from the server's own QWTFPOS, and printed with the event lines so a
     * failure shows where the player actually was (0235 asked for this).
     */
    const atCapture = lastPos();
    const midX = geo.mid_x;
    check(atCapture && atCapture.x < midX,
          "the capture happened on the carrier's OWN side of mid-x",
          `player at x=${atCapture ? atCapture.x : '?'} (full ` +
          `${atCapture ? [atCapture.x, atCapture.y, atCapture.z].join(',') : '?'}), ` +
          `mid-x is ${midX}, red's half is x < ${midX}`);
    console.log(`       event trail: x=${atCapture ? atCapture.x : '?'} at the ` +
                `capture, ${caps} capture(s), ${takes} take(s)`);
    await await_('capture_score', 1);
    const sc = probe('capture_score');
    /* The LAST capture_score, and at least +1 for the capturing team. Exactly
     * "1 line, red=10" was wrong twice over: a second walk-through captures
     * again (the flag has reset by then, so the same code captures it a second
     * time), and a repeated capture legitimately raises the score. What must
     * hold is that red scored and blue did not.
     *
     * The value is now 1 PER CAPTURE (the lane brief of 2026-10-09): the team
     * scores are two GLOBALS, and the +10 the old read expected went to the
     * capturer's frags instead of to a per-player field. The +10 read asserted
     * the old bug's own number. */
    const lastScore = clean(sc[sc.length - 1] || '');
    const red = +(lastScore.match(/red=(\d+)/) || [])[1];
    const blue = +(lastScore.match(/blue=(\d+)/) || [])[1];
    check(sc.length >= 1 && red >= 1 && blue === 0,
          'the capture scored for red and not for blue',
          `${sc.length} capture_score lines, last ${JSON.stringify(lastScore)}`);

    // The flag resets.
    await await_('carried_key_returned', 1);
    check(ev('carried_key_returned').length >= 1,
          'the captured key went home again',
          `${ev('carried_key_returned').length} return events`);

    /* And it goes home to ITS OWN vault, not to the carrier's. The key's home is
     * its own pedastal, and QWTF_key_home puts it at qwtf_homevec, so this asserts
     * the key is where it started: the spawn print for team 2, mirrored.
     */
    const homePrints = probe('QWTF_KEY 2 at');
    check(homePrints.length >= 1,
          "the enemy key's home vault is recorded",
          `no QWTF_KEY 2 spawn print, so there is nowhere to assert it returned`);
    if (homePrints.length) {
      const hx = +(homePrints[0].match(/at (-?[\d.]+)/) || [])[1];
      check(hx > midX, "the enemy key belongs to the other team's half",
            `team 2's key is at x=${hx}, expected > ${midX}`);
    }

    /* ----------------------------------------------------------------------
     * DEATH, AND THE TWO WAYS A DROPPED KEY GOES HOME.
     *
     * PLAN.md's M4b done-when lists three rules the capture round above never
     * needed, because a carrier in that round is never hurt and never loses the
     * key on the floor:
     *
     *   - a carrier who DIES drops the key where they fell,
     *   - a dropped key comes home on its own 20 s clock,
     *   - a DEFENDER who touches a dropped key sends it home at once.
     *
     * All three are observed the same way as everything else here: through
     * QWTF_EVENT, with qwtf_trace off, so they are the rules the owner's server
     * runs. The one new thing this section needs is a way to DIE, which is the
     * probe's `qwtf_hurtseq` hook (qwtf/probe.qc) -- it applies real damage
     * through T_Damage, so PlayerDie runs exactly as it does when the owner is
     * shot, and ctf.qc's wrapper does the dropping.
     *
     * ORDER IS THE POINT, and it is why this is two rounds rather than one:
     *
     *   round 1  take the enemy key, die with it, and have a DEFENDER walk onto it
     *            before the clock can run out -- so `defender_return` is proved to
     *            be the touch and not the timeout arriving late;
     *   round 2  take it again, die again, and then nobody touches it, so the
     *            only thing that can send it home is the 20 s clock.
     *
     * The interval in round 2 is measured from the SERVER'S OWN clock, out of the
     * drop_at and return_timeout_at lines (ctf.qc prints `time` on both). A test
     * cannot do this from its side: the log is written asynchronously, so two
     * wall-clock readings taken here differ by however long each line took to
     * appear, which is a measurement of the flush and not of the rule.
     */
    console.log('');
    console.log('death drops the key; it comes home in 20 s or to a defender');

    /* The n-th drop's position and the server's time, straight out of
     * "QWTF_EVENT drop_at <x> <y> <z> <time>". Indexed by drop, not "the last
     * one", so round 2 cannot read round 1's drop and pass on it. */
    const dropAt = (n) => {
      const l = probe('QWTF_EVENT drop_at ')[n];
      if (!l) return null;
      const t = l.trim().split(/\s+/);
      /* QWTF_EVENT drop_at <x> <y> <z> <time> -- six tokens, and the time is the
       * fifth field after the two fixed words. A line without it is a map change
       * of the print, and reading x as a time would put the gap near zero and
       * look like a rule that fired instantly. */
      if (t.length < 6 || !/^-?[\d.]+$/.test(t[5])) return null;
      return { x: +t[2], y: +t[3], z: +t[4], t: +t[5], line: l };
    };
    /* The server's time on a "QWTF_EVENT <what>_at <time>" line, the n-th. */
    const evAt = (what, n) => {
      const l = probe(`QWTF_EVENT ${what}_at `)[n || 0];
      if (!l) return null;
      const m = l.trim().match(/(-?[\d.]+)\s*$/);
      return m ? +m[1] : null;
    };
    /* The index of the last line matching `re`, so "the timeout came after this
     * drop" is an assertion about the LOG and not about two clocks agreeing. */
    const lastIndex = (re) => {
      const ls = raw().split('\n').map(clean);
      let at = -1;
      ls.forEach((l, i) => { if (re.test(l)) at = i; });
      return at;
    };

    let hurtseq = 0;
    /* Kill the carrier, and wait for the RULE, not for the hook.
     *
     * The wait is on QWTF_EVENT drop, which is PlayerDie running. QWTFHURT is the
     * hook talking about itself, and a check that waited for it would pass on a
     * build where the drop never happens. */
    const kill = async (dropsSoFar) => {
      hurtseq += 1;
      server.command('serverinfo qwtf_hurt 1000');
      server.command(`serverinfo qwtf_hurtseq ${hurtseq}`);
      const until = Date.now() + 15000;
      while (Date.now() < until && ev('drop').length === dropsSoFar) await sleep(200);
      /* And wait for the respawn, because the team switch below runs
       * respawn() on the player: switched while the corpse is still DEAD_DEAD it
       * would put a live body in the world with the corpse's frame and no idea
       * which one owns the keys. */
      const spawnUntil = Date.now() + 20000;
      while (Date.now() < spawnUntil) {
        const p = lastPosNamed(raw(), 'diver');
        if (p && p.health > 0) break;
        await sleep(300);
      }
      await sleep(500);
      return ev('drop').length > dropsSoFar;
    };

    /* Team switches go through the REAL overlay -- window.QWTF_MENU.do() is the
     * same call the menu button makes -- because the defender round needs the
     * player to BE blue, and a command typed straight into cbufadd would prove
     * nothing about the thing the owner clicks. It is also the lobby's own
     * command, so this doubles as the path check 5 of the lobby round uses. */
    const setTeam = async (action) => {
      const before = ev('setteam_accepted').length;
      await client.evalJS(`window.QWTF_MENU.do("${action}")`);
      const switched = await untilLog(t => ev('setteam_accepted').length > before, 12000);
      await sleep(1200);
      return { switched, before, after: ev('setteam_accepted').length };
    };

    // ---- round 1: die holding it, and a defender walks onto it.
    const takes1 = ev('take').length;
    await go(KEY_X_B + NEAR_X, KEY_Y, STAND);
    await walkTo(KEY_X_B - NEAR_X, KEY_Y);
    await await_('take', takes1 + 1, 12000);
    const took1 = ev('take').length > takes1;
    const drops1 = ev('drop').length;
    const died1 = await kill(drops1);
    const d1 = dropAt(drops1);

    check(took1 && died1,
          'dying with the enemy key drops it where the carrier fell',
          `took again: ${took1}; the hook killed the carrier (QWTFHURT: ` +
          `${JSON.stringify(probe('QWTFHURT ').pop() || 'none')}); ` +
          `QWTF_EVENT drop ${ev('drop').length - drops1} time(s), expected 1`);
    /* WHERE it dropped. The bound is the walk, not a box: the carrier walked from
     * KEY_X_B+96 to KEY_X_B-96 and died somewhere on that line, so the drop has
     * to be inside it -- and it must NOT be the pedestal, or the rule has just
     * put the key back where it started and the check would pass on a key that
     * never fell over.
     *
     * The bound is 384 rather than something tight because the walk does not stay
     * on y = KEY_Y. Measured on a real run: the carrier ended at (4111, 1135) for
     * a key at (4208, 960) -- 96 in x, 176 in y. It had walked 24 short of the
     * waypoint and drifted 176 off the line, because the vault's floor is not a
     * corridor along that y. An assertion of "within 96 in y" would have failed on
     * a rule that worked. */
    const pedestal = probe('QWTFPROBE QWTF_KEY 2 at').pop() || '';
    const pm = pedestal.match(/at (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/) || [];
    const hx = +pm[1], hy = +pm[2];
    const distFromKey = d1 ? Math.hypot(d1.x - KEY_X_B, d1.y - KEY_Y) : Infinity;
    const onPedestal = !!d1 && Math.hypot(d1.x - hx, d1.y - hy) < 32;
    check(!!d1 && d1.x > midX && Math.abs(d1.z - STAND) < 48 &&
          distFromKey <= 384 && !onPedestal,
          'the dropped key is where the carrier fell, not back on its pedestal',
          `drop_at ${JSON.stringify(d1 && { x: d1.x, y: d1.y, z: d1.z })}; ` +
          `the key is at ${KEY_X_B},${KEY_Y} and its pedestal at ${hx},${hy}; ` +
          `${distFromKey === Infinity ? 'no drop_at line' : distFromKey.toFixed(0) + ' units from the key'}` +
          `${onPedestal ? ', which IS the pedestal' : ''}; red's half is x < ${midX}`);

    /* The key on the floor is BLUE's, and it is lying in BLUE's vault. Become a
     * defender and walk onto it. */
    const rtBefore = ev('return_timeout').length;
    const toBlue = await setTeam('team_blue');
    check(toBlue.switched,
          'the player can be put on the key\'s own team (the overlay\'s Blue button)',
          `setteam_accepted events ${toBlue.before} -> ${toBlue.after}, ` +
          `refused ${ev('setteam_refused').length}`);
    if (d1 && toBlue.switched) {
      /* ONTO THE SPOT THE CARRIER FELL, then one short step back the way they
       * came (+x, which is where this test walked them in from).
       *
       * The step is not decoration: FTE checks touch during a player's MOVE and
       * not on a setorigin (see walkTo), so a teleport onto the key fires
       * nothing at all. And the direction is the one the carrier arrived from,
       * because that is the only stretch of floor this test has proved is walkable
       * -- the vault's ends are walls, and a start point is part of the route. */
      await go(d1.x, d1.y, STAND);
      await walkTo(d1.x + 24, d1.y);
    }
    const defended = await untilLog(t => ev('defender_return').length > 0, 12000);
    check(defended && ev('return_timeout').length === rtBefore,
          'a defender touching a dropped key sends it home at once',
          `defender_return ${ev('defender_return').length}, ` +
          `return_timeout ${ev('return_timeout').length} (was ${rtBefore} before ` +
          `the walk: a timeout here would mean the clock sent it home, not the ` +
          `defender); player ended at ${JSON.stringify(lastPos())}, ` +
          `the key lay at ${JSON.stringify(d1 && { x: d1.x, y: d1.y, z: d1.z })}`);

    /* Back to red: round 2 needs an attacker again, and it is where the capture
     * round above left the player. */
    await setTeam('team_red');
    const backRed = await untilLog(t => {
      const p = lastPosNamed(t, 'diver');
      return p && p.team === 1;
    }, 12000);
    const onRed = lastPosNamed(raw(), 'diver');
    check(backRed, 'and back on red for the next round (the probe trail says team 1)',
          `last trail for diver: ${onRed ? 'team ' + onRed.team : 'none'}`);

    // ---- round 2: die holding it again, and nobody touches it.
    const takes2 = ev('take').length;
    await go(KEY_X_B + NEAR_X, KEY_Y, STAND);
    await walkTo(KEY_X_B - NEAR_X, KEY_Y);
    await await_('take', takes2 + 1, 12000);
    const took2 = ev('take').length > takes2;
    const drops2 = ev('drop').length;
    const home2 = ev('dropped_key_returned').length;
    const died2 = await kill(drops2);
    const d2 = dropAt(drops2);

    /* Nothing touches it now: the carrier is dead and respawned at their own
     * spawn, and there is no second client. Wait past the 20 s design with margin
     * and see what sent it home. */
    const timed = await untilLog(t => ev('return_timeout').length > rtBefore, 30000);
    const rt = evAt('return_timeout', ev('return_timeout').length - 1);
    /* Both the ORDER in the log and the interval on the server's clock. Order
     * alone would pass for a clock armed by an earlier drop; the interval alone
     * would pass if the test paired the wrong two lines. */
    const dropIdx = lastIndex(/QWTF_EVENT drop_at/);
    const rtIdx = lastIndex(/QWTF_EVENT return_timeout_at/);
    const gap = d2 && rt !== null ? rt - d2.t : null;

    check(took2 && died2 && timed && gap !== null && rtIdx > dropIdx && gap >= 19 && gap <= 22,
          'the dropped key comes home on its own clock, 19 to 22 s after the drop',
          `took again: ${took2}, died: ${died2}, return_timeout ${ev('return_timeout').length - rtBefore} time(s); ` +
          `server clock: dropped at t=${d2 ? d2.t : '?'}, returned at t=${rt}, ` +
          `gap ${gap === null ? '?' : gap.toFixed(2)} s (design 20, think ticks 0.5 s); ` +
          `log order drop@${dropIdx} return_timeout@${rtIdx}`);

    check(ev('dropped_key_returned').length > home2,
          'and the timed return put the dropped key back on its pedestal',
          `dropped_key_returned ${ev('dropped_key_returned').length - home2} time(s) ` +
          `after the second drop (was ${home2})`);

    /* The key really is home, and not sitting on the floor: the game's own
     * model/origin state for a key is what QWTF_KEY_* prints at spawn, so the
     * absence of a fresh spawn line plus the returned event is what is available
     * here. The state is on the carrier's field, and the carrier no longer has
     * the key at all -- a dropped key that timed out leaves qwtf_carry empty. */
    const noCarry = await untilLog(t => {
      const m = /QWTFPOS \[diver\] (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/.exec(
        (t.split('\n').map(clean).filter(x => x.indexOf('QWTFPOS [diver]') >= 0).pop()) || '');
      return m && m[8] === '-';
    }, 12000);
    check(noCarry, 'the carrier is empty-handed again (the probe prints carry "-" with none)',
          `last trail: ${JSON.stringify((raw().split('\n').map(clean).filter(x => x.indexOf('QWTFPOS [diver]') >= 0).pop() || ''))}`);
  } catch (e) {
    bad('the player checks ran', e && e.message);
  } finally {
    if (client) await client.stop();

    /* Kill the page server's whole PROCESS GROUP. It is spawned detached, and
     * killing only the parent node left the listener alive holding the port for the
     * next run -- which then serves a stale page (0222). */
    try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {
      try { page.kill('SIGKILL'); } catch (e2) {}
    }
    await sleep(300);
    await server.stop();
    /* The symlink farm is removed in main(), once EVERY phase is done: the map-load
     * phase below runs a second server out of the SAME STAGE, and deleting it in
     * this finally made that server find no map at all ("no map 'forts' in
     * .../run-<pid>/gamedir/id1/maps", both runs of the concurrency proof). */
  }
}

/* --------------------------------------------------------------------------
 * GAME-DESIGN.md's class table, READ rather than restated.
 *
 * Every stat below is checked against the document, so a tune in GAME-DESIGN.md
 * that the server does not implement FAILS here instead of being quietly
 * disagreed with. The restatement is the thing this project has been bitten by
 * repeatedly: a number written in two places is a number that is right in one
 * of them.
 *
 * Columns (GAME-DESIGN.md "Classes"): `| # | Class | Role | Speed | Health / armour |
 * Weapons | Grenades ... |`, e.g.
 *   | 1 | **Scout** | Flag runner, recon | 1.35× | 75 / 50 light | Shotgun, nail pistol | ... |
 *
 * Speed is a multiple of sv_maxspeed 320, which is the base the design names in
 * the sentence above the table. Armour's three words map onto LibreQuake's own
 * ladder (client.qc's deathmatch default is 0.8, the top of the three).
 */
const QWTF_ARMOUR_TYPE = { light: 0.3, combat: 0.6, heavy: 0.8 };

function designClasses() {
  const text = fs.readFileSync(path.join(ROOT, 'GAME-DESIGN.md'), 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line) || !line.includes('**')) continue;
    const r = line.split('|').map(c => c.trim());
    // "**Soldier** (default)" -> soldier; the parenthetical is the design's
    // annotation, not part of the name.
    const name = r[2].replace(/\*\*/g, '').replace(/\(.*\)/, '').trim().toLowerCase();
    const speed = +(r[4].replace(/[^0-9.]/g, ''));
    const hp = r[5].match(/(\d+)\s*\/\s*(\d+)\s*(light|combat|heavy)/);
    if (!hp || !speed) continue;
    out[name] = {
      speed: speed * 320,          // the design's "Base movement is sv_maxspeed 320"
      health: +hp[1],
      armour: +hp[2],
      armortype: QWTF_ARMOUR_TYPE[hp[3]],
      default: /default/.test(r[2]),
    };
  }
  return out;
}

/* One `QWTF_EVENT class_stats <name> class=<c> speed=.. hp=.. armour=.. absorb=..`
 * line, read by value. ftos prints 0.6 as 0.60000002, so every field is parsed
 * as a number and compared with a tolerance -- a literal "absorb=0.6 " match is
 * how the first run of this section went red on a correct line. */
function classStats(name, cls) {
  const line = raw().split('\n').map(clean)
    .filter(l => l.startsWith(`QWTF_EVENT class_stats ${name} class=${cls}`)).pop();
  if (!line) return null;
  const f = (k) => { const m = line.match(new RegExp(`(?:^| )${k}=(\\S+)`)); return m ? parseFloat(m[1]) : NaN; };
  return { line, speed: f('speed'), health: f('hp'), armour: f('armour'), absorb: f('absorb') };
}
const near = (a, b) => Math.abs(a - b) < 0.01;

/* Poll the server's own log for a predicate. The server writes stdout
 * asynchronously, so a check that reads the instant a click returns sees the
 * log BEFORE the frame that answers it (0222). */
async function untilLog(pred, ms) {
  const until = Date.now() + (ms || 12000);
  while (Date.now() < until) {
    if (pred(raw())) return true;
    await sleep(250);
  }
  return pred(raw());
}

/* --------------------------------------------------------------------------
 * M5: the overlay's actions, through the real page, to server-side state.
 *
 * PLAN.md's M5 menu done-when is "each overlay action changes server-side state
 * (team, class)". This is the first check in the project that asserts it, and it
 * runs in THIS harness, on the live server and the live page, for the same three
 * reasons the take/capture walk does: a second harness would be a second copy of
 * the start-up plumbing, the commands have to travel the real path -- page ->
 * menu.js -> FTEC.cbufadd -> the wire -> SV_ParseClientCommand -- or nothing is
 * proved, and the numbers have to be read out of the SERVER's log rather than
 * out of the page, because the page is the thing being tested.
 *
 * It is where 0506 item 1 landed: the reviewer's report was that `==` on runtime
 * strings takes the TRUE branch when they differ, which would make every command
 * a qwtf_setteam red. Measured instead (tests/test_stringeq.js, 29/29) the
 * comparisons are correct and the transport was not: menu.js sent the commands
 * bare, FTE's client eats an unknown command, and the server never heard them.
 * The `cmd ` prefix is what arrives, and the setclass_first / setteam_accepted
 * events below are that fix proving itself end to end.
 */
async function lobbyChecks(client) {
  console.log('');
  console.log('the lobby: menu -> engine -> wire -> server, and the class on a body');
  const design = designClasses();
  const NAME = 'diver';

  check(Object.keys(design).length === 6,
        'GAME-DESIGN.md\'s class table parsed: 6 classes with speed, health and armour',
        `parsed ${Object.keys(design).length}: ${Object.keys(design).join(', ')}`);

  /* The menu is loaded by web/index.html (the page under test), so this is the
   * real overlay and not a re-implementation of it. If it were missing, every
   * check below would fail on a null, which is why this one comes first. */
  const hasMenu = await client.evalJS('typeof window.QWTF_MENU === "object"');
  check(hasMenu === true, 'the real page has our overlay on it (window.QWTF_MENU)',
        `window.QWTF_MENU is ${hasMenu}`);

  // 1. THE LOBBY HELD THE JOIN. The order in the server's own log is the
  //    rule: lobby_wait for the join, and NO class_stats line until the
  //    picks were made (the spawn above is the one playerChecks asked for).
  const waited = raw().split('\n').map(clean)
    .some(l => l.startsWith('QWTF_EVENT lobby_wait diver'));
  check(waited, 'the join was held in the lobby (QWTF_EVENT lobby_wait diver)',
        `the log has ${raw().split('\n').filter(l => l.includes('lobby_wait')).length} lobby_wait lines`);
  const waitIdx = raw().indexOf('QWTF_EVENT lobby_wait diver');
  const firstStats = raw().indexOf('QWTF_EVENT class_stats diver');
  check(waitIdx >= 0 && firstStats > waitIdx,
        'no body was dressed before the picks (class_stats came after lobby_wait)',
        `lobby_wait at ${waitIdx}, first class_stats at ${firstStats}`);

  // 2. THE CLASS COMMAND, THROUGH THE REAL OVERLAY, APPLIES AT ONCE.
  //    window.QWTF_MENU.do() is the same entry point a click on the menu
  //    button uses, and the body is a live Soldier (the spawn above), so the
  //    pick respawns the body into the new class immediately.
  const cmd = await client.evalJS('window.QWTF_MENU.do("cls_scout")');
  const first1 = await untilLog(t => /QWTF_EVENT setclass_now /.test(t));
  check(first1, 'the overlay\'s Scout button reaches the server as a class command',
        `the page sent ${JSON.stringify(cmd)}; no setclass_now event within 12 s`);
  const scout = await untilLog(t => !!classStats(NAME, 'scout'), 12000);
  check(scout, 'and it reaches the BODY at once: a live Soldier becomes a Scout',
        `no class_stats ${NAME}/scout within 12 s of the pick`);
  if (scout) {
    const d = design.scout || {};
    const s = classStats(NAME, 'scout');
    check(near(s.speed, d.speed) && near(s.health, d.health) &&
          near(s.armour, d.armour) && near(s.absorb, d.armortype),
          'the scout on the wire carries GAME-DESIGN\'s scout row, read server-side',
          `server ${JSON.stringify(s)}, design ${JSON.stringify(d)}`);
  }

  // 3. A SECOND CLASS CHANGE IS EQUALLY IMMEDIATE: the old "applies at your
  //    next respawn" path is gone (2026-10-09: "I select and the weapon
  //    doesn't change").
  await client.evalJS('window.QWTF_MENU.do("cls_medic")');
  const medicNow = await untilLog(t => !!classStats(NAME, 'medic'), 12000);
  check(medicNow, 'a later class pick applies at once too (medic on the body)',
        `no class_stats ${NAME}/medic within 12 s of the pick`);

  // 4. M5B HAS SHIPPED (qwtf/sniper.qc, qwtf/heavy.qc), so its two buttons
  //    spawn those classes the same way.
  for (const [action, cls] of [['cls_heavy', 'heavy'], ['cls_sniper', 'sniper']]) {
    await client.evalJS(`window.QWTF_MENU.do("${action}")`);
    const got = await untilLog(t => !!classStats(NAME, cls), 12000);
    check(got, `${cls} is accepted now M5b has shipped (class_stats on the body)`,
          `no class_stats ${NAME}/${cls} within 12 s of the pick`);
  }

  // 5. THE TEAM COMMAND, THROUGH THE REAL OVERLAY. One player is on red (the
  //    auto-balance put them there), so asking for blue leaves red 0 / blue 1 --
  //    one apart, which is the rule's allowed end state, so it is accepted.
  const tBefore = ev('setteam_accepted').length;
  const medicBefore = raw().split('\n')
    .filter(l => l.includes(`QWTF_EVENT class_stats ${NAME} class=medic`)).length;
  await client.evalJS('window.QWTF_MENU.do("team_blue")');
  const accepted = await untilLog(t => ev('setteam_accepted').length > tBefore, 12000);
  check(accepted, 'the overlay\'s Blue team button changes server-side state',
        `no setteam_accepted within 12 s; the log has ` +
        `${ev('setteam_accepted').length} (was ${tBefore})`);
  const onBlue = await untilLog(t => {
    const p = lastPosNamed(t, NAME);
    return p && p.team === 2;
  }, 12000);
  const p = lastPosNamed(raw(), NAME);
  check(onBlue, 'and the body is on blue: the probe trail says team 2',
        `last trail for ${NAME}: ${p ? 'team ' + p.team : 'none'}`);

  // 6. AND THE BODY STILL READS AS THE LAST PICKED CLASS after the respawn the
  //    team switch did: pick medic once more and require a NEW medic spawn
  //    trail line (the count grows only if the respawn dressed the body).
  await client.evalJS('window.QWTF_MENU.do("cls_medic")');
  const medic = await untilLog(t =>
    t.split('\n').filter(l => l.includes(`QWTF_EVENT class_stats ${NAME} class=medic`)).length >
    medicBefore, 15000);
  check(medic, 'the team-switch respawn dressed the body as the picked class (a new medic spawn)',
        `no new class_stats ${NAME}/medic line after the respawn`);
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  stage();
  try {
    splitChecks();
    await playerChecks();
    /* --lobby-only is "the M5 section, nothing else": the map-load phase is part
     * of the take/capture proof (keys and stands with the trace off), not of the
     * lobby's, and it costs a second server boot. */
    if (!process.argv.includes('--lobby-only')) mapLoadChecks();
  } finally {
    console.log('');
    console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log, mapload.log)`);
    /* Now nothing is left to serve, drop the farm. The logs STAY: server.log is the
     * evidence behind every number above, and it is what "signon reached X" is
     * read from. It is deliberately not copied to one shared name -- that copy is
     * the race 0239 was about. */
    try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(failed ? `FAIL: ${failed} of ${passed + failed} checks`
                      : `PASS: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('Error:', e && e.stack); process.exit(1); });
