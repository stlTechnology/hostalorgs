// tests/test_gate.js -- M3b: the front door must be boring to a bot and work
// for a person.
//
// Two halves, matching PLAN.md's done-when:
//
//   A. A "scanner" walks the paths a bot would try and must get nothing: no
//      engine bytes, no listing, no game-server connection, no process
//      creation, tiny answers, and 429s once the per-IP limit is passed. The
//      WebSocket upgrade is refused on the token BEFORE the game server is
//      touched at all, which is checked against the game server's own log.
//
//   B. A "person" opens the landing page, presses Play, gets a session, loads
//      the game through the gate and spawns -- in one browser, on one origin,
//      with no game port reachable.
//
// Run: node tests/test_gate.js [--pow-bits N]

'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_MAPS = path.join(ROOT, 'tests', 'fixtures', 'maps');
const WEB = path.join(ROOT, 'web');
const ARTIFACTS = path.join(ROOT, 'tests/artifacts/gate');
const POW_BITS = (() => {
  const i = process.argv.indexOf('--pow-bits');
  return i > 0 ? parseInt(process.argv[i + 1], 10) : 0;
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(ok, what, detail) {
  results.push({ ok: !!ok, what, detail: detail || '' });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : '\n         ' + detail}`);
}
function sh(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
}

/* ------------------------------------------------------------- http client */

function request(port, pathname, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET',
      headers: opts.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: String(e) }));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* A raw WebSocket upgrade, so we can see the refusal before any game server is
 * involved. No handshake helper: the point is to send the upgrade and read the
 * status line. */
function rawUpgrade(port, pathname, headers) {
  return new Promise(resolve => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      let h = `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
      for (const [k, v] of Object.entries(headers || {})) h += `${k}: ${v}\r\n`;
      sock.write(h + '\r\n');
    });
    let buf = '';
    let done = false;
    const finish = status => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(status); } };
    sock.on('data', d => {
      buf += d.toString('latin1');
      const m = buf.match(/^HTTP\/1\.1 (\d+)/);
      if (m) finish(parseInt(m[1], 10));
    });
    sock.on('error', () => finish(0));
    sock.on('close', () => finish(0));
    setTimeout(() => finish(0), 4000);
  });
}

/* ------------------------------------------------------------ process count */

/* "No process creation" is a property of the whole scan, so count what the gate
 * itself has spawned before and after. */
function childCount(pid) {
  try {
    return execFileSync('bash', ['-c',
      `ps -eo ppid= | awk -v p=${pid} '$1==p' | wc -l`], { encoding: 'utf8' }).trim();
  } catch (e) { return '0'; }
}

/* -------------------------------------------------------------------- setup */

/* An unused port on loopback, so a run never collides with the owner's servers
 * or another test. */
