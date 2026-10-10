#!/usr/bin/env node
/*
 * tests/test_key_entity.js -- the team key exists IN-ENGINE (M4b, reviewer 0167).
 *
 *   node tests/test_key_entity.js [--port N]
 *
 * Why this is a separate file rather than more of tests/flag_run.js: the thing
 * being tested is not a movement, it is whether an ENTITY survived the map load
 * at all, and the failure mode is invisible from the .map text.
 *
 * Specifically: the map used to say "classname" "item_key", which is not a
 * classname LibreQuake's QuakeC knows (it has item_key1 and item_key2, the
 * single-player keys). An unknown classname is dropped when the map loads, the
 * same way func_water1 was -- so both vaults rendered empty while maps/forts.map
 * still said the key was on its pedestal, and no amount of reading the .map would
 * have found it. This counts the entity's own dprint in the server's stdout: a
 * dropped classname never runs its spawn function and never prints.
 *
 * This is a PRESENCE check only. The key does not yet do anything when touched
 * (see QWTF_key_touch in qwtf/probe.qc) -- take/drop/return/capture is the rest of
 * M4b. A key that exists but cannot be picked up is the next milestone's problem,
 * not this one's, and it would be a false pass to claim otherwise here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.dirname(__dirname);
const WEB = path.join(ROOT, 'web');
const ART = path.join(ROOT, 'tests/artifacts');
/* PER RUN, like tests/ctf_rules.js (0239). This used to stage into the shared
 * tests/artifacts/gamedir and write tests/artifacts/key_entity/server.log, so two
 * concurrent runs deleted each other's gamedir while the server was loading the
 * client out of it, and each read the other's log. */
