#!/usr/bin/env node
/* tests/test_stringeq.js -- what `==` on strings actually does in this progs.
 *
 *   node tests/test_stringeq.js
 *
 * Reviewer 0506 item 1 asked for a probe before any fix: "classes.qc:527+
 * compares runtime strings with ==, and in this QW progs a runtime string ==
 * evaluates TRUE when the strings DIFFER ... Confirm with a 2-line dprint
 * probe, then fix every runtime string comparison."
 *
 * MEASURED ANSWER: the premise is false, and this file is the measurement.
 * Every runtime form the lobby uses compares correctly -- argv(0)/argv(1)
 * against a literal, two argv strings against each other, against the empty
 * string, and after a copy through a .string field. The reviewer's own claim,
 * re-stated in the probe as the dispatch SV_ParseClientCommand performs, also
 * comes out right: "qwtf_setclass" does NOT take the qwtf_setteam branch.
 *
 * What was actually broken is the wire form: web/menu.js sent the server-bound
 * commands bare, and FTE's client eats an unknown command in its own console
 * ("Unknown command \"qwtf_setclass\"") instead of forwarding it. The fix is
 * there (the `cmd ` prefix), and tests/test_menu.js and the lobby phase of
 * tests/ctf_rules.js are the end-to-end proof.
 *
 * So this file is not a test that will flip when the code changes -- it is the
 * pin that stops the NEXT person from "fixing" a correct `==` into a helper
 * call, and it re-measures the operator on every run of check_all.
 *
 * HOW: build qwtf/stringeq_probe.qc into a THROWAWAY progs
 * (QWTF_EXTRA_QC + QWTF_PROGS_OUT -- the shipped web/id1 progs are never
 * touched), stage a gamedir that uses it, boot the server on forts with
 * `developer 1`, and read the STREQ lines the probe prints from worldspawn.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.dirname(__dirname);
const WEB = path.join(ROOT, 'web');
const PROBE = 'stringeq_probe.qc';

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'qwtf-streq-'));
const PROGS = path.join(RUN, 'progs');
const STAGE = path.join(RUN, 'stage');
const LOG = path.join(RUN, 'server.log');

let pass = 0, fail = 0;
const check = (ok, what, detail) => {
  if (ok) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? '\n       ' + detail : '')); }
  return ok;
};
const bad = (what, detail) => check(false, what, detail);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };

/* What the log says for one probe line, or null. */
function said(log, label) {
  const m = log.split('\n').map(l => l.trim())
    .find(l => l.startsWith('STREQ ' + label + ' '));
  if (!m) return null;
  return m.slice(('STREQ ' + label + ' ').length).trim();
}

/* The label says what the expression is, the answer is what happened. */
function expect(log, label, want, why) {
  const got = said(log, label);
  if (got === null) return bad(why, `the probe printed no line for ${label}`);
  check(got === want, why, `${label}: engine took ${got}, expected ${want}`);
  return got === want;
}

console.log('the string-comparison probe (qwtf/stringeq_probe.qc, worldspawn)');

/* -- 1. build the probe into a throwaway progs ---------------------------- */
const build = spawnSync('bash', [path.join(ROOT, 'scripts/build_progs.sh')], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000,
  env: Object.assign({}, process.env, {
    QWTF_EXTRA_QC: PROBE,
    QWTF_PROGS_OUT: PROGS,
  }),
});
if (build.status !== 0) {
  bad('the probe progs compiled',
      (build.stdout || '') + (build.stderr || '').split('\n').slice(-6).join('\n'));
  return finish();
}
if (!fs.existsSync(path.join(PROGS, 'qwprogs.dat'))) {
  bad('the probe progs landed', `no qwprogs.dat in ${PROGS}`); return finish();
}
check(true, `the probe progs compiled (${fs.statSync(path.join(PROGS, 'qwprogs.dat')).size} bytes)`);

/* -- 2. a gamedir that serves them ---------------------------------------- */
fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
  if (e === 'progs.dat' || e === 'qwprogs.dat') continue;
  fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
}
for (const e of ['progs.dat', 'qwprogs.dat']) {
  fs.symlinkSync(path.join(PROGS, e), path.join(STAGE, 'id1', e));
}

