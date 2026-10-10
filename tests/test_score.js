#!/usr/bin/env node
/*
 * tests/test_score.js -- the team score: one score per team, announced to
 * everyone, published for a HUD, and +10 frags for the capturer.
 *
 *   node tests/test_score.js
 *
 * THE BUG IT IS ABOUT (owner, playtest 2026-10-09): "there is no indicator that
 * a key was turned in other than the sound. No score increment was done." The
 * old code kept `.float team_score_red` / `.float team_score_blue` as FIELDS on
 * the capturing player's entity -- each player had a private score nobody else
 * added to, nothing displayed it, and the tests only read the QWTF_EVENT line.
 *
 * What is proven, and where each half is observed:
 *
 *   the score           the server's own QWTF_EVENT capture_score trail: one
 *                       point per capture, red and blue kept separately.
 *   the capturer's +10  the frag column of the server's own `status` table --
 *                       the same number the engine's Tab scoreboard reads.
 *   the serverinfo      `serverinfo` on the server console prints the info
 *                       buffer; score_red/score_blue must be in it, because
 *                       that is what a later HUD reads.
 *   the announcement    BOTH clients, live in the same server, must receive
 *                       the capture centerprint and the bprint line that ends
 *                       with the score. Each client is read through its own
 *                       page console (CDP): bprints arrive as svc_print and
 *                       FTE echoes them to console.log; centerprints are
 *                       echoed by an f_centerprint alias the test installs
 *                       client-side, which FTE runs on every centerprint with
 *                       the text in scr_centerprinttext. No rule code changes
 *                       for any of this: the alias only echoes what the
 *                       client already received.
 *   the key events      take/drop/return announce to everyone too, worded
 *                       from the viewer's side: the OTHER team's client must
 *                       see "Your key has been taken!" and "Your key is back
 *                       home".
 *
 * Choreography: the probe's qwtf_gx teleport hook is GLOBAL (one serverinfo key
 * moves every player at once), so two clients cannot be teleported apart with
 * it. This test teleports each client with the engine's own per-player `setpos`
 * client command instead, which needs `sv_cheats 1` on the test server: a
 * test-only switch, like qwtf_trace. setpos leaves the player NOCLIP, so each
 * move is followed by `noclip` to hand walking back.
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
const LOG = path.join(DIR, 'server.log');
const RUN_STARTED = Date.now();

let failed = 0, passed = 0;
let LIVE = [];                      // live clients, for diag() on a red check
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
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
}

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

/* The map's geometry, from gen_map (ctf_rules.js's rule: never type what the
 * map can say). World units. */
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
  '    "vault_floor": g.sc(g.FORTS_VAULT_Z),',
  '    "mid_x": g.sc(g.FORTS_LEN / 2.0),',
  '    "scale": g.FORTS_SCALE,',
  '}))',
].join('\n');
function vaultGeometry() {
  const r = spawnSync('python3', ['-c', GEO_PY], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; }
}

/* ------------------------------------------------------------------- the log */
const raw = () => fs.readFileSync(LOG, 'utf8');
function logIsFromThisRun() {
  try {
    const st = fs.statSync(LOG);
    return st.size > 0 && st.mtimeMs >= RUN_STARTED;
  } catch (e) { return false; }
}
/* Exact-match an event line ("take" must not count "take_refused_*"). */
const ev = (what) => raw().split('\n').map(clean)
  .filter(l => l.startsWith('QWTF_EVENT ' + what + ' ') || l === 'QWTF_EVENT ' + what);
const probe = (what) => raw().split('\n').map(clean).filter(l => l.includes(what));

/* QWTFPOS [name] x y z yaw health waterlevel team carry caps red blue weapon
 * ammo armour time -- per player, 4 Hz. team and carry are what the rounds
 * assert on. */
function lastPosNamed(text, name) {
  const l = text.split('\n').map(clean).filter(x => x.indexOf(`QWTFPOS [${name}]`) >= 0).pop();
  if (!l) return null;
  const m = l.match(/QWTFPOS \[([^\]]*)\] (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+)/);
  return m ? { x: +m[2], y: +m[3], z: +m[4], yaw: +m[5], health: +m[6],
               water: +m[7], team: +m[8], carry: m[9] } : null;
}
function posOf(name) { return lastPosNamed(raw(), name); }

/* The whole 4 Hz trail for one name, from the server's own log. The walk
 * checks straddle a key's x by reading this, because the walk's STOP is a
 * wall and the take happens mid-stride -- the event, not the endpoint, is the
 * proof (ctf_rules.js's lesson). */
