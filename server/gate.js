#!/usr/bin/env node
'use strict';
/* server/gate.js -- the front door.
 *
 * A scanner that finds this server must get one small, boring static page and
 * nothing else: no game download, no game-server connection, no process
 * creation, no meaningful CPU. Only a person who deliberately presses Play gets
 * the game, then the connection, then the lobby. PROJECT.md "Front door".
 *
 * One origin, one port. Everything a browser does happens here:
 *
 *   /              landing page, static, <= 10 KB, no engine script
 *   /robots.txt    disallow everything
 *   POST /api/session   short-lived signed token, set as a cookie
 *   /play/...      the engine and content, ONLY with a valid cookie
 *   /play/ws       WebSocket, validated on upgrade, then piped to FTE
 *
 * The game server is internal only: FTE listens on 127.0.0.1 and this process is
 * the only listener reachable from outside. Nothing here ever binds a port that
 * is meant to be reachable -- we bind one port and connect out to FTE.
 *
 * Node built-ins only (http, net, crypto, fs, path). No dependencies, because a
 * gate is exactly the thing that must not break in an interesting way.
 *
 * Config from the environment, so M6's container needs no code change:
 *   GATE_PORT     port to listen on                  (default 8080)
 *   GATE_SECRET   HMAC secret for session tokens     (required in production)
 *   GATE_ROOT     snapshot directory holding web/    (required)
 *   FTE_HOST/FTE_PORT   the internal game server     (default 127.0.0.1:27500)
 *   GATE_POW_BITS leading zero bits required of a session request (default 0)
 *   GATE_MAX_SESSIONS / GATE_MAX_SESSION_RATE  per-IP limits
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.GATE_PORT || '8080', 10);
const HOST = process.env.GATE_HOST || '0.0.0.0';
const FTE_HOST = process.env.FTE_HOST || '127.0.0.1';
const FTE_PORT = parseInt(process.env.FTE_PORT || '27500', 10);
const POW_BITS = parseInt(process.env.GATE_POW_BITS || '0', 10);
const SESSION_TTL = parseInt(process.env.GATE_SESSION_TTL || '300', 10);
const IDLE_MS = parseInt(process.env.GATE_IDLE_MS || '60000', 10);
/* Inactivity limit for a plain HTTP connection that never finishes its headers. */
const CONN_IDLE_MS = parseInt(process.env.GATE_CONN_IDLE_MS || '15000', 10);
const MAX_SESSIONS = parseInt(process.env.GATE_MAX_SESSIONS || '4', 10);
const MAX_SESSION_RATE = parseInt(process.env.GATE_MAX_SESSION_RATE || '10', 10);
/* The rate window and the sweep interval are configurable so the pruning of
 * ipState (0066 item 4) can be tested in seconds rather than by waiting a
 * minute for a real window to expire. */
const RATE_WINDOW_MS = parseInt(process.env.GATE_RATE_WINDOW_MS || '60000', 10);
const SWEEP_MS = parseInt(process.env.GATE_SWEEP_MS || '60000', 10);

/* A missing secret must not silently mean "everyone may have a session". In
 * development we fall back to a fixed dev secret and say so on stderr; in
 * production (GATE_ENV=production) it is fatal. */
const SECRET = process.env.GATE_SECRET || 'qwtf-dev-secret-do-not-use';
if (!process.env.GATE_SECRET) {
  if (process.env.GATE_ENV === 'production') {
    console.error('FATAL: GATE_SECRET must be set in production');
    process.exit(1);
  }
  console.error('WARNING: GATE_SECRET unset, using the dev secret. Sessions are forgeable.');
}

