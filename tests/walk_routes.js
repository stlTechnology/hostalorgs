/*
 * The pathing, proved in the engine and not in Python (reviewer 0246).
 *
 *   node tests/walk_routes.js [--port N]
 *
 * WHY THIS FILE EXISTS: the owner's own words were "the pathing is broken. the
 * basement is not something that can be escaped from currently. the paths dont lead
 * out, can't jump to get on a path, fall in and stuck. the door out, is too short,
 * so can't get to the other fort", and every Python reachability check I had said
 * the opposite -- including one that said "you can walk from the fort floor to the
 * battlement lookout" while the battlement was unreachable. The model was wrong, so
 * the model is not the evidence any more. This drives a real fteqw-sv with a real
 * client and asserts, from the server's own QWTFPOS, that a player holding W gets
 * from A to B.
 *
 * The rules it plays by:
 *
 *   * Teleports are used ONLY to put the player at the start of a leg. Every metre
 *     between the start and the goal is walked, with the heading dictated by the
 *     server (qwtf_face) and W held down. The one exception is a deliberate DROP,
 *     which is the point of legs (b) and (c): the player is put somewhere high and
 *     has to get out on foot.
 *   * The route comes from scripts/map_route.py over the map's own boxes, in WORLD
 *     units, so it cannot pass through a wall -- but it is only a DIRECTION. Whether
 *     the player can actually walk it is what this file finds out.
 *   * Arrival is the server's own position within `reach` of the goal, never the
 *     browser's, and a leg that fails prints its last QWTFPOS lines so the failure
 *     says where the player stopped.
 *
 * Legs (reviewer 0246 item 3):
 *   a  red spawn -> red vault (up the stairs) -> back to the fort floor -> out the
 *      bridge door -> across the bridge -> into blue's fort -> blue's vault -> out
 *   b  dropped into the red vault from the highest drop point above it -> out on foot
 *   c  fallen into the water channel -> back up to a fort floor
 *   d  the same three for blue, mirrored
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const WEB = path.join(ROOT, 'web');
/* Per run, like ctf_rules.js: a shared gamedir means two runs delete each other's
 * staged content while the client is loading out of it (0239). */
const RUN = path.join(ART, 'run-walk-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const LOG = path.join(RUN, 'server.log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* A port RESERVED TO THIS LEG, not merely free the instant we looked (0466).
 *
 * History: the arithmetic `20000 + (pid % 20000)` could land on ports that are
 * PERMANENTLY taken on this box (the live owner service on 27510 TCP), so the
 * first fix probed and walked up. That fixed 27510 and left the worse race:
 * between the probe's close() and the real listener's listen() sat the whole
 * game-server startup, and with JOBS=2 a leg's neighbour probed the same port
 * in that window. Both spawned serve.js on it; one bound and printed
 * "[serve] static/ on :PORT", the other died EADDRINUSE -- and the leg failed
 * "the static server started on its port" while the LOG said it had started,
 * or the walker joined the OTHER leg's server and its own log never showed
 * "walker joined". Seen 2/36 in the 3-repeat run, both intermittent, both
 * gone on re-run. A probe can never close that window; only holding the port
 * can. So: a claim file per port under /tmp/qwtf-walk-ports, created O_EXCL
 * (one leg may hold it), THEN the probe-bind to reject ports an OUTSIDE
 * listener really holds. The claim is kept until the leg exits and unlinked on
 * every exit path; a claim left behind by a killed leg is reclaimed when its
 * pid is dead AND the file is over a minute old (a running leg's pid alone
 * would be enough, but pid reuse exists; the age is what makes reuse safe). */
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
        fd = fs.openSync(f, 'wx');   // reclaim: legs are the only other writers
      } else return null;
    } catch (e2) { return null; }    // vanished or unreadable under us: skip
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

/* TRUE once something accepts TCP on the port (or false after the timeout).
 * The old startup was `await sleep(1500)` after spawning serve.js and then
 * navigating straight away: under load 1.5 s is not enough for node to reach
 * listen(), the first navigation lands on ERR_CONNECTION_REFUSED, and the
 * whole 240 s of canvas polling ran against Chrome's error page. This answers
 * the reviewer's literal question ("did the static server start on its
 * port?") BEFORE the browser is sent anywhere. */
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

let failed = 0, passed = 0;
const ok = (what) => { console.log(`  ok   ${what}`); passed++; };
const bad = (what, detail) => {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
};
const check = (c, what, detail) => (c ? ok(what) : bad(what, detail));

/* EVERY PROCESS THIS RUN SPAWNS, AND ONE WAY TO KILL THEM (0359 item 1).
 *
 * The harness spawns a server, a static file server and a browser, each `detached: true`
 * so it gets its own process group. Killing only the handle we kept left the rest of the
 * group alive: the reviewer counted **107** survivors after a run and load 85 during it,
 * and I counted 25 fteqw-sv of my own. Every run was then slower than the one before it,
 * which is how a timing problem got mistaken for a map problem -- twice, by me and once
 * by the reviewer.
 *
 * So: record every pid, and kill the whole GROUP (negative pid) on every exit path,
 * including the ones nobody expects to run -- normal return, throw, SIGINT, SIGTERM, and
 * the exit after `timeout --kill-after` sends SIGKILL to this process, which is the path
 * the wrapper's own cut-off takes. `process.on('exit')` covers all of them but cannot be
 * async, so it is a synchronous `kill`, and the async sweep runs on the paths that can.
 */
/* EVERY WAYPOINT THIS RUN SENT, and every arrival the player reported (0365). Printed in
 * full on any non-PASS, because a TIMEOUT kills the leg: asking for a trace afterwards is
 * asking for something that no longer exists, and I have asked twice this week.
 *
 * Leg (c) sent TWO of its four corners and nobody could see it from a stall position --
 * a waypoint nobody arrived at is never sent, so a route that stops early looks exactly
 * like a route that works. */
const SENT = [];
const ARRIVED = [];

const SPAWNED = new Set();

function reapSync() {
  for (const pid of SPAWNED) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
  }
  SPAWNED.clear();
}

function reapAsync() {
  for (const pid of SPAWNED) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
  }
  SPAWNED.clear();
}

function track(proc) {
  if (proc && proc.pid) SPAWNED.add(proc.pid);
  return proc;
}

/* The trace prints from EVERY exit path, including the ones a cut-off takes (0365):
 * `timeout` sends SIGTERM, and the handler used to reap and exit without printing -- so
 * the one case you most want the trace for, a leg that hung, was the one case that never
 * produced it. It is called from a function declared later and hoisted by `function`, so
 * the order here does not matter. */
let CUT_OFF = false;
function printTraceNow() {
  // On a cut-off there are no failed checks YET -- the leg was still running when the
  // signal arrived -- so gating on `failed` alone printed nothing for exactly the case
  // you want it. CUT_OFF says "this run did not finish", and that is reason enough.
  if (CUT_OFF) CUT_OFF_SAW = true;
  try { if (typeof printTrace === 'function') printTrace(CUT_OFF); } catch (e) {}
}
let CUT_OFF_SAW = false;

process.on('exit', () => { printTraceNow(); reapSync(); claimReleaseSync(); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { CUT_OFF = true; printTraceNow(); reapSync(); process.exit(1); });
}
process.on('uncaughtException', e => {
  printTraceNow(); reapSync(); console.error(e); process.exit(1);
});

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/* The map's geometry, in world units, out of gen_map. */
const GEO_PY = [
  'import sys, json',
  'sys.path.insert(0, "scripts")',
  'import gen_map as g',
  'ents = [e for m in (False, True) for e in g.forts_entities(m)]',
  'spawns = [e for e in ents if e[0] == "info_player_deathmatch"]',
  'def raw_origin(e):',
  '    return [float(v) for v in e[1].split(chr(34))[3].split()]',
  // The FIRST spawn of each fort, not the last: the spawns run north up the hall
  // and the northern ones stood over the hole in the floor until 177bb2c.
  'def first_spawn(mirrored):',
  '    for e in g.forts_entities(mirrored):',
  '        if e[0] == "info_player_deathmatch":',
  '            return raw_origin(e)',
  'spawn_a, spawn_b = first_spawn(False), first_spawn(True)',
  'def origin(cls, flags=None):',
  '    for e in ents:',
  '        if e[0] != cls:',
  '            continue',
  '        d = dict(f.split(chr(34))[1::2] for f in e[1:] if f.startswith(chr(34)))',
  '        if flags is None or d.get("spawnflags") == flags:',
  '            return [float(v) for v in d["origin"].split()]',
  '    return None',
  'g.forts_map()',
  // f["tread"] on every record: a RAMP has no treads, so it reports its run and rise
  // instead, and the fields a caller reads are the same either way. The keys are .get
  // with a default because this dict comprehension is a KeyError away from turning the
  // whole static sweep into "gen_map answered with nothing" -- which is what happened
  // the first time a flight stopped being a staircase.
  'flights = [{"name": f["name"], "mirrored": bool(f["mirrored"]),',
  '           "ramp": bool(f.get("ramp")),',
  '           "box": [g.sc(v) for v in f["box"]], "n": f["n"],',
  '           "width": f.get("width"), "run": f.get("run"),',
  '           "tread": f.get("tread", f.get("run")), "rise": f["rise"]}',
  '          for f in g.FORTS_FLIGHTS]',
  // The MAP's solids, for the swept-hull assertion below. Read out of maps/forts.map
  // by scripts/mapfile.py -- the same reader the checks use -- so this cannot disagree
  // with the map, and a route is judged against what qbsp compiled rather than against
  // a list of generator functions kept in step by hand (0277).
  'import mapfile',
  'solids = [list(b) for b in mapfile.brushes("maps/forts.map") if b[6] != g.TEX_WATER]',
  // A RAMP'S SURFACE, read off the map and handed over as its axis and its two end
  // heights, so the route corners below can ask "how high is the walking surface HERE"
  // instead of assuming the flight's bounding box is walkable. On a flight of stairs
  // the box's ends were the first and last tread and that was close enough; on a ramp
  // the box's ends are the HIGH end and the low one, and a corner placed at the fort
  // floor's height walks the player into the foot of the slope -- which is what the
  // parapet leg did: "stalled at 279,571,46, corner 2/4 of [256,608,24]".
  'def flight_surface(fl):',
  '    # fl["box"] is ALREADY scaled -- the dict comprehension above scaled it -- so this',
  '    # must not scale it again. It did, the window was off the map, and every flight',
  '    # came back with no surface at all.',
  '    fx0, fy0, fx1, fy1 = fl["box"][:4]',
  '    hit = [b for b in mapfile.brushes("maps/forts.map")',
  '           if mapfile.is_ramp(b) and fx0 - 1 <= b[0] and b[3] <= fx1 + 1',
  '           and fy0 - 1 <= b[1] and b[4] <= fy1 + 1]',
  '    if not hit or fl.get("mirrored"):',
  '        return None',
  '    r = hit[0]',
  '    return {"axis": r[7][1], "z_lo": mapfile.top_at(r, r[0], r[1]),',
  '            "z_hi": mapfile.top_at(r, r[3], r[4]),',
  '            "x0": r[0], "y0": r[1], "x1": r[3], "y1": r[4]}',
  'for _f in flights:',
  '    _s = flight_surface(_f)',
  '    if _s:',
  '        _f.update(_s)',
  // THE MERLONS' OWN PLACES, read off the map. The drop leg walks the player at a
  // battlement edge, and half of a parapet is a GAP (32 of merlon, 32 of opening,
  // repeating), so a site x picked by arithmetic lands on a hole half the time and the
  // player steps off the roof -- which is the map being right and the leg being wrong
  // about where a merlon is. These are the merlon boxes themselves (they stand ON the
  // roof, so their z0 is the roof's top plus the wall thickness, and they are the only
  // wall boxes up there that are exactly a merlon tall), with `y` already moved to the
  // standing line just inside them: the walk starts a hull from the merlon and runs at
  // it. Read from the map rather than from the crenellation pitch, because the pitch is
  // inset a pitch in from the wall and getting that wrong by one pitch is exactly what
  // made fort B's pattern a shift of A's.
  'roof_top = g.sc(g.FORTS_ROOF_Z) + g.sc(g.FORTS_WALL_T)',
  'merl_h = g.sc(g.FORTS_MERLON_H)',
  'mid_x = g.sc(g.FORTS_LEN) / 2.0',
  'mid_y = g.sc(g.FORTS_WID) / 2.0',
  '_mer = [b for b in solids if b[6] == g.TEX_WALL',
  '         and abs(b[2] - roof_top) <= 1 and abs(b[5] - (roof_top + merl_h)) <= 1',
  '         and b[3] <= mid_x]',
  'merlons = {',
  '    "north": sorted([{"x": (b[0] + b[3]) / 2.0, "y": b[4] + 16,',
  '                     "x0": b[0], "x1": b[3]} for b in _mer if b[4] <= mid_y],',
  '                   key=lambda m: m["x"]),',
  '    "south": sorted([{"x": (b[0] + b[3]) / 2.0, "y": b[1] - 16,',
  '                     "x0": b[0], "x1": b[3]} for b in _mer if b[1] >= mid_y],',
  '                   key=lambda m: m["x"]),',
  '}',
  'print(json.dumps({',
  '    "solids": solids,',
  '    "merlons": merlons,',
  '    "water_top": g.sc(g.FORTS_WATER_TOP),',
  '    "water_x0": g.sc(g.FORTS_FORT_X1),',
  '    "water_x1": g.sc(g.FORTS_LEN - g.FORTS_FORT_X1),',
  '    "flights": flights,',
  '    "passage_x": [g.sc(v) for v in g.FORTS_PASSAGE_X],',
  '    "passage_y": [g.sc(v) for v in g.FORTS_PASSAGE_Y],',
  // The stairwell DOOR's own x span. A route that goes from the landing into the
  // corridor needs a corner at the middle of this, or the straight line between its
  // corners crosses the corridor's north wall somewhere else and the player pins
  // against it (0338). The door is the only opening in that wall for 288 of world.
    '    "stair_door": [g.sc(v) for v in g.FORTS_STAIR_DOOR],',
    '    # The BANK DOOR (2026-10-09): the doorway in each fort\'s north wall that',
    '    # leads from the bank top (where the water ramp\'s steps arrive) into the',
    '    # hall, sill at bank-top level. Derived from the same constants the',
    '    # generator cuts the gap with.',
    '    "bank_door_x": [g.sc(v) for v in (g.FORTS_STAIR_X[1],',
    '                                      64 + g.FORTS_FORT_W - g.FORTS_WALL_T)],',
    '    "bank_door_y": [g.sc(g.FORTS_FORT_D - g.FORTS_WALL_T + 192),',
    '                    g.sc(g.FORTS_FORT_D + 192)],',
  '    "bridge_y": [g.sc(v) for v in g.FORTS_BRIDGE_Y],',
  '    "shaft_y": [g.sc(v) for v in g.FORTS_SHAFT_Y],',
  '    "stair_w": g.sc(g.FORTS_VAULT_STAIR_W),',
  '    "wall_x": [g.sc(v) for v in (96, 448)],',
  '    "floor_t": g.sc(g.FORTS_GROUND_Z),',
  '    "roof_t": g.sc(g.FORTS_ROOF_Z),',
  '    "wall_t": g.sc(g.FORTS_WALL_T),',
  '    "vault_t": g.sc(g.FORTS_VAULT_Z),',
  '    "bed_t": g.sc(g.FORTS_BED_Z),',
  '    "key_a": origin("item_qwtf_key", "2"),',
  '    "key_b": origin("item_qwtf_key", "4"),',
  '    "spawn": spawn_a,',
  '    "spawn_b": spawn_b,',
  '    "ground": g.sc(g.FORTS_GROUND_Z),',
  '    "bed": g.sc(g.FORTS_BED_Z),',
  '    "water": g.sc(g.FORTS_WATER_TOP),',
  '    "roof": g.sc(g.FORTS_ROOF_Z),',
  '    "vault": g.sc(g.FORTS_VAULT_Z),',
  '    "bridge_y": [g.sc(v) for v in g.FORTS_BRIDGE_Y],',
  '    "wid": g.sc(g.FORTS_WID),',
  '    "len": g.sc(g.FORTS_LEN),',
  '    "hull": g.HULL_HEIGHT,',
  '    "scale": g.FORTS_SCALE,',
  '}))',
].join('\n');

