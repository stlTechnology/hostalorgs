#!/usr/bin/env node
/*
 * tests/test_touch.js -- phone controls, on a real server, in a browser that
 * emulates a landscape phone with a touch screen (owner, 2026-10-10: "people hit
 * it from their phones and they connect but can't really control").
 *
 * The controls are web/touch.js: a floating stick on the left half, drag to look
 * on the right half, and buttons. Every check reads the
 * SERVER's trail (QWTFPOS lines, qwtf_trace 1), never the page's opinion:
 *
 *   1  on a touch screen the overlay is there: 5 buttons, the stick ring, MENU
 *   2  a thumb held above the left stick's centre moves the player
 *   3  a drag across the right half turns the player
 *   4  holding FIRE fires (the current ammo goes down)
 *   5  touches on the buttons never reach the engine (no move while firing)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ART = path.join(__dirname, 'artifacts', 'touch');
const LOG = path.join(ART, 'server.log');
const W = 900, H = 420;                          // a landscape phone, CSS px
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m, d) => { failed++; console.log('  FAIL ' + m + (d ? '\n       ' + d : '')); };

function stage() {
  const S = path.join(ART, 'gamedir');
  fs.rmSync(S, { recursive: true, force: true });
  fs.mkdirSync(path.join(S, 'id1', 'maps'), { recursive: true });
  for (const e of fs.readdirSync(WEB)) if (e !== 'id1') fs.symlinkSync(path.join(WEB, e), path.join(S, e));
  for (const e of fs.readdirSync(path.join(WEB, 'id1')))
    if (e !== 'maps') fs.symlinkSync(path.join(WEB, 'id1', e), path.join(S, 'id1', e));
  for (const e of fs.readdirSync(path.join(WEB, 'id1', 'maps')))
    fs.symlinkSync(path.join(WEB, 'id1', 'maps', e), path.join(S, 'id1', 'maps', e));
  return S;
}

/* The server's own record of alpha: x y z yaw ... weapon currentammo. */
function trail() {
  let t = ''; try { t = fs.readFileSync(LOG, 'utf8'); } catch (e) {}
  const out = [];
  for (const m of t.matchAll(/QWTFPOS \[alpha\] (.*)/g)) {
    const f = m[1].trim().split(/\s+/);
    out.push({ x: +f[0], y: +f[1], z: +f[2], yaw: +f[3], ammo: +f[12] });
  }
  return out;
}
const last = () => { const t = trail(); return t[t.length - 1]; };

