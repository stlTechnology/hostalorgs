'use strict';

/*
 * tests/test_help.js — Lane brief: HUD help panel
 *
 * Done when all four checks pass:
 *   1. CONTROLS has every row listed in the brief
 *   2. quake.rc keys for impulse 2x, +attack, +jump, +use, +showscores, messagemode
 *      all appear in CONTROLS, and no CONTROLS key (except Esc, H, W A S D)
 *      is missing from quake.rc
 *   3. web/index.html loads help.js after menu.js
 *   4. Source contains pointer-events: none and the keydown handler tests for h/H first
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
 const HELP_JS = path.join(WEB, 'help.js');
 const MENU_JS = path.join(WEB, 'menu.js');
 const QUAKE_RC = path.join(WEB, 'id1', 'quake.rc');
 const INDEX_HTML = path.join(WEB, 'index.html');

 // ---------- 1. CONTROLS has every row listed in the brief ----------

function loadHelp() {
  // node with no browser: module.exports
  return require(HELP_JS);
}

function checkControlsRows(help) {
  // Normalize to uppercase for comparison since CONTROLS uses quake.rc key names
  // (which are case-insensitive in practice, but quake.rc uses lowercase for some keys)
  const expected = [
    'MOUSE1', 'CTRL', 'SPACE', 'W', 'A', 'S', 'D', 'SHIFT', 'E',
    '1', '2', '3', '4', '5', '6', '7', '8',
    'MWHEELUP', 'MWHEELDOWN', 'MOUSE2', 'G', 'F', 'V', 'B',
    'ESCAPE', 'TAB', 't', 'H',
  ].map(k => k.toUpperCase());

  const present = help.CONTROLS.map(c => c.key.toUpperCase()).sort();
  const missing = expected.filter(k => !present.includes(k));

  if (missing.length) {
    console.error('FAIL: CONTROLS missing keys:', missing);
    process.exit(1);
  }
  console.log('PASS: CONTROLS has every row listed in the brief');

  // The class header (owner, 2026-10-09): all six classes, each with its
  // signature weapon first, and the Sniper's scope on the right mouse.
  const first = { 1: '4 Nailgun', 2: '3 Sniper rifle', 3: '7 Rocket launcher',
                  4: '6 Grenade launcher', 5: '5 Rotary cannon', 6: '5 Super nailgun' };
  for (const [id, w] of Object.entries(first)) {
    const c = help.CLASSES && help.CLASSES[id];
    if (!c || !c.weapons[0].startsWith(w)) {
      console.error(`FAIL: class ${id} must list "${w}" first, got: ` + (c ? c.weapons[0] : 'no entry'));
      process.exit(1);
    }
  }
  if (!/right mouse/.test(help.CLASSES[2].weapons.join(' '))) {
    console.error('FAIL: the Sniper row must say the scope is on the right mouse');
    process.exit(1);
  }
  console.log('PASS: the class header lists every class, signature weapon first');

  // The lobby lane's wording: the Esc row must say the menu now carries the
  // settings with it, and the Tab row must say scores (owner, 2026-10-09:
  // "there is nothing to help me know what buttons are available").
  const esc = help.CONTROLS.find(c => c.key.toUpperCase() === 'ESCAPE');
  const tab = help.CONTROLS.find(c => c.key.toUpperCase() === 'TAB');
  if (!esc || esc.action !== 'team, class and settings menu') {
    console.error('FAIL: the Esc row must read "team, class and settings menu", got: ' +
      (esc ? esc.action : 'no Esc row'));
    process.exit(1);
  }
  if (!tab || tab.action !== 'scores') {
    console.error('FAIL: the Tab row must read "scores", got: ' +
      (tab ? tab.action : 'no Tab row'));
    process.exit(1);
  }
  console.log('PASS: the Esc row says "team, class and settings menu" and the Tab row says "scores"');
}

// ---------- 2. quake.rc key coverage ----------

function parseQuakeRC() {
  const text = fs.readFileSync(QUAKE_RC, 'utf8');
  // bind "key" "command" lines
  const binds = [];
  const regex = /bind\s+"([^"]+)"\s+"([^"]*)"/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    binds.push({ key: m[1], command: m[2] });
  }
  // also handle single-line commands without quotes on RHS for simple impulses
  const altRegex = /bind\s+"([^"]+)"\s+(.+)/g;
  // We already captured the main pattern; also check for impulse lines without
  // the standard bind format (e.g. just "impulse 2x" in comments, but the actual
  // binds are the ones above)
  return binds;
}

function checkRCKeyCoverage(help) {
  const binds = parseQuakeRC();
  const rcKeys = new Set(binds.map(b => b.key));

  // Keys that quake.rc binds to the target actions
  const targetActions = ['impulse 2x', '+attack', '+jump', '+use', '+showscores', 'messagemode'];

  // Build a map from action name to the keys that produce it in quake.rc
  // Based on quake.rc analysis:
  //   impulse 2x -> key '2'
  //   +attack -> keys 'MOUSE1', 'CTRL'
  //   +jump -> key 'SPACE'
  //   +use -> key 'e'
  //   +showscores -> key 'TAB'
  //   messagemode -> key 't'

  const actionToKeys = {
    'impulse 2x': ['2'],
    '+attack': ['MOUSE1', 'CTRL'],
    '+jump': ['SPACE'],
    '+use': ['e'],
    '+showscores': ['TAB'],
    'messagemode': ['t'],
  };

  // Collect all CONTROLS keys
  const controlsKeys = new Set(help.CONTROLS.map(c => c.key));

  // Check: every key bound to target actions in quake.rc must appear in CONTROLS
  let allGood = true;
  for (const [action, expectedKeys] of Object.entries(actionToKeys)) {
    const rcKeysForAction = new Set(expectedKeys);
    // Find which rc keys actually produce this action
    for (const b of binds) {
      if (b.command === action || (action === 'impulse 2x' && b.command === 'impulse 2')) {
        rcKeysForAction.add(b.key);
      }
    }

    for (const k of rcKeysForAction) {
      if (!controlsKeys.has(k)) {
        console.error(`FAIL: key "${k}" used for ${action} in quake.rc but missing from CONTROLS`);
        allGood = false;
      }
    }
  }

  // Check: no CONTROLS key (except Esc, H, W A S D) is missing from quake.rc
  const exemptKeys = new Set(['H', 'ESCAPE', 'W', 'A', 'S', 'D']);
  for (const c of help.CONTROLS) {
    if (exemptKeys.has(c.key)) continue;
    if (!rcKeys.has(c.key)) {
      console.error(`FAIL: CONTROLS key "${c.key}" not found in quake.rc`);
      allGood = false;
    }
  }

  if (allGood) {
    console.log('PASS: quake.rc key coverage check');
  } else {
    process.exit(1);
  }
}

// ---------- 3. index.html loads help.js after menu.js ----------

function checkHTMLLoadOrder() {
  const text = fs.readFileSync(INDEX_HTML, 'utf8');

  // Find the position of menu.js script tag
  const menuIdx = text.indexOf('<script src="menu.js">');
  const helpIdx = text.indexOf('<script src="help.js">');

  if (menuIdx === -1 || helpIdx === -1) {
    console.error('FAIL: Could not find both script tags in index.html');
    process.exit(1);
  }

  if (helpIdx > menuIdx) {
    console.log('PASS: index.html loads help.js after menu.js');
  } else {
    console.error('FAIL: help.js is NOT after menu.js in index.html');
    process.exit(1);
  }
}

// ---------- 4. Behaviour, in a minimal fake page ----------
// The panel must install ITSELF (nothing else calls install()), start visible,
// toggle on H, ignore other keys, and never swallow any key (an H swallowed here
// would be an "h" missing from every chat line).

function checkBehaviour() {
  const text = fs.readFileSync(HELP_JS, 'utf8');
  if (!text.includes('pointer-events: none')) fail('source missing pointer-events: none');
  const nodes = {};
  const listeners = [];
  const el = (tag) => ({ tag, id: '', hidden: false, innerHTML: '', textContent: '',
    appendChild(c) { if (c.id) nodes[c.id] = c; return c; } });
  const document = {
    readyState: 'complete', head: el('head'), body: el('body'),
    createElement: el, getElementById: (id) => nodes[id] || null,
    addEventListener() {},
  };
  const window = { addEventListener: (type, fn, cap) => listeners.push({ type, fn, cap }) };
  const vm = require('vm');
  vm.runInNewContext(text, { window, document, module: undefined, console });
  const api = window.QWTF_HELP;
  if (!api) fail('help.js did not set window.QWTF_HELP');
  if (!api.visible()) fail('the panel is not shown after the page loads (install() never ran?)');
  const keys = listeners.filter(l => l.type === 'keydown');
  if (keys.length !== 1 || keys[0].cap !== true) fail('expected one capture keydown listener, got ' + keys.length);
  let swallowed = 0;
  const press = (key) => keys[0].fn({ key, repeat: false,
    stopPropagation() { swallowed++; }, preventDefault() { swallowed++; },
    stopImmediatePropagation() { swallowed++; } });
  press('h');
  if (api.visible()) fail('H did not hide the panel');
  press('w'); press('Escape'); press('g');
  if (api.visible()) fail('a key other than H changed the panel');
  press('H');
  if (!api.visible()) fail('H did not show the panel again');
  if (swallowed) fail('the listener swallowed ' + swallowed + ' key event(s); it must swallow none');
  console.log('PASS: installs itself, starts visible, H toggles, other keys ignored, nothing swallowed');

  // A phone (owner, 2026-10-10: "on a phone it's on top of the view"): a touch
  // screen, 400 wide. The panel must start hidden there, and H still shows it.
  const nodes2 = {};
  const el2 = (tag) => ({ tag, id: '', hidden: false, innerHTML: '', textContent: '',
    appendChild(c) { if (c.id) nodes2[c.id] = c; return c; } });
  const doc2 = { readyState: 'complete', head: el2('head'), body: el2('body'),
    createElement: el2, getElementById: (id) => nodes2[id] || null, addEventListener() {} };
  const listeners2 = [];
  const phone = { innerWidth: 400, matchMedia: (q) => ({ matches: q === '(pointer: coarse)' }),
    addEventListener: (type, fn, cap) => listeners2.push({ type, fn, cap }) };
  vm.runInNewContext(text, { window: phone, document: doc2, module: undefined, console });
  if (phone.QWTF_HELP.visible()) fail('on a 400-wide touch screen the panel must start hidden');
  listeners2[0].fn({ key: 'h', repeat: false, stopPropagation() {}, preventDefault() {} });
  if (!phone.QWTF_HELP.visible()) fail('H must still show the panel on a touch screen with a keyboard');
  console.log('PASS: on a phone the panel starts hidden (and H still shows it)');
}

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1); }

// ---------- main ----------

function main() {
  const help = loadHelp();

  console.log('=== Test: CONTROLS rows ===');
  checkControlsRows(help);

  console.log('=== Test: quake.rc key coverage ===');
  checkRCKeyCoverage(help);

  console.log('=== Test: index.html load order ===');
  checkHTMLLoadOrder();

  console.log('=== Test: behaviour ===');
  checkBehaviour();

  console.log('=== All checks complete ===');
}

main();