function geo() {
  const r = sh('python3', ['-c', GEO_PY], { cwd: ROOT });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; }
}

function route(from, to) {
  const r = sh('python3', [path.join(ROOT, 'scripts/map_route.py'),
    '--map', 'forts', '--from', from.join(','), '--to', to.join(',')],
    { cwd: ROOT });
  try {
    const j = JSON.parse(r.stdout);
    return j.ok ? j.waypoints : null;
  } catch (e) { return null; }
}

function stage() {
  fs.rmSync(RUN, { recursive: true, force: true });
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

/* The server owns the player's position and heading: qwtf/probe.qc reads the
 * serverinfo cvars qwtf_gx/gy/gz (+ qwtf_gseq, one-shot) to move the player and
 * qwtf_face to dictate the heading, which is the only way a headless client can
 * turn at all. */
class Server {
  constructor(port) { this.port = port; this.seq = 0; this.wseq = 0; }
  async start() {
    this.out = fs.openSync(LOG, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', STAGE,
      '--map', 'forts',
      '+set', 'developer', '1',
      '+set', 'qwtf_trace', '1',
      '+serverinfo', 'qwtf_trace', '1',
    ], { cwd: ROOT, stdio: ['pipe', this.out, 'pipe'], detached: true });
    track(this.proc);
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr || '') + d; });
    for (let i = 0; i < 200; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(fs.readFileSync(LOG, 'utf8'))) return true;
      if (this.proc.exitCode !== null) break;
    }
    return /Quake Initialized/.test(fs.readFileSync(LOG, 'utf8'));
  }
  command(c) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(c + '\n'); }
  goto(x, y, z) {
    this.seq += 1;
    this.command(`serverinfo qwtf_gx ${x}`);
    this.command(`serverinfo qwtf_gy ${y}`);
    this.command(`serverinfo qwtf_gz ${z}`);
    this.command(`serverinfo qwtf_face ""`);
    this.command(`serverinfo qwtf_gseq ${this.seq}`);
  }
  face(yaw) { this.command(`serverinfo qwtf_face ${yaw.toFixed(2)}`); }
  faceNone() { this.command('serverinfo qwtf_face ""'); }

  /* WAYPOINT STEERING, ON THE SERVER (reviewer 0252). The test names a place and
   * the probe faces the player at it every server frame; the test never computes an
   * angle and never reads a position to decide anything. */
  /* z IS SENT, and that is the fix for leg (c) timing out (0355). probe.qc holds +jump
   * while a swimming player's waypoint is more than 24 above them -- a yaw alone cannot
   * swim upwards -- and it reads the height from `qwtf_wz`. The harness was sending
   * wx, wy, wjump and wseq and NOT wz, so that condition could never fire and the
   * swimmer swam along the bed for ever. The leg reached "the player is in the water"
   * and then sat there.
   *
   * z is optional in the signature: absent means level with the player, so every walking
   * leg behaves exactly as before. */
  /* Every waypoint this run sends, in order, when QWTF_WP_TRACE is set.
   *
   * Leg (c) has been timing out with the player arriving on the WRONG FORT (0364), and
   * the question is whether the route SENT is the route BUILT. That is not a thing to
   * infer from a stall position: two waypoints of four were being sent and nobody could
   * see it, because a waypoint nobody arrived at is simply never sent. Printed, it took
   * one run.
   */
  waypoint(x, y, jump, z) {
    this.wseq += 1;
    SENT.push({ seq: this.wseq, x, y, z: z === undefined ? null : z,
                jump: jump ? 1 : 0 });
    if (process.env.QWTF_WP_TRACE) {
      console.log(`   wp ${this.wseq} ${x} ${y} ${z === undefined ? '-' : z} `
                + `jump=${jump ? 1 : 0}`);
    }
    this.command(`serverinfo qwtf_wx ${x}`);
    this.command(`serverinfo qwtf_wy ${y}`);
    this.command(`serverinfo qwtf_wz ${z === undefined || z === null ? '' : z}`);
    this.command(`serverinfo qwtf_wjump ${jump ? 1 : 0}`);
    this.command(`serverinfo qwtf_wseq ${this.wseq}`);
    return this.wseq;
  }
  waypointOff() {
    this.wseq += 1;
    this.command('serverinfo qwtf_wx ""');
    this.command('serverinfo qwtf_wz ""');
    this.command('serverinfo qwtf_wy ""');
    this.command(`serverinfo qwtf_wseq ${this.wseq}`);
  }
  /* "QWTFWP <seq> <x> <y> <z>" -- the server saying the player reached the
   * waypoint it was given, once per waypoint. */
  arrivals() {
    const txt = fs.readFileSync(LOG, 'utf8');
    const re = /QWTFWP (\d+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g;
    const out = new Map();
    let m;
    while ((m = re.exec(txt)) !== null) {
      const a = { seq: +m[1], x: +m[2], y: +m[3], z: +m[4] };
      out.set(a.seq, a);
      ARRIVED.push(a);
    }
    return out;
  }
  /* EVERY field the server prints, not just x, y, z (0368). The regex used to stop after
   * z and an optional yaw, so the harness could not see HEALTH or WATERLEVEL at all --
   * and the reviewer's first suspect for leg (c) was the player dying in the water and
   * respawning on the other team, which is two more columns. They were being printed by
   * the server and thrown away here.
   *
   * probe.qc prints: x y z yaw health waterlevel team key captures --, in that order, so
   * the names below are the server's, not mine. */
  positions() {
    const txt = fs.readFileSync(LOG, 'utf8');
    const re = /QWTFPOS \[walker\] (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/g;
    const out = [];
    let m;
    while ((m = re.exec(txt)) !== null) {
      out.push({
        x: +m[1], y: +m[2], z: +m[3], yaw: +m[4],
        health: +m[5], water: +m[6], team: +m[7],
      });
    }
    return out;
  }
  last() { const p = this.positions(); return p.length ? p[p.length - 1] : null; }
  async stop() {
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { fs.closeSync(this.out); } catch (e) {}
  }
}

class Client {
  constructor(cdp) {
    this.cdp = cdp; this.nextId = 1; this.pending = new Map();
    // 0384: what the page said and fetched, kept so a client that never starts
    // can say why instead of leaving a 0-waypoint leg to look like a map bug.
    this.console = []; this.net = [];
  }
  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-walk-'));
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.cdp}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=640,480', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    // 0384: the console and the network log are captured from before the first
    // navigation, so a client that never reaches a canvas leaves evidence.
    await this.send('Log.enable');
    await this.send('Network.enable');
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
    // The canvas may not exist yet when navigate resolves (0355): the wait loop ran to
    // its 480 tries and then fell through to clickCanvas(), which threw "no canvas on the
    // page" -- a flake that read as a failed leg, in the table, under the leg's name. So:
    // it either appears or we say so, and the load is retried ONCE.
    //
    // AND the retry itself was the flake's biggest cause (0466): the rewrite made the
    // navigate conditional -- `if (attempt) navigate` -- so attempt 0 sat on
    // about:blank for its WHOLE 120s poll and only the "retry" ever loaded the page.
    // Every leg lost 120s of budget; a leg whose harness timeout was the 120s default
    // was killed before the page was EVER asked for, which is exactly the "TIMEOUT ...
    // 0 waypoints sent, killed inside CLIENT STARTUP" rows in 0415's run. Navigate on
    // every attempt, and keep the navigation's own result.
    let seen = false;
    let lastNav = null;
    for (let attempt = 0; attempt < 2 && !seen; attempt++) {
      lastNav = await this.send('Page.navigate', { url })
        .then(r => ({ sent: true, errorText: (r && r.errorText) || null }))
        .catch(e => ({ sent: true, errorText: 'CDP: ' + e.message }));
      for (let i = 0; i < 480; i++) {
        await sleep(250);
        if (await this.eval(`!!document.getElementById('canvas')`)) { seen = true; break; }
      }
    }
    if (!seen) {
      // 0384, verbatim ask: on "no canvas", print whether the page loaded, whether
      // the .wasm or .pk3 fetch failed or 404'd, and whether the static server is
      // on its port -- from the browser AND from the harness side.
      const where = await this.eval(
        `JSON.stringify({ href: location.href, ready: document.readyState,` +
        ` title: document.title,` +
        ` body: (((document.body && document.body.innerText) || '') + '')` +
        `.slice(0, 300) })`).catch(e => '(eval failed: ' + e.message + ')');
      const curl = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
                               '--max-time', '5', url]);
      const lines = [
        `no canvas on the page after two loads, 120s each -- the CLIENT did not` +
        ` start, which is a harness or client problem and not a leg result`,
        `  last navigate: ${JSON.stringify(lastNav)}`,
        `  the tab is really at: ${where}`,
        `  harness GET of the same URL: HTTP ${curl.stdout.trim() || 'no answer'}` +
        ` (curl rc ${curl.status})`,
        `  console (${this.console.length} lines): ` +
          (this.console.slice(-15).join(' | ') || '(nothing)'),
        `  network (${this.net.length} entries): ` +
          (this.net.slice(-15).join(' | ') || '(nothing)')];
      throw new Error(lines.join('\n'));
    }
    await this.clickCanvas();
  }
  /* 0384: the CDP event stream, trimmed to what a dead page leaves behind.
   * Console messages (both the page's console.* and the browser's own log --
   * net errors and renderer crashes arrive as Log.entryAdded), uncaught JS
   * exceptions, and every network request with its status or failure. */
  event(m) {
    const val = a => a.value !== undefined ? String(a.value)
                   : (a.description || a.type || '?');
    try {
      switch (m.method) {
        case 'Runtime.consoleAPICalled':
          this.console.push(`[${m.params.type}] ` +
            (m.params.args || []).map(val).join(' '));
          break;
        case 'Log.entryAdded': {
          const e = m.params.entry;
          this.console.push(`[browser.${e.level}] ${e.text}` +
            (e.url ? ` @${e.url}` : ''));
          break; }
        case 'Runtime.exceptionThrown': {
          const d = m.params.exceptionDetails;
          this.console.push('[EXCEPTION] ' +
            ((d.exception && d.exception.description) || d.text));
          break; }
        case 'Network.requestWillBeSent':
          this.net.push(`-> ${m.params.request.url}`);
          break;
        case 'Network.responseReceived':
          this.net.push(`<- ${m.params.response.status} ${m.params.response.url}`);
          break;
        case 'Network.loadingFailed':
          this.net.push(`XX ${m.params.errorText || 'failed'}` +
            (m.params.blockedReason ? ` (${m.params.blockedReason})` : ''));
          break;
        default: return;
      }
    } catch (e) {}
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method) this.event(m);
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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
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
    return c;
  }
  /* Press and HOLD a key.
   *
   * FTE drops a keydown that arrives before the player has spawned, so the press
   * has to be repeated until the server reports the player moving (this is the M3
   * lesson and the ammo-counter one). keyUp is deliberately never sent until the
   * walk is over. */
  async hold(key, code, keyCode) {
    /* rawKeyDown, not keyDown: ctf_rules.js uses rawKeyDown and with keyDown the
     * player never moved at all -- FTE's web glue latches movement keys on the raw
     * event, so a synthetic keyDown is a keypress the engine hears as nothing. */
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
      type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
  }
  async stop() {
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* Walk a route, naming one waypoint at a time.
 *
 * The test's whole job here is to hand the server the next corner and wait to be
 * told the player arrived. The heading is computed on the server, per frame, in
 * probe.qc (reviewer 0252), because a control loop in the test has the probe's 4 Hz
 * period and the console round trip in it, and the player covers 77 units between
 * two samples -- measured oscillating over a straight line to x=400, and never once
 * pointing north.
 *
 * Arrival is the server's own QWTFWP line for the seq just issued. The timeout
 * prints the last positions, which is what says "stuck on the stairwell's west
 * face" rather than "did not arrive". */
async function walk(client, server, wps, opts) {
  const reach = (opts && opts.reach) || 64;
  const deadline = Date.now() + ((opts && opts.timeoutMs) || 240000);
  let arrived = [];
  let i = 0;
  // The waypoint's z goes with it: a swimmer needs to know which way is UP.
  let seq = server.waypoint(wps[0][0], wps[0][1], opts && opts.jump, wps[0][2]);
  let best = 1e9;
  const goal = wps[wps.length - 1];
  while (Date.now() < deadline) {
    const seen = server.arrivals();
    if (seen.has(seq)) {
      /* A LEVEL-CHANGING corner also needs the player to be near it in Z (0393). The 48
       * arrival radius is HORIZONTAL, so a player on the flight directly ABOVE the
       * landing ticks it off while still on a tread -- which is exactly how a/red walked
       * into the stairwell's south wall steering for the corridor: the landing and the
       * door both "arrived" from up the flight and the next corner was straight south
       * through a wall. The flag is the corner's own 4th element: 'L' for a landing, a
       * door or a flight's end. The probe's QWTFWP is a horizontal test, so the check has
       * to happen here. */
      const a = seen.get(seq);
      const flag = wps[i][3];
      const okZ = flag !== 'L' ||
                  (a.z <= wps[i][2] + 40 && a.z >= wps[i][2] - 40);
      if (okZ) arrived.push(a);
      if (Math.hypot(goal[0] - wps[i][0], goal[1] - wps[i][1]) <= reach) break;
      i += 1;
      if (i >= wps.length) break;
      seq = server.waypoint(wps[i][0], wps[i][1], opts && opts.jump, wps[i][2]);
    }
    await sleep(120);
  }
  /* WHERE HE ACTUALLY FINISHED, NOT WHERE THE PROBE LAST TICKED A CORNER.
   *
   * `arrived` holds the position at the moment each corner was ticked. But the loop
   * above stops STEERING the moment the corner it is aiming at is within `reach` of the
   * goal -- there is no point steering to a corner you are already close enough to --
   * and W is still held, so the player keeps walking. On the parapet leg that is the
   * whole difference: seq 3 was ticked at (254,1458,534), the loop then decided the
   * corner was close enough to the goal and stopped, and judging by that stale reading
   * said 131 short, while the player -- still walking -- finished at (259,1534,568),
   * which is 34 from the battlement corner and plainly ON it.
   *
   * So: take the player's real position, and if the only thing missing is the last few
   * units of a walk he is already making, wait for him to finish making it. Nothing
   * here teleports him or skips a corner; the legs still have to be walked end to end.
   */
  const settle = Date.now() + 20000;
  let last = server.last() || (arrived.length ? arrived[arrived.length - 1] : null);
  while (last && Date.now() < settle &&
         Math.hypot(goal[0] - last.x, goal[1] - last.y) > reach) {
    await sleep(200);
    const now = server.last();
    if (now) last = now;
  }
  if (last) {
    best = Math.hypot(goal[0] - last.x, goal[1] - last.y, goal[2] - last.z);
  }
  server.waypointOff();
  const goalXY = last ? Math.hypot(goal[0] - last.x, goal[1] - last.y) : Infinity;
  const reached = !!last && (arrived.length >= wps.length || goalXY <= reach);
  return {
    arrived: reached,
    /* How many corners were actually SENT, so the pass line can say so instead of
     * claiming all of them. */
    tried: Math.min(i + 1, wps.length),
    why: reached ? (arrived.length >= wps.length ? 'all corners'
                                        : `within ${reach} of the goal`)
                 : `ran out of time ${best.toFixed(0)} short of the goal`,
    at: last, best, leg: i, of: wps.length,
  };
}

/* One leg whose corners are already decided: walk them in order.
 *
 * The corners come from stairRoutes(), which is 0257's "hand-author it as the
 * corners of the walk the owner would take". This is the same walk() and the same
 * arrival assertion as leg() below; the only difference is where the waypoints come
 * from, which is the whole point: a router's shortest path is free to take a drop. */
/* --leg NAME, by label (0345). Gating here rather than at twelve call sites means one
 * place to change when a leg is added, and the label is already the thing the table
 * prints -- so `--leg` names are the same strings the failure lines use. */
/* Module scope, not main()'s: legWanted() reads LEG and it is called from the route
 * builders, which run before and outside main's frame. */
const TEAM = (() => {
  const i = process.argv.indexOf('--team');
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : 'both';
})();

const LEG = (() => {
  const i = process.argv.indexOf('--leg');
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : 'all';
})();

const LEG_WORDS = {
  a: ['vault, down'], b: ['back up the dog-leg'], c: ['water', 'the bed'],
  across: ['across'], parapet: ['parapet'], drop: ['fell off', 'landed'],
  doortokey: ['enemy key'],
};

/* The water blocks are gated by hand the way the drop is (0355): each is a BLOCK with a
 * teleport in it, not a legWaypoints call, so the label gate cannot see it and --leg c
 * would run every one of them. */
function waterBlockWanted(which) {
  // c1 runs for --leg c and --leg swim (it IS leg c, split in two); the old end-to-end
  // water walk runs only for --leg c.
  if (LEG === 'all') return true;
  if (LEG === which) return true;
  return which === 'c1' && (LEG === 'c' || LEG === 'swim');
}

function legWanted(label) {
  const sel = LEG;
  if (sel === 'all') return true;
  const words = LEG_WORDS[sel];
  if (!words) return true;
  return words.some(w => String(label).includes(w));
}

/* Which of this team's legs to WALK. Separate from legWanted() because the gate is on
 * the route's NAME (which is stable) rather than on the label a failure prints, and the
 * drop legs' labels are sentences. */
function walkWanted(name) {
  if (LEG === 'all') return true;
  const byName = { a: ['toVault'], b: ['outOfVault'], c: ['swimOut', 'stepsDown', 'stepsUp'],
                   swim: ['swimOut'],
                   steps: ['stepsDown', 'stepsUp'],
                   across: ['across'], parapet: ['upBattlement', 'downBattlement'],
                   drop: ['dropped'], doortokey: ['doorToKey'] };
  const names = byName[LEG];
  return names ? names.includes(name) : true;
}

async function legWaypoints(client, server, wps, label, opts) {
  if (!legWanted(label) || !walkWanted(opts && opts.routeName)) {
    console.log(`  skip  ${label} (--leg ${LEG})`);
    return;
  }
  const zFrom = wps[0][2];
  server.goto(wps[0][0], wps[0][1], wps[0][2]);
  await sleep(1500);
  await client.hold('w', 'KeyW', 87);
  const r = await walk(client, server, wps,
                       Object.assign({ client: client }, opts || {}));
  await client.release('w', 'KeyW', 87);
  await sleep(400);
  const trail = server.positions().slice(-8)
    .map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`).join(' ');
  if (r.arrived) {
    ok(`${label}: walked ${r.tried} of ${wps.length} corners to within ` +
       `${(opts && opts.reach) || 64} of the last one` +
       (r.tried < wps.length ? ` (${r.why}; the last corners are inside that)` : ''));
    if ((opts && opts.climb) !== undefined) {
      const gained = (r.at ? r.at.z : 0) - zFrom;
      check(gained >= (opts.climb - 8),
            `${label}: and it GAINED ${gained.toFixed(0)} of height on the way`,
            `wanted at least ${opts.climb - 8} from z=${zFrom.toFixed(0)}; ` +
            `last positions ${trail}`);
    }
  } else {
    bad(`${label}: the player did not get there`,
        `stalled at ${r.at ? [r.at.x, r.at.y, r.at.z].map(v => v.toFixed(0)).join(',') : '?'}` +
        `, ${r.why}, ${r.best.toFixed(0)} from the goal, corner ` +
        `${r.leg + 1}/${r.of} of ` +
        `${JSON.stringify(wps[Math.min(r.leg, wps.length - 1)])}; ` +
        `last positions ${trail}`);
  }
  return r;
}

/* One leg: prove a route exists, then walk it. */
async function leg(client, server, from, to, label, opts) {
  const wps = route(from, to);
  if (!wps) {
    bad(`${label}: there is a route at all`,
        `map_route found none from ${from} to ${to} -- this is a map problem, ` +
        `not a walking one`);
    return null;
  }
  const zFrom = from[2], zTo = to[2];
  /* Put the player at the START, then hold W only for the walk.
   *
   * Both halves matter. W was held from before the first leg, so the player walked
   * off in whatever direction the spawn faces while the harness was still reading
   * the first position -- and because the first route's first waypoint is due
   * north, he walked north, off the floor of the shaft, and was 352 units down at
   * the vault level before the steering began. From there the aim was correct and
   * useless: "aim yaw=270 probe yaw=270" and the position never changed, which
   * reads like broken geometry and is really a player standing in a pit with the
   * right idea.
   *
   * Teleporting to the start of a leg is what reviewer 0246 allows ("use teleports
   * ONLY to set the start point"); everything between here and the goal is walked.
   */
  server.goto(from[0], from[1], from[2]);
  await sleep(1500);
  /* The face is the server's business now: the first waypoint is named here and the
   * probe aims at it from the frame the player is put down. */
  await client.hold('w', 'KeyW', 87);
  const before = server.last();
  const r = await walk(client, server, wps,
                    Object.assign({ client: client }, opts || {}));
  await client.release('w', 'KeyW', 87);
  await sleep(400);
  const trail = server.positions().slice(-8)
    .map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`).join(' ');
  if (r.arrived) {
    ok(`${label}: walked ${r.tried} of ${wps.length} waypoints to within ` +
       `${(opts && opts.reach) || 64} of the goal` +
       (r.tried < wps.length ? ` (${r.why}; the last corners are inside that)` : ''));
    if ((opts && opts.climb) !== undefined) {
      const gained = (r.at ? r.at.z : 0) - zFrom;
      check(gained >= (opts.climb - 8),
            `${label}: and it GAINED ${gained.toFixed(0)} of height on the way`,
            `wanted at least ${opts.climb - 8}, from z=${zFrom.toFixed(0)}; ` +
            `last positions ${trail}`);
    }
  } else {
    bad(`${label}: the player did not get there`,
        `stopped at ${r.at ? [r.at.x, r.at.y, r.at.z].map(v => v.toFixed(0)).join(',') : '?'}` +
        `, ${r.best.toFixed(0)} from the goal, waypoint ${r.leg + 1}/${r.of}; ` +
        `last positions ${trail}` +
        (before ? '' : ' (and the probe never reported the player at all)'));
  }
  return r;
}

