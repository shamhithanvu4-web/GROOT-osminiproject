/* =========================================================
   G.R.O.O.T. — learn.js
   Stage 4 "Learn the Rules": a tiny guided buffer that teaches the
   full / empty rules in four gated steps. Exposes GROOT.Learn.
   ========================================================= */
(function () {
  'use strict';

  const G = window.GROOT;
  const $ = G.$, $$ = G.$$, announce = G.announce, popIn = G.popIn, ghostOut = G.ghostOut, shake = G.shake, bus = G.bus;

  /* =========================================================
     1. LEARN THE RULES — guided mini simulation
     Independent from the Control Room: a tiny circular buffer
     used to teach the full / empty rules one step at a time.
     The global Next button moves between its four steps.
     ========================================================= */
  const Learn = (function learnModule() {
    const CAP = 5;
    const STEPS = [
      { title: 'A Package Appears', gate: 'Create a package to unlock the next rule', prompt: 'Press <b>Create Package</b>. The Producer will drop its very first package into the empty buffer.', done: 'The Producer created a package. The buffer now has one item ready for the Consumer.' },
      { title: 'Send It Out', gate: 'Consume the package to continue', prompt: 'The Consumer just clocked in. Press <b>Consume Package</b> to take the earliest package.', done: 'The Consumer removed the package. One buffer slot is free again.' },
      { title: 'Too Much Production', gate: 'Fill all 5 slots, then try once more', prompt: 'Keep pressing <b>Create Package</b> until all five slots are full — then try one more time.', done: 'The buffer is full. The Producer must wait until the Consumer frees a slot.' },
      { title: 'Nothing to Consume', gate: 'Reset the buffer, then try to consume', prompt: 'Press <b>Reset Buffer</b> to start from an empty buffer, then press <b>Consume Package</b>.', done: 'The buffer is empty. The Consumer must wait until the Producer adds a package.' },
    ];
    const pills = $$('#learn-stepper .step-pill');
    const ui = {
      kicker: $('#learn-kicker'), title: $('#learn-title'), prompt: $('#learn-prompt'),
      create: $('#learn-create'), consume: $('#learn-consume'), reset: $('#learn-reset'),
      feedback: $('#learn-feedback'),
      slots: $$('#learn-slots .slot'), ptrs: $$('#learn-ptrs .ptr'),
      prod: $('#learn-prod'), cons: $('#learn-cons'),
      prodStatus: $('#learn-prod-status'), consStatus: $('#learn-cons-status'),
      empty: $('#learn-empty'), full: $('#learn-full'),
    };
    const done = [false, false, false, false];
    let step = 0;
    let buf = freshBuf();
    let fb = { html: 'Your move, Controller.', tone: 'idle' };

    function freshBuf() { return { slots: new Array(CAP).fill(null), inP: 0, outP: 0, count: 0, nextId: 1, prod: 'Ready', cons: 'Ready' }; }
    const allDone = () => done.every(Boolean);
    function setFb(html, tone) { fb = { html: html, tone: tone || 'info' }; }
    function complete(i, tone) {
      done[i] = true;
      setFb(STEPS[i].done + (i < 3 ? ' <br><b>Press Next for the next rule.</b>' : ' <br><b>All four rules learned — press Next.</b>'), tone || 'ok');
    }

    function create() {
      if (buf.count === CAP) {               // empty = 0 → production is blocked
        buf.prod = 'Waiting for space';
        G.emit('wait', { sem: 'empty', source: 'learn' });
        shake(ui.prod);
        if (step === 2 && !done[2]) complete(2, 'wait'); else setFb(STEPS[2].done, 'wait');
        render();
        return;
      }
      const slot = buf.inP;
      const id = buf.nextId++;
      buf.slots[slot] = id;
      buf.inP = (slot + 1) % CAP;
      buf.count++;
      G.emit('add', { source: 'learn' });
      buf.prod = 'Ready';
      let woke = false;
      if (buf.cons === 'Waiting for item') { buf.cons = 'Ready'; woke = true; }
      if (step === 0 && !done[0]) complete(0);
      else if (step === 2 && !done[2]) {
        if (buf.count < CAP) {
          setFb('Item #' + id + ' landed in slot ' + (slot + 1) + '. <code>empty = ' + (CAP - buf.count) + '</code>, <code>full = ' + buf.count + '</code>.' +
            (slot === 0 && id > 1 ? '<br>↺ Wrap-around! After slot 5 the Producer continues at slot 1 — a <b>circular</b> buffer.' : ''), 'info');
        } else {
          setFb('All five slots are full — <code>empty = 0</code>. Now try creating one more package…', 'info');
        }
      } else {
        setFb('Item #' + id + ' added to slot ' + (slot + 1) + '.' + (woke ? ' The waiting Consumer can continue.' : ''), 'info');
      }
      render();
      popIn(ui.slots[slot].querySelector('.pkg'));
    }

    function consume() {
      if (buf.count === 0) {                 // full = 0 → consumption is blocked
        buf.cons = 'Waiting for item';
        G.emit('wait', { sem: 'full', source: 'learn' });
        shake(ui.cons);
        if (step === 3 && !done[3]) complete(3, 'wait'); else setFb(STEPS[3].done, 'wait');
        render();
        return;
      }
      const slot = buf.outP;
      const id = buf.slots[slot];
      buf.slots[slot] = null;
      buf.outP = (slot + 1) % CAP;
      buf.count--;
      buf.cons = 'Ready';
      let woke = false;
      if (buf.prod === 'Waiting for space') { buf.prod = 'Ready'; woke = true; }
      if (step === 1 && !done[1]) complete(1);
      else if (step === 3 && !done[3]) setFb('Item #' + id + ' removed. ' + (buf.count ? 'Keep going — or reset to start empty.' : 'The buffer is empty now. Try consuming once more.'), 'info');
      else setFb('Item #' + id + ' removed from slot ' + (slot + 1) + '.' + (woke ? ' A slot is free, so the waiting Producer can continue.' : ''), 'info');
      render();
      ghostOut(ui.slots[slot], '#' + id);
    }

    function resetBuf() {
      buf = freshBuf();
      setFb(step === 3 && !done[3] ? 'Buffer emptied: <code>full = 0</code>. Now press <b>Consume Package</b>.' : 'Buffer reset. Every slot is empty again.', 'info');
      render();
    }

    function goTo(i) {
      if (i < 0 || i > 3) return;
      if (i > 0 && !done[i - 1]) return;     // steps unlock in order
      step = i;
      if (done[i]) setFb(STEPS[i].done, i >= 2 ? 'wait' : 'ok');
      else setFb('Your move, Controller.', 'idle');
      render();
    }

    function setBubble(el, text) {
      el.textContent = text;
      el.classList.toggle('is-wait', text.indexOf('Waiting') === 0);
    }

    function render() {
      const free = allDone();
      pills.forEach((p, i) => {
        const unlocked = i === 0 || done[i - 1];
        p.disabled = !unlocked;
        p.classList.toggle('is-current', i === step);
        p.classList.toggle('is-done', done[i]);
        if (i === step) p.setAttribute('aria-current', 'step'); else p.removeAttribute('aria-current');
        p.querySelector('.num').textContent = done[i] ? '✓' : String(i + 1);
      });
      ui.kicker.textContent = free ? 'All four rules unlocked · free play' : 'Step ' + (step + 1) + ' of 4';
      ui.title.textContent = STEPS[step].title;
      ui.prompt.innerHTML = free ? 'Every button is unlocked. Fill it, drain it, poke the edges — the rules always hold.' : STEPS[step].prompt;
      ui.create.disabled = !(free || (step === 0 && !done[0]) || (step === 2 && !done[2]));
      ui.consume.disabled = !(free || (step === 1 && !done[1]) || (step === 3 && !done[3]));
      ui.reset.disabled = !(free || step === 3);
      ui.feedback.innerHTML = fb.html;
      ui.feedback.dataset.tone = fb.tone;

      ui.slots.forEach((s, i) => {
        const id = buf.slots[i];
        s.classList.toggle('is-filled', id !== null);
        s.querySelector('.pkg-label').textContent = id !== null ? '#' + id : '';
        s.setAttribute('aria-label', 'Slot ' + (i + 1) + ': ' + (id !== null ? 'item #' + id : 'empty'));
      });
      ui.ptrs.forEach((p, i) => {
        let h = '';
        if (i === buf.inP) h += '<span class="ptr-in">IN</span>';
        if (i === buf.outP) h += '<span class="ptr-out">OUT</span>';
        p.innerHTML = h;
      });
      setBubble(ui.prodStatus, buf.prod);
      setBubble(ui.consStatus, buf.cons);
      ui.empty.textContent = 'empty = ' + (CAP - buf.count);
      ui.full.textContent = 'full = ' + buf.count;
      ui.empty.classList.toggle('is-zero', buf.count === CAP);
      ui.full.classList.toggle('is-zero', buf.count === 0);
      bus.refresh();
    }

    ui.create.addEventListener('click', create);
    ui.consume.addEventListener('click', consume);
    ui.reset.addEventListener('click', resetBuf);
    pills.forEach((p, i) => p.addEventListener('click', () => goTo(i)));
    render();

    // Public API used by the stage controller.
    return {
      get step() { return step; },
      isDone: (i) => done[i],
      title: (i) => STEPS[i].title,
      gate: (i) => STEPS[i].gate,
      goTo: goTo,
      focusFirstAction: () => { const b = [ui.create, ui.reset, ui.consume].find((x) => !x.disabled); if (b) b.focus(); },
    };
  })();

  G.Learn = Learn;
})();
