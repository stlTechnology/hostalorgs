#!/usr/bin/env node
/*
 * tests/test_heavy.js -- the Heavy's rotary cannon (M5b, GAME-DESIGN.md
 * "Classes" row 5), on a real server and a real page, with qwtf_trace OFF.
 *
 *   node tests/test_heavy.js               # builds its progs variants, then runs
 *   node tests/test_heavy.js --static-only # the static half alone
 *   node tests/test_heavy.js --progs DIR   # run the live half against DIR's progs
 *
 * THE GUN (the brief, .lane/BRIEF.md):
 *   rotary cannon   the super-nailgun slot (key 5, nails). Spin-up: the first
 *                   0.6 s of holding fire shoots nothing (weapons/spike2.wav
 *                   once). Then every 0.1 s: 2 pellets at '0.05 0.05 0', 6
 *                   damage a pellet, 1 nail per shot. While firing the
 *                   Heavy's speed is 112 (half of 224); 224 after release.
 *                   Events: QWTF_EVENT heavy_spin <name> at the spin-up's
 *                   start; QWTF_EVENT heavy_shot <name> nails=<n> per shot.
 *
 * THE DONE-WHEN this file proves (the brief):
 *   - no heavy_shot within 0.5 s of heavy_spin;
 *   - shots then come about 10 per second;
 *   - nails drop by 1 per shot;
 *   - the speed is 112 while firing and 224 after.
 *
 * THE EVIDENCE IS THE RULE'S OWN LINES. qwtf_trace is never set, so there are
 * no QWTFPOS samples at all: everything asserted here is a QWTF_EVENT line
 * the rule prints unconditionally (tests/drown.js's standing: qwtf_trace
 * gates the probe, never a rule). The speed is read by a TEST-ONLY console
 * command, hv_speed (qwtf/heavy_probe.qc), which prints the server's own copy
 * of the caller's maxspeed as QWTF_EVENT heavy_speed -- classes.qc's
 * class_stats prints speed only at the class apply, never live, and the brief
 * wants live numbers. On the wire the command goes as `cmd hv_speed`: FTE's
 * client EATS a bare unknown command in its own console instead of
 * forwarding it (tests/test_stringeq.js's measured lesson, the same reason
 * web/menu.js sends every server-bound command with the `cmd ` prefix).
 *
 * HOW THE SHOOTER IS A HEAVY WITHOUT TOUCHING ANYONE'S FILES. The class gate
 * is QWTF_class_available in qwtf/classes.qc (must NOT touch), and
 * tests/ctf_rules.js asserts the class is refused while its lane has not
 * shipped (must NOT touch). So the SHIPPED progs keep refusing, and this test
 * builds its own: QWTF_EXTRA_QC=heavy_probe.qc QWTF_PROGS_OUT=<run dir> --
 * the build script's own test hook, the precedent being qwtf/sniper_probe.qc
 * (its harness, tests/test_sniper.js, is this file's skeleton). The probe
 * flips exactly one boolean (heavy becomes available); everything behind it
 * is shipped code: the menu click, qwtf_setclass, classes.qc's stat table,
 * and qwtf/heavy.qc's gun.
 *
 * THE NEGATIVE CONTROL IS THE FIRST-FAIL PROOF. The same live run against a
 * progs built with QWTF_QC_SKIP=heavy.qc (probe still on) spawns a "heavy"
 * with classes.qc's stats but the STOCK super nailgun: no QWTF_EVENT
 * heavy_* line ever prints, so the same assertions come out red. The test
 * runs that control itself and fails unless it does fail.
 *
 * THE TIMING IS THE SERVER'S. Spin-up/rate numbers are read off the log
 * (heavy_spin_at / heavy_shot_at), not off this process's clock (drown.js's
 * reason: the log is flushed asynchronously).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'tests/artifacts');
const WEB = path.join(ROOT, 'web');

/* Per run, every path: two concurrent runs sharing a staging directory or a
 * log file is how one run ends up asserting on the other's numbers (0239).
 * The run directory is KEPT -- server.log is the evidence behind every number
 * printed here. */