/* THE ROUTES, HAND-AUTHORED FROM THE MAP'S OWN NUMBERS (reviewer 0257).
 *
 * Not the router's shortest path. The router checks that a hull fits and that
 * rising costs a step, and it will happily take a DROP: its path from the spawn to
 * the vault crosses the shaft by stepping off its edge at x=400. A player keeps his
 * horizontal velocity through a 352-unit fall, drifts 80 east and lands against the
 * passage's side wall -- measured (480,1200) with the wall between him and the next
 * waypoint. No lookahead fixes that; the route is wrong for a player.
 *
 * These are the corners of the walk the OWNER would take, and 0257's rule is
 * CHECKED rather than asserted: consecutive waypoints are within 18 of z unless the
 * pair is a flight's bottom and top (which is the step the player takes), and drops
 * appear only in leg (b) and the water in leg (c).
 *
 * Every corner is derived from gen_map -- the corridor's and the stairwell's own
 * spans, the crossing's, and the flights it says it built (FORTS_FLIGHTS, which
 * carries each flight's footprint) -- so the route follows the map instead of a
 * number copied out of it.
 */
/* What the engine run needs to know about the map's own geometry, measured here so
 * the check in main() can quote it. */
const STAIR_GAPS = {};

function stairRoutes(G) {
  const stand = 24;                         // a player origin above a floor
  const ground = G.floor_t + stand;
  const vault = G.vault_t + stand;
  const roof = G.roof_t + stand;
  const bed = G.bed_t + stand;
  const mid = G.len / 2;
  const byMid = (G.bridge_y[0] + G.bridge_y[1]) / 2;      // the crossing's centre
  const py = (G.passage_y[0] + G.passage_y[1]) / 2;       // the corridor's centre
  // The dog-leg: leg 1 climbs +y from the corridor, leg 2 climbs -x back along the
  // landing. Its foot is leg 1's first tread and its head is leg 2's last, and both
  // come out of the flight records rather than out of my head.
  /* THE STRAIGHT FLIGHT, not the dog-leg. The dog-leg was two records, "vault leg 1"
   * and "vault leg 2", with a landing between them; it is gone (0286/0297 replaced it
   * with one straight enclosed flight) and every corner below used to be derived from
   * those two names -- so with them gone `dog.foot` was undefined and this threw
   * before it walked anything. One record now, "vault stair", read from the map the
   * same way the parapet is: its own box, bottom at the WEST end and top at the EAST,
   * because it descends westward (FORTS_STAIR_X = 224..512). */
  // 'vault ramp' is what gen_map calls it now (0341: level changes are ramps). Both
  // names are accepted so a reader is not broken by the rename, and the error below
  // still fires when NEITHER is there -- which is the check that matters.
  // ON THE RAMP'S OWN SURFACE, where the flight is a ramp: `parapet[1] + 32` is 32 up
  // its run, and the surface there is not the fort floor's height.
  const surfZ = (fl, x, y, fallback) => {
    if (!fl || !fl.ramp) return fallback;
    const lo = fl.axis === 'x' ? fl.x0 : fl.y0;
    const hi = fl.axis === 'x' ? fl.x1 : fl.y1;
    const t = Math.max(0, Math.min(1, ((fl.axis === 'x' ? x : y) - lo) / (hi - lo)));
    // + `stand`, like `ground`/`roof`/`vault` below: these corners are where the
    // player's ORIGIN goes, and a player's origin is 24 above the surface. Without it
    // the corner is 24 inside the ramp and the walker steers into the slope -- which is
    // what the parapet leg did: "stalled at 282,570,45, corner 2/4 of [256,608,33.6]".
    return fl.z_lo + (fl.z_hi - fl.z_lo) * t + stand;
  };
  const flight = (G.flights.find(f => /^vault (stair|ramp)$/.test(f.name)
                                  && !f.mirrored) || {}).box;
  if (!flight) {
    throw new Error('the map reports no "vault stair" flight, so there is nothing to '
      + 'walk down to the key: ' + JSON.stringify((G.flights || []).map(f => f.name)));
  }
  const syMid = (flight[1] + flight[3]) / 2;
  // The vault flight is a RAMP now, so its foot is on the slope and not on the vault
  // floor: one riser above it. `surfZ` is the same question as for the parapet.
  const vFl = G.flights.find(f => /^vault (stair|ramp)$/.test(f.name) && !f.mirrored) || {};
  const vfx = flight[0] + 32;
  const dogFoot = [vfx, syMid, surfZ(vFl, vfx, syMid, vault)];   // the low end
  const dogHead = [flight[2] - 32, syMid, ground];  // the top, at the landing
  /* WHERE THE HEAD MEETS THE FORT FLOOR. The head tread is at floor level but sits
   * INSIDE the hole in that floor (the hole is design x 144..448, the head x
   * 192..216), so a player at the top of the dog-leg has one step of floor to
   * westward before the hole starts again -- 96 world of it, at the same height, so
   * it is a walk and not a step. That ledge is the whole connection, and it is why
   * the dog-leg IS the way down.
   *
   * I had this backwards (0264): I wrote a route that went from the spawn to the
   * corridor first and reported "there is no way down", when the flight itself is
   * the way down and my corners were in a nonsensical order. A flight that goes up
   * from A to B also goes down from B to A -- which is the reviewer's point and it
   * is correct. The `traps` check was right and I misread it: there is no trap,
   * there is a stair. */
  /* ... AND HERE IS THE MEASUREMENT THAT SAYS IT DOES NOT REACH. The top tread's
   * own footprint (leg 2) is world x 384..768, y 1488..1552 and the hole in the
   * fort floor starts at world x 288. So between the top tread and the floor there
   * is 96 of nothing at floor level: a player at the top of the dog-leg stands at
   * floor HEIGHT in the middle of the hole, with 96 of gap to the west before the
   * floor starts again. They step west and they fall. That is the reviewer's case
   * (ii) -- "its top lands in the shaft" -- and it is why leg (a) stalls at
   * (480,880), one floor below where it started.
   *
   * So: the dog-leg IS a stair (a flight that goes up goes down, and the route rule
   * now says so -- all fourteen route checks pass), and its top does not join the
   * fort floor. The vault is escapable, which is what `traps` checks and it is not
   * vacuous about it. What is missing is the last 96 of floor, and more to the point
   * the reviewer's design: an open hole in a floor people walk on, which is how the
   * owner has ended up in this shaft in every build. */
  // The landing, east of the flight's top tread and at the hall floor's own
  // height. It replaces the old `ledge`, which was 96 of floor west of the
  // dog-leg's head and existed only because the head tread sat 48 short of it.
  const ledge = [flight[2] + 32, syMid, ground];
  /* The GAP is from the flight's own west EDGE, not from the corner I picked in the
   * middle of it: leg 2's box starts at world x=336 and the hole in the fort floor
   * starts at 288, so there are 48 of nothing at floor level between the top tread
   * and the floor. A hull is 32 wide, so 48 is a fall, not a step. */
  /* The gap the old dog-leg had -- 48 of nothing between its head tread and the hole
   * in the floor -- cannot exist now: the flight's top tread is flush with the
   * landing at the hall floor (0286), so head and floor are the same height and the
   * same walk. Recorded as 0 rather than deleted, because a reader looking for the
   * gap should find that it was closed and why. */
  STAIR_GAPS.head = 0;
  STAIR_GAPS.floorEdge = flight[2];
  STAIR_GAPS.treadEdge = flight[2];
  // 'parapet ramp' now; both names accepted, as with the vault flight above.
  const parapet = (G.flights.find(f => /^parapet( stair| ramp)?$/.test(f.name)
                          && !f.mirrored) || {}).box;
  if (!parapet) {
    throw new Error('the map reports no parapet flight, so there is nothing to walk '
      + 'up to the battlement: ' + JSON.stringify((G.flights || []).map(f => f.name)));
  }
  // The water steps out of the channel, from the same records (0335: every corner comes
  // from the map). There are two per fort -- north and south of the bridge -- and the
  // SOUTH one is the one the leg swims to, because the north one is behind the bridge.
  // 'water ramp' is what gen_map calls it now; both names accepted, as above.
  const stepsAll = (G.flights || []).filter(f => /^water (steps|ramp)$/.test(f.name)
                                            && !f.mirrored).map(f => f.box)
    .sort((a, b) => a[1] - b[1]);
  if (!stepsAll.length) {
    throw new Error('the map reports no "water steps" flight, so leg (c) has nothing '
      + 'to swim to: ' + JSON.stringify((G.flights || []).map(f => f.name)));
  }
  // The flight RECORD, not just its box: the ramp corners below ask surfZ() for
  // the surface ON the slope, and surfZ reads the record's axis and end heights.
  const stepsFl = (G.flights.find(f => /^water (steps|ramp)$/.test(f.name)
                                    && !f.mirrored));
  const steps = stepsFl.box;
  const paraFl = G.flights.find(f => /^parapet( stair| ramp)?$/.test(f.name)
                                 && !f.mirrored) || {};
  const pfx = (parapet[0] + parapet[2]) / 2;
  const stairFoot = [pfx, parapet[1] + 32, surfZ(paraFl, pfx, parapet[1] + 32, ground)];
  const stairHead = [pfx, parapet[3] - 32, surfZ(paraFl, pfx, parapet[3] - 32, roof)];
  // The crossing: the fort's own floor, the door's threshold, and the deck outside.
  const doorIn = [G.wall_x[1] - 96, byMid, ground];
  const doorOut = [G.wall_x[1] + G.stair_w, byMid, ground];
  // The corridor's middle, in LOCAL x -- it is inside the per-fort loop below and gets
  // mx() there. It was not, and that is the fort B route-rule failure in 0343: the pair
  // ran 4352,1264,-288 (fort B's door, correctly mirrored) -> 784,1024,-264 (fort A's
  // corridor, not mirrored at all), so the rule read it as a 24-unit step across the map.
  const corridor = [(G.passage_x[0] + G.passage_x[1]) / 2, py, vault];
  const out = { A: {}, B: {} };
  // BOTH teams are always built. Building costs nothing -- no engine, just geometry --
  // and gating it here left ROUTES.A undefined for `--team blue`, so every blue leg died
  // with "Cannot read properties of undefined". The team filter belongs on the WALKS.
  for (const tag of ['A', 'B']) {
    const m = tag === 'A' ? 1 : -1;
    const mx = v => (tag === 'A' ? v : G.len - v);
    const spawn = tag === 'A' ? G.spawn : G.spawn_b;
    const key = tag === 'A' ? G.key_a : G.key_b;
    const R = out[tag];
    // Down into the vault and up out of it, on the dog-leg both ways -- and the
    // order is the flight's order: floor, ledge, head, down the flight, foot,
    // corridor, key.
    // West of the hole FIRST, then north: the straight line from the spawn to the
    // ledge crosses the hole's mouth, and the player walked into it and fell --
    // measured (480,880) one floor below where he started. The corner is the wall
    // along the hole's west side, not a diagonal.
    // The hall floor on the landing's side of the shaft, then north to the landing.
    // The old pair went round the hole's west mouth, which is not where the hole is
    // any more: it is the flight's own span, walled on its north and south sides.
    const corridorM = [mx(corridor[0]), corridor[1], corridor[2]];
    /* The flight's own corners, MIRRORED (0365). dogFoot, dogHead, ledge, west and north
     * are built from `flight`, which GEO_PY exports UNMIRRORED, and only the ones passed
     * through mx() were ever on the right side of the map. Fort B's whole vault leg was
     * walking to fort A's stairwell: 17 corners on the near side, which the new
     * half-of-the-map assertion caught before a single engine run. That is the third time
     * this week one of these has been invisible in a stall position and obvious in one
     * comparison. */
    const mFoot = [mx(dogFoot[0]), dogFoot[1], dogFoot[2], 'L'];  // the flight's foot
    const mHead = [mx(dogHead[0]), dogHead[1], dogHead[2], 'L'];  // the flight's head
    const mLedge = [mx(ledge[0]), ledge[1], ledge[2], 'L'];   // the landing
    const west = [mx(flight[2] + 96), spawn[1], ground];
    const north = [mx(flight[2] + 96), mHead[1], ground];
    // The DOOR'S CENTRE, between the flight's foot and the corridor (0338). The flight
    // runs along x and the corridor's north wall is pierced once, at the door, so a
    // straight line from the landing's end to the corridor's middle crosses that wall
    // somewhere to the east of the opening -- and the steering, which is a yaw and a
    // walk, pins against it. The corner is the middle of the door the map reports.
    // z is `vault`, the ORIGIN, like every other corner here -- G.vault is the vault
    // FLOOR and the two differ by HULL_MIN_Z, so mixing them made the rule read the
    // door-to-corridor pair as a 24-unit step up (0343).
    const doorC = [mx((G.stair_door[0] + G.stair_door[1]) / 2), (flight[1] + flight[3]) / 2,
                   vault, 'L'];                                      // the DOOR
    /* ... AND THE DOORWAY'S OWN Y, which is a different y from the flight's. doorC sits
     * at the flight's middle (1264 in the world) and the doorway is 80 further south
     * (1152..1184), so the straight line from doorC to the corridor's middle leaves the
     * doorway sideways: the player walks south-east, clears the flight's own x, and runs
     * into the ramp's solid flank 112 north of the opening. The trace said exactly that
     * -- "seq 8 sent (784, 1024, -264) ... ** never arrived **" -- and it is 0338's
     * lesson again: "derived" is not "walkable in a straight line", and the missing
     * corner is the one IN the door.
     *
     * G.passage_y is ALREADY scaled (GEO_PY scales it), so this is the doorway's own
     * middle in world units and nothing here is scaled again. Multiplying by G.scale a
     * second time put the corner at y=2320, off the map, and the leg sent eight
     * waypoints instead of nine without saying so -- the third time in this thread that
     * a coordinate was scaled twice. */
    const doorY = [mx((G.stair_door[0] + G.stair_door[1]) / 2), G.passage_y[1] + 8, vault];
    R.toVault = [spawn, west, north, mLedge, mHead, mFoot, doorC, doorY, corridorM, key];
    R.outOfVault = [key, corridorM, doorY, doorC, mFoot, mHead, mLedge, north, west, spawn];
    // Out of the bridge door, across, and into the far fort's floor.
    // Up the parapet flight and back down it.
    /* The parapet and the bridge door's corners, MIRRORED (0365/0371). They were built
     * outside the loop from LOCAL x and only mx()'d where they were used, so fort B's
     * crossing leg walked to fort A's doorway and its battlement leg to fort A's flight:
     * `across[1] [800,704,24]` and `upBattlement[1] [256,608,24]` on a blue leg, both on
     * the near side. Same class as the vault corners, found by the same assertion. */
    const sFoot = [mx(stairFoot[0]), stairFoot[1], stairFoot[2]];
    const sHead = [mx(stairHead[0]), stairHead[1], stairHead[2]];
    const dIn = [mx(doorIn[0]), doorIn[1], doorIn[2]];
    const dOut = [mx(doorOut[0]), doorOut[1], doorOut[2]];
    R.across = [spawn, dIn, dOut, [mid, byMid, ground]];
    // The battlement is at the HEAD of the flight, not the foot. It was
    // `parapet[1] + 32` -- 32 up the flight's own RUN, which is its LOW end -- at roof
    // height, i.e. a point on the parapet with 250 of nothing under it. On a staircase
    // the legs still passed, because the stair rule and the swept-hull check both only
    // ever saw the corners before it; the walker reached the head and then walked to a
    // point it could not be at. Now it is the head's own end, on the roof strip north of
    // the flight, which is where the battlement is.
    const bat = [mx(parapet[2] - 32), parapet[3] + 32, roof];
    R.upBattlement = [spawn, sFoot, sHead, bat];
    R.downBattlement = [bat, sHead, sFoot, spawn];
    // (b) THE DROP: put the player on the battlement and let them fall off it, then
    // walk out. The waypoint after the fall is where they LAND, not the edge.
    /* The battlement -> landing -> corridor -> flight -> key, and the LANDING is the
     * corner that makes it (0383). It used to go straight from the battlement to the
     * corridor's middle, and the trace said why: the player was sent to (784,1024,-264)
     * and ARRIVED at (755,991,+24) -- the fort floor -- because the only way from the
     * hall into the shaft is the landing at its east end, and the shaft's south rail
     * (y 1184, solid at floor level) is between the hall and the corridor. Same defect
     * as toVault's missing door corner in 0338; the swept-hull check passes it either
     * way, because the straight line between the corners goes ROUND the rail. An
     * assertion on the straight line cannot see a missing corner -- that is a property
     * of the method, and worth knowing before the ramp work leans on it. */
    R.dropped = [[mx(parapet[0] + 32), parapet[1] + 32, roof], mLedge, corridorM,
                 mFoot, key];
    // (c) THE WATER: the channel bed, then the ramp, then the bank top.
    /* (c) THE WATER: the channel bed, SWIM to the ramp, up it, and out onto the
     * bank. The ramp's foot and top are read off the flight the map reports
     * ("water ramp"), not typed: they are built on side A and mirrored, and a
     * typed x is wrong the moment either moves -- which is exactly what happened
     * to the parapet's corner in 0335.
     *
     * The first waypoint is the middle of the channel, so the leg has to swim
     * before it has to climb.
     *
     * The trace that settled the SWIMMER'S need to surface first (0368) still
     * holds: a waypoint below the player tells the probe there is nothing to
     * rise for, so the swim leg's corners climb -- the surface over the slot's
     * mouth, then the landing, then the bank top. Holding jump to reach them is
     * the thing probe.qc's rule was written for. */
    /* c is TWO tests, not one swim (0384), because "the swimmer gets out somewhere" and
     * "the steps are a way out" are different claims and the first was hiding the second.
     *
     * c1 (the outcome): into the middle of the channel, face the nearest steps, hold
     *   forward and jump to the surface. It PASSES on the OUTCOME -- waterlevel 0,
     *   z >= 0, health > 0 -- and it PRINTS where they came out, because that is the
     *   datum that matters and where they land is not something to assert.
     * c2 (the steps, on foot, both ways): start on the bank at the top of the steps, walk
     *   DOWN the treads to the foot and back UP. This proves the steps are an exit using
     *   the steering that already works -- a, b and across all pass on it -- so it does
     *   not depend on swimming at all.
     *
     * The old single leg asked one route to swim, climb and walk out, and reported only
     * TIMEOUT, which told us nothing about which of the three had failed.
     *
     * 2026-10-09, the passage walled: the OLD water leg walked the bed, THROUGH the
     * passage, to the key and out -- which is exactly the shortcut the owner has now
     * closed ("one just has to get in the water and swim back and forth"). The swim legs
     * are the ramp and the bank now: the swimmer surfaces over the slot's mouth south of
     * the flight, wades up the ramp to its landing, and walks the two steps onto the bank
     * top. The corners are the flight's own record (steps[]) plus the landing and steps
     * that stand north of it: the landing's top IS the record's high end (steps[5]), and
     * each step is 16 world above the one before, so nothing here is typed twice. */
    const landY = steps[3] + 64;         // the flat landing's middle, 128 world long
    const step1Y = steps[3] + 160;       // the first step's middle (top steps[5]+16)
    const step2Y = steps[3] + 224;       // the second step's middle (top 0, the bank)
    const bankX = steps[0] - 16;         // on the bank, a hull's half-width off its edge
    const rampMidY = (steps[1] + steps[3]) / 2;
    const rampMid = [mx(steps[0] + 32), rampMidY, surfZ(stepsFl, steps[0] + 32,
                                                        rampMidY, bed)];
    const rampFoot = [mx(steps[0] + 32), steps[1] + 48,
                      surfZ(stepsFl, steps[0] + 32, steps[1] + 48, bed)];
    /* THE BANK DOOR (2026-10-09), read off the map's own constants: the doorway
     * in the north wall that the steps' bank feeds. The walk's last three
     * corners stand outside it, in it, and inside the hall -- sill at bank-top
     * level, so every one of them is at `ground`. */
    const bdX = (G.bank_door_x[0] + G.bank_door_x[1]) / 2;
    const bdY = G.bank_door_y;
    const bankOut = [mx(bdX), bdY[1] + 32, ground];
    const doorN = [mx(bdX), (bdY[0] + bdY[1]) / 2, ground];
    const bankIn = [mx(bdX), bdY[0] - 32, ground];
    R.swimOut = [[mid, py - 256, bed],
                 [mx(steps[0] + 64), steps[1] - 64, G.water + stand],
                 [mx(steps[0] + 64), landY, steps[5] + stand],
                 [mx(steps[0] + 64), step2Y, ground],
                 [mx(bankX), step2Y, ground],
                 bankOut, doorN, bankIn];
    // c2: the treads themselves, top to foot and back. The flight's own box gives them.
    /* Waypoints ON the surfaces (0384), not beside them: the bank corner stands on the
     * bank top, the step corners on their own treads, and the ramp corners on the
     * flight's surface via surfZ -- the first version of the old leg put a corner on the
     * bank at y=64 and one on the bed at y=288, and the stair rule called it "a 288-unit
     * drop the route was supposed to avoid", which is correct: those two points are not
     * a staircase, they are its two ends. */
    R.stepsDown = [[mx(bankX), step2Y, ground],
                   [mx(steps[0] + 64), step2Y, ground],
                   [mx(steps[0] + 64), step1Y, steps[5] + 16 + stand],
                   [mx(steps[0] + 64), landY, steps[5] + stand],
                   rampMid, rampFoot];
    R.stepsUp = [rampFoot, rampMid,
                 [mx(steps[0] + 64), landY, steps[5] + stand],
                 [mx(steps[0] + 64), step1Y, steps[5] + 16 + stand],
                 [mx(steps[0] + 64), step2Y, ground],
                 [mx(bankX), step2Y, ground]];
    /* THE KEY RUN FROM THE BANK (2026-10-09): from inside the fort at the bank
     * door, out the bridge door, across the deck, in through the ENEMY fort's
     * bridge door, and down their stairwell to their key. This is the walk the
     * owner's swim-and-climb now feeds: the water is no longer a way INTO a
     * vault, so a carrier who bails into the channel comes back into the fight
     * the long way, through the door every player uses.
     *
     * The enemy's corners are the SAME local expressions mirrored the OTHER way
     * (mxOther), which is exactly what mx() does for the other tag's own legs --
     * the mirror maps A's flight foot to B's flight foot, not to B's head, so
     * the mirrored corners stay the right ends of their own flight. */
    const mxOther = tag === 'A' ? (v => G.len - v) : (v => v);
    const dInE = [mxOther(doorIn[0]), byMid, ground];
    const dOutE = [mxOther(doorOut[0]), byMid, ground];
    const headE = [mxOther(flight[2] - 32), syMid, ground];
    const footE = [mxOther(vfx), syMid, surfZ(vFl, vfx, syMid, vault), 'L'];
    const doorCE = [mxOther((G.stair_door[0] + G.stair_door[1]) / 2),
                    (flight[1] + flight[3]) / 2, vault, 'L'];
    const doorYE = [mxOther((G.stair_door[0] + G.stair_door[1]) / 2),
                    G.passage_y[1] + 8, vault];
    const corrE = [mxOther((G.passage_x[0] + G.passage_x[1]) / 2), py, vault];
    // The ENEMY's key, not this fort's: `key` above is the own team's, and a
    // leg into the enemy fort that ends on the OWN key would be walking home
    // with nothing.
    const keyE = tag === 'A' ? G.key_b : G.key_a;
    R.doorToKey = [bankIn, dIn, dOut, [mid, byMid, ground],
                   dOutE, dInE, headE, footE, doorCE, doorYE, corrE, keyE];
  }
  return out;
}