/* -- 3. boot it, and read what the engine did ----------------------------- */
const PORT = 29000 + (process.pid % 3000);
const server = spawnSync('bash', [
  path.join(ROOT, 'scripts/run_server.sh'),
  '--port', String(PORT), '--gamedir', STAGE, '--map', 'forts',
  // dprint reaches stdout only with developer 1; the trace cvar is what the
  // infokey control compares against.
  '+set', 'developer', '1', '+set', 'qwtf_trace', '1', '+serverinfo', 'qwtf_trace', '1',
], { cwd: ROOT, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', input: '' });
const out = (server.stdout || '') + (server.stderr || '');
fs.writeFileSync(LOG, out);

if (!out.includes('STREQ ')) {
  bad('the probe printed', out.split('\n').slice(-12).join('\n'));
  return finish();
}
check(/Quake Initialized/.test(out), 'the server booted on forts with the probe progs');
check(true, `the probe printed ${out.split('\n').filter(l => l.includes('STREQ ')).length} lines`);

/* -- 4. what `==` actually does ------------------------------------------- */
console.log('');
console.log('a runtime string against a literal');
expect(out, 'argv0_same', 'read_true', 'argv(0) == the literal it holds is TRUE');
expect(out, 'argv0_diff', 'read_false', 'argv(0) == a DIFFERENT command name is false');
expect(out, 'argv0_diff_short', 'read_false', 'argv(0) == an unrelated short literal is false');
expect(out, 'argv1_same', 'read_true', 'argv(1) == the argument it holds ("red") is TRUE');
expect(out, 'argv1_diff', 'read_false', 'argv(1) == the other team ("blue") is false');
expect(out, 'argv0_setclass_same', 'read_true', 'the other command name == its own literal is TRUE');
expect(out, 'argv0_setclass_diff', 'read_false', 'and it is false against the first command name');

console.log('');
console.log('two runtime strings');
expect(out, 'runtime_pair_diff', 'read_false', 'argv(0) of two different commands is false');
expect(out, 'runtime_pair_diff_args', 'read_false', '"red" == "scout" is false');
expect(out, 'runtime_pair_same', 'read_true', '"red" == "red" from two tokenize calls is TRUE');

console.log('');
console.log('the empty string, and a copy through a field');
expect(out, 'argv0_vs_empty', 'read_false', 'a non-empty runtime string == "" is false');
expect(out, 'argv0_ne_same', 'read_false', 'the negated form too: a != its own literal is false');
expect(out, 'argv0_ne_diff', 'read_true', 'and a != a different literal is true');
expect(out, 'ctrl_infokey_ne_empty', 'read_true',
       'infokey(world, "qwtf_trace") != "" with the trace set (probe.qc gates on this)');
expect(out, 'ctrl_classname_ne_player', 'read_true',
       'the world\'s classname != "player" (classes.qc gates two rules on this)');
expect(out, 'field_argv0_same', 'read_true', 'a runtime string copied to a .string field still == its literal');
expect(out, 'field_argv0_diff', 'read_false', 'and still false against a different literal');
expect(out, 'field_literal_same', 'read_true', 'a literal copied to a field == itself');
expect(out, 'field_literal_diff', 'read_false', 'and false against another literal');

console.log('');
console.log('the 0506 claim, in the form the rules use it');
expect(out, 'dispatch_argv0_is_setteam', '-> QWTF_cmd_setteam',
       'SV_ParseClientCommand sends "qwtf_setteam" to QWTF_cmd_setteam');
expect(out, 'dispatch_argv0_is_setclass', '-> QWTF_cmd_setclass',
       'and "qwtf_setclass" to QWTF_cmd_setclass -- the first branch is NOT taken');
expect(out, 'dispatch_argv1_is_red', '-> red',
       'QWTF_cmd_setteam("red") takes the red branch');
expect(out, 'dispatch_argv1_is_blue', '-> not red',
       'and QWTF_cmd_setteam("blue") does NOT -- the second bug 0506 called broken');

console.log('');
console.log('controls: the two forms the rest of the tree already depends on');
const cn = said(out, 'ctrl_classname_value');
check(cn === 'world' || cn === 'worldspawn',
      `the world's classname is "world"/"worldspawn" (measured: ${cn})`);
expect(out, 'ctrl_classname_is_world', cn === 'world' ? 'read_true' : 'read_false',
       'the classname comparison agrees with the classname itself (== "world")');
expect(out, 'ctrl_classname_is_worldspawn', cn === 'worldspawn' ? 'read_true' : 'read_false',
       'and with the value (== "worldspawn")');
expect(out, 'ctrl_classname_is_player', 'read_false',
       'and is false for a classname the world does not have (bots.qc gates on this form)');
expect(out, 'ctrl_infokey_same', 'read_true',
       'infokey(world, "qwtf_trace") == "1" is TRUE with the trace on (probe.qc gates on this form)');
expect(out, 'ctrl_infokey_diff', 'read_false', 'and false against "0"');

/* -- 5. and a comparison added later cannot slip past the measurement ------ */
/* The probe can only measure the forms it was written with, so this covers the
 * one gap it cannot: a runtime value compared with == that the probe does not
 * name. argv()/infokey()/netname are the runtime sources in the lobby, and
 * classes.qc is the file the 0506 report pointed at. */
console.log('');
console.log('and nothing new is compared by hand behind the probe\'s back');
const src = fs.readFileSync(path.join(ROOT, 'qwtf/classes.qc'), 'utf8')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const bare = src.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /\b(argv\(\d\)|infokey\(|self\.netname)\b[^=]*==[^=]/.test(l));
check(bare.length === 0,
      'classes.qc compares no argv()/infokey()/netname value with == directly',
      bare.map(([n, l]) => `${n}: ${l.trim()}`).join('\n       '));

function finish() {
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (e) {}
  console.log('');
  console.log(fail ? `FAIL: ${fail} of ${pass + fail} checks` : `PASS: ${pass} checks`);
  process.exit(fail ? 1 : 0);
}
finish();