if (!process.env.GATE_ROOT) {
  console.error('FATAL: GATE_ROOT must point at a deployed snapshot (see scripts/deploy_snapshot.sh)');
  process.exit(1);
}
const ROOT = path.resolve(process.env.GATE_ROOT);
if (!fs.existsSync(path.join(ROOT, 'landing', 'index.html'))) {
  console.error(`FATAL: no landing page at ${path.join(ROOT, 'landing/index.html')}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- helpers */

const b64u = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function clientIp(req) {
  // Only trust a forwarding header if a proxy in front of us sets it; in the
  // default deployment the gate IS the edge, so the socket address is honest.
  const fwd = process.env.GATE_TRUST_PROXY ? req.headers['x-forwarded-for'] : null;
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/* Per-IP limits. A scanner hits /api/session in a loop; a person clicks once. */
const ipState = new Map();
const IP_STATE_MAX = 10000;

/* Sweep expired entries so a scan from many source addresses cannot grow this
 * map without bound (reviewer 0066 item 4). Entries older than the rate window
 * are of no use to anyone. */
const ipSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, st] of ipState) {
    if (st.window < cutoff) ipState.delete(ip);
  }
  // Hard cap: if it is somehow still huge, drop the oldest half rather than
  // letting memory grow. Losing rate-limit history is better than dying.
  if (ipState.size > IP_STATE_MAX) {
    const keys = [...ipState.keys()].slice(0, Math.floor(IP_STATE_MAX / 2));
    for (const k of keys) ipState.delete(k);
  }
}, SWEEP_MS);
ipSweep.unref();

/* Open game connections, per IP and in total. Without this a single valid token
 * could open unlimited WebSockets for its whole 5 minute life (0066 item 2). */
const MAX_WS_PER_IP = parseInt(process.env.GATE_MAX_WS_PER_IP || '2', 10);
const MAX_WS_TOTAL = parseInt(process.env.GATE_MAX_WS_TOTAL || '16', 10);
const wsPerIp = new Map();
let wsTotal = 0;

function wsSlot(ip) {
  const n = (wsPerIp.get(ip) || 0);
  return { ok: n < MAX_WS_PER_IP && wsTotal < MAX_WS_TOTAL, perIp: n };
}
function wsOpen(ip) {
  wsPerIp.set(ip, (wsPerIp.get(ip) || 0) + 1);
  wsTotal++;
}
function wsClose(ip) {
  const n = (wsPerIp.get(ip) || 0) - 1;
  if (n > 0) wsPerIp.set(ip, n); else wsPerIp.delete(ip);
  if (wsTotal > 0) wsTotal--;
}
function rateLimited(ip) {
  const now = Date.now();
  let s = ipState.get(ip);
  if (!s || now - s.window > RATE_WINDOW_MS) s = { window: now, hits: 0, sessions: 0 };
  s.hits++;
  const over = s.hits > MAX_SESSION_RATE || s.sessions >= MAX_SESSIONS;
  ipState.set(ip, s);
  return { over, state: s };
}
function noteSession(ip) {
  const s = ipState.get(ip);
  if (s) s.sessions++;
}

/* An unauthenticated answer. Deliberately tiny and identical for every failure,
 * so a scanner learns nothing from the difference between 403 and 404. */
function deny(res, code) {
  const body = Buffer.from('no\n');
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

/* --------------------------------------------------------------- sessions */

/* HMAC-SHA256 over expiry, nonce and client IP, so a token is only good for the
 * address it was issued to and cannot be replayed after it expires. */
function issueToken(ip) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    nonce: crypto.randomBytes(8).toString('hex'),
    ip,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(token, ip) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = b64u(crypto.createHmac('sha256', SECRET).update(body).digest());
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (sig.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch (e) { return false; }
  if (!payload || typeof payload.exp !== 'number') return false;
  if (payload.exp * 1000 < Date.now()) return false;
  if (payload.ip !== ip) return false;
  return true;
}

/* Production is HTTPS only, so the cookie must be Secure there, or a plain-http
 * request on the same host could set it and then ride an unencrypted connection
 * (0066 item 6). Only trust x-forwarded-proto when a proxy in front of us is
 * declared. */
function secureSuffix(req) {
  const https = process.env.GATE_ENV === 'production' ||
    (process.env.GATE_TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  return https ? '; Secure' : '';
}

function cookieToken(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'qwtf') {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/* ------------------------------------------------------------ proof of work */

/* Optional: the client finds a nonce whose SHA-256 has POW_BITS leading zero
 * bits. The server checks in O(1) -- it hashes once and counts leading zeros.
 * POW_BITS=0 disables it. */
function checkPow(bits, nonce) {
  if (bits <= 0) return true;
  if (!nonce || nonce.length > 128) return false;
  const digest = crypto.createHash('sha256').update(String(nonce)).digest();
  let zeros = 0;
  for (const byte of digest) {
    if (byte === 0) { zeros += 8; continue; }
    zeros += Math.clz32(byte) - 24;
    break;
  }
  return zeros >= bits;
}

/* ------------------------------------------------------------ static files */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pak': 'application/octet-stream',
  '.wad': 'application/octet-stream',
  '.bsp': 'application/octet-stream',
  '.ogg': 'audio/ogg',
  '.dat': 'application/octet-stream',
  '.mdl': 'model/vnd.quake',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

/* Resolve a URL path inside ROOT, or null if it tries to escape. */
function safeResolve(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('\0')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function serveFile(req, res, file, extraHeaders) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return deny(res, 404);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    /* Serve the precompressed sibling when the client accepts gzip and the
     * sibling is fresh (0484): scripts/precompress_web.sh keeps one next to
     * every content file, verified to decompress byte-identically, and the
     * <= 8 MB download row is measured on these gzipped bytes. A stale or
     * missing sibling is not an error -- raw bytes are the fallback, exactly
     * as before. Same guard rationale as tools/serve.js. */
    const gz = file + '.gz';
    const send = (size, stream, encHeaders) => {
      const headers = Object.assign({
        'content-type': type,
        'content-length': size,
        'cache-control': 'no-cache',
      }, extraHeaders || {}, encHeaders || {});
      res.writeHead(200, headers);
      stream().pipe(res);
    };
    if (/gzip/.test(req.headers['accept-encoding'] || '')) {
      fs.stat(gz, (gerr, gst) => {
        if (!gerr && gst.isFile()) {
          if (gst.mtimeMs >= st.mtimeMs) {
            return send(gst.size,
              () => fs.createReadStream(gz),
              { 'content-encoding': 'gzip', vary: 'Accept-Encoding' });
          }
          console.warn(`[gate] stale .gz, serving raw: ${file}`);
        }
        send(st.size, () => fs.createReadStream(file));
      });
      return;
    }
    send(st.size, () => fs.createReadStream(file));
  });
}

/* ---------------------------------------------------------------- routing */

const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  let pathname;
  try { pathname = new URL(req.url, 'http://gate.invalid').pathname; }
  catch (e) { return deny(res, 400); }

  // Bots should not be told what this is.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    return deny(res, 405);
  }

  if (pathname === '/robots.txt') {
    const body = Buffer.from('User-agent: *\nDisallow: /\n');
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
    return res.end(body);
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  // Stage 1: the landing page. Static, small, and the only thing an anonymous
  // visitor can obtain. It must not reference the engine.
  if (pathname === '/' || pathname === '/index.html') {
    return serveFile(req, res, path.join(ROOT, 'landing', 'index.html'),
      { 'cache-control': 'no-store' });
  }

  // Stage 2: a person asks for a session.
  if (pathname === '/api/session' && req.method === 'POST') {
    const limit = rateLimited(ip);
    if (limit.over) return deny(res, 429);
    /* 1 KB cap, enforced by aborting the request rather than buffering it.
     * The only legitimate body is {"nonce":"..."} and a PoW nonce is short, so
     * anything larger is either a mistake or an attempt to make us allocate
     * (0066 item 5). */
    const BODY_MAX = 1024;
    let body = '';
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      body += c;
      if (body.length > BODY_MAX) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      let nonce = null;
      try { nonce = JSON.parse(body || '{}').nonce; } catch (e) { /* no PoW asked */ }
      if (!checkPow(POW_BITS, nonce)) {
        const r = deny(res, 403);
        return r;
      }
      const token = issueToken(ip);
      noteSession(ip);
      const out = JSON.stringify({ ok: true, pow: POW_BITS, ttl: SESSION_TTL });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(out),
        'cache-control': 'no-store',
          'set-cookie': `qwtf=${encodeURIComponent(token)}; Path=/; HttpOnly; ` +
          `SameSite=Strict; Max-Age=${SESSION_TTL}` + secureSuffix(req),
      });
      res.end(out);
    });
    return;
  }

  // Stage 3 and 4: everything else needs a valid session. /play/ws is handled in
  // the upgrade handler below, but it must be refused here for plain GETs.
  if (pathname === '/play' || pathname.startsWith('/play/')) {
    if (pathname === '/play/ws') return deny(res, 400); // needs an upgrade
    if (!verifyToken(cookieToken(req), ip)) return deny(res, 403);
    const rel = pathname.slice('/play'.length) || '/index.html';
    const file = safeResolve(ROOT, rel);
    if (!file) return deny(res, 403);
    return serveFile(req, res, file);
  }

  // Anything else: a tiny 404 with no listing, no hints, no directory names.
  return deny(res, 404);
});

/* ------------------------------------------------------- the WebSocket gate */

/* Stage 4. The token is checked HERE, on the HTTP upgrade, before a single byte
 * goes to the game server -- so an unauthenticated scanner never causes a
 * connection to FTE at all, which is the whole point (PROJECT.md stage 4, and
 * the done-when asserts FTE's log shows no connection). */
server.on('upgrade', (req, socket) => {
  const ip = clientIp(req);

  /* An aborted handshake -- the client that read the refusal's status line and
   * hung up before the body was drained -- surfaces here as ECONNRESET. Without
   * a handler on THIS socket Node kills the whole gate on it, and this handler
   * attaches one before any of the refusals below can return early: the error
   * and close handlers further down are only wired after the game server is
   * contacted, and a scanner refused on the token never reaches them. Measured
   * by tests/test_container.sh's entry-logic run: one raw probe that read the
   * 403 and closed immediately took the gate down, and with it the page and
   * every session. */
  socket.on('error', () => { try { socket.destroy(); } catch (e) {} });

  let pathname;
  try { pathname = new URL(req.url, 'http://gate.invalid').pathname; }
  catch (e) { pathname = ''; }

  if (pathname !== '/play/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (!verifyToken(cookieToken(req), ip)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    return;
  }

  /* Concurrency caps, checked BEFORE the game server is contacted so a refused
   * connection costs FTE nothing (0066 item 2). */
  const slot = wsSlot(ip);
  if (!slot.ok) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wsOpen(ip);

  /* Forward the upgrade request verbatim and let FTE answer it.
   *
   * The gate must NOT write its own "101 Switching Protocols": a real handshake
   * response carries Sec-WebSocket-Accept, which only the server that read
   * Sec-WebSocket-Key can compute. I fabricated the 101 here first and the
   * browser rejected it -- the client showed "Unable to connect to
   * ws://127.0.0.1:PORT/play/ws" while everything else about the flow was fine.
   * So: pass the request through, pipe FTE's response back untouched, and only
   * then start piping frames both ways. */
  const upstream = net.connect(FTE_PORT, FTE_HOST, () => {
    /* Forward only what the handshake needs. Forwarding everything would hand
     * the game server our session cookie -- the upgrade request carries it,
     * because the browser sends cookies on a WebSocket handshake like any other
     * request, and FTE has no use for it (0066 item 3). A whitelist is safer
     * than a blacklist here: anything new in the request cannot leak by default.
     */
    const FORWARD = new Set(['host', 'upgrade', 'connection',
      'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
      'sec-websocket-extensions', 'origin', 'user-agent']);
    const lines = [`GET ${req.url} HTTP/1.1`];
    const seen = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      const value = req.rawHeaders[i + 1];
      if (!FORWARD.has(name) || seen.has(name)) continue;
      seen.add(name);
      lines.push(`${name}: ${value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const drop = () => { try { socket.destroy(); } catch (e) {} try { upstream.destroy(); } catch (e) {} };
  upstream.on('error', drop);
  socket.on('error', drop);

  /* Idle close that actually re-arms.
   *
   * The first version did `socket.on('data', () => clearTimeout(idle))`, so any
   * connection that said one byte and then nothing lived forever -- exactly the
   * slow-drip case an idle limit exists for. setTimeout() is an inactivity
   * timer that the socket resets on every read, which is the behaviour wanted
   * (0066 item 1). Must be above the platform's idle timeout in production. */
  socket.setTimeout(IDLE_MS, drop);
  upstream.setTimeout(IDLE_MS, drop);

  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    wsClose(ip);
    upstream.destroy();
  };
  socket.on('close', release);
  upstream.on('close', release);
  socket.on('end', release);
});

/* Header and request timeouts. The default is 60 s, which is a long time to
 * hold a connection open for a client that sends nothing (0066 item 5). */
server.headersTimeout = 5000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;

/* headersTimeout is NOT enough on its own, and I checked rather than assumed:
 * with headersTimeout=1000 a socket that sends nothing at all is still open
 * after five seconds, because Node only starts that timer once bytes arrive.
 * That is exactly the slow-drip case, so every connection also gets an
 * inactivity timer of its own. The WebSocket path replaces this with IDLE_MS
 * once it has decided to upgrade. */
server.on('connection', socket => {
  socket.setTimeout(CONN_IDLE_MS, () => socket.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`gate listening on ${HOST}:${PORT}`);
  console.log(`  root      ${ROOT}`);
  console.log(`  fte       ${FTE_HOST}:${FTE_PORT} (internal only)`);
  console.log(`  pow bits  ${POW_BITS}, session ttl ${SESSION_TTL}s`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));