class Client {
  constructor(port) { this.port = port; this.logs = []; this.next = 1; this.pending = new Map(); }
  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-touch-'));
    this.proc = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader', `--window-size=${W},${H}`, '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
    let info = null;
    for (let i = 0; i < 150 && !info; i++) {
      const r = spawnSync('curl', ['-s', `http://127.0.0.1:${this.port}/json/list`], { encoding: 'utf8' });
      try { info = JSON.parse(r.stdout).find(t => t.type === 'page'); } catch (e) {}
      if (!info) await sleep(200);
    }
    if (!info) throw new Error('chrome debugger never came up');
    this.ws = await require('./cdp.js').connect(info.webSocketDebuggerUrl, m => this.on(m));
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    // A phone: touch screen, mobile viewport, landscape.
    await this.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await this.send('Page.navigate', { url });
  }
  on(m) {
    if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
      return m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    if (m.method === 'Runtime.consoleAPICalled')
      this.logs.push((m.params.args || []).map(a => a.value !== undefined ? String(a.value) : '').join(' '));
  }
  send(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result.value;
  }
  touch(type, points) { return this.send('Input.dispatchTouchEvent', { type, touchPoints: points }); }
  async hold(x, y, ms, id = 1) {                  // one finger held still, with periodic moves
    await this.touch('touchStart', [{ x, y, id }]);
    for (let t = 0; t < ms; t += 100) { await sleep(100); await this.touch('touchMove', [{ x, y: y + (t % 200 ? 0.5 : 0), id }]); }
    await this.touch('touchEnd', []);
  }
  async stick(x, y, dy, ms, id = 1) {             // thumb lands, slides by dy, holds
    await this.touch('touchStart', [{ x, y, id }]);
    for (let i = 1; i <= 5; i++) { await sleep(20); await this.touch('touchMove', [{ x, y: y + dy * i / 5, id }]); }
    for (let t = 0; t < ms; t += 100) { await sleep(100); await this.touch('touchMove', [{ x, y: y + dy + (t % 200 ? 0.5 : 0), id }]); }
    await this.touch('touchEnd', []);
  }
  async drag(x0, y0, dx, steps, id = 2) {
    await this.touch('touchStart', [{ x: x0, y: y0, id }]);
    for (let i = 1; i <= steps; i++) { await sleep(30); await this.touch('touchMove', [{ x: x0 + dx * i / steps, y: y0, id }]); }
    await this.touch('touchEnd', []);
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  async stop() {
    try { this.ws.close(); } catch (e) {}
    try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const S = stage();
  const PORT = 23600 + (process.pid % 1500), HTTP = PORT + 1;
  const out = fs.openSync(LOG, 'w');
  const sv = spawn('bash', [path.join(ROOT, 'scripts/run_server.sh'), '--port', String(PORT), '--gamedir', S,
    '--map', 'forts2', '+set', 'developer', '1', '+serverinfo', 'qwtf_trace', '1'],
    { cwd: ROOT, stdio: ['pipe', out, out], detached: true });
  const page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP), '--root', S],
    { cwd: ROOT, stdio: 'ignore', detached: true });
  const c = new Client(9300 + (process.pid % 300));
  try {
    await sleep(2500);
    await c.start(`http://127.0.0.1:${HTTP}/index.html?server=${encodeURIComponent('ws://127.0.0.1:' + PORT)}&name=alpha`);

    // 1. the overlay
    let have = null;
    for (let i = 0; i < 60 && !have; i++) { await sleep(500);
      have = await c.eval(`(() => { const r = document.getElementById('qwtf-touch'); if (!r) return null;
        return { buttons: r.querySelectorAll('.tb').length, stick: !!r.querySelector('.stick'),
                 menu: !!r.querySelector('[data-id=menu]') }; })()`); }
    if (have && have.buttons === 5 && have.stick && have.menu) ok('on a touch screen the overlay is there (5 buttons, the stick ring, MENU)');
    else bad('the touch overlay is missing', JSON.stringify(have));

    // join with the menu's defaults, then wait for the server's trail of alpha
    for (let i = 0; i < 120 && !/alpha joined/.test(fs.readFileSync(LOG, 'utf8')); i++) await sleep(500);
    await sleep(2000);
    // the lobby menu fits a phone held sideways, and Join is on screen
    // (owner, 2026-10-10: the panel ran off the top and covered the view)
    let fit = null;
    for (let i = 0; i < 20 && !(fit && fit.open); i++) { await sleep(500);
      fit = await c.eval(`(() => { const m = document.getElementById('qwtf-menu');
        const p = m && m.querySelector('.qwtf-panel'); const j = m && m.querySelector('[data-qwtf-action=join]');
        if (!p || !j || !window.QWTF_MENU.isOpen()) return { open: false };
        const pr = p.getBoundingClientRect(), jr = j.getBoundingClientRect();
        return { open: true, top: pr.top, bottom: pr.bottom, h: innerHeight, jt: jr.top, jb: jr.bottom }; })()`); }
    if (fit && fit.open && fit.top >= 0 && fit.bottom <= fit.h && fit.jt >= 0 && fit.jb <= fit.h)
      ok(`the lobby menu fits the phone screen and Join is visible (panel ${fit.top.toFixed(0)}-${fit.bottom.toFixed(0)} of ${fit.h})`);
    else bad('the lobby menu does not fit the phone screen', JSON.stringify(fit));
    await c.screenshot(path.join(ART, 'phone-lobby.png'));
    await c.eval('window.QWTF_MENU && window.QWTF_MENU.join()');
    for (let i = 0; i < 40 && !last(); i++) await sleep(500);
    await sleep(2500);
    const p0 = last();
    if (!p0) { bad('alpha spawned (no QWTFPOS trail)'); return; }

    // 2. the left stick: a thumb lands on the left half and slides 60 px up
    await c.stick(W * 0.2, H * 0.7, -60, 2500);
    await sleep(700);
    const p1 = last();
    const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (moved > 100) ok(`a thumb on the left stick moves the player (${moved.toFixed(0)} units)`);
    else bad('the left stick did not move the player', `moved ${moved.toFixed(1)} units`);

    // 3. the right half: drag 250 px to the right
    const y0 = last().yaw;
    await c.drag(W * 0.62, H * 0.4, 250, 12);
    await sleep(700);
    let dyaw = Math.abs(((last().yaw - y0) + 540) % 360 - 180);
    if (dyaw > 15) ok(`a drag on the right half turns the player (${dyaw.toFixed(0)} degrees)`);
    else bad('the right-half drag did not turn the player', `yaw changed ${dyaw.toFixed(1)} degrees`);

    // 4 and 5. FIRE, held 2 s: ammo goes down, and the player does not move.
    // On the super shotgun (key 3): a Soldier's rockets push him back off a wall.
    await c.eval(`FTEC.cbufadd('impulse 3\\n')`);
    await sleep(1200);
    const fire = await c.eval(`(() => { const b = document.querySelector('#qwtf-touch [data-id=fire]').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    const a0 = last();
    await c.hold(fire.x, fire.y, 2000, 3);
    await sleep(800);
    const a1 = last();
    if (a1.ammo < a0.ammo) ok(`holding FIRE fires (ammo ${a0.ammo} -> ${a1.ammo})`);
    else bad('holding FIRE did not fire', `ammo ${a0.ammo} -> ${a1.ammo}`);
    const drift = Math.hypot(a1.x - a0.x, a1.y - a0.y);
    if (drift < 24) ok(`a touch on a button does not reach the engine (moved ${drift.toFixed(0)} units while firing)`);
    else bad('a button touch leaked into the engine', `moved ${drift.toFixed(0)} units while holding FIRE`);
    await c.screenshot(path.join(ART, 'phone.png'));
  } finally {
    await c.stop();
    try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {}
    try { process.kill(-sv.pid, 'SIGKILL'); } catch (e) {}
    console.log('  run dir: tests/artifacts/touch (server.log, phone.png)');
  }
}

main().then(() => { console.log(failed ? `FAIL: ${failed} checks` : 'PASS'); process.exit(failed ? 1 : 0); })
  .catch(e => { console.log('FAIL: ' + e.message); process.exit(1); });