function trailOf(name) {
  const out = [];
  for (const l of raw().split('\n').map(clean)) {
    const m = l.match(/QWTFPOS \[([^\]]*)\] (\S+) (\S+) (\S+) (\S+) (\S+)/);
    if (m && m[1] === name) out.push({ x: +m[2], y: +m[3], z: +m[4], health: +m[6] });
  }
  return out;
}
/* Did the samples after `from` cross keyX at vault-floor height? */
function straddled(name, keyX, from, floorZ) {
  const pts = trailOf(name).slice(from);
  const onFloor = pts.filter(p => Math.abs(p.z - floorZ) < 48);
  if (!onFloor.length) return false;
  return Math.min(...onFloor.map(p => p.x)) <= keyX &&
         Math.max(...onFloor.map(p => p.x)) >= keyX;
}

async function untilLog(pred, ms) {
  const until = Date.now() + (ms || 12000);
  while (Date.now() < until) {
    if (pred(raw())) return true;
    await sleep(250);
  }
  return pred(raw());
}
/* Poll for the n-th event, so a late flush is not a false red. */
async function awaitEv(what, want, ms) {
  const until = Date.now() + (ms || 8000);
  while (Date.now() < until) {
    if (ev(what).length >= want) return ev(what).length;
    await sleep(250);
  }
  return ev(what).length;
}
/* Poll until a client's own page console matches re (CDP side). */
function clientSaid(client, re) { return client.logs.some(l => re.test(l)); }
async function awaitClientSaid(client, re, ms) {
  const until = Date.now() + (ms || 12000);
  while (Date.now() < until) {
    if (clientSaid(client, re)) return true;
    await sleep(250);
  }
  return clientSaid(client, re);
}

/* The frag column of the server's own `status` table, for one name.
 *
 * The bprint obituary path cannot be read server-side (it goes to the
 * clients), and the frag column is the server's authoritative record of the
 * same number the engine's Tab scoreboard displays. Columns:
 * frags userid address name hz ping -- name is the 4th field. */
function tableRows(text) {
  const lines = text.split('\n');
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
async function fragOf(server, name) {
  const mark = raw().length;
  server.command('status');
  const until = Date.now() + 8000;
  let chunk = '';
  while (Date.now() < until) {
    const now = raw();
    chunk = now.slice(mark);
    if (/frags\s+userid/.test(chunk)) { await sleep(300); chunk = raw().slice(mark); break; }
    await sleep(250);
  }
  for (const r of tableRows(chunk)) {
    const m = r.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/);
    if (m && m[4] === name) return +m[1];
  }
  return null;
}

/* ----------------------------------------------------------------- the server */
class Server {
  constructor(port) { this.port = port; }