const RUN = path.join(ART, 'run-key-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const LOG = path.join(RUN, 'server.log');

/* One number out of gen_map.py, in the units the map is in. gen_map is Python, so
 * this asks it -- one subprocess, and null if it cannot be read, so the caller can
 * fail loudly instead of asserting against a stale literal. */
function gen(expr) {
  const r = spawnSync('python3', ['-c',
    'import sys; sys.path.insert(0, "scripts"); import gen_map as g; print(' +
    expr + ')'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return NaN;
  return parseFloat(r.stdout.trim().split('\n').pop());
}

let failed = 0;
function ok(what) { console.log(`  ok   ${what}`); }
function bad(what, detail) {
  console.log(`  FAIL ${what}`);
  if (detail) console.log(`       ${detail}`);
  failed++;
}
const check = (cond, what, detail) => cond ? ok(what) : bad(what, detail);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* The harness this borrows from: a real fteqw-sv on a scratch port, a real
 * headless client joining it, and the server's own stdout as the evidence. The
 * position probe and the server-side facing come from qwtf/probe.qc. */
const HARNESS = fs.readFileSync(path.join(__dirname, 'flag_run.js'), 'utf8');

function stage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
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

function main() {
  /* The server does not need a client at all: the keys are world entities and
   * they spawn at map load, before anyone connects. So this reads the server's
   * stdout and never starts a browser. That is both faster and a better test --
   * it is not about the client. */
  const PORT = 28012;
  const run = spawnSync('bash', [
    path.join(ROOT, 'scripts/run_server.sh'),
    '--port', String(PORT),
    '--gamedir', STAGE,
    '--map', 'forts',
    '+set', 'developer', '1',
    '+set', 'qwtf_trace', '1',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 45000,
    killSignal: 'SIGKILL',
    input: 'echo quit\n',          // a real server exits on stdin; this must not hang
  });
  /* stdout ONLY. It was stdout + stderr concatenated, and stderr interleaves
   * mid-number -- the observed symptom was
   *
   *   QWTF_KEY 1 at  480 -112
   *
   * with the leading 3 of 328 replaced by stderr's output, so a correct map failed
   * its own mirror check. Diagnostics are for humans; assertions read the channel
   * under test.
   */
  const raw = run.stdout || '';
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, raw);

  console.log('the team key exists in-engine');

  check(run.status === 0 || raw.includes('Server spawned.'),
        'the server loaded maps/forts.bsp',
        (run.stderr || '').slice(-300));

  const keys = raw.split('\n')
    .map(l => l.replace(/[^\x20-\x7e]/g, ''))
    .filter(l => l.includes('QWTF_KEY'));

  check(keys.length === 2,
        'both keys spawned: one per vault',
        `expected 2 QWTF_KEY lines, got ${keys.length}: ${JSON.stringify(keys)}`);

  /* team 1 = red, team 2 = blue, per item_qwtf_key in qwtf/probe.qc. The order
   * is not guaranteed, so this reads the set. */
  const teams = keys
    .map(l => (l.match(/QWTF_KEY (\d)/) || [])[1])
    .filter(t => t !== undefined)
    .sort();
  check(teams.join(',') === '1,2',
        'one key per team, and they are different teams',
        `teams seen: ${JSON.stringify(teams)} (1 red, 2 blue)`);

  /* Mirrored about mid-x: FORTS_LEN is 2048, so if one key is at x 328 the other
   * must be at 1720. This is the same mirror is_symmetric() checks for geometry,
   * asserted on the entities, which is a different list. */
  const xs = keys
    .map(l => (l.match(/QWTF_KEY \d at (-?[\d.]+)/) || [])[1])
    .filter(x => x !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  /* The origin_x dprint can come out EMPTY -- observed "QWTF_KEY 1 at  480 -112",
   * with the x simply absent rather than wrong. It is a DIAGNOSTIC channel, not the
   * rules: the take and capture checks in tests/ctf_rules.js find and touch both
   * keys at the right places with qwtf_trace off, and the geometry's own mirror is
   * asserted by is_symmetric() inside gen_map and by test_forts_map.
   *
   * The x print was missing because I had deleted that dprint myself while
   * stripping diagnostics, matching the line by its text. It is back, and the live
   * check is live again. The map-text check stays as well: it is the same property
   * read from the source, so a print that breaks again cannot hide the geometry.
   */
  /* Mid-x and the key's x come from the map, not from here: gen_map authors the
   * forts in design units and emits them at FORTS_SCALE (0240), so at 2.0 mid-x is
   * 2048 and the keys are at 656 and 3440. The literals 328/1720 were correct until
   * the map got bigger, and then this check asserted a mirror about the wrong line
   * -- which reads as "the keys are not mirrored", not as "this file is out of
   * date". Same question as before, asked of the engine's own print. */
  const midX = gen('g.sc(g.FORTS_LEN / 2.0)');
  const keyXa = gen('g.sc(328)');
  if (xs.length === 2) {
    check(Math.abs((xs[0] + xs[1]) - 2 * midX) < 1,
          'the two keys are mirror images about mid-x',
          `at x ${xs}, which must sum to ${2 * midX} (mid-x ${midX}, red key ` +
          `${keyXa})`);
  } else {
    check(false, 'the two keys are mirror images about mid-x (from the live log)',
          `could not read both x positions from ${JSON.stringify(keys)}`);
    const map = fs.readFileSync(path.join(ROOT, 'maps/forts.map'), 'utf8');
    const origins = [...map.matchAll(/"classname" "item_qwtf_key"\s*\n"origin" "(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/g)]
      .map(m => ({ x: +m[1], y: +m[2], z: +m[3] }));
    check(origins.length === 2 && Math.abs(origins[0].y - origins[1].y) < 1
          && Math.abs((origins[0].x + origins[1].x) - 2 * midX) < 1,
          'the two keys are mirror images about mid-x (from maps/forts.map)',
          `keys at ${JSON.stringify(origins)}, expected x to sum to ${2 * midX} ` +
          `at the same y; the in-engine origin_x print came out empty ` +
          `(${JSON.stringify(keys)})`);
  }

  /* The negative case, which is the whole point. If the classname were unknown
   * the edict is dropped and none of this prints, so the count IS the assertion.
   * Say so in the output rather than leaving a reader to work it out. */
  check(!raw.includes('unknown classname') && !/item_key\b/.test(raw.replace(/item_qwtf_key/g, '')),
        'no unknown classname was dropped at map load');

  /* The STAND must not sit ON the key. Co-located, one frame fires both the take
   * and the capture, so a player walking into the enemy vault picked the key up
   * and scored on the spot -- 15 take/capture/return cycles in the owner's live
   * game, blue = 150, while standing in the enemy vault (0226).
   */
  const keyX = (raw.match(/QWTF_KEY \d at (-?\d+)/) || [])[1];
  const standX = (raw.match(/QWTF_STAND \d at (-?\d+)/) || [])[1];
  check(keyX !== undefined && standX !== undefined
        && Math.abs(+standX - +keyX) >= 48,
        'the capture stand is beside the key, not on it',
        `key at ${keyX}, stand at ${standX}: within one hull width, so both fire ` +
        'in the same frame');

  console.log('');
  console.log(failed ? `FAIL: ${failed} checks` : 'PASS');
  /* Drop the symlink farm, keep the log: the run directory is this run's own and
   * its server.log is the evidence for every line above. */
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch (e) {}
  console.log(`  run dir: ${path.relative(ROOT, RUN)}  (server.log)`);
  process.exit(failed ? 1 : 0);
}

try {
  stage();
  main();
} catch (e) {
  console.error('Error:', e && e.message);
  process.exit(1);
}