const RUN = path.join(ART, 'run-heavy-' + process.pid);
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

/* Strip // comments before a static check: the files explain at length WHY
 * they must not depend on qwtf_trace, and that explanation must not make the
 * check fail. What is forbidden is the cvar in CODE. */
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

/* ------------------------------------------------------------- static checks */

function heavyConstants() {
  /* The rule's own numbers, read out of the file rather than restated here. */
  const src = fs.readFileSync(path.join(ROOT, 'qwtf/heavy.qc'), 'utf8');
  const out = {};
  const re = /^float (QWTF_HV_[A-Z_]+) = ([0-9.]+);/gm;
  let m;
  while ((m = re.exec(src)) !== null) out[m[1]] = parseFloat(m[2]);
  const v = /^vector QWTF_HV_SPREAD = '([0-9. ]+)';/m.exec(src);
  out.QWTF_HV_SPREAD = v ? v[1] : null;
  return out;
}

function pakSounds() {
  /* Quake's pak: "PACK", the directory offset, then the directory's length.
   * The count is dirlen/64 (tests/drown.js's reader). */
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
  console.log('the cannon is a rule, not a test hook, and the brief is in the file');
  const q = code('qwtf/heavy.qc');

  check(!/infokey\s*\(\s*world\s*,\s*"qwtf_trace"/.test(q) && !/QWTF_TRACE_NEXT/.test(q),
        'nothing in qwtf/heavy.qc reads the trace cvar');
  check(/wrap void\(\) W_Attack/.test(q), 'the cannon is on the W_Attack wrap');
  check(/wrap void\(\) PlayerPreThink/.test(q),
        'the hold and the speed are on PlayerPreThink, the hook the brief names');
  check(/wrap void\(float id\) QWTF_class_apply/.test(q),
        'the per-life reset is on QWTF_class_apply, the one door every class goes through');
  check((q.match(/prior\(\);|prior\(id\);/g) || []).length >= 3,
        'the wraps call prior() -- sniper\'s guns, classes.qc\'s medkit and stock guns are below them');

  const c = heavyConstants();
  check(c.QWTF_HV_SPINUP === 0.6,
        `the spin-up is ${c.QWTF_HV_SPINUP} s of holding fire that shoots nothing (qwtf/heavy.qc)`);
  check(c.QWTF_HV_RATE === 0.1, `the cannon fires every ${c.QWTF_HV_RATE} s once spinning`);
  check(c.QWTF_HV_SPEED === 112, `the firing speed is ${c.QWTF_HV_SPEED} (half of 224)`);
  check(c.QWTF_HV_SPREAD === '0.05 0.05 0',
        `the pellet spread is '${c.QWTF_HV_SPREAD}' (the brief's own numbers)`);
  check(/pellets = 2;/.test(q), 'a pull is 2 pellets (at its one call site)');
  check(/TraceAttack\(6, direction, "heavy_cannon"\)/.test(q),
        'a pellet is 6 damage (TraceAttack\'s number at its one call site -- stock ' +
        'FireBullets hardcodes 4, which is why the pull is its own loop)');
  check(/"weapons\/spike2\.wav"/.test(q) &&
        (q.match(/sound\(self, CHAN_WEAPON, "weapons\/spike2\.wav"/g) || []).length === 1,
        'the spin-up sound is weapons/spike2.wav, played once (at the hold\'s start)');

  check(/QWTF_EVENT heavy_spin /.test(q), 'the spin event prints the brief\'s shape');
  check(/QWTF_EVENT heavy_shot /.test(q) && /nails=/.test(q),
        'the shot event prints the brief\'s shape');

  const design = fs.readFileSync(path.join(ROOT, 'GAME-DESIGN.md'), 'utf8');
  check(/rotary cannon \(spin-up, high damage, slows you while firing\)/.test(design),
        'GAME-DESIGN.md row 5 still asks for the spin-up cannon that slows while firing');

  const build = fs.readFileSync(path.join(ROOT, 'scripts/build_progs.sh'), 'utf8');
  check((build.match(/"qwtf\/heavy\.qc"/g) || []).length === 2,
        'build_progs.sh compiles qwtf/heavy.qc into BOTH include lines');
  check(!/heavy_probe/.test(build),
        'build_progs.sh never includes the probe unless QWTF_EXTRA_QC names it');

  const pak = pakSounds();
  const need = ['sound/weapons/spike2.wav', 'sound/weapons/rocket1i.wav',
                'sound/weapons/guncock.wav'];
  const missing = need.filter(s => !pak.has(s));
  check(missing.length === 0,
        'the spin-up sample and both shot samples are in sounds.pak',
        'missing: ' + JSON.stringify(missing));

  check(/QWTF_QC_SKIP=heavy\.qc/.test(fs.readFileSync(__filename, 'utf8')),
        'the negative control (the progs without heavy.qc) is part of this test');
}

/* -------------------------------------------------- building the progs pair */

/* The rule progs: the shipped tree + the availability probe. The control
 * progs: the same minus heavy.qc. Both land under RUN, never in web/id1. */
function buildProgs(name, skip) {
  const out = path.join(RUN, name);
  fs.mkdirSync(out, { recursive: true });
  const env = Object.assign({}, process.env, {
    QWTF_EXTRA_QC: 'heavy_probe.qc',
    QWTF_PROGS_OUT: out,
  });
  if (skip) env.QWTF_QC_SKIP = 'heavy.qc';
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/build_progs.sh')],
                      { cwd: ROOT, env, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(path.join(out, 'qwprogs.dat'))) {
    bad(`build_progs.sh (${name})`,
        (r.stdout || '').split('\n').slice(-6).join('\n') + '\n' +
        (r.stderr || '').split('\n').slice(-6).join('\n'));
    return null;
  }
  const warns = (r.stdout + r.stderr).toLowerCase().split('\n')
    .filter(l => l.includes('warning')).length;
  check(warns === 0, `build_progs.sh (${name}): 0 warnings`);
  return out;
}

/* --------------------------------------------------------------- the log
 *
 * QWTF_EVENT heavy_spin <name>
 * QWTF_EVENT heavy_spin_at <seconds>
 * QWTF_EVENT heavy_shot <name> nails=<n>
 * QWTF_EVENT heavy_shot_at <seconds>
 * QWTF_EVENT heavy_speed <name> maxspeed=<n>     (the probe's hv_speed)
 * QWTF_EVENT class_stats <name> class=<cls> speed= hp= armour= absorb= shells= nails= ...
 */
function parseLog(text) {
  const st = { spins: [], shots: [], speeds: [], stats: [] };
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) continue;
    let m = /^QWTF_EVENT heavy_spin (\S+)$/.exec(line);
    if (m) { st.spins.push({ who: m[1] }); continue; }
    m = /^QWTF_EVENT heavy_spin_at (\S+)$/.exec(line);
    if (m) { if (st.spins.length && st.spins[st.spins.length - 1].at === undefined)
               st.spins[st.spins.length - 1].at = parseFloat(m[1]); continue; }
    m = /^QWTF_EVENT heavy_shot (\S+) nails=(\S+)$/.exec(line);
    if (m) { st.shots.push({ who: m[1], nails: parseFloat(m[2]) }); continue; }
    m = /^QWTF_EVENT heavy_shot_at (\S+)$/.exec(line);
    if (m) { if (st.shots.length && st.shots[st.shots.length - 1].at === undefined)
               st.shots[st.shots.length - 1].at = parseFloat(m[1]); continue; }
    m = /^QWTF_EVENT heavy_speed (\S+) maxspeed=(\S+)$/.exec(line);
    if (m) { st.speeds.push({ who: m[1], maxspeed: parseFloat(m[2]) }); continue; }
    m = /^QWTF_EVENT class_stats (\S+) class=(\S+) speed=(\S+) hp=(\S+) armour=(\S+) absorb=(\S+) shells=(\S+) nails=(\S+)/.exec(line);
    if (m) { st.stats.push({ who: m[1], cls: m[2], speed: parseFloat(m[3]),
                             hp: parseFloat(m[4]), armour: parseFloat(m[5]),
                             absorb: parseFloat(m[6]), shells: parseFloat(m[7]),
                             nails: parseFloat(m[8]) }); continue; }
  }
  return st;
}

