/*
 * web/touch.js -- phone and tablet controls (owner, 2026-10-10: "people hit it
 * from their phones and they connect but can't really control").
 *
 * The layout mobile shooter players already know, all handled here:
 *
 *   LEFT half   a floating stick: put a thumb down anywhere and slide it; it
 *               holds +forward/+back/+moveleft/+moveright like W A S D do.
 *   RIGHT half  drag to look: the drag is fed to the engine as mouse movement
 *               (the engine's own pointer-lock path), exactly what a PC mouse
 *               gives it, so turning feels like the mouse does.
 *   Buttons     fire (big), jump, scope, next weapon, grenade, and MENU and
 *               FULL SCREEN at the top. Each sends what its key sends
 *               (web/id1/quake.rc), through FTEC.cbufadd like web/menu.js.
 *
 * This layer takes EVERY touch, so the engine never sees one. The engine's own
 * touch scheme (m_touchstrafe) is not used: it compares the touch position in
 * page pixels with the canvas's backing width, so on a phone with a 2x or 3x
 * screen almost the whole screen counted as its "left half" (measured: a
 * right-hand drag strafed instead of turning).
 *
 * Nothing here runs on a desktop with a mouse.
 */
(function () {
  'use strict';

  /* Where the stick's resting ring is drawn (a hint; the stick floats to
   * wherever the thumb lands on the left half). */
  const STICK_X = 0.2, STICK_Y = 0.7;
  const DEAD = 16;          // px of thumb travel before a direction is held
  let LOOK = 2.2;           // mouse units per px of drag on the right half

  /* Buttons: label, the command held while pressed (or tapped), and where.
   * Positions are from the bottom right, in CSS px, sized for a thumb. */
  const BUTTONS = [
    { id: 'fire',    label: 'FIRE',  hold: 'attack',      right: 24,  bottom: 64,  size: 96 },
    { id: 'jump',    label: 'JUMP',  hold: 'jump',        right: 136, bottom: 28,  size: 64 },
    { id: 'scope',   label: 'SCOPE', hold: 'qwtf_zoom',   right: 136, bottom: 112, size: 56 },
    { id: 'weapon',  label: 'WPN',   tap: 'impulse 10',   right: 40,  bottom: 180, size: 56 },
    { id: 'grenade', label: 'NADE',  tap: 'impulse 20',   right: 112, bottom: 190, size: 52 },
  ];

  const isTouch = () => {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
    catch (e) { return false; }
  };

  function send(cmd) {
    try {
      if (window.FTEC && typeof window.FTEC.cbufadd === 'function') { window.FTEC.cbufadd(cmd + '\n'); return true; }
    } catch (e) { /* engine not ready */ }
    return false;
  }

  /* LOOK: hand the drag to the engine as relative mouse movement. The
   * engine's mousemove handler reads Browser.pointerLock at event time and
   * then takes movementX/Y as a delta, the PC mouse path. */
  function look(dx, dy) {
    const cv = document.getElementById('canvas');
    if (!cv || !window.Browser) return false;
    const was = window.Browser.pointerLock;
    window.Browser.pointerLock = true;
    try {
      const ev = new MouseEvent('mousemove', { bubbles: true, cancelable: true,
        movementX: dx * LOOK, movementY: dy * LOOK });
      if (ev.movementX === undefined || ev.movementX === 0 && dx) {
        Object.defineProperty(ev, 'movementX', { value: dx * LOOK });
        Object.defineProperty(ev, 'movementY', { value: dy * LOOK });
      }
      cv.dispatchEvent(ev);
    } finally { window.Browser.pointerLock = was; }
    return true;
  }

  /* MOVE: the stick's direction as the four held move commands. */
  const held = new Set();
  function setMove(dx, dy) {
    const want = new Set();
    if (dy < -DEAD) want.add('forward');
    if (dy > DEAD) want.add('back');
    if (dx < -DEAD) want.add('moveleft');
    if (dx > DEAD) want.add('moveright');
    for (const c of held) if (!want.has(c)) { send('-' + c); held.delete(c); }
    for (const c of want) if (!held.has(c)) { send('+' + c); held.add(c); }
  }

  const CSS = `
#qwtf-touch { position: fixed; inset: 0; z-index: 40; pointer-events: auto; touch-action: none;
  font: 700 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
#qwtf-touch .tb { position: absolute; pointer-events: auto; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; letter-spacing: .06em;
  background: rgba(20, 24, 32, .38); border: 2px solid rgba(255, 255, 255, .45);
  touch-action: none; }
#qwtf-touch .tb.on { background: rgba(240, 180, 60, .55); border-color: #f0b43c; }
#qwtf-touch .tb[data-id="fire"] { background: rgba(200, 60, 50, .42); font-size: 16px; }
#qwtf-touch .knob { position: absolute; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%;
  background: rgba(255, 255, 255, .35); pointer-events: none; display: none; }
#qwtf-touch .stick { position: absolute; width: 132px; height: 132px; margin: -66px 0 0 -66px;
  border-radius: 50%; border: 2px dashed rgba(255, 255, 255, .28); pointer-events: none; }
#qwtf-touch .stick::after { content: "MOVE"; position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center; color: rgba(255, 255, 255, .35); font-size: 12px; }
#qwtf-touch .top { position: absolute; top: calc(10px + env(safe-area-inset-top, 0px)); pointer-events: auto;
  background: rgba(20, 24, 32, .55); border: 1px solid rgba(255, 255, 255, .4); border-radius: 8px;
  color: #fff; font: 700 13px/1 system-ui, sans-serif; padding: 10px 14px; touch-action: none; }
#qwtf-touch .rotate { position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
  text-align: center; padding: 24px; background: rgba(10, 12, 16, .92); font-size: 18px; line-height: 1.5;
  pointer-events: auto; }
@media (orientation: portrait) { #qwtf-touch .rotate { display: flex; } }`;

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }

  function button(b) {
    const d = el('div', { class: 'tb', 'data-id': b.id, role: 'button', 'aria-label': b.label }, b.label);
    d.style.right = `calc(${b.right}px + env(safe-area-inset-right, 0px))`;
    d.style.bottom = `calc(${b.bottom}px + env(safe-area-inset-bottom, 0px))`;
    d.style.width = d.style.height = b.size + 'px';
    const down = (e) => {
      e.preventDefault(); e.stopPropagation();
      d.classList.add('on');
      if (b.hold) send('+' + b.hold);
      if (b.tap) send(b.tap);
    };
    const up = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!d.classList.contains('on')) return;
      d.classList.remove('on');
      if (b.hold) send('-' + b.hold);
    };
    d.addEventListener('touchstart', down, { passive: false });
    d.addEventListener('touchend', up, { passive: false });
    d.addEventListener('touchcancel', up, { passive: false });
    return d;
  }

  function build() {
    if (document.getElementById('qwtf-touch')) return document.getElementById('qwtf-touch');
    const style = el('style'); style.textContent = CSS; document.head.appendChild(style);
    const root = el('div', { id: 'qwtf-touch' });
    const stick = el('div', { class: 'stick' });
    stick.style.left = (STICK_X * 100) + '%';
    stick.style.top = (STICK_Y * 100) + '%';
    root.appendChild(stick);
    const knob = el('div', { class: 'knob' });
    root.appendChild(knob);
    for (const b of BUTTONS) root.appendChild(button(b));

    /* Every touch that is not on a button: the left half is the stick, the
     * right half is look. Tracked per finger, so both thumbs work at once. */
    const fingers = new Map();
    root.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        if (t.target.closest && t.target.closest('.tb, .top, .rotate')) continue;
        e.preventDefault();
        const kind = t.clientX < window.innerWidth / 2 ? 'move' : 'look';
        if (kind === 'move' && [...fingers.values()].some(f => f.kind === 'move')) continue;
        fingers.set(t.identifier, { kind, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY });
        if (kind === 'move') {
          stick.style.left = t.clientX + 'px'; stick.style.top = t.clientY + 'px';
          knob.style.left = t.clientX + 'px'; knob.style.top = t.clientY + 'px';
          knob.style.display = 'block';
        }
      }
    }, { passive: false });
    root.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        const f = fingers.get(t.identifier);
        if (!f) continue;
        e.preventDefault();
        if (f.kind === 'move') {
          let dx = t.clientX - f.x0, dy = t.clientY - f.y0;
          const r = Math.hypot(dx, dy), max = 56;
          if (r > max) { dx *= max / r; dy *= max / r; }
          knob.style.left = (f.x0 + dx) + 'px'; knob.style.top = (f.y0 + dy) + 'px';
          setMove(dx, dy);
        } else {
          look(t.clientX - f.x, t.clientY - f.y);
        }
        f.x = t.clientX; f.y = t.clientY;
      }
    }, { passive: false });
    const end = (e) => {
      for (const t of e.changedTouches) {
        const f = fingers.get(t.identifier);
        if (!f) continue;
        fingers.delete(t.identifier);
        if (f.kind === 'move') {
          setMove(0, 0);
          knob.style.display = 'none';
          stick.style.left = (STICK_X * 100) + '%'; stick.style.top = (STICK_Y * 100) + '%';
        }
      }
    };
    root.addEventListener('touchend', end, { passive: false });
    root.addEventListener('touchcancel', end, { passive: false });

    const menu = el('div', { class: 'top', 'data-id': 'menu', role: 'button' }, 'MENU');
    menu.style.right = 'calc(12px + env(safe-area-inset-right, 0px))';
    menu.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (window.QWTF_MENU) window.QWTF_MENU.toggle();
    }, { passive: false });
    root.appendChild(menu);

    const full = el('div', { class: 'top', 'data-id': 'fullscreen', role: 'button' }, 'FULL SCREEN');
    full.style.left = 'calc(12px + env(safe-area-inset-left, 0px))';
    full.addEventListener('touchend', (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        const d = document.documentElement;
        (d.requestFullscreen || d.webkitRequestFullscreen || function () {}).call(d);
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      } catch (err) { /* not offered on this phone */ }
    }, { passive: false });
    root.appendChild(full);

    root.appendChild(el('div', { class: 'rotate' }, 'Turn your phone sideways to play.'));
    document.body.appendChild(root);
    return root;
  }

  let installed = false;
  function install(force) {
    if (installed || !(force || isTouch())) return false;
    installed = true;
    build();
    return true;
  }

  const api = { BUTTONS, isTouch, install, build, look, setMove,
    get lookScale() { return LOOK; }, set lookScale(v) { LOOK = +v || LOOK; } };
  if (typeof window !== 'undefined') {
    window.QWTF_TOUCH = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => install());
    else install();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
