// ==UserScript==
// @name         Kick Stream Enhancer (rewrite)
// @namespace    https://github.com/dxD7/Kick-Stream-Enhancer
// @version      2.0.0
// @description  Mouse wheel volume + middle-click mute, auto highest quality, auto theater mode for Kick.com
// @match        https://kick.com/*
// @match        https://www.kick.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  SETTINGS
   * ------------------------------------------------------------------ */
  const CFG = {
    wheelVolume: true,
    middleClickMute: true,
    autoQuality: true,
    autoTheater: true,
    theaterKeyFallback: true, // press "t" if no theater button can be found
    volumeStep: 0.05,         // 5% per wheel notch
    maxHeight: null,          // e.g. 1080 to cap quality; null = highest available
    debug: false,             // set true, then open DevTools console and filter "[KSE]"
  };

  const log = (...a) => CFG.debug && console.log('[KSE]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ *
   *  HELPERS
   * ------------------------------------------------------------------ */
  const RESERVED = new Set([
    '', 'categories', 'category', 'browse', 'search', 'following', 'dashboard',
    'settings', 'subscriptions', 'clips', 'video', 'videos', 'support', 'login',
    'signup', 'wallet', 'creator-dashboard', 'kick-streamer-dashboard',
    'terms-of-service', 'privacy-policy', 'community-guidelines', 'stream',
  ]);

  // Live channel page only: kick.com/<channel>  (not /clips, /videos, ?clip=)
  function isChannelPage() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return false;
    if (RESERVED.has(parts[0].toLowerCase())) return false;
    if (/[?&]clip=/.test(location.search)) return false;
    return true;
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function getVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width > 200 && area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // Walk up from the video until we hit the container that holds the control buttons
  function getControlsRoot(video) {
    let el = video.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      if (el.querySelectorAll('button').length >= 4) return el;
    }
    return video.parentElement || document.body;
  }

  // The player's control bar = buttons sitting along the bottom edge of the video,
  // sorted left -> right. Position-based so it can never include Follow/Share/Report etc.
  function getControlStrip(video) {
    const vr = video.getBoundingClientRect();
    const bottom = Math.min(vr.bottom, window.innerHeight);
    return [...document.querySelectorAll('button')]
      .filter((b) => {
        if (!visible(b)) return false;
        if (b.closest('#chatroom, [id*="chat"], [class*="chatroom"]')) return false;
        const r = b.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        return cx >= vr.left && cx <= vr.right && cy >= bottom - 100 && cy <= bottom + 30;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  }

  // Kick auto-hides the control bar (collapses it to height 0) when the mouse is idle.
  // Simulate a hover over the lower part of the player so it expands before we look for buttons.
  async function revealControls(video) {
    const r = video.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = Math.min(r.bottom, window.innerHeight) - 60;
    const target = document.elementFromPoint(x, y) || video;
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    }
    await sleep(450); // bar height transition is ~200ms
  }

  function clickEl(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function labelOf(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tooltip'),
      el.textContent,
    ].filter(Boolean).join(' ').trim();
  }

  async function waitFor(fn, timeout = 1500, step = 80) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   *  ON-SCREEN DISPLAY
   * ------------------------------------------------------------------ */
  let osd, osdTimer;
  function showOSD(video, text) {
    if (flashIndicator()) return; // preferred: indicator next to the speaker icon
    if (!osd) {
      osd = document.createElement('div');
      osd.id = 'kse-osd';
      Object.assign(osd.style, {
        position: 'fixed', zIndex: 2147483647, pointerEvents: 'none',
        padding: '8px 16px', borderRadius: '8px', font: '600 18px system-ui, sans-serif',
        color: '#fff', background: 'rgba(0,0,0,.7)', transition: 'opacity .2s',
        transform: 'translate(-50%,-50%)',
      });
      document.body.appendChild(osd);
    }
    const r = video.getBoundingClientRect();
    osd.style.left = r.left + r.width / 2 + 'px';
    osd.style.top = r.top + r.height / 2 + 'px';
    osd.textContent = fmtVol(video);
    setTimeout(() => { osd.textContent = fmtVol(video); }, 80); // re-read after Kick settles
    osd.style.opacity = '1';
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { osd.style.opacity = '0'; }, 800);
  }

  /* ------------------------------------------------------------------ *
   *  VOLUME INDICATOR (lives in the control bar, next to the speaker)
   *  Driven by the video's own 'volumechange' event, so it always shows
   *  the real state even if Kick adjusts volume/mute right after us.
   * ------------------------------------------------------------------ */
  let volEl = null;
  let volBoundVideo = null;
  let volMissLogged = false;
  let savedVol = null;   // last audible volume, restored on unmute (Kick's own value goes stale)
  let volTouchedAt = 0;  // last time the wheel changed volume
  const fmtVol = (v) => (v.muted || v.volume === 0 ? 'Muted' : Math.round(v.volume * 100) + '%');

  function updateIndicator() {
    const v = volBoundVideo;
    if (!v) return;
    if (Date.now() - volTouchedAt > 500) syncKickSlider(v); // don't fight the user's own slider drag
    if (!volEl) return;
    volEl.textContent = Math.round(v.volume * 100) + '%';
    volEl.style.opacity = v.muted ? '0.45' : '1';           // dimmed + struck through = muted
    volEl.style.textDecoration = v.muted ? 'line-through' : 'none';
  }

  function flashIndicator() {
    if (!volEl || !volEl.isConnected) return false;
    updateIndicator();
    setTimeout(updateIndicator, 80);
    volEl.style.color = '#53fc18';
    setTimeout(() => { if (volEl) volEl.style.color = '#fff'; }, 400);
    return true;
  }

  function saveVolume(v) {
    try {
      const d = new Date();
      d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
      document.cookie = `volume=${v.volume}; expires=${d.toUTCString()}; path=/`;
    } catch (_) {}
  }

  /* ---- Kick's own volume controls ---- */
  let ownClick = false;

  const kickVolBtn = () => document.querySelector('.group\\/volume > button');
  const kickSlider = () => document.querySelector('.group\\/volume [role="slider"]');
  const nativeMuteOK = () => !!kickVolBtn(); // mute through Kick's own button so its icon + MUTED label update

  // Kick's slider only follows Kick's own state (it ignores simulated keys), so mirror the
  // real volume onto it visually: fill (range) and thumb position. Cosmetic only; guarded.
  function syncKickSlider(v) {
    try {
      const th = kickSlider();
      if (!th || v.muted) return;
      const min = parseFloat(th.getAttribute('aria-valuemin')) || 0;
      const max = parseFloat(th.getAttribute('aria-valuemax')) || 100;
      const pct = Math.round(v.volume * 100);
      th.setAttribute('aria-valuenow', String(Math.round((min + v.volume * (max - min)) * 100) / 100));
      const wrap = th.parentElement;                 // thumb wrapper (positioned with left: calc(..))
      const root = wrap && wrap.parentElement;       // slider root
      const range = root && root.querySelector('[style*="right"]');
      if (range) range.style.right = (100 - pct) + '%';
      if (wrap && wrap.style.left) {
        const half = (th.offsetWidth || 16) / 2;
        wrap.style.left = `calc(${pct}% + ${(half * (1 - pct / 50)).toFixed(2)}px)`;
      }
    } catch (_) {}
  }

  function setVolume(v, frac) {
    frac = Math.min(1, Math.max(0, Math.round(frac * 100) / 100));
    v.volume = frac;
    syncKickSlider(v);
  }

  // After an unmute, Kick may re-apply its own value a moment later; put ours back (unless the user touched volume)
  function scheduleRestore(v, target, t0) {
    for (const ms of [150, 400]) {
      setTimeout(() => {
        if (!v.muted && volTouchedAt < t0 && Math.abs(v.volume - target) > 0.01) setVolume(v, target);
      }, ms);
    }
  }

  function clickKickMute() {
    ownClick = true;
    try { clickEl(kickVolBtn()); } finally { ownClick = false; }
  }

  function muteNow(v) {
    savedVol = v.volume;
    if (nativeMuteOK()) clickKickMute(); else v.muted = true;
  }

  function unmuteNow(v) {
    const target = savedVol != null ? savedVol : (v.volume || 1);
    const t0 = Date.now();
    if (nativeMuteOK()) clickKickMute(); else v.muted = false;
    if (v.muted) v.muted = false; // make sure the element really is unmuted
    setVolume(v, target);
    scheduleRestore(v, target, t0);
    return target;
  }

  function toggleMute(v) {
    if (v.muted || v.volume === 0) unmuteNow(v); else muteNow(v);
    showOSD(v);
  }

  // User clicking Kick's speaker button: let Kick handle it natively when possible,
  // but remember the volume so we can fix it if Kick restores a stale value.
  document.addEventListener('click', (e) => {
    if (ownClick) return;
    const b = kickVolBtn();
    const v = getVideo();
    if (!b || !v || !b.contains(e.target)) return;
    if (nativeMuteOK()) {
      if (v.muted || v.volume === 0) {
        const target = savedVol != null ? savedVol : (v.volume || 1);
        scheduleRestore(v, target, Date.now());
      } else {
        savedVol = v.volume;
      }
      return; // Kick handles the click itself
    }
    e.preventDefault();
    e.stopPropagation();
    toggleMute(v);
  }, true);

  // Remember when the user themselves touches Kick's volume slider so we never fight them
  const markTouch = (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('.group\\/volume') && !t.closest('button')) volTouchedAt = Date.now();
  };
  document.addEventListener('pointerdown', markTouch, true);
  document.addEventListener('keydown', markTouch, true);

  function findVolumeButton(strip) {
    const trusted = document.querySelector('.group\\/volume > button');
    if (trusted) return trusted;
    const named = strip.find((b) => /mute|unmute|volume|sound/i.test(labelOf(b)));
    if (named) return named;
    return strip.length >= 2 ? strip[1] : null; // pause/play is first, speaker second
  }

  function ensureIndicator() {
    const v = getVideo();
    if (!v) return;
    if (v !== volBoundVideo) {
      volBoundVideo = v;
      v.addEventListener('volumechange', () => {
        saveVolume(v);
        if (!v.muted && v.volume > 0) savedVol = v.volume;
        updateIndicator();
        setTimeout(updateIndicator, 80);
      });
    }
    const btn = findVolumeButton(getControlStrip(v));
    if (volEl && volEl.isConnected && (!btn || volEl.previousElementSibling === btn)) { updateIndicator(); return; }
    if (!btn) {
      if (CFG.debug && !volMissLogged) { volMissLogged = true; log('volume/speaker button not found'); }
      return;
    }
    if (!volEl) {
      volEl = document.createElement('span');
      volEl.id = 'kse-vol';
      Object.assign(volEl.style, {
        display: 'inline-block', minWidth: '44px', margin: '0 6px', textAlign: 'center',
        font: '600 14px system-ui, sans-serif', color: '#fff', userSelect: 'none',
        pointerEvents: 'none', whiteSpace: 'nowrap', transition: 'color .2s, opacity .2s',
      });
    }
    btn.insertAdjacentElement('afterend', volEl);
    updateIndicator();
  }

  /* ------------------------------------------------------------------ *
   *  FEATURE 1: WHEEL VOLUME + MIDDLE CLICK MUTE
   * ------------------------------------------------------------------ */
  function pointerOverPlayer(e) {
    const v = getVideo();
    if (!v) return null;
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], #kse-osd')) return null;
    const r = v.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom + 70; // +70px = control bar
    return inside ? v : null;
  }

  if (CFG.wheelVolume) {
    window.addEventListener('wheel', (e) => {
      const v = pointerOverPlayer(e);
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = e.deltaY < 0 ? 1 : -1;
      let base = v.volume;
      if (v.muted && dir > 0) base = unmuteNow(v);
      setVolume(v, base + dir * CFG.volumeStep);
      volTouchedAt = Date.now() + 1; // strictly after any unmute's restore timestamp
      showOSD(v, v.muted ? 'Muted' : `Volume ${Math.round(v.volume * 100)}%`);
    }, { passive: false, capture: true });
  }

  if (CFG.middleClickMute) {
    // Block middle-click autoscroll
    window.addEventListener('mousedown', (e) => {
      if (e.button === 1 && pointerOverPlayer(e)) e.preventDefault();
    }, { capture: true });

    window.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const v = pointerOverPlayer(e);
      if (!v) return;
      e.preventDefault();
      e.stopPropagation();
      toggleMute(v);
    }, { capture: true });
  }

  /* ------------------------------------------------------------------ *
   *  FEATURE 2: AUTO THEATER MODE
   * ------------------------------------------------------------------ */
  // Kick sets data-theatre="true" on the main layout wrapper when theater is on
  const canDetectTheater = () => !!document.querySelector('[data-theatre]');
  const isTheater = () => !!document.querySelector('[data-theatre="true"]');

  function pressT() {
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable)) return false; // never type into chat
    for (const type of ['keydown', 'keyup']) {
      document.dispatchEvent(new KeyboardEvent(type, { key: 't', code: 'KeyT', keyCode: 84, bubbles: true }));
    }
    return true;
  }

  async function doTheater(video) {
    const detectable = canDetectTheater();
    if (detectable && isTheater()) { log('theater already on'); return; }

    const btn = getControlStrip(video).find((b) => /theat(er|re)/i.test(labelOf(b)));
    if (btn) {
      log('clicking theater button');
      clickEl(btn);
      if (!detectable) return;                       // can't verify, don't risk a double toggle
      if (await waitFor(isTheater, 800)) return;     // worked
    }
    if (CFG.theaterKeyFallback) {
      log('using "t" key for theater');
      pressT();
      if (detectable) await waitFor(isTheater, 800);
    }
  }

  /* ------------------------------------------------------------------ *
   *  FEATURE 3: AUTO HIGHEST QUALITY  (one-shot, caption-safe)
   *
   *  Why the old behaviour looped: streams with captions have an extra
   *  popup (Off / English / ...). A script that just "opens the menu and
   *  clicks the last/first thing" lands in that captions popup, never
   *  finds a resolution, and retries forever from a MutationObserver.
   *  This version identifies each menu by its TEXT, bails out of the
   *  captions menu, and is hard-capped on attempts.
   * ------------------------------------------------------------------ */
  const RES_RE = /^\s*(\d{3,4})p\s*(\d{2,3})?\s*(\(.*\))?\s*$/i;

  function findTextEls(re) {
    const out = [];
    for (const el of document.querySelectorAll('button, li, div, span, a, [role]')) {
      if (el.children.length > 3) continue;
      if (el.closest('#kse-osd, #chatroom, [id*="chat"], [class*="chatroom"]')) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 28 || !re.test(t)) continue;
      if (!visible(el)) continue;
      out.push(el);
    }
    return out;
  }

  // Identify which menu (if any) is currently open
  function menuState() {
    const res = findTextEls(RES_RE);
    if (res.length) return { kind: 'quality', items: res };
    const row = findTextEls(/^quality/i)[0];
    if (row) return { kind: 'root', row };
    const off = findTextEls(/^off$/i);
    if (off.length) return { kind: 'captions' };
    return null;
  }

  function settingsCandidates(video) {
    const strip = getControlStrip(video);
    if (CFG.debug) log('control strip:', strip.map((b) => labelOf(b).slice(0, 25) || '(no label)'));
    const named = strip.filter((b) => /setting|quality|gear|cog/i.test(labelOf(b)));
    const last = strip[strip.length - 1]; // gear is the rightmost control
    const out = [...named];
    if (last && !out.includes(last) && !/full|caption|clip|theat|mute|volume|play|pause/i.test(labelOf(last))) out.push(last);
    return out;
  }

  async function closeMenu(btn) {
    // No Escape key: Kick uses it to exit theater mode.
    await sleep(200);
    if (menuState() && btn) { clickEl(btn); await sleep(200); } // toggle closed
  }

  function pickBest(items) {
    let best = null;
    let bestScore = -1;
    for (const el of items) {
      const m = RES_RE.exec(el.textContent.trim());
      if (!m) continue;
      const h = parseInt(m[1], 10);
      if (CFG.maxHeight && h > CFG.maxHeight) continue;
      const score = h * 1000 + (m[2] ? parseInt(m[2], 10) : 30);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }

  async function runQuality(video) {
    const tried = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      await revealControls(video);
      const btn = settingsCandidates(video).find((b) => !tried.has(b));
      if (!btn) { log('no more settings candidates'); return false; }
      tried.add(btn);
      log('opening candidate button:', labelOf(btn).slice(0, 30) || btn.outerHTML.slice(0, 80));

      clickEl(btn);
      let state = await waitFor(menuState, 1200);

      if (state && state.kind === 'root') {
        clickEl(state.row);
        state = await waitFor(() => { const s = menuState(); return s && s.kind === 'quality' ? s : null; }, 1200);
      }

      if (state && state.kind === 'quality') {
        const best = pickBest(state.items);
        if (best) {
          log('selecting', best.textContent.trim());
          st.targetH = parseInt(RES_RE.exec(best.textContent.trim())[1], 10);
          clickEl(best);
          await sleep(300);
          await closeMenu(btn);
          return true;
        }
      }

      log('wrong/empty menu (' + (state ? state.kind : 'none') + '), closing and trying next button');
      await closeMenu(btn);
      await sleep(250);
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   *  SCHEDULER  (plain 1s tick; no MutationObserver, so no feedback loops)
   * ------------------------------------------------------------------ */
  const st = { path: null, video: null, videoSince: 0, qRuns: 0, theaterDone: false, busy: false, targetH: null };

  async function tick() {
    if (document.hidden) return;

    const path = location.pathname + location.search;
    if (path !== st.path) {
      Object.assign(st, { path, video: null, qRuns: 0, theaterDone: false, targetH: null });
      log('navigated to', path);
    }

    const v = getVideo();
    if (!v) return;
    if (v !== st.video) { st.video = v; st.videoSince = Date.now(); }

    if (!isChannelPage()) return;
    if (v.readyState < 2 || Date.now() - st.videoSince < 3000) return; // let the player settle
    if (st.busy) return;

    const needTheater = CFG.autoTheater && !st.theaterDone;
    const goalH = CFG.maxHeight || 1080;
    const alreadyHigh = v.videoHeight >= goalH - 20;
    const needQuality = CFG.autoQuality && st.qRuns < 2 && !alreadyHigh;
    if (!needTheater && !needQuality) return;

    st.busy = true;
    try {
      if (needTheater) {
        st.theaterDone = true;
        await doTheater(v);
        await sleep(900); // layout shifts after theater toggle
      }
      if (needQuality) {
        st.qRuns++;
        const ok = await runQuality(getVideo() || v);
        if (ok) st.qRuns = 2; // success: done for this page
        log('quality result:', ok);
        // Safety net: if anything in the quality routine knocked theater off, put it back
        if (CFG.autoTheater && canDetectTheater() && !isTheater()) {
          log('theater was turned off, restoring');
          await doTheater(getVideo() || v);
        }
      }
    } catch (err) {
      console.warn('[KSE] error', err);
    } finally {
      st.busy = false;
    }
  }

  function reenforceQuality() {
    const v = getVideo();
    if (!CFG.autoQuality || !v || !isChannelPage() || st.busy || !v.videoHeight) return;
    const target = st.targetH || CFG.maxHeight || 1080;
    if (v.videoHeight < target - 20) {
      log('quality dropped to ' + v.videoHeight + 'p, re-enforcing');
      st.qRuns = 0;
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reenforceQuality(); });
  window.addEventListener('focus', reenforceQuality);

  setInterval(tick, 1000);
  setInterval(() => { try { ensureIndicator(); } catch (_) {} }, 700);
})();
