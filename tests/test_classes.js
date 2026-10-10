#!/usr/bin/env node
/*
 * tests/test_classes.js -- M5a: the class system and the lobby rules.
 *
 *   node tests/test_classes.js                 both phases
 *   node tests/test_classes.js --lobby-only    the lobby phase (forks)
 *   node tests/test_classes.js --duel-only     the specials phase
 *
 * --lobby-only exists for the same reason ctf_rules.js has it: the lobby phase
 * is the one that goes red for reasons the specials phase cannot explain, and
 * iterating on a 2-minute suite by queueing it is slow. Neither flag changes
 * what is asserted.
 *
 * What is proven, and on which path:
 *
 *   the lobby rules     real joins on a real server (qwtf_setteam is what the
 *                       overlay sends; the auto-place is ctf.qc's own rule):
 *                         - a join on an empty server is auto-placed
 *                         - a join with even teams lets the joiner choose
 *                         - a switch that would unbalance is refused
 *   class stats         the server's own QWTF_EVENT class_stats trail, printed
 *                       at every spawn by qwtf/classes.qc -- soldier by default,
 *                       scout/medic/demolitions on the overlay click, heavy
 *                       refused while M5b is not shipped
 *   the specials        concussion knockback (the medic's grenade 1), the
 *                       medkit hurting an enemy and healing a wounded teammate,
 *                       sticky charges firing and detonating on command, the
 *                       timed demolition charge's 5 s fuse, the soldier's hand
 *                       and nail grenades
 *   friendly fire off   a soldier shooting a teammate does nothing to them --
 *                       proven AFTER the same soldier demonstrably hurt an
 *                       enemy, so "no damage" cannot mean "the gun did not fire"
 *   first visit         page load to playing, timed, against the 10 s budget
 *
 * Everything is observed through the server's own stdout (QWTF_EVENT and
 * QWTFPOS), never through a test hook on the client side.
 *
 * Two maps. The lobby phase runs forts (the real map, where the team-aware
 * spawn rule and the overlay live). The specials phase runs the duel fixture:
 * a straight hall whose spawns face each other, so two or three players meet
 * by walking -- the probe's teleport and face hooks are GLOBAL (one serverinfo
 * key moves or turns every player at once), so they cannot place one player
 * next to another, and nobody here uses them.
 *
 * Choreography note for the duel: alpha stays at his spawn and fires; bravo
 * (medic) walks into him and the meeting proves both directions of damage;
 * charlie (demolitions) does the walking parts, because charlie is the one who
 * changes class and team and every change respawns them onto the free spawn
 * point at their end of the hall.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const WEB = path.join(ROOT, 'web');
const RUN = path.join(ART, 'run-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const DIR = RUN;
const SHOTS = path.join(DIR, 'shots');
const LOG = path.join(DIR, 'server.log');
const LOG2 = path.join(DIR, 'duel.log');
const RUN_STARTED = Date.now();

let failed = 0, passed = 0;
/* Every client this run has started, so a red check can say what the page
 * thought. Before this, `client.errors` and `client.logs` were filled by the
 * CDP event handlers and NEVER read: the 1008-105339 run reported "picking
 * Scout in the menu applies the class at once" as a bare FAIL with no way to
 * tell a click that never reached the button from a page that threw. */
let LIVE = [];
/* Hold the array itself, not a copy of it: the phase pushes clients onto it
 * after this is called. */
function phaseOf(clients) { LIVE = clients; }
function ok(what) { console.log(`  ok   ${what}`); passed++; }
function bad(what, detail) {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  diag();
  failed++;
}
/* Print the pages' own account of themselves: the last console lines and every
 * exception. Cheap, and it is the only evidence there is when a browser-driven
 * check goes red. */
function diag(only) {
  const cs = only ? [only] : LIVE;
  for (const c of cs) {
    if (!c) continue;
    const errs = c.errors.slice(-3), logs = c.logs.slice(-6);
    if (!errs.length && !logs.length) continue;
    console.log(`       [${c.name}] page exceptions: ` +
      (errs.length ? errs.map(e => String(e).split('\n')[0]).join(' / ') : 'none'));
    if (logs.length) console.log(`       [${c.name}] console: ` + logs.join(' | ').slice(0, 400));
  }
}
const check = (c, what, detail) => c ? ok(what) : bad(what, detail);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (l) => l.replace(/[^\x20-\x7e]/g, '');

/* ------------------------------------------------------------------ staging */
function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const e of fs.readdirSync(WEB)) {
    if (e === 'id1' || e === 'index.html') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  }
  /* The staged page gets the duel map in its pre-engine manifest (the same
   * patch test_sniper.js and test_heavy.js make). Without it the web build
   * asks the server for maps/duel.bsp at connect, cl_downloads 0 refuses, and
   * alpha is dropped before the lobby ("Downloading of maps/duel.bsp blocked
   * by clientside cvars"). The deployed page stays trim. */
  {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const END = '\t\t/* ---- END GENERATED MANIFEST ---- */';
    if (!html.includes(END)) throw new Error('staged page: no manifest END marker');
    const entry = '\t\t"id1/maps/duel.bsp": "id1/maps/duel.bsp",'.padEnd(56) +
                  '/* staged for this suite */\n';
    fs.writeFileSync(path.join(STAGE, 'index.html'), html.replace(END, entry + END));
  }
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    if (e === 'maps') continue;   // merged below, with the fixture maps
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
  /* maps is a REAL directory: the shipped tree only carries forts.bsp, and the
   * specials phase's duel fixture lives in tests/fixtures/maps. The first run
   * symlinked web's maps wholesale, the duel server's own guard correctly
   * FATALed on "no map 'duel'", and its stderr went to an unread pipe -- an
   * empty duel.log and a "the duel server started" red with no cause in it. */
  fs.mkdirSync(path.join(STAGE, 'id1', 'maps'));
  for (const e of fs.readdirSync(path.join(WEB, 'id1', 'maps'))) {
    fs.symlinkSync(path.join(WEB, 'id1', 'maps', e), path.join(STAGE, 'id1', 'maps', e));
  }
  const FIX = path.join(ROOT, 'tests', 'fixtures', 'maps');
  if (fs.existsSync(FIX)) {
    for (const e of fs.readdirSync(FIX)) {
      if (e.endsWith('.bsp'))
        fs.symlinkSync(path.join(FIX, e), path.join(STAGE, 'id1', 'maps', e));
    }
  }
}

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

