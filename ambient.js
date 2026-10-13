/* =========================================================
   G.R.O.O.T. — ambient.js
   The floating background.

   A full-screen <canvas> behind every stage with faint, slowly
   drifting pieces of the story: packages, buffer slots, semaphore
   tokens, padlocks, little code fragments and dust.

   It is designed to stay out of the way:
   • very low contrast, and fainter toward the centre of the screen
     where the content sits (centreFade)
   • it never takes clicks (pointer-events: none)
   • it pauses when the tab is hidden, and draws one still frame
     when the visitor prefers reduced motion
   • the sparkle button in the top bar switches it off (remembered)

   It is also a little alive:
   • the pointer gently parts the pieces and draws faint
     "orchestration" links to the ones nearby
   • clicking empty background sends a soft ripple
   • it listens to the game (GROOT.emit) — a new package floats up
     at the edges, waits tint tokens amber, a race condition flushes
     everything red, a safe restore or a win sparkles, and changing
     stage nudges the whole field sideways.
   ========================================================= */
(function () {
  'use strict';

  const G = window.GROOT;
  const canvas = document.getElementById('ambient');
  const toggle = document.getElementById('ambient-toggle');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  /* ---------- Palette (RGB) ---------- */
  const C = {
    green: [75, 83, 32],
    sage: [221, 230, 207],
    amber: [183, 121, 31],
    red: [169, 68, 66],
  };
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const CODE = ['wait(empty)', 'signal(full)', 'wait(mutex)', 'signal(mutex)', 'empty = 5', 'full = 0',
    'P → C', 'buffer[5]', 'critical', '++full', '--empty', 'lock', 'in = (in+1) % 5', 'out', 'sem'];
  const TYPES = ['pkg', 'pkg', 'pkg', 'slot', 'slot', 'token', 'token', 'lock', 'code', 'code', 'dot', 'dot', 'dot'];
  // On narrow screens the content fills the width, so skip the text fragments there.
  const TYPES_NARROW = TYPES.filter((t) => t !== 'code');
  const isNarrow = () => W < 700;

  /* ---------- Tunables ---------- */
  const PUSH_R = 140;      // pointer "personal space"
  const LINK_R = 180;      // pointer link reach
  const PAIR_R = 110;      // particle–particle link reach (near the pointer only)
  const MAX_TEMPS = 10;    // event-spawned particles alive at once

  /* ---------- State ---------- */
  let W = 0, H = 0, DPR = 1;
  let parts = [];          // the permanent field
  let temps = [];          // short-lived particles from game events
  let ripples = [];
  let running = false, raf = 0, last = 0, clock = 0;
  let enabled = true;
  let globalTint = null;   // { color, until, strength }
  const mouse = { x: 0, y: 0, active: false, px: 0, py: 0 };

  try { if (localStorage.getItem('groot-ambient') === 'off') enabled = false; } catch (e) { /* storage blocked */ }

  /* ---------- Helpers ---------- */
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
  const mix = (a, b, k) => [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
  const motionOK = () => !G.motionReduced();

  // Fainter in the middle third of the screen, where the content lives.
  function centreFade(x) {
    const d = Math.abs(x / W - 0.5) * 2;              // 0 at centre → 1 at the edges
    const k = Math.min(1, Math.max(0, (d - 0.15) / 0.55));
    const f = 0.3 + 0.7 * k * k * (3 - 2 * k);
    return isNarrow() ? f * 0.75 : f;
  }

  function makeParticle(type, x, y) {
    const z = rand(0.45, 1);                          // depth: bigger, faster, stronger parallax when near
    const speed = rand(6, 15) * z;
    const ang = rand(0, Math.PI * 2);
    const p = {
      type: type || pick(isNarrow() ? TYPES_NARROW : TYPES),
      x: x != null ? x : rand(0, W),
      y: y != null ? y : rand(0, H),
      z: z,
      bvx: Math.cos(ang) * speed,                     // "home" velocity it relaxes back to
      bvy: Math.sin(ang) * speed * 0.6 - 2,           // a slight upward float overall
      vx: 0, vy: 0,
      rot: rand(-0.4, 0.4),
      vr: rand(-0.12, 0.12),
      phase: rand(0, Math.PI * 2),
      alpha: rand(0.14, 0.26),
      glow: 0,
      tint: null,
      size: 10,
      label: '',
    };
    p.vx = p.bvx; p.vy = p.bvy;
    switch (p.type) {
      case 'pkg': p.size = rand(18, 34) * z; break;
      case 'slot': p.size = rand(20, 32) * z; break;
      case 'token': p.size = rand(18, 26) * z; p.label = String((Math.random() * 6) | 0); break;
      case 'lock': p.size = rand(16, 24) * z; p.vr *= 0.5; break;
      case 'code': p.size = rand(10, 13) * (0.8 + z * 0.3); p.label = pick(CODE); p.rot = rand(-0.12, 0.12); p.vr = 0; break;
      default: p.size = rand(1.6, 3.4) * z; p.alpha = rand(0.16, 0.32);
    }
    return p;
  }

  const targetCount = () => Math.max(12, Math.min(46, Math.round((W * H) / 36000)));
  function populate() {
    const n = targetCount();
    while (parts.length < n) parts.push(makeParticle());
    if (parts.length > n) parts.length = n;
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    if (isNarrow()) parts = parts.filter((p) => p.type !== 'code');
    populate();
    parts.forEach((p) => {
      if (p.x > W + 40) p.x = rand(0, W);
      if (p.y > H + 40) p.y = rand(0, H);
    });
    if (!running && enabled) draw(performance.now());
  }

  /* ---------- Drawing ---------- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function colourOf(p, now) {
    let tint = p.tint && p.tint.until > now ? p.tint : null;
    if (!tint && globalTint && globalTint.until > now) tint = globalTint;
    if (!tint) return C.green;
    const fadeOut = Math.min(1, (tint.until - now) / 700);
    return mix(C.green, C[tint.color], fadeOut * tint.strength);
  }

  function shape(p, col, a) {
    const s = p.size;
    ctx.lineWidth = Math.max(1, s / 16);
    ctx.strokeStyle = rgba(col, a);
    switch (p.type) {
      case 'pkg': {                                   // isometric parcel with tape
        const h = s / 2, w = s * 0.44;
        ctx.beginPath();
        ctx.moveTo(0, -h); ctx.lineTo(w, -h / 2); ctx.lineTo(w, h / 2);
        ctx.lineTo(0, h); ctx.lineTo(-w, h / 2); ctx.lineTo(-w, -h / 2);
        ctx.closePath();
        ctx.fillStyle = rgba(C.sage, a * 1.6);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-w, -h / 2); ctx.lineTo(0, 0); ctx.lineTo(w, -h / 2);
        ctx.moveTo(0, 0); ctx.lineTo(0, h);
        ctx.moveTo(-w / 2, -h * 0.75); ctx.lineTo(w / 2, -h * 0.25);
        ctx.stroke();
        break;
      }
      case 'slot': {                                  // dashed empty buffer slot
        ctx.setLineDash([3, 3]);
        roundRect(-s / 2, -s * 0.55, s, s * 1.1, s * 0.2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'token': {                                 // semaphore value token
        ctx.beginPath();
        ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(C.sage, a * 1.4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = rgba(col, a * 1.7);
        ctx.font = '700 ' + Math.round(s * 0.55) + 'px ' + MONO;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, 0, 1);
        break;
      }
      case 'lock': {                                  // mutex padlock
        roundRect(-s * 0.36, -s * 0.08, s * 0.72, s * 0.56, s * 0.12);
        ctx.fillStyle = rgba(C.sage, a * 1.4);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -s * 0.08, s * 0.22, Math.PI, 0);
        ctx.stroke();
        break;
      }
      case 'code': {                                  // pseudocode fragment
        ctx.fillStyle = rgba(col, a * 1.15);
        ctx.font = '500 ' + Math.round(s) + 'px ' + MONO;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, 0, 0);
        break;
      }
      default: {                                      // dust
        ctx.beginPath();
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, a);
        ctx.fill();
      }
    }
  }

  // Where a particle is drawn this frame (its position plus a little parallax).
  function screenPos(p) {
    const k = 0.014 * p.z;
    return { x: p.x - (mouse.px - W / 2) * k, y: p.y - (mouse.py - H / 2) * k };
  }

  function drawParticle(p, now, life) {
    const s = screenPos(p);
    const a = p.alpha * centreFade(s.x) * (1 + p.glow * 1.3) * life;
    if (a < 0.004) return;
    ctx.setTransform(DPR, 0, 0, DPR, s.x * DPR, s.y * DPR);
    if (p.rot) ctx.rotate(p.rot);
    shape(p, colourOf(p, now), a);
  }

  function drawLinks() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.lineWidth = 1;
    const near = [];
    for (let i = 0; i < parts.length; i++) {
      const s = screenPos(parts[i]);
      const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
      if (d < LINK_R) near.push({ x: s.x, y: s.y, d: d });
    }
    for (let i = 0; i < near.length; i++) {
      const n = near[i];
      ctx.strokeStyle = rgba(C.green, (1 - n.d / LINK_R) * 0.13);
      ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(n.x, n.y); ctx.stroke();
      for (let j = i + 1; j < near.length; j++) {
        const m = near[j];
        const dd = Math.hypot(n.x - m.x, n.y - m.y);
        if (dd < PAIR_R) {
          ctx.strokeStyle = rgba(C.green, (1 - dd / PAIR_R) * 0.07);
          ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); ctx.stroke();
        }
      }
    }
    if (near.length) {
      ctx.fillStyle = rgba(C.green, 0.16);
      ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (mouse.active && running) drawLinks();
    for (let i = 0; i < parts.length; i++) drawParticle(parts[i], now, 1);
    for (let i = 0; i < temps.length; i++) {
      const p = temps[i];
      const age = now - p.born;
      const life = Math.min(1, age / 600) * Math.min(1, (p.dur - age) / 900);
      drawParticle(p, now, Math.max(0, life));
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    for (let i = 0; i < ripples.length; i++) {
      const r = ripples[i];
      const k = (now - r.born) / 1000;
      if (k >= 1) continue;
      ctx.strokeStyle = rgba(C.green, (1 - k) * 0.22);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, 12 + k * 130, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* ---------- Motion ---------- */
  function move(p, dt) {
    const relax = Math.min(1, dt * 0.9);
    p.vx += (p.bvx - p.vx) * relax;                   // drift back to the home velocity
    p.vy += (p.bvy - p.vy) * relax;
    let near = false;
    if (mouse.active) {                               // part gently around the pointer
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const d = Math.hypot(dx, dy);
      if (d < PUSH_R && d > 0.01) {
        const f = 1 - d / PUSH_R;
        const k = f * f * 260 * dt;
        p.vx += (dx / d) * k;
        p.vy += (dy / d) * k;
        near = true;
      }
    }
    p.glow = near ? Math.min(1, p.glow + dt * 4) : Math.max(0, p.glow - dt * 2);
    p.x += (p.vx + Math.sin(clock * 0.35 + p.phase) * 3 * p.z) * dt;
    p.y += (p.vy + Math.cos(clock * 0.27 + p.phase) * 2.5 * p.z) * dt;
    p.rot += p.vr * dt;
  }

  function step(dt, now) {
    clock += dt;
    const ease = Math.min(1, dt * 3);
    mouse.px += ((mouse.active ? mouse.x : W / 2) - mouse.px) * ease;
    mouse.py += ((mouse.active ? mouse.y : H / 2) - mouse.py) * ease;
    const m = 40;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      move(p, dt);
      if (p.x < -m) p.x = W + m; else if (p.x > W + m) p.x = -m;   // wrap around the edges
      if (p.y < -m) p.y = H + m; else if (p.y > H + m) p.y = -m;
    }
    for (let i = temps.length - 1; i >= 0; i--) {
      const p = temps[i];
      move(p, dt);
      if (now - p.born > p.dur || p.y < -60) temps.splice(i, 1);
    }
    ripples = ripples.filter((r) => now - r.born < 1000);
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    step(dt, now);
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!enabled) return;
    if (running) return;
    if (!motionOK() || document.hidden) { draw(performance.now()); return; }   // one still frame
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  /* ---------- Reactions to the game ---------- */
  const edgeX = () => (Math.random() < 0.5 ? rand(0.02, 0.2) : rand(0.8, 0.98)) * W;

  function spawnPackage() {                           // a new package floats up at the edges
    if (temps.length >= MAX_TEMPS) return;
    const p = makeParticle('pkg', edgeX(), H + 30);
    p.bvx = rand(-6, 6);
    p.bvy = -rand(36, 58);
    p.vx = p.bvx; p.vy = p.bvy;
    p.alpha = 0.24;
    p.born = performance.now();
    p.dur = 7000;
    temps.push(p);
  }
  function sparkle(n, colour) {                       // little burst of bright dust
    const now = performance.now();
    for (let i = 0; i < n && temps.length < MAX_TEMPS + n; i++) {
      const p = makeParticle('dot', edgeX(), rand(0.15, 0.85) * H);
      const a = rand(0, Math.PI * 2), sp = rand(20, 60);
      p.bvx = Math.cos(a) * sp; p.bvy = Math.sin(a) * sp;
      p.vx = p.bvx; p.vy = p.bvy;
      p.alpha = 0.4;
      p.size = rand(2, 3.6);
      p.tint = colour ? { color: colour, until: now + 1600, strength: 1 } : null;
      p.born = now;
      p.dur = 1800;
      temps.push(p);
    }
  }
  function tintSome(colour, n, ms) {                  // waits: a few tokens / locks blink amber
    const now = performance.now();
    const pool = parts.filter((p) => p.type === 'token' || p.type === 'lock' || p.type === 'slot');
    for (let i = 0; i < n && pool.length; i++) {
      const p = pool.splice((Math.random() * pool.length) | 0, 1)[0];
      p.tint = { color: colour, until: now + ms, strength: 1 };
      p.glow = 1;
    }
  }
  function kick(strength) {                           // race: everything jostles
    parts.forEach((p) => { p.vx += rand(-1, 1) * strength * p.z; p.vy += rand(-1, 1) * strength * p.z; });
  }
  function drift(dir) {                               // stage change: the field slides with the content
    parts.forEach((p) => { p.vx += dir * 70 * p.z; });
  }

  window.addEventListener('groot:event', (e) => {
    if (!enabled || !running) return;
    const d = e.detail || {};
    const now = performance.now();
    switch (d.type) {
      case 'add': spawnPackage(); break;
      case 'wait': tintSome('amber', d.sem === 'mutex' ? 3 : 5, 1600); break;
      case 'race': globalTint = { color: 'red', until: now + 2400, strength: 0.85 }; kick(90); break;
      case 'restore': sparkle(8); break;
      case 'win': sparkle(16); spawnPackage(); spawnPackage(); break;
      case 'stage': drift(d.dir === 'back' ? 1 : -1); break;
      default: break;
    }
  });

  /* ---------- Pointer ---------- */
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;            // no hover on touch screens
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
  }, { passive: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) mouse.active = false; });
  window.addEventListener('blur', () => { mouse.active = false; });

  // A soft ripple when clicking empty background (never on buttons or cards).
  document.addEventListener('pointerdown', (e) => {
    if (!enabled || !running) return;
    const t = e.target;
    if (t && t.closest && t.closest('button, a, input, label, select, textarea, .glass, dialog, .topbar, .bottombar')) return;
    ripples.push({ x: e.clientX, y: e.clientY, born: performance.now() });
    parts.forEach((p) => {
      const dx = p.x - e.clientX, dy = p.y - e.clientY;
      const d = Math.hypot(dx, dy);
      if (d < 220 && d > 0.01) { const k = (1 - d / 220) * 140; p.vx += (dx / d) * k; p.vy += (dy / d) * k; }
    });
  }, { passive: true });

  /* ---------- On / off, visibility, motion preference ---------- */
  function setEnabled(on, remember) {
    enabled = on;
    canvas.hidden = !on;
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(on));
      toggle.title = on ? 'Floating background: on' : 'Floating background: off';
    }
    if (on) { resize(); start(); } else stop();
    if (remember) { try { localStorage.setItem('groot-ambient', on ? 'on' : 'off'); } catch (e) { /* ignore */ } }
  }
  if (toggle) {
    toggle.addEventListener('click', () => {
      setEnabled(!enabled, true);
      G.announce(enabled ? 'Floating background on.' : 'Floating background off.');
    });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  G.onMotionChange(() => { stop(); start(); });
  window.addEventListener('resize', resize);

  // Go.
  mouse.px = window.innerWidth / 2;
  mouse.py = window.innerHeight / 2;
  setEnabled(enabled, false);
})();
