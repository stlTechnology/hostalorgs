#!/usr/bin/env node
/**
 * M6 name filter: the server must never store an unsafe player name.
 * Run through tests/test_name_filter.sh (which takes the walk-suite flock).
 *
 * See the .sh header for the case list and the reasoning. One headless browser
 * client, one dedicated server, the server's own `status` table as the
 * authority. Two name paths are driven:
 *   connect  -- ?name=... on the page URL (the +set name path a visitor takes)
 *   runtime  -- FTEC.cbufadd('name ...') (the console path, F key)
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');

const SV_PORT = 27700 + (process.pid % 300);
const HTTP_PORT = 8400 + (process.pid % 300);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WSS = `ws://127.0.0.1:${SV_PORT}`;

let failed = false;
function check(ok, what, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}` +
              (ok || !detail ? '' : `\n         ${detail}`));
  if (!ok) failed = true;
  return ok;
}
function sh(cmd, args) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* --- the server, driven over stdin (same channel as mp_combat) ------------ */
class Server {
  constructor(port, gamedir) {
    this.port = port; this.gamedir = gamedir; this.log = '';
  }
  async start() {
    /* --map forts explicitly, not the default: the default IS forts today, but
     * the assert below reads the status table and a wrong map would still
     * "pass" the boot while testing nothing. Naming it keeps the suite honest
     * if the default ever changes again. */
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port), '--gamedir', this.gamedir, '--map', 'forts',
    ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.proc.stdout.on('data', d => { this.log += d.toString(); });
    this.proc.stderr.on('data', d => { this.log += d.toString(); });
    for (let i = 0; i < 120; i++) {
      await sleep(200);
      if (/Quake Initialized/.test(this.log)) return true;
      if (this.proc.exitCode !== null) break;
    }
    return false;
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

/* --- one headless client (the mp_combat shape, minus everything unused) --- */
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
  /* Run JS in the page. Used only for the console path: FTEC.cbufadd is the
   * engine's own command-buffer entry (web/menu.js uses nothing else). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  console(text) { return this.eval(`window.FTEC && FTEC.cbufadd(${JSON.stringify(text)}), 'sent'`); }
  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* properties every stored name must have, whatever the case */
const INVALID = [':', '\\', '"', '$', '\r', '\n', '\u00ff', '\u0080', '\u0081', '\u0082'];
function nameIsClean(n) {
  return n.length > 0 && n.length <= 40 && !INVALID.some(c => n.includes(c));
}

/* --- the raw QW path -------------------------------------------------------
 *
 * The browser's userinfo cannot carry `"` or `\` (the info format's own
 * delimiter rules refuse them client-side), so a browser test can never show
 * the server dropping them. A raw UDP QW client can: InfoBuf stores values
 * verbatim (InfoBuf_SetStarBlobKey copies bytes as they come), so the ONLY
 * thing between a crafted packet and a stored quote is the server's own
 * SV_FixupName. This speaks just enough QW to take a slot:
 *   getchallenge -> "\xff\xff\xff\ffc<n>" -> connect <ver 28> <qport> <n> <userinfo>
 * The userinfo goes UNQUOTED on purpose: the command tokenizer ends a quoted
 * token at the first `"`, so a quoted userinfo could never carry a quote.
 * Mid-token, a `"` is literal, which is exactly the craft this case is about.
 * The client never spawns; cs_connected (set synchronously by the connect
 * packet) is enough for `status` and `user` to list it.
 */
const dgram = require('dgram');
function qwRawConnect(port, name, timeoutMs) {
  return new Promise((resolve0, reject0) => {
    let settled = false;
    const sock = dgram.createSocket('udp4');
    const timers = [];
    const finish = (ok, val) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout); timers.forEach(clearInterval);
      try { sock.close(); } catch (e) {}
      if (ok) resolve0(val); else reject0(val);
    };
    sock.on('error', e => finish(false, e));
    const replies = [];
    sock.on('message', (msg) => {
      replies.push(msg.toString('latin1'));
      /* The reply is 4 x 0xff, 'c', the challenge, NUL, then FTE extension
       * blobs. latin1 keeps the 0xff bytes intact. The challenge is a SIGNED
       * int ((rand() << 16) ^ rand(), sv_main.c SV_NewChallenge), so it is
       * negative about half the time -- the first probes only ever saw
       * positive ones, which is why the missing sign read as "no reply". */
      const m = /^\xff{4}c(-?\d+)/.exec(msg.toString('latin1'));
      if (!m) return;
      const challenge = m[1];   // one capture group: the optional-header group is gone
      const info = `\\name\\${name}\\rate\\3000\\msg\\1`;
      /* The qport must be unique per attempt: FTE dedups a connect by source
       * address + qport, and a swallowed "dup connect" answers nothing. */
      const qport = (process.pid + Math.floor(Math.random() * 60000)) & 0xffff;
      const pkt = Buffer.from(
        `\xff\xff\xff\xffconnect 28 ${qport} ${challenge} ${info}`,
        'latin1');
      sock.send(pkt, port, '127.0.0.1', () => timers.push(setTimeout(() => finish(true, replies), 700)));
    });
    /* Ask again every 2 s: the first ask may land while the server is still
     * bringing its sockets up, and a silent ask proves nothing. */
    const ask = () => sock.send(Buffer.from('\xff\xff\xff\xffgetchallenge', 'latin1'),
      port, '127.0.0.1', e => { if (e) finish(false, e); });
    ask();
    timers.push(setInterval(ask, 2000));
    timers.push(setTimeout(() => finish(false, new Error('no challenge reply')), timeoutMs || 8000));
  });
}

