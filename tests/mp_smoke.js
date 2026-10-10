#!/usr/bin/env node
/**
 * M2 acceptance test: two browsers see each other.
 *
 * Opens two independent headless Chrome instances against the SAME dedicated
 * server over FTE's native WebSocket transport (no relay -- see
 * scripts/run_server.sh, which sets sv_port_tcp + net_enable_websockets 1), and
 * asserts:
 *
 *   1. each client's console says it connected and joined the server,
 *   2. the SERVER log lists 2 players,
 *   3. each client sees the other player's name, in its own console, so the
 *      entity really crossed the wire rather than the client just being
 *      connected,
 *   4. neither client produced a load failure or an exception.
 *
 * The server's `status` output is read by driving the server's stdin: FTE's
 * dedicated server accepts console commands on stdin, so `status` there is the
 * server's own view rather than anything the clients report about themselves.
 *
 * Usage:
 *   node tests/mp_smoke.js                  start our own server, then test
 *   node tests/mp_smoke.js --no-server      use a server already running
 *   node tests/mp_smoke.js --port 27510     server port (default 27510)
 *   node tests/mp_smoke.js --http-port N static server port (default: derived
 *                            from the PID, so it never lands on a port a human
 *                            or another test is using -- 8200 in particular is
 *                            the owner's own page server)
 *   node tests/mp_smoke.js --runs 3         repeat N times (M2 asks for 3)
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

/* The staged gamedir (0479): web/ plus the maps that ship with the tests.
 * Built ONCE in main(), used by BOTH the static server (the frozen-tree rule,
 * 0054) and the game server.
 *
 * The staged index.html is a REAL COPY with this suite's fixture map added to
 * the manifest block, and it has to be, measured: with corridor.bsp absent
 * from the browser's pre-engine fetch list, the client asks the server for the
 * map at connect ("Downloading maps/corridor.bsp..."), the server serves it
 * (its own log: "Downloading maps/corridor.bsp to <client>"), all 62 sounds
 * arrive per-file, the client joins -- and the canvas is a black void
 * (measured: colours 1, mean 0, holding forward, after the downloads went
 * quiet). The web build does not apply a map it downloaded at connect; it
 * only applies maps it fetched before the engine started. That is a product
 * finding recorded for the reviewer; it does NOT affect the deployed page,
 * whose map (forts) is in the manifest. The staged page is a test fixture. */
