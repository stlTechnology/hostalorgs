#!/usr/bin/env node
/*
 * tests/test_medic.js -- the Medic's overheal and virus, on a real server.
 *
 * Owner, 2026-10-09: "The medic had a special axe that hurt enemies with a
 * virus, and healed past 100, up to 150 the team-mates."
 *
 * Aiming a medkit at a moving bot is not something a test can do reliably, so
 * qwtf/medic_probe.qc (test-only, built with QWTF_EXTRA_QC) applies the
 * shipped QWTF_medkit_heal and QWTF_infect to the two bots on a timer and
 * prints what the server then holds. The per-second virus tick and the
 * overheal drain are the shipped PlayerPreThink code running on its own.
 *
 *   1  three heals take a 100-health teammate to 150 (past the class max)
 *   2  the overheal drains: 4 s later it is below 150 but no lower than 140
 *   3  the virus is still on 12 s after infection, and has ticked >= 10 times
 *   4  a heal from the victim's own side cures it
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const RUN = path.join(ROOT, 'tests', 'artifacts', 'run-medic-' + process.pid);
const STAGE = path.join(RUN, 'gamedir');
const PROGS = path.join(RUN, 'progs');
const SV_PORT = 27900 + (process.pid % 90);

let failed = false;
function check(ok, what, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}` + (ok || !detail ? '' : `\n         ${detail}`));
  if (!ok) failed = true;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  fs.mkdirSync(PROGS, { recursive: true });
  const b = spawnSync('bash', [path.join(ROOT, 'scripts/build_progs.sh')], {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, { QWTF_EXTRA_QC: 'medic_probe.qc', QWTF_PROGS_OUT: PROGS }) });
  check(b.status === 0, 'the probe build compiles (qwtf/medic_probe.qc)', (b.stdout + b.stderr).slice(-800));
  if (b.status !== 0) return;
  for (const e of fs.readdirSync(WEB)) if (e !== 'id1') fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    const probe = path.join(PROGS, e);
    fs.symlinkSync(fs.existsSync(probe) ? probe : path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }

  let log = '';
  const sv = spawn('bash', [path.join(ROOT, 'scripts/run_server.sh'), '--port', String(SV_PORT),
    '--gamedir', STAGE, '--map', 'forts', '+set', 'developer', '1', '+set', 'qwtf_bots', '1'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  sv.stdout.on('data', d => { log += d; });
  sv.stderr.on('data', d => { log += d; });
  try {
    for (let i = 0; i < 180 && !/QWTF_PROBE medic_cure/.test(log); i++) await sleep(500);
    fs.writeFileSync(path.join(RUN, 'server.log'), log);
    const num = (re) => { const m = re.exec(log); return m ? Number(m[1]) : NaN; };

    const healed = num(/QWTF_PROBE medic_heal hp=([\d.]+)/);
    check(healed === 150, 'three medkit heals take a 100-health teammate to 150', `hp=${healed}`);
    const drained = num(/QWTF_PROBE medic_drain hp=([\d.]+)/);
    check(drained < 150 && drained >= 140, 'the overheal drains back by about 1 a second (4 s later)', `hp=${drained}`);
    const virus = /QWTF_PROBE medic_virus infected=1/.test(log);
    const ticks = (log.match(/QWTF_EVENT poison_tick Bot Blue/g) || []).length;
    check(virus && ticks >= 10, 'the virus is still on 12 s after infection and has ticked every second',
          `infected=${virus} ticks=${ticks}`);
    check(/QWTF_PROBE medic_cure infected=0/.test(log), 'a heal from the victim\'s own side cures it',
          (/QWTF_PROBE medic_cure.*/.exec(log) || ['no cure line'])[0]);
  } finally {
    try { process.kill(-sv.pid, 'SIGKILL'); } catch (e) {}
    console.log(`  run dir: ${path.relative(ROOT, RUN)}`);
  }
}

main().then(() => { console.log(failed ? 'FAIL' : 'PASS: 4 checks'); process.exit(failed ? 1 : 0); });