/* The map's own midpoint, from the generator, in world units (ctf_rules.js's
 * rule: never type what the map can say). */
const GEO_PY = [
  'import sys, json',
  'sys.path.insert(0, "scripts")',
  'import gen_map as g',
  'ents = [e for m in (False, True) for e in g.forts_entities(m)]',
  'xs = []',
  'for e in ents:',
  '    if e[0] != "info_player_deathmatch": continue',
  '    d = dict(f.split(chr(34))[1::2] for f in e[1:] if f.startswith(chr(34)))',
  '    xs.append(float(d["origin"].split()[0]))',
  'print(json.dumps({"mid_x": (min(xs) + max(xs)) / 2.0}))',
].join('\n');
function fortsMidX() {
  const r = sh('python3', ['-c', GEO_PY], { cwd: ROOT });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()).mid_x; }
  catch (e) { return null; }
}

/* ------------------------------------------------------------------- the log */
const raw = (f) => fs.readFileSync(f, 'utf8');
function logIsFromThisRun(f) {
  try {
    const st = fs.statSync(f);
    return st.size > 0 && st.mtimeMs >= RUN_STARTED;
  } catch (e) { return false; }
}
/* Exact-match event lines: "take" must not count "take_refused_*" (ctf_rules.js
 * measured four events hiding behind one substring). */
const ev = (f, what) => raw(f).split('\n').map(clean)
  .filter(l => l.startsWith('QWTF_EVENT ' + what + ' ') || l === 'QWTF_EVENT ' + what);

/* QWTFPOS [name] x y z yaw health waterlevel team ... -- the probe's 4 Hz trail
 * for every player. health and team are what the medkit and the lobby rules are
 * asserted on. */
function parsePositions(f) {
  const byName = new Map();
  let text = '';
  try { text = raw(f); } catch (e) { return byName; }
  const re = /QWTFPOS \[([^\]]*)\] (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, name, x, y, z, yaw, health, waterlevel, team] = m;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({
      t: byName.get(name).length * 0.25,
      x: parseFloat(x), y: parseFloat(y), z: parseFloat(z),
      yaw: parseFloat(yaw), health: parseFloat(health),
      water: parseFloat(waterlevel), team: parseFloat(team),
    });
  }
  return byName;
}
function trail(f, name) { const m = parsePositions(f).get(name); return m || []; }
function last(f, name) { const t = trail(f, name); return t.length ? t[t.length - 1] : null; }

/* ----------------------------------------------------------------- the server */
class Server {
  constructor(port, log, map) { this.port = port; this.log = log; this.map = map; }

  async start() {
    fs.mkdirSync(SHOTS, { recursive: true });
    this.out = fs.openSync(this.log, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', STAGE,
      '--demo-subdir', 'demos',
      '--map', this.map,
      '+set', 'qwtf_trace', '1',
      '+set', 'developer', '1',
      '+serverinfo', 'qwtf_trace', '1',
    ], { cwd: ROOT, stdio: ['pipe', this.out, this.out], detached: true });
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      try { if (/Quake Initialized/.test(raw(this.log))) return true; } catch (e) {}
      if (this.proc.exitCode !== null) break;
    }
    return false;
  }

  command(cmd) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n'); }

  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { if (this.out) fs.closeSync(this.out); } catch (e) {}
    await sleep(300);
  }
}

/* ----------------------------------------------------------------- the client */
const VK = { w: 87, a: 65, s: 83, d: 68, ' ': 32, g: 71, f: 70, v: 86, b: 66,
             ControlLeft: 17 };

class Client {
  constructor(name, cdpPort) { this.name = name; this.port = cdpPort; this.logs = []; this.errors = []; }

  /* A killed Chrome can hold its debugging port for a moment, and a NEW Chrome
   * that cannot bind it silently starts without remote debugging. The test then
   * attaches to whatever still answers on that port -- a zombie page from the
   * previous phase, already SIGKILLed -- which is how the 1008-105339 duel phase
   * got a client that connected to the server and was dropped before spawning.
   * Wait for the port to be nobody's before starting. */
  async waitPortFree(ms) {
    const deadline = Date.now() + (ms || 10000);
    while (Date.now() < deadline) {
      const r = spawnSync('curl', ['-s', '--max-time', '1',
        `http://127.0.0.1:${this.port}/json/version`], { timeout: 3000 });
      if (r.status !== 0 || !r.stdout || !/"Browser"/.test(r.stdout)) return true;
      await sleep(250);
    }
    return false;
  }

  async start(url) {
    if (!await this.waitPortFree(10000))
      console.log(`       [${this.name}] its CDP port ${this.port} was still answering; ` +
                  'attaching to whatever is there');
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `qwtf-${this.name}-`));
    /* Chrome's stdout/stderr go to a FILE, not to a pipe nobody reads. A
     * 'pipe' with no reader fills at 64 KB and then Chrome BLOCKS on write --
     * a frozen renderer looks exactly like "the click did nothing". The file is
     * also the evidence when a browser misbehaves. */
    this.chromeLog = path.join(DIR, 'chrome-' + this.name + '.log');
    this.chromeOut = fs.openSync(this.chromeLog, 'w');
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1024,576', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', this.chromeOut, this.chromeOut], detached: true });
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

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result.value;
  }

  async canvasCentre() {
    const r = await this.send('Runtime.evaluate', {
      expression: `(() => { const c = document.getElementById('canvas');
        if (!c) return null; const b = c.getBoundingClientRect();
        return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`,
      returnByValue: true,
    });
    return r.result.value;
  }

  /* focus plus the canvas click, without which no key reaches the engine
   * (the M3 lesson, ctf_rules.js and mp_combat.js both measure it). */
  async focus() {
    await this.send('Page.bringToFront').catch(() => {});
    const c = await this.canvasCentre();
    if (!c) throw new Error(`${this.name}: no canvas on the page`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    }
    return c;
  }

  async keyDown(key) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
        windowsVirtualKeyCode: VK[key] || 0, nativeVirtualKeyCode: VK[key] || 0 });
  }
  async keyUp(key) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', key: key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
        windowsVirtualKeyCode: VK[key] || 0, nativeVirtualKeyCode: VK[key] || 0 });
  }

  /* A short press-and-release burst. FTE latches impulses and movement on the
   * keydown transition; re-issuing the keydown while held is what ctf_rules.js
   * does because a keydown that lands before the spawn is dropped. */
  async nudge(key, ms) {
    await this.keyDown(key);
    await sleep(ms || 250);
    await this.keyDown(key);
    await this.keyUp(key);
  }

  /* A single clean press-and-release: one impulse per transition. */
  async tap(key) {
    await this.keyDown(key);
    await sleep(80);
    await this.keyUp(key);
  }

  /* Hold until `until` (a deadline or a position test) says stop. */
  async hold(key, until, ms) {
    const end = Date.now() + (ms || 20000);
    await this.keyDown(key);
    while (Date.now() < end && !until()) {
      await sleep(250);
      await this.keyDown(key);
    }
    await this.keyUp(key);
  }

  /* The menu overlay, opened the way a player opens it (ESC also releases the
   * pointer lock, which is what makes the buttons clickable at all). */
  /* The overlay opens ITSELF on join now (the lobby's QWTF_YOU line); wait
   * for it rather than assuming, since the picks below click its buttons.
   * No focus() first: a click on the canvas while the overlay is up would
   * land on the overlay, and CDP mouse events do not need focus anyway. */
  async waitMenuOpen(ms) {
    const end = Date.now() + (ms || 20000);
    while (Date.now() < end) {
      try { if (await this.eval('window.QWTF_MENU.isOpen()')) return true; } catch (e) {}
      await sleep(250);
    }
    return false;
  }

  async openMenu() {
    await this.send('Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(120);
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(300);
  }

  /* Click one of the overlay's own buttons by its label: a real click at the
   * element's position, not a call into QWTF_MENU.do.
   *
   * The two facts that make a click land are measured here rather than assumed,
   * because "the command never arrived" cannot tell them apart:
   *   - the overlay is OPEN. A hidden element's rect is all zeroes, so the click
   *     would go to the top-left corner of the canvas and be read as +attack.
   *   - elementFromPoint at the click point is the button, i.e. nothing is on
   *     top of it and it is inside the viewport.
   * Both are returned so the caller can print them with a red check.
   *
   * The lobby auto-closes the overlay when both picks are made, so the old
   * open/close toggling around every click no longer adds up; the click
   * therefore opens the overlay itself when it finds it shut (ESC, the way a
   * player does it), and the toggle bookkeeping is gone. */
  async clickButton(label) {
    let open = await this.eval('window.QWTF_MENU.isOpen()').catch(() => false);
    if (!open) {
      await this.openMenu();
      open = await this.eval('window.QWTF_MENU.isOpen()').catch(() => false);
      if (!open) throw new Error(`${this.name}: the overlay never opened for "${label}"`);
    }
    const r = await this.eval(`(() => {
      const m = window.QWTF_MENU;
      const b = Array.from(document.querySelectorAll('#qwtf-menu button'))
        .find(x => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return { err: 'no such button' };
      const open = !!(m && m.isOpen());
      const rect = b.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      window.__qwtf_click_note = { open, x, y,
        hit: hit ? (hit.tagName + '/' + (hit.textContent || '').trim().slice(0, 16)) : 'null',
        same: hit === b };
      /* Record what the overlay actually sends, and what actually got clicked, so
       * "the pick did not take" can be read apart rather than guessed at: the
       * TEXT matters (a cvar set in front of it, a stray prefix) as much as the
       * count does. */
      window.__qwtf_sent = [];
      window.__qwtf_clicks = [];
      if (!window.__qwtf_listeners) {
        window.__qwtf_listeners = true;
        document.addEventListener('click', function (e) {
          window.__qwtf_clicks.push(e.target.tagName + '/' + (e.target.textContent || '').trim().slice(0, 16));
        }, true);
        const real = window.FTEC && window.FTEC.cbufadd;
        if (real) window.FTEC.cbufadd = function (t) {
          window.__qwtf_sent.push(String(t)); return real.call(this, t); };
      }
      return { open, x, y, hit: window.__qwtf_click_note.hit, same: window.__qwtf_click_note.same };
    })()`);
    if (r && r.err) throw new Error(`${this.name}: ${r.err}: "${label}"`);
    if (!r || !r.open) throw new Error(`${this.name}: the overlay was NOT open when "${label}" was clicked`);
    if (!r.same) throw new Error(`${this.name}: "${label}" is covered at ${r.x.toFixed(0)},${r.y.toFixed(0)} by ${r.hit}`);
    this.lastClick = r;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1 });
      await sleep(60);
    }
    return r;
  }

  /* What the page says it sent and received since the last click, for a red
   * check. `null` when the page never got that far. */
  async sent() {
    return this.eval('JSON.stringify({ sent: window.__qwtf_sent || null, ' +
      'clicks: window.__qwtf_clicks || null, ' +
      'lock: document.pointerLockElement ? document.pointerLockElement.id : null })')
      .catch(e => 'unavailable: ' + e.message);
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
    try { if (this.chromeOut) fs.closeSync(this.chromeOut); } catch (e) {}
    await sleep(400);
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* Wait for "<name> joined" in the server's log -- the join is the thing to wait
 * for, never a fixed sleep (ctf_rules.js's measured lesson). */
async function waitJoined(f, name, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (raw(f).includes(name + ' joined')) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}
async function waitLog(f, pred, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (pred(raw(f))) return true; } catch (e) {}
    await sleep(400);
  }
  return false;
}
/* Wait until the log contains the given class_stats trail for a player.
 *
 * waitLog hands its predicate the log's CONTENTS, so this takes text, not a
 * filename. It used to take a filename and read it itself, which made every
 * check that waits for a class_stats line unreachable: waitLog called
 * fs.readFileSync on the whole log text, that threw, waitLog's try/catch ate
 * it, and the predicate could never be true. The lobby's class step therefore
 * reported FAIL with the server log plainly showing
 * `QWTF_EVENT class_stats alpha class=scout` a few lines above it. */
