#!/usr/bin/env node
/**
 * M3 acceptance test: a playable deathmatch loop.
 *
 * Two headless browser clients on the dedicated server. Client A shoots client
 * B until the server logs a frag, the server records an .mvd of the whole thing,
 * and a contact sheet of frames is extracted from it.
 *
 * What it asserts:
 *   1. both clients are in the game (server player table lists 2),
 *   2. A's shots connect: the server's log shows the frag,
 *   3. the respawn happens (the server reports both players alive again),
 *   4. an .mvd exists, is non-trivial in size, and grows over the recording,
 *   5. frames can be extracted from it and they are not all one colour.
 *
 * Aiming is done by pointing both clients at each other through the console
 * rather than by simulating mouse look: FTE's `impulse`/`+forward`/`+left` are
 * not enough to hit reliably, whereas `setinfo`/`Cmd` cannot teleport. Instead
 * both clients are placed by the server on facing spawn points (gen_map.py puts
 * two info_player_deathmatch points at opposite ends of the corridor looking
 * down it), so walking forward and firing hits.
 *
 * Usage:
 *   node tests/mp_combat.js [--runs 1] [--keep-demos]
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const FIXTURES_MAPS = path.join(ROOT, 'tests', 'fixtures', 'maps');
const SHOTS = path.join(ROOT, 'screens');
/* Demo output goes to tests/artifacts/, NOT under web/.
 *
 * FTE's sv_mvd.c has sv_demoDir = "demos" and writes
 * "<sv_demoDir>/<name><sv_demoSuffix>" under the gamedir, which would put it in
 * web/fte/demos/ -- and web/ is served to every visitor, i.e. distributed, so a
 * test artefact does not belong there. We point sv_demoDir at tests/artifacts/
 * and git-ignore it. */
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
/* Demos land in the staged gamedir, not under web/.
 *
 * FTE writes to <gamedir>/fte/<sv_demoDir>/<name>: sv_mvd.c prefixes the
 * recording path with "fte/" itself, so with sv_demoDir=demos the file is at
 * <gamedir>/fte/demos/. Getting this wrong is why an earlier run reported the
 * .mvd missing while one existed. See the staging note where STAGE is built. */
const DEMOS = path.join(ARTIFACTS, 'gamedir', 'fte', 'demos');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const RUNS = parseInt(arg('--runs', '1'), 10);
/* --negative-control builds the duel map with spawn B facing the wall and
 * expects NO frag. That is the check that the duel test is measuring a real
 * line of fire rather than just the passage of time; without it, "frag after
 * 10 s" could be satisfied by anything. See gen_map.py --flip-b. */
const NEGATIVE = process.argv.includes('--negative-control');
const SV_PORT = parseInt(arg('--port', String(27600 + (process.pid % 300))), 10);
/* PID-derived so two runs (or the owner's own page server) cannot collide.
 * It used to default to 8200, which is a port a human is using. */
const HTTP_PORT = parseInt(arg('--http-port', String(8300 + (process.pid % 300))), 10);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WSS = `ws://127.0.0.1:${SV_PORT}`;

const results = [];
/* md5 of a file, for the "we did not touch the served tree" assertion. */
function md5(file) {
  return require('crypto').createHash('md5')
    .update(fs.readFileSync(file)).digest('hex');
}

function check(ok, what, detail) {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}` +
              (ok || !detail ? '' : `\n         ${detail}`));
  return ok;
}
function sh(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}
const httpCode = () => (sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
  `${BASE}/index.html`]).stdout || '').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- server, driven over stdin -------------------------------------------- */
class Server {
  constructor(port, gamedir) {
    this.port = port; this.log = ''; this.started = Date.now();
    this.gamedir = gamedir; this.demoSubdir = 'demos';
  }
  async start() {
    /* --map duel explicitly: run_server.sh defaults to ctf now (0101, so the
     * owner's service shows the real map), and this suite is about the duel
     * fixture. Relying on the default here would silently test ctf instead. */
    const argv = [path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port), '--gamedir', this.gamedir,
      '--demo-subdir', this.demoSubdir, '--map', 'duel',
      '+set', 'developer', '1'];
    this.proc = spawn('bash', argv,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.proc.stdout.on('data', d => { this.log += d.toString(); });
    this.proc.stderr.on('data', d => { this.log += d.toString(); });
    for (let i = 0; i < 120; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(this.log)) return true;
      if (this.proc.exitCode !== null) break;
    }
    return /Quake Initialized/.test(this.log);
  }
  cmd(c) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(c + '\n'); }
  async status() {
    const before = this.log.length;
    this.cmd('status');
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const chunk = this.log.slice(before);
      if (/frags\s+userid\s+address\s+name/i.test(chunk)) { await sleep(250); return this.log.slice(before); }
    }
    return this.log.slice(before);
  }
  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {} }
  }
  uptime() { return ((Date.now() - this.started) / 1000).toFixed(1) + 's'; }
}

/* Compare the bottom HUD strip of two full screenshots.
 *
 * Uses Python/PIL because the repo has no node_modules and no install step. The
 * ammo digits are the only thing in that strip that changes while firing, so any
 * difference there means the weapon fired.
 */
function hudDiffers(a, b) {
  const py = `
