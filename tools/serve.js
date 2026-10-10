#!/usr/bin/env node
/* Static server for static/ plus an upload endpoint for static/js/recorder.js.
 *
 *   node tools/serve.js [--port 8200]
 *
 * POST /api/upload  (JSON from recorder.js) -> recordings/<id>/
 *   recording: rec.json (poses, keys, marks, note), thumbs/NNNN.jpg, contact.jpg,
 *              marks.jpg (frames around each F9 marker)
 *   snapshot:  shot.json, image.png, faceid.png
 *   note.txt   whatever the user typed
 * recordings/LATEST holds the newest id.  GET /recordings/ lists them.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/* --root <dir> overrides the served directory. Defaults to static/ (the
 * retired custom engine's page). M1 onwards the game is FTEQW, whose build
 * output lives in web/, so: node tools/serve.js --port 8200 --root web */
const argRoot = process.argv.indexOf('--root');
const STATIC = argRoot > 0 ? path.resolve(process.argv[argRoot + 1])
                           : path.join(ROOT, 'static');
const REC = path.join(ROOT, 'recordings');
const argPort = process.argv.indexOf('--port');
const PORT = argPort > 0 ? parseInt(process.argv[argPort + 1], 10) : 8200;
const MAX_BODY = 80 * 1024 * 1024;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.txt': 'text/plain', '.cfg': 'text/plain', '.css': 'text/css',
  '.bsp': 'application/octet-stream', '.wad': 'application/octet-stream',
  '.dat': 'application/octet-stream', '.pak': 'application/octet-stream',
};

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function writeDataUrl(file, url) {
  const m = /^data:image\/(png|jpeg);base64,(.*)$/.exec(url || '');
  if (!m) return false;
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return true;
}

/* Join the mock server's per-command movement log (server/proxy.js logMove)
 * onto a recording.  The client numbers its clientcmds from CL_Connect and the
 * server numbers them per connection; WebSocket delivery is ordered, so equal
 * seq = the same command.  Writes server.jsonl (that client's raw server log),
 * moves.jsonl (joined rows with checks) and moves-summary.txt. */
const MOVELOG = process.env.QWTF_MOVELOG || '/tmp/qwtf-server-moves.jsonl';
function joinServerLog(dir, body) {
  const lo = (body.wallStart || 0) - 1000, hi = (body.wallEnd || Date.now()) + 1000;
  const lines = [];
  for (const f of [MOVELOG + '.1', MOVELOG]) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const l of txt.split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (e.ts >= lo && e.ts <= hi) lines.push(e); } catch (e) { /* torn line */ }
    }
  }
  const frames = body.frames || [];
  const bySeq = new Map();
  frames.forEach((fr, i) => { if (fr.c && fr.c.seq > 0 && !bySeq.has(fr.c.seq)) bySeq.set(fr.c.seq, i); });
  if (!lines.length || !bySeq.size) {
    fs.writeFileSync(path.join(dir, 'moves-summary.txt'),
      `no join: ${lines.length} server log lines in the time window, ${bySeq.size} client cmd samples\n` +
      '(was the client connected to server/proxy.js --mock, and is the move log enabled?)\n');
    return;
  }
  // pick the server-side client whose seq numbers line up with ours
  const score = new Map();
  for (const e of lines) if (bySeq.has(e.seq)) score.set(e.client, (score.get(e.client) || 0) + 1);
  const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) { fs.writeFileSync(path.join(dir, 'moves-summary.txt'), 'no join: seq numbers never matched\n'); return; }
  const mine = lines.filter(e => e.client === best[0]).sort((a, b) => a.seq - b.seq);
  fs.writeFileSync(path.join(dir, 'server.jsonl'), mine.map(e => JSON.stringify(e)).join('\n') + '\n');
  const angDiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };
  const n = { rows: 0, sampled: 0, fieldMismatch: 0, yawMismatch: 0, blocked: 0 };
  const rows = mine.map(e => {
    const i = bySeq.get(e.seq), fr = i === undefined ? null : frames[i];
    const blocked = [0, 1, 2].map(k => Math.abs(e.after[k] - e.want[k]) > 0.01);
    const row = { seq: e.seq, ts: e.ts, server: e, blocked };
    n.rows++;
    if (blocked[0] || blocked[1]) n.blocked++;
    if (fr) {
      n.sampled++;
      row.f = i; row.t = fr.t; row.keys = fr.k; row.clientOrigin = fr.o; row.viewAngles = fr.a; row.clientCmd = fr.c;
      row.fieldsMatch = fr.c.forw === e.forw && fr.c.side === e.side && fr.c.up === e.up;
      // viewAngles are [roll, pitch, yaw]: did the server steer by the yaw the player was looking along?
      row.serverYawMinusViewYaw = Math.round(angDiff(e.yawUsedDeg, fr.a[2]) * 10) / 10;
      if (!row.fieldsMatch) n.fieldMismatch++;
      if (row.serverYawMinusViewYaw > 1 && (e.forw || e.side)) n.yawMismatch++;
    }
    return row;
  });
  fs.writeFileSync(path.join(dir, 'moves.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'moves-summary.txt'), [
    `server client ${best[0]}: ${n.rows} clientcmds integrated, ${n.sampled} matched to a recorder frame`,
    `forw/side/up differ between client and server: ${n.fieldMismatch}`,
    `server steered by a yaw != the player's view yaw (while moving): ${n.yawMismatch}`,
    `horizontal move blocked/slid by collision: ${n.blocked}`,
    'rows: moves.jsonl  (server.before/want/after, clientOrigin, clientCmd, keys)',
  ].join('\n') + '\n');
}

