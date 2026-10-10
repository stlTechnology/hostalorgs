#!/usr/bin/env node
/*
 * tests/drown.js -- the drowning rule: the design's 15 s under water, then damage
 * and a sound on every tick.
 *
 *   node tests/drown.js                  # the rule as shipped
 *   node tests/drown.js --progs DIR      # the same run against other progs (below)
 *   node tests/drown.js --static-only    # the static half alone, no server, no browser
 *
 * GAME-DESIGN.md, owner playtest 2026-10-08 item 3: "Drowning: after about 15 s
 * fully underwater, the player takes damage at intervals, with a
 * gasping/drowning sound each time." The rule is qwtf/drown.qc; the sounds are
 * player/drown1.wav and player/drown2.wav, which LibreQuake's world.qc:215-216
 * already precaches and never plays.
 *
 * WHY THIS FILE IS ITS OWN AND NOT A PHASE OF tests/ctf_rules.js: ctf_rules.js
 * states as a rule of itself that no check in it asserts on a QWTFPOS field,
 * because its whole point is that the key rules are observed through QWTF_EVENT
 * with the trace off. Drowning cannot be asserted that way -- armour spends
 * itself before health moves (see the health/armour arithmetic below), so the
 * rule's effect is only visible in the sample trail. Keeping it here leaves that
 * invariant intact instead of quietly weakening it.
 *
 * WHAT IS THE EVIDENCE, and what is only context:
 *
 *   the rule       QWTF_EVENT dive/drown/surface and their _at lines, which
 *                  qwtf/drown.qc prints UNCONDITIONALLY. qwtf_trace gates the
 *                  probe, never the rules (the REJECT 0172 lesson), and the
 *                  static checks below enforce that on this file too.
 *   the context    QWTFPOS: waterlevel (was the head actually under?), health
 *                  and armour (was anything actually lost?), and the server's
 *                  own clock per sample.
 *
 * THE TIMING IS THE SERVER'S, not this process's. The log is flushed
 * asynchronously, so a Date.now() next to a log line measures when the line came
 * out of a pipe, not when the rule ran. Every interval here is a difference of
 * two numbers the rule printed with `time`.
 *
 * THE NEGATIVE RUN. `--progs DIR` puts DIR's progs.dat/qwprogs.dat in the staged
 * gamedir instead of web/id1's. The point of it is that a check which passes
 * against a progs with NO drowning rule in it is reading nothing, so:
 *
 *   QWTF_QC_SKIP=drown.qc QWTF_PROGS_OUT=/tmp/nodrown bash scripts/build_progs.sh
 *   node tests/drown.js --progs /tmp/nodrown      # must FAIL
 *
 * QWTF_C_SKIP is build_progs.sh's own hook for exactly this, in the same
 * standing as QWTF_NO_EGGS.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'tests/artifacts');
const WEB = path.join(ROOT, 'web');

/* Per run, every path: two concurrent runs (mine and the reviewer's) sharing a
 * staging directory or a log file is how one run ends up asserting on the
 * other's numbers (0239). The run directory is KEPT -- server.log is the evidence
 * behind every number printed here. */