/* THE SWEPT-HULL ASSERTION (0345, 0338). Every consecutive corner pair swept with a real
 * 32-wide hull against maps/forts.map BEFORE anything is walked, naming the pair and the
 * first solid it hits.
 *
 * WHY, in one paragraph, because this is the third time in a week I had to decide by hand
 * whether a stall was the map or the route, and I got it wrong twice: every corner in
 * `toVault` came from the map's own records and the leg still stalled, because "derived"
 * is not "walkable in a straight line" -- the flight runs along x, the corridor's north
 * wall is pierced once, and the straight line between two correct corners crosses that
 * wall somewhere else. This makes that class of answer mechanical.
 *
 * THE RULE: walk the segment in 8-unit steps; at each sample the hull must be free,
 * EXCEPT where the solid it hits is a tread it is stepping UP onto by 18 or less --
 * which is a stair, and the whole point of the map. Anything else is either a wall the
 * route goes through or a drop the route does not expect, and both are named.
 */
const SWEEP_STEP = 8;
const g_player_rise = 18;   // PLAYER_RISE: what a player walks UP, not a guess
const HULL_XY = 16;
const HULL_BELOW = 24, HULL_ABOVE = 32;

/* EPS, because a hull RESTING ON a surface is not inside it -- and without it the sweep
 * reported the bed itself as an obstruction to every corridor corner, because the hull's
 * bottom (-288) is exactly the bed's top (-288) and floating point rounds one of them a
 * hair over. That is the assertion reporting a floor as a wall, which would have made it
 * noise instead of signal on its first run. */
