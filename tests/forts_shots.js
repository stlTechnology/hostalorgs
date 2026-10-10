/*
 * The forts map's screenshots, in the real engine on the real map.
 *
 *   node tests/forts_shots.js [--port N]
 *
 * PLAN.md M4a asks for "an overhead screenshot of the layout plus a first-person
 * run from flag to flag". This file is the screenshot half of that, and it exists
 * as its own thing rather than as a mode of tests/flag_run.js because the two have
 * different jobs: flag_run.js ASSERTS a walk (positions from the server, arrival
 * asserted), and a screenshot taken along a walk that did not arrive is a picture
 * of the wrong place. Here every viewpoint is proven walkable FIRST, by
 * scripts/map_route.py over the map's own boxes, and only then is the camera put
 * there -- by the server, which is authoritative over the player entity, so the
 * picture is the real server's view of the real map and not a client-side guess.
 *
 * All coordinates are WORLD units, read from gen_map.py:
 *
 *   * the spawn and the key/stand positions come out of the map's own ENTITY list,
 *     which gen_map emits already scaled by FORTS_SCALE (0240 -- the owner asked
 *     for "about 4 times larger overall"), so a viewpoint cannot drift from the map
 *     the way a hardcoded 328 did the moment the scale changed;
 *   * the walkable targets come from map_route.py --map forts, which works in world
 *     units for the same reason.
 *
 * Outputs, all under tests/artifacts/flag_run/forts/:
 *   NN-<label>.png   the view
 *   route.json       the route each viewpoint was proven reachable by
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
const WEB = path.join(ROOT, 'web');
/* Per run, like tests/ctf_rules.js: a shared gamedir means two runs delete each
 * other's staged content while the client is loading out of it (0239). */
const RUN = path.join(ART, 'run-shots-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const SHOTS = path.join(ART, 'flag_run', 'forts');
const LOG = path.join(RUN, 'server.log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0;
const ok = (what) => { console.log(`  ok   ${what}`); passed++; };
const bad = (what, detail) => {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
};
const check = (c, what, detail) => (c ? ok(what) : bad(what, detail));

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/* Every position this file needs, in world units, out of gen_map. */
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
  '    "spawn_a": origin("info_player_deathmatch"),',
  '    "ground": g.sc(g.FORTS_GROUND_Z),',
  '    "bed": g.sc(g.FORTS_BED_Z),',
  '    "water": g.sc(g.FORTS_WATER_TOP),',
  '    "bridge": g.sc(g.FORTS_BRIDGE_Z),',
  '    "roof": g.sc(g.FORTS_ROOF_Z),',
  '    "vault_floor": g.sc(g.FORTS_VAULT_Z),',
  '    "len": g.sc(g.FORTS_LEN),',
  '    "wid": g.sc(g.FORTS_WID),',
  '    "hull": g.HULL_HEIGHT,',
  '    "scale": g.FORTS_SCALE,',
  '}))',
].join('\n');

function geo() {
  const r = sh('python3', ['-c', GEO_PY], { cwd: ROOT });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return null; }
}

/* A walkable route between two WORLD points, or null. */
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

/* The server, which is what puts the camera somewhere: qwtf/probe.qc reads the
 * serverinfo cvars qwtf_gx/gy/gz and qwtf_gseq and sets the player there. The
 * counter makes it one-shot -- while the keys stayed set, PlayerPreThink re-applied
 * setorigin every frame and the player could not be moved at all (0203). */
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
    ], { cwd: ROOT, stdio: ['pipe', this.out, 'pipe'], detached: true });
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr || '') + d; });
    for (let i = 0; i < 200; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(fs.readFileSync(LOG, 'utf8'))) return true;
      if (this.proc.exitCode !== null) break;
    }
    return /Quake Initialized/.test(fs.readFileSync(LOG, 'utf8'));
  }
  command(c) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(c + '\n'); }
  /* `yaw` is in degrees, Quake's way: 0 looks along +x, 90 along -y, 180 along -x.
   * Without it every picture is taken in whatever direction the player happened to
   * be facing when they spawned, which is how "the fort front" came out as a close
   *-up of a wall. */
  goto(x, y, z, seq, yaw) {
    this.command(`serverinfo qwtf_gx ${x}`);
    this.command(`serverinfo qwtf_gy ${y}`);
    this.command(`serverinfo qwtf_gz ${z}`);
    if (yaw !== undefined) this.command(`serverinfo qwtf_face ${yaw}`);
    this.command(`serverinfo qwtf_gseq ${seq}`);
  }
  async stop() {
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { fs.closeSync(this.out); } catch (e) {}
  }
}

/* Just enough browser to load the page and capture the canvas, over the repo's own
 * CDP client (tests/cdp.js) -- CDP is a WebSocket, and a WebSocket needs the
 * handshake, which curl does not do. The click is not optional: a canvas that has
 * never been clicked delivers no key events to the engine (the M3 lesson), and
 * without input the engine's view never updates. */