const RUN = path.join(ART, 'run-drown-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const LOG = path.join(RUN, 'server.log');

let failed = 0, passed = 0;
function ok(what) { console.log(`  ok   ${what}`); passed++; }
function bad(what, detail) {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
}
const check = (c, what, detail) => (c ? ok(what) : bad(what, detail));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Strip // comments before a static check: the QuakeC files explain at length
 * WHY they must not depend on qwtf_trace, and that explanation must not make the
 * check fail. What is forbidden is the cvar in CODE. */
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

/* ------------------------------------------------------------- static checks */

function drownConstants() {
  /* The rule's own numbers, read out of the file rather than restated here: a
   * test that hardcodes 15 beside a rule that says 15 passes when the rule is
   * changed and the test is not, which is the failure this whole repo keeps
   * running into (a check reading its own model instead of the map). */
  const src = fs.readFileSync(path.join(ROOT, 'qwtf/drown.qc'), 'utf8');
  const out = {};
  const re = /^float (QWTF_DROWN_[A-Z_]+) = ([0-9.]+);/gm;
  let m;
  while ((m = re.exec(src)) !== null) out[m[1]] = parseFloat(m[2]);
  return out;
}

function pakSounds() {
  /* Quake's pak: "PACK", the directory offset, then the directory's length. The
   * first pass at this read the COUNT from offset 0, which is the four bytes of
   * "PACK" -- 1262657360 boxes -- and hung. The count is dirlen/64. */
  const p = path.join(WEB, 'id1', 'sounds.pak');
  const d = fs.readFileSync(p);
  const off = d.readInt32LE(4), dlen = d.readInt32LE(8);
  const n = Math.floor(dlen / 64);
  const out = new Set();
  for (let i = 0; i < n; i++) {
    const e = d.subarray(off + i * 64, off + i * 64 + 56);
    out.add(e.toString('latin1').replace(/\0.*$/, ''));
  }
  return out;
}

function staticChecks() {
  console.log('');
  console.log('the rule is a rule, not a test hook, and it is on the right clock');
  const q = code('qwtf/drown.qc');

  check(!/infokey\s*\(\s*world\s*,\s*"qwtf_trace"/.test(q) && !/QWTF_TRACE_NEXT/.test(q),
        'no rule in qwtf/drown.qc reads the trace cvar');
  check(/wrap void\(\) WaterMove/.test(q),
        'the rule is on WaterMove, the function vanilla drowns in');
  check(!/wrap void\(\) PlayerPostThink/.test(q),
        'the drowning is not on the probe\'s 4 Hz tick');
  check(/prior\(\);/.test(q),
        'the wrap still calls prior() -- water friction and lava are in there too');

  const design = fs.readFileSync(path.join(ROOT, 'GAME-DESIGN.md'), 'utf8');
  check(/after about \*\*15 s\*\* fully underwater, the player takes damage at intervals/.test(design),
        'the design still asks for 15 s and damage at intervals');

  const c = drownConstants();
  check(c.QWTF_DROWN_TIME === 15,
        'the rule breathes for 15 s (qwtf/drown.qc: ' + c.QWTF_DROWN_TIME + ')',
        'GAME-DESIGN.md says 15');
  check(c.QWTF_DROWN_TICK === 1,
        'and the damage is every 1 s (qwtf/drown.qc: ' + c.QWTF_DROWN_TICK + ')');

  check(/qwtf\/drown\.qc/.test(fs.readFileSync(path.join(ROOT, 'scripts/build_progs.sh'), 'utf8')),
        'the build compiles qwtf/drown.qc into the progs');
  check(/qwtf_isbot/.test(q),
        'bot clients are exempt, or a bot would drown mid-passage again');

  const pak = pakSounds();
  const need = ['sound/player/drown1.wav', 'sound/player/drown2.wav', 'sound/player/gasp2.wav'];
  const missing = need.filter(s => !pak.has(s));
  check(missing.length === 0,
        'both drowning samples and the gasp are in sounds.pak (the client can play them)',
        'missing: ' + JSON.stringify(missing));
}

/* ----------------------------------------------------------- where to dive
 *
 * The deep spot is read out of maps/forts.map, not typed in, and for the reason
 * this repo learned the hard way three times: a test that keeps its own copy of
 * the map tests a map that does not exist. The water brush is one box
 * (1344..3520 x 0..2048 x -288..-48 in world units) and the bed is its floor,
 * so a player standing on the bed is 216 units under the surface with their
 * eyes there too.
 *
 * The one thing this adds to "the middle of the water" is the bridge: the deck
 * spans the channel at y 576..832, and a player under it is still drowning, but
 * the open channel is the honest place to be standing still for 15 s.
 */
const GEO_PY = [
  'import sys, json',
  'sys.path.insert(0, "scripts")',
  'import mapfile, gen_map as g',
  'shapes = [s[0] for s in mapfile.shapes_in(open("maps/forts.map").read())',
  '         if s[0][6] == g.TEX_WATER]',
  'w = max(shapes, key=lambda b: b[5] - b[2])',
  'bridge_y = [g.sc(v) for v in g.FORTS_BRIDGE_Y]',
  'ys = [w[1] + 32, w[4] - 32]',
  'y = ys[0] if (ys[0] < bridge_y[0] - 64 or ys[0] > bridge_y[1] + 64) else ys[1]',
  'print(json.dumps({',
  '    "x": (w[0] + w[3]) / 2.0, "y": y,',
  '    "bed": w[2], "top": w[5], "depth": w[5] - w[2],',
  '    "bridge_y": bridge_y,',
  '    "bridge_y_mid": (bridge_y[0] + bridge_y[1]) / 2.0,',
  '    "deck": g.sc(g.FORTS_BRIDGE_Z),',
  '    "box": [w[0], w[1], w[2], w[3], w[4], w[5]],',
  '}))',
].join('\n');

function deepWater() {
  const r = spawnSync('python3', ['-c', GEO_PY], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; }
}

/* --------------------------------------------------------------- the log
 *
 * One pass over the log in ORDER, because order is information here: the probe
 * prints a sample every 0.25 s and the rule prints its events with the server's
 * clock, so walking the file once gives every sample the nearest event before it.
 *
 * QWTFPOS [name] x y z yaw health waterlevel team carry caps red blue weapon
 *          currentammo armour time
 *          ^ the last two are probe.qc's append-only additions, for this test.
 * QWTF_DROWN name dmg= health= tick= sound=
 * QWTF_EVENT {dive,drown,surface}_at <seconds>
 */
function parseLog(text) {
  const st = { events: [], drowns: [], samples: [] };
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) continue;
    let m = /^QWTF_EVENT (dive|drown|surface)_at (\S+)$/.exec(line);
    if (m) { st.events.push({ kind: m[1], t: parseFloat(m[2]) }); continue; }
    m = /^QWTF_DROWN (\S+) dmg=(\S+) health=(\S+) tick=(\S+) sound=(\S+)$/.exec(line);
    if (m) {
      st.drowns.push({ name: m[1], dmg: parseFloat(m[2]), health: parseFloat(m[3]),
                       tick: parseInt(m[4], 10), sound: m[5] });
      continue;
    }
    m = /^QWTFPOS \[([^\]]*)\] (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(line);
    if (m) {
      /* m[1] is the NAME, so numeric field N is m[N + 1]. That off-by-one is why
       * this reads armour from m[15] and the clock from m[16] and not from m[14]
       * and m[15]: with those, every check below reads `currentammo` as armour
       * and `armour` as the clock, and it fails in a way that looks exactly like
       * a broken rule -- every sample "happened" at 198 s and every player had 40
       * armour, so nothing between two times ever matched and no damage showed.
       */
      st.samples.push({
        name: m[1],
        x: parseFloat(m[2]), y: parseFloat(m[3]), z: parseFloat(m[4]),
        yaw: parseFloat(m[5]), health: parseFloat(m[6]), waterlevel: parseFloat(m[7]),
        armour: parseFloat(m[15]), t: parseFloat(m[16]),
      });
    }
  }
  return st;
}

