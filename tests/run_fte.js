#!/usr/bin/env node
/**
 * Test runner for the FTEQW-based game (PLAN.md M1 onwards).
 *
 * Distinct from tests/run_all.js, which drives the retired custom engine in
 * client/ and is kept frozen for reference.
 *
 * Phases, in dependency order:
 *   1. test_wad.py      web/id1/our.wad parses as a real WAD2, and the pixels
 *                       decode back to the source textures' palette entries
 *   2. manifest         web/index.html's generated content list matches web/id1
 *   3. source offer     web/SOURCE.md (the GPL v2 source offer) is up to date
 *   4. test_fte_web.js  the real page in headless Chrome: the map loads, a
 *                       player spawns, and the canvas shows lit geometry
 *
 * Phase 4 needs Chrome; it starts its own page server and dedicated server on
 * PID-derived ports (see PORT/SV_PORT below), so nothing has to be running
 * first and it cannot collide with a human's or another test's server.
 *   node tests/run_fte.js
 *
 * Usage:
 *   node tests/run_fte.js               everything (starts its own server)
 *   node tests/run_fte.js --no-browser   skip the headless-Chrome phase
 *   node tests/run_fte.js --list
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/* Ports are derived from the PID, never hardcoded.
 *
 * They used to be fixed at 8200 (the page) and, in test_fte_web.js, 27510 (the
 * game server) -- which are exactly the ports the owner's play-test runs on
 * (reviewer 0053). Phase 4 therefore attached itself to whatever already held
 * them, and when that was the long-lived play server it failed with a black
 * canvas: the owner's log filled with "client Player connected / Client Player
 * removed" while the same phase scored 31/31 against a server it started
 * itself. A test must never silently measure someone else's server. These
 * offsets differ from mp_combat.js/mp_smoke.js so the suites can run together. */
const PORT = 8300 + (process.pid % 300);        // page (tools/serve.js)
const SV_PORT = 28300 + (process.pid % 300);    // dedicated server

const C = {
  g: '\u001b[32m', r: '\u001b[31m', d: '\u001b[2m', b: '\u001b[7m', x: '\u001b[0m',
};

const argv = process.argv.slice(2);

const PHASES = [
  { n: 1, name: 'wad format',   cmd: ['python3', 'tests/test_wad.py'] },
  { n: 2, name: 'manifest',     cmd: ['python3', 'scripts/gen_manifest.py', '--check'] },
  { n: 3, name: 'source offer', cmd: ['python3', 'scripts/gen_source_md.py', '--check'] },
  { n: 4, name: 'browser load', cmd: ['node', 'tests/test_fte_web.js', '--port', String(PORT),
           '--server-port', String(SV_PORT)],
    skip: /--no-browser/, needsServer: true },
];

if (argv.includes('--list')) {
  for (const p of PHASES) console.log(`  phase ${p.n}  ${p.name}`);
  process.exit(0);
}

/* curl's exit status is 0 even for a 404, so ask it for the code explicitly. */
function httpCode() {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}',
    `http://127.0.0.1:${PORT}/index.html`], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

function run(cmd, args) {
  const r = spawnSync(cmd[0], args, { cwd: ROOT, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

async function main() {
  const active = PHASES.filter(p => !p.skip || !p.skip.test(argv.join(' ')));
  const needServer = active.some(p => p.needsServer);
  let server = null;

  if (needServer) {
    // Reuse an already-running server if something is answering on the port;
    // starting a second one would fail with EADDRINUSE.
    const code = httpCode();
    if (code === '200') {
      console.log(`${C.d}using the server already on :${PORT}${C.x}`);
    } else {
      console.log(`${C.d}starting tools/serve.js on :${PORT}${C.x}`);
      server = spawn('node', ['tools/serve.js', '--port', String(PORT), '--root', 'web'],
        { cwd: ROOT, stdio: 'ignore' });
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (httpCode() === '200') break;
      }
    }
  }

  const out = [];
  for (const p of active) {
    console.log(`\n${C.b}=== phase ${p.n} ${p.name} ===${C.x}`);
    const started = Date.now();
    const code = run(p.cmd, p.cmd.slice(1));
    out.push({ p, code, secs: ((Date.now() - started) / 1000).toFixed(1) });
  }

  if (server) server.kill('SIGKILL');

  console.log(`\n${C.b} SUMMARY ${C.x}`);
  for (const r of out) {
    const tag = r.code === 0 ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`;
    console.log(`  ${tag}  phase ${r.p.n} ${r.p.name.padEnd(14)} ${C.d}${r.secs}s${C.x}`);
  }
  const bad = out.filter(r => r.code !== 0);
  console.log(bad.length ? `\n${C.r}${bad.length} phase(s) failed${C.x}`
                         : `\n${C.g}all ${out.length} phases passed${C.x}`);
  process.exit(bad.length ? 1 : 0);
}

main();