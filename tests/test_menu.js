/*
 * tests/test_menu.js -- PLAN.md M5: our ESC menu, and FTE's stock menus gone.
 *
 *   node tests/test_menu.js [--port N]
 *
 * The done-when has three parts and this covers the two that exist today:
 *
 *   1  ESC opens OUR overlay, and only ours.
 *   2  None of FTE's stock menu commands can be reached from it.
 *   3  Each overlay action changes server-side state (team, class).
 *
 * (3) is NOT met and this test says so rather than passing on a subset. Team and
 * class are M4b/M5 server-side rules; the QuakeC that would answer
 * `qwtf_setteam` / `qwtf_setclass` does not exist yet. What is asserted instead
 * is that the overlay sends exactly those commands and nothing else, so the
 * moment the server side lands the wiring is already proven.
 *
 * The checks that matter are the negative ones: an overlay that merely *looks*
 * right while FTE's menu still opens behind it would pass a screenshot test.
 *
 * Additionally, we assert that the build stamp footer code is present in menu.js
 * so that when build.json is available, the footer will correctly display the build date.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ART = path.join(__dirname, 'artifacts');
const SHOTS = path.join(ART, 'menu');
const LOG = path.join(SHOTS, 'server.log');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  return { status: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || '') };
}

/* ------------------------------------------------------------ static checks
 * These need no browser: the overlay's whole command surface is data in
 * web/menu.js, so it can be read and checked directly. That is deliberate -- the
 * done-when is "none of FTE's menu commands can be reached from it", and the
 * strongest form of that is to enumerate what it CAN send. */