  async start() {
    fs.mkdirSync(DIR, { recursive: true });
    this.out = fs.openSync(LOG, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', STAGE,
      '--demo-subdir', 'demos',
      '--map', 'forts',
      '+set', 'qwtf_trace', '1',
      '+set', 'developer', '1',
      '+serverinfo', 'qwtf_trace', '1',
      /* TEST ONLY: the per-player `setpos` choreography needs the engine's
       * cheat commands. The owner's server does not set this; the rules never
       * read it. */
      '+set', 'sv_cheats', '1',
    ], { cwd: ROOT, stdio: ['pipe', this.out, 'pipe'], detached: true });
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr || '') + d.toString(); });
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      try { if (/Quake Initialized/.test(raw())) return true; } catch (e) {}
      if (this.proc.exitCode !== null) break;
    }
    return false;
  }

  command(cmd) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n'); }

  /* Point every player at a heading, server-side. The probe's qwtf_face hook
   * is applied in PlayerPreThink to whoever runs it; only the client holding W
   * moves, so steering one walker at a time is safe with two clients. */
  face(yaw) { this.command(`serverinfo qwtf_face ${yaw.toFixed(2)}`); }
  faceNone() { this.command('serverinfo qwtf_face ""'); }

  /* The keys the capture published, from the server's own info buffer. */
  async serverinfoKeys() {
    const mark = raw().length;
    this.command('serverinfo');
    const until = Date.now() + 8000;
    let chunk = '';
    while (Date.now() < until) {
      chunk = raw().slice(mark);
      if (/Server info settings/.test(chunk)) { await sleep(300); chunk = raw().slice(mark); break; }
      await sleep(250);
    }
    const out = {};
    for (const line of chunk.split('\n').map(clean)) {
      const m = line.match(/^(\S+)\s+(\S+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }

  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { if (this.out) fs.closeSync(this.out); } catch (e) {}
    await sleep(300);
  }
}

/* ----------------------------------------------------------------- the client */
const VK = { w: 87, a: 65, s: 83, d: 68, ' ': 32, ShiftLeft: 16 };

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
    /* Chrome's stdout goes to a FILE: a pipe nobody reads fills and blocks the
     * renderer, which looks exactly like "the click did nothing". */
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

  async evalJS(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('page eval threw: ' +
        JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  /* The centerprint echo hook, installed through the page the way a player's
   * console line would be. FTE runs the `f_centerprint` alias on every
   * centerprint it receives, with the text in scr_centerprinttext; the alias
   * echoes it to console.log, which CDP captures. The ${} form matters: it
   * survives alias definition and alias execution, and is expanded only when
   * the echo line itself is executed from the command buffer. */
  async installCenterprintEcho() {
    return this.evalJS(
      "FTEC.cbufadd('alias f_centerprint \"echo CPRINT ${scr_centerprinttext}\"')");
  }

  /* The engine's own per-player teleport. setpos leaves the player NOCLIP, so
   * every move is followed by `noclip` to hand walking back. */
  async setpos(x, y, z) {
    await this.evalJS(`FTEC.cbufadd('setpos ${x} ${y} ${z}')`);
    await sleep(400);
    await this.evalJS("FTEC.cbufadd('noclip')");
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

  /* focus plus the canvas click: the M3 lesson, without which no key reaches
   * the engine. */
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

  async keyDown(keys) {
    const vk = VK;
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
          windowsVirtualKeyCode: vk[k] || 0, nativeVirtualKeyCode: vk[k] || 0 });
    }
  }
  async keyUp(keys) {
    const vk = VK;
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent',
        { type: 'keyUp', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k,
          windowsVirtualKeyCode: vk[k] || 0, nativeVirtualKeyCode: vk[k] || 0 });
    }
  }

  /* Re-issued keydown: FTE latches movement on the keydown transition, and a
   * keydown that lands before the spawn is dropped on the floor. */
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

/* --------------------------------------------------------------- the walking */
/* Walk to a point in short SHIFT bursts, stopping on arrival.
 *
 * The heading is dictated server-side (qwtf_face, read by the probe's
 * PlayerPreThink). The position is only visible at the probe's 4 Hz, and a
 * runner covers ~100 units between two readings -- too far to land inside a
 * 32-wide trigger. Walking (~100 u/s) covers 25 per reading. */
async function walkTo(client, name, server, targetX, targetY) {
  let p = posOf(name);
  if (!p) return false;
  const dist = () => Math.hypot(targetX - p.x, targetY - p.y);
  for (let i = 0; i < 60 && dist() > 8; i++) {
    server.face(Math.atan2(targetY - p.y, targetX - p.x) * 180 / Math.PI);
    await sleep(100);
    await client.keyDown(['shift']);
    await client.holdKey('w', dist() > 60 ? 120 : 60);
    await client.keyUp(['shift']);
    await sleep(280);
    p = posOf(name);
    if (!p) return false;
  }
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
  return dist() <= 96;
}

/* ------------------------------------------------------------- static checks */
/* Strip // comments: what is forbidden is the cvar in CODE, not in prose. */
const code = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