class Client {
  constructor(cdp) { this.cdp = cdp; this.nextId = 1; this.pending = new Map(); }
  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-shots-'));
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.cdp}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1024,576', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    this.ws = await WS.connect(info.webSocketDebuggerUrl,
                               m => this.onMessage(m));
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
    await this.send('Page.navigate', { url });
    /* Generous: SwiftShader compiling shaders for a 580 KB BSP. The signon
     * deadline in tests/ctf_rules.js is 90 s for the same reason. */
    for (let i = 0; i < 480; i++) {
      await sleep(250);
      const c = await this.eval(`(() => { const c = document.getElementById('canvas');
        return c ? 1 : 0; })()`);
      if (c) { await this.clickCanvas(); return true; }
    }
    throw new Error('the page never showed a canvas');
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true });
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
  async screenshot(file) {
    await sleep(600);
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return fs.statSync(file).size;
  }
  async stop() {
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

async function main() {
  stage();
  const G = geo();
  if (!G) { bad('gen_map answered with the map geometry'); return; }
  console.log(`forts at scale ${G.scale}: hull ${G.len}x${G.wid}, key A ` +
              `${G.key_a}, spawn ${G.spawn_a}`);

  const PORT = 20000 + (process.pid % 20000), HTTP = PORT + 1;
  const CDP = 10000 + (process.pid % 20000);
  const server = new Server(PORT);
  if (!await server.start()) { bad('the server started', (server.stderr || '').slice(-300)); return; }
  const page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
    '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
  const client = new Client(CDP);
  let seq = 0;
  const views = [];
  try {
    await sleep(1500);
    await client.start('http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=photog&autojoin=1');
    /* Wait for the join: a capture before the player entity exists is a canvas of
     * the sky and nothing else. */
    let joined = false;
    for (let i = 0; i < 240 && !joined; i++) {
      await sleep(500);
      joined = /photog joined/.test(fs.readFileSync(LOG, 'utf8'));
    }
    check(joined, 'the camera player joined the server',
          `no "photog joined" in ${LOG} after 120s: ` +
          `${(fs.readFileSync(LOG, 'utf8').match(/Client command: (\w+)/g) || []).slice(-1)}`);

    /* THE LOBBY (2026-10-09): the join is held until both picks are made, and
     * a waiter is an invisible noclip camera with no weapon on screen. The
     * photographs are of a player's view, so give the camera its body back. */
    await client.eval('window.QWTF_MENU.do("team_auto")');
    await sleep(700);
    await client.eval('window.QWTF_MENU.do("cls_soldier")');
    let dressed = false;
    for (let i = 0; i < 60 && !dressed; i++) {
      await sleep(500);
      try { dressed = /QWTF_EVENT class_stats photog class=soldier/.test(fs.readFileSync(LOG, 'utf8')); } catch (e) {}
    }
    check(dressed, 'the lobby spawn landed for the camera (class_stats photog/soldier)');

    const gy = G.ground;
    const standing = gy + 24;         // a player origin is 24 above the floor
    /* yaw: 0 looks along +x, 90 along -y, 180 along -x, 270 along +y. Fort A is at
     * low x, so everything that looks at it looks along -x. */
    const spec = [
      ['spawn-hall', 'the spawn hall, looking down the fort', G.spawn_a, 0],
      ['fort-front', 'the fort front, from the bridge head',
        [G.key_a[0] + 640, G.wid / 2, G.bridge + 24], 180],
      ['fort-across', 'the far fort, across the water',
        [G.len / 2, G.wid / 2, G.bridge + 24], 180],
      ['lookout', 'the battlement, over the water',
        [G.key_a[0] + 128, G.wid / 2, G.roof + 64], 180],
      ['channel', 'down in the water channel', [G.len / 2, 512, G.bed + 96], 90],
      ['underwater', 'the underwater passage, looking in',
        [G.key_a[0] + 96, G.wid / 2, G.bed + 24], 0],
      /* Down the corridor looking AT the key, not standing on it: the camera 256
       * short of the key and facing east, so the picture has the key, the corridor
       * and the dog-leg in it. Standing on the key and looking north gave a
       * close-up of the passage wall 32 units away. */
      ['vault', 'the basement key vault',
        [G.key_a[0] - 256, G.key_a[1], G.vault_floor + 24], 0],
    ];
    /* Prove each viewpoint walkable BEFORE photographing it. A viewpoint that
     * cannot be routed is a viewpoint nobody gets a picture of, and it is also the
     * defect -- which is how the compressed stairs were found. */
    const from = G.spawn_a;
    const proof = {};
    for (const [label, what, at] of spec) {
      const wps = route(from, at);
      proof[label] = { what, at, ok: !!wps, waypoints: wps ? wps.length : 0 };
      check(!!wps, `reachable on foot: ${what}`,
            'no route from the spawn to that point; it will not be photographed');
    }
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, 'route.json'),
                     JSON.stringify(proof, null, 1));

    let n = 1;
    for (const [label, what, at] of spec) {
      if (!proof[label].ok) continue;
      seq += 1;
      server.goto(at[0], at[1], at[2], seq, spec.find(v => v[0] === label)[3]);
      await sleep(1500);
      const file = path.join(SHOTS,
        `${String(n).padStart(2, '0')}-${label}.png`);
      const size = await client.screenshot(file);
      /* A black canvas is 20 KB or less in practice; the old shots are 100-400 KB.
       * Anything under that is a failed picture reported as a successful one. */
      check(size > 20000, `${String(n).padStart(2, '0')}-${label}.png is a real ` +
            `picture (${(size / 1024).toFixed(0)} KB)`, `only ${size} bytes`);
      views.push(file);
      n += 1;
    }
    check(views.length >= 5, `${views.length} viewpoints photographed`,
          'fewer than five: the map is not being looked at');
  } catch (e) {
    bad('the screenshot run completed', e && e.message);
  } finally {
    await client.stop();
    try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {
      try { page.kill('SIGKILL'); } catch (e2) {}
    }
    await sleep(300);
    await server.stop();
    try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) {}
  }
}

main().then(() => {
  console.log('');
  console.log(`  shots: ${SHOTS}`);
  console.log(failed ? `FAIL: ${failed} of ${passed + failed} checks`
                      : `PASS: ${passed} checks`);
  process.exit(failed ? 1 : 0);
}).catch(e => { console.error('Error:', e && e.message); process.exit(1); });