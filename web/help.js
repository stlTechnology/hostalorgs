/*
 * web/help.js -- the on-screen controls help (owner playtest 2026-10-08: "I need
 * some key info on the HUD so I know what buttons are available for functions").
 *
 * A small panel at the top right, shown when the page loads; H hides or shows
 * it. It never takes a click (pointer-events: none) and never swallows a key:
 * H is not bound in quake.rc, and swallowing it would eat every "h" typed in chat.
 *
 * CONTROLS must match web/id1/quake.rc; tests/test_help.js checks both ways.
 */
(function () {
  'use strict';

  const CONTROLS = [
    { key: 'MOUSE1',  label: 'Mouse / Ctrl', action: 'fire' },
    { key: 'CTRL',    label: null,           action: 'fire' },
    { key: 'W',       label: 'W A S D',      action: 'move' },
    { key: 'A',       label: null,           action: 'move' },
    { key: 'S',       label: null,           action: 'move' },
    { key: 'D',       label: null,           action: 'move' },
    { key: 'SPACE',   label: 'Space',        action: 'jump' },
    { key: 'SHIFT',   label: 'Shift',        action: 'walk' },
    { key: 'e',       label: 'E',            action: 'use' },
    { key: '1',       label: '1-8 / wheel',  action: 'weapons' },
    { key: '2',       label: null, action: 'weapons' },
    { key: '3',       label: null, action: 'weapons' },
    { key: '4',       label: null, action: 'weapons' },
    { key: '5',       label: null, action: 'weapons' },
    { key: '6',       label: null, action: 'weapons' },
    { key: '7',       label: null, action: 'weapons' },
    { key: '8',       label: null, action: 'weapons' },
    { key: 'MWHEELUP',   label: null, action: 'next weapon' },
    { key: 'MWHEELDOWN', label: null, action: 'previous weapon' },
    { key: 'MOUSE2',  label: 'Right mouse', action: 'scope (Sniper rifle)' },
    { key: 'g',       label: 'G',   action: 'grenade 1' },
    { key: 'f',       label: 'F',   action: 'grenade 2' },
    { key: 'v',       label: 'V',   action: 'launcher mode (Demolitions)' },
    { key: 'b',       label: 'B',   action: 'detonate charges (Demolitions)' },
    { key: 'ESCAPE',  label: 'Esc', action: 'team, class and settings menu' },
    { key: 'TAB',     label: 'Tab', action: 'scores' },
    { key: 't',       label: 'T',   action: 'chat' },
    { key: 'H',       label: 'H',   action: 'hide or show this help' },
  ];

  /* The class you are playing, and its weapons with their keys (owner,
   * 2026-10-09: "what class you are playing as should be listed or obvious",
   * "the other available weapons for the class should be listed in the hud").
   * Class numbers are qwtf/classes.qc's; weapon keys are Quake's impulses. */
  const CLASSES = {
    1: { name: 'Scout',       weapons: ['4 Nailgun', '2 Shotgun', 'G concussion, F flash grenade'] },
    2: { name: 'Sniper',      weapons: ['3 Sniper rifle: hold fire to charge, right mouse to scope',
                                        '4 Auto-rifle', '2 Shotgun', 'G, F grenades'] },
    3: { name: 'Soldier',     weapons: ['7 Rocket launcher', '3 Super shotgun', 'G grenade, F nail grenade'] },
    4: { name: 'Demolitions', weapons: ['6 Grenade launcher (V sticky mode, B detonate)', '2 Shotgun',
                                        'G grenade, F timed charge'] },
    5: { name: 'Heavy',       weapons: ['5 Rotary cannon', '2 Shotgun', 'G, F grenades'] },
    6: { name: 'Medic',       weapons: ['5 Super nailgun', '3 Super shotgun',
                                        '1 Medkit: heals team to 150, infects enemies', 'G concussion, F grenade'] },
  };
  const TEAM_COLOUR = { 1: '#ff6b6b', 2: '#6bb0ff' };

  const ID = 'qwtf-help';
  const CSS = `
#${ID} {
  position: fixed; right: 8px; top: 8px; z-index: 999;   /* top right: the engine prints its messages top left (owner, 2026-10-10) */
  background: rgba(10, 10, 18, 0.78); color: #e6e6e6;
  font: 13px/1.45 monospace; padding: 8px 12px; border-radius: 6px;
  pointer-events: none; user-select: none;
}
#${ID} b { color: #9cc4e4; display: inline-block; min-width: 116px; font-weight: normal; }
#${ID}[hidden] { display: none; }
#${ID} .qwtf-class { font-size: 15px; font-weight: bold; letter-spacing: 1px; }
#${ID} .qwtf-class-weapons { margin: 2px 0 6px; color: #f0e6c0; }`;

  function root() { return typeof document !== 'undefined' ? document.getElementById(ID) : null; }

  function build() {
    if (root()) return root();
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const div = document.createElement('div');
    div.id = ID;
    div.innerHTML = '<div id="qwtf-class-box"></div>' + CONTROLS.filter(c => c.label)
      .map(c => `<div><b>${c.label}</b>${c.action}</div>`).join('');
    document.body.appendChild(div);
    return div;
  }

  /* Called by web/menu.js on every QWTF_YOU line (each spawn). */
  function setClass(team, cls) {
    const box = (build(), document.getElementById('qwtf-class-box'));
    if (!box) return '';
    const c = CLASSES[cls];
    if (!c) { box.innerHTML = ''; return ''; }
    const colour = TEAM_COLOUR[team] || '#e6e6e6';
    box.innerHTML = `<div class="qwtf-class" style="color:${colour}">${c.name.toUpperCase()}</div>` +
      `<div class="qwtf-class-weapons">${c.weapons.map(w => `<div>${w}</div>`).join('')}</div>`;
    return c.name;
  }

  function visible() { const r = root(); return !!r && !r.hidden; }
  function show() { build().hidden = false; return true; }
  function hide() { const r = root(); if (r) r.hidden = true; return false; }
  function toggle() { return visible() ? hide() : show(); }

  let installed = false;
  function install() {
    if (installed) return false;
    installed = true;
    show();
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'h' && e.key !== 'H') return;   // every other key: untouched
      if (e.repeat) return;
      toggle();                                     // and H still reaches the game
    }, true);
    return true;
  }

  const api = { CONTROLS, CLASSES, build, show, hide, toggle, visible, install, setClass };
  if (typeof window !== 'undefined') {
    window.QWTF_HELP = api;
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', install);
    else
      install();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