function saveUpload(body) {
  const kind = body.kind === 'snapshot' ? 'snap' : 'rec';
  const id = `${stamp()}-${kind}`;
  const dir = path.join(REC, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.txt'), (body.note || '').trim() + '\n');
  if (kind === 'snap') {
    writeDataUrl(path.join(dir, 'image.png'), body.image);
    writeDataUrl(path.join(dir, 'faceid.png'), body.faceid);
    const meta = Object.assign({}, body); delete meta.image; delete meta.faceid;
    fs.writeFileSync(path.join(dir, 'shot.json'), JSON.stringify(meta, null, 1));
  } else {
    fs.mkdirSync(path.join(dir, 'thumbs'));
    const thumbs = (body.thumbs || []).map((t, i) => {
      const name = `thumbs/${String(i).padStart(4, '0')}.jpg`;
      writeDataUrl(path.join(dir, name), t.d);
      return { f: t.f, t: t.t, file: name };
    });
    const meta = Object.assign({}, body, { thumbs });
    fs.writeFileSync(path.join(dir, 'rec.json'), JSON.stringify(meta));
    try { joinServerLog(dir, body); } catch (e) { console.log(`[serve] move join failed: ${e.message}`); }
    const r = spawnSync('python3', [path.join(__dirname, 'contact_sheet.py'), dir], { encoding: 'utf8' });
    if (r.status !== 0) console.log(`[serve] contact sheet failed: ${(r.stderr || '').slice(0, 300)}`);
  }
  fs.writeFileSync(path.join(REC, 'LATEST'), id + '\n');
  return id;
}

function listing(res) {
  fs.mkdirSync(REC, { recursive: true });
  const ids = fs.readdirSync(REC).filter(n => fs.statSync(path.join(REC, n)).isDirectory()).sort().reverse();
  const rows = ids.map(id => {
    const note = (() => { try { return fs.readFileSync(path.join(REC, id, 'note.txt'), 'utf8').trim(); } catch (e) { return ''; } })();
    const img = ['contact.jpg', 'image.png'].find(f => fs.existsSync(path.join(REC, id, f)));
    return `<li><a href="/recordings/${id}/${img || ''}">${id}</a> ${note.replace(/</g, '&lt;')}</li>`;
  }).join('');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><meta charset=utf-8><title>Recordings</title><ul>${rows}</ul>`);
}

const srv = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url === '/api/upload') {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413); res.end('{"error":"too large"}'); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try {
        const id = saveUpload(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        console.log(`[serve] saved recordings/${id}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        console.log(`[serve] upload failed: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url === '/recordings' || url === '/recordings/') return listing(res);
  let base = STATIC, rel = url === '/' ? '/index.html' : url;
  if (rel.startsWith('/recordings/')) { base = REC; rel = rel.slice('/recordings'.length); }
  const file = path.join(base, rel);
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    /* Serve the precompressed sibling when the client accepts gzip and the
     * sibling is fresh. The M6 download row is measured against this server
     * (tests/loadtime.js), and until 0484 it served raw bytes while verified
     * .gz files sat next to them: the "wire" was exactly the raw count. The
     * staleness guard is not decoration -- FTE's build once shipped a
     * truncated .wasm.gz with exit 0 (see scripts/build_fte_web.sh), so a
     * sibling older than its source is served raw and named in the log
     * instead of being trusted. Browsers that do not send Accept-Encoding
     * (raw node http.get in tests) get the identical bytes as before. */
    const gz = file + '.gz';
    const serveRaw = () => {
      fs.readFile(file, (err2, buf) => {
        if (err2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    };
    if (!/gzip/.test(req.headers['accept-encoding'] || '')) return serveRaw();
    fs.stat(gz, (gerr, gst) => {
      if (gerr || !gst.isFile()) return serveRaw();
      if (gst.mtimeMs < st.mtimeMs) {
        console.warn(`[serve] stale .gz, serving raw: ${rel}`);
        return serveRaw();
      }
      fs.readFile(gz, (rerr, buf) => {
        if (rerr) return serveRaw();
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache',
                             'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
        res.end(buf);
      });
    });
  });
});
srv.listen(PORT, () => console.log(`[serve] static/ on :${PORT}, uploads -> ${REC}`));