const SWEEP_EPS = 0.05;

function hullInside(bs, x, y, z) {
  for (const b of bs) {
    if (b[0] < x + HULL_XY - SWEEP_EPS && b[3] > x - HULL_XY + SWEEP_EPS &&
        b[1] < y + HULL_XY - SWEEP_EPS && b[4] > y - HULL_XY + SWEEP_EPS &&
        b[2] < z + HULL_ABOVE - SWEEP_EPS && b[5] > z - HULL_BELOW + SWEEP_EPS) return b;
  }
  return null;
}

/* The floor under (x, y) the player would be standing on, at or just below `want`.
 *
 * A sweep that interpolates z between two corners does not describe a player: on the
 * way down a flight it sinks the hull into each tread it just left, and on the first
 * few units of any segment it dips below the corner's own floor. Both made the
 * assertion report the flight's own treads as walls. A player walks ON the surface, so
 * the sweep has to find the surface: the highest top at this column that is at or below
 * `want` plus a little (so the player does not float up a wall) and not more than 32
 * below it (so it does not free-fall). */
function floorUnder(bs, x, y, want) {
  let best = null;
  for (const b of bs) {
    if (b[0] > x + HULL_XY || b[3] < x - HULL_XY ||
        b[1] > y + HULL_XY || b[4] < y - HULL_XY) continue;
    const top = b[5];
    if (top > want + 4) continue;
    if (want - top > 32) continue;
    if (best === null || top > best) best = top;
  }
  return best;
}

function sweepPair(bs, a, b) {
  // The first solid a hull meets walking a -> b, or null.
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(d / SWEEP_STEP));
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const x = a[0] + dx * f, y = a[1] + dy * f;
    const want = a[2] + (b[2] - a[2]) * f;
    const floor = floorUnder(bs, x, y, want);
    const z = (floor === null ? want : floor + HULL_BELOW);
    const hit = hullInside(bs, x, y, z);
    if (!hit) continue;
    /* A tread is not an obstruction, and the rule is ONE-SIDED on purpose:
     * PLAYER_RISE above the feet is walkable -- that is what a stair IS -- and anything
     * below the feet is a floor they are on or dropping to. Only a solid whose top is
     * MORE than 18 above the feet is a wall.
     *
     * It had a lower bound of -SWEEP_EPS as well, which meant "the hull may not be more
     * than a hair inside a tread from below" -- and that reported every tread of the
     * flight as a wall to the leg that walks down it, because the flight's treads are 32
     * deep and the hull is 32 wide, so the hull always overlaps the next tread up and
     * always steps onto it. The lower bound was the wrong half of the rule.
     */
    const stepUp = z - HULL_BELOW - hit[5];
    if (stepUp <= g_player_rise) continue;
    return { at: [Math.round(x), Math.round(y), Math.round(z)], solid: hit, stepUp };
  }
  return null;
}

/* EVERY CORNER IS ON ITS OWN TEAM'S HALF (0365). Checked BEFORE anything walks, and chosen
 * by the LEG's team -- never by where the player happens to be standing, which is how a
 * leg can "work" by walking across the map.
 *
 * This would have caught both mirror bugs this week before a single engine run: the
 * corridor corner that was never put through mx() (fort B's route ran to fort A's
 * corridor), and leg (c)'s swim that carried the player from mid-x to the FAR fort. Both
 * were invisible in a stall position and both were one comparison here.
 *
 * The water legs are the exception, because they are SUPPOSED to be in the channel: their
 * corners are allowed anywhere the channel is, and the test says so rather than skipping
 * them, because "the water legs are exempt" is a claim worth making visible. */
function checkLegHalf(routes, G, team, legsInChannel = [], legsCrossOnce = []) {
  const mid = G.len / 2;
  const wrong = [];
  for (const [name, wps] of Object.entries(routes)) {
    const inChannel = legsInChannel.includes(name);
    const crossOnce = legsCrossOnce.includes(name);
    let crossed = false;
    for (const [i, w] of wps.entries()) {
      const here = w[0] < mid;
      // ownHalf: the half THIS team's fort is on. The deck's own mid-x corner
      // reads as own-half for both teams by the `here !== red` convention the
      // channel legs already use, which is right: it is the channel.
      const ownHalf = here === (team === 'red');
      const chanLo = G.water_x0, chanHi = G.water_x1;
      const inChan = w[0] >= chanLo - 64 && w[0] <= chanHi + 64;
      if (crossOnce) {
        // A leg that crosses EXACTLY ONCE, over the deck (2026-10-09:
        // doorToKey, from the bank door to the enemy key). Every corner before
        // the crossing is this team's half or the channel; every corner after
        // it is the OTHER team's half or the channel. A corner back on this
        // team's own half after the crossing is the mirror bug this check
        // exists for -- a leg that wanders home mid-route instead of walking
        // into the enemy fort.
        if (crossed && ownHalf && !inChan) {
          wrong.push(`${name}[${i}] ${JSON.stringify(w)} is back on ${team}'s own ` +
            `half after the leg crossed (mid-x ${mid})`);
        }
        if (!ownHalf && !crossed) crossed = true;
      } else if (inChannel) {
        // allowed: this team's half, or the channel between the forts
        const okChan = inChan || ownHalf;
        if (!okChan) wrong.push(`${name}[${i}] ${JSON.stringify(w)} is not on ${team}'s ` +
          `half nor in the channel (mid-x ${mid})`);
      } else if (here !== (team === 'red')) {
        wrong.push(`${name}[${i}] ${JSON.stringify(w)} is on the ` +
          `${here ? 'near' : 'far'} side of a ${team} leg (mid-x ${mid})`);
      }
    }
  }
  check(!wrong.length,
        `every corner of every ${team} leg is on that team's own half of the map`,
        wrong.slice(0, 4).join(' | ') +
        (wrong.length > 4 ? ` ... and ${wrong.length - 4} more` : '') +
        '. A corner on the far side means something mirrored it when it did not need to, ' +
        'or was never mirrored when it did -- and the leg will walk the player across the ' +
        'map to find out.');
}

function checkSweptHulls(routes, G, team) {
  const bs = G.solids || [];
  check(bs.length > 100, "the map's solids are loaded for the swept-hull check",
        `only ${bs.length}: the .map could not be read, so nothing below is tested`);
  if (!bs.length) return;
  const problems = [];
  for (const [name, wps] of Object.entries(routes)) {
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      const hit = sweepPair(bs, a, b);
      if (hit) {
        problems.push(`${name}[${i}->${i + 1}] ${JSON.stringify(a)} -> ` +
                      `${JSON.stringify(b)} hits ${JSON.stringify(hit.solid.slice(0, 6))} ` +
                      `at ${JSON.stringify(hit.at)} (step ${hit.stepUp.toFixed(1)})`);
      }
    }
  }
  check(!problems.length,
        `every corner pair of every ${team} leg sweeps a hull clear against the map`,
        problems.slice(0, 4).join(' | ') +
        (problems.length > 4 ? ` ... and ${problems.length - 4} more` : '') +
        '. Either the route crosses something it does not expect -- add a corner, and ' +
        'the door is usually the one it wants -- or the map has no way through there.');
}

/* 0257's rule, MEASURED: consecutive waypoints within 18 of z, except where the pair
 * is a flight's bottom and top -- the step the player takes -- and except the legs
 * that are supposed to contain a fall. */
function checkStairRule(routes, G) {
  /* The steps that are ALLOWED to be big, and why: a pair of corners that spans a
   * flight. Taken from the flight records gen_map already keeps -- the footprint and
   * the z range of every flight it built -- and matched by the corner being inside
   * that footprint's plan, so the exception follows the map instead of a list. */
  /* MERGED BY FLIGHT, not by record. The dog-leg is two records ("vault leg 1" and
   * "vault leg 2") with the landing between them, and neither record's own z span
   * covers the climb: leg 1 is 119 and leg 2 is 137, while the flight the player
   * walks is 288. So the exception is looked up on the merged span -- one bounding
   * box and one z range per flight, "vault" and "parapet" -- because that is what
   * the player experiences. Looking it up per record is how the check came to call
   * a 288-unit climb a drop. */
  /* Keyed by WHICH FORT as well as which flight (0365/0371). It used to be keyed by name
   * alone, so fort A's records and fort B's were merged into ONE box spanning both halves
   * of the map -- and a box that spans the map matches every corner in it, which is why
   * the rule accepted the vault flight's 288-unit climb on red and could not be made to
   * on blue. `len` is on the group because the mirrored footprint is computed from it. */
  const groups = new Map();
  for (const f of G.flights || []) {
    const key = `${f.name.split(' ')[0]}:${f.mirrored ? 'B' : 'A'}`;
    const g = groups.get(key) || { x0: Infinity, y0: Infinity, x1: -Infinity,
                                   y1: -Infinity, z0: Infinity, z1: -Infinity,
                                   name: key.split(':')[0], team: key.split(':')[1],
                                   mirrored: !!f.mirrored, len: G.len };
    g.x0 = Math.min(g.x0, f.box[0]); g.y0 = Math.min(g.y0, f.box[1]);
    g.x1 = Math.max(g.x1, f.box[2]); g.y1 = Math.max(g.y1, f.box[3]);
    g.z0 = Math.min(g.z0, f.box[4]); g.z1 = Math.max(g.z1, f.box[5]);
    groups.set(key, g);
  }
  const flightSteps = [...groups.values()];
  /* A corner is "in" a flight if either end is inside its footprint. The footprint may be
   * the record AS REPORTED or its MIRROR (0365/0371): GEO_PY exports every flight box
   * unmirrored and with a `mirrored` flag, so a blue leg's corners -- which are mirrored,
   * because they have to be -- never matched the box they belong to. That is why the rule
   * called the vault flight's own 288-unit climb "a drop the route was supposed to avoid"
   * on blue and accepted it on red: the same corner pair, two different answers. */
  const inFlight = (a, b, f, mirror) => {
    const L = mirror ? f.len : 0;
    const inOne = p => {
      const x = mirror ? L - p[0] : p[0];
      return x >= f.x0 - 64 && x <= f.x1 + 64 &&
             p[1] >= f.y0 - 64 && p[1] <= f.y1 + 64;
    };
    return inOne(a) || inOne(b);
  };

  for (const [team, set] of Object.entries(routes)) {
    for (const [name, wps] of Object.entries(set)) {
      let worst = 0, where = '', why = '';
      for (let i = 1; i < wps.length; i++) {
        const a = wps[i - 1], b = wps[i];
        const d = Math.abs(b[2] - a[2]);
        if (d <= worst) continue;
        // A step is fine if it is a step, or if it spans a flight.
        const f = flightSteps.find(f => (inFlight(a, b, f) || inFlight(a, b, f, true)) &&
                                      Math.abs(f.z1 - f.z0) >= d - 8);
        if (d <= 18 || f) continue;
        worst = d; where = `${a} -> ${b}`;
        why = (d > 40 ? 'a drop' : 'a step');
      }
      const aFall = name === 'dropped';
      check(aFall || worst === 0 || worst <= 18,
            `leg ${name} (fort ${team}) steps no more than 18 at a time, or spans a `
            + `flight, or is the leg that is meant to include a fall`,
            `a ${worst}-unit ${why} at ${where}; 18 is what a player walks up, so ` +
            `this route asks for ${why} it was supposed to avoid`);
    }
  }
}

/* --leg NAME and --team red|blue (0345). One process per leg, run in parallel by
 * tests/walk_all.sh: a leg that hangs then costs 120 seconds of wall clock instead of
 * the whole run, and a cut-off leg has a NAME and says TIMEOUT rather than going
 * missing from the table -- which is how "the run timed out" read as "that leg passed"
 * every time the suite ran long.
 *
 * The names are the routes' own, and `all` is the default so running this file on its
 * own still does what it always did.
 */
function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main() {
  console.log(`leg ${LEG}, team ${TEAM}`);
  // The run dir is printed HERE, at startup, not only in the end-of-run trace
  // (0466): walk_all.sh reaps each repeat's leftovers by this path, and a
  // SIGKILLed repeat never reaches its trace -- exactly the case the reap
  // exists for. The first line is the one line a killed leg always leaves.
  console.log(`run dir: ${path.relative(ROOT, RUN)}  (server.log)`);
  // --static runs the checks that need NO engine: the geometry, the half-map assertion
  // and the SEGMENT SWEEP. It exists so tests/check_all.sh can have the sweep in its
  // table without starting a server and a browser (0400), and so the sweep is run on
  // every commit that touches the map rather than only when someone walks a leg.
  const STATIC = process.argv.includes('--static');
  stage();
  const G = geo();
  if (!G) { bad('gen_map answered with the map geometry'); return; }
  const ROUTES = stairRoutes(G);
  console.log(`forts at scale ${G.scale}: spawn A ${G.spawn}, key A ${G.key_a}, ` +
              `bridge y ${G.bridge_y}`);

  if (STATIC) {
    // The half-map assertion needs no engine either, and it is the check that has found
    // the most real bugs, so --static runs it too (0400).
    const CROSSES_S = ['across', 'swimOut', 'stepsDown', 'stepsUp', 'doorToKey'];
    checkLegHalf(ROUTES.A, G, 'red', CROSSES_S, ['doorToKey']);
    checkLegHalf(ROUTES.B, G, 'blue', CROSSES_S, ['doorToKey']);
    checkSweptHulls(ROUTES.A, G, 'red');
    checkSweptHulls(ROUTES.B, G, 'blue');
    checkStairRule(ROUTES, G);
    printTrace();
    console.log('');
    console.log(failed ? `FAIL: ${failed} of ${passed + failed} static checks`
                        : `PASS: ${passed} static checks`);
    process.exit(failed ? 1 : 0);
  }

  // Every port CLAIMED, not merely probed (0466): the claim file closes the
  // probe's TOCTOU window, so a leg's neighbour can never take a port this leg
  // is about to bind. The range stays BELOW net.ipv4.ip_local_port_range
  // (32768..60999 here): an outbound connection from any process can
  // transiently hold an ephemeral port and beat a bind that a probe could
  // never see coming. Chained, so the three are distinct.
  const PORT = await takePort(20000 + (process.pid % 12000));
  const HTTP = await takePort(PORT + 1);
  const CDP = await takePort(HTTP + 1);
  const server = new Server(PORT);
  if (!await server.start()) {
    bad('the server started', (server.stderr || '').slice(-400));
    return;
  }
  // serve.js used to be spawned `stdio: 'ignore'`, so when it died with
  // EADDRINUSE nobody could ever say why (0466). Its output goes to a file in
  // the run dir now, and the harness WAITS for the port to answer instead of
  // sleeping 1.5s and hoping.
  const SERVE_LOG = path.join(RUN, 'serve.log');
  const page = track(spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
    '--root', STAGE], { cwd: ROOT, stdio: ['ignore', fs.openSync(SERVE_LOG, 'w'),
                                           fs.openSync(SERVE_LOG, 'a')], detached: true }));
  const client = new Client(CDP);
  try {
    const up = await waitListening(HTTP, 30000);
    if (!up || page.exitCode !== null) {
      // WHO owns the port now? (0466) ss names any holder by pid; the two
      // curls answer "does ANY stack answer on it" (127.0.0.1 and ::1 -- if
      // only ::1 answers, the listener is IPv6-only and the probe was IPv4).
      const who = sh('ss', ['-ltnp', 'sport', '=', ':' + HTTP]);
      const v4 = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
                             '--max-time', '3', `http://127.0.0.1:${HTTP}/`]);
      const v6 = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
                             '--max-time', '3', `http://[::1]:${HTTP}/`]);
      bad('the static server started on its port',
        `port ${HTTP} after 30s ` +
        (page.exitCode !== null ? `(serve.js exited ${page.exitCode}) ` :
         page.signalCode ? `(serve.js was KILLED by ${page.signalCode} -- ` +
           `something signalled it; the walk_all reap used to be unscoped and ` +
           `killed the neighbouring leg's serve.js (0466)) ` :
         '(still running) ') +
        `-- holders: ${who.stdout.trim() || 'NONE'}; ` +
        `curl 127.0.0.1: HTTP ${v4.stdout.trim() || 'no answer'} (rc ${v4.status}); ` +
        `curl [::1]: HTTP ${v6.stdout.trim() || 'no answer'} (rc ${v6.status}); ` +
        `serve.log tail: ${fs.readFileSync(SERVE_LOG, 'utf8').slice(-300)}`);
      return;
    }
    await client.start('http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=walker&autojoin=1');
    let joined = false;
    for (let i = 0; i < 240 && !joined; i++) {
      await sleep(500);
      joined = /walker joined/.test(fs.readFileSync(LOG, 'utf8'));
    }
    check(joined, 'the walking player joined the server',
      `no "walker joined" in ${LOG} after 120s -- nothing below was tested. ` +
      `The client's own evidence (0384): console ` +
      `(${client.console.length} lines): ${client.console.slice(-10).join(' | ') || '(nothing)'}. ` +
      `network (${client.net.length} entries): ${client.net.slice(-10).join(' | ') || '(nothing)'}`);
    if (!joined) return;

    /* THE LOBBY (2026-10-09): a join is held until both picks are made, and a
     * waiter is a noclip observer with no body -- every leg below walks a
     * real hull through real geometry. Both picks go out through the page's
     * own overlay entry point; `auto` counts as the team pick. */
    await client.eval('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await client.eval('window.QWTF_MENU.do("cls_soldier")');
    let body = false;
    for (let i = 0; i < 60 && !body; i++) {
      await sleep(500);
      try { body = /QWTF_EVENT class_stats walker class=soldier/.test(fs.readFileSync(LOG, 'utf8')); } catch (e) {}
    }
    check(body, 'the lobby spawn landed for the walker (class_stats walker class=soldier)',
      `no class_stats walker/soldier within 30 s of the picks in ${LOG} -- ` +
      'every leg below would be steering an invisible noclip waiter');

    /* W is pressed per leg, inside leg(), after the player is at the start -- see
     * the note there. Holding it from here made the player walk off on his own. */
    const ROUTES = stairRoutes(G);
    // `across` is exempt for the same reason as `outOfWater` and for the same reason it
    // exists: it crosses to the other fort. Its mid-channel corner is [2432, 704, 24],
    // which is exactly mid-x, and the assertion caught it -- correctly, as a corner on
    // the far side, because it had not been told that leg is supposed to cross.
    const CROSSES = ['across', 'swimOut', 'stepsDown', 'stepsUp', 'doorToKey'];
    checkLegHalf(ROUTES.A, G, 'red', CROSSES, ['doorToKey']);
    if (TEAM !== 'red') checkLegHalf(ROUTES.B, G, 'blue', CROSSES, ['doorToKey']);
    checkSweptHulls(ROUTES.A, G, 'red');
    if (TEAM !== 'red') checkSweptHulls(ROUTES.B, G, 'blue');
    checkStairRule(ROUTES, G);
    console.log(`   the vault's dog-leg: foot ` +
                `${JSON.stringify(ROUTES.A.toVault[3])} head ` +
                `${JSON.stringify(ROUTES.A.outOfVault[3])}`);
    check(STAIR_GAPS.head <= 0,
          "the dog-leg's top tread REACHES the fort floor " +
          `(gap ${STAIR_GAPS.head.toFixed(0)})`,
          `the top tread's west edge is x=${STAIR_GAPS.treadEdge.toFixed(0)} and ` +
          `the hole in the floor starts at x=${STAIR_GAPS.floorEdge.toFixed(0)}, so ` +
          `there are ${STAIR_GAPS.head.toFixed(0)} of nothing at floor level between ` +
          `them. A hull is ${2 * 16} wide, so that is a fall and not a step: a player ` +
          `at the top of the stair stands at floor HEIGHT over the hole and drops ` +
          `the moment they step off it. This is the reviewer's case (ii) -- the ` +
          `flight is a stair, and its top lands in the shaft.`);
    check(G.spawn[0] < G.len / 2 && G.key_a[0] < G.len / 2,
          "fort A's spawn and key are both on its own half of the map",
          `spawn ${G.spawn}, key ${G.key_a}, mid-x ${G.len / 2}`);

    console.log('a. red: spawn -> the vault and back, out the door, across, and blue');
    await legWaypoints(client, server, ROUTES.A.toVault,
                       'red spawn -> the vault, down the dog-leg',
                       { reach: 96, routeName: 'toVault' });
    await legWaypoints(client, server, ROUTES.A.outOfVault,
                       'the vault -> back up the dog-leg -> the fort floor',
                       { reach: 96, climb: (G.ground - G.vault) * 0.8,
                         routeName: 'outOfVault' });
    await legWaypoints(client, server, ROUTES.A.across,
                       'the fort floor -> out the bridge door -> across the deck',
                       { reach: 128, timeoutMs: 300000, routeName: 'across' });
    await legWaypoints(client, server, ROUTES.A.upBattlement,
                       'the fort floor -> up the parapet flight -> the battlement',
                       { reach: 96, climb: G.roof - G.ground, routeName: 'upBattlement' });
    await legWaypoints(client, server, ROUTES.A.downBattlement,
                       'and back down it', { reach: 96, routeName: 'downBattlement' });

    /* The routes the owner would walk, and what they say about the map.
     *
     * THE VAULT HAS NO STAIR DESCENT. Hand-authoring leg (a) the reviewer's way is
     * what proved it: from the fort floor to the corridor is a 288-unit drop in
     * every direction available, because the dog-leg climbs FROM the corridor TO
     * the floor and nothing comes down. So the vault can be entered from the water
     * or by falling 352 down the shaft, and "spawn -> the vault by stairs" cannot
     * be walked at all -- which is the owner's "the basement is not something that
     * can be escaped from" and, read the other way round, "is not something that
     * can be entered either". That is a map bug, and it is the next thing to build:
     * a flight from the fort floor down into the corridor.
     *
     * The legs that DO have a legal shape are run below, so the harness is here when
     * the descent exists. */
    console.log('b. dropped off the battlement, and out on foot');
    // The drop is a BLOCK, not a legWaypoints call, so --leg has to gate it here too --
    // otherwise every leg's run carried the drop's failure and the table was one line
    // wide for every row (0345).
    if (walkWanted('dropped')) {
    /* drop-out, RETIRED AND REWRITTEN (0388), AND THEN REWRITTEN AGAIN (reviewer
     * 0527 item 3). The old leg was 0246(b), "drop into the vault from the highest
     * drop point", and since 0270 that map does not exist: the shaft is filled and the
     * stairwell is railed. The leg was testing a hole that was closed two days of
     * work ago, and its failure -- "the player did not fall" -- was the map being
     * right.
     *
     * What replaced it was: **you cannot fall off the battlements or off the
     * bridge.** The merlons (0324) and the bridge's railings were the reason.
     *
     * That is now TWO claims and not one, and only because the bridge rail is
     * 24 world above the deck instead of 96 (gen_map.FORTS_BRIDGE_RAIL). A rail at
     * 96 is taller than a Quake jump clears, so the bridge's edge was a wall and
     * "cannot walk off" was true for the wrong reason; the owner asked for the
     * opposite, "a player can jump into the water", and that is what the leg now
     * asserts for the bridge. The merlons are untouched at 32 above the roof, so
     * "cannot walk off" is still the right claim for the battlement.
     *
     * So each site below carries its own claim and its own way of walking it, and
     * the difference is the leg's whole point: a check that said "cannot get off"
     * everywhere would still have passed on a rail at 96, which is the map this
     * just stopped being. `traps` (on foot) covers the falls that remain. */
    console.log('b. the battlement edges hold; the bridge rail lets you into the water');
    // `mx` and `parapet` live inside stairRoutes()'s per-fort loop; this block is
    // outside it. It runs on FORT A's half (red), so mirroring is the identity and the
    // parapet's own record gives the edges.
    // 'parapet ramp' is what the map calls it now that all three flights are ramps
    // (0395), and the four sites up in stairRoutes() all take the regex. THIS one was
    // still `f.name === 'parapet'`, so after the rename it found nothing and the whole
    // drop leg reported:
    //
    //     FAIL the map reports a parapet flight   (no "parapet" record to walk off)
    //     FAIL the walking run completed          (0 waypoints sent)
    //
    // on both teams, three times each, and it was reported as a drop failure. It is a
    // string comparison left behind by the ramp work, not a map problem. Same regex as
    // everywhere else, so the next rename is one edit rather than a hunt.
    const paraA = (G.flights.find(f => /^parapet( stair| ramp)?$/.test(f.name)
                                   && !f.mirrored) || {}).box;
    const roofZ = G.roof, groundZ = G.ground;   // also inside the loop
    if (!paraA) {
      bad('the map reports a parapet flight', 'no "parapet" record to walk off');
    }
    /* THE BATTLEMENT SITES ARE MERLONS, READ OFF THE MAP (G.merlons).
     *
     * This is the second false pass this block had, and the walk found both of them.
     * The first was the site x: half a parapet is a gap, so `paraA[0] + 32` lands on a
     * merlon only by luck. The second was worse and is why this loop holds W now:
     *
     *   **THE OLD VERSION NEVER HELD W.** It teleported the player to the edge and set
     *   a waypoint, and the server aimed them at the drop -- but nobody held the
     *   forward key, and the waypoint hook sets the HEADING and the JUMP, not +forward
     *   (probe.qc: qwtf_face/qwtf_wx/qwtf_wjump are angles and buttons; leg() holds W
     *   from the client side, which is why every other leg moves at all). So the player
     *   stood still at all four sites and "the player cannot walk off it" passed four
     *   times on a statue. Measured on the run that found it: the trace ended with
     *   4 waypoints sent, 0 arrivals, and the last twenty positions all identical.
     *
     * So the merlon sites are the map's own, and W is held for the whole of each site.
     */
    const merl = (G.merlons || { north: [], south: [] });
    /* STAND ON THE SURFACE, NOT IN IT. A player's origin is 24 above their feet
     * (defs.qc HULL_MIN_Z = -24), so the z handed to a teleport has to be the
     * floor plus 24. These sites were handing over the bare floor height -- G.roof is
     * the roof's TOP and G.ground is the deck's top -- which puts the player's feet 24
     * inside the solid they are standing on: the engine pushes them out along the
     * shortest axis and the +forward they are holding fights the push, so they go
     * nowhere. Measured on the run that found it: the bridge sites reported the player
     * at (2432, 752, 0) on all twenty samples, i.e. exactly where the teleport put
     * them, with W held. Every other leg's corners add the 24 (see `vault + 24`), so
     * this was the odd one out rather than a new discovery about standing heights. */
    const stand = (floor) => floor + 24;
    const northMerlon = (merl.north || [])[Math.floor((merl.north || []).length / 2)];
    const southMerlon = (merl.south || [])[Math.floor((merl.south || []).length / 2)];
    if (!northMerlon || !southMerlon) {
      bad('the map reports merlons on the battlement',
          `north ${(merl.north || []).length}, south ${(merl.south || []).length} ` +
          'merlon boxes found on the map; without one there is nothing to walk at');
    }
    /* jump: the site is walked with the jump button held. It is what a player does
     * at a rail, and the waypoint hook turns it into self.button2 for as long as
     * the waypoint is live (probe.qc, qwtf_wjump) -- the server owns the heading
     * and the jump alike, so this is still the ordinary movement path. */
    const sites = [];
    if (northMerlon) sites.push(['the battlement, north merlon',
                                 [northMerlon.x, northMerlon.y, stand(roofZ)], false,
                                 'held']);
    if (southMerlon) sites.push(['the battlement, south merlon',
                                 [southMerlon.x, southMerlon.y, stand(roofZ)], false,
                                 'held']);
    sites.push(['the bridge, north rail',
                [G.len / 2, (G.bridge_y[0] + G.bridge_y[1]) / 2 - 48, stand(groundZ)],
                true, 'jumpable']);
    sites.push(['the bridge, south rail',
                [G.len / 2, (G.bridge_y[0] + G.bridge_y[1]) / 2 + 48, stand(groundZ)],
                true, 'jumpable']);
    for (const [what, edge, jump, claim] of sites) {
      server.goto(edge[0], edge[1], edge[2]);
      await sleep(1500);
      /* W IS HELD for the walk, and released after it. Without it the player is a
       * statue and every "cannot walk off" here is a false pass (see above).
       *
       * AND SPACE, FOR THE SAME REASON: the waypoint's own jump (qwtf_wjump) sets
       * button2 from PlayerPreThink, which FTE runs BEFORE the frame's usercmd
       * buttons are applied -- so the engine's own buttons overwrite it. Measured:
       * with qwtf_wjump on and the player pressed against the rail, z read exactly
       * 24 (their standing height) on all twenty samples for ten seconds: no hop at
       * all. So the jump comes from the CLIENT, as the ordinary +jump key a player
       * holds, and the waypoint only aims.
       *
       * Bunny-hopping is deliberate, not sloppy: holding +jump re-jumps on every
       * landing, so a player running at a rail crosses it in flight rather than
       * jumping into it from a standstill. Jumped from a standstill there is no
       * horizontal speed left -- the wall took it -- and 0.2 s of air time is 6
       * units, which is not the rail's 32 of thickness. */
      await client.hold('w', 'KeyW', 87);
      if (jump) await client.hold(' ', 'Space', 32);
      server.waypoint(edge[0], edge[1] + (what.indexOf('north') >= 0 ? -160 : 160),
                      jump, edge[2]);
      /* POLL for the outcome rather than reading once: getting into the channel
       * takes a jump and a fall, and the last sample at 10 s can be a player still
       * on the rail. `held` sites pass on the LAST sample (they never move), and a
       * `jumpable` site is passed on the FIRST sample that is in the water, because
       * the water is where they are going to be and a later sample cannot unring
       * it -- the channel's own trap leg (c) is what proves the water is a way
       * out. */
      let p = null, got = false;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        p = server.last();
        if (!p) continue;
        /* The water's SURFACE is 48 below the deck (the channel's water brush runs
         * z -288..-48 in world units), so a player floating in it is ~48 down. The
         * z test is "below the deck", not a number of its own: the claim is that
         * they are IN the water, and waterlevel is the number that says so. */
        if (claim === 'jumpable' && p.water > 0 && p.z < groundZ - 8) { got = true; break; }
      }
      server.waypointOff();
      if (jump) await client.release(' ', 'Space', 32);
      await client.release('w', 'KeyW', 87);
      const at = `ended at (${p ? p.x.toFixed(0) : '?'}, ${p ? p.y.toFixed(0) : '?'}, ` +
                 `${p ? p.z.toFixed(0) : '?'}, water ${p ? p.water : '?'})`;
      if (claim === 'jumpable') {
        /* Into the WATER, and not merely lower: the deck is at 0 and the channel's
         * surface is below it, so "below the deck" alone would also be true of a
         * player who fell through the deck into the fort's own basement, which is
         * the trap this leg exists to notice. waterlevel is the server's own number
         * (probe.qc prints it) and only a player IN the water has it above 0 --
         * a func_water would not do it, see probe.qc's note on CONTENTS_WATER. */
        check(got,
              `${what}: a player can jump it and land in the channel (the rail is 24 ` +
              `world, a jump clears 45)`,
              `${at}; the fort floor is ${groundZ} and the deck is the bridge's own ` +
              `level, so this site is expecting waterlevel > 0 below it`);
      } else {
        check(p && p.z > groundZ - 64,
              `${what}: the player cannot walk off it`,
              `${at}; the fort floor is ${groundZ} and anything below it is a fall ` +
              `off the edge -- which is what the merlons are for (0324)`);
      }
    }
    if (false) {
      const from = ROUTES.A.upBattlement[3];
      server.goto(from[0], from[1], from[2]);
      await sleep(2500);
      const landed = server.last();
      check(landed && landed.z < G.ground,
            'the player fell off the battlement and landed below the fort floor',
            `ended at z=${landed ? landed.z.toFixed(0) : '?'}, the fort floor is ` +
            `${G.ground.toFixed(0)}`);
      if (landed) {
        /* From wherever they landed, out on foot. The waypoint is the LANDING, per
         * 0257: a leg that is allowed to fall still has to know where the fall put
         * them, and must not then aim at the edge they left. */
        await legWaypoints(client, server,
                           [[landed.x, landed.y, landed.z]].concat(ROUTES.A.dropped.slice(1)),
                           'from wherever they landed -> up and out to the fort floor',
                           { reach: 128, timeoutMs: 300000, routeName: 'dropped' });
      }
    }   // if (false) -- the old 0246(b) drop into the vault, retired in 0388
    }

    // --leg gates this block by hand: it teleports and reads the landing, so it is not a
    // legWaypoints call and the label gate cannot see it (0355).
    if (waterBlockWanted('c1') || waterBlockWanted('c')) {
    /* c1: the OUTCOME, not a route. Into the middle of the channel, face the nearest
     * steps, and pass when the player is out -- waterlevel 0, z >= 0, health > 0. Where
     * they came out is PRINTED, not asserted (0384): it is the datum, and the old leg
     * turned it into a TIMEOUT that said nothing. */
    console.log('c1. into the channel, and out onto the bank');
    {
      // `mid` and `py` live inside stairRoutes()'s per-fort loop and c1 runs outside
      // it, so it takes them from G: mid-x is the map's own middle, and py is the
      // corridor's centre, which is a place the player can be put in open water.
      // G.bed + 24, not G.bed (0466): the probe's teleport sets the ORIGIN, and the
      // hull's feet are 24 BELOW it, so a goto at bed height embeds the player 24
      // INTO the bed solid -- measured in-engine: origin pinned at -288, waterlevel
      // 0, yaw steering toward the steps (90 -> 148) while the position never moves
      // for the whole poll. This is also 0384's open note -- "same coordinates, two
      // answers" -- resolved: the coordinates were NOT identical; the water check
      // that worked teleports at bed+24 and this one at bed, 24 apart, hull-deep.
      // The WATER legs are the own team's ramp (2026-10-09): red swims to red's,
      // blue to blue's -- a blue swimmer aimed at red's ramp would cross the whole
      // channel to get out of it.
      const TW = TEAM === 'blue' ? ROUTES.B : ROUTES.A;
      server.goto(G.len / 2, (G.passage_y[0] + G.passage_y[1]) / 2 - 256, G.bed + 24);
      /* POLL for being in the water, not sleep and hope. A fixed 2.5s read waterlevel 0
       * at exactly the point the old c leg reads water -- the teleport had not settled.
       * The check is "is the player in the channel", so it should wait for that. */
      let inWater = null;
      for (let i = 0; i < 40 && !(inWater && inWater.water > 0); i++) {
        await sleep(500);
        const p = server.last();
        if (p && p.water > 0) inWater = p;
      }
      inWater = inWater || server.last();
      check(inWater && inWater.water > 0,
            'the player is in the channel',
            `waterlevel ${inWater ? inWater.water : '?'} at ` +
            `${inWater ? `(${inWater.x.toFixed(0)}, ${inWater.y.toFixed(0)})` : '?'}`);
      // The swim itself is the corner list (surface over the slot's mouth, the
      // landing, the bank top), walked with the steering that already works and
      // jump held -- the waypoint hook's own jump is what got the old swimmer up
      // to its surface corner, and W is the thrust (0466). The OUTCOME is what
      // c1 has always passed on: out of the water, above the surface, alive.
      const r = await legWaypoints(client, server, TW.swimOut,
                       'a swimmer in the water: up the ramp, out onto the bank top',
                       { reach: 96, jump: true, routeName: 'swimOut',
                         timeoutMs: 300000 });
      const out = server.last();
      check(!!(r && r.arrived) && !!out && out.water === 0 && out.z >= 0
              && out.health > 0,
            'a swimmer gets OUT of the channel: out of the water, on the bank top, ' +
            'alive',
            `the walk ended at ` +
            `${out ? `(${out.x.toFixed(0)}, ${out.y.toFixed(0)}, ` +
              `${out.z.toFixed(0)}), water ${out.water}, health ${out.health}` : '?'}`);
      if (out) {
        console.log(`   the swimmer came out at ${out.x.toFixed(0)}, ` +
                    `${out.y.toFixed(0)}, ${out.z.toFixed(0)} (mid-x ` +
                    `${(G.len / 2).toFixed(0)})`);
      }
      // NO server.stop() here (0466). Leg c continues below it -- the final block
      // teleports again and walks out of the water -- and after a stop every
      // serverinfo command went into a dead stdin: command() drops it silently, the
      // teleport never took, the "in the water" check read the SWIMMER's last
      // position (z=24, dry) and the walk "stalled 203 short of a goal the player
      // was already standing on". For --leg swim this block is the whole leg and
      // main's finally reaps the server anyway.
    }
    /* c2: the steps, on foot, both ways. This proves the steps are an exit using the
     * steering that already works, so it does not depend on swimming at all. The bank
     * corner at the top and the flight's foot at the bottom, on this leg's own team's
     * ramp (2026-10-09).
     *
     * THE OLD THIRD WATER LEG IS GONE, on purpose: "fallen into the water, and back
     * up to a fort floor" walked the bed, THROUGH the underwater passage, to the key
     * and out -- the exact shortcut the owner has now closed ("one just has to get in
     * the water and swim back and forth ... to save time"). What a swimmer who falls
     * in mid-channel gets now is the ramp, the landing and the bank top, and that is
     * what c1 and c2 assert. The route back into a fort is the bridge door, walked
     * by legs a and across. */
    console.log('c2. down the water steps on foot, and back up');
    {
      const TW = TEAM === 'blue' ? ROUTES.B : ROUTES.A;
      await legWaypoints(client, server, TW.stepsDown,
                       'the water steps: down the treads into the water',
                       { reach: 96, routeName: 'stepsDown' });
      await legWaypoints(client, server, TW.stepsUp,
                       'the water steps: back up the treads to the bank',
                       { reach: 96, routeName: 'stepsUp' });
    }

    }
    if (TEAM === 'both') {
    console.log('d. the same four legs for blue');
    await legWaypoints(client, server, ROUTES.B.toVault,
                       'blue spawn -> the vault, down its dog-leg', { reach: 96 });
    await legWaypoints(client, server, ROUTES.B.outOfVault,
                       'and back out of it, up the dog-leg',
                       { reach: 96, climb: (G.ground - G.vault) * 0.8 });
    await legWaypoints(client, server, ROUTES.B.across,
                       'blue fort -> out the door and across the deck',
                       { reach: 128, timeoutMs: 300000 });
    await legWaypoints(client, server, ROUTES.B.upBattlement,
                       'blue fort -> up its parapet flight',
                       { reach: 96, climb: G.roof - G.ground });
    await legWaypoints(client, server, ROUTES.B.downBattlement,
                       'and back down it', { reach: 96, routeName: 'downBattlement' });
    }   // TEAM === 'both'
  } catch (e) {
    bad('the walking run completed', (e && e.message) +
        (process.env.QWTF_DEBUG && e && e.stack ? '\n' + e.stack : ''));
  } finally {
    await client.release('w', 'KeyW', 87).catch(() => {});
    await client.stop();
    try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {
      try { page.kill('SIGKILL'); } catch (e2) {}
    }
    await sleep(300);
    await server.stop();
    reapAsync();
    try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) {}
  }
}

