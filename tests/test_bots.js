#!/usr/bin/env node
/*
 * M7 bots: one bot per team, running the key, fighting, and a human joining.
 * Run through tests/test_bots.sh (which takes the walk-suite flock).
 *
 *   node tests/test_bots.js
 *
 * What is asserted, and on whose authority:
 *
 *   1  A server started with qwtf_bots 1 and no humans has two bot clients,
 *      one per team, listed by the server's own `status` (address column
 *      "bot"), named Bot Red and Bot Blue, teams 1 and 2 read from the
 *      server's own QWTFPOS trail (the probe's qwtf_team field).
 *   2  Both bots TAKE the enemy key: QWTF_EVENT take <bot>, which qwtf/ctf.qc
 *      prints unconditionally (the rules file's header: the behaviour under
 *      test must not be reachable only when the test is watching).
 *   3  Both bots CAPTURE: QWTF_EVENT capture_score team=N with the score
 *      having moved. This is the slow check -- the routes are deliberately
 *      asymmetric (scripts/build_nav.py) so the bots meet in the underwater
 *      passage, fight, and whoever wins a fight either captures or picks the
 *      dropped key up; a capture is therefore a matter of minutes, not
 *      seconds. The budget is generous and the wait is driven by events,
 *      not by hope.
 *   4  A human (a raw QW client speaking just enough protocol to connect and
 *      begin) joins, is auto-assigned a team by ctf.qc's own
 *      QWTFPROBE QWTF_TEAM line, and both bots are still there afterwards --
 *      "a human joining is placed on a team with one bot on each side"
 *      (PLAN.md M7). With one bot per side and the join auto-balanced, no bot
 *      needs to leave; the leave rule is exercised only when a join would
 *      unbalance the teams, which a 2-bot start plus one human cannot do.
 *
 * The client here is raw UDP on purpose: the M7 done-when is about the
 * SERVER's view (status, QWTF_EVENT, QWTF_TEAM), and a browser adds minutes
 * for nothing this file asserts. test_name_filter.js already proved the raw
 * connect path (challenge, signed challenge, unique qport); this file extends
 * it with the two stringcmds that make the slot a player ("new", "begin").
 * PlayerPreThink runs for such a client without move packets -- the engine
 * re-runs the last command on its own timeout (sv_phys.c), so the auto-team
 * assignment fires without a real client's input.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const RUN = path.join(ARTIFACTS, 'run-bots-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');

const SV_PORT = 27600 + (process.pid % 300);
const HTTP_PORT = 8600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WSS = `ws://127.0.0.1:${SV_PORT}`;

/* Budgets. The captures are the long pole: the bots meet and fight in the
 * underwater passage, and every fight hands a key to somebody, so the wait is
 * minutes. Everything is event-driven against these ceilings. The env knobs
 * exist so a debugging run can shrink them; the defaults are what the queue
 * runs. */
const BOTS_UP_MS = +(process.env.QWTF_BOTS_UP_MS || 45000);
const TAKE_BUDGET_MS = +(process.env.QWTF_BOTS_TAKE_MS || 300000);
const CAP_BUDGET_MS = +(process.env.QWTF_BOTS_CAP_MS || 600000);
const JOIN_WINDOW_MS = 20000;  // the human is placed after connecting