/* Read the server's view of a client via `user <uid>`, falling back to the
 * status table's (16-truncated) name field when `user` does not answer. */
async function serverSees(server, preferFull) {
  const st = await server.status();
  const row = st.split('\n').find(l => /^\s*\d/.test(l) && /\S/.test(l));
  if (!row) return { full: null, short: null, table: st };
  const cols = row.trim().split(/\s+/);
  const uid = cols[1];
  let short = null;
  if (cols.length >= 4) short = cols[3].slice(0, 16);
  if (!preferFull || !/^\d+$/.test(uid || '')) return { full: null, short, table: st };
  const before = server.log.length;
  server.cmd('user ' + uid);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const block = server.log.slice(before);
    if (!/Userinfo \(\d+\):/.test(block)) continue;
    await sleep(200);
    const lines = server.log.slice(before).split('\n');
    const start = lines.findIndex(l => /Userinfo \(\d+\):/.test(l));
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (/^\s*\[.*\]\s*$/.test(lines[j])) { end = j; break; }
    }
    for (const l of lines.slice(start + 1, end)) {
      /* Con_Printf colour escapes are control bytes; the key field is padded
       * to 20. The value itself never carries control bytes -- that is the
       * property under test -- so stripping them here cannot hide a failure. */
      const clean = l.replace(/[\x00-\x1f\x7f]+/g, '');
      const m = clean.match(/^\s*name\s+(.*)$/);
      if (m) return { full: m[1].trim(), short, table: block };
    }
    return { full: null, short, table: block };
  }
  return { full: null, short, table: st };
}

