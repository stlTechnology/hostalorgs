#!/usr/bin/env node
/*
 * tests/test_sniper.js -- the Sniper's two guns (M5b, GAME-DESIGN.md "Classes"
 * row 2), on a real server and a real page, with qwtf_trace OFF.
 *
 *   node tests/test_sniper.js               # builds its progs variants, then runs
 *   node tests/test_sniper.js --static-only # the static half alone
 *   node tests/test_sniper.js --progs DIR   # run the live half against DIR's progs
 *
 * THE GUNS (the brief, .lane/BRIEF.md):
 *   charged rifle   hold fire to charge; the shot fires ON RELEASE. Damage
 *                   20 + 30/s of charge, capped at 110 (3 s). fov 40 while
 *                   charging, 90 back on release. 1.5 s between shots, 1 shell
 *                   per shot. Event: QWTF_EVENT sniper_shot <name> charge=<s>
 *                   dmg=<n>.
 *   auto-rifle      the nailgun slot: a hitscan bullet every 0.1 s, 8 damage,
 *                   1 nail a shot, small spread. Event: sniper_auto.
 *
 * THE DONE-WHEN this file proves (the brief):
 *   - a 0-charge shot does 20 to 50 damage;
 *   - a full charge does 110;
 *   - a full charge kills a fresh Scout (75 health, 50 light armour) but NOT a
 *     fresh Soldier;
 *   - 10 auto-rifle hits do 70 to 90 damage;
 *   - nails go down by 1 per shot.
 *
 * THE EVIDENCE IS THE RULE'S OWN LINES. qwtf_trace is never set, so there are
 * no QWTFPOS samples at all: everything asserted here is a QWTF_EVENT line the
 * rule prints unconditionally (tests/drown.js's standing: qwtf_trace gates the
 * probe, never a rule), plus the game's own obituary. The shot line comes
 * BEFORE its hit line in the log by construction (qwtf/sniper.qc prints the
 * event, then fires the hitscan whose T_Damage prints the hit), so a reader
 * pairs a hit with the shot line just above it.
 *
 * HOW THE SHOOTER IS A SNIPER WITHOUT TOUCHING ANYONE'S FILES. The class gate
 * is QWTF_class_available in qwtf/classes.qc (must NOT touch), and
 * tests/ctf_rules.js asserts the class is refused while M5b is not shipped
 * (must NOT touch). So the SHIPPED progs keep refusing, and this test builds
 * its own: QWTF_EXTRA_QC=sniper_probe.qc QWTF_PROGS_OUT=<run dir> -- the
 * build script's own test hook, the precedent being qwtf/stringeq_probe.qc.
 * The probe flips exactly one boolean (sniper becomes available); everything
 * behind it is shipped code: the menu click, qwtf_setclass, classes.qc's
 * stat table, and qwtf/sniper.qc's guns.
 *
 * THE NEGATIVE CONTROL IS THE FIRST-FAIL PROOF. The same live run against a
 * progs built with QWTF_QC_SKIP=sniper.qc (probe still on) spawns a "sniper"
 * with classes.qc's stats but the STOCK guns: no QWTF_EVENT sniper_* line
 * ever prints, so the same assertions come out red. The test runs that control
 * itself and fails unless it does fail.
 *
 * THE TIMING IS THE SERVER'S. Charge/refire numbers are read off the log, not
 * off this process's clock (drown.js's reason: the log is flushed
 * asynchronously).
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
const RUN = path.join(ART, 'run-sniper-' + process.pid);
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

function sniperConstants() {
  /* The rule's own numbers, read out of the file rather than restated here. */
  const src = fs.readFileSync(path.join(ROOT, 'qwtf/sniper.qc'), 'utf8');
  const out = {};
  const re = /^float (QWTF_SNIPER_[A-Z_]+) = ([0-9.]+);/gm;
  let m;
  while ((m = re.exec(src)) !== null) out[m[1]] = parseFloat(m[2]);
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
  console.log('the guns are a rule, not a test hook, and the brief is in the file');
  const q = code('qwtf/sniper.qc');

  check(!/infokey\s*\(\s*world\s*,\s*"qwtf_trace"/.test(q) && !/QWTF_TRACE_NEXT/.test(q),
        'nothing in qwtf/sniper.qc reads the trace cvar');
  check(/wrap void\(\) W_Attack/.test(q), 'the guns are on the W_Attack wrap');
  check(/wrap void\(\) PlayerPreThink/.test(q),
        'the charge clock is on PlayerPreThink, the hook the brief names');
  check(/wrap void\(float id\) QWTF_class_apply/.test(q),
        'the per-life reset is on QWTF_class_apply, the one door every class goes through');
  check((q.match(/prior\(\);|prior\(id\);|prior\(targ/g) || []).length >= 3,
        'the wraps call prior() -- classes.qc\'s medkit, sticky charges and stock guns are below them');

  const c = sniperConstants();
  check(c.QWTF_SNIPER_BASE === 20,
        'a zero-charge shot is worth ' + c.QWTF_SNIPER_BASE + ' (qwtf/sniper.qc)',
        'the brief: damage 20 + 30 per second');
  check(c.QWTF_SNIPER_PER_SEC === 30,
        'the charge adds ' + c.QWTF_SNIPER_PER_SEC + ' damage a second');
  check(c.QWTF_SNIPER_CAP_TIME === 3, 'the cap is reached at ' + c.QWTF_SNIPER_CAP_TIME + ' s');
  check(c.QWTF_SNIPER_BASE + c.QWTF_SNIPER_PER_SEC * c.QWTF_SNIPER_CAP_TIME === 110,
        `the cap is ${c.QWTF_SNIPER_BASE} + ${c.QWTF_SNIPER_PER_SEC} * ${c.QWTF_SNIPER_CAP_TIME} = 110`);
  check(c.QWTF_SNIPER_REFIRE === 1.5, '1.5 s between charged shots');
  check(c.QWTF_SNIPER_AUTO_RATE === 0.1, 'the auto-rifle fires every 0.1 s');
  check(/TraceAttack\(8, direction, "sniper_auto"\)|QWTF_sn_fire_hitscan\(8, "sniper_auto"/.test(q),
        'the auto-rifle bullet is 8 damage (TraceAttack\'s number at its one call site)');

  /* The zoom is stuffcmd, the brief's own spellings. The values live in the
   * literals, one place, so the check reads the same place the game does. */
  check(/#define QWTF_SNIPER_FOV_CMD "fov 30\\n"/.test(q) &&
        /#define QWTF_SNIPER_FOV_BACK_CMD "fov 90\\n"/.test(q),
        'the scope is stuffcmd fov 30 up and fov 90 back (qwtf/sniper.qc)');
  /* Owner, 2026-10-09: the scope is the right mouse button, a single-barrel
   * rifle with its own sound, and the Sniper also carries the shotgun. */
  const rc = fs.readFileSync(path.join(ROOT, 'web/id1/quake.rc'), 'utf8');
  check(/^bind "MOUSE2"\s+"\+qwtf_zoom"/m.test(rc) && /alias \+qwtf_zoom "impulse 30"/.test(rc) &&
        /alias -qwtf_zoom "impulse 31"/.test(rc),
        'quake.rc holds the scope on the right mouse button (impulse 30 down, 31 up)');
  check(!/self\.qwtf_sn_charge = time;\s*\n\s*QWTF_sn_fov\(1\)/.test(q),
        'charging no longer raises the scope by itself');
  check(/self\.weaponmodel = "progs\/v_shot\.mdl"/.test(q),
        'the rifle shows the single-barrel model (v_shot.mdl), not the double barrel');
  const cq = fs.readFileSync(path.join(ROOT, 'qwtf/classes.qc'), 'utf8');
  check(/QWTF_CLASS_SNIPER\) return IT_SHOTGUN \| IT_SUPER_SHOTGUN \| IT_NAILGUN;/.test(cq),
        'the Sniper carries the shotgun as well as the rifle and the auto-rifle');

  check(/QWTF_EVENT sniper_shot /.test(q) && /charge=/.test(q) && /dmg=/.test(q),
        'the shot event prints the brief\'s shape');
  check(/QWTF_EVENT sniper_auto /.test(q), 'the auto-rifle has its own event');

  const design = fs.readFileSync(path.join(ROOT, 'GAME-DESIGN.md'), 'utf8');
  check(/Charged sniper rifle \(damage grows with hold time, zoom\), auto-rifle/.test(design),
        'GAME-DESIGN.md row 2 still asks for the charged rifle and the auto-rifle');
  check(/A charged Sniper shot kills a Scout or Medic, but not a full-armour\s*\n\s*Soldier or Heavy/.test(design),
        'and the balance target line is still the one this test proves');

  const build = fs.readFileSync(path.join(ROOT, 'scripts/build_progs.sh'), 'utf8');
  check((build.match(/"qwtf\/sniper\.qc"/g) || []).length === 2,
        'build_progs.sh compiles qwtf/sniper.qc into BOTH include lines');

  const pak = pakSounds();
  const need = ['sound/qwtf/rifle.wav', 'sound/weapons/rocket1i.wav'];
  const missing = need.filter(s => !pak.has(s));
  check(missing.length === 0,
        'the rifle\'s own sound (ours, scripts/mk_sounds.py) and the auto-rifle\'s are in sounds.pak',
        'missing: ' + JSON.stringify(missing));

  check(/QWTF_QC_SKIP=sniper\.qc/.test(fs.readFileSync(__filename, 'utf8')),
        'the negative control (the progs without sniper.qc) is part of this test');
}

/* -------------------------------------------------- building the progs pair */

/* The rule progs: the shipped tree + the availability probe. The control
 * progs: the same minus sniper.qc. Both land under RUN, never in web/id1. */
function buildProgs(name, skip) {
  const out = path.join(RUN, name);
  fs.mkdirSync(out, { recursive: true });
  const env = Object.assign({}, process.env, {
    QWTF_EXTRA_QC: 'sniper_probe.qc',
    QWTF_PROGS_OUT: out,
  });
  if (skip) env.QWTF_QC_SKIP = 'sniper.qc';
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
 * QWTF_EVENT sniper_shot <name> charge=<s> dmg=<n> shells=<n>
 * QWTF_EVENT sniper_shot_at <seconds>
 * QWTF_EVENT sniper_auto <name> nails=<n>
 * QWTF_EVENT sniper_hit <victim> dmg=<n> health=<n> armour=<n>
 * QWTF_EVENT class_stats <name> class=<cls> speed= hp= armour= absorb= shells= nails= ...
 */
function parseLog(text) {
  const st = { shots: [], autos: [], hits: [], stats: [] };
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line) continue;
    let m = /^QWTF_EVENT sniper_shot (\S+) charge=(\S+) dmg=(\S+) shells=(\S+)$/.exec(line);
    if (m) { st.shots.push({ who: m[1], charge: parseFloat(m[2]), dmg: parseFloat(m[3]),
                             shells: parseFloat(m[4]) }); continue; }
    m = /^QWTF_EVENT sniper_shot_at (\S+)$/.exec(line);
    if (m) { if (st.shots.length && st.shots[st.shots.length - 1].at === undefined)
               st.shots[st.shots.length - 1].at = parseFloat(m[1]); continue; }
    m = /^QWTF_EVENT sniper_auto (\S+) nails=(\S+)$/.exec(line);
    if (m) { st.autos.push({ who: m[1], nails: parseFloat(m[2]) }); continue; }
    m = /^QWTF_EVENT sniper_hit (\S+) dmg=(\S+) health=(\S+) armour=(\S+)$/.exec(line);
    if (m) { st.hits.push({ victim: m[1], dmg: parseFloat(m[2]),
                            health: parseFloat(m[3]), armour: parseFloat(m[4]) }); continue; }
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
 * half-written final line ("QWTF_EVENT sniper_auto alpha na") completes into
 * a real event AFTER the mark -- on a plain split count that event's line
 * index is inside the mark, and afterN drops it (the burst read 11 of 12).
 * split('\n').length - 1 is the one count that does both halves right: a
 * trailing "" element (file ends with \n) is dropped, and a trailing PARTIAL
 * line keeps its index, so its completed form is inside the phase -- exactly
 * what "everything written before the mark is another phase's" means. */
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
       * the whole point of this test is that the guns are seen without it. */
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
 * failure so "no shot" is never just a count. */
function describe(st) {
  return `shots: ${JSON.stringify(st.shots.slice(-4))}; autos: ${st.autos.length}; ` +
         `hits: ${JSON.stringify(st.hits.slice(-4))}; stats: ${JSON.stringify(st.stats)}`;
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
   * (FTEC.cbufadd). This is how a player would type it. */
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
   * rawKeyDown, and a keyUp only when the shot must fire. */
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

  /* A tap: press, hold `ms` of wall clock, release. The charge the SERVER
   * saw is read off the log, never off this clock. */
  async tapFire(ms) {
    await this.fireDown();
    await sleep(ms);
    await this.fireUp();
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
 * THE ARENA. The duel fixture (tests/fixtures/maps/duel.bsp, generated by
 * gen_map.py --duel) has exactly two info_player_deathmatch points, 288 units
 * apart on one line, each facing the other (maps/duel.map: 16 256 24 angle 0,
 * 304 256 24 angle 180). Two clients spawn one per point, so the charged
 * rifle's single hitscan bullet -- no spread at all -- has a dead-centre
 * target, and the auto-rifle's 0.02 spread cannot miss at 288 units (its
 * widest offset is 5.8 units against a 32-unit hull). No teleport, no
 * steering: the arena IS the aim.
 *
 * THE SEQUENCE is ordered so every brief assertion gets what it names:
 *   1. alpha picks Sniper through the real menu; bravo picks Scout.
 *   2. the FIRST shot is the full charge: it meets a FRESH Scout and must
 *      kill (the brief's "kills a fresh Scout"). bravo's 10 s anti-stall
 *      respawn (client.qc:927, search_time set at death, player.qc:669)
 *      brings a fresh Scout back.
 *   3. the tap is the 0-charge shot, tried every refire window until a hit
 *      line pairs with a shot line (the first taps can land while bravo is
 *      still respawning; the events are asserted per phase by log offset).
 *   4. bravo picks Soldier while dead; the second kill's respawn applies it
 *      (classes.qc: the pending pick applies at the next respawn).
 *   5. the THIRD full charge meets a FRESH Soldier and must NOT kill.
 *   6. alpha switches to the nailgun slot and holds: 10+ hits, 8 a hit,
 *      nails down by 1 a shot.
 */
async function liveChecks(progsDir, expectFailure) {
  console.log('');
  console.log(expectFailure
    ? 'the NEGATIVE CONTROL: the same run, without qwtf/sniper.qc in the progs'
    : 'the guns, on a real page against a real server');

  stage(progsDir);
  const PORT = 25000 + (process.pid % 7000), HTTP = PORT + 1;
  const server = new Server(PORT);
  let alpha = null, bravo = null, page = null;
  const marks = {};   // per-phase log line offsets
  const mark = (name) => { marks[name] = completeLines(server.text()); };

  /* EVERYTHING below the page server shares one finally: a throw inside
   * server.start() or anywhere after it must still kill the detached server,
   * page server and browsers. A run once leaked a 100%-CPU test fteqw-sv for
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

    /* --- alpha picks the Sniper, through the real menu ------------------- */
    /* THE LOBBY (2026-10-09): the join is held until both picks are made, so
     * the team pick goes first (`auto` counts as a pick) and the Sniper pick
     * then spawns the body. */
    await alpha.evalJS('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await alpha.focus();
    const okMenu = await alpha.evalJS('!!window.QWTF_MENU && !!window.QWTF_MENU.do');
    check(okMenu, 'the overlay\'s API is on the page');
    await alpha.evalJS('window.QWTF_MENU.do("cls_sniper")');
    await server.waitFor(
      (st) => st.stats.some(s => s.who === 'alpha' && s.cls === 'sniper'), 20000,
      'picking Sniper applies the class at once (class_stats alpha class=sniper)');
    const sn = server.state().stats.find(s => s.who === 'alpha' && s.cls === 'sniper');
    if (!sn) {
      bad('the Sniper class spawned', 'no class_stats alpha class=sniper; ' + describe(server.state()));
      return null;
    }
    /* The Sniper spawns holding the rifle (IT_SUPER_SHOTGUN = 2), and the
     * scope goes up on impulse 30 and down on 31 (the right mouse button). */
    check(/QWTF_EVENT class_weapon alpha weapon=2\b/.test(server.text()),
          'the Sniper spawns holding the rifle (class_weapon alpha weapon=2)');
    await alpha.console('impulse 30');
    const up = await server.waitFor(() => /QWTF_EVENT sniper_scope_up alpha/.test(server.text()), 8000);
    check(up !== false && /QWTF_EVENT sniper_scope_up alpha/.test(server.text()),
          'impulse 30 raises the scope (QWTF_EVENT sniper_scope_up)');
    await alpha.console('impulse 31');
    await server.waitFor(() => /QWTF_EVENT sniper_scope_down alpha/.test(server.text()), 8000);
    check(/QWTF_EVENT sniper_scope_down alpha/.test(server.text()),
          'impulse 31 lowers it (QWTF_EVENT sniper_scope_down)');
    /* GAME-DESIGN.md row 2: speed 0.95x (0.95 * 320 = 304), 90 / 50 light.
     * Light armour absorbs 0.3 (classes.qc's absorb table, the same numbers
     * test_classes.js asserts for the Scout). The slots are classes.qc's M5b
     * table: 60 shells, 100 nails. */
    check(sn.speed === 304 && sn.hp === 90 && sn.armour === 50 &&
          Math.abs(sn.absorb - 0.3) < 0.01 && sn.shells === 60 && sn.nails === 100,
          'the Sniper on the wire carries GAME-DESIGN\'s row 2 (speed 304, hp 90, ' +
          'armour 50, absorb 0.3, 60 shells, 100 nails)',
          JSON.stringify(sn));
    mark('sniper-up');

    /* --- bravo, the victim, picks Scout ---------------------------------- */
    const burl = 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=bravo&autojoin=1';
    bravo = new Client('bravo', 16000 + (process.pid % 7000));
    try { await bravo.start(burl); } catch (e) {
      bad('the second browser joined', e && e.message);
      return null;
    }
    await server.waitFor(() => /bravo joined/.test(server.text()), 90000);
    if (!/bravo joined/.test(server.text())) {
      bad('a second player joined', `no "bravo joined" in ${LOG} after 90s`);
      return null;
    }
    /* The lobby: the team pick first, then the class that spawns the body. */
    await bravo.evalJS('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await bravo.focus();
    await bravo.evalJS('window.QWTF_MENU.do("cls_scout")');
    await server.waitFor(
      (st) => st.stats.some(s => s.who === 'bravo' && s.cls === 'scout'), 20000,
      'bravo picked Scout (class_stats bravo class=scout)');
    const sc = server.state().stats.find(s => s.who === 'bravo' && s.cls === 'scout');
    check(sc && sc.hp === 75 && sc.armour === 50,
          'the victim is a fresh Scout (75 health, 50 light armour)',
          sc ? JSON.stringify(sc) : 'no stats line');
    /* Both bodies are down on their own spawn points, facing each other, and
     * the log is quiet: no shots have been fired yet. */
    check(server.state().shots.length === 0, 'no shots before the test fires any');

    /* --- 1. the full charge kills a fresh Scout --------------------------- */
    /* The FIRST press can be eaten by the page: one run's "full charge"
     * released with the key having been down for 0.038 s, because the engine
     * only processed the down right before the up (a seconds-long stall right
     * after the menu pick). The gun is not the flake; the browser input is.
     * So hold again on later refire windows, and accept only a shot whose
     * charge reached the cap. A misfire that HIT the Scout is undone first:
     * bravo suicides through its own console and the 10 s anti-stall respawn
     * (client.qc:927) puts a fresh Scout back -- "kills a fresh Scout" must
     * not read a wounded one. Misfires never kill that Scout (under the 2.4 s
     * acceptance floor 92 dmg pass 64 through armour: 75 - 64 > 0), so the
     * only alpha-kills-bravo obituary in this phase is the accepted shot's. */
    mark('kill1');
    let shot1 = null, p1 = null, sawShot = false;
    for (let attempt = 0; attempt < 3 && !shot1; attempt++) {
      const shotsBefore = server.state().shots.length;
      if (attempt === 0) await sleep(1500);      /* the page settles after the menu pick */
      else if (sawShot) {
        await bravo.console('kill');
        await sleep(11500);                      /* suicide + search_time 10 s + slack */
      } else await sleep(1700);                  /* refire window only; nothing was hit */
      await alpha.tapFire(3400);                 // 3 s cap + client-side slack
      await server.waitFor((st) => st.shots.length > shotsBefore, 10000);
      const pp = parseLog(afterN(server.text(), marks.kill1));
      const s = pp.shots.length ? pp.shots[pp.shots.length - 1] : null;
      if (s) sawShot = true;
      if (s && s.charge >= 2.4) { p1 = pp; shot1 = s; }
    }
    if (!shot1) {
      /* No accepted shot: nothing downstream can pass, and in the negative
       * control this IS the expected red -- bail rather than tap at a corpse
       * for two more minutes. */
      bad('a full charge was released', sawShot
        ? 'every shot released under the cap: ' + JSON.stringify(p1 ? p1.shots : [])
        : 'no QWTF_EVENT sniper_shot at all');
      if (expectFailure) console.log('  (control failed as expected: no shot event ever printed)');
      return null;
    }
    await server.waitFor(
      (st) => st.hits.some(h => h.victim === 'bravo' && h.dmg === shot1.dmg), 8000,
      'the charged shot hit bravo (QWTF_EVENT sniper_hit)');
    p1 = parseLog(afterN(server.text(), marks.kill1));
    const hit1 = p1.hits.find(h => h.victim === 'bravo' && h.dmg === shot1.dmg);
    check(shot1 && Math.abs(shot1.charge - 3) < 0.6 && shot1.dmg === 110,
          `a full charge is 110 damage (charge ${shot1 ? shot1.charge : '?'}, ` +
          `dmg ${shot1 ? shot1.dmg : '?'})`,
          shot1 ? JSON.stringify(p1.shots) : 'no shot line');
    /* Freshness is arithmetical, not taken on faith: a FRESH Scout is 75 hp /
     * 50 light armour, light absorbs 0.3 (classes.qc's table), so a 110 shot
     * must leave armour 50 - 33 = 17 and health 75 - 77 = -2. Any earlier
     * damage on the victim shows up right here. */
    check(hit1 && hit1.health === -2 && hit1.armour === 17,
          `and it kills the fresh Scout (75/50 -> health -2, armour 17; ` +
          `hit: ${hit1 ? 'health ' + hit1.health + ', armour ' + hit1.armour : 'none'})`,
          hit1 ? JSON.stringify(hit1) : 'no hit line');
    check(shot1 && hit1 && hit1.dmg === shot1.dmg,
          'the hit line carries the shot\'s own damage number');
    const chain = p1.shots.map(s => s.shells);
    check(p1.shots.length >= 1 && p1.shots[0].shells === 59 &&
          p1.shots.every((s, i) => i === 0 || s.shells === p1.shots[i - 1].shells - 1),
          `one shell per shot (60 -> ${chain.join(',')})`, JSON.stringify(p1.shots));
    await server.waitFor(
      (st, txt) => /bravo/.test(afterN(txt, marks.kill1).replace(/QWTF_EVENT[^\n]*\n/g, '')), 8000);
    const obit = afterN(server.text(), marks.kill1)
      .split('\n').map(l => l.trim())
      .find(l => l && !l.startsWith('QWTF') && l.includes('bravo') && l.includes('alpha'));
    check(!!obit, 'the game\'s own obituary printed the kill (' + (obit || 'none') + ')');

    /* --- 2. the 0-charge tap ---------------------------------------------- */
    /* bravo is respawning (10 s anti-stall). Tap every refire window until a
     * shot pairs with a hit: the taps while bravo is still dead print shots
     * with no hit, and the first one after the respawn hits. */
    mark('tap');
    let tapHit = null;
    for (let i = 0; i < 10 && !tapHit; i++) {
      await alpha.tapFire(150);
      const before = server.state().hits.length;
      await server.waitFor(
        (st) => st.hits.length > before, 2300);
      const p = parseLog(afterN(server.text(), marks.tap));
      if (p.hits.length) tapHit = p;
    }
    const p2 = tapHit || parseLog(afterN(server.text(), marks.tap));
    const tapShot = p2.shots.find(s => s.charge <= 0.5);
    const tapHits = p2.hits.filter(h => h.dmg >= 20 && h.dmg <= 50 && h.health > 0);
    check(tapShot && tapShot.dmg >= 20 && tapShot.dmg <= 50,
          `a 0-charge shot does 20 to 50 damage (charge ${tapShot ? tapShot.charge : '?'}, ` +
          `dmg ${tapShot ? tapShot.dmg : '?'})`,
          tapShot ? JSON.stringify(p2.shots.slice(0, 3)) : 'no tap shot at all');
    check(tapShot && tapHits.length > 0,
          `and it lands: the Scout takes it and lives (health ${tapHits[0] ? tapHits[0].health : '?'})`,
          JSON.stringify(p2.hits));

    /* --- 3. the Soldier pick, applied AT ONCE now (2026-10-09: the old
     *    "pending until the next respawn" path is gone; a live body respawns
     *    into the new class immediately) ------------------------------------ */
    await bravo.evalJS('window.QWTF_MENU.do("cls_soldier")');
    await server.waitFor(
      (st) => st.stats.some(s => s.who === 'bravo' && s.cls === 'soldier'), 10000,
      'bravo\'s Soldier pick applies at once (class_stats bravo class=soldier)');
    mark('kill2');
    for (let i = 0; i < 6; i++) {
      await alpha.tapFire(3400);
      const before = server.state().hits.length;
      await server.waitFor((st) => st.hits.length > before, 6000);
      const p = parseLog(afterN(server.text(), marks.kill2));
      if (p.hits.some(h => h.dmg === 110 && h.health <= 0)) break;
    }
    await server.waitFor(
      (st) => st.stats.some(s => s.who === 'bravo' && s.cls === 'soldier'), 25000,
      'the respawn applies the pending pick (class_stats bravo class=soldier)');
    const sol = server.state().stats.find(s => s.who === 'bravo' && s.cls === 'soldier');
    check(sol && sol.hp === 100 && sol.armour === 200,
          'the fresh Soldier is on the wire (100 health, 200 combat armour)',
          sol ? JSON.stringify(sol) : 'no stats line');

    /* --- 4. the full charge does NOT kill a fresh Soldier ----------------- */
    mark('survive');
    let p4 = null;
    for (let i = 0; i < 8 && !p4; i++) {
      await alpha.tapFire(3400);
      const before = server.state().hits.length;
      await server.waitFor((st) => st.hits.length > before, 6000);
      const p = parseLog(afterN(server.text(), marks.survive));
      if (p.hits.some(h => h.dmg === 110)) p4 = p;
    }
    const surv = p4 ? p4.hits[p4.hits.length - 1] : null;
    check(surv && surv.dmg === 110 && surv.health > 0,
          `the same 110 does NOT kill a fresh Soldier (health ${surv ? surv.health : '?'})`,
          surv ? JSON.stringify(p4.hits) : 'no hit on the Soldier at all');
    check(surv && surv.health >= 1 && surv.health <= 100 && surv.armour > 0,
          `and the Soldier still has armour after it (${surv ? surv.armour : '?'} left, ` +
          'combat absorbs most of a charged shot)',
          surv ? JSON.stringify(surv) : '');

    /* --- 5. the auto-rifle ------------------------------------------------ */
    await alpha.console('impulse 4');
    await sleep(2500);                   // past the charged rifle's refire window
    mark('auto');
    await alpha.fireDown();
    const before = server.state().autos.length;
    await server.waitFor((st) => st.autos.length - before >= 12, 9000,
      'the auto-rifle fired a burst (QWTF_EVENT sniper_auto)');
    await alpha.fireUp();
    const p5 = parseLog(afterN(server.text(), marks.auto));
    const autoLines = p5.autos.filter(a => a.who === 'alpha');
    check(autoLines.length >= 12, `the burst is ${autoLines.length} bullets on the log`);
    let stepping = true;
    for (let i = 1; i < autoLines.length; i++)
      if (autoLines[i].nails !== autoLines[i - 1].nails - 1) stepping = false;
    check(autoLines.length >= 2 && stepping,
          `nails go down by 1 per shot (${autoLines.slice(0, 4).map(a => a.nails).join(', ')}...)`,
          JSON.stringify(autoLines.slice(0, 6)));
    const autoHits = p5.hits.filter(h => h.victim === 'bravo');
    check(autoHits.length >= 10,
          `10+ auto-rifle hits landed (${autoHits.length})`,
          JSON.stringify(p5.hits.slice(-3)));
    check(autoHits.slice(0, 10).every(h => h.dmg === 8),
          'every auto-rifle hit is 8 damage');
    const sum10 = autoHits.slice(0, 10).reduce((a, h) => a + h.dmg, 0);
    check(autoHits.length >= 10 && sum10 >= 70 && sum10 <= 90,
          `10 auto-rifle hits do 70 to 90 damage (${autoHits.length >= 10 ? sum10 : 'n/a'})`,
          `sum of the first 10: ${sum10}`);

    const errs = (alpha.errors || []).concat(bravo ? bravo.errors : []).slice(0, 3);
    check(errs.length === 0, 'the pages raised no exceptions', errs.join(' | '));
  } finally {
    if (bravo) await bravo.stop();
    if (alpha) await alpha.stop();
    try { if (page) process.kill(-page.pid, 'SIGKILL'); } catch (e) {}
    await server.stop();
  }

  if (expectFailure) return { failed, passed };
  return { failed, passed };
}

/* ------------------------------------------------------------------- main */

const argProgs = (() => {
  const i = process.argv.indexOf('--progs');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const progsDir = argProgs ? path.resolve(argProgs) : null;

(async () => {
  console.log('== tests/test_sniper.js: the Sniper\'s two guns, with the trace off ==');
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
        /* THE FIRST-FAIL PROOF: the control progs still spawn a "sniper"
         * (classes.qc's table) but has the stock guns, so the same run must
         * come out red. A control that passes would mean the test reads
         * nothing. */
        const before = { failed, passed };
        const r = await liveChecks(controlProgs, true);
        const grew = failed - before.failed;
        check(grew > 0,
              `the negative control failed as it must (${grew} red checks without sniper.qc)`,
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
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log, chrome-alpha.log, chrome-bravo.log)`);
  if (failed) {
    console.log(`FAIL: ${passed} ok, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`PASS: ${passed} checks`);
  process.exit(0);
})();