/* The log AFTER a line index -- each phase asserts only on its own lines, so
 * a shot from the previous phase can never satisfy this one. */
const afterN = (text, n) => text.split('\n').slice(n).join('\n');
/* Complete lines only: the server is mid-write when a mark is taken, and a
 * half-written final line ("QWTF_EVENT heavy_shot alpha na") completes into
 * a real event AFTER the mark -- on a plain split count that event's line
 * index is inside the mark, and afterN drops it (test_sniper.js's measured
 * reason). split('\n').length - 1 is the one count that does both halves
 * right: a trailing "" element (file ends with \n) is dropped, and a trailing
 * PARTIAL line keeps its index, so its completed form is inside the phase. */
const completeLines = (text) => text.split('\n').length - 1;

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
      '--map', 'duel',
      /* developer is what lets dprint reach stdout; qwtf_trace is NEVER set:
       * the whole point of this test is that the gun is seen without it. */
      '+set', 'developer', '1',
    /* stderr goes into the same log: run_server.sh's "no map" FATAL and FTE's
     * own crash text otherwise vanish (a silent dead server is undebuggable). */
    ], { cwd: ROOT, stdio: ['pipe', this.out, this.out], detached: true });
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(this.text())) return true;
      if (this.proc.exitCode !== null) break;
    }
    return /Quake Initialized/.test(this.text());
  }

  text() { try { return fs.readFileSync(LOG, 'utf8'); } catch (e) { return ''; } }

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

  state() { return parseLog(this.text()); }

  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {} }
    try { if (this.out) fs.closeSync(this.out); } catch (e) {}
    await sleep(300);
  }
}