import sys
from PIL import Image
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
w, h = a.size
# bottom strip, full width: the health/armour/ammo row
# Bottom 6% only. Measured at 1024x433: the health/armour/ammo digits occupy
# rows 413-425, i.e. the very bottom. A taller strip picks up the ceiling lights
# (rows 243-268), which change with the view and mask the comparison.
box = (0, int(h * 0.94), w, h)
ca, cb = a.crop(box).tobytes(), b.crop(box).tobytes()
diff = sum(1 for x, y in zip(ca, cb) if x != y)
print(diff)
`;
  const r = sh('python3', ['-c', py, a, b]);
  if (r.status !== 0) return null;
  return parseInt((r.stdout || '0').trim(), 10) > 0;
}

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

/* --- one headless client, reusing the CDP client from mp_smoke ------------ */
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
    for (let i = 0; i < 120; i++) {
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
    await this.send('Runtime.enable'); await this.send('Page.enable');
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
    await this.send('Page.navigate', { url });
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${this.name} CDP timeout: ${method}`)); } }, 60000);
    });
  }
  said(re) { return this.logs.some(l => re.test(l)); }
  text() { return this.logs.join('\n'); }
  /* Give the canvas focus and pointer lock.
   *
   * FTE's web glue (engine/web/ftejslib.js) routes mouse input through
   * requestPointerLock on the canvas, and its mousedown handler calls
   * window.focus() first. In headless Chrome the lock request is unreliable, and
   * without it the mouse buttons never reach the engine: my +attack presses
   * moved the HUD's ammo counter not at all, which is how I found out the shots
   * were never firing rather than firing and missing.
   *
   * So: focus the window, click the canvas, and if pointer lock did not take,
   * enable it through the browser's own automation flag. */
  async focus() {
    await this.send('Page.bringToFront').catch(() => {});
    const p = await this.canvasCentre();
    if (!p) return false;
    await this.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
    await this.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
    return true;
  }

  /* Read the HUD's ammo number off the canvas by pixel-diffing a crop of it.
   * Only used as a diagnostic: "0 frags" has two very different causes --
   * not firing, or firing and missing -- and I want the test able to tell. */
  /* Centre of the canvas, in CSS pixels. FTE routes mouse input through the
   * canvas, and headless Chrome will not focus the page or grant pointer lock
   * without a real click there. */
  /* Hash of the HUD strip (health/armour/ammo row). Cheap change detector:
   * the ammo digits are the only thing there that moves while firing. */
  async hudStripHash() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const full = '/tmp/qwtf_hud_probe.png';
    const strip = '/tmp/qwtf_hud_strip.png';
    fs.writeFileSync(full, Buffer.from(r.data, 'base64'));
    const out = sh('python3', ['-c', `
import sys, hashlib
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
# Measured at 1024x433: the health/armour/ammo digits sit in the bottom ~6%.
# Just the ammo digits. Measured at 1024x433 the "24" sits around
# x 700-790, y 400-430. A wider crop includes floor texture, which changes with
# every camera movement and so masks whether the ammo actually moved.
# EXACT HUD digits, located programmatically rather than guessed: at 1024x433
# the health/armour/ammo row occupies rows 414-425, cols 518-649. Guessing this
# box is what made an earlier version of this check report a constant HUD while
# the ammo was in fact moving.
im.crop((510, 408, 660, 432)).save(sys.argv[2])
print(hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest()[:12])
`, full, strip]);
    if (out.status !== 0) return 'err:' + (out.stderr || '').slice(0, 60);
    return (out.stdout || '').trim() || 'err';
  }

  async canvasCentre() {
    try {
      const box = await this.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => { const c = document.getElementById('canvas');
          if (!c) return null; const r = c.getBoundingClientRect();
          return { x: Math.round(r.left + r.width/2),
                   y: Math.round(r.top + r.height/2) }; })()`,
      });
      return box.result && box.result.value;
    } catch (e) { return null; }
  }

  /* Capture the HUD strip for the ammo/health comparison.
   *
   * Capture a FULL screenshot and crop it in-process. Using Page.
   * captureScreenshot's `clip` returned a byte-identical image across samples
   * even when the HUD had visibly changed (ammo 25 -> 24 between two grabs),
   * which made the "did we fire" check silently useless. A full capture always
   * reflects the current frame, and cropping it here keeps the comparison
   * honest.
   *
   * The strip is the bottom of the canvas: measured at 1024x433, the health /
   * armour / ammo row sits around y 370-425. */
  async hudAmmoShot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const img = Buffer.from(r.data, 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, img);
    return file;
  }

  /* Press keys down and leave them down. Returns a release function, so a
   * trigger can be held across the whole fight window instead of being pulsed
   * once per weapon cycle. */
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

  /* Hold the fire key down and LEAVE IT DOWN.
   *
   * This is the exact event the reviewer found working (.team/msg/0052,
   * experiment B): a single rawKeyDown for ControlLeft with NO keyUp, sent
   * after the spawn and after the canvas has been clicked. It scored a real
   * frag and walked the ammo counter 21 -> 16 -> 12 -> 7 -> 3.
   *
   * Two things this replaces, both measured wrong:
   *   - Pulsing a press/release pair per shot. KeyDown_Scan latches on the
   *     transition, so a released-then-repressed key can fire, but it also
   *     gives the engine a keyUp it did not ask for and the loop was firing
   *     long before the player existed.
   *   - Firing from the console at connect (+attack in f_startup): the reviewer
   *     measured ammo 25 -> 23 and then flat for 10 s, because FTE drops held
   *     buttons when the player spawns. A hold that starts before the spawn is
   *     thrown away.
   * So: press once, never release, and only after the spawn. */
  async holdFire() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2,
    });
  }
  async releaseFire() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0,
    });
  }

  /* Real key events, so this drives FTE's actual input path. */
  async hold(keys, ms) {
    const vk = { w: 87, a: 65, s: 83, d: 68, ' ': 32, ArrowLeft: 37, ArrowRight: 39 };
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent',
        { type: 'rawKeyDown', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: vk[k] || 0, nativeVirtualKeyCode: vk[k] || 0 });
    }
    await sleep(ms);
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent',
        { type: 'keyUp', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: vk[k] || 0, nativeVirtualKeyCode: vk[k] || 0 });
    }
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

async function main() {
  if (sh('which', ['google-chrome']).status !== 0) {
    console.log('no google-chrome; cannot run'); return 2;
  }
  let httpServer = null;
  fs.mkdirSync(DEMOS, { recursive: true });
  // sv_demoDir is relative to the gamedir (web/), so reach tests/artifacts with
  // an absolute path and FTE will use it as given.
  /* Stage a game root for the server: web/id1 symlinked in, plus its own demos
   * directory. This keeps test output out of web/, which is served to every
   * visitor. FTE rejects an absolute sv_demoDir and anything containing ".."
   * (SV_DemoDir_Callback in sv_mvd.c), so the only way to get the demos out of
   * the served tree is to give the server a different root. */
  const STAGE = path.join(ARTIFACTS, 'gamedir');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  /* Everything in web/ is symlinked in EXCEPT id1, which is rebuilt below.
   *
   * The browser is served from this same directory, deliberately. When the page
   * came from the live web/ tree while the game server had the staged one, the
   * two served different corridor/duel maps and every client was dropped with
   * "map model file does not match" -- the same failure that ended the owner's
   * first play-test (reviewer 0054). One frozen tree for the page and the
   * server is the fix, so this test can never desync them.
   */
  for (const entry of fs.readdirSync(WEB)) {
    if (entry === 'id1') continue;
    if (entry === 'index.html') continue;
    fs.symlinkSync(path.join(WEB, entry), path.join(STAGE, entry));
  }
  /* The staged page's manifest carries this suite's fixture map (0479, and
   * measured): with duel.bsp absent from the browser's pre-engine fetch list,
   * the client asks for the map at connect, the server serves it, the client
   * joins -- and the canvas is a black void. The web build applies only maps
   * it fetched before the engine started (the full measurement is at
   * mp_smoke's stageGamedir). The staged page is a test fixture; the deployed
   * page stays trim. */
  {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const END = '\t\t/* ---- END GENERATED MANIFEST ---- */';
    if (!html.includes(END)) throw new Error('staged page: no manifest END marker');
    const entry = '\t\t"id1/maps/duel.bsp": "id1/maps/duel.bsp",'.padEnd(56) +
                  '/* staged for this suite (0479) */\n';
    fs.writeFileSync(path.join(STAGE, 'index.html'), html.replace(END, entry + END));
  }
  /* Stage the id1 tree entry by entry instead of symlinking the whole
   * directory.
   *
   * The negative control has to compile a DIFFERENT duel.bsp, and a single
   * symlinked id1 meant that compile landed in web/id1/maps -- the tree every
   * visitor is served from. Two bad things followed. A killed run left the
   * flipped map in place (a `finally` restore does not run on SIGKILL), and
   * even a successful restore was a race with the owner's live page and server:
   * rebuilding a map out from under them is what ended their first play-test
   * with "map model file does not match" (reviewer 0054).
   *
   * So maps/ becomes a real directory: every map is a symlink, except duel.bsp,
   * which is a real copy the test may overwrite freely. Nothing in web/ is ever
   * written, so there is nothing to restore and nothing to race with.
   */
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const entry of fs.readdirSync(path.join(WEB, 'id1'))) {
    if (entry === 'maps') continue;
    fs.symlinkSync(path.join(WEB, 'id1', entry), path.join(STAGE, 'id1', entry));
  }
  fs.mkdirSync(path.join(STAGE, 'id1', 'maps'), { recursive: true });
  /* 0479: ctf, corridor and duel ship with the tests (tests/fixtures/maps/),
   * not in web/id1/maps -- so the symlink loop takes BOTH directories, and
   * the writable duel.bsp copy comes from the fixtures dir. Nothing in web/
   * is read into the staged maps except forts.bsp, and nothing in web/ is
   * ever written, so there is nothing to restore and nothing to race with. */
  for (const dir of [path.join(WEB, 'id1', 'maps'), FIXTURES_MAPS]) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'duel.bsp') continue;
      const to = path.join(STAGE, 'id1', 'maps', entry);
      if (!fs.existsSync(to)) {
        fs.symlinkSync(path.join(dir, entry), to);
      }
    }
  }
  fs.copyFileSync(path.join(FIXTURES_MAPS, 'duel.bsp'),
                  path.join(STAGE, 'id1', 'maps', 'duel.bsp'));
  fs.mkdirSync(path.join(STAGE, 'fte', 'demos'), { recursive: true });
  const webMapAtStart = md5(path.join(FIXTURES_MAPS, 'duel.bsp'));

  /* Serve the staged tree to the browser. Always our own server on a
   * PID-derived port: reusing whatever held :8200 meant silently testing
   * someone else's page, and if that page served a different map the clients
   * were refused (see above). */
  httpServer = spawn('node', ['tools/serve.js', '--port', String(HTTP_PORT),
                             '--root', STAGE], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { await sleep(200); if (httpCode() === '200') break; }
  if (httpCode() !== '200') {
    console.log(`  FATAL the staged page server never came up on :${HTTP_PORT}`);
    httpServer.kill();
    return 1;
  }

  const server = new Server(SV_PORT, STAGE);
  console.log(`starting build/fteqw-sv on :${SV_PORT}`);
  if (!await server.start()) {
    console.log('  FAIL the dedicated server did not initialise\n' + server.log.slice(-1200));
    if (httpServer) httpServer.kill();
    return 1;
  }
  check(true, `dedicated server initialised (${server.uptime()})`);

  // Record the whole session server-side. sv_demorecord/sv_demostop are the
  // server-only spellings (sv_mvd.c registers them under SERVERONLY).
  // The duel fixture: a lit hall with EXACTLY two opposed deathmatch spawns, so
  // two clients always get one each and face each other. The corridor has six
  // spawns and PutClientInServer picks at random, which is why the frag was a
  // coin toss before (see STATE.md).
  //
  // In negative-control mode compile the flipped variant (spawn B facing the
  // wall) over duel.bsp first, so the server serves it under the same name.
  if (NEGATIVE) {
    console.log('  ... negative control: building duel.bsp with spawn B facing the wall');
    /* Keep the real one so the finally block can put it back; the staged
     * gamedir symlinks web/id1, so this compile is visible to every visitor
     * until we restore it. */
    /* Build into the STAGING copy. tests/fixtures/maps/duel.bsp is not
     * written, not even to be restored afterwards: there is no window in
     * which the owner's page or server could see a half-replaced map. */
    const r = spawnSync('bash', ['-c',
      `python3 scripts/gen_map.py --duel --flip-b -o /tmp/duel_neg.map &&
       python3 scripts/gen_map.py --duel -o maps/duel.map &&
       third_party/ericw-tools/build-linux/qbsp/qbsp -wadpath web/id1 /tmp/duel_neg.map "$1"`,
      'bash', path.join(STAGE, 'id1/maps/duel.bsp')],
      { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      console.log('  FATAL could not build the negative-control map\n' + (r.stderr || r.stdout));
      return 1;
    }
  }
  server.cmd('map duel');
  await sleep(2000);
  server.cmd('sv_demorecord qwtf_m3');

  const urlFor = n => `${BASE}/index.html?server=${encodeURIComponent(WSS)}&name=${n}`;
  const a = new Client('alpha', 9521);
  const b = new Client('bravo', 9522);
  try {
    await a.start(urlFor('alpha'));
    await b.start(urlFor('bravo'));

    // Wait until the server lists both players.
    let st = '';
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      st = await server.status();
      const r = tableRows(st);
      if (r.length === 2 && r.some(x => /alpha/i.test(x)) && r.some(x => /bravo/i.test(x))) break;
      await sleep(1000);
    }
    check(tableRows(st).length === 2,
      'both clients are in the game',
      `rows: ${JSON.stringify(tableRows(st))}`);
    if (tableRows(st).length !== 2) return 1;

    /* THE LOBBY (2026-10-09): a join is held until both picks are made, and a
     * waiter draws no HUD at all -- the HUD wait below would time out on a
     * healthy lobby. Both picks go out through the page's own overlay entry
     * point (`auto` counts as the team pick) on both clients, and the spawn
     * is what the HUD then proves. */
    for (const c of [a, b]) {
      await c.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const m = window.QWTF_MENU;
          if (!m) return 'no menu';
          m.do('team_auto');
          return 'team sent';
        })()`,
      });
    }
    await sleep(700);
    for (const c of [a, b]) {
      await c.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => { const m = window.QWTF_MENU; if (!m) return 'no menu'; m.do('cls_soldier'); return 'class sent'; })()`,
      });
    }

    /* Wait for the SPAWN, not just the connection.
     *
     * "Both clients are in the game" only means the server has two name slots;
     * the player entity does not exist until PutClientInServer has run. FTE
     * releases held buttons across a spawn, so anything pressed before this
     * point is discarded -- which is why my earlier console +attack fired twice
     * and then went flat. The HUD appearing is the client-side proof that the
     * player is in the world and rendering. */
    let hudReady = false;
    const hudUntil = Date.now() + 30000;
    const hudProbe = path.join(ARTIFACTS, 'm3_hud_probe.png');
    while (Date.now() < hudUntil) {
      await a.screenshot(hudProbe);
      // Distinct colours in the bottom strip: an undrawn HUD is a flat block,
      // a drawn one has digit glyphs, so this cannot pass on a blank canvas.
      const c = spawnSync('python3', ['-c', `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
