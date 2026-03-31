// ==UserScript==
// @name         Kick Stream Enhancer (Volume Wheel + Auto-1080 + Auto-Theater)
// @namespace    https://github.com/dxd7
// @version      1.7
// @description  FIXED: Middle-click mute.
// @match        https://kick.com/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    const CONFIG = {
        VOLUME_STEP: 5,
        SHOW_CONTROLS_ON_SCROLL: true,
        SLIDER_ALWAYS_VISIBLE: true,
        HIDE_CURSOR_DELAY: 4000,
        QUALITY_PREFERENCES: ['1080p60', '1080p', '720p60', '720p'],
        RECHECK_DELAY: 2000 
    };

    function log(msg) { console.log(`[KickQoL] ${msg}`); }

    /* Utils */
    function setCookie(name, value, days) {
        const date = new Date();
        date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
        document.cookie = `${name}=${value}; expires=${date.toUTCString()}; path=/`;
    }

    function simulateFullClick(el) {
        if (!el) return;
        try {
            el.focus();
            ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                const event = new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true });
                el.dispatchEvent(event);
            });
            el.click();
        } catch (err) { try { el.click(); } catch (e) {} }
    }

    function wakeUpPlayer() {
        const container = document.querySelector("#injected-embedded-channel-player-video > div");
        if (!container) return;
        ['mouseenter', 'mousemove', 'mouseover'].forEach(type => {
            container.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
    }

    /* ------------------ SMART ENFORCEMENT ------------------ */

    function isStreamPage(url) {
        const path = url.replace(/^https?:\/\/(?:www\.)?kick\.com\/?/, "");
        if (!path || path === "") return false;
        const parts = path.split("/").filter(Boolean);
        return parts.length === 1 && !['video', 'clips', 'search', 'home'].includes(parts[0]);
    }

    function checkAndEnforceQuality() {
        if (!isStreamPage(location.href) || location.href.includes("/clips")) return;
        const video = document.getElementById("video-player");
        if (!video) return;
        if (video.videoHeight >= 1060) {
            log(`Quality is already ${video.videoHeight}p.`);
            return;
        }
        log(`Quality drop detected (${video.videoHeight}p). Fixing...`);
        wakeUpPlayer();
        setTimeout(trySelectQualityLoop, 100);
    }

    let scheduleTimeout;
    function scheduleQualityCheck() {
        clearTimeout(scheduleTimeout);
        scheduleTimeout = setTimeout(checkAndEnforceQuality, CONFIG.RECHECK_DELAY);
    }

    document.addEventListener("visibilitychange", () => { if (document.visibilityState === 'visible') scheduleQualityCheck(); });
    window.addEventListener("focus", scheduleQualityCheck);
    
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(scheduleQualityCheck, 500);
    });

    /* ------------------ NAVIGATION ------------------ */

    let lastUrl = location.href;
    const navObserver = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            tryInitPlayer();
            setTimeout(checkAndEnforceQuality, 1500);
            if (isStreamPage(lastUrl)) singlePressTheater();
        }
    });
    navObserver.observe(document, { childList: true, subtree: true });

    /* ------------------ VOLUME WHEEL & MUTE ------------------ */

    const playerSetupStore = new WeakSet();
    const bodyObserver = new MutationObserver(() => tryInitPlayer());
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    function tryInitPlayer() {
        const video = document.getElementById("video-player");
        const videoDiv = document.querySelector("#injected-embedded-channel-player-video > div");
        if (!video || !videoDiv || playerSetupStore.has(videoDiv)) return;
        playerSetupStore.add(videoDiv);
        setupVolumeWheel(video, videoDiv);
    }

    function toggleMute(video, videoDiv) {
        if (video.muted) {
            video.muted = false;
            const stored = parseFloat(videoDiv.getAttribute("kpvolume"));
            if (!Number.isNaN(stored)) video.volume = stored;
        } else {
            videoDiv.setAttribute("kpvolume", video.volume);
            video.muted = true;
        }
        updateSlider(video, videoDiv);
    }

    function setupVolumeWheel(video, videoDiv) {
        if (videoDiv.hasAttribute("kpvolume-init")) return;
        videoDiv.setAttribute("kpvolume-init", "1");

        // Scroll Wheel
        videoDiv.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (video.muted) {
                video.muted = false;
                const stored = parseFloat(videoDiv.getAttribute("kpvolume"));
                if (!Number.isNaN(stored)) video.volume = stored;
            } else if (e.deltaY < 0) {
                video.volume = Math.min(1, video.volume + (CONFIG.VOLUME_STEP / 100));
            } else {
                video.volume = Math.max(0, video.volume - (CONFIG.VOLUME_STEP / 100));
            }
            updateSlider(video, videoDiv);
            setCookie("volume", video.volume, 365);
        }, { passive: false });

        // RESTORED: Middle Click Mute
        videoDiv.addEventListener("mousedown", (e) => {
            if (e.button === 1) { // Middle click
                e.preventDefault(); // Stop auto-scroll icon
                toggleMute(video, videoDiv);
            }
        });

        videoDiv.addEventListener("mousemove", () => {
            bindMuteBtn(video, videoDiv);
            updateSlider(video, videoDiv);
        });

        applySliderCSS();
    }

    function updateSlider(video, videoDiv) {
        try {
            const controls = videoDiv.querySelector('div.z-controls') || document.querySelector('div.z-controls');
            if (!controls) return;
            const vol = Math.round(video.volume * 100);
            const sliderFill = controls.querySelector('span[style*="right:"]');
            if (sliderFill) sliderFill.style.right = `${100 - vol}%`;
            const sliderP = controls.querySelector('.group\\/volume .betterhover\\:group-hover\\/volume\\:flex');
            if (sliderP) sliderP.setAttribute("playervolume", vol + "%");
            
            let pDisp = document.getElementById('kp-volume-percentage');
            if (!pDisp) {
                pDisp = document.createElement('span');
                pDisp.id = 'kp-volume-percentage';
                pDisp.style.cssText = `margin-left: 8px; font-size: 0.875rem; font-weight: 600; color: white; pointer-events: none;`;
                const volCont = document.querySelector('.group\\/volume');
                if (volCont) volCont.appendChild(pDisp);
            }
            if (pDisp) pDisp.textContent = video.muted ? "MUTED" : `${vol}%`;
        } catch (err) {}
    }

    function bindMuteBtn(video, videoDiv) {
        const btn = document.querySelector('#injected-embedded-channel-player-video .z-controls .group\\/volume > button');
        if (!btn || btn._kpbound) return;
        btn._kpbound = true;
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            toggleMute(video, videoDiv);
        });
    }

    function applySliderCSS() {
        const id = 'kp-volume-wheel-styles';
        if (document.getElementById(id)) return;
        const style = document.createElement("style");
        style.id = id;
        style.textContent = `
            #injected-embedded-channel-player-video > div > div.z-controls .group\\/volume .betterhover\\:group-hover\\/volume\\:flex::after { content: attr(playervolume); font-weight: 600; font-size: .875rem; margin-left: .5rem; width: 4ch; }
            #injected-embedded-channel-player-video > div > div.z-controls .group\\/volume .betterhover\\:group-hover\\/volume\\:flex { display: flex !important; align-items: center; }
        `;
        document.head.appendChild(style);
    }

    /* ------------------ COG LOGIC ------------------ */

    let qualityInterval = null;
    function trySelectQualityLoop() {
        if (qualityInterval) return;
        let attempts = 0;
        qualityInterval = setInterval(() => {
            if (attempts++ > 10) { clearInterval(qualityInterval); qualityInterval = null; return; }
            if (attempts % 3 === 0) wakeUpPlayer();

            const player = document.querySelector('#injected-embedded-channel-player-video');
            if (!player) return;

            const cog = Array.from(player.querySelectorAll('button')).find(b => 
                b.ariaLabel?.toLowerCase().includes('settings') || 
                b.getAttribute('aria-haspopup') === 'menu'
            );

            if (cog) {
                simulateFullClick(cog);
                setTimeout(() => {
                    const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'));
                    const match = items.find(it => CONFIG.QUALITY_PREFERENCES.some(p => it.textContent.includes(p)));
                    if (match) {
                        if (match.getAttribute('aria-checked') !== 'true') simulateFullClick(match);
                        clearInterval(qualityInterval);
                        qualityInterval = null;
                        setTimeout(() => { if (document.querySelector('[role="menu"]')) simulateFullClick(cog); }, 200);
                    }
                }, 200);
            }
        }, 1000);
    }

    /* ------------------ THEATER ------------------ */

    function singlePressTheater() {
        setTimeout(() => {
            const video = document.getElementById('video-player');
            const isTheater = Array.from(document.querySelectorAll('button')).some(b => b.ariaLabel?.includes('Default View'));
            if (video && !isTheater) video.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }));
        }, 3500);
    }

    setTimeout(() => onNavigate(location.href), 500);
})();