function staticChecks() {
  console.log('the score is two globals, published and announced');
  const ctf = code('qwtf/ctf.qc');
  const flat = ctf.replace(/\s+/g, ' ');   // signatures wrap across lines

  check(/float\s+qwtf_score_red/.test(ctf) && /float\s+qwtf_score_blue/.test(ctf),
        'the team scores are two file-scope GLOBALS (qwtf_score_red/blue)',
        'the bug was per-player .float fields, so every player had a private score');
  check(!/\.float\s+team_score_red/.test(ctf) && !/\.float\s+team_score_blue/.test(ctf),
        'no per-player team_score field is left in qwtf/ctf.qc');

  check(/frags\s*=\s*frags\s*\+\s*10|other\.frags\s*=/.test(ctf),
        'the capturer gets +10 frags (the engine\'s own scoreboard number)');
  check(/qwtf_score_red\s*=\s*qwtf_score_red\s*\+\s*1/.test(ctf) &&
        /qwtf_score_blue\s*=\s*qwtf_score_blue\s*\+\s*1/.test(ctf),
        'a capture is ONE point on a global, not ten on a field');

  check(/localcmd\(\s*strcat\(\s*"serverinfo score_red/.test(ctf) &&
        /localcmd\(\s*strcat\(\s*"serverinfo score_blue/.test(ctf),
        'the score is published as serverinfo score_red/score_blue (a HUD can read it)');

  /* The announcement helper and its four call sites. The helper is defined
   * BEFORE it is called (QuakeC rules), so the definition line counts too. */
  check(/void\(float owner_team, string owner_line, entity special, string special_line, string others_line\) QWTF_announce/.test(flat),
        'QWTF_announce centerprints every player, worded per viewer');
  const callSites = (ctf.match(/QWTF_announce\(/g) || []).length;
  check(callSites >= 4,
        `take, drop, return and capture all announce (${callSites} rule call sites)`);
  check(/Your key has been taken!/.test(ctf), 'the taken line is worded for the key\'s own team');
  check(/Your key is back home/.test(ctf), 'the return line is worded for the key\'s own team');
  check(/The enemy key is yours, take it to your key room/.test(ctf),
        'the carrier gets the pickup line');
  check(/captured the /.test(ctf) && /Red /.test(ctf) && /Blue /.test(ctf),
        'the capture line carries both totals');
  /* The one-centerprint-per-frame constraint, measured on the live run: the
   * capture path must not send a second print in the same frame, or the
   * server's single pending-centerprint slot replaces the capture line before
   * it is ever sent. */
  check(new RegExp('QWTF_announce\\(key\\.qwtf_team,[^;]*?Your key is back home[\\s\\S]*?QWTF_event\\("dropped_key_returned"\\)|QWTF_event\\("dropped_key_returned"\\)[\\s\\S]{0,80}QWTF_announce\\(key\\.qwtf_team,[^;]*?Your key is back home').test(ctf),
        'the "back home" print lives in the dropped-key return, NOT in the capture frame ' +
        '(the server keeps one pending centerprint per client: a second print the ' +
        'same frame replaces the first)');
  check(!/infokey\s*\(\s*world\s*,\s*"qwtf_trace"/.test(ctf),
        'no rule in qwtf/ctf.qc reads the trace cvar');
  check(/centerprint\(p, /.test(ctf) || /centerprint\(e, /.test(ctf),
        'the announce loop centerprints each player individually');
}

/* ---------------------------------------------------------------- live phase */
async function liveChecks() {
  console.log('');
  console.log('two clients, one server: the score everyone can see');
  const PORT = 20000 + (process.pid % 16000), HTTP = PORT + 1;
  const server = new Server(PORT);
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

    const geo = vaultGeometry();
    if (!geo || !geo.key_a || !geo.key_b || !geo.stand_a || !geo.stand_b) {
      bad("gen_map's geometry is readable", 'the entity origins came back empty');
      return;
    }
    const FLOOR = geo.vault_floor;
    const STAND = FLOOR + 24;              // standing height on the vault floor
    const KEY_A = geo.key_a, KEY_B = geo.key_b;
    const NEAR = 96;
    console.log(`       map: scale ${geo.scale}, vault floor ${FLOOR}, ` +
                `red key ${KEY_A[0]},${KEY_A[1]}, stand ${geo.stand_a[0]}, ` +
                `blue key ${KEY_B[0]},${KEY_B[1]}, stand ${geo.stand_b[0]}`);

    /* -- two joins on different teams -------------------------------------- */
    let alpha = new Client('alpha', 10000 + (process.pid % 16000));
    clients.push(alpha);
    try { await alpha.start(url('alpha')); } catch (e) {
      bad('the first browser loaded the page', e && e.message); return;
    }
    if (!await untilLog(t => t.includes('alpha joined'), 90000)) {
      bad('a first join landed', 'no "alpha joined" in the server log after 90 s');
      return;
    }
    /* THE LOBBY: alpha is not spawned until both picks are made. Red is the
     * pick this test needs (alpha red, bravo blue below). The spawn is then
     * waited for like any other server event (class_stats alpha). */
    await sleep(1500);
    await alpha.evalJS('window.QWTF_MENU.do("team_red")');
    await sleep(700);
    await alpha.evalJS('window.QWTF_MENU.do("cls_soldier")');
    if (!await untilLog(t => t.includes('QWTF_EVENT class_stats alpha class=soldier'), 20000)) {
      bad('alpha spawned after both picks', 'no class_stats alpha class=soldier within 20 s');
      return;
    }
    if (!await untilLog(t => (posOf('alpha') || { team: 0 }).team !== 0, 15000)) {
      bad('alpha was given a team', `last trail: ${JSON.stringify(posOf('alpha'))}`);
      return;
    }
    ok('alpha joined and was given a team');

    let bravo = new Client('bravo', 10001 + (process.pid % 16000));
    clients.push(bravo);
    try { await bravo.start(url('bravo')); } catch (e) {
      bad('the second browser loaded the page', e && e.message); return;
    }
    if (!await untilLog(t => t.includes('bravo joined'), 90000)) {
      bad('a second join landed', 'no "bravo joined"');
      return;
    }
    await sleep(1500);
    await bravo.evalJS('window.QWTF_MENU.do("team_blue")');
    await sleep(700);
    await bravo.evalJS('window.QWTF_MENU.do("cls_soldier")');
    if (!await untilLog(t => t.includes('QWTF_EVENT class_stats bravo class=soldier'), 20000)) {
      bad('bravo spawned after both picks', 'no class_stats bravo class=soldier within 20 s');
      return;
    }
    if (!await untilLog(t => (posOf('bravo') || { team: 0 }).team !== 0, 15000)) {
      bad('bravo was given a team', `last trail: ${JSON.stringify(posOf('bravo'))}`);
      return;
    }
    const at = posOf('alpha'), bt = posOf('bravo');
    check(at.team === 1 && bt.team === 2,
          'the two clients are on DIFFERENT teams (alpha red, bravo blue)',
          `alpha team ${at.team}, bravo team ${bt.team}`);

    if (!logIsFromThisRun()) {
      bad("the server log is this run's", `${LOG} is empty or older than the run started`);
      return;
    }

    /* -- focus + the centerprint echo, on BOTH pages ------------------------ */
    try {
      await alpha.focus();
      await alpha.installCenterprintEcho();
      await bravo.focus();
      await bravo.installCenterprintEcho();
      ok('both pages are focused and carry the centerprint echo hook');
    } catch (e) {
      bad('the pages could be focused and hooked', e && e.message);
      return;
    }
    /* The hook has to prove itself before it is evidence of anything: the
     * first take below echoes a centerprint through it. If the alias was
     * refused, `alias` prints its complaint to the page console instead. */

    /* A movement precondition: the input path works at all. */
    {
      const p0 = posOf('alpha');
      await alpha.holdKey('w', 600);
      await sleep(1200);
      const p1 = posOf('alpha');
      const moved = p0 && p1 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 16;
      check(moved, 'holding W moves alpha (input reaches the engine)',
            `alpha at ${p0 ? [p0.x, p0.y, p0.z].join(',') : '?'} -> ` +
            `${p1 ? [p1.x, p1.y, p1.z].join(',') : '?'}, needed >16 units`);
      await alpha.setpos(KEY_A[0], KEY_A[1], STAND);   // back to the red vault
    }
    /* A setpos precondition: the choreography's own tool works. */
    {
      const p0 = posOf('alpha');
      await alpha.setpos(KEY_B[0] + NEAR, KEY_B[1], STAND);
      const p1 = posOf('alpha');
      const got = p1 && Math.hypot(p1.x - (KEY_B[0] + NEAR), p1.y - KEY_B[1]) < 64;
      check(got, 'setpos moves alpha (the per-player teleport works)',
            `alpha ${p0 ? [p0.x, p0.y].join(',') : '?'} -> ` +
            `${p1 ? [p1.x, p1.y].join(',') : '?'} wanted ${KEY_B[0] + NEAR},${KEY_B[1]}`);
    }

    /* -- ROUND A: alpha (red) captures blue's key --------------------------- */
    console.log('round A: red captures (red 0 -> 1)');
    const frag0 = await fragOf(server, 'alpha');
    const cs0 = ev('capture_score').length, cp0 = ev('capture').length;

    await alpha.setpos(KEY_B[0] + NEAR, KEY_B[1], STAND);
    const trail0 = trailOf('alpha').length;
    await walkTo(alpha, 'alpha', server, KEY_B[0] - NEAR, KEY_B[1]);
    const takes1 = await awaitEv('take', 1);
    check(takes1 >= 1 && straddled('alpha', KEY_B[0], trail0, FLOOR),
          'alpha walked THROUGH the ENEMY key and took it',
          `QWTF_EVENT take ${takes1} time(s); the walk trail ` +
          `${straddled('alpha', KEY_B[0], trail0, FLOOR) ? 'crossed' : 'never crossed'} ` +
          `x=${KEY_B[0]} at vault-floor height; alpha ended at ` +
          `${JSON.stringify((({ x, y }) => ({ x, y }))(posOf('alpha') || {}))}`);

    /* The OTHER team's client hears about the take (task 2). */
    const bravoTaken = await awaitClientSaid(bravo, /Your key has been taken!/);
    check(bravoTaken, 'the key\'s own team (bravo, blue) got "Your key has been taken!"',
          bravoTaken ? null : `bravo console tail: ${bravo.logs.slice(-4).join(' | ').slice(0, 300)}`);
    const alphaCarryLine = await awaitClientSaid(alpha, /The enemy key is yours/);
    check(alphaCarryLine, 'the carrier (alpha) got the pickup centerprint',
          alphaCarryLine ? null : `alpha console tail: ${alpha.logs.slice(-4).join(' | ').slice(0, 300)}`);

    await alpha.setpos(KEY_A[0], KEY_A[1], STAND);
    const trail0b = trailOf('alpha').length;
    await walkTo(alpha, 'alpha', server, geo.stand_a[0] + 32, KEY_A[1]);
    const caps1 = await awaitEv('capture', cp0 + 1);
    check(caps1 > cp0 && straddled('alpha', geo.stand_a[0], trail0b, FLOOR),
          'alpha carried it to the RED stand: capture',
          `QWTF_EVENT capture ${caps1 - cp0} new time(s); the walk trail ` +
          `${straddled('alpha', geo.stand_a[0], trail0b, FLOOR) ? 'crossed' : 'never crossed'} ` +
          `the stand x=${geo.stand_a[0]}; alpha ended at ` +
          `${JSON.stringify((({ x, y }) => ({ x, y }))(posOf('alpha') || {}))}`);

    await awaitEv('capture_score', cs0 + 1);
    const scoreLines = probe('QWTF_EVENT capture_score');
    const lastScore = clean(scoreLines[scoreLines.length - 1] || '');
    const red = +(lastScore.match(/red=(\d+)/) || [])[1];
    const blue = +(lastScore.match(/blue=(\d+)/) || [])[1];
    const team = +(lastScore.match(/team=(\d+)/) || [])[1];
    check(team === 1 && red === 1 && blue === 0,
          'the first red capture reads team=1 red=1 blue=0',
          `last capture_score: ${lastScore}`);

    /* BOTH clients received the capture CENTERPRINT (the CPRINT prefix is the
     * alias echo -- only a real svc_centerprint can produce it; the bprint
     * would match too, so it is excluded here and checked below). */
    const capText = /CPRINT .*captured the BLUE key!/;
    const aGot = await awaitClientSaid(alpha, capText);
    const bGot = await awaitClientSaid(bravo, capText);
    check(aGot, 'ALPHA received the capture centerprint',
          aGot ? null : `alpha console tail: ${alpha.logs.slice(-4).join(' | ').slice(0, 300)}`);
    check(bGot, 'BRAVO received the capture centerprint',
          bGot ? null : `bravo console tail: ${bravo.logs.slice(-4).join(' | ').slice(0, 300)}`);

    /* And the bprint line that ends with the score, on both clients. */
    const scoreText = /captured the BLUE key! Red 1\s*-\s*Blue 0/;
    const aScore = await awaitClientSaid(alpha, scoreText);
    const bScore = await awaitClientSaid(bravo, scoreText);
    check(aScore && bScore, 'both clients saw the bprint line end with the score (Red 1 - Blue 0)',
          `alpha ${aScore}, bravo ${bScore}`);

    /* The capturer's +10, from the server's own status table. */
    const frag1 = await fragOf(server, 'alpha');
    check(frag1 !== null && frag1 === (frag0 === null ? null : frag0 + 10),
          `the capturer's frags rose by 10 (${frag0} -> ${frag1})`,
          frag1 === null ? 'alpha was not in the status table' :
                           'the frag column did not move by 10');

    /* The serverinfo the HUD would read. */
    const keys = await server.serverinfoKeys();
    check(keys.score_red === '1' && keys.score_blue === '0',
          'serverinfo carries score_red=1 score_blue=0',
          `score_red=${keys.score_red} score_blue=${keys.score_blue}`);

    /* -- ROUND B: a SECOND red capture -------------------------------------- */
    console.log('round B: red captures again (red 1 -> 2)');
    const cs1 = ev('capture_score').length, cp1 = ev('capture').length;
    await alpha.setpos(KEY_B[0] + NEAR, KEY_B[1], STAND);
    await walkTo(alpha, 'alpha', server, KEY_B[0] - NEAR, KEY_B[1]);
    await awaitEv('take', 2, 15000);
    await alpha.setpos(KEY_A[0], KEY_A[1], STAND);
    await walkTo(alpha, 'alpha', server, geo.stand_a[0] + 32, KEY_A[1]);
    await awaitEv('capture', cp1 + 1);
    await awaitEv('capture_score', cs1 + 1);
    const scoreLines2 = probe('QWTF_EVENT capture_score');
    const lastScore2 = clean(scoreLines2[scoreLines2.length - 1] || '');
    const red2 = +(lastScore2.match(/red=(\d+)/) || [])[1];
    const blue2 = +(lastScore2.match(/blue=(\d+)/) || [])[1];
    check(red2 === 2 && blue2 === 0, 'the second red capture reads red=2 blue=0',
          `last capture_score: ${lastScore2}`);
    const capText2 = /CPRINT .*captured the BLUE key!/;
    const aGot2 = await awaitClientSaid(alpha, capText2);
    const bGot2 = await awaitClientSaid(bravo, capText2);
    check(aGot2 && bGot2, 'both clients received the SECOND capture centerprint too',
          `alpha ${aGot2}, bravo ${bGot2}`);
    const keys2 = await server.serverinfoKeys();
    check(keys2.score_red === '2', 'serverinfo score_red moved to 2',
          `score_red=${keys2.score_red}`);

    /* -- ROUND C: bravo (blue) captures red's key --------------------------- */
    console.log('round C: blue captures (blue 0 -> 1)');
    const cs2 = ev('capture_score').length, cp2 = ev('capture').length;
    const fragB0 = await fragOf(server, 'bravo');

    await bravo.setpos(KEY_A[0] - NEAR, KEY_A[1], STAND);
    await walkTo(bravo, 'bravo', server, KEY_A[0] + NEAR, KEY_A[1]);
    await awaitEv('take', 3, 15000);
    const alphaTaken = await awaitClientSaid(alpha, /Your key has been taken!/);
    check(alphaTaken, 'the key\'s own team (alpha, red) got "Your key has been taken!"',
          alphaTaken ? null : `alpha console tail: ${alpha.logs.slice(-4).join(' | ').slice(0, 300)}`);

    await bravo.setpos(KEY_B[0], KEY_B[1], STAND);
    await walkTo(bravo, 'bravo', server, geo.stand_b[0] - 32, KEY_B[1]);
    await awaitEv('capture', cp2 + 1);
    await awaitEv('capture_score', cs2 + 1);
    const scoreLines3 = probe('QWTF_EVENT capture_score');
    const lastScore3 = clean(scoreLines3[scoreLines3.length - 1] || '');
    const red3 = +(lastScore3.match(/red=(\d+)/) || [])[1];
    const blue3 = +(lastScore3.match(/blue=(\d+)/) || [])[1];
    const team3 = +(lastScore3.match(/team=(\d+)/) || [])[1];
    check(team3 === 2 && red3 === 2 && blue3 === 1,
          'the blue capture reads team=2 red=2 blue=1',
          `last capture_score: ${lastScore3}`);
    const capText3 = /CPRINT .*captured the RED key!/;
    const aGot3 = await awaitClientSaid(alpha, capText3);
    const bGot3 = await awaitClientSaid(bravo, capText3);
    check(aGot3 && bGot3, 'both clients received the BLUE capture centerprint',
          `alpha ${aGot3}, bravo ${bGot3}`);
    const bScore3 = await awaitClientSaid(bravo, /captured the RED key! Red 2\s*-\s*Blue 1/);
    check(bScore3, 'the blue capture\'s bprint line ends with the score on a client too',
          `bravo ${bScore3}`);
    const fragB1 = await fragOf(server, 'bravo');
    check(fragB1 !== null && fragB1 === fragB0 + 10,
          `bravo's frags rose by 10 (${fragB0} -> ${fragB1})`);
    /* Note: RED's key going home after this capture says nothing extra -- the
     * capture line above IS the announcement (one print per frame; a second
     * print replaces it before it is sent). The "back home" wording is proven
     * in round D, where the key goes home WITHOUT a capture. */
    const keys3 = await server.serverinfoKeys();
    check(keys3.score_red === '2' && keys3.score_blue === '1',
          'serverinfo reads score_red=2 score_blue=1',
          `score_red=${keys3.score_red} score_blue=${keys3.score_blue}`);

    /* -- ROUND D: the drop and the clock -------------------------------------
     * Alpha takes blue's key a third time and DIES with it. The key lands
     * where he fell; nobody touches it; the 20 s clock sends it home. That is
     * a return WITHOUT a capture, which is where "Your key is back home"
     * belongs: the capture path must not send a second centerprint in the
     * same frame (the server keeps one pending print per client, so a second
     * print REPLACES the capture line -- measured in round A's first
     * implementation). */
    console.log('round D: the carrier dies, the key times out and goes home');
    const cs3 = ev('capture_score').length, cp3 = ev('capture').length;
    await alpha.setpos(KEY_B[0] + NEAR, KEY_B[1], STAND);
    const trailD = trailOf('alpha').length;
    await walkTo(alpha, 'alpha', server, KEY_B[0] - NEAR, KEY_B[1]);
    await awaitEv('take', 4, 15000);

    /* The death, through the probe's own hook (a real T_Damage, so PlayerDie
     * runs exactly as it does when a player is shot). MEASURED with two
     * clients: one qwtf_hurtseq damages BOTH of them about a second apart --
     * the per-player seq memory makes it one-shot per player, and the world's
     * 1 s gate only spaces the two. Alpha is hurt FIRST (it is the lower
     * client slot and the one carrying), and the drop below is its PlayerDie;
     * bravo's line lands a second later and costs nothing. The assertion is
     * therefore "alpha was hurt AND the key dropped", not "bravo was never
     * hurt". */
    let hurtseq = 0;
    const dropsD = ev('drop').length;
    hurtseq += 1;
    server.command('serverinfo qwtf_hurt 1000');
    server.command(`serverinfo qwtf_hurtseq ${hurtseq}`);
    const died = await untilLog(t => ev('drop').length > dropsD, 15000);
    const alphaHurt = probe('QWTFHURT alpha').length > 0;
    check(died && alphaHurt,
          'the carrier died and the key dropped where he fell',
          `QWTF_EVENT drop +${ev('drop').length - dropsD}; QWTFHURT alpha lines: ` +
          `${probe('QWTFHURT alpha').length} (bravo is hurt a second later by the same ` +
          `sequence: ${probe('QWTFHURT bravo').length})`);

    /* The key's team hears about the drop (the drop's own centerprint). */
    const bravoDrop = await awaitClientSaid(bravo, /Your key has been dropped!/);
    check(bravoDrop, 'the key\'s own team (bravo, blue) got "Your key has been dropped!"',
          bravoDrop ? null : `bravo console tail: ${bravo.logs.slice(-4).join(' | ').slice(0, 300)}`);
    check(straddled('alpha', KEY_B[0], trailD, FLOOR),
          'the drop happened on the blue side (alpha died in the enemy vault)');

    /* Nobody touches it: alpha respawns at the red spawn, bravo is at its own
     * spawn. Wait out the 20 s clock with margin. */
    const rtD = ev('return_timeout').length;
    const homeD = ev('dropped_key_returned').length;
    const timed = await untilLog(t => ev('return_timeout').length > rtD, 40000);
    check(timed && ev('dropped_key_returned').length > homeD,
          `the dropped key came home on its own clock (${ev('return_timeout').length - rtD} timeout)`,
          `return_timeout +${ev('return_timeout').length - rtD}, ` +
          `dropped_key_returned +${ev('dropped_key_returned').length - homeD}`);

    const bravoHome2 = await awaitClientSaid(bravo, /Your key is back home/);
    check(bravoHome2, 'the key\'s own team (bravo, blue) got "Your key is back home"',
          bravoHome2 ? null : `bravo console tail: ${bravo.logs.slice(-4).join(' | ').slice(0, 300)}`);

    /* The drop and the timeout moved NOBODY's score. */
    const keys4 = await server.serverinfoKeys();
    check(keys4.score_red === '2' && keys4.score_blue === '1',
          'a drop and a timed return scored nothing (still red=2 blue=1)',
          `score_red=${keys4.score_red} score_blue=${keys4.score_blue}`);
  } catch (e) {
    bad('the live checks ran', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
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
  fs.mkdirSync(DIR, { recursive: true });
  stage();
  staticChecks();
  await liveChecks();
  console.log('');
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log)`);
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) {}
  console.log(failed ? `FAIL: ${failed} of ${passed + failed} checks`
                      : `PASS: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('Error:', e && e.stack); process.exit(1); });
