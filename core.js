/* =========================================================
   G.R.O.O.T. — core.js
   Guarded Resource Orchestration & Operation Terminal

   Shared helpers used by every other script:
   • DOM shortcuts ($, $$)
   • reduced-motion detection (live)
   • screen-reader announcer
   • tiny animation helpers for buffer slots
   • an event bus: modules call GROOT.emit('add' | 'wait' | 'race' | ...)
     and anything (the floating background, for example) can listen.

   Plain scripts (not ES modules) on purpose, so the project runs by
   double-clicking index.html — no local server needed.
   ========================================================= */
(function () {
  'use strict';

  const G = (window.GROOT = window.GROOT || {});

  /* ---------- DOM shortcuts ---------- */
  G.$ = (s, r) => (r || document).querySelector(s);
  G.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ---------- prefers-reduced-motion (updates live) ---------- */
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = !!(mq && mq.matches);
  const motionListeners = [];
  G.motionReduced = () => reduced;
  G.onMotionChange = (fn) => { motionListeners.push(fn); };
  if (mq) {
    const onChange = (e) => { reduced = e.matches; motionListeners.forEach((fn) => fn(reduced)); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---------- Polite screen-reader announcements ---------- */
  const announcer = document.getElementById('announcer');
  let announceTimer = 0;
  G.announce = function (msg) {
    if (!announcer) return;
    clearTimeout(announceTimer);
    announcer.textContent = '';                       // clear first so repeats are re-read
    announceTimer = setTimeout(() => { announcer.textContent = msg; }, 80);
  };

  /* ---------- Slot animation helpers ---------- */
  // Restart the "pop in" animation on a package element.
  G.popIn = function (el) {
    if (!el) return;
    el.classList.remove('is-new');
    void el.offsetWidth;
    el.classList.add('is-new');
  };
  // Show a package sliding out of a slot; the ghost removes itself afterwards.
  G.ghostOut = function (slotEl, label) {
    const g = document.createElement('div');
    g.className = 'ghost';
    g.setAttribute('aria-hidden', 'true');
    g.innerHTML = '<svg class="pkg-icon" focusable="false"><use href="#i-pkg"></use></svg>';
    const s = document.createElement('span');
    s.textContent = label;
    g.appendChild(s);
    slotEl.appendChild(g);
    let gone = false;
    const kill = () => { if (!gone) { gone = true; g.remove(); } };
    g.addEventListener('animationend', kill, { once: true });
    setTimeout(kill, reduced ? 60 : 800);
  };
  // A small "no!" shake (skipped when motion is reduced).
  G.shake = function (el) {
    if (!el || reduced) return;
    el.classList.remove('is-shake');
    void el.offsetWidth;
    el.classList.add('is-shake');
  };

  /* ---------- Module bus ---------- */
  // The stage controller replaces refresh() so modules can say "my gate may have opened".
  G.bus = { refresh: function () {} };

  // Game events for anyone who wants to react (the ambient background does).
  //   add      a package entered a buffer
  //   wait     a worker blocked on a semaphore   { sem: 'empty' | 'full' | 'mutex' }
  //   race     a race condition was shown
  //   restore  safety restored / mutex path succeeded
  //   win      the 15-package shift is complete
  //   stage    the visible stage changed          { dir: 'fwd' | 'back', id }
  G.emit = function (type, detail) {
    try {
      window.dispatchEvent(new CustomEvent('groot:event', { detail: Object.assign({ type: type }, detail || {}) }));
    } catch (e) { /* very old browsers: background reactions are optional */ }
  };
})();