let failed = false;
function check(ok, what, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}` +
              (ok || !detail ? '' : `\n         ${detail}`));
  if (!ok) failed = true;
  return ok;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- the server, driven over stdin (the mp_combat/test_name_filter shape) -- */
class Server {
  constructor(port, gamedir) {
    this.port = port; this.gamedir = gamedir; this.log = '';
  }
  start() {
    /* qwtf_bots is the switch the bots live behind (qwtf/bots.qc): off by
     * default, so every other suite's server runs without bots and nothing
     * that counts players or expects a quiet server can be surprised. */
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port), '--gamedir', this.gamedir, '--map', 'forts',
      '+set', 'developer', '1',
      '+set', 'qwtf_bots', '1',
      '+serverinfo', 'qwtf_trace', '1',
    ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.proc.stdout.on('data', d => { this.log += d.toString(); });
    this.proc.stderr.on('data', d => { this.log += d.toString(); });
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
  stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); }
    catch (e) { try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {} }
  }
}

/* --- one headless browser client (the mp_combat shape, minus the unused) ---
 *
 * The "human" of the done-when is a real visitor: the page at ?server= and
 * ?name=, which auto-connects the way every other suite's client does. A raw
 * UDP client was tried first and abandoned with its reason recorded: FTE's QW
 * signon is a stage machine (SV_New_f refuses to proceed until the client has
 * answered its "cmd pext" prompt, then modellist/soundlist/prespawn/spawn
 * must each arrive in stage order), and speaking enough of that to reach
 * cs_spawned is a second protocol implementation in a file that only wanted a
 * player to exist. The browser IS the path a person takes, and the assertions
 * read the server either way.
 */
const { spawnSync } = require('child_process');
const os = require('os');
class Client {
  constructor(name, cdpPort) { this.name = name; this.port = cdpPort; this.logs = []; }
  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `qwtf-${this.name}-`));
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1024,576', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    let info = null;
    for (let i = 0; i < 120; i++) {
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
    await this.send('Runtime.enable'); await this.send('Page.enable');
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
    }
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000);
    });
  }
  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* --- helpers over the server's own words ---------------------------------- */
function statusRows(st) {
  /* The table's rows: "<frags> <userid> <address> <name>", after the header.
   * Tolerant of lines the dprint probe interleaves between rows and of the
   * dashes line under the header: collect every row-like line after the LAST
   * header in this chunk, stop at the first blank line once rows exist. */
  const lines = st.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/frags\s+userid\s+address\s+name/i.test(lines[i])) last = i;
  }
  if (last < 0) return [];
  const out = [];
  for (let i = last + 2; i < lines.length; i++) {   // +2: skip the dashes line
    const m = /^\s*(-?\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) out.push({ frags: +m[1], uid: m[2], addr: m[3], name: m[4].slice(0, 16) });
    else if (out.length && /^\s*$/.test(lines[i])) break;
  }
  return out;
}

function lastProbe(log, name) {
  /* QWTFPOS [name] x y z yaw health waterlevel team carry captures rscore bscore */
  const lines = log.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('QWTFPOS [' + name + ']')) {
      const f = lines[i].slice(('QWTFPOS [' + name + '] ').length).trim().split(/\s+/);
      return { x: +f[0], y: +f[1], z: +f[2], hp: +f[4], team: +f[6], carry: f[7] };
    }
  }
  return null;
}

async function waitFor(deadlineMs, probe) {
  /* probe may be sync or async; an async one returns a PROMISE, which is
   * truthy on its own -- so the promise is awaited before it is judged. The
   * first version judged the promise and returned after one iteration, which
   * is why every status-based check ran against the boot-time table. */
  const t0 = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(1000);
  }
}

async function main() {
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const entry of fs.readdirSync(WEB)) {
    if (entry === 'id1') continue;
    fs.symlinkSync(path.join(WEB, entry), path.join(STAGE, entry));
  }
  for (const entry of fs.readdirSync(path.join(WEB, 'id1'))) {
    fs.symlinkSync(path.join(WEB, 'id1', entry), path.join(STAGE, 'id1', entry));
  }
  fs.mkdirSync(path.join(STAGE, 'demos'), { recursive: true });

  const server = new Server(SV_PORT, STAGE);
  console.log(`starting build/fteqw-sv with qwtf_bots 1 on :${SV_PORT} (run dir ${RUN})`);
  server.start();
  const cleanup = [() => server.stop()];
  try {
    let up = false;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      if (/Quake Initialized/.test(server.log)) { up = true; break; }
    }
    if (!up) {
      check(false, 'the dedicated server initialised',
        server.log.slice(-1200));
      return finish();
    }
    check(true, 'the dedicated server initialised (qwtf_bots 1)');

    /* -- 1: two bots, present because the server started ------------------- */
    let st = await waitFor(BOTS_UP_MS, async () => {
      const t = await server.status();
      return statusRows(t).length >= 2 ? t : null;
    });
    const rows = st ? statusRows(st) : [];
    const bots = rows.filter(r => r.addr === 'bot');
    check(bots.length === 2,
      `a server with no humans lists exactly 2 bots in status (got ` +
      `${rows.length} players, ${bots.length} bot)`,
      st);
    check(!!bots.find(b => b.name.startsWith('Bot Red')) &&
          !!bots.find(b => b.name.startsWith('Bot Blue')),
      'the bots are named Bot Red and Bot Blue', st);
    const redProbe = await waitFor(BOTS_UP_MS, () => {
      const p = lastProbe(server.log, 'Bot Red');
      return p && p.team === 1 ? p : null;
    });
    const blueProbe = await waitFor(BOTS_UP_MS, () => {
      const p = lastProbe(server.log, 'Bot Blue');
      return p && p.team === 2 ? p : null;
    });
    check(!!redProbe && !!blueProbe,
      'the server\'s own trail reads Bot Red as team 1 and Bot Blue as team 2',
      `red: ${JSON.stringify(redProbe)}\n         blue: ${JSON.stringify(blueProbe)}`);
    check(!!redProbe && redProbe.hp > 0 && blueProbe && blueProbe.hp > 0,
      'both bots are spawned and alive at their forts',
      `red: ${JSON.stringify(redProbe)}\n         blue: ${JSON.stringify(blueProbe)}`);

    /* The 4 Hz position trail is a test hook and 8 KB/s of stdout; with the
     * server's stdout block-buffered into 4 KB chunks through a pipe, the
     * trail delays the status table's flush past any sane wait. So the trace
     * goes OFF for the long capture wait (the rules print QWTF_EVENT
     * unconditionally -- ctf.qc's header) and back ON for the join phase's
     * per-player checks. */
    server.cmd('serverinfo qwtf_trace 0');

    /* -- 2: both bots take the enemy key ----------------------------------- */
    const took = { 'Bot Red': false, 'Bot Blue': false };
    const seenTake = () => {
      for (const m of server.log.matchAll(/QWTF_EVENT take (\S[^\n]*?)\n/g)) {
        for (const b of Object.keys(took)) if (m[1].startsWith(b)) took[b] = true;
      }
      return took['Bot Red'] && took['Bot Blue'];
    };
    const t2 = await waitFor(TAKE_BUDGET_MS, seenTake);
    check(!!t2, `both bots took the enemy key within ` +
          `${Math.round(TAKE_BUDGET_MS / 1000)} s (red: ${took['Bot Red']}, blue: ${took['Bot Blue']})`,
      server.log.split('\n').filter(l => l.startsWith('QWTF_EVENT')).slice(-20).join('\n'));

    /* -- 3: both bots capture ---------------------------------------------- */
    const captured = { 1: false, 2: false };
    const seenCapture = () => {
      for (const m of server.log.matchAll(/QWTF_EVENT capture_score team=(\d)/g)) {
        captured[+m[1]] = true;
      }
      return captured[1] && captured[2];
    };
    const t3 = await waitFor(CAP_BUDGET_MS, seenCapture);
    const capLines = server.log.split('\n').filter(l => l.startsWith('QWTF_EVENT capture'));
    check(!!t3, `both bots captured within ` +
          `${Math.round(CAP_BUDGET_MS / 1000)} s of the run (team1: ${captured[1]}, team2: ${captured[2]})`,
      capLines.slice(-12).join('\n') || server.log.slice(-1200));
    const score = (server.log.match(/QWTF_EVENT capture_score team=(\d) red=(\d+) blue=(\d+)/g) || []).pop();
    check(!!score && !/^team=\d red=0 blue=0$/.test(score.replace(/^QWTF_EVENT /, '')),
      'a capture moved a team score (the rules, not just the event line)', score);

    /* -- 4: a human joins and is placed; one bot per side remains ---------- */
    /* The page's own static server, on the staged tree, like every other
     * suite. The ?server= URL makes the page dial OUR server; ?name=Human is
     * the +set name path a visitor takes. */
    const httpServer = spawn('node', ['tools/serve.js', '--port', String(HTTP_PORT),
                                      '--root', STAGE], { cwd: ROOT, stdio: 'ignore' });
    cleanup.unshift(() => httpServer.kill());
    let pageUp = false;
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
        `${BASE}/index.html`], { encoding: 'utf8' });
      if ((r.stdout || '').trim() === '200') { pageUp = true; break; }
    }
    if (!pageUp) {
      check(false, `the staged page server came up on :${HTTP_PORT}`);
      return finish();
    }
    server.cmd('serverinfo qwtf_trace 1');   // the join phase re-reads the
                                             // per-player trail

    const human = new Client('Human', 9300 + (process.pid % 300));
    cleanup.unshift(() => human.stop());
    try {
      await human.start(`${BASE}/index.html?server=${encodeURIComponent(WSS)}&name=Human`);
    } catch (e) {
      check(false, 'headless human client started', e.message);
      return finish();
    }
    const joined = await waitFor(JOIN_WINDOW_MS + 25000, async () => {
      const t = await server.status();
      const r = statusRows(t);
      return r.length >= 3 && r.some(x => x.name.startsWith('Human')) ? t : null;
    });
    const rows4 = joined ? statusRows(joined) : [];
    check(rows4.length >= 3 && rows4.some(r => r.addr === 'bot') &&
          rows4.some(r => r.name.startsWith('Human')),
      `after the human joins, status lists the human and BOTH bots still ` +
      `(players: ${rows4.map(r => `${r.name}@${r.addr}`).join(', ') || 'none'})`,
      joined);
    const humanTeam = await waitFor(20000, () => {
      const m = server.log.match(/QWTFPROBE QWTF_TEAM Human -> (\d)/);
      return m ? +m[1] : null;
    });
    check(humanTeam === 1 || humanTeam === 2,
      `the human was auto-assigned a team (server's own line says ${humanTeam})`,
      server.log.split('\n').filter(l => l.includes('QWTF_TEAM')).slice(-6).join('\n'));
    const rp = lastProbe(server.log, 'Bot Red');
    const bp = lastProbe(server.log, 'Bot Blue');
    check(!!rp && rp.team === 1 && !!bp && bp.team === 2,
      'one bot per side after the join (red 1, blue 2, from the server trail)',
      `red: ${JSON.stringify(rp)}\n         blue: ${JSON.stringify(bp)}`);
    return finish();
  } catch (e) {
    check(false, 'unexpected failure', e.stack || String(e));
    return finish();
  }

  function finish() {
    for (const c of cleanup) { try { c(); } catch (e) {} }
    /* Keep the evidence: server.log is behind every number this file prints. */
    try { fs.writeFileSync(path.join(RUN, 'server.log'), server.log); } catch (e) {}
    console.log(`run dir kept: ${RUN}`);
    process.exit(failed ? 1 : 0);
  }
}

main();
