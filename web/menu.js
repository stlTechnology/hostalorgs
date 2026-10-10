/*
 * web/menu.js -- our own ESC menu, and the bridge to the engine's console.
 *
 * PLAN.md M5, from GAME-DESIGN.md "Menus" and the owner's feedback in 0086: FTE's
 * stock menus (single player, server browser, options pages) go, and ESC opens a
 * minimal overlay instead -- Resume / team / class / the lobby list / Settings /
 * Leave -- which doubles as the lobby. The 2026-10-09 playtest removed
 * Reconnect: it dropped the web client to the engine console and sat there.
 *
 * ---------------------------------------------------------------------------
 * How ESC is taken away from FTE
 *
 * FTE opens its own menu on ESC (keys.c:3036 -> M_ToggleMenu_f -> M_Menu_Main_f).
 * Its key listeners are registered on the canvas and on `document`, both with
 * capture:true. Capture order is window -> document -> ... -> target, so a
 * capture listener on `window` runs BEFORE FTE's document listener. Ours calls
 * stopPropagation() on Escape, which means the engine never sees the key at all.
 *
 * That is the whole mechanism, and it is worth stating plainly because the
 * alternative -- unbinding or disabling FTE's menu commands -- is not available
 * from script: FTE registers menu_main and friends with Cmd_AddCommand
 * (menu.c:1386) and there is no console command to remove one. Intercepting the
 * key is both simpler and stronger: nothing downstream runs, so there is no
 * `menu_main` to reach even if something wanted to.
 *
 * ---------------------------------------------------------------------------
 * The console bridge
 *
 * FTEC.cbufadd(text) is FTE's own "add this text to the command buffer" entry
 * point -- the same one window.onmessage uses for chat, i.e. exactly what typing
 * into the console would do. `var FTEC = {...}` at the top level of
 * ftewebgl.js makes it a global, so a plain <script src> on the page can reach
 * it. Every action here goes through it, so nothing is reimplemented: the overlay
 * asks the engine to do what a player typing the same command would do.
 *
 * If FTEC is not there yet (the engine is still loading), commands are queued and
 * flushed when it appears, so a menu action during startup is not silently lost.
 */
'use strict';

(function () {
  /* ------------------------------------------------------------------ state */
  const state = {
    open: false,
    pending: [],          /* commands issued before the engine existed */
    retries: [],          /* server-bound commands being re-sent (see below) */
    retryTimer: null,
    whoTimer: null,       /* the 2 s lobby-list poll while the overlay is open */
    settings: {
      sensitivity: 2,
      invert: 0,
      volume: 0.7,
    },
    team: null,           /* null = server decides */
    cls: null,            /* null = server decides */
    lobby: { team: 0, cls: 0 },  /* the server's own account: its "You:" lines */
    /* What the lobby will join as. Pre-selected so nobody starts without a team
     * or class (owner, 2026-10-10): Auto team, Soldier. */
    sel: { team: 'team_auto', cls: 'cls_soldier' },
    who: [],              /* the last lobby list: { name, team } */
    autoOpened: false,    /* the join auto-open has run for this lobby stay */
  };

  /* Every action the overlay offers, and the console command it sends.
   *
   * Kept as data, in one place, so the test can read the whole surface instead of
   * grepping the file: if a stock FTE menu command ever appears here, the test
   * fails. That is the PLAN.md done-when "none of FTE's menu commands can be
   * reached from it", asserted against the list rather than against the absence
   * of a string.
   *
   * The two qwtf_* families are SERVER commands the client engine does not know,
   * and FTE's client does not forward unknown commands: measured on the shipped
   * build, `qwtf_setclass scout` in the command buffer prints Unknown command
   * "qwtf_setclass" and never reaches the server, while QW's own forwarding
   * command `cmd qwtf_setclass scout` arrives and is answered. So the server-bound
   * lobby commands are written in the wire form FTE actually forwards; the client
   * commands (reconnect, disconnect) and cvar settings stay bare. */
  const ACTIONS = {
    resume:    { label: 'Resume',     command: null },
    join:      { label: 'Join game',  command: null },
    team_red:  { label: 'Red team',   command: 'cmd qwtf_setteam red' },
    team_blue: { label: 'Blue team',  command: 'cmd qwtf_setteam blue' },
    team_auto: { label: 'Auto',       command: 'cmd qwtf_setteam auto' },
    cls_soldier: { label: 'Soldier',     command: 'cmd qwtf_setclass soldier' },
    cls_scout:   { label: 'Scout',       command: 'cmd qwtf_setclass scout' },
    cls_medic:   { label: 'Medic',       command: 'cmd qwtf_setclass medic' },
    cls_demo:    { label: 'Demolitions', command: 'cmd qwtf_setclass demolitions' },
    cls_heavy:   { label: 'Heavy',      command: 'cmd qwtf_setclass heavy' },
    cls_sniper:  { label: 'Sniper',     command: 'cmd qwtf_setclass sniper' },
    settings:  { label: 'Settings',    command: 'menu_options' },
    leave:     { label: 'Leave',       command: 'disconnect' },
  };

  /* FTE's own commands that must never be reachable from this overlay. Named
   * here so the test asserts against the list rather than trusting a grep.
   *
   * menu_options is DELIBERATELY not on this list any more: the overlay takes
   * ESC (the interception above leaves the engine's own ESC menu unreachable),
   * so the Settings button is the one way to the engine's options pages --
   * video, sound, mouse, keys. That is the 2026-10-09 playtest's "there is
   * nothing to help me know what buttons are available" fix, not a leak. */
  const STOCK_MENU_COMMANDS = [
    'menu_main', 'menu_single', 'menu_multiplayer', 'menu_video',
    'menu_keys', 'menu_advanced', 'menu_download', 'menu_quit', 'menu_browser',
    'menu_servers', 'menu_findgame', 'menu_addserver', 'menu_player',
    'menu_chat', 'menu_console', 'M_Menu_Main_f', 'togglemenu',
  ];

  const CVARS = {
    sensitivity: ['sensitivity', String],
    invert:      ['m_invert', String],
    volume:      ['snd_vol', (v) => String(Math.round(v * 100) / 100)],
  };

  /* ------------------------------------------------------------- the bridge */
  function engine() {
    return (typeof window !== 'undefined' && window.FTEC &&
            typeof window.FTEC.cbufadd === 'function') ? window.FTEC : null;
  }

  function send(command) {
    if (!command) return false;
    const e = engine();
    if (!e) {
      /* The engine is still loading. Queue rather than drop it, so an action
       * taken during startup still happens. */
      state.pending.push(command);
      return false;
    }
    /* THE TRAILING NEWLINE IS NOT OPTIONAL. FTEC.cbufadd maps to
     * Cbuf_AddText, which appends the text to the command buffer without
     * terminating it; a command without its own newline sits in the buffer
     * until the NEXT command arrives and the two execute as one line.
     * Measured (tests/test_lobby.js run-lobby-1693375, server.log:449):
     *   Client command: qwtf_setclass soldiercmd qwtf_setteam red
     * i.e. the class pick arrived as argv(1) "soldiercmd" -- "no such class"
     * -- and the team pick inside it was never seen. That is the owner's
     * 2026-10-09 report almost verbatim: "I select and the weapon doesn't
     * change, I hit reconnect and it either does, or just bombs out" -- a
     * click followed by Reconnect ran "cmd qwtf_setclass snipercmd reconnect". */
    e.cbufadd(command + '\n');
    return true;
  }

  /* ---------------------------------------------------------------- reliability
   * The lobby commands are the ones a player presses in the FIRST seconds of a
   * session -- that is the whole point of the lobby -- and they were being lost
   * there, silently.
   *
   * MEASURED (tests/test_classes.js, the class-step check, three runs): the
   * click reaches the button, the overlay hands the engine the right text
   * (`cmd qwtf_setclass scout`, read out of the page by wrapping FTEC.cbufadd),
   * no pointer lock is in the way, no exception is thrown, the client's console
   * says nothing at all about the command -- and the server never logs it. The
   * same command from the same page two seconds later arrives. The engine is
   * dropping a client->server command issued right after the connect, which is
   * what FTE's client does while its own connection state is still settling:
   * CL_SendSeatClientCommand queues it in `clientcmdlist`, and CL_FlushClientCommands
   * (cl_main.c, from CL_CheckForResend / CL_Disconnect) throws that whole list
   * away rather than send it. Nothing in that path reports the loss.
   *
   * So the page cannot trust one send, and cannot ask: FTEC exposes no way to
   * read a cvar or a command result. What it CAN do is send again a moment
   * later, and the server is idempotent about it -- `qwtf_setclass` to the class
   * you already have is a no-op, and `qwtf_setteam` to your own team is refused
   * with "you are already on that team" and moves nobody. A lost command then
   * costs the player a quarter of a second and nothing else, where before it
   * cost them the pick.
   *
   * Only the picks (`cmd qwtf_setteam` / `cmd qwtf_setclass`) are retried.
   * `disconnect`, `menu_options` and the cvar settings are local commands
   * with their own effects, and repeating those would be the bug.
   */
  const RETRY_DELAYS = [250, 700, 1500];

  function isServerCommand(command) {
    return typeof command === 'string' && command.startsWith('cmd qwtf_');
  }

  /* The who poll is deliberately NOT retried: it is a read, not a pick, and
   * the 2 s poll re-issues it anyway. Retrying it would put six lines on the
   * wire for every list refresh. */
  function isRetryWorthy(command) {
    return isServerCommand(command) && !command.startsWith('cmd qwtf_who');
  }

  function sendReliable(command) {
    if (!send(command)) return false;     /* still queued for the engine */
    if (!isRetryWorthy(command)) return true;
    /* One timer for all of them, cleared as soon as the queue empties: a
     * permanent interval in the page is the sort of thing that keeps a
     * headless browser alive after a test is done with it. */
    state.retries.push({ command, at: RETRY_DELAYS });
    if (!state.retryTimer) {
      state.retryTimer = setInterval(() => {
        for (let i = state.retries.length - 1; i >= 0; i--) {
          const r = state.retries[i];
          if (!r.at.length) { state.retries.splice(i, 1); continue; }
          send(r.command);
          r.at.shift();
        }
        if (!state.retries.length && state.retryTimer) {
          clearInterval(state.retryTimer);
          state.retryTimer = null;
        }
      }, 250);
    }
    return true;
  }

function flushPending() {
  const e = engine();
  if (!e || !state.pending.length) return;
  const queued = state.pending;
  state.pending = [];
  for (const c of queued) sendReliable(c);
}

  /* Poll only until the engine shows up; then stop. A permanent interval would
   * be a permanent timer in the page, which is the sort of thing that keeps a
   * headless Chrome alive after a test is done with it. */
  let flushTries = 0;
  const flushTimer = setInterval(() => {
    if (flushPending() || ++flushTries > 200) clearInterval(flushTimer);
  }, 100);

  /* ------------------------------------------------------------ the lobby
   * The server owns the lobby state and says so on the client's console --
   * the same output _emscriptenfte_print hands to console.log one line at a
   * time, which is how this page already reads the engine. Two line shapes:
   *
   *   You: Red team, Soldier        the caller's own state, sent on entering
   *                                 the lobby and on every spawn
   *   Players: a (red) | b (choosing)   one line, the answer to `cmd qwtf_who`
   *
   * Both are written to read as normal game messages, because the engine also
   * draws every console line on screen for a few seconds.
   *
   * The overlay opens itself when the "You:" line says the player is in the
   * lobby -- a fresh visitor lands on the picks without having to find ESC --
   * and closes itself when both picks are made (team != 0 and class != 0 on
   * the same line, which is the spawn the server just did). ESC keeps working
   * either way; auto-open only runs once per lobby stay, so a player who
   * closed the overlay on purpose is not dragged back into it.
   */
  /* ftos prints whole numbers the way the rest of the trail prints them, and
   * it has printed "1.000000" flavours too; both must parse. */
  /* The server's two readable lines (qwtf/lobby.qc):
   *   You: Red team, Soldier          (every spawn and on entering the lobby)
   *   Players: Bot Red (red) | alpha (choosing)   (answer to cmd qwtf_who) */
  const YOU_RE = /^You: (Red team|Blue team|no team), (Scout|Sniper|Soldier|Demolitions|Heavy|Medic|no class)\s*$/;
  const WHO_RE = /^Players: (.*?)\s*$/;
  const TEAM_ID = { 'Red team': 1, 'Blue team': 2, 'no team': 0 };
  const CLASS_ID = { Scout: 1, Sniper: 2, Soldier: 3, Demolitions: 4, Heavy: 5, Medic: 6, 'no class': 0 };

  function handleLine(line) {
    const you = YOU_RE.exec(line);
    if (you) {
      state.lobby = { team: TEAM_ID[you[1]], cls: CLASS_ID[you[2]] };
      try { api.renderSelection(); } catch (e) { /* not built yet */ }
      try { if (window.QWTF_HELP) window.QWTF_HELP.setClass(state.lobby.team, state.lobby.cls); }
      catch (e) { /* the help panel is optional */ }
      const done = state.lobby.team !== 0 && state.lobby.cls !== 0;
      if (done) {
        if (api.isOpen()) api.close();
        state.autoOpened = false;
      } else if (!api.isOpen() && !state.autoOpened) {
        state.autoOpened = true;
        api.open();
      }
      return;
    }
    const who = WHO_RE.exec(line);
    if (who) {
      state.who = who[1].split(' | ').map(p => /^(.*) \((red|blue|choosing)\)$/.exec(p))
        .filter(Boolean).map(m => ({ name: m[1], team: m[2] }));
      api.renderWho();
    }
  }

  /* Wrap console.log once. The engine's console output is the ONLY channel
   * the server's lobby state reaches the page through, and this is where the
   * lines are complete. The wrapper is transparent: everything it does not
   * recognise goes through untouched. */
  function installConsoleHook() {
    if (api._consoleHooked) return;
    api._consoleHooked = true;
    const orig = console.log.bind(console);
    console.log = function (...args) {
      try {
        const s = args.map(a => (typeof a === 'string' ? a : String(a.value !== undefined ? a.value : a))).join(' ');
        const t = s.trim();
        if (t.startsWith('You: ') || t.startsWith('Players: ')) handleLine(t);
      } catch (e) { /* never let the hook break the page */ }
      return orig(...args);
    };
  }

  function renderWhoRow(p) {
    const row = el('div', { class: 'qwtf-row', 'data-qwtf-player': p.name });
    const nm = el('span', { class: 'qwtf-label', style: 'width:auto;flex:1;' }, p.name);
    const team = el('span', { style: 'color:#8fa3bd' },
      p.team === 'red' ? 'Red' : p.team === 'blue' ? 'Blue' : 'choosing');
    row.appendChild(nm);
    row.appendChild(team);
    return row;
  }

  /* ------------------------------------------------------------ the DOM */
  const CSS = `
#qwtf-menu { position: fixed; inset: 0; z-index: 50; display: none;
  background: rgba(6,8,12,0.82); color: #dfe6ef;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
#qwtf-menu.qwtf-open { display: flex; align-items: center; justify-content: center; }
#qwtf-menu .qwtf-panel { background: #131820; border: 1px solid #2b3646;
  border-radius: 8px; padding: 18px 22px; min-width: 320px;
  box-shadow: 0 18px 60px rgba(0,0,0,0.6); }
#qwtf-menu h1 { font-size: 15px; margin: 0 0 12px; letter-spacing: .08em;
  text-transform: uppercase; color: #8fa3bd; }
#qwtf-menu .qwtf-row { display: flex; gap: 6px; margin-bottom: 8px;
  align-items: center; flex-wrap: wrap; }
#qwtf-menu .qwtf-label { width: 96px; color: #8fa3bd; }
#qwtf-menu button { background: #1d2733; color: #dfe6ef; border: 1px solid #33445a;
  border-radius: 5px; padding: 6px 10px; cursor: pointer; font: inherit; }
#qwtf-menu button:hover { background: #27354a; }
#qwtf-menu button[aria-pressed="true"] { background: #2f5d8f; border-color: #4d86c4; }
#qwtf-menu .qwtf-sep { height: 1px; background: #2b3646; margin: 12px 0; }
#qwtf-menu .qwtf-hint { color: #6d7f96; font-size: 12px; margin-top: 10px; }
/* Never taller than the screen: a phone held sideways is about 390 px tall and
 * the panel ran off its top, hiding Join (owner, 2026-10-10). */
#qwtf-menu .qwtf-panel { max-height: calc(100vh - 16px); overflow-y: auto; }
@media (max-height: 520px) {
  #qwtf-menu { font-size: 13px; }
  #qwtf-menu .qwtf-panel { padding: 10px 14px; }
  #qwtf-menu h1 { margin-bottom: 6px; }
  #qwtf-menu .qwtf-row { margin-bottom: 5px; }
  #qwtf-menu .qwtf-label { width: 64px; }
  #qwtf-menu button { padding: 7px 10px; }
  #qwtf-menu .qwtf-sep { margin: 6px 0; }
  #qwtf-menu .qwtf-settings-row { display: none; }
  #qwtf-menu [data-qwtf-players] { max-height: 22vh !important; }
}
`;

  function el(tag, attrs, text) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function build() {
    if (document.getElementById('qwtf-menu')) return document.getElementById('qwtf-menu');
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = el('div', { id: 'qwtf-menu', role: 'dialog', 'aria-modal': 'true',
                            'aria-label': 'Hostalorgs menu' });
    const panel = el('div', { class: 'qwtf-panel' });
    panel.appendChild(el('h1', null, 'Hostalorgs'));

    function row(labelText) {
      const r = el('div', { class: 'qwtf-row' });
      if (labelText) r.appendChild(el('span', { class: 'qwtf-label' }, labelText));
      panel.appendChild(r);
      return r;
    }
    function button(actionName) {
      const a = ACTIONS[actionName];
      const b = el('button', { type: 'button', 'data-qwtf-action': actionName }, a.label);
      b.addEventListener('click', () => {
        if (api.choose(actionName)) return;      /* a lobby selection or the join */
        sendReliable(a.command);
        if (actionName === 'resume') api.close();
        /* Settings hands over to the engine's own options menu, which draws
         * on the canvas UNDER this overlay -- ours has to go, or the player
         * clicks a menu they cannot see. */
        if (actionName === 'settings') api.close();
      });
      return b;
    }

    const resumeRow = row(null);
    resumeRow.appendChild(button('join'));
    resumeRow.appendChild(button('resume'));
    resumeRow.appendChild(el('span', { class: 'qwtf-label', style: 'width:auto;margin-left:8px;',
                                       'data-qwtf-joinas': '' }, ''));

    panel.appendChild(el('div', { class: 'qwtf-sep' }));
    const teamRow = row('Team');
    for (const t of ['team_auto', 'team_red', 'team_blue']) teamRow.appendChild(button(t));

    const clsRow = row('Class');
    for (const c of ['cls_soldier', 'cls_scout', 'cls_medic', 'cls_demo',
                     'cls_heavy', 'cls_sniper']) clsRow.appendChild(button(c));

    panel.appendChild(el('div', { class: 'qwtf-sep' }));
    const sensRow = row('Sensitivity');
    sensRow.classList.add('qwtf-settings-row');
    const sens = el('input', { type: 'range', min: '0.5', max: '8', step: '0.1',
                                'data-qwtf-setting': 'sensitivity' });
    sens.value = String(state.settings.sensitivity);
    sens.addEventListener('input', () => api.setSetting('sensitivity', parseFloat(sens.value)));
    sensRow.appendChild(sens);

    const invRow = row('Invert');
    invRow.classList.add('qwtf-settings-row');
    const inv = el('button', { type: 'button', 'data-qwtf-action': 'invert' }, 'Off');
    inv.addEventListener('click', () => {
      api.setSetting('invert', state.settings.invert ? 0 : 1);
    });
    invRow.appendChild(inv);

    const volRow = row('Volume');
    volRow.classList.add('qwtf-settings-row');
    const vol = el('input', { type: 'range', min: '0', max: '1', step: '0.05',
                               'data-qwtf-setting': 'volume' });
    vol.value = String(state.settings.volume);
    vol.addEventListener('input', () => api.setSetting('volume', parseFloat(vol.value)));
    volRow.appendChild(vol);

    panel.appendChild(el('div', { class: 'qwtf-sep' }));
    const whoHead = row('Lobby');
    whoHead.setAttribute('data-qwtf-lobby-head', '1');
    const whoBox = el('div', { 'data-qwtf-players': '1', style: 'max-height:140px;overflow-y:auto' });
    panel.appendChild(whoBox);

    panel.appendChild(el('div', { class: 'qwtf-sep' }));
    const endRow = row(null);
    endRow.appendChild(button('settings'));
    endRow.appendChild(button('leave'));

    /* Build stamp row: fetched from build.json when the menu opens. */
    const buildRow = row('Build');
    const buildText = el('span', { style: 'color:#8fa3bd;font-size:11px;padding-left:4px' }, 'loading...');
    buildRow.appendChild(buildText);
    panel.appendChild(buildRow);

    /* Fetch build.json once when the overlay opens. */
    api._buildFetchPromise = (async () => {
      try {
        const r = await fetch('build.json');
        const j = await r.json();
        const built = j.built ? j.built.replace('<br>', ' ') : 'unknown';
        const sha = j.sha ? j.sha : '';
        buildText.textContent = `build ${built} · ${sha}`;
      } catch (e) {
        buildText.textContent = 'build unknown';
      }
    })();

    panel.appendChild(el('div', { class: 'qwtf-hint' },
      'ESC or Resume to close. Settings opens the engine\'s own options ' +
      '(video, sound, mouse, keys).'));
    root.appendChild(panel);

    /* Clicking the backdrop closes, like every menu. */
    root.addEventListener('mousedown', (e) => { if (e.target === root) api.close(); });

    document.body.appendChild(root);
    return root;
  }

  /* ---------------------------------------------------------------- the API */
  const api = {
    ACTIONS,
    STOCK_MENU_COMMANDS,
    state,

    build,

    get root() { return document.getElementById('qwtf-menu'); },
    isOpen() { const r = api.root; return !!(r && r.classList.contains('qwtf-open')); },

    open() {
      const r = build();
      r.classList.add('qwtf-open');
      state.open = true;
      document.documentElement.style.cursor = 'default';
      api.refresh();
      api.renderWho();
      api.renderSelection();
      /* The lobby list lives on the server; ask for it now and every 2 s
       * while the overlay is open, and never leave the interval behind.
       * state.who is cleared per request: each answer is a whole list, and
       * mixing two answers would show a player twice. */
      const askWho = () => { state.who = []; send('cmd qwtf_who'); api.renderWho(); };
      askWho();
      if (!state.whoTimer) {
        state.whoTimer = setInterval(() => {
          if (!api.isOpen()) { clearInterval(state.whoTimer); state.whoTimer = null; return; }
          askWho();
        }, 2000);
      }
      return true;
    },

    renderWho() {
      const r = api.root;
      if (!r) return;
      const box = r.querySelector('[data-qwtf-players]');
      if (!box) return;
      /* Keep the last burst only: each who answer is a whole list, and a
       * partial mix of two answers would show a player twice. */
      box.textContent = '';
      for (const p of state.who) box.appendChild(renderWhoRow(p));
      if (!state.who.length) {
        box.appendChild(el('div', { class: 'qwtf-hint', style: 'margin-top:2px' }, '...'));
      }
    },

    close() {
      const r = api.root;
      if (r) r.classList.remove('qwtf-open');
      state.open = false;
      document.documentElement.style.cursor = '';
      if (state.whoTimer) { clearInterval(state.whoTimer); state.whoTimer = null; }
      /* FTE re-acquires the pointer lock on the next click; asking for it here
       * would fail without a user gesture and log a pointerlockerror. */
      return true;
    },

    toggle() { return api.isOpen() ? api.close() : api.open(); },

    /* Push a setting to the engine as a cvar. `sensitivity` and `m_invert` are
     * FTE's own cvars, so this is the same thing the stock Options page did --
     * there is no second implementation to keep in step. */
    setSetting(name, value) {
      if (!(name in CVARS)) throw new Error('no such setting: ' + name);
      state.settings[name] = value;
      const [cvar, fmt] = CVARS[name];
      send(`+set ${cvar} ${fmt(value)}`);
      api.refresh();
      return `${cvar} = ${fmt(value)}`;
    },

    inLobby() { return state.lobby.team === 0 || state.lobby.cls === 0; },

    /* The lobby's selection rules. In the lobby a team click selects (it is
     * highlighted, Auto to begin with) and is sent; a class click selects
     * and joins at once; Join (or Enter) joins with what is selected. Returns the
     * description of what it did, or '' when the click is an ordinary in-game
     * action for the caller to send. */
    choose(actionName) {
      if (actionName === 'join') return api.join();
      if (!api.inLobby()) return '';
      if (actionName.startsWith('team_')) {
        /* Highlight it AND let the caller send it: the server keeps the player
         * waiting until a class arrives, and the pick is on record at once. */
        state.sel.team = actionName; api.renderSelection(); return '';
      }
      if (actionName.startsWith('cls_')) { state.sel.cls = actionName; return api.join(); }
      return '';
    },

    join() {
      sendReliable(ACTIONS[state.sel.team].command);
      sendReliable(ACTIONS[state.sel.cls].command);
      api.renderSelection();
      return 'join ' + state.sel.team + ' ' + state.sel.cls;
    },

    /* Highlight what is chosen: in the lobby the selection, in the game the
     * server's own account of the player's team and class. */
    renderSelection() {
      const r = api.root;
      if (!r) return;
      const CLS = { 1: 'cls_scout', 2: 'cls_sniper', 3: 'cls_soldier', 4: 'cls_demo',
                    5: 'cls_heavy', 6: 'cls_medic' };
      const lobby = api.inLobby();
      const team = lobby ? state.sel.team
                         : (state.lobby.team === 1 ? 'team_red' : state.lobby.team === 2 ? 'team_blue' : '');
      const cls = lobby ? state.sel.cls : (CLS[state.lobby.cls] || '');
      for (const b of r.querySelectorAll('button[data-qwtf-action]')) {
        const n = b.getAttribute('data-qwtf-action');
        if (n.startsWith('team_') || n.startsWith('cls_'))
          b.setAttribute('aria-pressed', (n === team || n === cls) ? 'true' : 'false');
        if (n === 'join') b.hidden = !lobby;
        if (n === 'resume') b.hidden = lobby;
      }
      const line = r.querySelector('[data-qwtf-joinas]');
      if (line) {
        const tl = team ? ACTIONS[team].label.replace(' team', '') : '?';
        const cl = cls ? ACTIONS[cls].label : '?';
        const touch = !!(window.QWTF_TOUCH && window.QWTF_TOUCH.isTouch());
        line.textContent = lobby ? `You will join: ${tl} team, ${cl}  (${touch ? 'tap Join game' : 'Enter to join'})`
                                 : `Playing: ${tl} team, ${cl}`;
      }
    },

    do(actionName) {
      if (!(actionName in ACTIONS)) throw new Error('no such action: ' + actionName);
      const chosen = api.choose(actionName);
      if (chosen) return chosen;
      const a = ACTIONS[actionName];
      sendReliable(a.command);
      if (actionName === 'resume') api.close();
      if (actionName === 'settings') api.close();
      return a.command;
    },

    refresh() {
      const r = api.root;
      if (!r) return;
      const inv = r.querySelector('[data-qwtf-action="invert"]');
      if (inv) {
        inv.textContent = state.settings.invert ? 'On' : 'Off';
        inv.setAttribute('aria-pressed', state.settings.invert ? 'true' : 'false');
      }
    },

    /* The commands this overlay can send, for a test to check against the list of
     * stock menu commands. Derived from ACTIONS, so it cannot disagree with what
     * the buttons actually do. */
    commands() {
      return Object.values(ACTIONS).map(a => a.command).filter(Boolean);
    },

    install() {
      if (api._installed) return false;
      api._installed = true;
      /* Built here rather than on first open, so the overlay's DOM exists from
       * the first frame. Building it lazily meant `QWTF_MENU.root` was null until
       * something opened it, which is a null check every caller has to remember. */
      api.build();
      installConsoleHook();
      /* window capture: runs before FTE's document capture listener, so ESC can
       * be taken before the engine ever sees it. See the note at the top. */
      const onKey = (e) => {
        /* Enter in the lobby joins with the highlighted team and class. */
        if ((e.key === 'Enter' || e.code === 'Enter') && api.isOpen() && api.inLobby()) {
          e.stopPropagation();
          e.preventDefault();
          api.join();
          return;
        }
        if (e.key !== 'Escape' && e.code !== 'Escape') return;
        /* Always swallow, open or closed: otherwise ESC closes our menu and then
         * opens FTE's on the same keypress. */
        e.stopPropagation();
        e.preventDefault();
        api.toggle();
      };
      window.addEventListener('keydown', onKey, true);
      return true;
    },
  };

  if (typeof window !== 'undefined') window.QWTF_MENU = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();