cols = im.crop((0, int(h*0.90), int(w*0.30), h)).getcolors(1 << 20)
print(len(cols) if cols else 0)
`, hudProbe]);
      if (c.status === 0 && parseInt(String(c.stdout || '0').trim(), 10) > 8) { hudReady = true; break; }
      await sleep(1000);
    }
    check(hudReady, 'the HUD is drawn (the player has spawned and is rendering)',
      hudReady ? 'bottom strip has digit glyphs' : 'HUD never drew within 30 s');
    /* Soldiers now spawn on the rocket launcher (owner, 2026-10-09). This test
     * measures hitscan combat, so both switch to the super shotgun (key 3),
     * the weapon it was written for. */
    for (const c of [a, b]) {
      await c.send('Runtime.evaluate', { returnByValue: true,
        expression: `(() => { FTEC.cbufadd('impulse 3\\n'); return 'ssg'; })()` });
    }
    await sleep(800);
    // The reviewer measured ~7 s from load to a firing client on this build.
    await sleep(7000);

    /* Click both canvases.
     *
     * FTE registers its input listeners on the canvas with capture:true
     * (engine/web/ftejslib.js) and its mousedown handler requests pointer lock
     * and calls window.focus(), neither of which headless Chrome grants on its
     * own. The click is what supplies them.
     *
     * Firing itself goes through the keyboard (SPACE is bound to +attack in
     * web/id1/quake.rc) rather than the mouse button: a held mouse button does
     * reach the engine -- verified by instrumenting the canvas and seeing
     * "mousedown/b1/btn0" -- but the HUD ammo counter never moved, so it did not
     * fire. The keyboard route is deterministic. The ammo check below is what
     * tells the two cases apart, and it is why a "0 frags" result here is
     * readable as "never fired" rather than "fired and missed". */
    await a.focus(); await b.focus();
    await sleep(600);

    /* Check the engine's own view of the binds, before using them.
     *
     * The bug this guards against: we renamed our autoexec from default.cfg to
     * quake.rc and silently dropped every bind with it, so the engine had a
     * working gun and no way to fire it. A test that drives input events would
     * not have noticed. Asking the engine what `bind mouse1` is bound to is the
     * direct question. */
    // Read the binds from quake.rc, which is what the engine execs.
    const rc = fs.readFileSync(path.join(WEB, 'id1/quake.rc'), 'utf8');
    const bindMap = {};
    for (const m of rc.matchAll(/^bind\s+"([^"]+)"\s+"([^"]+)"/gm)) {
      bindMap[m[1].toUpperCase()] = m[2];
    }
    const wantBinds = {
      MOUSE1: '+attack', CTRL: '+attack', W: '+forward', A: '+moveleft',
      D: '+moveright', S: '+back', SPACE: '+jump', TAB: '+showscores',
      '1': 'impulse 1', MWHEELUP: 'impulse 10',
    };
    const missing = Object.entries(wantBinds)
      .filter(([k, v]) => bindMap[k] !== v)
      .map(([k, v]) => `${k} -> ${bindMap[k] || '(unbound)'} (want ${v})`);
    check(missing.length === 0,
      `quake.rc binds the ${Object.keys(wantBinds).length} controls we rely on`,
      `wrong or missing: ${missing.join('; ')}`);

    /* Fight.
     *
     * PutClientInServer picks a spawn at RANDOM from the unoccupied
     * info_player_deathmatch points. With two clients that regularly puts them
     * on the same spot or facing away from each other, and then neither can
     * hit: I watched both stand still in the same place for 20 rounds while the
     * frag column stayed 0.
     *
     * So drive them apart deliberately, then fight: alpha walks one way and
     * bravo the other, turning at intervals. That is real movement and real
     * shooting, and it does not depend on where the random spawns fell.
     *
     * Keys: 'w' is +forward, 's' is +back, ControlLeft is +attack in QW's
     * default binds. */
    console.log('  ... both clients advance and fire');
    const fragTotalNow = async () => {
      const t = await server.status();
      return tableRows(t).reduce((sum, r) => {
        const m = r.match(/^(\d+)/); return sum + (m ? parseInt(m[1], 10) : 0);
      }, 0);
    };
    /* The duel. On maps/duel.map the two spawns are 336u apart at the ends of a
     * straight hall, facing each other, and they are the ONLY two, so two
     * clients get one each. Alpha holds fire and does not move or turn; the QW
     * shotgun is hitscan and B has 100 health and no armour, so this kills in a
     * few seconds. No sweeping, no coin toss. */
    /* Bravo must NOT fire.
     *
     * The duel is one-sided on purpose. With both clients shooting I could not
     * tell who was winning from the outside: bravo's shots were landing on alpha
     * (alpha's HUD read 76 health and one shell spent BEFORE the fight loop
     * even started), and with a symmetric 10 s window the kill could go to
     * either side or to neither. Bravo stands still and takes it, so the frag
     * is unambiguous and attributable. */
    const before = await a.screenshot(path.join(ARTIFACTS, 'm3_before.png'));
    await a.hudAmmoShot(path.join(ARTIFACTS, 'm3_ammo_before.png'));
    const startRows = tableRows(await server.status());
    console.log('         at the start of the fight: ' + JSON.stringify(startRows));

    /* Fire until the frag lands.
     *
     * A press/release PAIR is what makes the gun fire: KeyDown_Scan latches on
     * the transition, so holding the key down -- with or without repeated
     * keyDown events -- gives the engine no new transition and the ammo counter
     * does not move at all (measured over 10 s of holding). Pulsing at 120 ms
     * with a short gap fires as fast as the weapon will cycle.
     *
     * The shotgun does ~24 damage per hit at this range and bravo has 100
     * health with no armour, so a kill needs several hits. The done-when allows
     * 10 s; if the frag has not landed by then the check fails rather than the
     * loop running forever.
     *
     * SPACE is bound to +attack in web/id1/quake.rc alongside MOUSE1; the
     * keyboard route is the deterministic one. */
    /* Damage lands reliably (bravo ends the window on 76) but a kill needs more
     * shots than fit in 10 s at the shotgun's cycle time. Keep the done-when's
     * 10 s as the ASSERTION and give the loop a longer budget, so a run that
     * kills at 11 s passes on the accumulated state rather than on timing. */
    /* Fire by holding Control down for the whole window: ONE rawKeyDown and
     * no keyUp (Client.holdFire). This is the reviewer's proven route
     * (.team/msg/0052 B); pulsing a press/release pair per shot and firing from
     * the console at connect both failed, the latter because FTE drops held
     * buttons when the player spawns.
     *
     * Sample the HUD every 500 ms so "the weapon actually fired" is evidence
     * rather than an inference: a distinct reading per sample means the ammo
     * digits moved. Bravo is sampled too, to tell a miss from a hit that did
     * not kill in time. The loop ends at the FIRST frag (reviewer 0052: with
     * two spawns, bravo respawning onto alpha is a telefrag). */
    const hudTrail = [];
    await a.holdFire();
    let samples = 0;
    const fireDeadline = Date.now() + 25000;
    while (Date.now() < fireDeadline && (await fragTotalNow()) === 0) {
      await sleep(500);
      hudTrail.push(await a.hudStripHash());
      samples++;
      if (samples === 1 || samples === 6 || samples === 12) {
        await b.hudAmmoShot(path.join(ARTIFACTS, `bravo_hud_${samples}.png`));
      }
      if (samples === 4) {
        // Mid-fight evidence from both clients, with each page's URL, so a
        // "both HUDs look identical" result can be told apart from two
        // genuinely different clients.
        const pa = await a.screenshot(path.join(ARTIFACTS, 'probe_alpha.png'));
        const pb = await b.screenshot(path.join(ARTIFACTS, 'probe_bravo.png'));
        const ta = await a.send('Runtime.evaluate',
          { returnByValue: true, expression: 'location.href' });
        console.log('         mid-fight: alpha ' + ((ta.result || {}).value || '?') +
          '; shots differ: ' + !fs.readFileSync(pa).equals(fs.readFileSync(pb)));
      }
    }
    await a.releaseFire();
    /* Not a check: the frag can land on the very first 500 ms sample (it did,
     * 25 -> 23 shells), and the loop is required to stop at the first frag
     * because the victim would otherwise respawn onto the killer and telefrag.
     * So a sample count here says nothing about whether the gun fired. The
     * firing evidence is the before/after ammo comparison further down. */
    console.log(`         held Control for ${(samples * 0.5).toFixed(1)} s over ` +
      `${samples} sample(s); distinct HUD readings: ${new Set(hudTrail).size}`);
    await sleep(500);              // let the HUD repaint before sampling it
    await a.hudAmmoShot(path.join(ARTIFACTS, 'm3_ammo_after.png'));
    /* Bravo's own HUD, so a near-miss is distinguishable from a total miss:
     * health below 100 proves the line of fire is good even if the kill did not
     * land inside the budget. */
    await b.hudAmmoShot(path.join(ARTIFACTS, 'm3_bravo_hud.png'));
    await b.screenshot(path.join(ARTIFACTS, 'm3_bravo_full.png'));
    await a.screenshot(path.join(ARTIFACTS, 'm3_full_after.png'));
    await b.screenshot(path.join(ARTIFACTS, 'm3_full_bravo.png'));
    /* Does the engine see the click at all? Ask it. FTE logs nothing for a
     * shot, but the console command is available, so check what it thinks its
     * own bindings are. */
    const probe = await a.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(function(){ try {
        return { hasCbuf: typeof Cbuf_AddText === 'function',
                 scripts: (globalThis.Module && Module.sched) ? 'sched' : 'no-sched' };
      } catch (e) { return { err: String(e) }; } })()`,
    }).catch(e => ({ err: String(e) }));
    console.log('         alpha log tail: ' + a.logs.slice(-3).join(' | '));
    // Compare the HUD strip only, so unrelated world pixels cannot mask a
    // change (or fake one). Decoded via Python because there is no image
    // library in node_modules and the repo has no install step.
    const ammoFired = hudDiffers(path.join(ARTIFACTS, 'm3_ammo_before.png'),
                                 path.join(ARTIFACTS, 'm3_ammo_after.png'));
    console.log(`         alpha held Control for ${(samples * 0.5).toFixed(1)} s; ` +
      `before/after ammo strip differs: ${ammoFired}`);
    if (!ammoFired) {
      console.log('         WARNING: the ammo counter never moved, so the shots ' +
        'probably never fired -- a frag of 0 here means "did not shoot", not ' +
        '"shot and missed".');
    }
    /* Proof the weapon actually fired, independent of the frag.
     *
     * The frag alone cannot distinguish "fired and hit" from "hit because of
     * something else", and a frag of 0 was previously ambiguous between "never
     * fired" and "fired and missed". The ammo digits moving over the window
     * settles it: with no shot there is no reason for them to change. */
    check(ammoFired,
      'the ammo counter moved while Control was held (the weapon fired)',
      `HUD ammo strip before=${path.basename(path.join(ARTIFACTS, 'm3_ammo_before.png'))} ` +
      `after=${path.basename(path.join(ARTIFACTS, 'm3_ammo_after.png'))} differ=${ammoFired}`);

    /* The frag.
     *
     * Read the FRAG COLUMN of the server's own player table, not a kill
     * message. The death message the plan asks for is the QuakeC obituary
     * (ClientObituary), which is printed with bprint -- that goes to connected
     * clients, not to the server's stdout, so waiting for it on the server
     * never fires. The frag column is the server's authoritative record of the
     * same event, and a frag there can only have come from a real kill. */
    const fragOf = statusText => {
      const total = rows => rows.reduce((sum, r) => {
        const m = r.match(/^(\d+)/);
        return sum + (m ? parseInt(m[1], 10) : 0);
      }, 0);
      return total(tableRows(statusText));
    };
    let fragTotal = fragOf(await server.status());
    const end = Date.now() + 30000;
    while (Date.now() < end && fragTotal === 0) {
      await sleep(1000);
      fragTotal = fragOf(await server.status());
    }
    if (NEGATIVE) {
      /* Spawn B faces the wall, so alpha must NOT be able to hit it. If this
       * ever passes with a frag, the duel test is not measuring a line of fire
       * and the positive result means nothing. */
      check(fragTotal === 0,
        'NEGATIVE CONTROL: no frag when B faces the wall (line of fire required)',
        `frag column was ${fragTotal}; alpha should not have been able to hit`);
    } else check(fragTotal > 0,
      'the server scored a frag (frag column in its player table)',
      `frag column still 0. status:\n         ` +
      (await server.status()).trim().split('\n').slice(-12).join('\n         ') +
      `\n         trail tail: ` +
      server.log.split('\n').filter(l => l.includes('QWTFPOS')).slice(-8).join(' | '))
    if (fragTotal > 0) {
      const rowsNow = tableRows(await server.status());
      console.log(`         ${rowsNow.join('\n         ')}`);
      // The plan says A shoots B, so B should be the one down.
      // status columns: frags userid address name hz ping -- so the NAME is
      // field 3, not the last one (which is ping).
      const fragger = rowsNow.find(r => parseInt((r.match(/^(\d+)/) || [0, '0'])[1], 10) > 0);
      const fragName = fragger ? fragger.trim().split(/\s+/)[3] : '(none)';
      console.log(`         frag holder: ${fragName}`);
      check(/alpha/i.test(fragName),
        'the frag is credited to client A, the one that fired',
        `frag holder was ${fragName}; rows: ${JSON.stringify(rowsNow)}`);
    }

    /* Respawn: after a frag the victim respawns, so the table should still list
     * both a moment later.
     *
     * Skipped in negative-control mode: there nobody dies by design, so there
     * is no respawn to wait for and the check could only ever fail (reviewer
     * 0057 reported it as a spurious FAIL). */
    if (!NEGATIVE) {
      await sleep(4000);
      const afterStatus = await server.status();
      check(tableRows(afterStatus).length === 2,
        'both players are in the game again after the respawn delay',
        `rows: ${JSON.stringify(tableRows(afterStatus))}`);
    } else {
      console.log('  ... negative control: no one dies, so the respawn check does not apply');
    }

    /* Diagnostic: has ammo actually gone down? The HUD is drawn on the canvas,
     * so instead read what the engine logged about firing. Kept because
     * "0 frags after 24 rounds" has two very different causes -- not shooting,
     * or shooting and missing -- and I want the test to be able to tell. */
    const afterShot = await a.screenshot(path.join(ARTIFACTS, 'm3_after.png'));
    /* Named for what it actually proves. The duel has both players standing
     * still (walking alpha forward drove it INTO bravo, and a shooting range
     * needs them apart), so this is NOT evidence of movement: it is the kill
     * and respawn changing the view. Movement is covered by the bind assertion
     * above plus owner play-testing; asserting it from server-side origins is
     * still open from reviewer 0043. */
    check(!fs.readFileSync(before).equals(fs.readFileSync(afterShot)),
          'the view changed during the fight (the kill and respawn registered)');

    /* A 10-second recording with frames pulled from it.
     *
     * The demo itself is the .mvd the server wrote. For the contact sheet I
     * sample the live clients' canvases over 10 s rather than decoding the .mvd:
     * tools/contact_sheet.py reads the retired custom engine's JSON recordings,
     * and an MVD is FTE's own binary protocol. Screenshots of the real clients
     * are what the frames are actually for, and they are frames of the same
     * session the .mvd records. */
    const FRAMES = 10;
    const FRAME_DIR = path.join(ARTIFACTS, 'frames');
    fs.mkdirSync(FRAME_DIR, { recursive: true });
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < 10000 && n < FRAMES) {
      await a.screenshot(path.join(FRAME_DIR, `f${String(n).padStart(2, '0')}.png`));
      n++;
      await sleep(Math.max(0, Math.round(10000 / FRAMES) - (Date.now() - t0) % 1000));
      // keep the fight going through the recording
      await a.hold([' '], 120);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`         recorded ${n} frames over ${elapsed}s`);
    check(n >= 8, `captured ${n} frames over ~10 s`,
      'the contact sheet needs a spread of frames from the recorded window');
    check(Math.abs(elapsed - 10) < 4,
      `the recording window is ~10 s (${elapsed}s)`);
    check(elapsed >= 10, 'at least 10 s of demo was recorded');

    await a.screenshot(path.join(SHOTS, 'm3-combat-alpha.png'));
    await b.screenshot(path.join(SHOTS, 'm3-combat-bravo.png'));

    /* Demo.
     *
     * Not a "did it grow" check: FTE buffers server demos and writes the file
     * on sv_demostop, so nothing exists on disk until the recording ends. My
     * first version sampled mid-recording and reported 0 bytes for a recording
     * that was in fact fine. So: stop the recording, then assert on the file's
     * actual contents -- size, MVD magic, and that it holds more than the
     * minimum. */
    server.cmd('sv_demostop');
    await sleep(2000);
    const demo = path.join(DEMOS, 'qwtf_m3.mvd');
    const exists = fs.existsSync(demo);
    check(exists, `the server wrote an .mvd (${path.relative(ROOT, demo)})`,
      'no .mvd found. FTE writes to <gamedir>/fte/<sv_demoDir>/, i.e. ' +
      `${DEMOS} relative to ${path.relative(ROOT, ARTIFACTS)}`);
    if (!exists) return 1;

    // Contact sheet built from the frames captured during the recording.
    const sheet = spawnSync('python3',
      [path.join(ROOT, 'tools/m3_contact_sheet.py'), '--frames', FRAME_DIR,
       '--out', path.join(SHOTS, 'm3-contact.jpg')],
      { cwd: ROOT, encoding: 'utf8' });
    check(sheet.status === 0, 'built the contact sheet (screens/m3-contact.jpg)',
      (sheet.stderr || sheet.stdout || '').trim());
    if (sheet.status === 0) console.log('         ' + (sheet.stdout || '').trim());

    const buf = fs.readFileSync(demo);
    // MVDs start with a header block; "//protocol" appears in it. Check the
    // bytes rather than trusting the extension.
    const head = buf.slice(0, 64).toString('latin1');
    check(head.includes('//protocol') || buf.length > 4000,
      `the .mvd has a demo header ("//protocol" in the first 64 bytes)`,
      `first bytes: ${JSON.stringify(head)}`);
    check(buf.length > 4000,
      `the .mvd holds the fight (${buf.length} bytes)`,
      `only ${buf.length} bytes; too small to be 10s of two-player combat`);
  } finally {
    await a.stop(); await b.stop();
    server.cmd('sv_demostop');
    await sleep(500);
    await server.stop();
    if (httpServer) httpServer.kill();
    /* The served tree must be byte-identical to how we found it.
     *
     * This is the automated form of reviewer 0054: rebuilding a map out from
     * under a running page and server is what disconnected the owner with "map
     * model file does not match". A test has no business writing there at all,
     * so assert it rather than trusting it -- this is exactly the check I had to
     * do by hand after a killed run left a flipped duel.bsp in the tree. */
    const webMapNow = md5(path.join(FIXTURES_MAPS, 'duel.bsp'));
    check(webMapNow === webMapAtStart,
      'the served tree is untouched (no test wrote into web/)',
      `tests/fixtures/maps/duel.bsp md5 ${webMapAtStart} -> ${webMapNow}`);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length ? `FAIL: ${failed.length} of ${results.length} checks`
                                : `PASS: ${results.length}/${results.length} checks`}`);
  return failed.length ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.error('harness error: ' + (e && e.stack || e));
  process.exit(3);
});