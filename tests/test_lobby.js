#!/usr/bin/env node
/*
 * tests/test_lobby.js -- the join lobby (owner, 2026-10-09: "it loads me in,
 * but should wait for me to select a team, a class and then spawn me in"), and
 * the menu's picks actually taking effect ("I select and the weapon doesn't
 * change, I hit reconnect and it either does, or just bombs out and
 * disconnects").
 *
 *   node tests/test_lobby.js
 *
 * Everything is driven against a REAL server through a REAL browser client,
 * and read out of the server's own stdout (QWTF_EVENT, QWTFPOS, QWTFHURT) and
 * the page's own console (the QWTF_YOU line the lobby sprints the menu) --
 * never through a test hook on the rules.
 *
 * What is proven, and the old behaviour it fails on:
 *
 *   the lobby wait     a human who connects is an observer: no team, no
 *                      class, takes no damage, takes no key (fails on the old
 *                      code, which spawned a Soldier at the join and assigned
 *                      a team on the first PreThink)
 *   the picks          a first qwtf_setteam of red or blue HONOURS the pick
 *                      (the old code auto-placed and ignored it); the spawn
 *                      comes only with the second pick, with a lobby_spawn
 *                      event naming team and class
 *   immediate class    a live Soldier who sends qwtf_setclass sniper is a
 *                      Sniper within 1 s (the old code recorded it as pending
 *                      for a respawn the player never saw)
 *   the controls       the same hurt hook and the same key teleport that do
 *                      nothing to the observer demonstrably hurt and take for
 *                      a spawned player, so the observer checks cannot be
 *                      passing because the hooks do nothing at all
 *   the menu protocol  the page's console carries QWTF_YOU team=.. class=..,
 *                      which is what web/menu.js opens and closes on
 *   the bots           qwtf/bots.qc keeps joining its own bots (bot_join)
 *
 * Infrastructure (stage, server, headless Chrome client, log readers) is the
 * same machinery tests/test_classes.js runs; it is duplicated here because
 * those files are standalone scripts by convention, not a library.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const WEB = path.join(ROOT, 'web');
const RUN = path.join(ART, 'run-lobby-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const LOG = path.join(RUN, 'server.log');
const RUN_STARTED = Date.now();

let failed = 0, passed = 0;
let LIVE = [];
function phaseOf(clients) { LIVE = clients; }
function ok(what) { console.log(`  ok   ${what}`); passed++; }
function bad(what, detail) {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  diag();
  failed++;
}
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
    if (e === 'id1') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  }
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    if (e === 'maps') continue;
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
  fs.mkdirSync(path.join(STAGE, 'id1', 'maps'));
  for (const e of fs.readdirSync(path.join(WEB, 'id1', 'maps'))) {
    fs.symlinkSync(path.join(WEB, 'id1', 'maps', e), path.join(STAGE, 'id1', 'maps', e));
  }
}

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

/* The map's own midpoint and the deep-water box, from the generator and the
 * map file -- never typed in (tests/drown.js's rule). */
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
const ev = (f, what) => raw(f).split('\n').map(clean)
  .filter(l => l.startsWith('QWTF_EVENT ' + what + ' ') || l === 'QWTF_EVENT ' + what);
const countEvent = (f, what) => ev(f, what).length;

/* QWTFPOS [name] x y z yaw health waterlevel team ... */
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

/* The keys' home positions, read from the server's own map-load trail:
 * "QWTF_KEY <team> at <x> <y> <z>" (qwtf/ctf.qc, developer 1). */
function keyHome(f, team) {
  const lines = raw(f).split('\n').map(clean);
  for (const l of lines) {
    const m = /^QWTFPROBE QWTF_KEY (\S+) at (\S+) (\S+) (\S+)$/.exec(l);
    if (m && parseFloat(m[1]) === team)
      return { x: parseFloat(m[2]), y: parseFloat(m[3]), z: parseFloat(m[4]) };
  }
  return null;
}

/* ----------------------------------------------------------------- the server */
class Server {
  constructor(port, log, map) { this.port = port; this.log = log; this.map = map; }

