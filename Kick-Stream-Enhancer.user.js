// ==UserScript==
// @name         Kick Stream Enhancer (Volume Wheel + Auto-1080 + Auto-Theater)
// @namespace    https://github.com/dxd7
// @version      1.5
// @description  FIXED: Reduced quality menu "spam" by using a single delayed check and smarter menu peeking.
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
        RECHECK_DELAY: 2500 // 2.5s delay after screen swap/focus
    };

    /* Logger */
    function log(msg) { console.log(`[KickQoL] ${msg}`); }

    /* Utils */
    function setCookie(name, value, days) {
        const date = new Date();
        date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
        document.cookie = `${name}=${value}; expires=${date.toUTCString()}; path=/`;
    }
    function prevent(e) {
        if (!e) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    function simulateFullClick(el) {
        if (!el) return;
        try {
            el.focus();
            ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                const event = new PointerEvent(type, {
                    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
                });
                el.dispatchEvent(event);
            });
            el.click();
        } catch (err) {
            try { el.click(); } catch (e) { /* ignore */ }
        }
    }

    /* ------------------ NAVIGATION & EVENTS ------------------ */

    let lastUrl = location.href;
    const navObserver = new MutationObserver(() => {
        const href = location.href;
        if (href !== lastUrl) {
            lastUrl = href;
            onNavigate(href);
        }
    });
    navObserver.observe(document, { childList: true, subtree: true });

    let scheduleTimeout;
    function scheduleQualityCheck() {
        if (!isStreamPage(location.href) || location.href.includes("/clips")) return;
        
        clearTimeout(scheduleTimeout);
        log("Screen swap/focus detected. Quality check scheduled...");

        scheduleTimeout = setTimeout(() => {
            log("Running delayed quality enforcement...");
            trySelectQualityLoop();
        }, CONFIG.RECHECK_DELAY);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === 'visible') scheduleQualityCheck();
    });

    window.addEventListener("focus", scheduleQualityCheck);

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(scheduleQualityCheck, 500);
    });

    function onNavigate(url) {
        log(`Mapsd to: ${url}`);
        tryInitPlayer();
        if (!url.includes("/clips")) trySelectQualityLoop();
        if (isStreamPage(url)) singlePressTheater();
    }

    function isStreamPage(url) {
        const path = url.replace(/^https?:\/\/(?:www\.)?kick\.com\/?/, "");
        if (!path || path === "") return false;
        const parts = path.split("/").filter(Boolean);
        return parts.length === 1 && !['video', 'clips', 'search'].includes(parts[0]);
    }

    /* ------------------ VOLUME WHEEL ------------------ */

    const playerSetupStore = new WeakSet();
    const bodyObserver = new MutationObserver(() => {
        tryInitPlayer();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    function tryInitPlayer() {
        const video = document.getElementById("video-player");
        if (!video) return;
        const videoDiv = document.querySelector("#injected-embedded-channel-player-video > div");
        if (!videoDiv) return;
        if (playerSetupStore.has(videoDiv)) return;
        playerSetupStore.add(videoDiv);
        setupVolumeWheel(video, videoDiv);
    }

    function setupVolumeWheel(video, videoDiv) {
        if (videoDiv.hasAttribute("kpvolume-init")) return;
        videoDiv.setAttribute("kpvolume-init", "1");

        videoDiv.addEventListener("wheel", (event) => {
            prevent(event);
            if (CONFIG.SHOW_CONTROLS_ON_SCROLL) {
                const showEvent = new Event('mousemove');
                videoDiv.dispatchEvent(showEvent);
            }
            if (video.muted && videoDiv.getAttribute("kpvolume")) {
                video.muted = false;
                setTimeout(() => {
                    const stored = parseFloat(videoDiv.getAttribute("kpvolume"));
                    if (!Number.isNaN(stored)) video.volume = stored;
                    updateSlider(video, videoDiv);
                }, 50);
            } else if (event.deltaY < 0) {
                video.volume = Math.min(1, video.volume + (CONFIG.VOLUME_STEP / 100));
            } else if (event.deltaY > 0) {
                video.volume = Math.max(0, video.volume - (CONFIG.VOLUME_STEP / 100));
            }
            setTimeout(() => updateSlider(video, videoDiv), 50);
            setTimeout(() => setCookie("volume", video.volume, 365), 3000);
        }, { passive: false });

        let hideCursorTimeout;
        videoDiv.addEventListener("mousemove", (event) => {
            setTimeout(() => {
                bindMuteBtn(video, videoDiv);
                updateSlider(video, videoDiv);
            }, 50);
            setTimeout(() => setCookie("volume", video.volume, 365), 3000);
            if (videoDiv.contains(event.target)) {
                videoDiv.style.cursor = 'default';
                if (hideCursorTimeout) clearTimeout(hideCursorTimeout);
                hideCursorTimeout = setTimeout(() => { videoDiv.style.cursor = 'none'; }, CONFIG.HIDE_CURSOR_DELAY);
            }
        });

        videoDiv.addEventListener("mousedown", (event) => {
            if (event && event.button === 1) { prevent(event); toggleMute(video, videoDiv); }
        });

        document.addEventListener("keydown", (event) => {
            if ((event.key === 'M' || event.key === 'm') && event.target.tagName !== 'INPUT' && event.target.tagName !== 'TEXTAREA' && event.target.isContentEditable !== true) {
                prevent(event); toggleMute(video, videoDiv);
            }
        });
        applySliderCSS();
    }

    function toggleMute(video, videoDiv) {
        if (video.muted) {
            video.muted = false;
            setTimeout(() => {
                const stored = parseFloat(videoDiv.getAttribute("kpvolume"));
                if (!Number.isNaN(stored)) video.volume = stored;
                updateSlider(video, videoDiv);
            }, 50);
        } else {
            videoDiv.setAttribute("kpvolume", video.volume);
            video.muted = true;
        }
    }

    function bindMuteBtn(video, videoDiv) {
        const muteButton = videoDiv.querySelector('div.z-controls .group\\/volume > button') || document.querySelector('#injected-embedded-channel-player-video .z-controls .group\\/volume > button');
        if (!muteButton || muteButton._kpbound) return;
        muteButton._kpbound = true;
        muteButton.addEventListener("click", (event) => { prevent(event); toggleMute(video, videoDiv); });
    }

    function updateSlider(video, videoDiv) {
        try {
            const controls = (videoDiv && videoDiv.querySelector) ? videoDiv.querySelector('div > div.z-controls') : document.querySelector('div.z-controls');
            if (!controls) return;
            const sliderFill = controls.querySelector('span[style*="right:"]');
            if (sliderFill) sliderFill.style.right = `${100 - (Math.round(video.volume * 100))}%`;
            const sliderThumb = controls.querySelector('span[style*="transform: var(--radix-slider-thumb-transform)"]');
            if (sliderThumb) {
                const vol = Math.round(video.volume * 100);
                sliderThumb.style.left = `calc(${vol}% + ${8 + (vol / 100) * -16}px)`;
            }
            const sliderValuenow = controls.querySelector('span[aria-valuenow]');
            if (sliderValuenow) sliderValuenow.setAttribute("aria-valuenow", Math.round(video.volume * 100));
            const sliderP = controls.querySelector('.group\\/volume .betterhover\\:group-hover\\/volume\\:flex');
            if (sliderP) sliderP.setAttribute("playervolume", Math.round(video.volume * 100) + "%");
            updatePercentageDisplay(Math.round(video.volume * 100));
        } catch (err) { }
    }

    function updatePercentageDisplay(volumePercent) {
        let percentageDisplay = document.getElementById('kp-volume-percentage');
        if (!percentageDisplay) {
            percentageDisplay = document.createElement('span');
            percentageDisplay.id = 'kp-volume-percentage';
            percentageDisplay.style.cssText = `margin-left: 8px; font-size: 0.875rem; font-weight: 600; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); pointer-events: none;`;
            const volumeContainer = document.querySelector('.group\\/volume');
            if (volumeContainer) {
                const sliderWrap = volumeContainer.querySelector('.betterhover\\:group-hover\\/volume\\:flex');
                if (sliderWrap) sliderWrap.parentNode.insertBefore(percentageDisplay, sliderWrap.nextSibling);
                else volumeContainer.appendChild(percentageDisplay);
            }
        }
        if (percentageDisplay) percentageDisplay.textContent = `${volumePercent}%`;
    }

    function applySliderCSS() {
        let styles = `
#injected-embedded-channel-player-video > div > div.z-controls .group\\/volume .betterhover\\:group-hover\\/volume\\:flex::after { content: attr(playervolume); font-weight: 600; font-size: .875rem; line-height: 1.25rem; margin-left: .5rem; width: 4ch; }
#kp-volume-percentage { margin-left: 8px; font-size: 0.875rem; font-weight: 600; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); pointer-events: none; transition: opacity 0.2s ease; }
.group\\/volume:hover #kp-volume-percentage { opacity: 1; }`;
        if (CONFIG.SLIDER_ALWAYS_VISIBLE) styles += `#injected-embedded-channel-player-video > div > div.z-controls .group\\/volume .betterhover\\:group-hover\\/volume\\:flex { display: flex; align-items: center; }`;
        if (!document.getElementById('kp-volume-wheel-styles')) {
            const ss = document.createElement("style"); ss.id = 'kp-volume-wheel-styles'; ss.textContent = styles; document.head.appendChild(ss);
        }
    }

    /* ------------------ AUTO 1080p ------------------ */

    let qualityInterval = null;

    function findCogButton() {
        const buttons = document.querySelectorAll('#injected-embedded-channel-player-video button');
        for (const btn of buttons) {
            const label = btn.ariaLabel || '';
            if (label.toLowerCase().includes('settings') || btn.getAttribute('aria-haspopup') === 'menu') return btn;
        }
        return null;
    }

    function selectQualityIfAvailable() {
        const items = document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]');
        if (!items || items.length === 0) return { found: false, alreadySet: false };

        const list = Array.from(items);
        for (const pref of CONFIG.QUALITY_PREFERENCES) {
            const match = list.find(it => it.textContent && it.textContent.trim().includes(pref));
            if (match) {
                if (match.getAttribute('aria-checked') === 'true') {
                    return { found: true, alreadySet: true };
                }
                log(`Selecting Quality: ${pref}`);
                simulateFullClick(match);
                return { found: true, alreadySet: false };
            }
        }
        return { found: false, alreadySet: false };
    }

    function trySelectQualityLoop() {
        if (qualityInterval) return; // Prevent overlapping loops

        let qualityAttempts = 0;
        qualityInterval = setInterval(() => {
            qualityAttempts++;
            if (qualityAttempts > 20) { clearQualityLoop(); return; }

            const cog = findCogButton();
            if (cog) {
                simulateFullClick(cog);
                
                setTimeout(() => {
                    const status = selectQualityIfAvailable();
                    if (status.found) {
                        clearQualityLoop();
                        // If it was already correct, just click the cog to close the menu
                        // If we just clicked a new setting, Kick usually closes the menu automatically, but we check anyway.
                        setTimeout(() => {
                            const menuOpen = document.querySelector('[role="menu"]');
                            if (menuOpen) simulateFullClick(findCogButton());
                        }, 100);
                    }
                }, 150);
            }
        }, 1000); // Check once per second until found or max attempts reached
    }

    function clearQualityLoop() {
        if (qualityInterval) { clearInterval(qualityInterval); qualityInterval = null; }
    }

    /* ------------------ AUTO THEATRE ------------------ */

    function singlePressTheater() {
        setTimeout(() => {
            const videoElement = document.getElementById('video-player');
            if (!videoElement) return;
            const isAlreadyTheater = Array.from(document.querySelectorAll('button')).some(b => (b.ariaLabel && (b.ariaLabel.includes('Default View') || b.ariaLabel.includes('Default Mode'))));
            if (isAlreadyTheater) return;
            videoElement.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true, cancelable: true }));
        }, 3000);
    }

    setTimeout(() => { onNavigate(location.href); }, 500);
    window.addEventListener('beforeunload', clearQualityLoop);
})();