function staticChecks(ok, bad) {
  console.log('== the overlay command surface (no browser needed)');
  const src = fs.readFileSync(path.join(WEB, 'menu.js'), 'utf8');

  /* Load menu.js in a minimal DOM-less sandbox to get its real API, rather than
   * scraping strings out of the source. jsdom is not available, so the module is
   * evaluated with the few globals it touches stubbed. */
  const sandbox = {
    window: {}, document: undefined, module: { exports: {} },
    setInterval: () => 0, clearInterval: () => {},
    console,
  };
  sandbox.window.window = sandbox.window;
  const vm = require('vm');
  vm.createContext(sandbox);
  try {
    vm.runInContext(src, sandbox, { filename: 'menu.js' });
  } catch (e) {
    bad(`web/menu.js does not load (${e.message})`);
    return null;
  }
  const menu = sandbox.module.exports;
  ok('web/menu.js loads and exposes QWTF_MENU');

  const commands = menu.commands();
  ok(`the overlay can send ${commands.length} commands`);

  /* The Reconnect entry is gone (2026-10-09: it dropped the web client into
   * the engine console, where it sat). */
  if (commands.includes('reconnect')) {
    bad('the overlay still has a Reconnect entry; it drops the player to the console');
  } else {
    ok('the overlay has no Reconnect entry');
  }

  /* Part 2: no stock FTE menu command is reachable. */
  const stock = menu.STOCK_MENU_COMMANDS;
  const bad1 = commands.filter(c =>
    stock.some(s => c === s || c.startsWith(s + ' ') || c.endsWith(' ' + s)));
  if (bad1.length === 0) {
    ok(`none of the ${stock.length} stock FTE menu commands is reachable from the overlay`);
  } else {
    bad(`the overlay can reach stock menu commands: ${bad1.join(', ')}`);
  }

  /* The ESC interception must be a window capture listener, because that is the
   * only place that runs before FTE's document capture listener. A bubble-phase
   * or document-phase listener would arrive after the engine had already opened
   * its menu. */
  if (/window\.addEventListener\(\s*'keydown'[\s\S]{0,400}?true\s*\)/.test(src)) {
    ok('ESC is intercepted on window in the CAPTURE phase, before FTE sees it');
  } else {
    bad('ESC is not intercepted in the capture phase on window; FTE would ' +
        'open its own menu first');
  }
  if (/stopPropagation\(\)/.test(src) && /preventDefault\(\)/.test(src)) {
    ok('the ESC handler stops propagation, so the engine never receives the key');
  } else {
    bad('the ESC handler does not stop propagation');
  }

  /* The bridge must be FTE's own, not a reimplementation. */
  if (/FTEC\.cbufadd|\.cbufadd\(/.test(src)) {
    ok('commands go through FTEC.cbufadd, the engine\'s own console path');
  } else {
    bad('the overlay does not use FTEC.cbufadd; it must not reimplement input');
  }

  /* Settings must map onto real FTE cvars, i.e. the same ones the stock Options
   * page used. Anything else and the slider would move and nothing would change. */
  for (const [name, cvar] of [['sensitivity', 'sensitivity'],
                              ['invert', 'm_invert'],
                              ['volume', 'snd_vol']]) {
    if (new RegExp(`\\['${cvar}'`).test(src) || src.includes(`"${cvar}"`)) {
      ok(`the ${name} setting maps to the real cvar ${cvar}`);
    } else {
      bad(`the ${name} setting does not map to ${cvar}`);
    }
  }

  /* Part 3: the commands exist, and they are the ones the server answers. */
  /* The two qwtf_* families go over the wire as `cmd qwtf_setteam ...` --
   * FTE's client does not forward unknown commands by itself (measured: a bare
   * qwtf_setclass prints Unknown command and dies in the client's own table),
   * so the wire form carries QW's forwarding prefix. */
  const teamCmds = commands.filter(c => c.includes('qwtf_setteam'));
  const classCmds = commands.filter(c => c.includes('qwtf_setclass'));
  ok(`team selection sends ${teamCmds.length} qwtf_setteam commands ` +
     `(${teamCmds.join(', ')})`);
  ok(`class selection sends ${classCmds.length} qwtf_setclass commands`);
  console.log('');
  console.log('  "each overlay action changes server-side state (team, class)" is no');
  console.log('  longer open, and this file still does not claim it: it drives the page,');
  console.log('  not a server. The proof lives where a server is: the lobby section of');
  console.log('  tests/ctf_rules.js (`node tests/ctf_rules.js --lobby-only`), which clicks');
  console.log('  this overlay and reads setclass_first / setteam_accepted / class_stats');
  console.log('  out of the SERVER\'s own log.')

  /* Static verification: the build stamp footer code must be present in menu.js.
   * This ensures that when build.json is available, the Esc menu will display build info.
   * The browser check below may still defer to static verification if build.json
   * hasn't been fetched yet, but the source code must contain the footer pattern. */
  const menustr = fs.readFileSync(path.join(WEB, 'menu.js'), 'utf8');
  if (/\$\{built\}/.test(menustr) ||
      menustr.includes("fetch('build.json')") ||
      /build\s+\$\{built\}/.test(menustr)) {
    ok('menu.js contains build stamp footer references');
  } else {
    bad('menu.js does not contain build stamp footer code pattern; ' +
        'the Esc menu footer will not show build info');
  }

  return menu;
}

/* ------------------------------------------------------------- in-browser */
class Client {
  constructor(name, cdpPort) { this.name = name; this.port = cdpPort; this.logs = []; this.errors = []; }
  async start(url) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), `qwtf-${this.name}-`));
    this.proc = spawn('google-chrome', [
      '--headless=new', `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`, '--no-sandbox', '--disable-gpu-sandbox',
      '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=1024,576', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--no-first-run', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let info = null;
    for (let i = 0; i < 150; i++) {
      const r = sh('curl', ['-s', `http://127.0.0.1:${this.port}/json/list`]);
      if (r.status === 0) {
        try { info = JSON.parse(r.stdout).find(t => t.type === 'page'); if (info) break; } catch (e) {}
      }
      await sleep(200);
    }
    if (!info) throw new Error(`${this.name}: chrome debugger never came up`);
    const WS = require('./cdp.js');
    this.ws = await WS.connect(info.webSocketDebuggerUrl, m => this.onMessage(m));
    this.nextId = 1; this.pending = new Map();
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Input.setIgnoreInputEvents', { ignore: false });
    await this.send('Page.navigate', { url });
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      this.logs.push((m.params.args || []).map(a =>
        a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      this.errors.push(d.exception ? (d.exception.description || d.text) : d.text);
    }
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${this.name} CDP timeout: ${method}`)); }
      }, 60000);
    });
  }
  said(re) { return this.logs.some(l => re.test(l)); }
  text() { return this.logs.join('\n'); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('page threw: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async stop() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {}
    await sleep(400);
    try { if (this.profile) fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) {}
  }
}

/* A page that only loads our overlay. The game server is not involved: the
 * done-when is about what ESC does on the page, and a server would only make a
 * failure here harder to read. */
async function browserChecks(ok, bad) {
  console.log('');
  console.log('== in a real page (headless Chrome)');
  const PORT = Number(arg('--port', 27610 + (process.pid % 40)));
  fs.mkdirSync(SHOTS, { recursive: true });

  const srv = spawn('node', [path.join(ROOT, 'tools/serve.js'),
    '--port', String(PORT), '--root', WEB], { cwd: ROOT, stdio: 'ignore', detached: true });
  await sleep(1200);
  const client = new Client('menu', 9600 + (process.pid % 300));
  try {
    await client.start(`http://127.0.0.1:${PORT}/index.html`);
    /* Wait for the overlay's API to exist, which means menu.js loaded and
     * installed, without needing the engine to have started. */
    let ready = false;
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      try { ready = await client.eval('!!(window.QWTF_MENU && window.QWTF_MENU.root)'); }
      catch (e) { /* the page may still be loading */ }
      if (ready) break;
    }
    if (!ready) {
      bad('QWTF_MENU never appeared on the page');
      console.log('  page log tail: ' + client.text().split('\n').slice(-8).join(' | '));
      return;
    }
    ok('menu.js loaded and built its overlay on a real page load');

    /* Before ESC: closed. */
    if (await client.eval('window.QWTF_MENU.isOpen()')) bad('the overlay starts open');
    else ok('the overlay starts closed');

    /* Record what the engine's command buffer receives, by stubbing cbufadd.
     * This is the bridge under test: the page must send commands through
     * FTEC.cbufadd, so that is where the evidence is collected. */
    await client.eval(`(() => {
      window.__qwtfSent = [];
      if (!window.FTEC) { window.FTEC = {}; }
      window.FTEC.cbufadd = (t) => { window.__qwtfSent.push(t); return true; };
      return true;
    })()`);

    /* Press ESC, the way a player does: a real key event, not a call into our
     * own API. If the interception is wrong this is where FTE's menu opens. */
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(500);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(400);

    if (await client.eval('window.QWTF_MENU.isOpen()')) {
      ok('ESC opened our overlay');
    } else {
      bad('ESC did not open our overlay');
    }

    const labels = await client.eval(
      'Array.from(document.querySelectorAll("#qwtf-menu button"))' +
      '.map(b => b.textContent.trim()).filter(Boolean)');
    const want = ['Resume', 'Red team', 'Blue team', 'Auto', 'Soldier', 'Scout',
                  'Medic', 'Demolitions', 'Heavy', 'Sniper', 'Settings', 'Leave'];
    const missing = want.filter(w => !labels.includes(w));
    if (!missing.length) {
      ok(`the overlay offers exactly the agreed items (${labels.length} buttons: ` +
         `${labels.join(', ')})`);
    } else {
      bad(`the overlay is missing: ${missing.join(', ')}`);
    }
    /* Nothing FTE-shaped: no "Single Player", no "Join Server", no "Options". */
    const stocky = labels.filter(l =>
      /single player|join server|browse|options|download|find game|add server/i.test(l));
    stocky.length === 0
      ? ok('no FTE stock menu items are present in the overlay')
      : bad(`stock menu items leaked into the overlay: ${stocky.join(', ')}`);
    await client.screenshot(path.join(SHOTS, '01-overlay.png'));

    /* An action must reach the engine's command buffer.
     *
     * The buffer entry is `cmd qwtf_setteam red`, NOT the bare command: FTE's
     * client prints Unknown command for a console command it does not know
     * instead of sending it, and only QW's own `cmd` forwards an unknown
     * command to the server (measured; the reasoning is on ACTIONS in
     * web/menu.js, and the end-to-end proof is the lobby section of
     * tests/ctf_rules.js --lobby-only). So the assertion is on the command and
     * its argument, and it prints the line it matched rather than hiding the
     * prefix. */
    await client.eval('window.QWTF_MENU.do("team_red")');
    await client.eval('window.QWTF_MENU.do("cls_sniper")');
    await sleep(200);
    const sent = await client.eval('window.__qwtfSent');
    const teamLine = sent.find(s => /(?:^|\s)qwtf_setteam\s+red\s*$/.test(s));
    if (teamLine) ok(`Change team reaches the engine's console as ${JSON.stringify(teamLine)}`);
    else bad(`Change team sent nothing useful: ${JSON.stringify(sent)}`);
    const classLine = sent.find(s => /(?:^|\s)qwtf_setclass\s+sniper\s*$/.test(s));
    if (classLine) ok(`Change class reaches the engine's console as ${JSON.stringify(classLine)}`);
    else bad(`Change class sent nothing useful: ${JSON.stringify(sent)}`);

    /* Settings must set real cvars. */
    await client.eval('window.QWTF_MENU.setSetting("sensitivity", 3.5)');
    await client.eval('window.QWTF_MENU.setSetting("invert", 1)');
    await client.eval('window.QWTF_MENU.setSetting("volume", 0.25)');
    await sleep(200);
    const sent2 = await client.eval('window.__qwtfSent');
    const wantSets = ['+set sensitivity 3.5', '+set m_invert 1', '+set snd_vol 0.25'];
    /* Every recorded command now carries the trailing newline menu.js adds
     * (without it FTE's command buffer concatenates consecutive sends), so
     * the comparison is on trimmed lines. */
    const gotSets = wantSets.filter(w => (Array.isArray(sent2) ? sent2 : [String(sent2)])
      .map(x => String(x).trim()).includes(w));
    if (gotSets.length === wantSets.length) {
      ok(`all three settings set real cvars (${gotSets.join(', ')})`);
    } else {
      bad(`settings did not reach the engine: wanted ${wantSets.join(', ')}, ` +
          `got ${JSON.stringify(sent2)}`);
    }

    /* Build stamp footer check: poll up to 5 s for the footer text, and fail if it never shows. */
    let buildStampText = '';
    for (let t = 0; t < 25; t++) {
      buildStampText = await client.eval(
        'Array.from(document.querySelectorAll("#qwtf-menu *")).map(e => e.textContent.trim())' +
        '.find(x => /^build (unknown|\\d{4}-\\d\\d-\\d\\d .* · [0-9a-f]{7,})$/.test(x)) || ""');
      if (buildStampText) break;
      await new Promise(r => setTimeout(r, 200));
    }
    if (buildStampText) ok(`build stamp footer shows: "${buildStampText}"`);
    else bad('build stamp footer never showed "build <date> · <sha>" or "build unknown"');

    /* ESC again must close it. */
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(400);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(300);
    (await client.eval('window.QWTF_MENU.isOpen()'))
      ? bad('ESC did not close the overlay')
      : ok('ESC closes the overlay again');
    await client.screenshot(path.join(SHOTS, '02-closed.png'));

    /* The engine must not have opened anything of its own. FTE logs its menu
     * opening? Not reliably, so this asserts the DOM instead: no element FTE
     * created, and our overlay is the only dialog. */
    const dialogs = await client.eval(
      'Array.from(document.querySelectorAll(\'[role="dialog"]\')).map(d => d.id)');
    if (dialogs.length === 1 && dialogs[0] === 'qwtf-menu') {
      ok('our overlay is the only dialog on the page (FTE draws its menu on the ' +
         'canvas, and ESC never reaches it)');
    } else {
      bad(`unexpected dialogs on the page: ${JSON.stringify(dialogs)}`);
    }
    if (client.errors.length === 0) ok('no uncaught exceptions on the page');
    else bad(`page threw: ${client.errors.slice(0, 2).join(' | ')}`);

    /* -- Settings really opens the engine's own options menu ------------------
     * The done-when allows a screenshot for exactly this, because FTE prints
     * nothing when a menu opens (measured: no Con_Printf on the menu path in
     * engine/client/menu.c). The recorder stub above SWALLOWS commands, so
     * this runs on a fresh page: there, QWTF_MENU.do("settings") reaches the
     * real FTEC.cbufadd, the engine's options pages draw on the canvas, and
     * the only thing that happened between the two screenshots is that one
     * command. */
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    let ready2 = false;
    for (let i = 0; i < 100 && !ready2; i++) {
      await sleep(200);
      try { ready2 = await client.eval('!!(window.QWTF_MENU && window.QWTF_MENU.root)'); }
      catch (e) {}
    }
    if (!ready2) {
      bad('the reloaded page never rebuilt the overlay; the Settings check could not run');
    } else {
      await sleep(1500);   // let the engine reach a steady first frame
      const before = await client.screenshot(path.join(SHOTS, '03-before-settings.png'));
      await client.eval('window.QWTF_MENU.do("settings")');
      await sleep(2000);
      const after = await client.screenshot(path.join(SHOTS, '04-after-settings.png'));
      const changed = fs.readFileSync(before).equals(fs.readFileSync(after)) === false;
      if (changed) ok('the Settings click changed the screen (the engine\'s options menu drew)');
      else bad('the Settings click left the screen identical; menu_options did nothing');
      const stillOpen = await client.eval('window.QWTF_MENU.isOpen()');
      if (!stillOpen) ok('the Settings click handed over: our overlay closed');
      else bad('our overlay stayed open on top of the engine\'s menu');
    }
  } finally {
    await client.stop();
    try { process.kill(-srv.pid, 'SIGKILL'); } catch (e) {
      try { srv.kill('SIGKILL'); } catch (e2) {} }
  }
}