/* What the log looks like when something did not happen. Printed with a
 * failure so "no spin" is never just a count. */
function describe(st) {
  return `spins: ${JSON.stringify(st.spins)}; shots: ${JSON.stringify(st.shots.slice(-4))}; ` +
         `speeds: ${JSON.stringify(st.speeds)}; stats: ${JSON.stringify(st.stats)}`;
}

/* -------------------------------------------------------------- the client
 *
 * One headless Chrome page on the real page (web/index.html), auto-joined.
 * Keys are real CDP key events on the same binds mp_combat proved: Control is
 * +attack in web/id1/quake.rc. The tap and the hold differ only in how long
 * the key stays down. */
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

  /* The menu overlay's own API, the same route ctf_rules.js drives. */
  async evalJS(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  }

  /* The engine's command buffer, the same bridge web/menu.js uses
   * (FTEC.cbufadd). This is how a player would type it. Callers pass the
   * WIRE form: a server-bound command that is not a client command needs
   * the `cmd ` prefix (test_stringeq.js: FTE's client otherwise eats the
   * bare unknown command in its own console and it never reaches the
   * server). */
  async console(cmd) {
    await this.evalJS(`(window.FTEC && FTEC.cbufadd(${JSON.stringify(cmd + '\n')})) !== undefined`);
  }

  async focus() {
    await this.send('Runtime.evaluate', { expression: 'window.focus()' });
    /* The canvas click is what gives FTE its input listeners' focus
     * (mp_combat's reason). Dispatch a real click through CDP. */
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 300,
        button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300,
        button: 'left', clickCount: 1 });
    } catch (e) {}
    await sleep(400);
  }

  /* THE FIRE KEY. ControlLeft is +attack in web/id1/quake.rc, and the event
   * is the reviewer's proven one (.team/msg/0052 experiment B): a single
   * rawKeyDown, and a keyUp only when the hold must end. */
  async fireDown() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
    });
  }
  async fireUp() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0,
    });
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
 * A symlink farm per run, exactly as ctf_rules.js does (drown.js's note). */
function stage(progsDir) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const e of fs.readdirSync(WEB)) {
    if (e === 'id1' || e === 'index.html') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  }
  /* The staged page gets the duel map in its pre-engine manifest. Measured on
   * mp_combat (0479): the web build only applies maps it fetched before the
   * engine started, so a client on a duel server with the shipped page asks
   * for the map at connect and is dropped mid-prespawn ("alpha lost
   * connection" right after modellist). The deployed page stays trim. */
  {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const END = '\t\t/* ---- END GENERATED MANIFEST ---- */';
    if (!html.includes(END)) throw new Error('staged page: no manifest END marker');
    const entry = '\t\t"id1/maps/duel.bsp": "id1/maps/duel.bsp",'.padEnd(56) +
                  '/* staged for this suite (0479) */\n';
    fs.writeFileSync(path.join(STAGE, 'index.html'), html.replace(END, entry + END));
  }
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
  /* The duel fixture's BSP lives in tests/fixtures/maps, not in web/id1, and
   * the shipped tree must not gain a file (run_server.sh refuses a map the
   * gamedir does not have). So id1/maps here is a REAL directory: the shipped
   * maps symlinked in, the duel BSP copied beside them. Symlinking the whole
   * maps dir would put the copy inside web/id1/maps. */
  fs.rmSync(path.join(STAGE, 'id1', 'maps'), { force: true });
  fs.mkdirSync(path.join(STAGE, 'id1', 'maps'));
  for (const e of fs.readdirSync(path.join(WEB, 'id1', 'maps'))) {
    fs.symlinkSync(path.join(WEB, 'id1', 'maps', e), path.join(STAGE, 'id1', 'maps', e));
  }
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/maps/duel.bsp'),
                  path.join(STAGE, 'id1', 'maps', 'duel.bsp'));
  if (progsDir) {
    for (const f of ['progs.dat', 'qwprogs.dat']) {
      const src = path.join(progsDir, f);
      const dst = path.join(STAGE, 'id1', f);
      if (!fs.existsSync(src)) { console.log(`  FAIL no ${f} in ${progsDir}`); process.exit(1); }
      fs.rmSync(dst, { force: true });
      fs.copyFileSync(src, dst);
    }
    console.log(`  (using ${progsDir}'s progs.dat and qwprogs.dat)`);
  }
}