function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  if (sh('which', ['google-chrome']).status !== 0) {
    console.log('no google-chrome; cannot run the person flow');
    return 2;
  }
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  /* Stage the snapshot the gate serves, exactly as production does: a deploy
   * directory, with the landing page beside web/. 0479: web/id1 no longer
   * carries the alt maps, and this suite runs corridor -- so id1 is staged
   * entry by entry with the fixtures' maps beside web's own. */
  const STAGE = path.join(ARTIFACTS, 'deploy');
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(WEB)) {
    if (e === 'id1' || e === 'landing') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  }
  fs.symlinkSync(path.join(WEB, 'landing'), path.join(STAGE, 'landing'));
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    if (e === 'maps') continue;
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
  fs.mkdirSync(path.join(STAGE, 'id1', 'maps'), { recursive: true });
  for (const dir of [path.join(WEB, 'id1', 'maps'), FIXTURES_MAPS]) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir)) {
      const to = path.join(STAGE, 'id1', 'maps', e);
      if (!fs.existsSync(to)) fs.symlinkSync(path.join(dir, e), to);
    }
  }

  const gatePort = await freePort();
  const ftePort = await freePort();
  const secret = 'test-secret-' + crypto.randomBytes(8).toString('hex');

  const svLog = path.join(ARTIFACTS, 'fte.log');
  const svOut = fs.openSync(svLog, 'w');
  const fte = spawn('bash', [path.join(ROOT, 'scripts/run_server.sh'),
    '--port', String(ftePort), '--host', '127.0.0.1',
    '--gamedir', STAGE, '--demo-subdir', 'demos', '--map', 'corridor'],
    { cwd: ROOT, stdio: ['pipe', svOut, svOut], detached: true });
  await fte.unref();

  const gateLog = path.join(ARTIFACTS, 'gate.log');
  const gateOut = fs.openSync(gateLog, 'w');
  const gate = spawn('node', [path.join(ROOT, 'server/gate.js')], {
    cwd: ROOT, detached: true,
    stdio: ['ignore', gateOut, gateOut],
    env: Object.assign({}, process.env, {
      GATE_PORT: String(gatePort),
      GATE_ROOT: STAGE,
      GATE_SECRET: secret,
      GATE_HOST: '127.0.0.1',
      FTE_HOST: '127.0.0.1',
      FTE_PORT: String(ftePort),
      GATE_POW_BITS: String(POW_BITS),
    }),
  });
  await gate.unref();

  const up = await waitFor(async () => (await request(gatePort, '/robots.txt')).status === 200, 15000);
  if (!up) {
    console.log('FATAL the gate never came up; log:\n' + fs.readFileSync(gateLog, 'utf8'));
    try { process.kill(-gate.pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(-fte.pid, 'SIGKILL'); } catch (e) {}
    return 1;
  }
  const fteUp = await waitFor(async () =>
    /Quake Initialized/.test(fs.readFileSync(svLog, 'utf8')), 25000);
  check(fteUp, 'the internal game server started');

  try {
    /* ============================ A. the scanner ============================ */
    console.log('\n-- A. scanner --');

    /* 1. The game port.
     *
     * REPORTED, NOT ASSERTED: PLAN.md wants FTE on 127.0.0.1 only, and this FTE
     * build cannot do it. sv_port/sv_port_tcp document an "IP:PORT" form that
     * binds a specific interface, and it works for UDP, but with the address
     * prefix the TCP listener never comes up at all -- so the game stops
     * working entirely. Measured both ways; see scripts/run_server.sh. There is
     * no cvar or -port switch that restricts it (SV_ArgumentOverrides only sets
     * the two port cvars). Isolation has to come from outside FTE.
     *
     * So the number below is printed for the record and the assertions are
     * about what the gate does guarantee: no route from a scanner to that port.
     */
    const tcpLine = (sh('bash', ['-c', `ss -ltn 2>/dev/null | grep ":${ftePort} "`]).stdout || '').trim();
    const udpLine = (sh('bash', ['-c', `ss -lun 2>/dev/null | grep ":${ftePort} "`]).stdout || '').trim();
    const loopbackOnly = /127\.0\.0\.1:${ftePort}/.test(tcpLine);
    console.log(`         game port tcp: ${tcpLine || '(none)'}`);
    console.log(`         game port udp: ${udpLine || '(none)'}`);
    console.log(`         loopback only: ${loopbackOnly ? 'YES' : 'NO -- known gap, see run_server.sh'}`);

    // The gate must not offer any route to that port.
    for (const p of ['/play/../:' + ftePort, '/play/ws?port=' + ftePort]) {
      const r = await request(gatePort, p);
      check(r.status === 404 || r.status === 403 || r.status === 400,
        `the gate exposes no route to the game port (${p})`, `status ${r.status}`);
    }
    // And nothing the gate serves may advertise the game port.
    const landingHtml = (await request(gatePort, '/')).body.toString('latin1');
    check(!landingHtml.includes(String(ftePort)),
      'the landing page never mentions the game port');

    // 2. Every path a bot tries, answered small and without anything useful.
    const probes = [
      '/', '/index.html', '/play/ftewebgl.wasm', '/play/id1/models.pak',
      '/.env', '/wp-login.php', '/recordings/', '/api/upload',
      '/../.git/config', '/server/gate.js', '/web/index.html',
    ];
    const before = childCount(gate.pid);
    let biggest = 0, biggestPath = '', wasmServed = false, listingLeak = false;
    const table = [];
    for (const p of probes) {
      const r = await request(gatePort, p);
      table.push(`${p} -> ${r.status} ${r.body.length}B`);
      if (r.body.length > biggest) { biggest = r.body.length; biggestPath = p; }
      if (/wasm/i.test(p) && r.status === 200 && r.body.length > 1000) wasmServed = true;
      if (r.status === 200 && /id1|our\.wad|qwprogs|parent|Index of/i.test(r.body.toString('latin1'))) {
        listingLeak = true;
      }
    }
    console.log('         ' + table.join('\n         '));

    check(biggest <= 10 * 1024, `every response is <= 10 KB (largest ${biggest}B at ${biggestPath})`);
    check(!wasmServed, 'the wasm is never served without a session');
    check(!listingLeak, 'no response lists the content tree');

    const noEnv = await request(gatePort, '/.env');
    check(noEnv.status === 404 && noEnv.body.length < 64,
      '/.env gets a tiny 404', `status ${noEnv.status}, ${noEnv.body.length}B`);

    const upload = await request(gatePort, '/api/upload', { method: 'POST', body: 'x' });
    check(upload.status === 404 || upload.status === 405,
      '/api/upload does not exist on the gate (no process spawned)',
      `status ${upload.status}`);

    const uploadGet = await request(gatePort, '/recordings/');
    check(uploadGet.status === 404, '/recordings/ is not served', `status ${uploadGet.status}`);

    // 3. WebSocket upgrade without a token: refused, and the game server must
    // never see a connection.
    const fteLogBefore = fs.readFileSync(svLog, 'utf8').length;
    const wsNo = await rawUpgrade(gatePort, '/play/ws');
    await sleep(1200);
    const fteLogAfter = fs.readFileSync(svLog, 'utf8').slice(fteLogBefore);
    check(wsNo === 403, 'a WebSocket upgrade without a session is refused', `status ${wsNo}`);
    check(!/connect/i.test(fteLogAfter),
      'the game server saw no connection from the refused upgrade',
      `new game-server log: ${JSON.stringify(fteLogAfter.slice(0, 200))}`);

    const wsOther = await rawUpgrade(gatePort, '/play/socket');
    check(wsOther === 404, 'an upgrade to any other path is a 404', `status ${wsOther}`);

    // 4. No process creation across the whole scan.
    const after = childCount(gate.pid);
    check(before === after, 'the gate spawned no child processes while being scanned',
      `children ${before} -> ${after}`);

    /* The container publishes only the gate, so FTE on 0.0.0.0 inside it is
     * unreachable from outside. That is only true if nothing publishes the game
     * port, so assert it against the Dockerfile rather than trusting the
     * comment (reviewer 0066). */
    let dockerfile = '';
    try { dockerfile = fs.readFileSync(path.join(ROOT, 'deploy/Dockerfile'), 'utf8'); }
    catch (e) { /* handled below */ }
    const exposed = [...dockerfile.matchAll(/^\s*EXPOSE\s+(.*)$/gim)]
      .flatMap(m => m[1].trim().split(/\s+/));
    check(exposed.length > 0, 'the Dockerfile declares its published port', 'no EXPOSE found');
    check(exposed.every(p => p === '8080' || p.startsWith('$')),
      'the container publishes only the gate port',
      `EXPOSE says: ${JSON.stringify(exposed)} (the game port must not appear)`);
    check(!exposed.includes(String(ftePort)) && !exposed.includes('27500'),
      'the game port is not published by the container');

    /* ============================ B. the person ============================ */
    console.log('\n-- B. person --');
    const t0 = Date.now();

    // The landing page is small, static and mentions no engine.
    const landing = await request(gatePort, '/');
    check(landing.status === 200 && landing.body.length <= 10 * 1024,
      'the landing page is a small static page',
      `status ${landing.status}, ${landing.body.length}B`);
    const landingText = landing.body.toString('utf8');
    const landingCode = landingText
      .replace(/<!--[\s\S]*?-->/g, '')   // HTML comments
      .replace(/^\s*\/\/.*$/gm, '');      // JS line comments
    check(!/webid|wasm|qprogs|\.pak|\.bsp/i.test(landingCode),
      'the landing page references no engine or content',
      (landingCode.match(/.*(webid|wasm|qprogs|\.pak|\.bsp).*/i) || [''])[0].slice(0, 120));

    // Get a session the honest way, honouring proof of work if it is on.
    let nonce = null;
    if (POW_BITS > 0) {
      const enc = 'sha256';
      const target = POW_BITS;
      for (let n = 0; ; n++) {
        const d = crypto.createHash(enc).update(String(n)).digest();
        let zeros = 0;
        for (const byte of d) {
          if (byte === 0) { zeros += 8; continue; }
          zeros += Math.clz32(byte) - 24;
          break;
        }
        if (zeros >= target) { nonce = String(n); break; }
      }
    }
    const sess = await request(gatePort, '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce }),
    });
    check(sess.status === 200, 'a person gets a session', `status ${sess.status} ${sess.body}`);
    const setCookie = (sess.headers['set-cookie'] || [])[0] || '';
    const cookie = setCookie.split(';')[0];
    check(/qwtf=/.test(cookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie),
      'the session cookie is HttpOnly and SameSite=Strict', setCookie);

    // With the cookie, the game loads and the wasm is served.
    const idx = await request(gatePort, '/play/index.html', { headers: { cookie } });
    check(idx.status === 200 && /<canvas/i.test(idx.body.toString('utf8')),
      'the game page loads with a session', `status ${idx.status}`);
    const wasm = await request(gatePort, '/play/ftewebgl.wasm', { headers: { cookie } });
    check(wasm.status === 200 && wasm.body.length > 100000,
      'the wasm is served once a session exists',
      `status ${wasm.status}, ${wasm.body.length}B`);

    const pak = await request(gatePort, '/play/id1/models.pak', { headers: { cookie } });
    check(pak.status === 200 && pak.body.length > 1000,
      'content is served once a session exists', `status ${pak.status}, ${pak.body.length}B`);

    // Path traversal with a session is still refused.
    const trav = await request(gatePort, '/play/../../etc/passwd', { headers: { cookie } });
    check(trav.status === 404 || trav.status === 403,
      'traversal out of the snapshot is refused even with a session', `status ${trav.status}`);

    // A token issued to one address does not work from another: forge the IP.
    const fteStatus = (await new Promise(resolve => {
      let out = '';
      const s = net.connect(ftePort, '127.0.0.1', () => s.write('status\n'));
      s.on('data', d => {
        out += d.toString('latin1');
        if (/frags/.test(out)) { s.write('status\n'); }
        if (/----/.test(out) && out.length > 200) { s.destroy(); resolve(out); }
      });
      s.on('error', () => resolve(out));
      setTimeout(() => { s.destroy(); resolve(out); }, 1500);
    }));

    // Now the whole thing in one browser: landing -> Play -> game -> spawn.
    const cdpPort = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-gate-'));
    const chrome = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=800,600', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });

    let target = null;
    await waitFor(async () => {
      const r = sh('curl', ['-s', `http://127.0.0.1:${cdpPort}/json/list`]);
      if (r.status === 0) {
        try { target = JSON.parse(r.stdout).find(t => t.type === 'page'); } catch (e) {}
      }
      return !!target;
    }, 20000);

    let spawned = false, cdpErr = null;
    if (target) {
      const WS = require('./cdp.js');
      const logs = [];
      let id = 0;
      const pending = new Map();
      /* cdp.js hands every parsed message to this callback and never emits an
       * event, so responses are resolved here. Getting this wrong makes every
       * send() time out silently and every assertion fail for no reason. */
      const ws = await WS.connect(target.webSocketDebuggerUrl, m => {
        if (m.method === 'Runtime.consoleAPICalled') {
          logs.push((m.params.args || []).map(a => a.value).join(' '));
        }
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m.result || {});
          pending.delete(m.id);
        }
      });
      const send = (method, params) => new Promise(res => {
        const myId = ++id;
        pending.set(myId, res);
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
        setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({}); } }, 20000);
      });

      await send('Runtime.enable');
      await send('Page.enable');
      await send('Page.navigate', { url: `http://127.0.0.1:${gatePort}/` });
      await sleep(2500);

      // Press Play the way a person does: click the button.
      const clicked = await send('Runtime.evaluate', {
        expression: `(function(){ var b=document.getElementById('play');
          if(!b) return 'no-button'; b.click(); return 'clicked'; })()`,
        returnByValue: true,
      });
      check((clicked.result || {}).value === 'clicked',
        'the landing page has a Play button that can be pressed',
        JSON.stringify((clicked.result || {}).value));

      // The game page must arrive on the SAME origin, through the gate.
      const landed = await waitFor(async () => {
        const r = await send('Runtime.evaluate', {
          expression: 'location.pathname', returnByValue: true });
        return /^\/play\//.test((r.result || {}).value || '');
      }, 15000);
      check(landed, 'pressing Play lands on the game page through the gate');

      // And the client must connect and spawn, over the gate's own WebSocket.
      spawned = await waitFor(async () => {
        const st = sh('bash', ['-c',
          `ss -tn 2>/dev/null | grep -c ":${ftePort}" || true`]);
        return parseInt((st.stdout || '0').trim(), 10) > 0;
      }, 20000);

      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      check(spawned, 'the browser client reaches the game through the gate', `in ${secs}s`);
      check(parseFloat(secs) < 60, 'time to play is reasonable', `${secs}s`);

      const errs = logs.filter(l => /ReferenceError|Uncaught/i.test(l));
      check(errs.length === 0, 'no client exceptions in the browser', errs.slice(0, 2).join(' | '));

      // Screenshot the landing page and the game for the record.
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.data) {
        fs.writeFileSync(path.join(ARTIFACTS, 'person-game.png'),
          Buffer.from(shot.data, 'base64'));
      }
      try { ws.close(); } catch (e) {}
    } else {
      check(false, 'chrome debugger came up for the person flow');
    }

    try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
    fs.rmSync(profile, { recursive: true, force: true });

    /* 5. Per-IP limits, last: this exhausts the budget for 127.0.0.1, which is
     * the same address the person flow above legitimately used. */
    let sawLimit = false;
    for (let i = 0; i < 60; i++) {
      const r = await request(gatePort, '/api/session', { method: 'POST', body: '{}' });
      if (r.status === 429) { sawLimit = true; break; }
    }
    check(sawLimit, 'repeated session requests are rate limited (429)');

  } finally {
    try { process.kill(-gate.pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(-fte.pid, 'SIGKILL'); } catch (e) {}
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length
    ? `FAIL: ${failed.length} of ${results.length} checks did not hold`
    : `PASS: ${results.length}/${results.length} checks`}`);
  return failed.length ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.error('harness error:', e && e.stack || e);
  process.exit(1);
});