/* ------------------------------------------------------------- the lobby run
 * The 2026-10-09 owner brief adds three checks that need a real server: the
 * overlay opens itself on join (no key press), it lists who is in the lobby
 * (the server answers `cmd qwtf_who` with one QWTF_WHO line per player), and
 * it closes itself once both picks are made. All three ride the console
 * lines the server sprints; nothing here presses ESC to open anything. */
function stage() {
  const STAGE = path.join(SHOTS, 'gamedir');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  for (const e of fs.readdirSync(WEB)) {
    if (e === 'id1') continue;
    fs.symlinkSync(path.join(WEB, e), path.join(STAGE, e));
  }
  fs.mkdirSync(path.join(STAGE, 'id1'), { recursive: true });
  for (const e of fs.readdirSync(path.join(WEB, 'id1'))) {
    if (e === 'maps') continue;
    fs.symlinkSync(path.join(WEB, 'id1', e), path.join(STAGE, 'id1', e));
  }
  fs.mkdirSync(path.join(STAGE, 'id1', 'maps'));
  for (const e of fs.readdirSync(path.join(WEB, 'id1', 'maps'))) {
    fs.symlinkSync(path.join(WEB, 'id1', 'maps', e), path.join(STAGE, 'id1', 'maps', e));
  }
  return STAGE;
}