/* The last sample at or before `t` -- "what did the server think at t", for a
 * question about a moment rather than about the end of the run. */
function sampleAt(st, t) {
  let out = null;
  for (const s of st.samples) { if (s.t <= t) out = s; else break; }
  return out;
}
const firstAt = (st, kind) => (st.events.find(e => e.kind === kind) || {}).t;
const pool = (s) => (s ? s.health + s.armour : 0);

/* -------------------------------------------------------------- the server */

class Server {
  constructor(port) { this.port = port; }

  async start() {
    fs.mkdirSync(RUN, { recursive: true });
    this.out = fs.openSync(LOG, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', STAGE,
      '--map', 'forts',
      /* developer is what lets dprint reach stdout at all; qwtf_trace is the
       * probe's own gate. The rules are observed through QWTF_EVENT, which is
       * printed either way -- the static checks above say so about the code. */
      '+set', 'developer', '1',
      '+serverinfo', 'qwtf_trace', '1',
    ], { cwd: ROOT, stdio: ['pipe', this.out, 'pipe'], detached: true });
    this.proc.stderr.on('data', () => {});
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(this.text())) return true;
      if (this.proc.exitCode !== null) break;
    }
    return /Quake Initialized/.test(this.text());
  }

  text() { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } }
  command(c) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(c + '\n'); }
  state() { return parseLog(this.text()); }

  /* The server's teleport hook (qwtf/probe.qc), a TEST HOOK: it puts the
   * player somewhere in 1/50 s where walking takes minutes. One-shot per seq,
   * so this is not a pin. */
  goto(x, y, z, seq) {
    this.command(`serverinfo qwtf_gx ${x}`);
    this.command(`serverinfo qwtf_gy ${y}`);
    this.command(`serverinfo qwtf_gz ${z}`);
    this.command(`serverinfo qwtf_gseq ${seq}`);
  }
  hurt(seq, amount) {
    this.command(`serverinfo qwtf_hurtseq ${seq}`);
    this.command(`serverinfo qwtf_hurt ${amount}`);
  }

  async waitFor(pred, ms, what) {
    const end = Date.now() + ms;
    let st = this.state();
    while (Date.now() < end) {
      if (pred(st, this.text())) return st;
      await sleep(250);
      st = this.state();
    }
    if (what) bad(what, describe(st));
    return st;
  }

  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {} }
    try { if (this.out) fs.closeSync(this.out); } catch (e) {}
    await sleep(300);
  }
}