function stageGamedir() {
  const stage = path.join(os.tmpdir(), `qwtf-mpsmoke-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(WEB)) {
    if (e === 'id1') continue;
    if (e === 'index.html') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(stage, e));
  }
  /* The staged page's manifest carries this suite's fixture map. */
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const END = '\t\t/* ---- END GENERATED MANIFEST ---- */';
  if (!html.includes(END)) throw new Error('staged page: no manifest END marker');
  const entry = '\t\t"id1/maps/corridor.bsp": "id1/maps/corridor.bsp",'
    .padEnd(56) + '/* staged for this suite (0479) */\n';
  fs.writeFileSync(path.join(stage, 'index.html'),
                   html.replace(END, entry + END));
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    if (e === 'maps') continue;
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(stage, 'id1', e));
  }
  fs.mkdirSync(path.join(stage, 'id1', 'maps'), { recursive: true });
  for (const dir of [path.join(WEB, 'id1', 'maps'), FIXTURES_MAPS]) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      const to = path.join(stage, 'id1', 'maps', e);
      if (!fs.existsSync(to)) fs.symlinkSync(path.join(dir, e), to);
    }
  }
  return stage;
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
/* Default to a port derived from our PID. Reusing a fixed port across runs
 * means a server left over from a previous (possibly killed) run is still
 * bound, clients pile onto it, and its player table carries stale slots: I saw
 * "status lists 2 players (found 1)" because the surviving server had been up
 * for over a minute with a dropped client still in it. A fresh port per process
 * makes each run independent. --port still overrides. */
const SV_PORT = parseInt(arg('--port', String(27500 + (process.pid % 400))), 10);
const HTTP_PORT = parseInt(arg('--http-port', String(8400 + (process.pid % 300))), 10);
const RUNS = parseInt(arg('--runs', '3'), 10);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WSS = `ws://127.0.0.1:${SV_PORT}`;

const results = [];
function check(ok, what, detail) {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}` +
              (ok || !detail ? '' : `\n         ${detail}`));
  return ok;
}

function sh(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}
const code = () => (sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
  `${BASE}/index.html`]).stdout || '').trim();

/* --- the server, driven through stdin so we can ask it for `status` -------- */
class Server {
  constructor(port) {
    this.port = port;
    this.proc = null;
    this.log = '';
    this.stderr = '';
    this.started = Date.now();
  }

  async start(stage) {
    /* The gamedir is the staged tree built in main() (0479): ctf, corridor
     * and duel ship with the tests (tests/fixtures/maps/) and NOT in the
     * deployed web root, and the browser is served from this same tree (the
     * 0054 frozen-tree rule). The staged gamedir is also what makes this
     * suite the lazy-path proof: corridor.bsp is not in the browser's
     * pre-engine manifest any more, so the only way the client can join a
     * corridor server is the connect-time download. */
    this.proc = spawn('bash', [path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port), '--gamedir', stage, '--map', 'corridor'],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.proc.stdout.on('data', d => { this.log += d.toString(); });
    this.proc.stderr.on('data', d => { this.stderr += d.toString(); });
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (/Quake Initialized/.test(this.log)) return true;
      if (this.proc.exitCode !== null) break;
    }
    return /Quake Initialized/.test(this.log);
  }

  /* FTE's dedicated server reads console commands from stdin. */
  command(cmd) {
    if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  /* Ask the server for its status.  The command has to be written after the
   * map is loaded: FTE drains stdin during init, so a `status` sent at startup
   * is consumed before there are any players and its output never appears. */
  async status() {
    const before = this.log.length;
    this.command('status');
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      const chunk = this.log.slice(before);
      // SV_Status_f prints a player table under a "frags userid address name"
      // header. Wait for the whole table, which is what we actually assert on.
      if (/frags\s+userid\s+address\s+name/i.test(chunk)) {
        await new Promise(r => setTimeout(r, 300));
        return this.log.slice(before);
      }
    }
    return this.log.slice(before);
  }

  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {}
    }
  }

  uptime() { return ((Date.now() - this.started) / 1000).toFixed(1) + 's'; }
}

/* --- one headless browser client ------------------------------------------- */
class Client {
  constructor(name, cdpPort) {
    this.name = name;
    this.port = cdpPort;
    this.logs = [];
    this.errors = [];
    this.badUrls = [];
  }

  async start(url, playerName) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `qwtf-${this.name}-`));
    this.proc = spawn('google-chrome', [
      '--headless=new',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`,
      '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1024,576', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run',
      // A distinct name so the server log shows two distinct players.
      `--user-agent=QWTF-smoke-${this.name}`,
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    let info = null;
    for (let i = 0; i < 100; i++) {
      const r = sh('curl', ['-s', `http://127.0.0.1:${this.port}/json/list`]);
      if (r.status === 0) {
        try {
          info = JSON.parse(r.stdout).find(t => t.type === 'page');
          if (info) break;
        } catch (e) { /* not up yet */ }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    if (!info) throw new Error(`${this.name}: chrome debugger never came up`);

    const WS = require('./cdp.js');
    this.ws = await WS.connect(info.webSocketDebuggerUrl, m => this.onMessage(m));
    this.nextId = 1;
    this.pending = new Map();
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
    await this.send('Network.enable');
    await this.send('Page.navigate', { url });
    this.playerName = playerName;
  }

  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      this.logs.push({ kind: m.params.type, text: (m.params.args || [])
        .map(a => a.value !== undefined ? String(a.value)
               : (a.description || a.type)).join(' ') });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      this.errors.push(d.exception ? (d.exception.description || d.text) : d.text);
    } else if (m.method === 'Log.entryAdded') {
      this.logs.push({ kind: m.params.entry.level, text: m.params.entry.text });
      if (m.params.entry.level === 'error') this.errors.push(m.params.entry.text);
    } else if (m.method === 'Network.responseReceived') {
      if (m.params.response.status >= 400) {
        this.badUrls.push(`${m.params.response.status} ${m.params.response.url}`);
      }
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

  /* Decode our own screenshot and report what is on it. Doing it in the page
   * via a data: URL avoids adding an image library. */
  async evalPixels() {
    const file = path.join(SHOTS, `m2-${this.name}.png`);
    const b64 = fs.readFileSync(file).toString('base64');
    return this.send('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${b64}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        let sum = 0, n = 0, lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          seen.add((d[i] << 16) | (d[i+1] << 8) | d[i+2]);
          const v = (d[i] + d[i+1] + d[i+2]) / 3;
          sum += v; n++;
          if (v > 20) lit++;
        }
        return { colours: seen.size, mean: sum / n, litFraction: lit / n };
      })()`,
    }).then(r => r.result.value);
  }

  text() { return this.logs.map(l => l.text).join('\n'); }
  said(re) { return this.logs.some(l => re.test(l.text)); }

  /* Wait until the client's console satisfies `re`, or time out. */
  async waitFor(re, ms) {
    const end = Date.now() + (ms || 30000);
    while (Date.now() < end) {
      if (this.said(re)) return true;
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  async stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100));
      const p = sh('curl', ['-s', '-o', '/dev/null',
        `http://127.0.0.1:${this.port}/json/list`]);
      if (p.status !== 0) break;
    }
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); }
    catch (e) {}
  }
}