/* THE TRACE, PRINTED BY THE HARNESS, ON ANY NON-PASS (0365). No asking, no re-running:
 * the waypoints sent, the arrivals the server reported, and the last positions. A
 * TIMEOUT kills the process, so this is printed from the exit path and flushed
 * synchronously -- process.exit() does not drain an async write. */
function printTrace(cutOff) {
  if ((!failed && !cutOff) || typeof LOG === 'undefined') return;
  if (cutOff) {
    console.log('');
    console.log(`  TRACE: this run was CUT OFF (${failed} failed, ` +
                `${passed} passed so far) -- printed anyway, because that is the ` +
                'run you most want it for.');
  }
  let log = '';
  try { log = fs.readFileSync(LOG, 'utf8'); } catch (e) {}
  const pos = (log.match(/^QWTFPOS .*$/gm) || []).slice(-12);
  console.log('');
  console.log(`  TRACE: ${SENT.length} waypoint(s) sent, ` +
              `${ARRIVED.length} arrival(s) reported`);
  for (const w of SENT) {
    const hit = ARRIVED.find(a => a.seq === w.seq);
    console.log(`    seq ${String(w.seq).padStart(3)}  sent ` +
                `(${w.x}, ${w.y}, ${w.z === null ? '-' : w.z}) jump=${w.jump}` +
                (hit ? `   ARRIVED at (${hit.x.toFixed(0)}, ${hit.y.toFixed(0)}, ` +
                       `${hit.z.toFixed(0)})`
                     : '   ** never arrived **'));
  }
  if (!SENT.length) console.log('    (no waypoint was ever sent)');
  console.log('  last positions  (x y z yaw HEALTH WATER TEAM):');
  for (const p of pos) {
    console.log(`    ${p.replace(/^QWTFPOS \[walker\] /, '')}`);
  }
}

main().then(() => {
  printTrace();
  console.log('');
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log)`);
  console.log(failed ? `FAIL: ${failed} of ${passed + failed} checks`
                      : `PASS: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}).catch(e => { console.error('Error:', e && e.message); process.exit(1); });