/* What the log looks like when something did not happen. Printed with a failure
 * so "no drown events" is never just a count. */
function describe(st) {
  return `events so far: ${JSON.stringify(st.events)}; drown lines: ` +
         `${st.drowns.length}; last sample: ${JSON.stringify(st.samples[st.samples.length - 1] || null)}`;
}

/* -------------------------------------------------------------- the client
 *
 * One headless Chrome page on the real page (web/index.html), auto-joined to the
 * real server: the drowning has to be shown on the path a player uses, and
 * FTE's own movement runs on this client, not on a stub.
 */
class Client {
  constructor(name, cdpPort) { this.name = name; this.port = cdpPort; this.logs = []; this.errors = []; }

  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `qwtf-${this.name}-`));
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=800,600', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    /* Chrome's own output goes to a FILE: a pipe with no reader fills at 64 KB
     * and blocks the renderer, which looks exactly like a dead page. A WriteStream,
     * not fs.openSync's descriptor -- pipe() wants a stream. */
    this.logStream = fs.createWriteStream(path.join(RUN, `chrome-${this.name}.log`));
    this.proc.stdout.pipe(this.logStream);
    this.proc.stderr.pipe(this.logStream);

    let info = null;
    for (let i = 0; i < 150; i++) {
      const r = spawnSync('curl', ['-s', `http://127.0.0.1:${this.port}/json/list`],
                          { encoding: 'utf8' });
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${this.name} CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  /* One Runtime.evaluate, for the lobby's picks (2026-10-09): a join is held
   * until both a team and a class are picked, and this test's diver must be
   * a swimming body, not a noclip lobby waiter. */
  async evalJS(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    await sleep(400);
    try { if (this.logStream) this.logStream.end(); } catch (e) {}
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* --------------------------------------------------------------- the gamedir
 *
 * A symlink farm per run, exactly as ctf_rules.js does: two runs sharing
 * tests/artifacts/gamedir delete each other's content mid-load.
 *
 * --progs DIR replaces the two .dat files with DIR's, which is how the negative
 * run gets a server whose progs have no drowning rule in them.
 */
function stage(progsDir) {
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
  if (progsDir) {
    for (const f of ['progs.dat', 'qwprogs.dat']) {
      const src = path.join(progsDir, f);
      const dst = path.join(STAGE, 'id1', f);
      if (!fs.existsSync(src)) { console.log(`  FAIL --progs ${progsDir}: no ${f}`); process.exit(1); }
      fs.rmSync(dst, { force: true });
      fs.copyFileSync(src, dst);
    }
    console.log(`  (using ${progsDir}'s progs.dat and qwprogs.dat)`);
  }
}

/* ------------------------------------------------------------------- the run */

async function liveChecks() {
  console.log('');
  console.log('a dive, on the real page against the real server');

  const geo = deepWater();
  if (!geo) {
    bad('read the channel out of maps/forts.map',
        'scripts/mapfile.py + gen_map.py did not answer; every water check below ' +
        'would be guessing at a spot');
    return;
  }
  ok('the deep water is read from the map: box ' + JSON.stringify(geo.box) +
     ', surface ' + geo.top + ', bed ' + geo.bed + ' (' + geo.depth + ' deep)');
  /* Feet on the bed: origin = floor + 24, the same 24 the walk tests use. A bare
   * floor z puts the player's feet 24 units inside the surface they stand on
   * (drop leg, reviewer 0527 item 3). */
  const dive = { x: geo.x, y: geo.y, z: geo.bed + 24 };

  stage(progsDir);
  const PORT = 24000 + (process.pid % 8000), HTTP = PORT + 1;
  const server = new Server(PORT);
  if (!await server.start()) { bad('the server loaded maps/forts.bsp'); return; }
  const page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
    '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
  let client = null;
  try {
    await sleep(1500);
    const url = 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=diver&autojoin=1';
    client = new Client('diver', 14000 + (process.pid % 8000));
    try {
      await client.start(url);
    } catch (e) {
      bad('the headless client loaded the page', e && e.message);
      return;
    }
    /* Wait for the JOIN, not a fixed time. A run that never joined has a log
     * full of zeros, and zero looks like a result. */
    await server.waitFor(() => /diver joined/.test(server.text()), 90000);
    const joined = /diver joined/.test(server.text());
    if (!joined) {
      bad('a player joined', 'no "diver joined" in ' + LOG + ' after 90s; everything ' +
          'below would read an empty log');
      return;
    }
    check(/QWTF_TEAM diver -> [12]/.test(server.text()),
          'a player joined and was given a team');
    await sleep(1500);

    /* THE LOBBY: the diver picks a team and a class so there is a body to
     * drown. `auto` counts as the team pick; the spawn is waited for like
     * any other server event. */
    await client.evalJS('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await client.evalJS('window.QWTF_MENU.do("cls_soldier")');
    await server.waitFor(
      () => /QWTF_EVENT class_stats diver class=soldier/.test(server.text()), 20000,
      'the lobby spawn landed (class_stats diver/soldier)');

    /* --- the dive ------------------------------------------------------- */
    const t0 = Date.now();
    server.goto(dive.x, dive.y, dive.z, 1);
    const under = await server.waitFor(
      (st) => st.samples.some(s => s.waterlevel === 3), 15000);
    const headUnder = under.samples.find(s => s.waterlevel === 3);
    if (!headUnder) {
      bad(`the head is under the water at ${dive.x.toFixed(0)} ${dive.y.toFixed(0)} ` +
          `${dive.z.toFixed(0)}`,
          `waterlevel never read 3 in 15s. ${describe(under)} -- every drowning ` +
          'check below would be asserting about a player standing in the air');
      return;
    }
    ok(`the head is under the water (waterlevel 3 at ` +
       `${headUnder.x.toFixed(0)} ${headUnder.y.toFixed(0)} ${headUnder.z.toFixed(0)}, ` +
       `bed ${geo.bed}, surface ${geo.top})`);

    /* Fifteen seconds of doing nothing at all. The rules run on their own clock
     * and the player holds no key, so nothing here depends on the client sending
     * input -- the only thing the client had to do was connect. */
    const C = drownConstants();
    const want = C.QWTF_DROWN_TIME;
    /* Wait for THREE ticks, not for the first one. Returning on the first drown
     * event is how this ran once and reported "1 tick, no gaps": the checks below
     * are about damage AT INTERVALS, and one tick is not an interval. */
    const drownEvents = await server.waitFor(
      (st) => st.events.filter(e => e.kind === 'drown').length >= 3, (want + 14) * 1000);
    const st1 = drownEvents;
    const diveT = firstAt(st1, 'dive');
    const drownT = firstAt(st1, 'drown');
    const ticks = st1.drowns;

    if (diveT === undefined) {
      bad('the rule announced the dive (QWTF_EVENT dive)',
          `no dive event within ${want + 12}s of being put under. ${describe(st1)}`);
      return;
    }
    ok(`the rule announced the dive at t=${diveT.toFixed(2)} (server clock)`);

    /* The head stayed under: EVERY sample between the dive and the first tick
     * reads waterlevel 3. A tick fired while the player was standing in the air
     * would mean the rule counts something other than being submerged. */
    const whileUnder = st1.samples.filter(s => s.t >= diveT && s.t <= drownT);
    check(whileUnder.length > 0 && whileUnder.every(s => s.waterlevel === 3),
          'every sample between the dive and the first tick says the head was under',
          JSON.stringify(whileUnder.map(s => [s.t, s.waterlevel])));

    /* NO DAMAGE BEFORE THE 15 s. This is the check that makes the number mean
     * something: vanilla drowns at 12 s (client.qc:1031) and prints nothing, so a
     * test that only watched for our own event could not tell "15 s" from "12 s
     * plus our 15 on top". Armour and health are both read because T_Damage spends
     * armour first (combat.qc:168-177), and a 2-point tick against the Soldier's
     * 200 armour at 0.6 costs armour and no blood at all. */
    const early = st1.samples.filter(s => s.t >= diveT && s.t < diveT + want - 0.5);
    const earlyLoss = early.length
      ? (pool(early[0]) - pool(early[early.length - 1]))
      : -1;
    check(early.length >= 10 && earlyLoss === 0,
          `nothing at all is lost in the first ${want - 0.5}s -- so this is our ` +
          `${want} s rule and vanilla's 12 s is not also running`,
          `${early.length} samples, health+armour fell ${earlyLoss}. ` +
          (early.length < 10 ? 'too few samples to say anything: ' : '') + describe(st1));

    if (drownT === undefined) {
      bad(`the player takes damage after ${want} s under water`,
          `no drown event within ${want + 12}s. ${describe(st1)}`);
      return;
    }
    const first = drownT - diveT;
    check(first >= want - 0.5 && first <= want + 1.0,
          `the first damage lands ${first.toFixed(2)}s under (the design's ${want})`,
          `drown_at - dive_at = ${first.toFixed(3)}`);

    /* At intervals. Three ticks minimum: two intervals are one interval and a
     * coincidence. The gaps are differences of the server's own clock, which is
     * why the rule prints an _at line per tick instead of trusting this
     * process's wall clock. */
    check(ticks.length >= 3,
          `the damage repeats: ${ticks.length} ticks in ` +
          `${((Date.now() - t0) / 1000).toFixed(0)}s of real time`);
    const at = st1.events.filter(e => e.kind === 'drown').map(e => e.t);
    const gaps = [];
    for (let i = 1; i < at.length; i++) gaps.push(at[i] - at[i - 1]);
    const worst = gaps.length ? Math.max(...gaps.map(g => Math.abs(g - C.QWTF_DROWN_TICK))) : 99;
    check(gaps.length >= 2 && worst <= 0.3,
          `every tick is ${C.QWTF_DROWN_TICK}s apart (gaps ` +
          `${gaps.map(g => g.toFixed(2)).join(', ')})`,
          `worst gap off by ${worst}`);

    /* The sound. Both LibreQuake drowning samples, and alternating: a check that
     * only asked for "a drowning sound" would pass on one sample forever. */
    const wavs = [...new Set(ticks.map(t => t.sound))];
    check(wavs.length > 0 &&
          wavs.every(w => w === 'player/drown1.wav' || w === 'player/drown2.wav'),
          'every tick played a drowning sample (' + wavs.join(', ') + ')');
    let alternating = true;
    for (let i = 1; i < ticks.length; i++) if (ticks[i].sound === ticks[i - 1].sound) alternating = false;
    check(ticks.length < 2 || alternating,
          'and they alternate, so a drowning player does not hear one loop',
          ticks.map(t => t.sound).join(' '));
    check(ticks.map(t => t.tick).join(',') === ticks.map((_, i) => i + 1).join(','),
          'the ticks count up on this dive (' + ticks.map(t => t.tick).join(',') + ')');

    /* The damage is REAL: it went through T_Damage, so health and armour fell by
     * the sum of what the rule said it dealt. Health alone would say "nothing
     * happened" here, which is the whole reason the probe prints armour.
     *
     * The sample to compare against is the FIRST probe sample at or after the
     * last tick, and finding it has to WAIT for it. Both frames run in the same
     * server frame with the rule first (PlayerPreThink) and the probe second
     * (PlayerPostThink), so that sample has the tick in it; and the next tick is a
     * full second later, so it cannot have the one after that in it too. Reading
     * the log the instant waitFor saw the third event instead measured a sample
     * from BEFORE the third tick -- 6 points of damage against 12 the rule said
     * it had dealt, which reads like a rule that prints more than it does. */
    const sum = ticks.reduce((a, t) => a + t.dmg, 0);
    const before = sampleAt(st1, diveT);
    const caughtUp = await server.waitFor(
      (st) => st.samples.some(s => s.t >= at[at.length - 1]), 4000);
    const after = caughtUp.samples.find(s => s.t >= at[at.length - 1]);
    const lost = (before && after) ? pool(before) - pool(after) : -1;
    check(lost > 0 && Math.abs(lost - sum) <= 2,
          `the ${sum} points the rule dealt came out of the player (health+armour ` +
          `fell ${lost})`,
          `before ${JSON.stringify(before)} after ${JSON.stringify(after)} ` +
          `rule said ${sum}; samples at/after the last tick: ` +
          `${JSON.stringify(caughtUp.samples.filter(s => s.t >= at[at.length - 1]).slice(0, 3))}`);
    check(ticks.every(t => t.dmg >= C.QWTF_DROWN_DMG_MIN) &&
          ticks[ticks.length - 1].dmg <= C.QWTF_DROWN_DMG_MAX &&
          ticks[0].dmg === C.QWTF_DROWN_DMG_MIN,
          `the damage ramps ${C.QWTF_DROWN_DMG_MIN} -> ` +
          `${C.QWTF_DROWN_DMG_MAX} and stops (${ticks.map(t => t.dmg).join(',')})`);

    /* --- up again, on the bridge deck, which is dry ---------------------- */
    /* The deck, not "somewhere above the water": a player put in mid-air over
     * the channel falls straight back in, which would be a second dive inside the
     * very check that says the clock was reset. FORTS_BRIDGE_Z out of gen_map is
     * where the bridge's surface is. */
    const dry = { x: geo.x, y: geo.bridge_y_mid, z: geo.deck + 24 };
    server.goto(dry.x, dry.y, dry.z, 2);
    await server.waitFor((st) => st.events.some(e => e.kind === 'surface'), 8000);
    /* Wait for the PROBE to see the player out of the water, not just for the
     * rule to say so: the event is printed in the same frame the teleport
     * happened, and the trail is a quarter-second behind it. THREE samples, and
     * `>=` on both sides of this comparison -- the frame that reports the
     * surfacing is the same frame that reports the first dry sample (same
     * `time`, same player, and the first version of this check used `>` here and
     * `>=` in the wait, so it waited for a sample and then refused to count it). */
    const drySample = (st, t0) =>
      st.samples.filter(s => t0 !== undefined && s.t >= t0 && s.waterlevel < 3);
    const st2 = await server.waitFor(
      (st) => drySample(st, firstAt(st, 'surface')).length >= 3, 8000);
    const surfaceT = firstAt(st2, 'surface');
    check(surfaceT !== undefined && surfaceT > drownT,
          'the rule announced surfacing (' +
          (surfaceT === undefined ? 'never' : `t=${surfaceT.toFixed(2)}`) + ')');
    const outOfWater = drySample(st2, surfaceT);
    check(outOfWater.length > 0,
          'and the samples agree the head came out',
          `waterlevel after surfacing: ${JSON.stringify(outOfWater.map(s => s.waterlevel))}`);
    const drownsBefore = st2.drowns.length;
    await sleep(3000);
    const st3 = server.state();
    const newTicks = st3.drowns.length - drownsBefore;
    check(newTicks === 0,
          'and the drowning stopped: three seconds out of the water, no new damage',
          `${newTicks} new drown lines after surfacing; ${describe(st3)}`);

    /* --- it can still kill, and the death says drowning ----------------- */
    /* Hurt the player first, because armour spends itself before health does and
     * a Soldier at 100 health and 200 points of armour would otherwise need about
     * 50 s under water to die, which is most of a minute of test time for a fact
     * the arithmetic already gives. The hurt is the probe's own hook
     * (qwtf_hurtseq) and it is a real T_Damage, so what it leaves behind is a
     * real low-health player -- the precondition for "drowning kills", not a
     * substitute for it. The death below is then still the rule's to do. */
    server.hurt(1, 200);
    await server.waitFor((st, txt) => /QWTFHURT diver/.test(txt), 6000);
    const hurtLine = (server.text().split('\n').map(l => l.trim())
      .filter(l => l.startsWith('QWTFHURT diver')).pop() || '');
    check(/^QWTFHURT diver 200 health=\S+$/.test(hurtLine),
          'the probe hurt the player for 200 (' + hurtLine + ')');
    /* The hook's line prints the health BEFORE the damage (probe.qc prints, then
     * calls T_Damage), so the wounded health has to come from the sample trail
     * instead. `alive but hurt` is the precondition for "drowning kills"; if the
     * player were still at 100 with 200 armour the water would need another 50 s
     * of test time to kill anything, which is why the check is here and not a
     * 50 s wait. */
    const wounded = await server.waitFor(
      (st) => st.samples.some(s => s.health > 0 && s.health < 100), 8000);
    const hurt = wounded.samples.filter(s => s.health > 0 && s.health < 100).pop();
    const alive = hurt ? hurt.health : 0;
    check(alive > 0 && alive < 100,
          `the player is alive but wounded (${alive} health, ${hurt ? hurt.armour : '?'} armour)`);
    /* The first sample used to be the spawned body's; since the lobby
     * (2026-10-09) the first samples are the lobby waiter's -- no armour, no
     * body -- so the "before" here is the first sample of the DRESSED body. */
    const atSpawn = server.state().samples.find(s => s.armour > 0);
    check(!!hurt && !!atSpawn && hurt.armour < atSpawn.armour,
          `and the hurt spent armour as well (${atSpawn ? atSpawn.armour : '?'} -> ` +
          `${hurt ? hurt.armour : '?'}), which is why health moves before armour runs out`);

    server.goto(dive.x, dive.y, dive.z, 3);
    await server.waitFor((st) => st.events.filter(e => e.kind === 'dive').length >= 2, 10000);
    const dives = server.state().events.filter(e => e.kind === 'dive');
    check(dives.length >= 2,
          'the second dive starts a NEW breath, so the clock really was reset',
          `${dives.length} dive events`);
    await sleep(6000);
    const quickTicks = server.state().drowns.length - drownsBefore;
    check(quickTicks === 0,
          'six seconds into the second dive there is still no damage, as on the first',
          `${quickTicks} drown lines since surfacing; ${describe(server.state())}`);

    const dead = await server.waitFor(
      (st, txt) => /forgot how to swim|ran out of air/.test(txt), (want + 30) * 1000);
    check(/forgot how to swim|ran out of air/.test(server.text()),
          'drowning kills, and the obituary is the game\'s own drowning line');
    /* The drowning alone finished it: the health on the rule's own lines walks
     * down from what the hurt hook left, and the last of those ticks is the one
     * that killed. Nothing here is the hook's doing -- the hook ran 20 s and 15 s
     * of water earlier, and the player was alive (and above 0 health) after it. */
    const after2 = dead.drowns.slice(drownsBefore);
    const walked = after2.map(t => t.health);
    /* NOT strictly decreasing: T_Damage spends armour before health
     * (combat.qc:168-177), so the first tick or two of a wounded player can cost
     * armour and no blood at all and print the same health twice. What has to hold
     * is that it never goes UP and that the end is below where it started. */
    const falling = after2.every((t, k) => (k === 0 ? t.health <= alive : t.health <= after2[k - 1].health));
    check(after2.length >= 2 && falling &&
          after2[after2.length - 1].health < after2[0].health,
          `the drowning walked the health down on its own printed lines: ` +
          `${alive} then ${walked.join(' > ')}`,
          `drown lines after surfacing: ${JSON.stringify(after2)}`);
    const sum2 = after2.reduce((a, t) => a + t.dmg, 0);
    check(after2.length > 0 && sum2 >= alive,
          `and the water dealt ${sum2} against the ${alive} health it found -- so ` +
          'the death is the drowning rule\'s, not the hook\'s');

    const errs = (client.errors || []).slice(0, 3);
    check(errs.length === 0, 'the page raised no exceptions', errs.join(' | '));
  } finally {
    if (client) await client.stop();
    try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {}
    await server.stop();
  }
}

const argProgs = (() => {
  const i = process.argv.indexOf('--progs');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const progsDir = argProgs ? path.resolve(argProgs) : null;

(async () => {
  console.log('== tests/drown.js: the drowning rule, on a real page and a real server ==');
  /* --static-only is the check_all row. Everything above is a file read, so it is
   * under a second and belongs in the standing table (the drowning rule must not be
   * able to drift back to "only while a test watches" without something going red);
   * everything below boots a server and a browser, which is why it does not. */
  const staticOnly = process.argv.includes('--static-only');
  staticChecks();
  if (!staticOnly) await liveChecks();
  console.log('');
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log, chrome-diver.log)`);
  if (failed) {
    console.log(`FAIL: ${passed} ok, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
})();