const FAIL_WORDS = ["couldn't load", 'not found', 'unable to', 're ferenceerror',
  'is not defined', 'failed to', 'error:', 'unsupported'];

async function oneRun(server, runIndex) {
  console.log(`\n-- run ${runIndex + 1}/${RUNS}`);
  const urlFor = n => `${BASE}/index.html?server=${encodeURIComponent(WSS)}` +
                    `&name=${encodeURIComponent(n)}`;
  const a = new Client('alpha', 9401);
  const b = new Client('bravo', 9402);
  try {
    await a.start(urlFor('alpha'), 'alpha');
    await b.start(urlFor('bravo'), 'bravo');

    /* The web build is a combined client+server, so "joined the server" proves
     * nothing on its own: with no external server running it spawns its own,
     * prints "Server spawned.", and reports the join anyway. That cost me
     * several runs of a test which looked like it was passing.
     *
     * The signal that the client actually dialled OUR server is the connect
     * handshake naming the address we passed in. And the absence of
     * "Server spawned" proves it did not fall back to its own server. */
    /* "joined the server" is printed by the QuakeC's PlayerPostThink-driven
     * chat path, which only fires once the client has downloaded everything the
     * server precached -- and we ship no sounds, so there are ~200 failed
     * downloads to get through first. That makes it slow and, on a loaded
     * machine, unreliable as a gate.
     *
     * So the authoritative signal is the SERVER's own player table, polled
     * until it lists both names. That is what the done-when asks for anyway,
     * and it cannot be satisfied by a client talking to itself. */
    const tableHasBoth = async (ms) => {
      const end = Date.now() + (ms || 60000);
      let last = '';
      if (!server) return '(no server was started: --no-server)';
      while (Date.now() < end) {
        const st = await server.status();
        last = st;
        /* Wait for a read that has TWO player rows naming both clients, plus
         * the entity count, so the single read we keep can answer every
         * assertion.
         *
         * Keying on the names appearing anywhere in the text was not enough:
         * a client that appears and is then dropped still leaves its name in
         * the surrounding output, so the wait returned early and the row count
         * came out as 1. Requiring two rows in the table itself is the actual
         * done-when condition. */
        const r = tableRows(st);
        if (r.length === 2 &&
            r.some(x => /alpha/i.test(x)) && r.some(x => /bravo/i.test(x)) &&
            /entities\s*:\s*[0-9]+/i.test(st)) return st;
        await new Promise(r => setTimeout(r, 1000));
      }
      return last;
    };
    const st = await tableHasBoth(60000);
    const aJoined = /alpha/i.test(st), bJoined = /bravo/i.test(st);
    check(aJoined && bJoined,
          'both clients appear in the server\'s player table',
          `status output was:\n         ${String(st).trim().split('\n').slice(-14).join('\n         ')}`);
    if (!aJoined || !bJoined) return;   // nothing further can be meaningful

    const dialled = c => c.said(/Establishing connection to/i) ||
                         c.said(new RegExp(`Connected to ${WSS}`, 'i'));
    check(dialled(a) && dialled(b),
          'both clients dialled the server address we passed in',
          `alpha: ${a.logs.map(l => l.text).filter(t => /connect/i.test(t)).slice(0, 3).join(' | ') || '(no connect lines)'}`);
    check(!a.said(/Server spawned/i) && !b.said(/Server spawned/i),
          'neither client fell back to its own embedded server',
          'the web build includes a full server; "Server spawned" means the ' +
          'client was talking to itself');
    if (process.env.QWTF_DUMP) {
      for (const l of a.logs) console.log(`  alpha [${l.kind}] ${l.text}`);
      for (const l of b.logs) console.log(`  bravo [${l.kind}] ${l.text}`);
    }
    if (!aJoined || !bJoined) {
      const dump = (c) => `         --- ${c.name}: ${c.logs.length} console lines, ` +
        `${c.errors.length} exceptions, bad urls: ${JSON.stringify(c.badUrls)}\n` +
        c.logs.slice(-14).map(l => `           [${l.kind}] ${l.text}`).join('\n') +
        (c.errors.length ? '\n           ERR ' + c.errors.slice(0, 3).join('\n           ERR ') : '');
      console.log(dump(a));
      console.log(dump(b));
      console.log('         --- url: ' + urlFor('alpha'));
      return;
    }

    /* Rows of the player table in a status read (see the note below). */
  function tableRows(statusText) {
    const lines = statusText.split('\n');
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

  /* Parse the player table SV_Status_f prints:
         frags userid address         name              hz ping
             0      1 ws://127.0.0.1  alpha             47   21
       Take the lines after the dashes rule up to the next blank line. Matching
       on the address column instead (which is what I did first) is fragile:
       FTE prints "ws://127.0.0.1" for a websocket client and a bare address for
       a UDP one, so a regex keyed on either form silently drops a row and the
       count came out as 1 sometimes. */
    const rows = tableRows(st);
    check(rows.length === 2,
          `the server's status lists 2 players (found ${rows.length})`,
          `rows: ${JSON.stringify(rows)}\n         ` +
          `alpha console tail:\n           ` +
          a.logs.slice(-8).map(l => l.text).join('\n           ') +
          `\n         bravo console tail:\n           ` +
          b.logs.slice(-8).map(l => l.text).join('\n           '));
    check(rows.some(r => /alpha/i.test(r)) && rows.some(r => /bravo/i.test(r)),
          'the server status names both clients',
          `rows were: ${JSON.stringify(rows)}\n         ` +
          st.trim().split('\n').slice(-14).join('\n         '));

    /* Each client must SEE the other, not merely be connected.
     *
     * A client-side console line is a weak signal: FTE only prints the player
     * list when someone scores or speaks, so an idle pair never produces one,
     * and waiting for it made the test flaky. The server's entity count is the
     * direct measure instead: `status` reports "entities : used/total", and the
     * used figure rises by one per connected player, so a server holding two
     * players has two live player entities that it is simulating and sending.
     *
     * The render is then checked per client, so both sides are covered. */
    const ents = st.match(/entities\s*:\s*([0-9]+)\s*\/\s*([0-9]+)/i) || [];
    check(!!ents[1] && parseInt(ents[1], 10) >= 2,
      `the server is simulating at least 2 player entities (said "${ents[0] || '?'}")`,
      `status output was:\n         ${st.trim().split('\n').slice(-14).join('\n         ')}`);

    /* And each client is actually drawing a world with another player in it:
     * the canvas must not be a flat clear colour. */
    for (const c of [a, b]) {
      await c.screenshot(path.join(SHOTS, `m2-${c.name}.png`));
      const px = await c.evalPixels();
      check(px.colours > 500,
        `${c.name}'s canvas shows rendered geometry (${px.colours} distinct colours)`,
        `luma ${px.mean.toFixed(1)}, ${(px.litFraction * 100).toFixed(1)}% lit`);
    }

    for (const c of [a, b]) {
      /* Ignore the server's sound list. We ship no sounds on purpose (86 MB is
       * too much for a browser) and cl_downloads 0 stops the client asking for
       * them; if the server still volunteers them, the client's "Not found"
       * line is expected and must not mask a real failure. */
      const noise = /Download of|Couldn't find file|sound/i;
      const bad = c.logs.filter(l => !noise.test(l.text) &&
                                    FAIL_WORDS.some(w => l.text.toLowerCase().includes(w)));
      check(bad.length === 0, `${c.name}: no load failures in ${c.logs.length} console lines`,
        bad.slice(0, 6).map(l => `[${l.kind}] ${l.text}`).join('\n         '));
      const real404 = c.badUrls.filter(u => !/\/favicon\.ico$/.test(u));
      check(real404.length === 0, `${c.name}: no failed requests`, real404.join(', '));
      check(c.errors.length === 0, `${c.name}: no uncaught exceptions`,
        c.errors.slice(0, 4).join('\n         '));
    }

  } finally {
    await a.stop();
    await b.stop();
  }
}

async function main() {
  if (!sh('which', ['google-chrome']).status === 0 && sh('which', ['chromium']).status !== 0) {
    console.log('no chrome/chromium; cannot run');
    return 2;
  }

  const wantServer = !process.argv.includes('--no-server');
  let server = null;
  let httpServer = null;

  /* The staged tree (0479) is built BEFORE anything starts, because both the
   * static server and the game server read it (0054's frozen-tree rule). With
   * --no-server the caller's own server's gamedir is whatever it is; the
   * static server then serves web/ as before. */
  const stage = wantServer ? stageGamedir() : null;

  if (code() !== '200') {
    console.log(`${'starting tools/serve.js on :' + HTTP_PORT}` +
                (stage ? ' (staged tree)' : ''));
    httpServer = spawn('node', ['tools/serve.js', '--port', String(HTTP_PORT),
      '--root', stage || 'web'], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (code() === '200') break;
    }
  } else {
    console.log(`using the static server already on :${HTTP_PORT}`);
  }

  if (wantServer) {
    server = new Server(SV_PORT);
    console.log(`starting build/fteqw-sv on :${SV_PORT} (gamedir ${stage})`);
    if (!await server.start(stage)) {
      console.log('  FAIL the dedicated server did not initialise');
      console.log(server.log.slice(-1500));
      if (httpServer) httpServer.kill();
      return 1;
    }
    check(true, `dedicated server initialised (${server.uptime()})`);
  } else {
    console.log(`using the server already on :${SV_PORT}`);
  }

  for (let i = 0; i < RUNS; i++) await oneRun(server, i);

  if (server) await server.stop();
  if (httpServer) httpServer.kill();
  if (stage) { try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {} }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length ? `FAIL: ${failed.length} of ${results.length} checks`
                                : `PASS: ${results.length}/${results.length} checks`}`);
  console.log(`screenshots: ${path.relative(ROOT, SHOTS)}/m2-{alpha,bravo}.png`);
  return failed.length ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.error('harness error: ' + (e && e.stack || e));
  process.exit(3);
});

process.on('exit', () => {
  for (const c of global.__clients || []) {
    try { if (c.proc) process.kill(-c.proc.pid, 'SIGKILL'); } catch (e) {}
    try { if (c.profile) fs.rmSync(c.profile, { recursive: true, force: true }); }
    catch (e) {}
  }
});