/* ------------------------------------------------------------------- the run
 *
 * THE ARENA. The duel fixture (tests/fixtures/maps/duel.bsp) is the same
 * arena tests/test_sniper.js uses; the cannon's assertions need no victim --
 * no shot lands, every number is the shooter's own (its events, its nails,
 * its maxspeed) -- so the run is ONE client, and the flake budget is one
 * browser, not two.
 *
 * THE SEQUENCE is ordered so every brief assertion gets what it names:
 *   1. alpha picks Heavy through the real menu (the probe opened the gate).
 *      classes.qc's table hits the wire: speed 224 (0.7x), 100 hp, 300 heavy
 *      armour, absorb 0.8, 50 shells, 200 nails.
 *   2. alpha HOLDS fire ~3.4 s (spin-up 0.6 + ~2.8 s of firing): the spin
 *      event, then shots about 10 a second, nails stepping down by 1, and a
 *      live hv_speed read mid-hold at 112.
 *   3. alpha RELEASES: 0.6 s later a live hv_speed reads 224.
 *   4. alpha holds AGAIN: a SECOND spin event, and again no shot within
 *      0.5 s of it -- a released hold cannot be cashed as an instant burst.
 */
async function liveChecks(progsDir, expectFailure) {
  console.log('');
  console.log(expectFailure
    ? 'the NEGATIVE CONTROL: the same run, without qwtf/heavy.qc in the progs'
    : 'the cannon, on a real page against a real server');

  stage(progsDir);
  const PORT = 25000 + (process.pid % 7000), HTTP = PORT + 1;
  const server = new Server(PORT);
  let alpha = null, page = null;
  const marks = {};   // per-phase log line offsets
  const mark = (name) => { marks[name] = completeLines(server.text()); };

  /* EVERYTHING below the page server shares one finally: a throw inside
   * server.start() or anywhere after it must still kill the detached server,
   * page server and browser. A run once leaked a 100%-CPU test fteqw-sv for
   * exactly this reason (a TypeError bypassed the cleanup). */
  try {
    if (!await server.start()) {
      bad('the server loaded the duel fixture', LOG);
      return null;
    }
    page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
      '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
    await sleep(1500);
    const url = 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=alpha&autojoin=1';
    alpha = new Client('alpha', 15000 + (process.pid % 7000));
    try { await alpha.start(url); } catch (e) {
      bad('the headless client loaded the page', e && e.message);
      return null;
    }
    await server.waitFor(() => /alpha joined/.test(server.text()), 90000);
    if (!/alpha joined/.test(server.text())) {
      bad('a player joined', `no "alpha joined" in ${LOG} after 90s\n` +
          `page console: ${JSON.stringify(alpha.logs.slice(-8))}\n` +
          `page errors: ${JSON.stringify(alpha.errors.slice(0, 3))}`);
      return null;
    }
    await sleep(1500);

    /* --- alpha picks the Heavy, through the real menu --------------------- */
    /* THE LOBBY (2026-10-09): the join is held until both picks are made, so
     * the team pick goes first (`auto` counts as a pick) and the Heavy pick
     * then spawns the body. */
    await alpha.evalJS('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await alpha.focus();
    const okMenu = await alpha.evalJS('!!window.QWTF_MENU && !!window.QWTF_MENU.do');
    check(okMenu, 'the overlay\'s API is on the page');
    await alpha.evalJS('window.QWTF_MENU.do("cls_heavy")');
    await server.waitFor(
      (st) => st.stats.some(s => s.who === 'alpha' && s.cls === 'heavy'), 20000,
      'picking Heavy applies the class at once (class_stats alpha class=heavy)');
    const hv = server.state().stats.find(s => s.who === 'alpha' && s.cls === 'heavy');
    if (!hv) {
      bad('the Heavy class spawned', 'no class_stats alpha class=heavy; ' + describe(server.state()));
      return null;
    }
    /* GAME-DESIGN.md row 5: speed 0.7x (0.7 * 320 = 224), 100 / 300 heavy
     * armour. Heavy armour absorbs 0.8 (classes.qc's absorb table). The slots
     * are classes.qc's M5b table: 50 shells, 200 nails. */
    check(hv.speed === 224 && hv.hp === 100 && hv.armour === 300 &&
          Math.abs(hv.absorb - 0.8) < 0.01 && hv.shells === 50 && hv.nails === 200,
          'the Heavy on the wire carries GAME-DESIGN\'s row 5 (speed 224, hp 100, ' +
          'armour 300, absorb 0.8, 50 shells, 200 nails)',
          JSON.stringify(hv));
    mark('heavy-up');

    /* --- 2. THE HOLD: spin-up, then about 10 shots a second --------------- */
    /* The FIRST press can be eaten by the page: one run's hold released with
     * the key having been down for 0.038 s, because the engine only processed
     * the down right before the up (a seconds-long stall right after the menu
     * pick; test_sniper.js's measured reason). So hold again on later
     * attempts, and accept only a hold that actually fired a burst. The
     * mid-hold speed sample rides along on every attempt; it is asserted only
     * for the accepted hold, because 112 means nothing on a frame where the
     * press never arrived. */
    const HOLD_MS = 3400;              // 0.6 spin-up + ~2.8 s of firing
    async function hold(attempt, phase) {
      mark(phase);
      const spinsBefore = server.state().spins.length;
      if (attempt === 0) await sleep(1500);       // the page settles after the menu pick
      else await sleep(1700);                     // a retry settles too
      await alpha.fireDown();
      await sleep(1500);                          // mid-hold: spin-up done, firing
      await alpha.console('cmd hv_speed');        // the live speed read
      await sleep(HOLD_MS - 1500);
      await alpha.fireUp();
      await server.waitFor(
        (st) => st.spins.length > spinsBefore, 12000);
      return parseLog(afterN(server.text(), marks[phase]));
    }
    let p1 = null;
    for (let attempt = 0; attempt < 3 && !p1; attempt++) {
      const p = await hold(attempt, 'hold1');
      if (p.spins.length >= 1 && p.shots.length >= 5) p1 = p;
    }
    if (!p1) {
      /* No accepted hold: nothing downstream can pass, and in the negative
       * control this IS the expected red -- bail rather than hold at nothing
       * for two more minutes. */
      const st = parseLog(afterN(server.text(), marks.hold1));
      bad('a hold fired a burst',
          st.spins.length ? 'no burst after the spin: ' + JSON.stringify(st.shots.slice(-4))
                          : 'no QWTF_EVENT heavy_spin at all');
      if (expectFailure) console.log('  (control failed as expected: no spin event ever printed)');
      return null;
    }

    /* No heavy_shot within 0.5 s of heavy_spin -- the brief's own sentence.
     * The upper bound is the design's 0.6 plus measured client-frame slack
     * (the first held frame can lag the rawKeyDown by a frame or three). */
    const spin = p1.spins[p1.spins.length - 1];
    const firstShot = p1.shots[0];
    check(spin && spin.at !== undefined && firstShot && firstShot.at !== undefined &&
          firstShot.at - spin.at >= 0.5 && firstShot.at - spin.at <= 1.2,
          `no shot within 0.5 s of heavy_spin (gap ${spin && firstShot ?
            (firstShot.at - spin.at).toFixed(3) : '?'} s)`,
          JSON.stringify({ spin, firstShot }));
    check(spin && p1.speeds.some(s => s.who === 'alpha' && s.maxspeed === 112),
          `the speed is 112 while firing (hv_speed mid-hold: ` +
          `${p1.speeds.map(s => s.maxspeed).join(',') || 'none'})`,
          JSON.stringify(p1.speeds));

    /* About 10 per second, measured on the server's own clock: the burst's
     * span over its shot count. 0.1 s a shot is 10/s; the window absorbs
     * server frames dropped under load (a dropped frame delays a shot, it
     * cannot skip the 0.1 s floor). */
    const ats = p1.shots.filter(s => s.at !== undefined).map(s => s.at);
    const rate = ats.length >= 2 ? (ats.length - 1) / (ats[ats.length - 1] - ats[0]) : 0;
    check(rate >= 7 && rate <= 13,
          `the shots come about 10 per second (${rate.toFixed(1)}/s over ` +
          `${ats.length} shots)`,
          `span ${ats.length >= 2 ? (ats[ats.length - 1] - ats[0]).toFixed(3) : '?'} s`);

    /* Nails drop by 1 per shot: consecutive lines, starting at 199 (200 at
     * spawn, one spent by the first shot). */
    const nails = p1.shots.map(s => s.nails);
    let stepping = nails.length >= 2;
    for (let i = 1; i < nails.length; i++)
      if (nails[i] !== nails[i - 1] - 1) stepping = false;
    check(stepping && nails[0] === 199,
          `nails drop by 1 per shot (200 -> ${nails.slice(0, 4).join(',')}...)`,
          JSON.stringify(nails.slice(0, 6)));

    /* --- 3. THE RELEASE: the class speed comes back ----------------------- */
    await sleep(600);                     // let the released frame land
    await alpha.console('cmd hv_speed');
    await server.waitFor(
      (st) => st.speeds.length > p1.speeds.length, 8000,
      'the released hv_speed line printed');
    mark('release');
    const pR = parseLog(afterN(server.text(), marks.hold1));
    const rel = pR.speeds[pR.speeds.length - 1];
    check(rel && rel.maxspeed === 224,
          `the speed is 224 after release (last hv_speed: ${rel ? rel.maxspeed : '?'})`,
          JSON.stringify(pR.speeds));

    /* --- 4. THE SECOND HOLD: the spin-up cannot be cashed ----------------- */
    let p2 = null;
    for (let attempt = 0; attempt < 3 && !p2; attempt++) {
      const p = await hold(attempt, 'hold2');
      if (p.spins.length >= 1 && p.shots.length >= 3) p2 = p;
    }
    if (p2) {
      const spin2 = p2.spins[0];
      const first2 = p2.shots[0];
      check(spin2 && first2 && first2.at !== undefined &&
            first2.at - spin2.at >= 0.5,
            `the second hold spins up again (gap ${spin2 && first2 ?
              (first2.at - spin2.at).toFixed(3) : '?'} s to its first shot)`,
            JSON.stringify({ spin2, first2 }));
    } else if (!expectFailure) {
      bad('a second hold fired after its own spin-up',
          'no second hold produced a burst: ' + describe(parseLog(afterN(server.text(), marks.hold2))));
    }

    const errs = (alpha.errors || []).slice(0, 3);
    check(errs.length === 0, 'the page raised no exceptions', errs.join(' | '));
  } finally {
    if (alpha) await alpha.stop();
    try { if (page) process.kill(-page.pid, 'SIGKILL'); } catch (e) {}
    await server.stop();
  }

  return { failed, passed };
}

/* ------------------------------------------------------------------- main */

const argProgs = (() => {
  const i = process.argv.indexOf('--progs');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const progsDir = argProgs ? path.resolve(argProgs) : null;

(async () => {
  console.log('== tests/test_heavy.js: the Heavy\'s rotary cannon, with the trace off ==');
  const staticOnly = process.argv.includes('--static-only');
  staticChecks();
  if (!staticOnly) {
    let ruleProgs = progsDir;
    let controlProgs = null;
    if (!ruleProgs) {
      fs.mkdirSync(RUN, { recursive: true });
      ruleProgs = buildProgs('progs-rule', false);
      controlProgs = buildProgs('progs-norule', true);
      if (controlProgs) {
        /* THE FIRST-FAIL PROOF: the control progs still spawn a "heavy"
         * (classes.qc's table) but has the stock super nailgun, so the same
         * run must come out red. A control that passes would mean the test
         * reads nothing. */
        const before = { failed, passed };
        const r = await liveChecks(controlProgs, true);
        const grew = failed - before.failed;
        check(grew > 0,
              `the negative control failed as it must (${grew} red checks without heavy.qc)`,
              grew === 0 ? 'the control run was as green as the real one -- the test proves nothing' : '');
        if (grew === 0) {
          console.log('FAIL: the negative control did not fail; the test reads nothing.');
          process.exit(1);
        }
        /* The control's reds are the proof, not failures: its verdict is the
         * check above, so the tally returns to the pre-control count and the
         * final FAIL list stays about the real progs. */
        failed = before.failed;
      }
    }
    if (ruleProgs) await liveChecks(ruleProgs, false);
  }
  console.log('');
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log, chrome-alpha.log)`);
  if (failed) {
    console.log(`FAIL: ${passed} ok, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
})();