const statsRe = (name, cls) =>
  (text) => String(text).split('\n').some(l => l.includes(`QWTF_EVENT class_stats ${name} class=${cls}`));

/* Read one `key=value` field out of a QWTF_EVENT line as a number. The values
 * come from ftos, which prints the float 0.6 as 0.60000002 -- a literal
 * "absorb=0.6 " with a trailing space never matches, which is exactly how the
 * first run's soldier and scout rows went red on an otherwise correct line. */
function field(line, key) {
  const m = line.match(new RegExp('(?:^| )' + key + '=(\\S+)'));
  return m ? parseFloat(m[1]) : NaN;
}
const stats = (line) => ({
  speed: field(line, 'speed'), hp: field(line, 'hp'),
  armour: field(line, 'armour'), absorb: field(line, 'absorb'),
});

/* ---------------------------------------------------------- the static checks */
function staticChecks() {
  console.log('the class code is on its hooks, and the design table is in it');
  const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const cls = code('qwtf/classes.qc');

  check(!/qwtf_trace/.test(cls), 'no rule in qwtf/classes.qc reads the trace cvar');
  check(/wrap void\(\) PutClientInServer/.test(cls) && /QWTF_class_apply/.test(cls),
        'class stats are applied in the spawn hook, not on a poll');
  check(/wrap entity\(\) SelectSpawnPoint/.test(cls),
        'team-aware spawn selection is in SelectSpawnPoint, not in a tick');
  check(/wrap void\(\) ImpulseCommands/.test(cls) && /impulse == 20/.test(cls),
        'grenades ride ImpulseCommands, the same hook the guns use');
  check(/wrap void\(\) W_Attack/.test(cls) && /QWTF_medkit_attack/.test(cls),
        'the medkit is in W_Attack, behind the axe slot');
  check(/wrap void\(\) PlayerPreThink/.test(cls) && /qwtf_poison_until/.test(cls),
        'the poison tick is in PlayerPreThink, with the flash slow beside it');
  check(/SV_ParseClientCommand/.test(cls) && /clientcommand\(self, cmd\)/.test(cls),
        'the lobby commands come through SV_ParseClientCommand, unrecognised ones passed on');
  check(/wrap void\(entity targ, entity inflictor, entity attacker, float damage\) T_Damage/.test(cls),
        'friendly fire and the self-damage half live in the T_Damage wrap');
  check(/QWTF_CLASS_SOLDIER/.test(cls) && /QWTF_CLASS_SCOUT/.test(cls) &&
        /QWTF_CLASS_MEDIC/.test(cls) && /QWTF_CLASS_DEMOLITIONS/.test(cls),
        'the M5a roster is in the table');
  check(!/id == QWTF_CLASS_HEAVY \|\| id == QWTF_CLASS_SNIPER/.test(cls),
        'Heavy and Sniper are not spawnable before M5b ships them');
  const rc = fs.readFileSync(path.join(ROOT, 'web/id1/quake.rc'), 'utf8');
  const binds = {};
  for (const m of rc.matchAll(/^bind\s+"([^"]+)"\s+"([^"]+)"/gm)) binds[m[1]] = m[2];
  check(binds.g === 'impulse 20' && binds.f === 'impulse 21',
        'quake.rc binds G and F to grenade impulses 20/21 (GAME-DESIGN.md)',
        `g -> ${binds.g}, f -> ${binds.f}`);
  check(binds.v === 'impulse 22' && binds.b === 'impulse 23',
        'quake.rc binds V and B to the launcher mode toggle and the sticky detonate',
        `v -> ${binds.v}, b -> ${binds.b}`);
}

/* -------------------------------------------------------------- the lobby run */
/* Returns the clients and page for the caller to clean up, or null on a fatal
 * precondition (everything already stopped). */
