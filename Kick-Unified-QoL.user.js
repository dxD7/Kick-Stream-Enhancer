// ==UserScript==
// @name         Kick Unified QoL (Volume Wheel + Auto-1080 + Auto-Theater)
// @namespace    https://github.com/dxd7
// @version      1.2
// @description  FIXED: Resolution script now ignores /clips pages.
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
		QUALITY_PREFERENCES: ['1080p60', '1080p', '720p60', '720p']
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

	// ROBUST SIMULATED CLICK (Critical for all React buttons)
	function simulateFullClick(el) {
		if (!el) return;
		try {
			el.focus();
			['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
				const event = new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					composed: true,
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
				});
				el.dispatchEvent(event);
			});
			el.click();
		} catch (err) {
			try { el.click(); } catch (e) { /* ignore */ }
		}
	}

	/* ------------------ NAVIGATION & SPA HANDLING ------------------ */

	let lastUrl = location.href;
	const navObserver = new MutationObserver(() => {
		const href = location.href;
		if (href !== lastUrl) {
			lastUrl = href;
			onNavigate(href);
		}
	});
	navObserver.observe(document, { childList: true, subtree: true });

	function onNavigate(url) {
		log(`Mapsd to: ${url}`);
		tryInitPlayer();

		// FIX: Do not attempt to change resolution on clips pages
		if (!url.includes("/clips")) {
			trySelectQualityLoop();
		} else {
			log("Clips page detected, skipping Auto-Resolution.");
		}

		if (isStreamPage(url)) {
			log("Stream page detected, attempting single 't' press...");
			singlePressTheater(); // NEW SIMPLE CALL
		}
	}

	/* helper: decide stream page (not a VOD) */
	function isStreamPage(url) {
		const path = url.replace(/^https?:\/\/(?:www\.)?kick\.com\/?/, "");
		if (!path || path === "") return false;
		const parts = path.split("/").filter(Boolean);
		return parts.length === 1;
	}

	/* ------------------ VOLUME WHEEL (KNOWN WORKING CODE) ------------------ */

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
			if (event && event.button === 1) {
				prevent(event);
				toggleMute(video, videoDiv);
			}
		});

		document.addEventListener("keydown", (event) => {
			if ((event.key === 'M' || event.key === 'm') &&
				event.target.tagName !== 'INPUT' &&
				event.target.tagName !== 'TEXTAREA' &&
				event.target.isContentEditable !== true) {
				prevent(event);
				toggleMute(video, videoDiv);
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
		const muteButton = videoDiv.querySelector('div.z-controls .group\\/volume > button') ||
			document.querySelector('#injected-embedded-channel-player-video .z-controls .group\\/volume > button');
		if (!muteButton || muteButton._kpbound) return;
		muteButton._kpbound = true;
		muteButton.addEventListener("click", (event) => {
			prevent(event);
			toggleMute(video, videoDiv);
		});
	}

	function updateSlider(video, videoDiv) {
		try {
			const controls = (videoDiv && videoDiv.querySelector) ? videoDiv.querySelector('div > div.z-controls') : document.querySelector('div.z-controls');
			if (!controls) return;
			const sliderFill = controls.querySelector('span[style*="right:"]');
			if (sliderFill) {
				const videoVolume = Math.round(video.volume * 100);
				sliderFill.style.right = `${100 - videoVolume}%`;
			}
			const sliderThumb = controls.querySelector('span[style*="transform: var(--radix-slider-thumb-transform)"]');
			if (sliderThumb) {
				const videoVolume = Math.round(video.volume * 100);
				const offset = 8 + (videoVolume / 100) * -16;
				sliderThumb.style.left = `calc(${videoVolume}% + ${offset}px)`;
			}
			const sliderValuenow = controls.querySelector('span[aria-valuenow]');
			if (sliderValuenow) sliderValuenow.setAttribute("aria-valuenow", Math.round(video.volume * 100));
			const sliderP = controls.querySelector('.group\\/volume .betterhover\\:group-hover\\/volume\\:flex');
			if (sliderP) sliderP.setAttribute("playervolume", Math.round(video.volume * 100) + "%");
		} catch (err) { /* swallow */ }
	}

	function applySliderCSS() {
		let styles = `
#injected-embedded-channel-player-video > div > div.z-controls .group\\/volume .betterhover\\:group-hover\\/volume\\:flex::after {
	content: attr(playervolume);
	font-weight: 600;
	font-size: .875rem;
	line-height: 1.25rem;
	margin-left: .5rem;
	width: 4ch;
}`;
		if (CONFIG.SLIDER_ALWAYS_VISIBLE) {
			styles += `
#injected-embedded-channel-player-video > div > div.z-controls .group\\/volume .betterhover\\:group-hover\\/volume\\:flex {
	display: flex;
	align-items: center;
}`;
		}
		const id = 'kp-volume-wheel-styles';
		if (!document.getElementById(id)) {
			const styleSheet = document.createElement("style");
			styleSheet.id = id;
			styleSheet.textContent = styles;
			document.head.appendChild(styleSheet);
		}
	}

	/* ------------------ AUTO 1080p (KNOWN WORKING CODE) ------------------ */

	let qualityInterval = null;
	const MAX_QUALITY_ATTEMPTS = 120; // ~6 seconds if interval is 50ms

	function findCogButton() {
		// Aggressive selector from last attempt
		const buttons = document.querySelectorAll('#injected-embedded-channel-player-video button');
		for (const btn of buttons) {
			const label = btn.ariaLabel || '';
			if (label.toLowerCase().includes('settings') || btn.getAttribute('aria-haspopup') === 'menu') {
				return btn;
			}
		}
		return null;
	}

	function selectQualityIfAvailable() {
		const items = document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]');
		if (!items || items.length === 0) return false;

		const list = Array.from(items);
		for (const pref of CONFIG.QUALITY_PREFERENCES) {
			const match = list.find(it => it.textContent && it.textContent.trim().includes(pref));
			if (match) {
				log(`Selecting Quality: ${pref}`);
				simulateFullClick(match);
				return true;
			}
		}
		return false;
	}

	function trySelectQualityLoop() {
		clearQualityLoop();
		let qualityAttempts = 0;
		qualityInterval = setInterval(() => {
			qualityAttempts++;
			if (qualityAttempts > MAX_QUALITY_ATTEMPTS) {
				log("Auto-Resolution failed to find settings button after max attempts.");
				clearQualityLoop();
				return;
			}

			const cog = findCogButton();
			if (cog) {
				simulateFullClick(cog);

				setTimeout(() => {
					if (selectQualityIfAvailable()) {
						clearQualityLoop();
					} else {
						// Click again to close the menu for safety
						simulateFullClick(cog);
					}
				}, 50);
			}
		}, 250);
	}

	function clearQualityLoop() {
		if (qualityInterval) {
			clearInterval(qualityInterval);
			qualityInterval = null;
		}
	}

	/* ------------------ AUTO THEATRE (SINGLE 't' PRESS) ------------------ */

	function singlePressTheater() {
		const VIDEO_PLAYER_ID = 'video-player';

		// Use a timeout to ensure the video player and key listener are active
		setTimeout(() => {
			const videoElement = document.getElementById(VIDEO_PLAYER_ID);

			// Critical check: Ensure the video player exists before attempting the press
			if (!videoElement) {
				log(`Video element (${VIDEO_PLAYER_ID}) not found for 't' press.`);
				return;
			}

			// Check if Theater is already active (by looking for the "Default View" button)
			const isAlreadyTheater = Array.from(document.querySelectorAll('button')).some(
				b => (b.ariaLabel && (b.ariaLabel.includes('Default View') || b.ariaLabel.includes('Default Mode')))
			);

			if (isAlreadyTheater) {
				log("Theater mode already active. Skipping 't' press.");
				return;
			}

			// Dispatch a single 't' keypress on the video element
			const keyEvent = new KeyboardEvent('keydown', {
				key: 't',
				code: 'KeyT',
				bubbles: true,
				cancelable: true
			});
			videoElement.dispatchEvent(keyEvent);
			log("Dispatched single 't' keypress to toggle Theater Mode.");
		}, 3000); // 3-second delay to ensure the player is fully initialized
	}

	/* ------------------ KICK OFF INITIAL RUN ------------------ */
	setTimeout(() => {
		onNavigate(location.href);
	}, 500);

	/* Cleanup on page unload */
	window.addEventListener('beforeunload', () => {
		clearQualityLoop();
	});
})();