class Server {
  constructor(port, log) { this.port = port; this.log = log; }
  async start(stageDir) {
    this.out = fs.openSync(this.log, 'w');
    this.proc = spawn('bash', [
      path.join(ROOT, 'scripts/run_server.sh'),
      '--port', String(this.port),
      '--gamedir', stageDir,
      '--demo-subdir', 'demos',
      '--map', 'forts',
      '+set', 'qwtf_bots', '1',
      '+set', 'developer', '1',
    ], { cwd: ROOT, stdio: ['pipe', this.out, this.out], detached: true });
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      try { if (/Quake Initialized/.test(fs.readFileSync(this.log, 'utf8'))) return true; } catch (e) {}
      if (this.proc.exitCode !== null) break;
    }
    return false;
  }
  async stop() {
    try { if (this.proc) process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) {
      try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e2) {}
    }
    try { if (this.out) fs.closeSync(this.out); } catch (e) {}
    await sleep(300);
  }
}

async function lobbyMenuChecks(ok, bad) {
  console.log('');
  console.log('== on a real server: the overlay opens, lists, and closes itself');
  const STAGE = stage();
  const LOG = path.join(SHOTS, 'lobby-server.log');
  const PORT = 21600 + (process.pid % 2000), HTTP = PORT + 1;
  const server = new Server(PORT, LOG);
  let page = null;
  const clients = [];
  try {
    if (!await server.start(STAGE)) { bad('the lobby server started'); return; }
    page = spawn('node', [path.join(ROOT, 'tools/serve.js'), '--port', String(HTTP),
      '--root', STAGE], { cwd: ROOT, stdio: 'ignore', detached: true });
    await sleep(1500);
    const url = 'http://127.0.0.1:' + HTTP + '/index.html?server=' +
      encodeURIComponent('ws://127.0.0.1:' + PORT) + '&name=alpha&autojoin=1';
    const client = new Client('alpha', 9700 + (process.pid % 300));
    clients.push(client);
    await client.start(url);
    let joined = false;
    for (let i = 0; i < 180 && !joined; i++) {
      await sleep(500);
      try { joined = /alpha joined/.test(fs.readFileSync(LOG, 'utf8')); } catch (e) {}
    }
    if (!joined) { bad('alpha joined the lobby server', 'no "alpha joined" in 90 s'); return; }

    /* THE overlay opens itself: no ESC is dispatched on this page at all. */
    let open = false;
    for (let i = 0; i < 60 && !open; i++) {
      await sleep(500);
      try { open = await client.eval('window.QWTF_MENU.isOpen()'); } catch (e) {}
    }
    if (open) ok('the overlay is visible on join without any key press');
    else bad('the overlay never opened itself on join (no key press was sent)');

    /* The lobby list: the server answers cmd qwtf_who with one QWTF_WHO line
     * per player; the overlay polls it every 2 s while it is open. */
    let listed = null;
    for (let i = 0; i < 40 && !listed; i++) {
      await sleep(500);
      try {
        listed = await client.eval(`(() => {
          const box = document.querySelector('[data-qwtf-players]');
          if (!box) return null;
          const rows = Array.from(box.querySelectorAll('[data-qwtf-player]'))
            .map(r => ({ name: r.getAttribute('data-qwtf-player'),
                         text: r.textContent.trim() }));
          return rows;
        })()`);
        const want = [['Bot Red', 'Red'], ['Bot Blue', 'Blue']];
        if (listed && want.every(([n, t]) =>
          listed.some(r => r.name === n && r.text.includes(t)))) break;
        listed = null;
      } catch (e) { listed = null; }
    }
    if (listed) ok(`the list shows the bots' names and teams (${listed.map(r => r.name + ': ' + r.text).join(', ')})`);
    else bad('the lobby list never showed the bots with their teams');

    /* Both picks: the overlay closes itself when the server says the spawn
     * happened (QWTF_YOU with team and class both set). */
    /* Owner playtest 2026-10-10: the mouse wheel in the lobby (no weapons)
     * sent the stock weapon cycle into a runaway loop and the server died.
     * Roll it both ways while waiting; the server must still be up after. */
    await client.eval(`FTEC.cbufadd('impulse 12\\nimpulse 10\\nimpulse 12\\n')`);
    await sleep(1500);
    if (!/runaway loop/.test(fs.readFileSync(LOG, 'utf8'))) ok('the mouse wheel in the lobby does not crash the server');
    else bad('the mouse wheel in the lobby crashed the server', 'runaway loop error in the log');

    /* Owner, 2026-10-10: "auto a user selections in the panel when they
     * start, and show the defaulted or auto selections obviously in the
     * menu". On join, Auto and Soldier are highlighted and the line says so;
     * Enter (a real key event) joins with them. */
    const pressed = await client.eval(`[...document.querySelectorAll('#qwtf-menu button[aria-pressed="true"]')]
      .map(b => b.getAttribute('data-qwtf-action')).sort().join(',')`);
    if (pressed === 'cls_soldier,team_auto') ok('on join, Auto team and Soldier are pre-selected and highlighted');
    else bad('the defaults are not highlighted on join', JSON.stringify(pressed));
    const joinAs = await client.eval(`(document.querySelector('[data-qwtf-joinas]')||{}).textContent||''`);
    if (/You will join: Auto team, Soldier/.test(joinAs)) ok('the menu says what you will join as: ' + joinAs.trim());
    else bad('the menu does not say what you will join as', JSON.stringify(joinAs));
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(200);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      await sleep(500);
      try { closed = !(await client.eval('window.QWTF_MENU.isOpen()')); } catch (e) {}
    }
    const spawned = /QWTF_EVENT lobby_spawn alpha/.test(fs.readFileSync(LOG, 'utf8'));
    if (closed && spawned) ok('Enter joined with the defaults: the overlay closed and the server spawned alpha');
    else bad('the overlay did not close after both picks',
      `closed=${closed} lobby_spawn=${spawned}`);
    await client.screenshot(path.join(SHOTS, '05-lobby-closed.png'));

    /* The class header (owner, 2026-10-09: "what class you are playing as
     * should be listed"): it names the class and its signature weapon, and it
     * follows a class change. */
    const header = async () => { try { return await client.eval(
      '(document.getElementById("qwtf-class-box")||{}).textContent || ""'); } catch (e) { return ''; } };
    let h = '';
    for (let i = 0; i < 20 && !/SOLDIER/.test(h); i++) { await sleep(500); h = await header(); }
    if (/SOLDIER/.test(h) && /7 Rocket launcher/.test(h)) ok('the help panel names the class: SOLDIER, 7 Rocket launcher');
    else bad('the help panel does not name the class', JSON.stringify(h));
    await client.eval('window.QWTF_MENU.do("cls_sniper")');
    for (let i = 0; i < 20 && !/SNIPER/.test(h); i++) { await sleep(500); h = await header(); }
    if (/SNIPER/.test(h) && /right mouse/.test(h)) ok('it follows a class change: SNIPER, scope on the right mouse');
    else bad('the class header did not follow the change to Sniper', JSON.stringify(h));
    await client.screenshot(path.join(SHOTS, '06-class-header.png'));
  } finally {
    for (const c of clients) await c.stop();
    if (page) {
      try { process.kill(-page.pid, 'SIGKILL'); } catch (e) {
        try { page.kill('SIGKILL'); } catch (e2) {} }
    }
    await sleep(300);
    await server.stop();
  }
}

async function main() {
  let failed = 0;
  const results = [];
  const ok = (m) => { results.push(['ok', m]); console.log('  ok   ' + m); };
  const bad = (m) => { results.push(['FAIL', m]); failed++; console.log('  FAIL ' + m); };

  staticChecks(ok, bad);
  await browserChecks(ok, bad);
  await lobbyMenuChecks(ok, bad);

  console.log('');
  console.log(failed ? `FAIL: ${failed} checks` : 'PASS');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });