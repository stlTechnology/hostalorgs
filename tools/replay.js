#!/usr/bin/env node
/* Re-render what a user saw, headless, from recorded camera poses.
 *
 *   node tools/replay.js recordings/<id>                 # thumbnail frames, normal view
 *   node tools/replay.js recordings/<id> --views 0,1,6   # also face-id and triangle-id
 *   node tools/replay.js recordings/<id> --views all --from 3 --to 5
 *   node tools/replay.js recordings/<snap-id> --views all   # a snapshot's pose
 *   node tools/replay.js --pose 64,240,45,90,10 --views all --out /tmp/shots
 *
 * Output (under <dir>/replay/ unless --out):
 *   v<N>/<frame>.png      rendered frames per debug view (frame = recording index)
 *   metrics.json          per frame: tris, NaN verts, worst near-z, origin drift
 *   compare_v<N>.jpg      user's frame (left) vs replay (right), via contact_sheet.py
 *
 * Views: 0 normal, 1 face id, 2 lightmap, 3 texture, 4 UV checker, 5 depth,
 * 6 triangle id.  Face ids decode from a view-1 pixel: tools/faceat.py.
 *
 * The replay is OFFLINE (no server), so bots and other entities are absent;
 * it reproduces the world render only.  Poses come from what the client
 * actually rendered, so this works for connected sessions too.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WS = require(path.join(ROOT, 'node_modules', 'ws'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function args() {
  const a = process.argv.slice(2), o = { views: [0], all: false };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--views') o.views = a[++i] === 'all' ? [0, 1, 2, 3, 4, 5, 6] : a[i].split(',').map(Number);
    else if (k === '--from') o.t0 = parseFloat(a[++i]);
    else if (k === '--to') o.t1 = parseFloat(a[++i]);
    else if (k === '--all') o.all = true;
    else if (k === '--every') o.every = parseInt(a[++i], 10);
    else if (k === '--pose') o.pose = a[++i].split(',').map(Number);
    else if (k === '--map') o.map = a[++i];
    else if (k === '--size') o.size = a[++i].split('x').map(Number);
    else if (k === '--out') o.out = a[++i];
    else if (!o.dir) o.dir = k;
    else throw new Error('unknown arg ' + k);
  }
  return o;
}

/* Build the list of {f, o, a} poses to render. */
function poses(o) {
  if (o.pose) {
    const [x, y, z, yaw, pitch] = o.pose;
    return { list: [{ f: 0, o: [x, y, z], a: [0, pitch || 0, yaw || 0] }], size: o.size || [1280, 800] };
  }
  const snap = path.join(o.dir, 'shot.json');
  if (fs.existsSync(snap)) {
    const s = JSON.parse(fs.readFileSync(snap, 'utf8'));
    return { list: [{ f: 0, o: s.pose.o, a: s.pose.a }], size: o.size || s.canvas || [1280, 800] };
  }
  const rec = JSON.parse(fs.readFileSync(path.join(o.dir, 'rec.json'), 'utf8'));
  let idx;
  if (o.all) idx = rec.frames.map((_, i) => i);
  else if (o.every) idx = rec.frames.map((_, i) => i).filter(i => i % o.every === 0);
  else idx = (rec.thumbs || []).map(t => t.f);
  idx = idx.filter(i => {
    const t = rec.frames[i].t;
    return (o.t0 === undefined || t >= o.t0) && (o.t1 === undefined || t <= o.t1);
  });
  return { list: idx.map(i => ({ f: i, o: rec.frames[i].o, a: rec.frames[i].a })),
           size: o.size || rec.canvas || [1280, 800], hasThumbs: !o.all && !o.every };
}

function staticServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
  const base = path.join(ROOT, 'static');
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(base, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  const o = args();
  if (!o.dir && !o.pose) {
    console.log('usage: node tools/replay.js recordings/<id> [--views 0,1,6|all] [--from s --to s] [--all|--every N]');
    console.log('       node tools/replay.js --pose x,y,z,yaw,pitch [--views all] [--out dir]');
    process.exit(2);
  }
  const P = poses(o);
  const outDir = o.out || path.join(o.dir || '.', 'replay');
  fs.mkdirSync(outDir, { recursive: true });
  const [W, H] = P.size.map(v => Math.min(v, 1920));

  const srv = await staticServer();
  const port = srv.address().port;
  const cdpPort = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync('/tmp/qwtf-replay-');
  const chrome = spawn('google-chrome', [
    '--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `--window-size=${W + 40},${H + 40}`, '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  const cleanup = () => {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { /* gone */ }
    srv.close();
    fs.rmSync(profile, { recursive: true, force: true });
  };
  const watchdog = setTimeout(() => { console.error('replay: watchdog (10 min)'); cleanup(); process.exit(1); }, 600000);

  const req = p => new Promise((res, rej) => {
    http.request({ host: '127.0.0.1', port: cdpPort, path: p, method: 'PUT' }, x => {
      let d = ''; x.on('data', c => d += c); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej).end();
  });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { try { t = await req('/json/new?about:blank'); } catch (e) { await sleep(300); } }
    if (!t) throw new Error('chrome devtools never came up');
    const ws = new WS(t.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
    let id = 0; const pend = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
    await new Promise(r => ws.on('open', r));
    const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r && r.result ? r.result.value : null;
    };
    await send('Page.enable'); await send('Runtime.enable');
    // dead relay: stay offline so the free camera is ours to place
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html?connect=ws://127.0.0.1:1&map=${o.map || 'corridor'}` });

    let loaded = false;
    for (let i = 0; i < 160 && !loaded; i++) {
      await sleep(250);
      try {
        await ev('window.Module && Module._qwtfFrame ? Module._qwtfFrame() : 0');
        loaded = /map loaded/.test(await ev("(document.getElementById('qwtf-log')||{}).textContent||''") || '');
      } catch (e) { /* page still booting */ }
    }
    if (!loaded) throw new Error('map never loaded in headless page');

    await ev(`(function(){
      ['qwtf-hud','qwtf-boot','qwtf-bar','qwtf-log'].forEach(function(id){var e=document.getElementById(id); if(e) e.style.display='none';});
      var c=document.getElementById('qwtf-canvas');
      c.style.cssText='position:fixed;left:0;top:0;width:${W}px;height:${H}px;z-index:9999';
      c.width=${W}; c.height=${H}; Module._qwtfResize(${W},${H});
      window.__rp = Module._malloc(16);
      return 1;})()`);

    const metrics = [];
    for (const v of o.views) {
      const vd = path.join(outDir, `v${v}`);
      fs.mkdirSync(vd, { recursive: true });
      for (const p of P.list) {
        // one task: place, render, read back -- nothing else can run in between
        const r = await ev(`(function(){
          var M=Module;
          M._qwtfSetDebugView(${v});
          M._qwtfSetView(${p.o[0]},${p.o[1]},${p.o[2]},${p.a[2]},${p.a[1]});
          if (M._qwtfDbgReset) M._qwtfDbgReset();
          M._qwtfFrame();
          var f=new Float32Array(M.HEAPU8.buffer, window.__rp, 3);
          M._qwtfGetOrigin(window.__rp);
          var drift=Math.hypot(f[0]-${p.o[0]},f[1]-${p.o[1]},f[2]-${p.o[2]});
          return { png: document.getElementById('qwtf-canvas').toDataURL('image/png'),
                   tris: M._qwtfLastTriCount(), sorted: M._qwtfLastTriSorted(),
                   nan: M._qwtfDbgNan ? M._qwtfDbgNan() : null,
                   near: M._qwtfDbgNear ? M._qwtfDbgNear() : null, drift: drift };
        })()`);
        fs.writeFileSync(path.join(vd, `${String(p.f).padStart(5, '0')}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
        delete r.png;
        metrics.push(Object.assign({ f: p.f, view: v }, r));
      }
      console.log(`view ${v}: ${P.list.length} frame(s) -> ${vd}`);
    }
    await ev('Module._qwtfSetDebugView(0)');
    fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 1));
    const bad = metrics.filter(m => m.nan > 0 || (m.near !== null && m.near > -0.04));
    console.log(`metrics -> ${path.join(outDir, 'metrics.json')}  (${bad.length} frame(s) with NaN or vertices past the near plane)`);
    const drift = Math.max(0, ...metrics.map(m => m.drift || 0));
    if (drift > 2) console.log(`note: camera drifted up to ${drift.toFixed(1)}u during a frame (offline free-mover gravity?)`);

    if (P.hasThumbs) {
      for (const v of o.views) {
        const r = spawnSync('python3', [path.join(__dirname, 'contact_sheet.py'), o.dir,
          '--replay', path.join(outDir, `v${v}`), '--out', path.join(outDir, `compare_v${v}.jpg`), '--n', '12',
          ...(o.t0 !== undefined ? ['--from', String(o.t0)] : []), ...(o.t1 !== undefined ? ['--to', String(o.t1)] : [])],
          { encoding: 'utf8' });
        if (r.status === 0) console.log(`compare -> ${r.stdout.trim()}`);
        else console.log(`contact sheet failed: ${r.stderr.slice(0, 300)}`);
      }
    }
  } catch (e) {
    console.error('replay failed: ' + e.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    cleanup();
  }
})();
