/* =========================================================
   G.R.O.O.T. — stages.js
   The stage-by-stage reveal: Next / Back, in-stage reveals, gated
   steps, chapter jumps, #/stage links and ← / → keys. Loads last.
   ========================================================= */
(function () {
  'use strict';

  const G = window.GROOT;
  const $ = G.$, $$ = G.$$, announce = G.announce, popIn = G.popIn, ghostOut = G.ghostOut, shake = G.shake, bus = G.bus;

  const Learn = G.Learn, Door = G.Door;

  /* =========================================================
     8. STAGE CONTROLLER — one stage at a time, revealed with Next
     ---------------------------------------------------------
     • Each <section class="stage"> is a full-screen stage.
     • [data-reveal] blocks inside a stage are uncovered one per
       Next press before the journey moves on.
     • Some stages are gated: Next stays locked until the player
       has done the stage's action (Learn steps, the Door choice).
     • The chapter bar jumps anywhere; the URL hash (#/play)
       remembers the current stage; ← / → keys also work.
     ========================================================= */
  const Stage = (function () {
    const els = $$('.stage');
    const ids = els.map((e) => e.dataset.stage);
    const CONFIG = {
      mission:   { chapter: 'mission', title: 'Mission Briefing', next: 'Next: Meet the Cast' },
      cast:      { chapter: 'cast', title: 'Meet the Cast', next: 'Next: The Story' },
      story:     { chapter: 'cast', title: 'The Story', next: 'Next: Learn the Rules' },
      learn:     { chapter: 'learn', title: 'Learn the Rules', next: 'Next: One Door, Two Workers', custom: learnNext },
      door:      { chapter: 'learn', title: 'One Door, Two Workers', next: 'Next: Different Jobs', gate: () => (Door.tried ? null : 'Pick a path to continue') },
      jobs:      { chapter: 'learn', title: 'Different Jobs', next: 'Next: Enter the Control Room' },
      play:      { chapter: 'play', title: 'Control Room', next: 'Next: Scenario Challenges' },
      scenarios: { chapter: 'play', title: 'Scenario Challenges', next: 'Next: See Your Results' },
      results:   { chapter: 'results', title: 'Results', next: 'Next: Under the Hood' },
      logic:     { chapter: 'logic', title: 'The Logic Behind the Game', next: 'Next: The Pseudocode' },
      code:      { chapter: 'logic', title: 'Pseudocode', next: 'Next: The Debrief' },
      debrief:   { chapter: 'logic', title: 'What You Just Controlled', next: null },
    };
    const CHAPTER_START = { mission: 'mission', cast: 'cast', learn: 'learn', play: 'play', results: 'results', logic: 'logic' };
    const chapBtns = $$('.chap');
    const navLinks = $('#nav-links');
    const navToggle = $('#nav-toggle');
    const navToggleLabel = $('#nav-toggle-label');
    const nextBtn = $('#next-btn');
    const nextLabel = $('#next-label');
    const backBtn = $('#back-btn');
    const gateHint = $('#gate-hint');
    const gateText = $('#gate-text');
    const counter = $('#stage-counter');
    const dotsWrap = $('#stage-dots');
    const tripFill = $('#trip-fill');
    let cur = -1;
    let wasGated = false;
    const visited = new Set();

    ids.forEach(() => dotsWrap.appendChild(document.createElement('i')));
    const dots = Array.from(dotsWrap.children);

    // Learn: the global Next walks through its four steps, gated on each one.
    function learnNext() {
      const s = Learn.step;
      if (!Learn.isDone(s)) return { gate: Learn.gate(s) };
      if (s < 3) return { label: 'Next rule: ' + Learn.title(s + 1), action: () => { Learn.goTo(s + 1); Learn.focusFirstAction(); announce('Rule ' + (s + 2) + ' of 4: ' + Learn.title(s + 1)); } };
      return null; // fall through to the normal "next stage"
    }

    const revealItems = (el) => $$('[data-reveal]', el);
    function setRevealed(el, n) {
      revealItems(el).forEach((item, i) => item.classList.toggle('is-hidden', i >= n));
      el.dataset.revealed = String(n);
    }

    // What should the Next button do right now?
    function nextState() {
      const id = ids[cur];
      const el = els[cur];
      const cfg = CONFIG[id];
      const items = revealItems(el);
      const n = Number(el.dataset.revealed || items.length);
      if (n < items.length) {
        return { label: items[n].dataset.label || 'Reveal more', action: () => {
          setRevealed(el, n + 1);
          const shown = items[n];
          announce(shown.textContent.replace(/\s+/g, ' ').trim());
          if (shown.scrollIntoView) shown.scrollIntoView({ block: 'nearest', behavior: G.motionReduced() ? 'auto' : 'smooth' });
        } };
      }
      if (cfg.custom) { const c = cfg.custom(); if (c) return c; }
      if (cfg.gate) { const g = cfg.gate(); if (g) return { gate: g }; }
      if (cur === ids.length - 1) return { label: 'Back to the start', action: () => goTo(0, { focusTitle: true }) };
      return { label: cfg.next, action: () => goTo(cur + 1) };
    }

    function update() {
      if (cur < 0) return;
      const s = nextState();
      const gated = !!s.gate;
      nextBtn.setAttribute('aria-disabled', String(gated));
      nextLabel.textContent = gated ? 'Next' : s.label;
      nextBtn.setAttribute('aria-label', gated ? 'Next (locked): ' + s.gate : s.label);
      gateHint.hidden = !gated;
      gateText.textContent = gated ? s.gate : '';
      counter.hidden = gated;
      dotsWrap.hidden = gated;
      if (wasGated && !gated && !G.motionReduced()) {      // gate just opened → gentle pulse
        nextBtn.classList.remove('is-ready'); void nextBtn.offsetWidth; nextBtn.classList.add('is-ready');
      }
      wasGated = gated;
      backBtn.disabled = cur === 0;
      counter.innerHTML = 'Stage ' + (cur + 1) + ' of ' + ids.length + '<span class="cnt-title"> · ' + CONFIG[ids[cur]].title + '</span>';
      dots.forEach((d, i) => { d.classList.toggle('is-cur', i === cur); d.classList.toggle('is-seen', visited.has(ids[i]) && i !== cur); });
      tripFill.style.width = ((cur + 1) / ids.length * 100) + '%';
      const chapter = CONFIG[ids[cur]].chapter;
      chapBtns.forEach((b) => {
        const on = b.dataset.chapter === chapter;
        b.classList.toggle('is-active', on);
        b.classList.toggle('is-visited', !on && ids.some((id) => CONFIG[id].chapter === b.dataset.chapter && visited.has(id)));
        if (on) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      const activeBtn = chapBtns.find((b) => b.dataset.chapter === chapter);
      navToggleLabel.textContent = activeBtn ? activeBtn.textContent : 'Chapters';
    }

    function goTo(target, opts) {
      opts = opts || {};
      const i = typeof target === 'string' ? ids.indexOf(target) : target;
      if (i < 0 || i >= ids.length) return;
      if (i === cur) { if (opts.focusTitle) focusTitle(els[i]); return; }
      const dir = i > cur ? 'fwd' : 'back';
      const prev = els[cur];
      const hadFocusInside = prev && prev.contains(document.activeElement);
      if (prev) { prev.hidden = true; prev.classList.remove('enter-fwd', 'enter-back'); }
      const el = els[i];
      const items = revealItems(el);
      // First visit going forward: reveal step by step. Otherwise show everything.
      if (items.length) setRevealed(el, (dir === 'fwd' && !visited.has(ids[i])) ? 0 : items.length);
      el.hidden = false;
      el.scrollTop = 0;
      el.classList.remove('enter-fwd', 'enter-back');
      void el.offsetWidth;
      el.classList.add(dir === 'fwd' ? 'enter-fwd' : 'enter-back');
      cur = i;
      visited.add(ids[i]);
      document.body.dataset.stage = ids[i];
      G.emit('stage', { dir: dir, id: ids[i] });
      if (history.replaceState) history.replaceState(null, '', '#/' + ids[i]);
      wasGated = false;
      update();
      announce('Stage ' + (i + 1) + ' of ' + ids.length + ': ' + CONFIG[ids[i]].title);
      // Keep focus on Next when the player is clicking through; otherwise move it to the new title.
      if (opts.focusTitle || hadFocusInside || document.activeElement === document.body) focusTitle(el);
    }
    function focusTitle(el) {
      const h = $('.stage-title', el);
      if (h) { try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
    }

    function next() {
      const s = nextState();
      if (s.gate) {
        announce(s.gate);
        if (!G.motionReduced()) { gateHint.classList.remove('is-nudge'); void gateHint.offsetWidth; gateHint.classList.add('is-nudge'); }
        return;
      }
      s.action();
      update();
    }
    function back() { if (cur > 0) goTo(cur - 1); }

    // --- Wiring
    nextBtn.addEventListener('click', next);
    backBtn.addEventListener('click', back);
    function closeMenu() { navLinks.classList.remove('is-open'); navToggle.setAttribute('aria-expanded', 'false'); }
    navToggle.addEventListener('click', () => {
      const open = !navLinks.classList.contains('is-open');
      navLinks.classList.toggle('is-open', open);
      navToggle.setAttribute('aria-expanded', String(open));
    });
    chapBtns.forEach((b) => b.addEventListener('click', () => { closeMenu(); goTo(CHAPTER_START[b.dataset.chapter], { focusTitle: true }); }));
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => goTo(b.dataset.goto, { focusTitle: true })));
    $('.brand').addEventListener('click', (e) => { e.preventDefault(); closeMenu(); goTo(0, { focusTitle: true }); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navLinks.classList.contains('is-open')) { closeMenu(); navToggle.focus(); return; }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (G.Sim && G.Sim.modalOpen()) return;
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    });

    // Hash links (#/play) — also used by the skip link.
    function fromHash() {
      const m = /^#\/([\w-]+)/.exec(location.hash || '');
      return m && ids.indexOf(m[1]) >= 0 ? m[1] : null;
    }
    window.addEventListener('hashchange', () => { const id = fromHash(); if (id) goTo(id, { focusTitle: true }); });

    // Keep the stage area exactly between the top and bottom bars.
    const topbar = $('.topbar');
    const bottombar = $('.bottombar');
    function measure() {
      document.documentElement.style.setProperty('--top-h', Math.ceil(topbar.getBoundingClientRect().height) + 'px');
      document.documentElement.style.setProperty('--bot-h', Math.ceil(bottombar.getBoundingClientRect().height) + 'px');
    }
    if ('ResizeObserver' in window) { const ro = new ResizeObserver(measure); ro.observe(topbar); ro.observe(bottombar); }
    window.addEventListener('resize', measure);
    measure();

    // Start: hide every stage, then show the one in the URL (or the briefing).
    els.forEach((el) => { el.hidden = true; });
    const startId = fromHash();
    if (startId) { ids.slice(0, ids.indexOf(startId)).forEach((id) => visited.add(id)); }
    goTo(startId || 'mission');

    return { goTo: goTo, update: update };
  })();

  G.Stage = Stage;
  G.bus.refresh = Stage.update;
  Stage.update();
})();