async function lobbyPhase() {
  console.log('');
  console.log('the lobby and the class table, on forts (the real map)');

  const PORT = 20000 + (process.pid % 16000), HTTP = PORT + 1;
  const server = new Server(PORT, LOG, 'forts');
  const clients = [];
  phaseOf(clients);
  let page = null;
  try {
    if (!await server.start()) { bad('the server started'); return null; }
    page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
      '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
    await sleep(1500);
    const url = (name) => 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=' + name + '&autojoin=1';

    /* -- first visit ------------------------------------------------------- */
    let alpha = new Client('alpha', 10000 + (process.pid % 17000));
    clients.push(alpha);
    const t0 = Date.now();
    try { await alpha.start(url('alpha')); } catch (e) {
      bad('the first browser loaded the page', e && e.message); return null;
    }
    if (!await waitJoined(LOG, 'alpha', 90000)) {
      bad('a first-time visitor is playing within 10 s',
          'no "alpha joined" in the server log after 90 s; nothing after this can be checked');
      return null;
    }
    /* THE LOBBY (2026-10-09): the join is held -- the visitor picks a team and
     * a class in the overlay (which opens itself on join) and the spawn comes
     * with the second pick. The loading budget still applies to the JOIN;
     * playing follows the picks. */
    const joinedAt = Date.now();
    const waited = await waitLog(LOG, t => t.includes('QWTF_EVENT lobby_wait alpha'), 15000);
    const noBodyYet = !raw(LOG).includes('QWTF_EVENT class_stats alpha');
    check(waited && noBodyYet, 'the join waits in the lobby (lobby_wait, no spawn yet)',
          waited ? 'a class_stats line appeared before the picks' : 'no lobby_wait event');
    const elapsed = (joinedAt - t0) / 1000;
    check(elapsed <= 10,
          `a first-time visitor is in the lobby in ${elapsed.toFixed(1)} s from page load (<= 10)`,
          'page load to the server\'s own join line');
    if (!await alpha.waitMenuOpen()) {
      bad('the overlay opened itself for the first visitor'); return null;
    }
    try {
      await alpha.clickButton('Red team');
      await sleep(700);
      await alpha.clickButton('Soldier');
    } catch (e) {
      bad('the first visitor could pick a team and a class', e && e.message);
      return null;
    }
    const hasStats = await waitLog(LOG,
      t => t.includes('QWTF_EVENT class_stats alpha class=soldier'), 15000);
    check(hasStats, 'the second pick spawns the visitor as the picked class (Soldier)',
          'no class_stats line for alpha within 15 s of the picks');
    await alpha.focus();    // the spawn closed the overlay; the canvas is safe to click

    /* -- the design table, read server-side -------------------------------- */
    const m = raw(LOG).split('\n').map(clean)
      .find(l => l.startsWith('QWTF_EVENT class_stats alpha class=soldier'));
    const sol = m ? stats(m) : null;
    check(sol && sol.speed === 256 && sol.hp === 100 && sol.armour === 200 &&
          Math.abs(sol.absorb - 0.6) < 0.01,
          'Soldier spawns with the design-table stats (speed 256, hp 100, armour 200, absorb 0.6)',
          m);

    /* -- team-aware first spawn -------------------------------------------- */
    const mid = fortsMidX();
    if (mid === null) {
      bad('the map midpoint was readable from the generator');
    } else {
      const p = last(LOG, 'alpha');
      check(p && p.x < mid,
            `alpha spawned on its own half of the map (x ${p ? p.x.toFixed(0) : '?'} < mid ${mid.toFixed(0)})`,
            'the spawn rule put a red player in the blue fort');
    }

    /* -- the class step, on the overlay a player uses ----------------------- */
    try {
      await alpha.focus();
      await alpha.openMenu();
      await alpha.clickButton('Scout');
    } catch (e) {
      bad('the overlay could be clicked', e && e.message);
      return null;
    }
    /* The first class pick was Soldier (above), so this is a LATER pick --
     * which now applies immediately like every other (2026-10-09). */
    const scout = await waitLog(LOG, statsRe('alpha', 'scout'), 15000);
    /* The two halves of "the pick did not take", which look identical from the
     * server log: the page never handed the engine a command (a click that
     * missed), or it did and the command went nowhere. sent() is the page's own
     * record of what it handed over and what was clicked. */
    const sent = await alpha.sent();
    check(scout, 'picking Scout in the menu applies the class at once (the lobby step)',
          scout ? null
                : `the click reached the button (hit ${alpha.lastClick.hit}); the page says ` +
                  `sent=${sent}; the server logged no qwtf_setclass at all`);
    /* The page's own console is the only place FTE says what it did with a
     * command ("Can't \"cmd\", not connected", "Unknown command", "you are
     * already that class", ...). diag() prints the tail of it on a red check;
     * the whole of it is written beside the run's logs when one happens. */
    if (!scout && alpha.logs.length) {
      fs.writeFileSync(path.join(DIR, 'console-alpha.log'),
        alpha.logs.map((l, i) => String(i).padStart(3) + ' ' + l).join('\n') + '\n');
    }
    if (scout) {
      const s = raw(LOG).split('\n').map(clean)
        .find(l => l.startsWith('QWTF_EVENT class_stats alpha class=scout'));
      const sc = s ? stats(s) : null;
      check(sc && sc.speed === 432 && sc.hp === 75 && sc.armour === 50 &&
            Math.abs(sc.absorb - 0.3) < 0.01,
            'Scout spawns with the design-table stats (speed 432, hp 75, armour 50, absorb 0.3)',
            s);
      check(ev(LOG, 'setclass_first').length >= 1,
            'the first-ever class pick is recorded as the lobby step');
      await alpha.screenshot(path.join(SHOTS, '01-scout.png'));
    }
    /* -- M5b has shipped (qwtf/sniper.qc, qwtf/heavy.qc): accepted like any
     *    other later pick, applied at once. The lobby auto-closed the overlay
     *    after the Scout spawn; clickButton opens it again. --------------- */
    await alpha.clickButton('Heavy');
    const heavyUp = await waitLog(LOG, statsRe('alpha', 'heavy'), 15000);
    check(heavyUp, 'Heavy is accepted now M5b has shipped (class_stats alpha class=heavy)');

    /* -- the lobby rules need more people ----------------------------------- */
    let bravo = new Client('bravo', 10001 + (process.pid % 17000));
    clients.push(bravo);
    try { await bravo.start(url('bravo')); } catch (e) {
      bad('the second browser joined', e && e.message); return null;
    }
    if (!await waitJoined(LOG, 'bravo', 90000)) {
      bad('a second join landed', 'no "bravo joined"'); return null;
    }
    /* The lobby: `auto` counts as the team pick, and the spawn needs the
     * class pick too. */
    if (!await bravo.waitMenuOpen()) {
      bad('the overlay opened itself for bravo'); return null;
    }
    try {
      await bravo.clickButton('Auto');
      await sleep(700);
      await bravo.clickButton('Soldier');
    } catch (e) { bad('bravo could pick Auto and Soldier', e && e.message); }
    await waitLog(LOG, t => (last(LOG, 'bravo') || { team: 0 }).team !== 0, 15000);
    await bravo.focus();
    const bt = last(LOG, 'bravo');
    check(bt && bt.team === 2,
          'a join on a smaller team is auto-placed on it (bravo -> blue)',
          bt ? `bravo team ${bt.team}` : 'no trail for bravo');

    let charlie = new Client('charlie', 10002 + (process.pid % 17000));
    clients.push(charlie);
    try { await charlie.start(url('charlie')); } catch (e) {
      bad('the third browser joined', e && e.message); return null;
    }
    if (!await waitJoined(LOG, 'charlie', 90000)) {
      bad('a third join landed', 'no "charlie joined"'); return null;
    }
    if (!await charlie.waitMenuOpen()) {
      bad('the overlay opened itself for charlie'); return null;
    }
    try {
      await charlie.clickButton('Auto');
      await sleep(700);
      await charlie.clickButton('Soldier');
    } catch (e) { bad('charlie could pick Auto and Soldier', e && e.message); }
    await waitLog(LOG, t => (last(LOG, 'charlie') || { team: 0 }).team !== 0, 15000);
    await charlie.focus();
    const ct = last(LOG, 'charlie');
    check(ct && ct.team === 1, 'a third join splits 2/1 (charlie -> red)',
          ct ? `charlie team ${ct.team}` : 'no trail');

    /* -- a switch that would unbalance is refused --------------------------- */
    try {
      await bravo.focus();
      await bravo.openMenu();
      await bravo.clickButton('Red team');
    } catch (e) { bad('bravo could click Red team', e && e.message); }
    await waitLog(LOG, t => t.includes('setteam_refused'), 10000);
    check(ev(LOG, 'setteam_refused').length >= 1,
          'a switch that would unbalance is refused (2/1 -> 3/1)');
    const bt2 = last(LOG, 'bravo');
    check(bt2 && bt2.team === 2, 'the refused switcher is still on their team',
          bt2 ? `bravo team ${bt2.team}` : 'no trail');

    /* -- a join on even teams lets the joiner choose ------------------------- */
    /* Teams are 2/1. Charlie's click moves them to the other side, which the
     * rule allows (1/2), and that switch IS the choice the even-join got. */
    try {
      await charlie.focus();
      await charlie.openMenu();
      await charlie.clickButton('Blue team');
    } catch (e) { bad('charlie could click Blue team', e && e.message); }
    await waitLog(LOG, t => t.includes('setteam_accepted'), 10000);
    check(ev(LOG, 'setteam_accepted').length >= 1,
          'the joiner chose the other team and the server accepted it');
    await waitLog(LOG, t => (last(LOG, 'charlie') || { team: 0 }).team === 2, 15000);
    const ct2 = last(LOG, 'charlie');
    check(ct2 && ct2.team === 2, 'the chooser is now blue (1/2)',
          ct2 ? `charlie team ${ct2.team}` : 'no trail');

    return { clients, page };
  } finally {
    for (const c of clients) await c.stop();
    if (page) {
      try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {
        try { page.kill('SIGKILL'); } catch (e2) {}
      }
    }
    await sleep(300);
    await server.stop();
  }
}