  async start() {
    this.out = fs.openSync(this.log, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', STAGE,
      '--demo-subdir', 'demos',
      '--map', this.map,
      '+set', 'qwtf_bots', '1',
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

  /* The probe's test hooks (qwtf/probe.qc, server console only): a one-shot
   * teleport and a one-shot T_Damage. Both are what a headless client cannot
   * do for itself, and both are the controls the lobby checks lean on. */
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
  /* The probe's server-side heading (0 looks along +x). */
  face(yaw) { this.command(`serverinfo qwtf_face ${yaw.toFixed(2)}`); }
  faceNone() { this.command('serverinfo qwtf_face ""'); }

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
    this.chromeLog = path.join(RUN, 'chrome-' + this.name + '.log');
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
    /* Record the server's lobby lines in the page, before any page script
     * runs: web/menu.js reads the same console stream, and this is the test's
     * own independent record of what arrived. */
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__qwtf_you = [];
      (function () {
        const orig = console.log;
        console.log = function (...a) {
          try {
            const s = a.map(x => typeof x === 'string' ? x : String(x.value !== undefined ? x.value : x)).join(' ');
            if (s.indexOf('QWTF_YOU') === 0 || s.indexOf('QWTF_WHO') === 0) window.__qwtf_you.push(s);
          } catch (e) {}
          return orig.apply(console, a);
        };
      })();` });
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

  async keyDown(key) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'rawKeyDown', key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
        windowsVirtualKeyCode: VK[key] || 0, nativeVirtualKeyCode: VK[key] || 0 });
  }
  async keyUp(key) {
    await this.send('Input.dispatchKeyEvent',
      { type: 'keyUp', key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
        windowsVirtualKeyCode: VK[key] || 0, nativeVirtualKeyCode: VK[key] || 0 });
  }

  /* Hold a key, re-asserting the keydown (FTE latches movement on the
   * transition), until `until` says stop or the deadline passes. */
  async hold(key, until, ms) {
    const end = Date.now() + (ms || 10000);
    await this.keyDown(key);
    while (Date.now() < end && !until()) {
      await sleep(200);
      await this.keyDown(key);
    }
    await this.keyUp(key);
  }

  async focus() {
    await this.send('Page.bringToFront').catch(() => {});
    const r = await this.eval(`(() => { const c = document.getElementById('canvas');
      if (!c) return null; const b = c.getBoundingClientRect();
      return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
    if (!r) throw new Error(`${this.name}: no canvas on the page`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent',
        { type, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    }
    return r;
  }

  /* The overlay a player uses, opened only if it is not already open: the
   * lobby auto-opens it on join, and a blind ESC toggle would close it. */
  async ensureMenu() {
    let open = false;
    for (let i = 0; i < 25 && !open; i++) {
      try { open = await this.eval('window.QWTF_MENU.isOpen()'); } catch (e) { open = false; }
      if (open) break;
      await this.send('Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(120);
      await this.send('Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(300);
      try { open = await this.eval('window.QWTF_MENU.isOpen()'); } catch (e) { open = false; }
      if (open) break;
      await sleep(200);
    }
    if (!open) throw new Error(`${this.name}: the overlay never opened`);
  }

  /* What the page's console says: the QWTF_YOU / QWTF_WHO lines the lobby
   * sprints, recorded by the page itself. */
  async youLines() {
    return this.eval('(window.__qwtf_you || [])')
      .catch(() => null);
  }

  /* A pick through the real overlay: the same entry point a button click
   * runs (QWTF_MENU.do), which is the same sendReliable path with the same
   * retry belt. Returns the command it sent. */
  async pick(action) {
    await this.ensureMenu();
    return this.eval(`window.QWTF_MENU.do(${JSON.stringify(action)})`);
  }

  async stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    try { if (this.chromeOut) fs.closeSync(this.chromeOut); } catch (e) {}
    await sleep(400);
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

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
    await sleep(200);
  }
  return false;
}
const statsRe = (name, cls) =>
  (text) => String(text).split('\n').some(l => l.includes(`QWTF_EVENT class_stats ${name} class=${cls}`));

/* ---------------------------------------------------------- the static checks */
function staticChecks() {
  console.log('== static checks');
  const build = fs.readFileSync(path.join(ROOT, 'scripts/build_progs.sh'), 'utf8');
  const lines = build.split('\n').filter(l => l.includes('print "qwtf/'));
  check(lines.length === 2 && lines.every(l => l.includes('qwtf/lobby.qc')),
        'qwtf/lobby.qc is on BOTH include lines in scripts/build_progs.sh',
        `include lines with lobby.qc: ${lines.filter(l => l.includes('lobby.qc')).length} of ${lines.length}`);

  const cls = fs.readFileSync(path.join(ROOT, 'qwtf/classes.qc'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  check(!cls.includes('applies at your next respawn'),
        'the setclass handler no longer parks a pick on an unseen respawn');
  check(!cls.includes('setclass_pending'),
        'the setclass handler no longer records a pending pick');

  const menu = fs.readFileSync(path.join(ROOT, 'web/menu.js'), 'utf8');
  const m = require(path.join(ROOT, 'web/menu.js'));
  const reconnect = Object.values(m.ACTIONS).filter(a => a.command === 'reconnect');
  check(reconnect.length === 0 && !/['"]reconnect['"]/.test(menu),
        'the overlay has no Reconnect entry (the old one dropped the web client to the console)');
}

/* ------------------------------------------------------------------ the phase */
async function lobbyPhase() {
  console.log('');
  console.log('== the lobby, on forts, against a real server');

  const PORT = 20500 + (process.pid % 16000), HTTP = PORT + 1;
  const server = new Server(PORT, LOG, 'forts');
  const clients = [];
  phaseOf(clients);
  let page = null;
  try {
    if (!await server.start()) { bad('the server started'); return; }
    page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
      '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
    await sleep(1500);
    const url = (name) => 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=' + name + '&autojoin=1';

    /* -- a fresh client waits in the lobby --------------------------------- */
    let alpha = new Client('alpha', 11000 + (process.pid % 16000));
    clients.push(alpha);
    const t0 = Date.now();
    try { await alpha.start(url('alpha')); } catch (e) {
      bad('the first browser loaded the page', e && e.message); return;
    }
    if (!await waitJoined(LOG, 'alpha', 90000)) {
      bad('alpha joined the server', 'no "alpha joined" in the server log after 90 s');
      return;
    }
    const joinedAt = Date.now();

    const waited = await waitLog(LOG, t => t.includes('QWTF_EVENT lobby_wait alpha'), 20000);
    check(waited, 'a human who connects enters the lobby (QWTF_EVENT lobby_wait)');

    /* 8 s of waiting: the old code spawned a Soldier at the join and assigned a
     * team on the first PreThink -- both of those would show here. */
    await sleep(8000);
    const statsLines = raw(LOG).split('\n').map(clean)
      .filter(l => l.startsWith('QWTF_EVENT class_stats alpha'));
    check(statsLines.length === 0,
          'a waiter is not spawned as a player (no class_stats line in 8 s)',
          statsLines.length ? statsLines[0] : null);
    check(countEvent(LOG, 'lobby_spawn') === 0,
          'no lobby_spawn while the picks are missing');

    const tr = trail(LOG, 'alpha');
    const early = tr.filter(s => s.t <= 5);
    check(early.length > 0 && early.every(s => s.team === 0),
          `a waiter has no team on the probe trail (${early.length} samples in 5 s, team 0 on all)`,
          early.length ? `teams seen: ${[...new Set(early.map(s => s.team))].join(',')}` : 'no trail at all');

    /* -- the observer takes no damage ---------------------------------------
     * The probe's hurt hook is a real T_Damage, the same path a rocket takes.
     * On the old code alpha was a spawned Soldier and this hurt landed; on the
     * lobby it must not. The control below (a spawned player, same hook) keeps
     * this from passing because the hook is broken. */
    const hpBefore = last(LOG, 'alpha');
    server.hurt(1, 50);
    await sleep(3000);
    const hpAfter = last(LOG, 'alpha');
    check(hpBefore && hpAfter && hpAfter.health === hpBefore.health && hpAfter.health > 0,
          `a waiter takes no damage (hurt hook fired: health ${hpBefore ? hpBefore.health : '?'} -> ` +
          `${hpAfter ? hpAfter.health : '?'})`,
          'the hurt hook did not move the waiter\'s health');

    /* -- the observer cannot take a key --------------------------------------
     * Teleport onto the ENEMY (blue) key with the probe's goto hook: a spawned
     * player walks the same overlap the touch fires on, so the control below
     * proves the teleport really does fire key touches. The waiter's team is
     * 0, which ctf.qc would answer with take_refused_no_team if the lobby let
     * the touch through at all -- neither event may fire. */
    const blueKey = keyHome(LOG, 2);
    check(!!blueKey, 'the blue key\'s home position was read from the map-load trail',
          blueKey ? null : 'no QWTF_KEY 2 line in the server log');
    if (blueKey) {
      /* FTE checks touches during a player's MOVE, not on a setorigin
       * (tests/ctf_rules.js measured this), so the observer WALKS the last
       * step: teleport to 96 short of the key, face it with the probe's
       * server-side heading, and hold W. A noclip observer flies the 96
       * units in a third of a second, and the overlap fires the key's touch
       * -- which the lobby must refuse. */
      server.goto(blueKey.x - 96, blueKey.y, blueKey.z + 24, 1);
      server.face(0);                       // the key is due +x of the spot
      await alpha.focus();
      await alpha.hold('w', () => {
        const p = last(LOG, 'alpha');
        return p && p.x >= blueKey.x - 48;
      }, 8000);
      server.faceNone();
      await sleep(1500);
      /* The fly is stopped on a poll, so the waiter may be PAST the key by a
       * body length; what must hold is that its path crossed the key's y
       * line at the key's x (the trail is the evidence). */
      const crossed = trail(LOG, 'alpha').some(s =>
        s.x >= blueKey.x - 16 && Math.abs(s.y - blueKey.y) < 64);
      const at = last(LOG, 'alpha');
      check(crossed, `the waiter moved through the blue key (trail crossed x=${blueKey.x.toFixed(0)} ` +
            `at y ${blueKey.y.toFixed(0)}; now at ` +
            `${at ? at.x.toFixed(0) + ',' + at.y.toFixed(0) : '?'})`,
            'the goto/steer did not bring the waiter to the key, so the ' +
            'refusal check below would be vacuous');
      /* A spawned body's take is the control, and the key is still at home:
       * the observer's touch was refused before ctf.qc could even count it.
       * Teleport the spawned bots ONTO the key -- FTE fires a touch on the
       * mover's next move, and a bot is always moving -- and one of them
       * takes it from under the same ceiling the waiter stood under. */
      server.goto(blueKey.x, blueKey.y, blueKey.z + 24, 2);
      const botTook = await waitLog(LOG, t => t.includes('QWTF_EVENT take Bot'), 8000);
      const botTake = ev(LOG, 'take').filter(l => l.includes('Bot '));
      check(botTook,
            `a spawned body on the same spot DID take (control: ${botTake[0] || 'no take at all'})`,
            'without this, "the waiter took nothing" could mean the touch never fired');
      const taken = ev(LOG, 'take').filter(l => l.includes('alpha'));
      const refused = ev(LOG, 'take_refused_no_team').filter(l => l.includes('alpha'));
      check(taken.length === 0 && refused.length === 0,
            'the waiter touching the enemy key takes nothing (no take, no refused event)',
            `alpha: ${taken.concat(refused).join(' | ') || 'none'}`);
    }

    /* -- the first pick is honoured: red, not auto-place ---------------------- */
    const redCmd = await alpha.pick('team_red');
    const redAccepted = await waitLog(LOG, t => t.includes('QWTF_EVENT setteam_accepted alpha'), 10000);
    check(redAccepted, `the first team pick is honoured by the server (sent ${JSON.stringify(redCmd)})`,
          'no setteam_accepted within 10 s');
    await waitLog(LOG, t => (last(LOG, 'alpha') || { team: 0 }).team === 1, 10000);
    const at1 = last(LOG, 'alpha');
    check(at1 && at1.team === 1, `the pick put the waiter on red (trail team ${at1 ? at1.team : '?'})`,
          'the old code ignored a first red pick and auto-placed');
    check(countEvent(LOG, 'class_stats alpha') === 0 && countEvent(LOG, 'lobby_spawn') === 0,
          'one pick is still not a spawn (no class_stats, no lobby_spawn)');

    const you1 = await alpha.youLines();
    const youOk = (Array.isArray(you1) ? you1 : []).some(l => {
      const m = /^QWTF_YOU team=([\d.]+) class=([\d.]+)/.exec(l);
      return m && Math.round(+m[1]) === 1 && Math.round(+m[2]) === 0;
    });
    check(youOk,
          `the page's console carries the lobby state the menu reads (${you1 ? you1.slice(-2).join(' | ') : 'none'})`,
          'web/menu.js opens and closes on these QWTF_YOU lines');

    /* -- the second pick spawns the player ------------------------------------ */
    await alpha.pick('cls_soldier');
    const spawned = await waitLog(LOG,
      t => t.includes('QWTF_EVENT lobby_spawn alpha team=1 class=3'), 12000);
    check(spawned, 'the second pick spawns the waiter (QWTF_EVENT lobby_spawn alpha team=1 class=3)');
    const sol = await waitLog(LOG, statsRe('alpha', 'soldier'), 12000);
    check(sol, 'the lobby spawn carries the class (class_stats alpha class=soldier)');
    await waitLog(LOG, t => { const p = last(LOG, 'alpha'); return p && p.health > 0 && p.team === 1; }, 10000);
    const mid = fortsMidX();
    const al = last(LOG, 'alpha');
    check(al && al.health > 0 && al.team === 1,
          `the spawned player is alive on red (health ${al ? al.health : '?'}, team ${al ? al.team : '?'})`);
    check(mid !== null && al && al.x < mid,
          `and spawned on red's own half (x ${al ? al.x.toFixed(0) : '?'} < mid ${mid === null ? '?' : mid.toFixed(0)})`);

    /* -- the controls: the same hooks DO work on a spawned player -------------- */
    const hp0 = last(LOG, 'alpha').health;
    server.hurt(2, 50);
    await waitLog(LOG, t => { const p = last(LOG, 'alpha'); return p && p.health < hp0; }, 8000);
    const hp1 = last(LOG, 'alpha').health;
    check(hp1 < hp0, `the hurt hook hurts a spawned player (${hp0} -> ${hp1})`,
          'the observer\'s no-damage check above is only meaningful against a working hook');

    /* -- a live Soldier becomes a Sniper within 1 s ---------------------------- */
    await alpha.ensureMenu();
    const clicked = Date.now();
    await alpha.eval('window.QWTF_MENU.do("cls_sniper")');
    let sniperAt = null;
    {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          if (raw(LOG).split('\n').some(l => l.includes('QWTF_EVENT class_stats alpha class=sniper'))) {
            sniperAt = Date.now(); break;
          }
        } catch (e) {}
        await sleep(100);
      }
    }
    const dt = sniperAt ? (sniperAt - clicked) / 1000 : null;
    check(sniperAt && dt <= 1.0,
          `a live Soldier who sends qwtf_setclass sniper is a Sniper in ${dt === null ? 'never' : dt.toFixed(2) + ' s'} (<= 1 s)`,
          'the old code recorded the pick as pending for a respawn that never came');

    /* -- a second client: blue honoured first, spawned second ------------------- */
    let bravo = new Client('bravo', 11001 + (process.pid % 16000));
    clients.push(bravo);
    try { await bravo.start(url('bravo')); } catch (e) {
      bad('the second browser joined', e && e.message); return;
    }
    if (!await waitJoined(LOG, 'bravo', 90000)) {
      bad('bravo joined the server', 'no "bravo joined"'); return;
    }
    await waitLog(LOG, t => t.includes('QWTF_EVENT lobby_wait bravo'), 20000);
    await bravo.pick('team_blue');
    await waitLog(LOG, t => (last(LOG, 'bravo') || { team: 0 }).team === 2, 10000);
    const bt = last(LOG, 'bravo');
    check(bt && bt.team === 2,
          `a fresh client's first pick of blue puts them on blue (trail team ${bt ? bt.team : '?'})`);
    check(countEvent(LOG, 'class_stats bravo') === 0,
          'and they are still waiting, not spawned (no class_stats bravo)');
    await bravo.pick('cls_scout');
    const bspawn = await waitLog(LOG,
      t => t.includes('QWTF_EVENT lobby_spawn bravo team=2 class=1'), 12000);
    check(bspawn, 'bravo\'s second pick spawns them (lobby_spawn bravo team=2 class=1)');
    await waitLog(LOG, t => { const p = last(LOG, 'bravo'); return p && p.team === 2 && p.health > 0; }, 10000);
    const bl = last(LOG, 'bravo');
    check(mid !== null && bl && bl.team === 2 && bl.health > 0 && bl.x > mid,
          `bravo spawned alive on blue's own half (x ${bl ? bl.x.toFixed(0) : '?'} > mid ` +
          `${mid === null ? '?' : mid.toFixed(0)})`);

    /* -- the bots are untouched ------------------------------------------------- */
    const joins = countEvent(LOG, 'bot_join');
    check(joins >= 2, `the bots still join on their own (${joins} bot_join events)`,
          'the lobby must never hold a bot');
    const botStats = raw(LOG).split('\n').map(clean)
      .filter(l => l.startsWith('QWTF_EVENT class_stats Bot '));
    check(botStats.length >= 2, `the bots still spawn dressed (${botStats.length} class_stats lines)`,
          botStats.length ? null : 'no class_stats for any Bot');
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

async function main() {
  fs.mkdirSync(RUN, { recursive: true });
  stage();
  staticChecks();
  await lobbyPhase();
  console.log('');
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log)`);
  console.log(failed ? `FAIL: ${failed} of ${passed + failed} checks`
                      : `PASS: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('Error:', e && e.stack); process.exit(1); });
