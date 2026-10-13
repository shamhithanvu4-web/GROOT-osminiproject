/* =========================================================
   G.R.O.O.T. — door.js
   Stage 5 "One Door, Two Workers": the scripted mutex story (unsafe
   lost-update vs. safe locking). Never touches the real simulation.
   Exposes GROOT.Door.
   ========================================================= */
(function () {
  'use strict';

  const G = window.GROOT;
  const $ = G.$, $$ = G.$$, announce = G.announce, popIn = G.popIn, ghostOut = G.ghostOut, shake = G.shake, bus = G.bus;

  /* =========================================================
     2. ONE DOOR, TWO WORKERS — scripted mutex lesson
     A self-contained story scene. It never touches the
     Control Room simulation.
     ========================================================= */
  const Door = (function doorModule() {
    const ui = {
      unsafe: $('#door-unsafe'), safe: $('#door-safe'), reset: $('#door-reset'), result: $('#door-result'),
      p: $('#ds-p'), c: $('#ds-c'), pStatus: $('#ds-p-status'), cStatus: $('#ds-c-status'),
      room: $('#ds-room'), door: $('#ds-door'), doorIcon: $('#ds-door-icon'), doorText: $('#ds-door-text'),
      slots: $$('#ds-slots span'), count: $('#ds-count'), actual: $('#ds-actual'), counter: $('#ds-counter'),
      trace: $('#ds-trace'), traceEmpty: $('#ds-trace-empty'),
    };
    const api = { tried: false };
    let timers = [];
    let scene = freshScene();

    function freshScene() {
      return { items: 2, counter: 2, pPos: 'out', cPos: 'out', pStatus: 'Ready', cStatus: 'Ready', pTone: '', cTone: '', door: 'idle', doorText: 'One door into the buffer', mismatch: false };
    }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }
    function bubble(el, text, tone) { el.textContent = text; el.className = 'status-bubble' + (tone ? ' is-' + tone : ''); }

    function render() {
      ui.p.dataset.pos = scene.pPos;
      ui.c.dataset.pos = scene.cPos;
      bubble(ui.pStatus, scene.pStatus, scene.pTone);
      bubble(ui.cStatus, scene.cStatus, scene.cTone);
      ui.door.dataset.state = scene.door;
      ui.doorText.textContent = scene.doorText;
      ui.doorIcon.setAttribute('href', scene.door === 'locked' ? '#i-lock' : '#i-unlock');
      ui.slots.forEach((s, i) => s.classList.toggle('is-filled', i < scene.items));
      ui.count.textContent = scene.counter;
      ui.actual.textContent = scene.items;
      ui.counter.classList.toggle('is-bad', scene.mismatch);
    }

    function trace(who, text, tone) {
      ui.traceEmpty.hidden = true;
      const li = document.createElement('li');
      li.className = 'trace-row' + (tone ? ' is-' + tone : '');
      const a = document.createElement('span');
      const b = document.createElement('span');
      if (who === 'p' || who === 'both') a.textContent = text;
      if (who === 'c' || who === 'both') b.textContent = text;
      li.append(a, b);
      ui.trace.appendChild(li);
      ui.trace.scrollTop = ui.trace.scrollHeight;
    }

    function play(seq) {
      clearTimers();
      const gap = G.motionReduced() ? 700 : 1000;
      seq.forEach((fn, i) => timers.push(setTimeout(() => { fn(); render(); }, i * gap)));
    }
    function setBusy(b) { ui.unsafe.disabled = b; ui.safe.disabled = b; }

    function resetScene() {
      clearTimers();
      scene = freshScene();
      ui.trace.innerHTML = '';
      ui.traceEmpty.hidden = false;
      ui.result.hidden = true;
      ui.result.innerHTML = '';
      ui.result.className = 'door-result';
      ui.room.classList.remove('is-clash');
      ui.door.classList.remove('is-locking');
      ui.unsafe.setAttribute('aria-pressed', 'false');
      ui.safe.setAttribute('aria-pressed', 'false');
      ui.reset.hidden = true;
      setBusy(false);
      render();
    }

    // Unsafe path: the classic "lost update" interleaving on a shared counter.
    function runUnsafe() {
      resetScene();
      setBusy(true);
      ui.unsafe.setAttribute('aria-pressed', 'true');
      let pReg = 0, cReg = 0;
      play([
        () => { scene.door = 'open'; scene.doorText = 'No lock — both walk in'; scene.pPos = 'in'; scene.cPos = 'in'; scene.pStatus = 'Inside'; scene.cStatus = 'Inside'; scene.pTone = 'danger'; scene.cTone = 'danger'; ui.room.classList.add('is-clash'); trace('both', 'enter buffer (no lock)', 'danger'); },
        () => { pReg = scene.counter; scene.pStatus = 'Read counter = 2'; trace('p', 'read counter → ' + pReg); },
        () => { cReg = scene.counter; scene.cStatus = 'Read counter = 2'; trace('c', 'read counter → ' + cReg); },
        () => { scene.items = 3; scene.pStatus = 'Added package'; trace('p', 'add package (buffer: 3)'); },
        () => { scene.items = 2; scene.cStatus = 'Removed package'; trace('c', 'remove package (buffer: 2)'); },
        () => { scene.counter = cReg - 1; scene.cStatus = 'Wrote counter = 1'; trace('c', 'write counter = ' + cReg + ' − 1 = ' + (cReg - 1)); },
        () => { scene.counter = pReg + 1; scene.pStatus = 'Wrote counter = 3'; scene.mismatch = true; trace('p', 'write counter = ' + pReg + ' + 1 = ' + (pReg + 1) + '  ← overwrites!', 'danger'); },
        () => { finish('unsafe'); },
      ]);
    }

    // Safe path: the mutex lets exactly one worker in at a time.
    function runSafe() {
      resetScene();
      setBusy(true);
      ui.safe.setAttribute('aria-pressed', 'true');
      let reg = 0;
      play([
        () => {
          scene.door = 'locked'; scene.doorText = 'Locked by Producer'; scene.pPos = 'in';
          scene.pStatus = 'Holds the mutex'; scene.pTone = 'ok'; scene.cStatus = 'Waiting for mutex'; scene.cTone = 'wait';
          ui.door.classList.remove('is-locking'); void ui.door.offsetWidth; ui.door.classList.add('is-locking');
          trace('p', 'wait(mutex) → acquired 🔒', 'ok'); trace('c', 'wait(mutex) → blocked', 'wait');
          ui.result.className = 'door-result is-safe';
          ui.result.innerHTML = '<p class="res-title">🔒 Mutex acquired: One worker may update the shared buffer.</p>';
          ui.result.hidden = false;
        },
        () => { reg = scene.counter; scene.pStatus = 'Read counter = 2'; trace('p', 'read counter → ' + reg); },
        () => { scene.items = 3; scene.pStatus = 'Added package'; trace('p', 'add package (buffer: 3)'); },
        () => { scene.counter = reg + 1; scene.pStatus = 'Wrote counter = 3'; trace('p', 'write counter = ' + (reg + 1)); },
        () => {
          scene.pPos = 'out'; scene.pStatus = 'Done'; scene.pTone = '';
          scene.doorText = 'Locked by Consumer'; scene.cPos = 'in'; scene.cStatus = 'Holds the mutex'; scene.cTone = 'ok';
          ui.door.classList.remove('is-locking'); void ui.door.offsetWidth; ui.door.classList.add('is-locking');
          trace('p', 'signal(mutex) → released'); trace('c', 'woken → acquired 🔒', 'ok');
        },
        () => { reg = scene.counter; scene.cStatus = 'Read counter = 3'; trace('c', 'read counter → ' + reg); },
        () => { scene.items = 2; scene.cStatus = 'Removed package'; trace('c', 'remove package (buffer: 2)'); },
        () => { scene.counter = reg - 1; scene.cStatus = 'Wrote counter = 2'; trace('c', 'write counter = ' + (reg - 1)); },
        () => { scene.cPos = 'out'; scene.cStatus = 'Done'; scene.cTone = ''; scene.door = 'idle'; scene.doorText = 'Unlocked'; trace('c', 'signal(mutex) → released'); finish('safe'); },
      ]);
    }

    function finish(kind) {
      setBusy(false);
      ui.reset.hidden = false;
      if (kind === 'unsafe') {
        ui.result.className = 'door-result is-danger';
        ui.result.innerHTML = '<p class="res-title">⚠ Race Condition Detected</p>' +
          '<p>The buffer counter says 3 items, but the displayed buffer contains 2.</p>' +
          '<p class="res-why">Both workers changed shared data without mutual exclusion. This can cause inconsistent data.</p>';
      } else {
        ui.result.innerHTML += '<p class="res-why">A mutex protects the critical section. Only one process can modify the buffer at a time.</p>' +
          '<p class="res-check">✓ Final check: counter 2 · buffer 2 — consistent.</p>';
      }
      ui.result.hidden = false;
      api.tried = true;          // opens the gate on this stage
      G.emit(kind === 'unsafe' ? 'race' : 'restore', { source: 'door' });
      bus.refresh();
    }

    ui.unsafe.addEventListener('click', runUnsafe);
    ui.safe.addEventListener('click', runSafe);
    ui.reset.addEventListener('click', () => { resetScene(); ui.unsafe.focus(); });
    render();
    return api;
  })();

  G.Door = Door;
})();