/* -------------------------------------------------------------- the duel run */
async function duelPhase() {
  console.log('');
  console.log('the specials and friendly fire, on the duel fixture');

  const PORT = 20000 + ((process.pid + 500) % 16000), HTTP = PORT + 1;
  const server = new Server(PORT, LOG2, 'duel');
  const clients = [];
  phaseOf(clients);
  let page = null;
  try {
    if (!await server.start()) { bad('the duel server started'); return; }
    page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
      '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
    await sleep(1500);
    const url = (name) => 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=' + name + '&autojoin=1';

    /* alpha joins and stays at his spawn (the duel spawn faces +x, down the
     * hall at the other end). The CDP ports are offset from the lobby phase's,
     * so a browser from the phase just finished cannot be adopted by mistake. */
    let alpha = new Client('alpha', 10300 + (process.pid % 16000));
    clients.push(alpha);
    try { await alpha.start(url('alpha')); } catch (e) {
      bad('alpha joined the duel server', 'the browser never came up: ' + (e && e.message));
      return;
    }
    if (!await waitJoined(LOG2, 'alpha', 90000)) {
      bad('alpha joined the duel server'); return;
    }
    /* The lobby: alpha picks both, and the spawn follows. */
    if (!await alpha.waitMenuOpen()) {
      bad('the overlay opened itself for alpha on the duel server'); return;
    }
    try {
      await alpha.clickButton('Auto');
      await sleep(700);
      await alpha.clickButton('Soldier');
    } catch (e) { bad('alpha could pick Auto and Soldier', e && e.message); return; }
    if (!await waitLog(LOG2, statsRe('alpha', 'soldier'), 15000)) {
      bad('alpha spawned as a Soldier on the duel server'); return;
    }
    await alpha.focus();

    /* bravo joins, walks off his spawn point so it is free for the others, and
     * picks Medic -- the first pick applies at once, so bravo respawns onto his
     * own (now vacated) point. */
    let bravo = new Client('bravo', 10301 + (process.pid % 16000));
    clients.push(bravo);
    await bravo.start(url('bravo'));
    if (!await waitJoined(LOG2, 'bravo', 90000)) {
      bad('bravo joined the duel server'); return;
    }
    /* The lobby: bravo spawns first (Auto + Soldier), walks OFF the spawn
     * point so it is free for the others, and the Medic pick then respawns
     * him onto his own vacated spot -- the same choreography as before, with
     * the lobby's two picks in front of it. */
    if (!await bravo.waitMenuOpen()) {
      bad('the overlay opened itself for bravo on the duel server'); return;
    }
    await bravo.clickButton('Auto');
    await sleep(700);
    await bravo.clickButton('Soldier');
    if (!await waitLog(LOG2, statsRe('bravo', 'soldier'), 15000)) {
      bad('bravo spawned as a Soldier on the duel server (Auto + Soldier)'); return;
    }
    await bravo.focus();
    await bravo.hold('w', () => {
      const p = last(LOG2, 'bravo');
      return p && p.x < 300;
    });
    await bravo.openMenu();
    await bravo.clickButton('Medic');
    if (!await waitLog(LOG2, statsRe('bravo', 'medic'), 15000)) {
      bad('bravo picked Medic (a later pick applies at once)'); return;
    }
    const bs = raw(LOG2).split('\n').map(clean)
      .find(l => l.startsWith('QWTF_EVENT class_stats bravo class=medic'));
    check(/speed=352 /.test(bs) && /hp=90 /.test(bs) && /armour=100 /.test(bs),
          'Medic spawns with the design-table stats (speed 352, hp 90, armour 100, absorb 0.3)',
          bs);

    /* The Medic pick respawned bravo onto his own spawn point, and a joining
     * client's body is placed at connect (the lobby's spawn), which would
     * telefrag him there. Walk him off the point again before charlie joins. */
    await bravo.focus();
    await bravo.hold('w', () => {
      const p = last(LOG2, 'bravo');
      return p && p.x < 300;
    });

    /* charlie joins third: auto-placed red, and with alpha on his end's only
     * spot the spawn rule falls back to the other end, which bravo vacated. */
    let charlie = new Client('charlie', 10302 + (process.pid % 16000));
    clients.push(charlie);
    await charlie.start(url('charlie'));
    if (!await waitJoined(LOG2, 'charlie', 90000)) {
      bad('charlie joined the duel server'); return;
    }
    if (!await charlie.waitMenuOpen()) {
      bad('the overlay opened itself for charlie on the duel server'); return;
    }
    try {
      await charlie.clickButton('Auto');
      await sleep(700);
      await charlie.clickButton('Soldier');
    } catch (e) { bad('charlie could pick Auto and Soldier', e && e.message); return; }
    if (!await waitLog(LOG2, statsRe('charlie', 'soldier'), 15000)) {
      bad('charlie spawned as a Soldier on the duel server (Auto + Soldier)'); return;
    }
    await charlie.focus();

    /* -- the meeting: alpha's SSG hurts bravo, bravo's medkit hurts alpha ---- */
    const ahp0 = last(LOG2, 'alpha').health;
    const bhp0 = last(LOG2, 'bravo').health;
    /* alpha fires until the medkit connects -- the stop is the event, not a
     * timer, so the duel's two-spawn telefrag cascade (bravo dying and
     * respawning onto an occupied spot) never starts. */
    alpha.hold('ControlLeft', () =>
      ev(LOG2, 'medkit_hit').some(l => l.includes('alpha')), 15000).catch(() => {});
    await bravo.hold('w', () => {
      const p = last(LOG2, 'bravo');
      return (p && p.x < 200) || ev(LOG2, 'medkit_hit').some(l => l.includes('alpha'));
    }, 20000);
    /* Keep swinging for a moment, then stop both. */
    await bravo.keyDown('ControlLeft');
    await sleep(3500);
    await bravo.keyUp('ControlLeft');
    await alpha.keyUp('ControlLeft');
    const medhit = ev(LOG2, 'medkit_hit').some(l => l.includes('alpha'));
    check(medhit, 'the medkit hit the enemy (bravo -> alpha)');
    const ahp1 = last(LOG2, 'alpha').health;
    check(ahp1 < ahp0, `the medkit hurt over time (alpha health ${ahp0} -> ${ahp1})`,
          'poison ticks never moved alpha\'s health');
    const poison = ev(LOG2, 'poison_tick');
    check(poison.length >= 2, `the poison ticked over time (${poison.length} ticks)`);
    const bhp1 = last(LOG2, 'bravo').health;
    check(bhp1 < bhp0,
          `the meeting proves alpha's gun fires (bravo health ${bhp0} -> ${bhp1})`,
          'alpha did no damage to an enemy, so the friendly-fire check below would be vacuous');

    /* -- friendly fire is off: alpha shoots charlie, a teammate -------------- */
    await charlie.hold('w', () => {
      const p = last(LOG2, 'charlie');
      return p && p.x < 380;
    }, 10000);
    const chp0 = last(LOG2, 'charlie').health;
    alpha.keyDown('ControlLeft').catch(() => {});
    await sleep(3000);
    alpha.keyUp('ControlLeft').catch(() => {});
    const chp1 = last(LOG2, 'charlie').health;
    check(chp1 === chp0,
          `friendly fire is off (alpha shot teammate charlie for ${chp0} -> ${chp1})`,
          'the gun provably fired (bravo check above); a teammate took nothing');

    /* -- charlie picks Demolitions, then switches to blue --------------------- */
    await charlie.openMenu();
    await charlie.clickButton('Demolitions');
    if (!await waitLog(LOG2, statsRe('charlie', 'demolitions'), 15000)) {
      bad('charlie picked Demolitions (a later pick applies at once)'); return;
    }
    const cs = raw(LOG2).split('\n').map(clean)
      .find(l => l.startsWith('QWTF_EVENT class_stats charlie class=demolitions'));
    check(/speed=288 /.test(cs) && /hp=90 /.test(cs) && /armour=120 /.test(cs) &&
          /g2=1 /.test(cs),
          'Demolitions spawns with the design-table stats (speed 288, hp 90, armour 120, charge stock 1)',
          cs);

    await charlie.openMenu();
    await charlie.clickButton('Blue team');
    await waitLog(LOG2, t => t.includes('setteam_accepted'), 10000);
    await waitLog(LOG2, t => (last(LOG2, 'charlie') || { team: 0 }).team === 2, 15000);
    const ct = last(LOG2, 'charlie');
    check(ct && ct.team === 2, 'charlie switched to blue and respawned there',
          ct ? `charlie team ${ct.team}` : 'no trail');

    /* -- the medic heals a wounded teammate ----------------------------------- */
    /* bravo walks back toward the middle and stops facing -x (the duel spawn
     * angle). charlie walks -x from the far end; alpha fires down the hall at
     * them (they are enemies now, so the wound is real), and charlie stops just
     * past bravo, inside the medkit's 64. */
    await bravo.hold('w', () => {
      const p = last(LOG2, 'bravo');
      return p && p.x < 300;
    }, 10000);
    bravo.hold('w', () => {
      const p = last(LOG2, 'bravo');
      return p && p.x < 260;
    }, 8000).catch(() => {});
    /* creeps charlie up the hall in small bursts; alpha fires meanwhile */
    alpha.keyDown('ControlLeft').catch(() => {});
    let wounded = false;
    for (let i = 0; i < 40; i++) {
      const p = last(LOG2, 'charlie'), b = last(LOG2, 'bravo');
      if (!p || !b) { await sleep(300); continue; }
      const healed = ev(LOG2, 'medkit_heal').some(l => l.includes('charlie'));
      if (healed) break;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (p.x < b.x && d < 60) break;          // inside the medkit window
      await charlie.nudge('w', 200);
      await sleep(250);
      const p2 = last(LOG2, 'charlie');
      if (p2 && p2.health < p.health) wounded = true;
    }
    alpha.keyUp('ControlLeft').catch(() => {});
    const chp2 = last(LOG2, 'charlie').health;
    bravo.keyDown('ControlLeft').catch(() => {});
    await waitLog(LOG2, t => ev(LOG2, 'medkit_heal').some(l => l.includes('charlie')), 10000);
    await bravo.keyUp('ControlLeft').catch(() => {});
    const heal = ev(LOG2, 'medkit_heal').some(l => l.includes('charlie'));
    check(heal, 'the medkit healed the teammate (bravo -> charlie)');
    check(wounded, 'alpha wounded charlie on the way (enemy damage again)');
    const chp3 = last(LOG2, 'charlie').health;
    check(chp3 > chp2, `the heal moved health (charlie ${chp2} -> ${chp3})`,
          'medkit_heal fired but the patient was already at full health');

    /* -- sticky charges: fire two, walk to them, detonate on command ---------- */
    const chp4 = last(LOG2, 'charlie').health;
    await charlie.tap('v');                       // launcher mode: sticky
    await charlie.nudge('ControlLeft', 120);       // fire charge 1
    await sleep(900);
    await charlie.nudge('ControlLeft', 120);       // fire charge 2
    await sleep(900);
    const fired = ev(LOG2, 'sticky_fired').length;
    check(fired >= 2, `two sticky charges fired (${fired})`);
    /* walk toward the charges for about a second */
    {
      const end = Date.now() + 1000;
      await charlie.keyDown('w');
      while (Date.now() < end) { await sleep(200); await charlie.keyDown('w'); }
      await charlie.keyUp('w');
    }
    await charlie.tap('b');                       // detonate on command
    await sleep(800);
    const det = raw(LOG2).split('\n').map(clean)
      .find(l => l.startsWith('QWTF_EVENT sticky_detonate'));
    check(det && det.includes(' n=2'),
          `the detonate command popped the batch (${det ? det.slice(11, 44) : 'none'})`);
    const chp5 = last(LOG2, 'charlie').health;
    check(chp5 < chp4,
          `the demolition player took the burst (self-damage: ${chp4} -> ${chp5})`,
          'standing in your own sticky burst cost nothing at all');

    /* -- the timed demolition charge: a 5 s fuse ------------------------------ */
    await charlie.tap('f');
    const thrown = Date.now();
    const boom = await waitLog(LOG2, t => t.includes('QWTF_EVENT charge_boom'), 12000);
    const dt = (Date.now() - thrown) / 1000;
    check(boom && dt >= 4 && dt <= 7.5,
          `the demolition charge blew on its 5 s fuse (${dt.toFixed(1)} s)`,
          boom ? 'charge_boom came but at the wrong time' : 'no charge_boom within 12 s');

    /* -- the medic's concussion: knockback, no damage -------------------------- */
    const before = { alpha: last(LOG2, 'alpha'), bravo: last(LOG2, 'bravo'),
                     charlie: last(LOG2, 'charlie') };
    await bravo.tap('g');                          // medic grenade 1: concussion
    await waitLog(LOG2, t => t.includes('QWTF_EVENT conc_burst'), 8000);
    check(ev(LOG2, 'conc_burst').length >= 1, 'the concussion burst ran');
    await sleep(1500);
    const knocked = ['alpha', 'bravo', 'charlie'].filter(nm => {
      const p = last(LOG2, nm), b4 = before[nm];
      return p && b4 && Math.hypot(p.x - b4.x, p.y - b4.y, p.z - b4.z) > 24;
    });
    check(knocked.length >= 1,
          `the burst knocked someone back (${knocked.join(', ') || 'nobody'})`,
          'the concussion ran but no player within the burst moved');

    /* -- the soldier's own grenades ------------------------------------------- */
    await alpha.tap('g');
    await waitLog(LOG2, t => t.includes('QWTF_EVENT grenade_boom'), 8000);
    check(ev(LOG2, 'grenade_boom').length >= 1,
          'the hand grenade pops (soldier grenade 1)');
    await alpha.tap('f');
    await waitLog(LOG2, t => t.includes('QWTF_EVENT nail_spray'), 8000);
    check(ev(LOG2, 'nail_spray').length >= 1,
          'the nail grenade sprays (soldier grenade 2)');

    await alpha.screenshot(path.join(SHOTS, '02-duel-end.png'));
  } catch (e) {
    bad('the duel phase ran', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    for (const c of clients) await c.stop();
    if (page) {
      try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {
        try { page.kill('SIGKILL'); } catch (e2) {}
      }
    }
    await sleep(300);
    await server.stop();
  }
}

/* ---------------------------------------------------------------------- main */
async function main() {
  const only = process.argv.slice(2).filter(a => a.startsWith('--'));
  const want = (f) => only.length === 0 || only.includes(f);
  for (const a of only) {
    if (a !== '--lobby-only' && a !== '--duel-only') {
      console.error('unknown flag: ' + a); process.exit(2);
    }
  }
  fs.mkdirSync(DIR, { recursive: true });
  stage();
  console.log('== static checks ==');
  staticChecks();

  if (want('--lobby-only')) {
    console.log('');
    console.log('== lobby phase (forts) ==');
    await lobbyPhase();
  }
  if (want('--duel-only')) {
    console.log('');
    console.log('== specials phase (duel) ==');
    await duelPhase();
  }

  console.log('');
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log, duel.log)`);
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? `FAIL: ${failed} of ${passed + failed} checks`
                      : `PASS: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('Error:', e && e.stack); process.exit(1); });