async function main() {
  if (sh('which', ['google-chrome']).status !== 0) {
    console.log('no google-chrome; cannot run'); return 2;
  }
  /* Staged gamedir, the mp_combat lesson: the page the browser is served and
   * the tree the server reads must be the SAME bytes, and nothing may ever be
   * written into web/. Own directory name so this cannot clash with another
   * suite's staging. */
  const STAGE = path.join(ARTIFACTS, 'namefilter-gamedir');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const entry of fs.readdirSync(WEB)) {
    if (entry === 'id1') continue;
    fs.symlinkSync(path.join(WEB, entry), path.join(STAGE, entry));
  }
  for (const entry of fs.readdirSync(path.join(WEB, 'id1'))) {
    fs.symlinkSync(path.join(WEB, 'id1', entry), path.join(STAGE, 'id1', entry));
  }

  const httpServer = spawn('node', ['tools/serve.js', '--port', String(HTTP_PORT),
                                    '--root', STAGE], { cwd: ROOT, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const r = sh('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}/index.html`]);
    if ((r.stdout || '').trim() === '200') { up = true; break; }
  }
  if (!up) {
    console.log(`  FATAL the staged page server never came up on :${HTTP_PORT}`);
    httpServer.kill(); return 1;
  }
  /* Everything killable, killed on EVERY exit path -- a FATAL mid-phase must
   * not leak an fteqw-sv (the first run did exactly that, and its orphan held
   * the port until I noticed). */
  const cleanup = [];
  try {
    const server = new Server(SV_PORT, STAGE);
    cleanup.push(() => server.stop());
    console.log(`starting build/fteqw-sv on :${SV_PORT}`);
    if (!await server.start()) {
      console.log('  FAIL the dedicated server did not initialise\n' + server.log.slice(-1200));
      return 1;
    }

    /* --- Phase R: the raw path, before any browser exists -------------------- */
    {
      console.log('raw QW client: crafting a userinfo the browser could not send');
      let replies = null;
      try { replies = await qwRawConnect(SV_PORT, 'a"b:c$d', 8000); }
      catch (e) { check(false, 'raw client: challenge/connect flow', e.message); }
      let seen = null;
      const rawUntil = Date.now() + 15000;
      while (Date.now() < rawUntil) {
        seen = await serverSees(server, true);
        if (seen.full !== null || seen.short !== null) break;
        await sleep(1000);
      }
      const got = seen ? (seen.full !== null ? seen.full : seen.short) : null;
      /* Measured, not assumed: a name carrying `"` or `$` never reaches the
       * fixup at all -- the info layer (InfoBuf_NeedsEncoding) flags the value
       * as needing encoding, and SV_ExtractFromUserinfo blanks such a name
       * wholesale ("don't allow it if there's even anything weird in there"),
       * leaving "unnamed". The fixup's own ":"/"$" drops are exercised by the
       * browser's colon case below. */
      check(got === 'unnamed',
        `crafted quote/colon/dollar name is discarded wholesale: ${JSON.stringify(got)}` +
        (seen && seen.full !== null ? ' (user)' : ' (status, lossless at this length)'),
        (replies ? 'replies: ' + JSON.stringify(replies.map(r => r.slice(0, 60))) + '\n' : '') +
        server.log.slice(-1500));
    }
    server.stop();

    /* --- Phase B: the browser path, on a fresh server ------------------------ */
    const server2 = new Server(SV_PORT, STAGE);
    cleanup.push(() => server2.stop());
    if (!await server2.start()) {
      console.log('  FAIL the second server did not initialise\n' + server2.log.slice(-1200));
      return 1;
    }

    const cli = new Client('naming', 9531);
    cleanup.push(() => cli.stop());
    /* Connect path: the visitor's ?name= arrives as `+set name`, is sent in
     * the connect packet's userinfo AND re-pushed once connected. */
    const url = `${BASE}/index.html?server=${encodeURIComponent(WSS)}` +
                `&name=${encodeURIComponent('probe')}`;
    await cli.start(url);

    let name = null;
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const r = await serverSees(server2, true);
      if (r.full !== null) { name = r.full; break; }
      await sleep(1000);
    }
    if (name === null) {
      const last = await serverSees(server2, false);
      console.log('  FAIL the client never appeared in the server table\n' +
                  last.table.trim().split('\n').slice(-12).join('\n'));
      return 1;
    }
    check(name === 'probe', 'a normal name is stored as-is at connect',
      `stored ${JSON.stringify(name)}`);

    /* --- the cases. 2 s apart: five changes inside 5 s mutes name changes. */
    const cases = [
      // [label, how, input, expect: null = assert clean, else exact]
      /* Two length cases, split at the MEASURED boundary: a userinfo value
       * of 64+ bytes is "large" (InfoBuf_IsLarge) and discarded wholesale
       * (-> unnamed), so the fixup's 40-byte cut only ever applies under 64.
       * 63 is the longest input that still reaches the cut. */
      ['63 chars are cut to 40', 'url', 'a'.repeat(63), 'a'.repeat(40)],
      ['64 chars are discarded wholesale', 'url', 'a'.repeat(64), 'unnamed'],
      ['colon is dropped', 'url', 'b:c', 'bc'],
      ['the name "console"', 'url', 'console', 'unnamed'],
      ['invis/markup chars', 'url', '\u0082\u0082', null],
      ['whitespace only', 'console', 'name "   "', 'unnamed'],
      ['empty', 'console', 'name ""', 'unnamed'],
      ['spaces survive', 'console', 'name "Pro Be 42"', 'Pro Be 42'],
    ];
    for (const [label, how, input, expect] of cases) {
      await sleep(2000);
      if (how === 'console') {
        await cli.console(input);
      } else {
        /* The runtime path for a URL-shaped case: the same `+set name` push
         * the page does once connected, driven from the page itself.
         *
         * Quoting rule: `"` starts a quoted token anywhere in FTE's command
         * tokenizer, so a value containing a quote MUST go unquoted -- but a
         * quote in the value never reaches the server from a browser anyway
         * (the client's info buffer refuses it), which is why the quote case
         * lives in Phase R. The quoted form here is only for values with
         * spaces or the empty value, none of which carry hostile characters. */
        const cmd = / /.test(input) || input === ''
          ? `set name "${input}"`
          : `set name ${input}`;
        await cli.eval(`FTEC.cbufadd(${JSON.stringify(cmd + '\n')}), 'set'`);
      }
      const got = await serverSees(server2, true);
      if (got.full === null) {
        check(false, `${label}: the server reports a name`,
          got.table.trim().split('\n').slice(-8).join('\n'));
        continue;
      }
      const ok = (expect === null) ? nameIsClean(got.full) : got.full === expect;
      check(ok, `${label}: stored ${JSON.stringify(got.full)}` +
            (expect === null ? ' (clean)' : ''),
        `expected ${expect === null ? 'a clean name' : JSON.stringify(expect)}\n` +
        'client console: ' + JSON.stringify(cli.logs.slice(-4)) + '\n' +
        server2.log.slice(-800));
    }
  } finally {
    for (const c of cleanup) { try { await c(); } catch (e) {} }
    httpServer.kill();
    fs.rmSync(STAGE, { recursive: true, force: true });
  }

  console.log(failed ? 'FAIL: the name filter is not holding'
                     : 'PASS: the server stores a clean name in every case');
  return failed ? 1 : 0;
}

main().then(rc => process.exit(rc)).catch(e => {
  console.log('FATAL ' + (e && e.stack || e));
  process.exit(2);
});
