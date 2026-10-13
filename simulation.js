/* =========================================================
   G.R.O.O.T. — simulation.js
   Stages 7–9: the Producer–Consumer engine (semaphores, mutex, virtual
   clock, auto / manual / step modes), the scripted unsafe experiment,
   the Control Room UI, scenarios, live results, badges and the win modal.
   ========================================================= */
(function () {
  'use strict';

  const G = window.GROOT;
  const $ = G.$, $$ = G.$$, announce = G.announce, popIn = G.popIn, ghostOut = G.ghostOut, shake = G.shake, bus = G.bus;

  /* =========================================================
     3. CONTROL ROOM — Producer–Consumer simulation engine
     ---------------------------------------------------------
     One Producer, one Consumer, a circular bounded buffer of
     5 slots and three synchronization variables:
       empty – counting semaphore: free slots   (starts at 5)
       full  – counting semaphore: ready items  (starts at 0)
       mutex – binary lock around the buffer    (starts unlocked)

     Each worker runs its textbook program one instruction
     (one "event") at a time. A worker that calls wait() on a
     semaphore whose value is 0 is BLOCKED (asleep) until the
     matching signal() wakes it up — then it retries.

     Time is a virtual clock (ms). Every worker has `nextAt`,
     the virtual time of its next instruction. Auto/manual mode
     plays events in real time with ONE setTimeout; Step mode
     jumps straight to the next event. The simulation keeps
     running while you visit other stages.
     ========================================================= */
  const CAPACITY = 5;
  const GOAL = 15;
  const ROLES = ['producer', 'consumer'];
  const NAME = { producer: 'Producer', consumer: 'Consumer' };
  const SPEED_KEYS = ['slow', 'medium', 'fast'];
  const SPEED_LABEL = { slow: 'Slow', medium: 'Medium', fast: 'Fast' };
  // work = time spent OUTSIDE the critical section (creating / processing an item)
  // sync = time for each synchronization step (wait, signal, buffer update)
  const SPEED_MS = {
    slow:   { work: 1800, sync: 380 },
    medium: { work: 1000, sync: 260 },
    fast:   { work: 450,  sync: 150 },
  };
  // The two programs, instruction by instruction (index = program counter).
  const PROGRAMS = {
    producer: ['CREATE', 'WAIT_EMPTY', 'WAIT_MUTEX', 'ADD', 'SIGNAL_MUTEX', 'SIGNAL_FULL'],
    consumer: ['WAIT_FULL', 'WAIT_MUTEX', 'REMOVE', 'SIGNAL_MUTEX', 'SIGNAL_EMPTY', 'CONSUME'],
  };
  const WORK_PC = { producer: 0, consumer: 5 };

  /* ---------- Simulation state ---------- */
  function makeWorker(role) {
    // pc: -1 = idle (Ready), 0..5 = instruction it will execute next
    // blocked: null | 'empty' | 'full' | 'mutex'  (which semaphore it sleeps on)
    // primed: the cycle was started automatically (auto / step) and no work has happened yet
    return { role: role, pc: -1, blocked: null, item: null, nextAt: 0, orders: 0, primed: false };
  }
  function freshState() {
    return {
      buffer: new Array(CAPACITY).fill(null), // the 5 shared slots (item numbers or null)
      inPtr: 0,                                // next slot the Producer fills
      outPtr: 0,                               // oldest item, next slot the Consumer empties
      empty: CAPACITY,                         // semaphore: free slots
      full: 0,                                 // semaphore: items ready
      mutex: null,                             // null = unlocked, else 'producer' | 'consumer'
      nextItemId: 1,
      time: 0,                                 // virtual clock in ms
      producer: makeWorker('producer'),
      consumer: makeWorker('consumer'),
      stats: { produced: 0, consumed: 0, syncActions: 0, spaceWaits: 0, itemWaits: 0, pMutexWaits: 0, cMutexWaits: 0, raceConditions: 0 },
      won: false,
      invariantBroken: false,
    };
  }

  let S = freshState();
  let speeds = { producer: 'medium', consumer: 'medium' };
  let autoOn = false;        // Auto mode: workers loop forever
  let stepMode = false;      // Step mode: one event per click (also loops)
  let timerId = null;        // the single real-time timer driving events
  let runGen = 0;            // invalidates stale timer callbacks
  let clockRunning = false;  // is virtual time following real time right now?
  let lastReal = 0;
  let unsafe = false;        // scripted race-condition experiment active?
  let race = null;           // staged state used ONLY by the race demo
  let raceTimers = [];
  let activeScenario = null;
  let pendingAnims = [];
  let logCount = 0;
  const badges = new Set();

  /* ---------- Clock & timer helpers ---------- */
  function clearRunTimer() {
    if (timerId !== null) { clearTimeout(timerId); timerId = null; }
    runGen++;
  }
  // Advance virtual time by the real time that passed while running.
  function syncClock() {
    const now = performance.now();
    if (clockRunning) S.time += now - lastReal;
    lastReal = now;
  }
  const continuous = () => autoOn || stepMode;

  function durationFor(w) {
    const sp = SPEED_MS[speeds[w.role]];
    if (w.pc === WORK_PC[w.role]) return Math.round(sp.work * (0.85 + Math.random() * 0.3)); // ±15% jitter
    return sp.sync;
  }
  function schedule(w) { w.nextAt = S.time + durationFor(w); }
  function startCycle(w, primed) { w.pc = 0; w.blocked = null; w.primed = !!primed; schedule(w); }
  function finishCycle(w) {
    if (continuous()) startCycle(w, true);                  // loop forever in auto / step mode
    else if (w.orders > 0) { w.orders--; startCycle(w); }   // queued manual orders
    else { w.pc = -1; w.blocked = null; }                   // back to Ready
  }
  function advance(w) {
    w.primed = false;
    w.pc++;
    if (w.pc >= PROGRAMS[w.role].length) finishCycle(w); else schedule(w);
  }
  const runnable = (w) => w.pc >= 0 && !w.blocked;
  function pickNext() {
    const cands = ROLES.map((r) => S[r]).filter(runnable);
    if (!cands.length) return null;
    return cands.reduce((a, b) => (a.nextAt <= b.nextAt ? a : b));
  }

  /* ---------- Semaphore wait / signal helpers ---------- */
  // wait() found the semaphore at 0 → the worker sleeps (one wait event).
  function block(w, sem) {
    if (w.blocked === sem) return;
    w.blocked = sem;
    G.emit('wait', { sem: sem, role: w.role });
    if (sem === 'empty') {
      S.stats.spaceWaits++;
      log('Producer is waiting: buffer is full.', 'wait');
      coach('Buffer full: <code>empty = 0</code>. <code>wait(empty)</code> puts the Producer to sleep until the Consumer frees a slot.');
      announce('Producer is waiting: the buffer is full.');
    } else if (sem === 'full') {
      S.stats.itemWaits++;
      log('Consumer is waiting: buffer is empty.', 'wait');
      coach('Buffer empty: <code>full = 0</code>. <code>wait(full)</code> puts the Consumer to sleep until the Producer adds a package.');
      announce('Consumer is waiting: the buffer is empty.');
    } else {
      if (w.role === 'producer') S.stats.pMutexWaits++; else S.stats.cMutexWaits++;
      const holder = NAME[S.mutex] || 'the other worker';
      log(NAME[w.role] + ' is waiting for the mutex (held by ' + holder + ').', 'wait');
      coach(w.role === 'producer'
        ? 'There is space, but the Consumer is inside the critical section. The Producer queues at the door: <b>Waiting for mutex</b>.'
        : 'There is an item, but the Producer is inside the critical section. The Consumer queues at the door: <b>Waiting for mutex</b>.');
      announce(NAME[w.role] + ' is waiting for the mutex.');
    }
  }
  // signal() woke a sleeping worker → it retries its wait() next.
  function wake(w) {
    const sem = w.blocked;
    w.blocked = null;
    schedule(w);
    log(NAME[w.role] + ' woke up — retrying wait(' + sem + ').', 'system');
    coach('<code>signal(' + sem + ')</code> woke the sleeping ' + NAME[w.role] + '. No busy-waiting: it slept until there was a reason to continue.');
  }

  /* ---------- Execute one instruction (one event) ---------- */
  function execute(w) {
    const op = PROGRAMS[w.role][w.pc];
    const explain = !autoOn; // in manual / step mode the coach explains every event
    const other = w.role === 'producer' ? S.consumer : S.producer;

    switch (op) {
      case 'CREATE': {        // produce(item) — outside the critical section
        w.item = S.nextItemId++;
        S.stats.produced++;
        log('Producer created Item #' + w.item + '.', 'producer');
        if (explain || S.stats.produced === 1) coach('Item #' + w.item + ' was made <b>outside</b> the critical section — private work needs no lock.');
        advance(w);
        break;
      }
      case 'WAIT_EMPTY': {    // wait(empty)
        if (S.empty > 0) {
          S.empty--;
          S.stats.syncActions++;
          log('wait(empty) passed — slot ' + (S.inPtr + 1) + ' reserved, empty = ' + S.empty + '.', 'producer');
          if (explain) coach('<code>wait(empty)</code> passed, so a free slot is reserved (striped) and <code>empty</code> dropped to ' + S.empty + '.');
          advance(w);
        } else block(w, 'empty');
        break;
      }
      case 'WAIT_FULL': {     // wait(full)
        if (S.full > 0) {
          S.full--;
          S.stats.syncActions++;
          log('wait(full) passed — Item #' + S.buffer[S.outPtr] + ' claimed, full = ' + S.full + '.', 'consumer');
          if (explain) coach('<code>wait(full)</code> passed, so the oldest item is claimed (ringed) and <code>full</code> dropped to ' + S.full + '.');
          advance(w);
        } else block(w, 'full');
        break;
      }
      case 'WAIT_MUTEX': {    // wait(mutex) — enter the critical section
        if (S.mutex === null) {
          S.mutex = w.role;
          S.stats.syncActions++;
          log(NAME[w.role] + ' acquired mutex.', w.role);
          if (explain) coach('🔒 Mutex acquired. The ' + NAME[w.role] + ' is now alone inside the critical section.');
          advance(w);
        } else block(w, 'mutex');
        break;
      }
      case 'ADD': {           // critical section: put the item at IN
        const slot = S.inPtr;
        S.buffer[slot] = w.item;
        S.inPtr = (slot + 1) % CAPACITY;
        pendingAnims.push({ type: 'add', slot: slot });
        G.emit('add', { source: 'control' });
        log('Item #' + w.item + ' added to slot ' + (slot + 1) + '.', 'producer');
        if (explain) coach('Item #' + w.item + ' placed in slot ' + (slot + 1) + '. The <b>IN</b> pointer moves on — and wraps around after slot 5.');
        w.item = null;
        advance(w);
        break;
      }
      case 'REMOVE': {        // critical section: take the item at OUT
        const slot = S.outPtr;
        const item = S.buffer[slot];
        S.buffer[slot] = null;
        S.outPtr = (slot + 1) % CAPACITY;
        w.item = item;
        pendingAnims.push({ type: 'remove', slot: slot, label: '#' + item });
        log('Consumer removed Item #' + item + ' from slot ' + (slot + 1) + '.', 'consumer');
        if (explain) coach('Item #' + item + ' taken from slot ' + (slot + 1) + '. <b>OUT</b> always points at the oldest package: first in, first out.');
        advance(w);
        break;
      }
      case 'SIGNAL_MUTEX': {  // signal(mutex) — leave the critical section
        S.mutex = null;
        S.stats.syncActions++;
        log(NAME[w.role] + ' released mutex.', w.role);
        if (explain) coach('Mutex released — the door is open for the next worker.');
        advance(w);
        if (other.blocked === 'mutex') wake(other);
        break;
      }
      case 'SIGNAL_FULL': {   // signal(full)
        S.full++;
        S.stats.syncActions++;
        log('Full semaphore increased to ' + S.full + '.', 'producer');
        if (explain) coach('<code>signal(full)</code>: <code>full</code> rose to ' + S.full + '. The Consumer now knows an item is ready.');
        advance(w);
        if (S.consumer.blocked === 'full') wake(S.consumer);
        break;
      }
      case 'SIGNAL_EMPTY': {  // signal(empty)
        S.empty++;
        S.stats.syncActions++;
        log('Empty semaphore increased to ' + S.empty + '.', 'consumer');
        if (explain) coach('<code>signal(empty)</code>: <code>empty</code> rose to ' + S.empty + '. A sleeping Producer may now continue.');
        advance(w);
        if (S.producer.blocked === 'empty') wake(S.producer);
        break;
      }
      case 'CONSUME': {       // consume(item) — outside the critical section
        const item = w.item;
        w.item = null;
        S.stats.consumed++;
        log('Consumer processed Item #' + item + '. (' + S.stats.consumed + '/' + GOAL + ')', 'consumer');
        if (explain) coach('Item #' + item + ' processed <b>outside</b> the critical section. Shift progress: ' + S.stats.consumed + '/' + GOAL + '.');
        advance(w);
        checkWin();
        break;
      }
    }
    verifyIntegrity();
    updateBadges();
  }

  /* ---------- Integrity: the safety invariants ----------
     In safe mode these must ALWAYS hold:
       1) empty + full + inTransit === 5
          (inTransit = workers between their wait() and matching signal();
           when nobody is mid-operation this is exactly empty + full === 5)
       2) items in the buffer match what the semaphores promise
       3) the mutex holder is the worker inside the critical section       */
  function integrityReport() {
    const P = S.producer, C = S.consumer;
    const pTransit = (P.pc >= 2 && P.pc <= 5) ? 1 : 0; // passed wait(empty), not yet signal(full)
    const cTransit = (C.pc >= 1 && C.pc <= 4) ? 1 : 0; // passed wait(full), not yet signal(empty)
    const transit = pTransit + cTransit;
    const items = S.buffer.reduce((n, x) => n + (x !== null ? 1 : 0), 0);
    const expectedItems = S.full + ((P.pc === 4 || P.pc === 5) ? 1 : 0) + ((C.pc === 1 || C.pc === 2) ? 1 : 0);
    const pInside = P.pc === 3 || P.pc === 4;
    const cInside = C.pc === 2 || C.pc === 3;
    const holderOk = S.mutex === null ? (!pInside && !cInside)
      : S.mutex === 'producer' ? (pInside && !cInside) : (cInside && !pInside);
    const rangeOk = S.empty >= 0 && S.full >= 0 && S.empty <= CAPACITY && S.full <= CAPACITY;
    const sumOk = S.empty + S.full + transit === CAPACITY;
    const itemsOk = items === expectedItems;
    return { transit: transit, items: items, expectedItems: expectedItems, sumOk: sumOk, itemsOk: itemsOk, holderOk: holderOk, ok: sumOk && itemsOk && holderOk && rangeOk };
  }
  function verifyIntegrity() {
    const r = integrityReport();
    if (!r.ok && !S.invariantBroken) {
      S.invariantBroken = true;
      console.warn('[G.R.O.O.T.] Invariant violated', { empty: S.empty, full: S.full, inTransit: r.transit, items: r.items, expected: r.expectedItems });
      log('⚠ Dev check: invariant violated (empty ' + S.empty + ' + full ' + S.full + ' + in-transit ' + r.transit + ').', 'danger');
    }
    return r;
  }
  function integrityInfo(rep) {
    if (unsafe && race) {
      const actual = race.buffer.filter(Boolean).length;
      const diff = Math.abs(race.counter - actual);
      return { pct: Math.max(0, 100 - 20 * diff), warn: diff > 0 || race.mismatch, note: race.mismatch ? 'Temporary warning — demo only' : 'Unprotected access in progress' };
    }
    if (rep.ok) return { pct: 100, warn: false, note: rep.transit ? 'Balanced · ' + rep.transit + (rep.transit > 1 ? ' slots' : ' slot') + ' in transit' : 'empty + full = 5' };
    const diff = Math.abs(S.empty + S.full + rep.transit - CAPACITY) + Math.abs(rep.items - rep.expectedItems);
    return { pct: Math.max(0, 100 - 20 * Math.max(1, diff)), warn: true, note: 'Dev check failed' };
  }

  /* ---------- Real-time runner (auto + manual) ---------- */
  function runLoop() {
    syncClock();
    clearRunTimer();
    if (unsafe || S.won || (stepMode && !autoOn)) { clockRunning = false; render(); return; }
    const w = pickNext();
    if (!w) { clockRunning = false; render(); return; } // nothing runnable (idle or everyone waiting)
    const delay = Math.max(0, w.nextAt - S.time);
    const gen = runGen;
    clockRunning = true;
    lastReal = performance.now();
    timerId = setTimeout(() => {
      if (gen !== runGen) return;            // a reset / pause happened meanwhile
      timerId = null;
      S.time = Math.max(S.time, w.nextAt);
      lastReal = performance.now();
      execute(w);
      runLoop();
    }, delay);
    render();
  }

  /* ---------- Player actions ---------- */
  function manual(role) {
    if (autoOn || unsafe || S.won) return;
    syncClock();
    stepMode = false;
    // Workers only "scheduled" by auto/step that haven't started work are put back to Ready.
    ROLES.forEach((r) => { const x = S[r]; if (x.primed && x.pc === 0 && !x.blocked) { x.pc = -1; x.primed = false; } });
    const w = S[role];
    if (w.pc < 0) {
      startCycle(w);
      log((role === 'producer' ? 'Order: produce one item.' : 'Order: consume one item.'), 'system');
    } else {
      w.orders = Math.min(w.orders + 1, 9);
      log(NAME[role] + ' is busy — order queued (' + w.orders + ' waiting).', 'system');
    }
    runLoop();
  }

  function startAuto() {
    if (unsafe || S.won || autoOn) return;
    syncClock();
    stepMode = false;
    autoOn = true;
    S.producer.orders = 0;
    S.consumer.orders = 0;
    ROLES.forEach((r) => { if (S[r].pc < 0) startCycle(S[r], true); });
    log('Auto mode started — Producer ' + SPEED_LABEL[speeds.producer] + ', Consumer ' + SPEED_LABEL[speeds.consumer] + '.', 'system');
    coach('Auto mode is running. I’ll pop in when something important happens: a wait, a wake-up, or a queue at the mutex.');
    announce('Auto mode started.');
    runLoop();
  }

  function pause(silent) {
    const wasRunning = autoOn || timerId !== null;
    syncClock();
    autoOn = false;
    clearRunTimer();
    clockRunning = false;
    if (wasRunning && !silent) { log('Simulation paused.', 'system'); announce('Simulation paused.'); }
    render();
  }

  function stepOnce() {
    if (unsafe || S.won) return;
    if (autoOn || timerId !== null) pause(true);
    syncClock();
    clockRunning = false;
    if (!stepMode) { stepMode = true; log('Step mode: each click runs exactly one event.', 'system'); }
    ROLES.forEach((r) => { if (S[r].pc < 0) startCycle(S[r], true); });
    const w = pickNext();
    if (!w) { log('Both workers are waiting — nothing can run.', 'danger'); render(); return; }
    S.time = Math.max(S.time, w.nextAt);
    execute(w);
    render();
  }

  function resetSim(opts) {
    opts = opts || {};
    clearRunTimer();
    clearRaceTimers();
    autoOn = false;
    stepMode = false;
    unsafe = false;
    race = null;
    clockRunning = false;
    S = freshState();
    pendingAnims = [];
    closeWin();
    if (!opts.keepScenario) activeScenario = null;
    R.log.innerHTML = '';
    logCount = 0;
    log('Simulation reset: empty = 5, full = 0, mutex unlocked.', 'system');
    coach(COACH_IDLE);
    render();
    renderScenarios();
  }

  function checkWin() {
    if (S.won || unsafe || S.stats.consumed < GOAL) return;
    S.won = true;
    autoOn = false;
    stepMode = false;
    clearRunTimer();
    clockRunning = false;
    badges.add('shift');
    G.emit('win');
    log('Shift complete! 15 packages processed with the buffer protected.', 'success');
    coach('🏆 <b>Shift complete.</b> Fifteen packages, zero synchronization failures. Press <b>Reset Simulation</b> to run another shift.');
    announce('Shift complete! You processed 15 packages while protecting the shared buffer.');
    const ref = S;
    setTimeout(() => { if (S === ref && S.won) openWin(); }, G.motionReduced() ? 0 : 450);
  }

  function setSpeed(role, key, programmatic) {
    speeds[role] = key;
    const ref = role === 'producer' ? R.p : R.c;
    ref.speed.value = String(SPEED_KEYS.indexOf(key));
    ref.speed.setAttribute('aria-valuetext', SPEED_LABEL[key]);
    ref.speedOut.textContent = SPEED_LABEL[key];
    if (programmatic) return;
    log(NAME[role] + ' speed set to ' + SPEED_LABEL[key] + '.', 'system');
    if (activeScenario && activeScenario !== 'unsafe') { activeScenario = null; renderScenarios(); }
    // Apply the new speed to the instruction the worker is waiting to run.
    syncClock();
    const w = S[role];
    if (w.pc >= 0 && !w.blocked) schedule(w);
    if (timerId !== null) runLoop(); else render();
  }

  /* ---------- Unsafe experiment: scripted race condition ----------
     The real simulation state S is frozen and never modified.
     The demo plays on its own staged copy (`race`), so turning
     the mutex back on restores the shift exactly as it was.     */
  function clearRaceTimers() { raceTimers.forEach(clearTimeout); raceTimers = []; }

  function enableExperiment() {
    if (unsafe) return;
    syncClock();
    autoOn = false;
    stepMode = false;
    clearRunTimer();
    clockRunning = false;
    unsafe = true;
    log('Race-condition demonstration activated.', 'danger', 'demo');
    announce('Unsafe experiment enabled. The mutex is disabled for a scripted race-condition demo.');
    runRaceScript();
  }

  function runRaceScript() {
    clearRaceTimers();
    race = { buffer: ['D1', 'D2', null, null, null], counter: 2, pReg: 0, cReg: 0, p: 'Entering buffer', c: 'Entering buffer', mismatch: false };
    log('Staged demo: 2 items in the buffer, shared counter = 2.', 'system', 'demo');
    coach('The mutex is <b>disabled</b>. Both workers can walk straight into the critical section. Watch the shared <b>item counter</b>…');
    const steps = [
      () => { race.p = 'Inside (no lock)'; race.c = 'Inside (no lock)'; log('⚠ No lock: Producer and Consumer entered the critical section together.', 'danger', 'demo'); },
      () => { race.pReg = race.counter; race.p = 'Read counter = 2'; log('Producer read counter = 2.', 'producer', 'demo'); },
      () => { race.cReg = race.counter; race.c = 'Read counter = 2'; log('Consumer read counter = 2.', 'consumer', 'demo'); },
      () => { race.buffer[2] = 'D3'; pendingAnims.push({ type: 'add', slot: 2 }); race.p = 'Added D3'; log('Producer added Item D3 to slot 3.', 'producer', 'demo'); },
      () => { race.buffer[0] = null; pendingAnims.push({ type: 'remove', slot: 0, label: 'D1' }); race.c = 'Removed D1'; log('Consumer removed Item D1 from slot 1.', 'consumer', 'demo'); },
      () => { race.counter = race.cReg - 1; race.c = 'Wrote counter = 1'; log('Consumer wrote counter = 2 − 1 = 1.', 'consumer', 'demo'); },
      () => { race.counter = race.pReg + 1; race.p = 'Wrote counter = 3'; log('Producer wrote counter = 2 + 1 = 3 — the Consumer’s update is lost.', 'danger', 'demo'); },
      () => {
        race.mismatch = true;
        S.stats.raceConditions++;
        G.emit('race', { source: 'control' });
        updateBadges();
        log('⚠ Race Condition Detected: the counter says 3 items, the buffer contains 2.', 'danger', 'demo');
        coach('Both workers changed shared data without mutual exclusion. This can cause inconsistent data. Press <b>Restore mutex</b> to return to safe mode.');
        announce('Race condition detected. The buffer counter says 3 items, but the displayed buffer contains 2.');
      },
    ];
    const gap = G.motionReduced() ? 800 : 1100;
    steps.forEach((fn, i) => raceTimers.push(setTimeout(() => { if (!unsafe) return; fn(); render(); }, gap * (i + 1))));
    render();
  }

  function disableExperiment() {
    if (!unsafe) return;
    clearRaceTimers();
    unsafe = false;
    race = null;
    const r = verifyIntegrity();
    if (r.ok) log('Mutex restored. Buffer integrity verified.', 'success');
    else log('Mutex restored — ⚠ integrity check failed.', 'danger');
    coach('Safe mode is back. The race happened on a staged copy, so the real shift was never touched — integrity is 100%. Press <b>Start Auto Mode</b> to continue.');
    announce('Mutex restored. Buffer integrity verified.');
    G.emit('restore', { source: 'control' });
    render();
    renderScenarios();
  }

  /* =========================================================
     4. CONTROL ROOM — UI rendering
     ========================================================= */
  const R = {
    room: $('#room'), mission: $('#mission-text'), scenarioChip: $('#scenario-chip'),
    sbConsumed: $('#sb-consumed'), sbBar: $('#sb-bar'), sbProgress: $('#sb-progress'),
    sbIntegrityCell: $('#sb-integrity-cell'), sbIntegrity: $('#sb-integrity'), sbIntegrityNote: $('#sb-integrity-note'),
    sbRun: $('#sb-run'), sbMode: $('#sb-mode'), banner: $('#unsafe-banner'),
    slots: $$('#slots .slot'), ptrs: $$('#pointers .ptr'),
    doorStrip: $('#door-strip'), doorIcon: $('#door-icon'), mutexText: $('#mutex-text'),
    raceAlert: $('#race-alert'),
    valuesSafe: $('#values-safe'), valuesUnsafe: $('#values-unsafe'),
    vOccupied: $('#v-occupied'), vEmpty: $('#v-empty'), vFull: $('#v-full'), vEmptyBox: $('#v-empty-box'), vFullBox: $('#v-full-box'),
    vTransit: $('#v-transit'),
    vuActual: $('#vu-actual'), vuCounter: $('#vu-counter'), vuCounterBox: $('#vu-counter-box'),
    invariant: $('#invariant'), invEq: $('#inv-eq'), invOk: $('#inv-ok'), devcheck: $('#devcheck'),
    p: { panel: $('#panel-producer'), pill: $('#p-status'), holding: $('#p-holding'), orders: $('#p-orders'), count: $('#p-produced'), waits: $('#p-waits'), speed: $('#p-speed'), speedOut: $('#p-speed-out') },
    c: { panel: $('#panel-consumer'), pill: $('#c-status'), holding: $('#c-holding'), orders: $('#c-orders'), count: $('#c-consumed'), waits: $('#c-waits'), speed: $('#c-speed'), speedOut: $('#c-speed-out') },
    btn: {
      produce: $('#btn-produce'), consume: $('#btn-consume'), auto: $('#btn-auto'), pause: $('#btn-pause'), step: $('#btn-step'),
      reset: $('#btn-reset'), log: $('#btn-log'), experiment: $('#btn-experiment'), replay: $('#btn-replay-race'), restore: $('#btn-restore'),
    },
    logPanel: $('#log-panel'), log: $('#log'), logCount: $('#log-count'), lower: $('#lower'), coach: $('#coach-text'),
    programs: { producer: $$('[data-program="producer"]'), consumer: $$('[data-program="consumer"]') },
    res: {
      ring: $('#r-ring'), ringNum: $('#r-ring-num'), status: $('#r-status'),
      integrityBox: $('#r-integrity-box'), integrity: $('#r-integrity'), integrityNote: $('#r-integrity-note'),
      produced: $('#r-produced'), consumed: $('#r-consumed'), sync: $('#r-sync'),
      pwaits: $('#r-pwaits'), pwaitsD: $('#r-pwaits-d'), pwaitsBox: $('#r-pwaits-box'),
      cwaits: $('#r-cwaits'), cwaitsD: $('#r-cwaits-d'), cwaitsBox: $('#r-cwaits-box'),
      race: $('#r-race'), raceBox: $('#r-race-box'),
    },
    badgeEls: $$('#badges .badge'),
  };
  const RING_C = 2 * Math.PI * 66;
  const COACH_IDLE = 'Ready when you are. <b>Produce One Item</b> walks through one full operation, <b>Step One Event</b> goes instruction by instruction, and <b>Start Auto Mode</b> runs the whole shift.';
  const DEFAULT_MISSION = 'Process 15 packages without causing a synchronization failure.';

  /* ---------- Event log (newest first) ---------- */
  function log(msg, tone, timeLabel) {
    logCount++;
    const li = document.createElement('li');
    li.dataset.tone = tone || 'system';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = timeLabel === 'demo' ? 'demo' : (S.time / 1000).toFixed(1) + 's';
    const d = document.createElement('span');
    d.className = 'd';
    d.setAttribute('aria-hidden', 'true');
    const m = document.createElement('span');
    m.textContent = msg;
    li.append(t, d, m);
    R.log.prepend(li);
    while (R.log.children.length > 120) R.log.lastElementChild.remove();
    R.logCount.textContent = String(logCount);
    if (stepMode && !autoOn) announce(msg); // in step mode every event is announced
  }
  function coach(html) {
    R.coach.innerHTML = html;
    R.coach.classList.remove('is-fresh');
    void R.coach.offsetWidth;
    R.coach.classList.add('is-fresh');
  }

  /* ---------- Worker status labels ---------- */
  const P_STATUS = [
    () => ({ t: 'Creating item', tone: 'work' }),
    (b) => (b ? { t: 'Waiting for space', tone: 'wait' } : { t: 'Requesting a slot', tone: 'work' }),
    (b) => (b ? { t: 'Waiting for mutex', tone: 'wait' } : { t: 'Requesting mutex', tone: 'work' }),
    () => ({ t: 'Adding item', tone: 'critical' }),
    () => ({ t: 'Releasing mutex', tone: 'critical' }),
    () => ({ t: 'Signalling full', tone: 'work' }),
  ];
  const C_STATUS = [
    (b) => (b ? { t: 'Waiting for item', tone: 'wait' } : { t: 'Requesting an item', tone: 'work' }),
    (b) => (b ? { t: 'Waiting for mutex', tone: 'wait' } : { t: 'Requesting mutex', tone: 'work' }),
    () => ({ t: 'Removing item', tone: 'critical' }),
    () => ({ t: 'Releasing mutex', tone: 'critical' }),
    () => ({ t: 'Signalling empty', tone: 'work' }),
    () => ({ t: 'Processing item', tone: 'work' }),
  ];
  function statusOf(w) {
    if (unsafe && race) return { t: w.role === 'producer' ? race.p : race.c, tone: 'danger' };
    if (w.pc < 0) return { t: 'Ready', tone: 'idle' };
    return (w.role === 'producer' ? P_STATUS : C_STATUS)[w.pc](!!w.blocked);
  }

  function runStateText() {
    if (S.won) return 'Shift complete';
    if (unsafe) return 'Unsafe demo';
    if (autoOn) return 'Auto running';
    if (timerId !== null) return 'Working…';
    if (stepMode) return 'Step mode';
    const anyBlocked = ROLES.some((r) => S[r].blocked);
    const busy = ROLES.some((r) => S[r].pc >= 0);
    if (anyBlocked && !ROLES.some((r) => runnable(S[r]))) return 'Waiting';
    return busy ? 'Paused' : 'Idle';
  }

  function render() {
    const P = S.producer, C = S.consumer;
    const rep = integrityReport();
    const integ = integrityInfo(rep);
    R.room.classList.toggle('is-unsafe', unsafe);
    R.banner.hidden = !unsafe;

    // --- Buffer slots (real state, or the staged race copy in unsafe mode)
    for (let i = 0; i < CAPACITY; i++) {
      const el = R.slots[i];
      let label = null, state = 'empty', note = '';
      if (unsafe && race) {
        label = race.buffer[i];
        state = label ? 'filled' : 'empty';
      } else {
        const item = S.buffer[i];
        if (item !== null) {
          label = '#' + item;
          state = 'filled';
          if ((C.pc === 1 || C.pc === 2) && i === S.outPtr) { state = 'claimed'; note = 'claimed'; }
        } else if ((P.pc === 2 || P.pc === 3) && i === S.inPtr) {
          state = 'reserved'; note = 'reserved';
        } else if ((C.pc === 3 || C.pc === 4) && i === (S.outPtr + CAPACITY - 1) % CAPACITY) {
          state = 'freeing'; note = 'freeing';
        }
      }
      el.className = 'slot is-' + state;
      el.querySelector('.pkg-label').textContent = label || '';
      el.querySelector('.slot-note').textContent = note;
      el.setAttribute('aria-label', 'Slot ' + (i + 1) + ': ' + (label ? 'item ' + label : 'empty') + (note ? ' (' + note + ')' : ''));
    }
    pendingAnims.forEach((a) => {
      const el = R.slots[a.slot];
      if (a.type === 'add') popIn(el.querySelector('.pkg'));
      else ghostOut(el, a.label);
    });
    pendingAnims = [];

    // --- IN / OUT pointers
    R.ptrs.forEach((el, i) => {
      if (unsafe) { el.innerHTML = ''; return; }
      let h = '';
      if (i === S.inPtr) h += '<span class="ptr-in">IN</span>';
      if (i === S.outPtr) h += '<span class="ptr-out">OUT</span>';
      el.innerHTML = h;
    });

    // --- Mutex door
    let mState = 'open', mText = 'Mutex: Unlocked';
    if (unsafe) { mState = 'disabled'; mText = 'Mutex: DISABLED (unsafe demo)'; }
    else if (S.mutex) { mState = S.mutex; mText = 'Mutex: Locked by ' + NAME[S.mutex]; }
    R.doorStrip.dataset.state = mState;
    R.doorIcon.setAttribute('href', mState === 'producer' || mState === 'consumer' ? '#i-lock' : '#i-unlock');
    R.mutexText.textContent = mText;

    // --- Visible values
    R.valuesSafe.hidden = unsafe;
    R.valuesUnsafe.hidden = !unsafe;
    R.raceAlert.hidden = !(unsafe && race && race.mismatch);
    if (!unsafe) {
      R.vOccupied.textContent = rep.items + '/5';
      R.vEmpty.textContent = String(S.empty);
      R.vFull.textContent = String(S.full);
      R.vTransit.textContent = String(rep.transit);
      R.vEmptyBox.classList.toggle('is-zero', S.empty === 0);
      R.vFullBox.classList.toggle('is-zero', S.full === 0);
      R.invEq.textContent = rep.transit
        ? 'empty ' + S.empty + ' + full ' + S.full + ' + in-transit ' + rep.transit + ' = ' + (S.empty + S.full + rep.transit)
        : 'empty ' + S.empty + ' + full ' + S.full + ' = ' + (S.empty + S.full);
      R.invOk.textContent = rep.ok ? '✓ balanced' : '⚠ broken';
      R.invariant.classList.toggle('is-bad', !rep.ok);
      R.devcheck.textContent = rep.ok
        ? 'Dev check ✓ invariant holds · buffer contents match the semaphores'
        : '⚠ Dev check failed: empty(' + S.empty + ') + full(' + S.full + ') + in-transit(' + rep.transit + ') should be 5; items ' + rep.items + ' vs expected ' + rep.expectedItems + '.';
      R.devcheck.classList.toggle('is-bad', !rep.ok);
    } else if (race) {
      const actual = race.buffer.filter(Boolean).length;
      R.vuActual.textContent = actual + '/5';
      R.vuCounter.textContent = String(race.counter);
      R.vuCounterBox.classList.toggle('is-bad', race.mismatch);
      R.invEq.textContent = 'counter ' + race.counter + (race.counter === actual ? ' = ' : ' ≠ ') + 'actual ' + actual;
      R.invOk.textContent = race.mismatch ? '⚠ inconsistent' : 'unprotected…';
      R.invariant.classList.toggle('is-bad', race.mismatch);
      R.devcheck.textContent = 'Dev check paused: scripted unsafe demo. The real shift is frozen and safe.';
      R.devcheck.classList.remove('is-bad');
    }

    // --- Worker panels
    renderWorker(P, R.p, S.stats.produced, S.stats.spaceWaits + S.stats.pMutexWaits);
    renderWorker(C, R.c, S.stats.consumed, S.stats.itemWaits + S.stats.cMutexWaits);

    // --- Live program highlight (worker panels + pseudocode stage)
    ROLES.forEach((role) => {
      const w = S[role];
      R.programs[role].forEach((list) => {
        Array.from(list.children).forEach((li, i) => {
          const cur = !unsafe && w.pc === i;
          li.classList.toggle('is-current', cur && !w.blocked);
          li.classList.toggle('is-blocked', cur && !!w.blocked);
        });
      });
    });

    // --- Status bar
    const consumed = S.stats.consumed;
    R.sbConsumed.textContent = String(consumed);
    R.sbBar.style.width = Math.min(100, (consumed / GOAL) * 100) + '%';
    R.sbProgress.setAttribute('aria-valuenow', String(consumed));
    R.sbIntegrity.textContent = integ.pct + '%' + (integ.warn ? ' ⚠' : '');
    R.sbIntegrityNote.textContent = integ.note;
    R.sbIntegrityCell.classList.toggle('is-warn', integ.warn);
    R.sbRun.textContent = runStateText();
    R.sbMode.textContent = unsafe ? 'UNSAFE · mutex off' : 'Safe mode · mutex on';
    R.sbMode.classList.toggle('is-unsafe', unsafe);
    if (activeScenario === 'unsafe' && !unsafe) R.mission.textContent = 'Safe mode restored. Press Start Auto Mode to finish the shift — 15 packages, zero chaos.';
    else R.mission.textContent = activeScenario ? SCENARIOS[activeScenario].mission : DEFAULT_MISSION;
    R.scenarioChip.hidden = !activeScenario;
    if (activeScenario) R.scenarioChip.textContent = 'Scenario: ' + SCENARIOS[activeScenario].title;

    // --- Buttons
    const frozen = unsafe || S.won;
    R.btn.produce.disabled = autoOn || frozen;
    R.btn.consume.disabled = autoOn || frozen;
    R.btn.auto.disabled = autoOn || frozen;
    R.btn.pause.disabled = frozen || !(autoOn || timerId !== null);
    R.btn.step.disabled = frozen;
    R.btn.experiment.setAttribute('aria-pressed', String(unsafe));
    R.btn.experiment.querySelector('.lbl').textContent = unsafe ? 'Disable Mutex Experiment' : 'Enable Mutex Experiment';
    R.btn.experiment.disabled = S.won;

    renderResults(rep, integ);
  }

  function renderWorker(w, ref, count, waits) {
    const st = statusOf(w);
    ref.pill.dataset.tone = st.tone;
    ref.pill.querySelector('.txt').textContent = st.t;
    ref.panel.dataset.tone = st.tone;
    ref.holding.textContent = (!unsafe && w.item) ? '#' + w.item : '—';
    ref.orders.textContent = String(w.orders);
    ref.count.textContent = String(count);
    ref.waits.textContent = String(waits);
  }

  /* ---------- Results stage + badges ---------- */
  function updateBadges() {
    const st = S.stats;
    if (st.consumed >= 1) badges.add('first');
    if (st.spaceWaits >= 1) badges.add('fullhouse');
    if (st.itemWaits >= 1) badges.add('patience');
    if (st.pMutexWaits + st.cMutexWaits >= 1) badges.add('lock');
    if (st.raceConditions >= 1) badges.add('chaos');
    if (S.won) badges.add('shift');
  }
  function renderResults(rep, integ) {
    const st = S.stats;
    const pw = st.spaceWaits + st.pMutexWaits;
    const cw = st.itemWaits + st.cMutexWaits;
    const x = R.res;
    x.ring.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, st.consumed / GOAL)));
    x.ringNum.textContent = String(st.consumed);
    x.status.textContent = S.won ? 'Shift complete — buffer protected the whole way.'
      : unsafe ? 'Paused for the unsafe experiment.'
      : st.consumed ? (GOAL - st.consumed) + ' packages to go.' : 'Shift not started yet.';
    x.integrity.textContent = integ.pct + '%';
    x.integrityNote.textContent = unsafe ? integ.note : (rep.ok ? 'empty + full + in-transit = 5 · contents match the semaphores' : 'Dev check failed — see the Control Room');
    x.integrityBox.classList.toggle('is-warn', integ.warn);
    x.produced.textContent = String(st.produced);
    x.consumed.textContent = String(st.consumed);
    x.sync.textContent = String(st.syncActions);
    x.pwaits.textContent = String(pw);
    x.pwaitsD.textContent = st.spaceWaits + ' for space · ' + st.pMutexWaits + ' for mutex';
    x.cwaits.textContent = String(cw);
    x.cwaitsD.textContent = st.itemWaits + ' for items · ' + st.cMutexWaits + ' for mutex';
    x.race.textContent = String(st.raceConditions);
    x.pwaitsBox.classList.toggle('is-wait', pw > 0);
    x.cwaitsBox.classList.toggle('is-wait', cw > 0);
    x.raceBox.classList.toggle('is-bad', st.raceConditions > 0);
    R.badgeEls.forEach((b) => {
      const on = badges.has(b.dataset.badge);
      if (on && !b.classList.contains('is-earned')) b.classList.add('is-pop');
      b.classList.toggle('is-earned', on);
      b.setAttribute('aria-label', b.querySelector('b').textContent + (on ? ': earned' : ': not earned yet'));
    });
  }

  /* =========================================================
     5. SCENARIOS
     ========================================================= */
  const SCENARIOS = {
    balanced:  { title: 'Balanced Shift', p: 'medium', c: 'medium', mission: 'Balanced Shift — both workers at Medium. Observe a mostly stable flow.' },
    overflow:  { title: 'Overflow Alert', p: 'fast', c: 'slow', mission: 'Overflow Alert — fast Producer, slow Consumer. Watch the Producer wait when all slots are full.' },
    emptylane: { title: 'Empty Lane', p: 'slow', c: 'fast', mission: 'Empty Lane — slow Producer, fast Consumer. Watch the Consumer wait when no packages are available.' },
    unsafe:    { title: 'Unsafe Shortcut', p: 'medium', c: 'medium', unsafe: true, mission: 'Unsafe Shortcut — mutex disabled for a scripted demo. See why mutual exclusion matters.' },
  };
  const scenarioCards = $$('[data-scenario]');
  function renderScenarios() {
    scenarioCards.forEach((card) => {
      const on = card.dataset.scenario === activeScenario;
      card.classList.toggle('is-active', on);
      card.querySelector('.active-chip').hidden = !on;
      if (on) card.setAttribute('aria-current', 'true'); else card.removeAttribute('aria-current');
    });
  }
  function playScenario(key) {
    const sc = SCENARIOS[key];
    if (!sc) return;
    setSpeed('producer', sc.p, true);
    setSpeed('consumer', sc.c, true);
    activeScenario = key;
    resetSim({ keepScenario: true });     // reset the buffer, keep the scenario
    log('Scenario loaded: ' + sc.title + ' (Producer ' + SPEED_LABEL[sc.p] + ', Consumer ' + SPEED_LABEL[sc.c] + ').', 'system');
    announce('Scenario loaded: ' + sc.title + '.');
    renderScenarios();
    G.Stage.goTo('play', { focusTitle: true });
    if (sc.unsafe) enableExperiment(); else startAuto();
  }
  $$('[data-play]').forEach((b) => b.addEventListener('click', () => playScenario(b.dataset.play)));

  /* =========================================================
     6. WIN MODAL
     ========================================================= */
  const modal = $('#win-modal');
  function openWin() {
    const st = S.stats;
    $('#w-produced').textContent = String(st.produced);
    $('#w-consumed').textContent = String(st.consumed);
    $('#w-pwaits').textContent = String(st.spaceWaits + st.pMutexWaits);
    $('#w-cwaits').textContent = String(st.itemWaits + st.cMutexWaits);
    $('#w-race').textContent = String(st.raceConditions);
    $('#w-integrity').textContent = integrityInfo(integrityReport()).pct + '%';
    if (typeof modal.showModal === 'function') { if (!modal.open) modal.showModal(); }
    else modal.setAttribute('open', '');
    const b = $('#win-again');
    if (b) b.focus();
  }
  function closeWin() {
    if (!modal.open && !modal.hasAttribute('open')) return;
    if (typeof modal.close === 'function') modal.close(); else modal.removeAttribute('open');
  }
  modal.addEventListener('click', (e) => { if (e.target === modal) closeWin(); });
  $('#win-close').addEventListener('click', closeWin);
  $('#win-again').addEventListener('click', () => { closeWin(); resetSim(); G.Stage.goTo('play', { focusTitle: true }); });
  $('#win-logic').addEventListener('click', () => { closeWin(); G.Stage.goTo('logic', { focusTitle: true }); });

  /* =========================================================
     7. CONTROL ROOM — wiring
     ========================================================= */
  R.btn.produce.addEventListener('click', () => manual('producer'));
  R.btn.consume.addEventListener('click', () => manual('consumer'));
  R.btn.auto.addEventListener('click', () => { startAuto(); if (!R.btn.pause.disabled) R.btn.pause.focus(); });
  R.btn.pause.addEventListener('click', () => { pause(false); R.btn.auto.focus(); });
  R.btn.step.addEventListener('click', stepOnce);
  R.btn.reset.addEventListener('click', () => { resetSim(); announce('Simulation reset. empty is 5, full is 0, mutex unlocked.'); });
  R.btn.log.addEventListener('click', () => {
    const hide = !R.logPanel.hidden;
    R.logPanel.hidden = hide;
    R.lower.classList.toggle('is-log-hidden', hide);
    R.btn.log.setAttribute('aria-expanded', String(!hide));
  });
  R.btn.experiment.addEventListener('click', () => { if (unsafe) disableExperiment(); else enableExperiment(); });
  R.btn.replay.addEventListener('click', () => { if (unsafe) { log('Replaying the race…', 'danger', 'demo'); runRaceScript(); } });
  R.btn.restore.addEventListener('click', () => { disableExperiment(); R.btn.auto.focus(); });
  R.p.speed.addEventListener('input', () => setSpeed('producer', SPEED_KEYS[Number(R.p.speed.value)] || 'medium'));
  R.c.speed.addEventListener('input', () => setSpeed('consumer', SPEED_KEYS[Number(R.c.speed.value)] || 'medium'));



  // Initial Control Room state
  setSpeed('producer', 'medium', true);
  setSpeed('consumer', 'medium', true);
  log('Control Room online: empty = 5, full = 0, mutex unlocked.', 'system');
  coach(COACH_IDLE);
  render();
  renderScenarios();

  G.Sim = { modalOpen: () => !!modal.open };
})();
