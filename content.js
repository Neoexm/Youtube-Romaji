/*
 * Content Script for YouTube Romaji Captions
 * 
 * Purpose: Inject "Romaji (auto)" option into YouTube's subtitle menu
 * 
 * Architecture:
 * - Offscreen document runs Kuroshiro + Kuromoji
 * - Content script → background → offscreen via chrome.runtime.sendMessage
 * - Fetches captions via YouTube's timedtext API
 * - Renders romanized overlay on top of video
 * - ZERO page DOM injection, ZERO Workers from content script
 */

let videoEl = null;
let videoId = null;
let overlayEl = null;
let renderer = null;
let isRomajiActive = false;

let latestTracksByVideo = new Map();
let latestYtCfg = {};
let lastVideoId = null;

let lastTimedtextUrl = null;
let lastVideoIdForTimedtext = null;

let menuWired = false;
let lastUrl = null;
let captionMenuObserver = null;

let activeRomanization = null;
let tracksLoggedThisNav = false;

const SELECTOR_PLAYER = "ytd-player";
const CAPTION_PANEL_TITLE_RE = /Subtitles|Captions|字幕|자막/i;
const JAPANESE_LANG_RE = /^ja(-|$)/i;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function $(sel, root = document) { return root.querySelector(sel); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let toastHolder = null;
function ensureToastHolder() {
  if (toastHolder) return toastHolder;
  toastHolder = document.createElement('div');
  toastHolder.id = 'romaji-toast-holder';
  toastHolder.style.position = 'absolute';
  toastHolder.style.top = '12px';
  toastHolder.style.right = '20px';
  toastHolder.style.zIndex = '9999';
  toastHolder.style.display = 'flex';
  toastHolder.style.flexDirection = 'column';
  toastHolder.style.gap = '8px';
  toastHolder.style.pointerEvents = 'none';
  (document.querySelector('.html5-video-player') || document.body).appendChild(toastHolder);
  return toastHolder;
}
function showToast(msg, type = 'info', ttl = 4000) {
  try {
    const h = ensureToastHolder();
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.background = type === 'error' ? 'rgba(180,0,0,0.85)' : 'rgba(30,30,30,0.85)';
    el.style.color = '#fff';
    el.style.padding = '6px 10px';
    el.style.fontSize = '12px';
    el.style.borderRadius = '4px';
    el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
    el.style.pointerEvents = 'auto';
    el.style.fontFamily = 'Roboto, sans-serif';
    h.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, ttl - 250);
    setTimeout(() => el.remove(), ttl);
  } catch (e) {
    console.error('[romaji] toast failed', e);
  }
}

let progressOverlay = null;
function showProgressOverlay(message = 'Romanizing subtitles...') {
  hideProgressOverlay();
  
  const playerContainer = document.querySelector('.html5-video-player');
  if (!playerContainer) {
    console.warn('[romaji] no player container for progress overlay');
    return null;
  }
  
  progressOverlay = document.createElement('div');
  progressOverlay.id = 'romaji-progress-overlay';
  progressOverlay.style.position = 'fixed';
  progressOverlay.style.top = '20px';
  progressOverlay.style.right = '20px';
  progressOverlay.style.zIndex = '10000';
  
  const textEl = document.createElement('div');
  textEl.id = 'romaji-progress-text';
  textEl.textContent = message;
  
  const barContainer = document.createElement('div');
  barContainer.id = 'romaji-progress-bar-container';
  
  const bar = document.createElement('div');
  bar.id = 'romaji-progress-bar';
  barContainer.appendChild(bar);
  
  const percentageEl = document.createElement('div');
  percentageEl.id = 'romaji-progress-percentage';
  percentageEl.textContent = '0%';
  
  progressOverlay.appendChild(textEl);
  progressOverlay.appendChild(barContainer);
  progressOverlay.appendChild(percentageEl);
  
  document.body.appendChild(progressOverlay);
  
  console.log('[romaji] progress overlay shown');
  
  return progressOverlay;
}

function updateProgressOverlay(percentage) {
  if (!progressOverlay) return;
  
  const bar = progressOverlay.querySelector('#romaji-progress-bar');
  const percentageEl = progressOverlay.querySelector('#romaji-progress-percentage');
  
  if (bar) bar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  if (percentageEl) percentageEl.textContent = `${Math.round(percentage)}%`;
}

function hideProgressOverlay() {
  if (progressOverlay) {
    progressOverlay.remove();
    progressOverlay = null;
  }
}

// Timedtext sniffing is handled by page-bridge.js in page world

function getCurrentVideoId() {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = location.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch (e) {
    console.error('[romaji] getCurrentVideoId error:', e);
  }
  return null;
}

// Helper to modify only the fmt parameter
// Build timedtext URL following yt-dlp's methodology (lines 3989-3996)
// CRITICAL: Never modify signature/expire/sparams/pot/potc/c parameters
function buildTimedTextUrl(baseUrl, options = {}) {
  try {
    const url = new URL(baseUrl);
    
    // Only modify fmt parameter if specified (yt-dlp line 3989)
    if (options.fmt) {
      url.searchParams.set('fmt', options.fmt);
    }
    
    // Only add tlang for translations (yt-dlp line 4086)
    if (options.tlang) {
      url.searchParams.set('tlang', options.tlang);
    }
    
    // DON'T touch xosf - yt-dlp's Python xosf:[] means OMIT the parameter entirely
    // Setting xosf='' (empty string) breaks YouTube's API and returns empty responses
    
    // NEVER touch these signed parameters - they come from baseUrl:
    // - signature/sig: Required for authentication
    // - expire: URL expiration timestamp
    // - sparams: Signed parameters list
    // - pot: PO (Proof of Origin) token
    // - potc: PO token context flag
    // - c: Client name
    // - ei: Event ID
    
    return url.toString();
  } catch (e) {
    console.error('[romaji] buildTimedTextUrl error:', e);
    return baseUrl;
  }
}

// Legacy compatibility wrapper - prefer buildTimedTextUrl() for new code
function withFmt(urlStr, fmt) {
  return buildTimedTextUrl(urlStr, { fmt });
}

// PO Token detection helpers (based on yt-dlp lines 4036-4053)
// NOTE: These are for informational/debugging purposes only
// yt-dlp philosophy: Don't check upfront, just try everything and handle errors after
function requiresPoToken(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const exp = url.searchParams.get('exp');
    if (!exp) return false;
    
    const experiments = exp.split(',');
    // yt-dlp detects PO token requirement via 'xpe' or 'xpv' experiments
    return experiments.includes('xpe') || experiments.includes('xpv');
  } catch {
    return false;
  }
}

function hasPoToken(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.searchParams.has('pot');
  } catch {
    return false;
  }
}

// Fetch raw text with proper cookies/referrer (content context)
async function fetchRaw(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== 'www.youtube.com') {
      throw new Error('Invalid hostname - only youtube.com allowed');
    }
    if (!parsedUrl.pathname.includes('/api/timedtext')) {
      throw new Error('Invalid path - only timedtext API allowed');
    }
    
    // IMPORTANT: Fetch with the ORIGINAL url string, not parsedUrl.toString()
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const text = await res.text();
    const ok = res.ok && text.trim().length > 0;
    
    // Enhanced logging for debugging
    console.log('[romaji] fetchRaw result - status:', res.status, 'length:', text.length, 'ok:', ok);
    if (text.length === 0 && res.ok) {
      console.warn('[romaji] WARNING: HTTP 200 but empty response body!');
    }
    
    return { 
      ok, 
      text, 
      ct: res.headers.get('content-type') || '',
      status: res.status
    };
  } catch (err) {
    console.error('[romaji] fetchRaw error:', err);
    return { ok: false, text: '', ct: '', status: 0, error: err.message };
  }
}

// ============================================================================
// PROACTIVE ROMANIZATION
// ============================================================================

const romanizationCache = new Map(); // videoId -> { status: 'pending'|'ready'|'error', cues: [...] }

async function startProactiveRomanization(videoId, tracks) {
  // ONLY proactively romanize MANUAL Japanese subtitles
  const manualTrack = tracks.find(t => JAPANESE_LANG_RE.test(t.languageCode) && t.kind !== 'asr');
  
  if (!manualTrack) {
    console.log('[romaji] no MANUAL Japanese track for proactive romanization - skipping (ASR not supported)');
    return;
  }
  
  if (!manualTrack.baseUrl) {
    console.warn('[romaji] manual track missing baseUrl, cannot start proactive romanization');
    return;
  }
  
  if (romanizationCache.has(videoId)) {
    console.log('[romaji] already romanizing or romanized:', videoId);
    return;
  }
  
  console.log('[romaji] starting proactive romanization for:', videoId, 'track:', manualTrack.languageCode, 'MANUAL');
  romanizationCache.set(videoId, { status: 'pending', cues: null });
  
  try {
    // Use yt-dlp strategy directly with track baseUrl (manual subtitles only)
    const fetchResult = await fetchCaptionsWithFallback(manualTrack.baseUrl);
    if (!fetchResult.ok) {
      throw new Error(fetchResult.error);
    }
    
    const cues = parseTimedTextAuto(fetchResult.tag, fetchResult.body);
    if (cues.length === 0) {
      throw new Error('No cues parsed');
    }
    
    const romanizedCues = await romanizeCues(cues, false);
    romanizationCache.set(videoId, { status: 'ready', cues: romanizedCues });
    console.log('[romaji] proactive romanization complete:', videoId);
  } catch (err) {
    console.error('[romaji] proactive romanization failed:', err);
    romanizationCache.set(videoId, { status: 'error', cues: null, error: err.message });
  }
}

// ============================================================================
// BRIDGE EVENT LISTENERS
// ============================================================================

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.source !== 'romaji-bridge') return;
  
  if (e.origin !== 'https://www.youtube.com') {
    console.warn('[romaji] rejected message from untrusted origin:', e.origin);
    return;
  }
  
  if (d.type === 'YT_STATE') {
    lastVideoId = d.videoId || lastVideoId;
    latestYtCfg = d.ytcfg || latestYtCfg;
    
    if (Array.isArray(d.captionTracks) && lastVideoId) {
      latestTracksByVideo.set(lastVideoId, d.captionTracks);
      
      if (d.captionTracks.length > 0 && !tracksLoggedThisNav) {
        console.log('[romaji] player data loaded, tracks:', d.captionTracks.length);
        tracksLoggedThisNav = true;
      }
      
      if (d.captionTracks.length > 0 && !menuWired) {
        tryWireCaptionMenu();
      }
    }
  }
  
  if (d.type === 'TIMEDTEXT_URL') {
    const currentVid = getCurrentVideoId();
    if (!currentVid) return;
    
    try {
      const urlObj = new URL(d.url);
      const urlVideoId = urlObj.searchParams.get('v');
      
      if (urlVideoId !== currentVid) {
        console.warn('[romaji] ignoring timedtext URL for wrong video:', urlVideoId, 'current:', currentVid);
        return;
      }
    } catch (e) {
      console.error('[romaji] failed to validate timedtext URL:', e);
      return;
    }
    
    lastVideoIdForTimedtext = currentVid;
    lastTimedtextUrl = d.url;
    console.log('[romaji] sniffed manual timedtext url:', lastTimedtextUrl);
    
    try {
      if (lastTimedtextUrl) {
        const tracks = latestTracksByVideo.get(currentVid);
        if (tracks && tracks.length > 0) {
          startProactiveRomanization(currentVid, tracks);
        }
      }
    } catch (e) {
      console.error('[romaji] postMessage handler error:', e);
    }
  }
}, false);

// ============================================================================
// INITIALIZATION
// ============================================================================

start();

// Local cache removed - API/database handles all caching now

async function start() {
  console.log("[romaji] extension starting");
  
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-bridge.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
  console.log("[romaji] page-bridge injected");
  
  await waitForPlayer();
  console.log("[romaji] player ready");
  
  setupNavigationListener();
  observeSettingsMenu();
  
  console.log("[romaji] observers attached");
}

async function waitForPlayer() {
  for (;;) {
    videoEl = $("video");
    if ($(SELECTOR_PLAYER) && videoEl) return;
    await sleep(300);
  }
}

// ============================================================================
// NAVIGATION
// ============================================================================

function setupNavigationListener() {
  // Listen for yt-navigate-finish event (fired after SPA navigation)
  document.addEventListener('yt-navigate-finish', async (e) => {
    console.log("[romaji] yt-navigate-finish event detected");
    await onNavigation(e);
  });
  
  // Fallback: also monitor URL changes via MutationObserver
  const mo = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => onNavigation(null), 250);
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

async function onNavigation() {
  const newVideoId = getCurrentVideoId();
  if (newVideoId === videoId) return;
  
  videoId = newVideoId;
  console.log("[romaji] navigation detected, videoId:", videoId);
  
  tracksLoggedThisNav = false;
  
  lastTimedtextUrl = null;
  lastVideoIdForTimedtext = null;
  
  if (renderer) renderer.stop();
  renderer = null;
  ensureOverlay(false);
  setNativeCaptionsVisible(true);
  isRomajiActive = false;
  
  if (captionMenuObserver) {
    captionMenuObserver.disconnect();
    captionMenuObserver = null;
  }
  menuWired = false;
}

// Get cached tracks from bridge data
function getCachedTracks() {
  const vid = getCurrentVideoId();
  if (!vid) return [];
  return latestTracksByVideo.get(vid) || [];
}

// ============================================================================
// MENU INJECTION
// ============================================================================

function observeSettingsMenu() {
  const mo = new MutationObserver(() => {
    if ($(".ytp-settings-menu")) tryWireCaptionMenu();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

function tryWireCaptionMenu() {
  if (menuWired) return;
  const holder = $(".ytp-popup.ytp-settings-menu");
  if (!holder) return;
  
  console.log("[romaji] wiring caption menu observer");
  if (captionMenuObserver) captionMenuObserver.disconnect();
  
  const settingsBtn = document.querySelector('.ytp-settings-button');
  if (settingsBtn && !settingsBtn.hasAttribute('data-romaji-wired')) {
    settingsBtn.setAttribute('data-romaji-wired', 'true');
    settingsBtn.addEventListener('click', () => {
      setTimeout(() => {
        const tracks = getCachedTracks();
        const hasManualJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || "") && t.kind !== 'asr');
        if (hasManualJa) {
          updateSubtitleCount();
          if (isRomajiActive) {
            updateSubtitleDisplay('Romaji');
            startSubtitleDisplayWatcher();
          }
        }
      }, 100);
    });
  }
  
  captionMenuObserver = new MutationObserver(muts => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains("ytp-panel")) {
          const title = $(".ytp-panel-title", node);
          if (title && CAPTION_PANEL_TITLE_RE.test(title.textContent || "")) {
            console.log("[romaji] injecting caption entries");
            injectCaptionEntries($(".ytp-panel-menu", node));
          } else if (title && title.textContent === 'Settings') {
            setTimeout(() => {
              const tracks = getCachedTracks();
              const hasManualJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || "") && t.kind !== 'asr');
              if (hasManualJa) {
                updateSubtitleCount();
                if (isRomajiActive) {
                  updateSubtitleDisplay('Romaji');
                  startSubtitleDisplayWatcher();
                }
              }
            }, 50);
          }
        }
      }
    }
  });
  
  captionMenuObserver.observe(holder, { childList: true, subtree: true });
  menuWired = true;
}

let subtitleDisplayObserver = null;

function startSubtitleDisplayWatcher() {
  if (subtitleDisplayObserver) subtitleDisplayObserver.disconnect();
  
  const subtitleMenuItem = Array.from(document.querySelectorAll('.ytp-menuitem')).find(item => {
    const label = item.querySelector('.ytp-menuitem-label');
    return label && label.textContent.includes('Subtitles/CC');
  });
  
  if (!subtitleMenuItem) return;
  
  const contentEl = subtitleMenuItem.querySelector('.ytp-menuitem-content');
  if (!contentEl) return;
  
  subtitleDisplayObserver = new MutationObserver(() => {
    if (isRomajiActive) {
      const label = 'Romaji';
      if (contentEl.textContent !== label) contentEl.textContent = label;
    }
  });
  
  subtitleDisplayObserver.observe(contentEl, { childList: true, characterData: true, subtree: true });
}

function stopSubtitleDisplayWatcher() {
  if (subtitleDisplayObserver) {
    subtitleDisplayObserver.disconnect();
    subtitleDisplayObserver = null;
  }
}

async function injectCaptionEntries(menuEl) {
  if (!menuEl) {
    console.warn('[romaji] no menu element provided');
    return;
  }
  
  const vid = getCurrentVideoId();
  if (!vid) {
    console.warn('[romaji] no video ID available');
    return;
  }
  
  menuEl.querySelectorAll("[data-romaji-entry]").forEach(node => node.remove());
  
  const frag = document.createDocumentFragment();
  const tracks = getCachedTracks();
  console.log('[romaji] cached tracks:', tracks.length, tracks);
  const hasManualJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || "") && t.kind !== 'asr');
  // ONLY show Romaji option if MANUAL Japanese subtitles exist (no ASR support)
  if (hasManualJa) {
    frag.appendChild(buildMenuItem("Romaji", onSelectRomaji, "romaji:auto"));
  }
  
  const customTracks = await listCustomTracks();
  for (const track of customTracks) {
    if (track.value && track.value.name) {
      frag.appendChild(buildMenuItem(track.value.name, () => onSelectCustom(track.key), `custom:${track.key}`));
    }
  }
  
  console.log('[romaji] injecting', frag.childNodes.length, 'items into menu');
  if (frag.childNodes.length) {
    menuEl.appendChild(frag);
    setTimeout(() => updateSubtitleCount(), 50);
  } else {
    console.warn('[romaji] no items to inject');
  }
  
  updateMenuCheckmarks();
  
  if (isRomajiActive) setTimeout(() => updateSubtitleDisplay('Romaji'), 0);
  
  menuEl.querySelectorAll('.ytp-menuitem[role="menuitemradio"]').forEach(item => {
    if (!item.hasAttribute('data-romaji-entry')) {
      item.addEventListener('click', () => {
        if (isRomajiActive) {
          console.log('[romaji] user switched to native caption, turning off romaji');
          if (renderer) renderer.stop();
          renderer = null;
          ensureOverlay(false);
          setNativeCaptionsVisible(true);
          isRomajiActive = false;
          activeRomanization = null;
          
          const labelEl = item.querySelector('.ytp-menuitem-label');
          if (labelEl) {
            item.setAttribute('aria-checked', 'true');
            updateSubtitleDisplay(labelEl.textContent.trim());
          }
          
          updateMenuCheckmarks();
        }
      });
    }
  });
}

function buildMenuItem(label, onClick, entryKey) {
  const li = document.createElement("div");
  li.className = "ytp-menuitem";
  li.setAttribute("role", "menuitemradio");
  li.setAttribute("aria-checked", "false");
  li.tabIndex = 0;
  
  const name = document.createElement("div");
  name.className = "ytp-menuitem-label";
  name.textContent = label;
  
  const filler = document.createElement("div");
  filler.className = "ytp-menuitem-content";
  filler.textContent = "";
  
  li.appendChild(name);
  li.appendChild(filler);
  
  li.addEventListener("click", () => {
    if (!isRomajiActive) {
      onClick();
    }
    
    setTimeout(() => {
      const backBtn = document.querySelector('.ytp-panel-back-button');
      if (backBtn) {
        backBtn.click();
        
        setTimeout(() => {
          updateSubtitleCount();
          if (isRomajiActive) {
            updateSubtitleDisplay('Romaji');
            startSubtitleDisplayWatcher();
          }
        }, 50);
      }
    }, 100);
  }, false);
  
  li.addEventListener("keydown", evt => {
    if (evt.key === "Enter" || evt.key === " " || evt.key === "Spacebar" || evt.key === "Space") {
      evt.preventDefault();
      
      if (!isRomajiActive) {
        onClick();
      }
      
      setTimeout(() => {
        const backBtn = document.querySelector('.ytp-panel-back-button');
        if (backBtn) {
          backBtn.click();
          
          setTimeout(() => {
            updateSubtitleCount();
            if (isRomajiActive) {
              updateSubtitleDisplay('Romaji');
              startSubtitleDisplayWatcher();
            }
          }, 50);
        }
      }, 100);
    }
  }, false);
  
  if (entryKey) li.dataset.romajiEntry = entryKey;
  return li;
}

// ============================================================================
// TIMEDTEXT URL SNIFFER & CC TOGGLE (DEPRECATED)
// ============================================================================

// DEPRECATED: This approach is unreliable due to race conditions and CC button dependency
// Now using yt-dlp methodology: extract baseUrl from playerResponse.captions.captionTracks
// Keeping this code for potential fallback scenarios only
async function ensureSniffedTimedtextUrl() {
  console.warn('[romaji] ensureSniffedTimedtextUrl is DEPRECATED - use track.baseUrl instead');
  
  const currentVid = getCurrentVideoId();
  if (!currentVid) {
    console.warn('[romaji] no current video ID');
    return false;
  }
  
  if (lastVideoIdForTimedtext !== currentVid) {
    console.log('[romaji] clearing stale timedtext URLs (video changed)');
    lastTimedtextUrl = null;
    lastVideoIdForTimedtext = null;
  }
  
  if (lastTimedtextUrl && lastVideoIdForTimedtext === currentVid) {
    console.log('[romaji] using cached manual timedtext URL');
    return true;
  }
  
  console.log('[romaji] attempting to capture timedtext URL via CC button toggle (FALLBACK MODE)');
  
  const ccBtn = document.querySelector('.ytp-subtitles-button');
  if (!ccBtn) {
    console.warn('[romaji] CC button not found, cannot trigger timedtext request');
    return false;
  }
  
  const wasActive = ccBtn.classList.contains('ytp-subtitles-button-active');
  
  if (!wasActive) {
    console.log('[romaji] clicking CC button to trigger timedtext request');
    ccBtn.click();
    await sleep(100);
  }
  
  const start = performance.now();
  let attempts = 0;
  while (!lastTimedtextUrl && performance.now() - start < 3000) {
    await sleep(200);
    attempts++;
    
    if (getCurrentVideoId() !== currentVid) {
      console.warn('[romaji] video changed during CC toggle, aborting');
      return false;
    }
    
    if (attempts % 5 === 0) {
      console.log('[romaji] still waiting for timedtext URL... (' + Math.round((performance.now() - start) / 1000) + 's)');
    }
  }
  
  if (lastTimedtextUrl) {
    console.log('[romaji] successfully captured timedtext URL');
    return true;
  }
  
  console.warn('[romaji] failed to capture timedtext URL after 3 seconds');
  return false;
}

// ============================================================================
// CAPTION SELECTION & FETCHING
// ============================================================================

async function onSelectRomaji() {
  console.log("[romaji] onSelectRomaji triggered");
  if (isRomajiActive) {
    if (renderer) renderer.stop();
    renderer = null;
    ensureOverlay(false);
    setNativeCaptionsVisible(true);
    isRomajiActive = false;
    activeRomanization = null;
    stopSubtitleDisplayWatcher();
    updateMenuCheckmarks();
    updateCaptionButton();
    return;
  }
  if (activeRomanization) return;
  activeRomanization = (async () => {
    try {
      let tracks = getCachedTracks();
      if (!tracks || tracks.length === 0) {
        const vid = getCurrentVideoId();
        if (!vid) return;
        const result = await fetchPlayerResponseFallback(vid);
        if (result.ok && result.data) {
          const captionData = result.data.captions?.playerCaptionsTracklistRenderer;
          if (captionData?.captionTracks) {
            tracks = captionData.captionTracks;
            latestTracksByVideo.set(vid, tracks);
          }
        }
      }
      if (!tracks || tracks.length === 0) return;
      
      // ONLY look for manual Japanese subtitles - NEVER use ASR
      const track = tracks.find(t => JAPANESE_LANG_RE.test(t.languageCode) && t.kind !== 'asr');
      
      if (!track) {
        console.log('[romaji] no MANUAL Japanese subtitles found - ASR subtitles are not supported');
        showToast('No manual Japanese subtitles available. Auto-generated subtitles are not supported.', 'error');
        return;
      }
      
      console.log('[romaji] found manual Japanese track:', track.languageCode);
      
      // yt-dlp methodology: use baseUrl directly from track (no CC button toggling)
      if (!track.baseUrl) {
        console.error('[romaji] track missing baseUrl:', track);
        showToast('Subtitle URL not available', 'error');
        return;
      }
      
      console.log('[romaji] fetching captions for validation using track baseUrl');
      console.log('[romaji] track details - languageCode:', track.languageCode, 'kind:', track.kind || 'manual', 'baseUrl length:', track.baseUrl.length);
      
      // Fetch using yt-dlp's proven format fallback strategy (manual subtitles only)
      const sampleValidation = await fetchCaptionsWithFallback(track.baseUrl);
      if (!sampleValidation.ok) {
        console.error('[romaji] validation fetch failed:', sampleValidation.error);
        
        // Better error messaging based on failure type (yt-dlp approach)
        if (sampleValidation.needsPoToken) {
          throw new Error(
            'Unable to access subtitles. This video may require additional authentication. ' +
            'Try refreshing the page while logged into YouTube, or check if the video is geo-restricted.'
          );
        }
        
        throw new Error('Failed to fetch subtitles: ' + (sampleValidation.error || 'Unknown error'));
      }
      
      const sampleCues = parseTimedTextAuto(sampleValidation.tag, sampleValidation.body);
      if (sampleCues.length === 0) {
        console.error('[romaji] no cues parsed from response');
        throw new Error('No subtitle content found');
      }
      
      const sampleText = sampleCues.slice(0, 5).map(c => c.text).join(' ');
      const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(sampleText);
      if (!hasJapanese) { 
        console.warn('[romaji] subtitles are not Japanese, sample:', sampleText);
        showToast('Selected subtitles are not Japanese', 'error'); 
        return; 
      }
      const trackName = (track.name && track.name.simpleText) || track.languageCode || 'Unknown';
      console.log(`[romaji] selected manual track: ${trackName}`);
      const vid = getCurrentVideoId();
      const cached = romanizationCache.get(vid);
      if (cached?.status === 'ready') {
        showOverlay(cached.cues);
      } else if (cached?.status === 'pending') {
        showProgressOverlay('Romanization in progress...');
        let progressValue = 15;
        const progressInterval = setInterval(() => {
          const remaining = 82 - progressValue;
          const increment = remaining > 30 ? Math.random() * 0.8 : Math.random() * 0.3;
          progressValue = Math.min(82, progressValue + increment);
          updateProgressOverlay(progressValue);
        }, 1000);
        
        const checkInterval = setInterval(() => {
          const updated = romanizationCache.get(vid);
          if (updated?.status === 'ready') {
            clearInterval(checkInterval);
            clearInterval(progressInterval);
            updateProgressOverlay(100);
            setTimeout(() => {
              showOverlay(updated.cues);
              setTimeout(() => hideProgressOverlay(), 800);
            }, 300);
          } else if (updated?.status === 'error') {
            clearInterval(checkInterval);
            clearInterval(progressInterval);
            hideProgressOverlay();
            showToast(`Romanization failed: ${updated.error}`, 'error');
          }
        }, 500);
      } else if (cached?.status === 'error') {
        showToast(`Romanization failed: ${cached.error}`, 'error');
      } else {
        showProgressOverlay('Starting romanization...');
        updateProgressOverlay(5);
        startProactiveRomanization(vid, tracks);
        
        let progressValue = 10;
        const progressInterval = setInterval(() => {
          const remaining = 82 - progressValue;
          const increment = remaining > 30 ? Math.random() * 0.8 : Math.random() * 0.3;
          progressValue = Math.min(82, progressValue + increment);
          updateProgressOverlay(progressValue);
        }, 1000);
        
        const checkInterval = setInterval(() => {
          const updated = romanizationCache.get(vid);
          if (updated?.status === 'ready') {
            clearInterval(checkInterval);
            clearInterval(progressInterval);
            updateProgressOverlay(100);
            setTimeout(() => {
              showOverlay(updated.cues);
              setTimeout(() => hideProgressOverlay(), 800);
            }, 300);
          } else if (updated?.status === 'error') {
            clearInterval(checkInterval);
            clearInterval(progressInterval);
            hideProgressOverlay();
            showToast(`Romanization failed: ${updated.error}`, 'error');
          }
        }, 500);
      }
    } catch (err) {
      console.error("[romaji] onSelectRomaji error:", err);
      showToast('Caption load error', 'error');
    } finally {
      activeRomanization = null;
    }
  })();
  return activeRomanization;
}

// Fetch captions using yt-dlp's proven strategy (lines 3986-3996, 147)
// MANUAL SUBTITLES ONLY - ASR is NOT supported
// Priority: baseUrl as-is → format fallback sequence → error with PO token detection
async function fetchCaptionsWithFallback(baseUrl) {
  if (!baseUrl) {
    throw new Error('No baseUrl provided');
  }
  
  // DEBUG: Log the original baseUrl parameters
  console.log('[romaji] fetchCaptionsWithFallback called (MANUAL subtitles only)');
  console.log('[romaji] ORIGINAL baseUrl (first 200 chars):', baseUrl.substring(0, 200));
  try {
    const urlObj = new URL(baseUrl);
    console.log('[romaji] baseUrl has parameters:', {
      v: urlObj.searchParams.get('v'),
      lang: urlObj.searchParams.get('lang'),
      fmt: urlObj.searchParams.get('fmt'),
      xosf: urlObj.searchParams.get('xosf'),
      hasPot: urlObj.searchParams.has('pot'),
      hasSig: urlObj.searchParams.has('signature') || urlObj.searchParams.has('sig')
    });
  } catch (e) {
    console.error('[romaji] failed to parse baseUrl:', e);
  }
  
  console.log('[romaji] fetchCaptionsWithFallback - baseUrl length:', baseUrl.length);
  
  // MANUAL subtitles ONLY - use yt-dlp's format order for manual tracks (line 147)
  const formats = ['json3', 'srv1', 'srv2', 'srv3', 'ttml', 'vtt'];
  
  // yt-dlp philosophy: Just try everything. Don't check for PO tokens upfront.
  
  // ALWAYS try baseUrl as-is first (YouTube may have already set optimal fmt)
  console.log('[romaji] trying baseUrl UNMODIFIED (YouTube\'s default format)...');
  console.log('[romaji] EXACT URL being fetched:', baseUrl);
  let result = await fetchRaw(baseUrl);
  let lastStatus = result.status;
  
  if (result.ok && result.text && result.text.trim().length > 0) {
    console.log('[romaji] SUCCESS with baseUrl as-is, length:', result.text.length);
    return { ok: true, tag: 'as-is', body: result.text, ct: result.ct };
  }
  
  // Log warning but keep trying (yt-dlp behavior)
  if (lastStatus === 403 || lastStatus === 401) {
    console.warn('[romaji] baseUrl returned', lastStatus, '- trying format variations...');
  } else {
    console.log('[romaji] baseUrl as-is failed - ok:', result.ok, 'length:', result.text?.length || 0);
  }
  
  // Try each format in order, stop at first non-empty success (yt-dlp behavior)
  for (const fmt of formats) {
    const url = buildTimedTextUrl(baseUrl, { fmt });
    console.log(`[romaji] trying fmt=${fmt}...`);
    console.log('[romaji] EXACT URL being fetched:', url);
    
    result = await fetchRaw(url);
    lastStatus = result.status;
    
    if (result.ok && result.text && result.text.trim().length > 0) {
      console.log(`[romaji] SUCCESS with fmt=${fmt}, length:`, result.text.length);
      return { ok: true, tag: fmt, body: result.text, ct: result.ct };
    }
    console.log(`[romaji] fmt=${fmt} failed - ok:`, result.ok, 'status:', result.status, 'length:', result.text?.length || 0);
  }
  
  // ONLY NOW report the error (after all attempts exhausted)
  // yt-dlp lines 4050-4053: Reports skipped subtitles but tries next client
  console.error('[romaji] all format attempts failed, last status:', lastStatus);
  
  if (lastStatus === 403) {
    console.error('[romaji] All formats returned 403 - video may require authentication or PO token');
    return { 
      ok: false, 
      error: 'Access denied. This video may require authentication or be geo-restricted.',
      needsPoToken: true,
      status: lastStatus
    };
  }
  
  if (lastStatus === 401) {
    console.error('[romaji] All formats returned 401 - authentication required');
    return {
      ok: false,
      error: 'Authentication required. You may need to be logged into YouTube.',
      needsPoToken: true,
      status: lastStatus
    };
  }
  
  return { 
    ok: false, 
    error: 'All format attempts returned empty responses',
    status: lastStatus
  };
}

// Legacy function - redirects to baseUrl extraction + yt-dlp fetch
// DEPRECATED: Prefer getting baseUrl from track and calling fetchCaptionsWithFallback directly
async function fetchCaptionsUsingSniff() {
  console.log('[romaji] fetchCaptionsUsingSniff (LEGACY) - MANUAL subtitles only');
  
  // Get baseUrl from track (no sniffing needed, manual only)
  const baseUrl = await getTimedtextUrlFromTrack();
  if (!baseUrl) {
    throw new Error('Could not get timedtext baseUrl from track');
  }
  
  console.log('[romaji] using track baseUrl (length:', baseUrl.length, ')');
  
  // Use yt-dlp strategy (manual subtitles only)
  return await fetchCaptionsWithFallback(baseUrl);
}

async function getTimedtextUrlFromTrack() {
  const vid = getCurrentVideoId();
  if (!vid) return null;
  
  let tracks = getCachedTracks();
  
  if (!tracks || tracks.length === 0) {
    console.log('[romaji] no cached tracks, fetching playerResponse');
    const result = await fetchPlayerResponseFallback(vid);
    if (result.ok && result.data) {
      const captionData = result.data.captions?.playerCaptionsTracklistRenderer;
      if (captionData?.captionTracks) {
        tracks = captionData.captionTracks;
        latestTracksByVideo.set(vid, tracks);
        console.log('[romaji] fetched', tracks.length, 'tracks from playerResponse');
      }
    }
  }
  
  if (!tracks || tracks.length === 0) {
    console.warn('[romaji] no tracks available');
    return null;
  }
  
  console.log('[romaji] available tracks:', tracks.map(t => `${t.languageCode} (${t.kind || 'manual'})`).join(', '));
  
  // ONLY find MANUAL Japanese subtitles - NO ASR support
  const track = tracks.find(t => JAPANESE_LANG_RE.test(t.languageCode) && t.kind !== 'asr');
  
  if (!track) {
    console.warn('[romaji] no MANUAL Japanese track found (ASR not supported)');
    console.log('[romaji] all tracks:', tracks);
    return null;
  }
  
  if (!track.baseUrl) {
    console.warn('[romaji] track found but no baseUrl:', track);
    return null;
  }
  
  console.log('[romaji] selected MANUAL track:', track.languageCode, 'baseUrl length:', track.baseUrl.length);
  
  return track.baseUrl;
}
// Auto-detect and parse caption text
function parseTimedTextAuto(tag, body) {
  let cues = [];
  if (tag === 'json3' || tag === 'srv3') {
    cues = parseJson3(body);
    if (cues.length > 0) return cues;
  }
  if (tag === 'vtt' || tag === 'asis') {
    cues = parseVtt(body);
    if (cues.length > 0) return cues;
  }
  if (tag === 'ttml') {
    cues = parseTtml(body);
    if (cues.length > 0) return cues;
  }
  cues = parseJson3(body);
  if (cues.length > 0) return cues;
  cues = parseVtt(body);
  if (cues.length > 0) return cues;
  return parseTtml(body);
}

// Fallback: fetch playerResponse via youtubei API
function fetchPlayerResponseFallback(videoId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { 
        type: 'FETCH_PLAYER_RESPONSE', 
        videoId, 
        ytcfg: {
          clientName: latestYtCfg.INNERTUBE_CLIENT_NAME || 'WEB',
          clientVersion: latestYtCfg.INNERTUBE_CLIENT_VERSION,
          visitor: latestYtCfg.VISITOR_DATA,
          hl: latestYtCfg.HL || 'en',
          gl: latestYtCfg.GL || 'US'
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error('[romaji] FETCH_PLAYER_RESPONSE error:', chrome.runtime.lastError);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'No response from background' });
        }
      }
    );
  });
}

async function onSelectCustom(storageKey) {
  console.log("[romaji] onSelectCustom triggered, key:", storageKey);
  const rec = await storageGet(storageKey);
  
  if (!rec || !rec.cues) {
    console.warn("[romaji] custom track not found or has no cues");
    return;
  }
  
  console.log("[romaji] custom track loaded, cues:", rec.cues.length);
  showOverlay(rec.cues);
}

// ============================================================================
// CAPTION PARSERS
// ============================================================================

// Parse VTT format
function parseVtt(vttText) {
  const cues = [];
  const lines = vttText.replace(/\r/g, '').split('\n');
  let i = 0;
  function parseTime(str) {
    const s = str.trim().replace(',', '.');
    const main = s.split(/\s+/)[0];
    const parts = main.split(':');
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10) || 0;
      const m = parseInt(parts[1], 10) || 0;
      const sec = parseFloat(parts[2]) || 0;
      return h * 3600 + m * 60 + sec;
    }
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10) || 0;
      const sec = parseFloat(parts[1]) || 0;
      return m * 60 + sec;
    }
    const f = parseFloat(main);
    return isNaN(f) ? 0 : f;
  }
  while (i < lines.length && !lines[i].includes('-->')) i++;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->');
      const start = parseTime(startStr);
      const end = parseTime(endStr);
      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim()) {
        const t = lines[i].replace(/^\d+$/, '').trim();
        if (t) textLines.push(t);
        i++;
      }
      const text = textLines.join('\n').trim();
      if (text) cues.push({ start, end, text });
    }
    i++;
  }
  return cues;
}

// Parse JSON3/SRV3 format (YouTube auto-generated format)
function parseJson3(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    const cues = [];
    
    if (Array.isArray(data.events)) {
      for (const ev of data.events) {
        const startMs = ev.tStartMs || 0;
        const durMs = ev.dDurationMs || 0;
        const endMs = startMs + durMs;
        
        let text = '';
        if (ev.segs && Array.isArray(ev.segs)) {
          text = ev.segs.map(s => s.utf8 || '').join('');
        } else if (ev.utf8) {
          text = ev.utf8;
        }
        
        text = text.trim();
        if (text) {
          cues.push({
            start: startMs / 1000,
            end: endMs / 1000,
            text: text
          });
        }
      }
    }
    
    return cues;
  } catch (err) {
    console.warn('[romaji] JSON3 parse error:', err);
    return [];
  }
}

// Parse TTML format
function parseTtml(ttmlText) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(ttmlText, 'text/xml');
    const cues = [];
    function parseClockOrOffset(v) {
      if (!v) return 0;
      const s = String(v).trim();
      if (/^\d+(?:\.\d+)?s$/i.test(s)) {
        return parseFloat(s) || 0;
      }
      if (/^\d+(?:\.\d+)?ms$/i.test(s)) {
        return (parseFloat(s) || 0) / 1000;
      }
      if (s.includes(':')) {
        const parts = s.split(':');
        if (parts.length === 3) {
          const h = parseInt(parts[0], 10) || 0;
          const m = parseInt(parts[1], 10) || 0;
          const sec = parseFloat(parts[2]) || 0;
          return h * 3600 + m * 60 + sec;
        }
        if (parts.length === 2) {
          const m = parseInt(parts[0], 10) || 0;
          const sec = parseFloat(parts[1]) || 0;
          return m * 60 + sec;
        }
      }
      const num = parseFloat(s);
      if (!isNaN(num)) {
        return num >= 1000 ? num / 1000 : num;
      }
      return 0;
    }
    let elements = doc.querySelectorAll('text');
    if (elements.length === 0) elements = doc.querySelectorAll('p');
    for (const elem of elements) {
      const start = parseClockOrOffset(elem.getAttribute('start') || elem.getAttribute('begin'));
      const dur = parseClockOrOffset(elem.getAttribute('dur') || elem.getAttribute('duration'));
      const end = elem.hasAttribute('end') ? parseClockOrOffset(elem.getAttribute('end')) : (start + dur);
      const text = (elem.textContent || '').trim();
      if (text) cues.push({ start, end, text });
    }
    return cues;
  } catch (err) {
    console.warn('[romaji] TTML parse error:', err);
    return [];
  }
}

// ============================================================================
// ROMANIZATION
// ============================================================================

async function romanizeCues(cues, showProgress = true) {
  if (!cues?.length) return cues;
  console.log('[romaji] romanizing', cues.length, 'cues via API');
  
  const videoId = getCurrentVideoId();
  const fullText = cues.map(c => c.text).join('\n');
  
  if (showProgress) {
    showProgressOverlay('Romanizing subtitles...');
    updateProgressOverlay(5);
  }
  
  try {
    if (showProgress) updateProgressOverlay(10);
    
    let progressInterval = null;
    if (showProgress) {
      let currentProgress = 10;
      progressInterval = setInterval(() => {
        const remaining = 80 - currentProgress;
        const increment = remaining > 30 ? Math.random() * 0.8 : Math.random() * 0.3;
        currentProgress = Math.min(80, currentProgress + increment);
        updateProgressOverlay(currentProgress);
      }, 1000);
    }
    
    const response = await fetch('https://youtube-romaji-api.fly.dev/romanize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, text: fullText })
    });
    
    if (progressInterval) clearInterval(progressInterval);
    if (showProgress) updateProgressOverlay(85);
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('[romaji] API response cached:', data.cached);
    
    if (showProgress) updateProgressOverlay(90);
    
    const isTimed = data.timed && (data.vtt || data.segments);
    if (isTimed) {
      console.log('[romaji] using DB-timed romaji');
      
      if (data.vtt && data.segments) {
        console.log('[romaji] both vtt and segments present, preferring vtt');
        const timedCues = parseVtt(data.vtt);
        if (timedCues.length > 0) {
          console.log('[romaji] parsed', timedCues.length, 'timed cues from vtt');
          if (showProgress) {
            updateProgressOverlay(100);
          }
          return timedCues;
        }
        console.log('[romaji] vtt parsing failed, falling back to segments');
      }
      
      if (data.vtt) {
        const timedCues = parseVtt(data.vtt);
        if (timedCues.length > 0) {
          console.log('[romaji] parsed', timedCues.length, 'timed cues from vtt');
          if (showProgress) {
            updateProgressOverlay(100);
          }
          return timedCues;
        }
      }
      
      if (data.segments && Array.isArray(data.segments)) {
        console.log('[romaji] using', data.segments.length, 'timed segments');
        if (showProgress) {
          updateProgressOverlay(100);
        }
        return data.segments.map(s => ({
          start: s.start,
          end: s.end,
          text: s.text
        }));
      }
      
      console.warn('[romaji] timed flag set but no valid vtt or segments, falling back to untimed');
    }
    
    if (showProgress) updateProgressOverlay(93);
    
    const romanizedLines = data.romanized.split('\n');
    const r = [];
    for (let i = 0; i < cues.length; i++) {
      r.push({
        start: cues[i].start,
        end: cues[i].end,
        text: romanizedLines[i] || ''
      });
    }
    
    if (showProgress) updateProgressOverlay(96);
    
    const merged = [];
    for (let i = 0; i < r.length; i++) {
      const cue = r[i];
      
      if (!cue.text || cue.text.trim() === '') {
        continue;
      }
      
      let endTime = cue.end;
      while (i + 1 < r.length && r[i + 1].text === cue.text) {
        endTime = r[i + 1].end;
        i++;
      }
      
      merged.push({
        start: cue.start,
        end: endTime,
        text: cue.text
      });
    }
    
    if (merged.length < r.length) {
      console.log(`[romaji] merged ${r.length} cues → ${merged.length} (removed ${r.length - merged.length} duplicate continuation cues)`);
    }
    
    console.log('[romaji] romanized', cues.length, 'cues →', merged.length, 'after merging duplicates');
    
    if (showProgress) {
      updateProgressOverlay(100);
    }
    
    return merged;
  } catch (error) {
    console.error('[romaji] API call failed:', error);
    if (showProgress) hideProgressOverlay();
    showToast('Failed to romanize subtitles. Please try again later.', 'error');
    return cues;
  }
}

// ============================================================================
// OVERLAY RENDERING
// ============================================================================

function ensureOverlay(visible) {
  if (!overlayEl) {
    const playerContainer = document.querySelector('.html5-video-player');
    if (!playerContainer) {
      console.warn('[romaji] no player container found');
      return;
    }
    overlayEl = document.createElement("div");
    overlayEl.id = "romaji-caption-overlay";
    
    overlayEl.style.position = 'absolute';
    overlayEl.style.left = '0';
    overlayEl.style.right = '0';
    overlayEl.style.bottom = '60px';
    overlayEl.style.margin = '0 auto';
    overlayEl.style.width = '100%';
    overlayEl.style.maxWidth = 'none';
    overlayEl.style.padding = '0 12%';
    overlayEl.style.boxSizing = 'border-box';
    overlayEl.style.pointerEvents = 'none';
    overlayEl.style.lineHeight = '1.3';
    overlayEl.style.textAlign = 'center';
    overlayEl.style.zIndex = '68';
    overlayEl.style.whiteSpace = 'pre-wrap';
    overlayEl.style.wordWrap = 'break-word';
    
    playerContainer.appendChild(overlayEl);
    console.log('[romaji] overlay element created and appended');
  }
  
  overlayEl.style.display = visible ? "block" : "none";
  console.log('[romaji] overlay visibility set to:', visible ? 'block' : 'none');
  
  if (visible) {
    applyYouTubeCaptionSettings();
  }
}

function applyYouTubeCaptionSettings() {
  if (!overlayEl) return;
  
  try {
    const settings = getYouTubeCaptionSettings();
    
    overlayEl.style.setProperty('font-family', settings.fontFamily, 'important');
    overlayEl.style.setProperty('color', settings.textColor, 'important');
    overlayEl.style.setProperty('font-size', settings.fontSize, 'important');
    overlayEl.style.setProperty('opacity', settings.textOpacity, 'important');
    
    if (settings.backgroundColor && settings.backgroundOpacity > 0) {
      overlayEl.style.setProperty('background-color', settings.backgroundColor, 'important');
      overlayEl.style.setProperty('padding', '8px 16px', 'important');
      overlayEl.style.setProperty('border-radius', '4px', 'important');
      overlayEl.style.setProperty('display', 'inline-block', 'important');
      overlayEl.style.setProperty('max-width', '80%', 'important');
      overlayEl.style.setProperty('margin', '0 auto', 'important');
    } else {
      overlayEl.style.setProperty('background-color', 'transparent', 'important');
      overlayEl.style.setProperty('padding', '0', 'important');
    }
    
    const edgeStyle = settings.textEdgeStyle;
    if (edgeStyle === 'none') {
      overlayEl.style.setProperty('text-shadow', 'none', 'important');
    } else if (edgeStyle === 'drop-shadow') {
      overlayEl.style.setProperty('text-shadow', '2px 2px 4px rgba(0,0,0,0.9)', 'important');
    } else if (edgeStyle === 'raised') {
      overlayEl.style.setProperty('text-shadow', '1px 1px 0 rgba(0,0,0,0.9), 2px 2px 0 rgba(0,0,0,0.5)', 'important');
    } else if (edgeStyle === 'depressed') {
      overlayEl.style.setProperty('text-shadow', '-1px -1px 0 rgba(0,0,0,0.9), -2px -2px 0 rgba(0,0,0,0.5)', 'important');
    } else {
      overlayEl.style.setProperty('text-shadow', settings.textShadow, 'important');
    }
    
    if (settings.windowColor && settings.windowOpacity > 0) {
      const player = document.querySelector('.html5-video-player');
      if (player && !player.querySelector('#romaji-window-background')) {
        const windowBg = document.createElement('div');
        windowBg.id = 'romaji-window-background';
        windowBg.style.position = 'absolute';
        windowBg.style.left = '0';
        windowBg.style.right = '0';
        windowBg.style.bottom = '60px';
        windowBg.style.height = '120px';
        windowBg.style.backgroundColor = settings.windowColor;
        windowBg.style.opacity = settings.windowOpacity;
        windowBg.style.pointerEvents = 'none';
        windowBg.style.zIndex = '67';
        player.appendChild(windowBg);
      }
    } else {
      const existingBg = document.querySelector('#romaji-window-background');
      if (existingBg) existingBg.remove();
    }
    
  } catch (e) {
    console.error('[romaji] failed to apply caption settings:', e);
  }
}

function getYouTubeCaptionSettings() {
  const defaults = {
    fontFamily: '"YouTube Noto", "Roboto", Arial, Helvetica, sans-serif',
    textColor: 'rgb(255, 255, 255)',
    fontSize: 'min(4.2vw, 28px)',
    textOpacity: '1',
    backgroundColor: 'transparent',
    backgroundOpacity: 0,
    windowColor: 'transparent',
    windowOpacity: 0,
    textEdgeStyle: 'uniform',
    textShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.8)'
  };
  
  try {
    const rawSettings = localStorage.getItem('yt-player-caption-display-settings');
    if (!rawSettings) {
      console.log('[romaji] no saved caption settings, using defaults');
      return defaults;
    }
    
    const parsed = JSON.parse(rawSettings);
    console.log('[romaji] parsed caption settings:', parsed);
    
    const fontMap = {
      0: '"Courier New", Courier, monospace',
      1: '"Times New Roman", Times, serif',
      2: 'Georgia, serif',
      3: '"Arial", Helvetica, sans-serif',
      4: '"Comic Sans MS", "Comic Sans", cursive',
      5: '"Lucida Console", Monaco, monospace',
      6: '"Roboto", Arial, sans-serif',
      7: '"Consolas", "Courier New", monospace'
    };
    
    const edgeMap = {
      0: 'none',
      1: 'uniform',
      2: 'drop-shadow',
      3: 'raised',
      4: 'depressed'
    };
    
    if (parsed.fontSizeIncrement !== undefined) {
      const sizeMap = {
        '-2': 'min(2.8vw, 18px)',
        '-1': 'min(3.5vw, 23px)',
        '0': 'min(4.2vw, 28px)',
        '1': 'min(5.6vw, 37px)',
        '2': 'min(7.0vw, 46px)'
      };
      defaults.fontSize = sizeMap[parsed.fontSizeIncrement] || defaults.fontSize;
    }
    
    if (parsed.textColor !== undefined) {
      defaults.textColor = rgbaFromYT(parsed.textColor);
      console.log('[romaji] applying text color:', defaults.textColor);
    }
    
    if (parsed.textOpacity !== undefined) {
      defaults.textOpacity = String(parsed.textOpacity);
      console.log('[romaji] applying text opacity:', defaults.textOpacity);
    }
    
    if (parsed.background !== undefined) {
      defaults.backgroundColor = rgbaFromYT(parsed.background);
      defaults.backgroundOpacity = parsed.backgroundOpacity !== undefined ? parsed.backgroundOpacity : 0;
      console.log('[romaji] applying background:', defaults.backgroundColor, 'opacity:', defaults.backgroundOpacity);
    }
    
    if (parsed.window !== undefined) {
      defaults.windowColor = rgbaFromYT(parsed.window);
      defaults.windowOpacity = parsed.windowOpacity !== undefined ? String(parsed.windowOpacity) : '0';
      console.log('[romaji] applying window:', defaults.windowColor, 'opacity:', defaults.windowOpacity);
    }
    
    if (parsed.fontFamily !== undefined) {
      defaults.fontFamily = fontMap[parsed.fontFamily] || defaults.fontFamily;
      console.log('[romaji] applying font family:', defaults.fontFamily);
    }
    
    if (parsed.charEdgeStyle !== undefined) {
      const style = edgeMap[parsed.charEdgeStyle];
      defaults.textEdgeStyle = style || 'uniform';
      
      if (style === 'uniform') {
        defaults.textShadow = '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 4px rgba(0,0,0,0.8)';
      } else if (style === 'drop-shadow') {
        defaults.textShadow = '2px 2px 4px rgba(0,0,0,0.9)';
      } else if (style === 'raised') {
        defaults.textShadow = '1px 1px 0 rgba(0,0,0,0.9), 2px 2px 0 rgba(0,0,0,0.5)';
      } else if (style === 'depressed') {
        defaults.textShadow = '-1px -1px 0 rgba(0,0,0,0.9), -2px -2px 0 rgba(0,0,0,0.5)';
      } else if (style === 'none') {
        defaults.textShadow = 'none';
      }
      console.log('[romaji] applying edge style:', style);
    }
    
    return defaults;
    
  } catch (e) {
    console.warn('[romaji] failed to parse caption settings:', e);
    return defaults;
  }
}

function rgbaFromYT(val) {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') {
    const r = (val >> 24) & 0xFF;
    const g = (val >> 16) & 0xFF;
    const b = (val >> 8) & 0xFF;
    const a = (val & 0xFF) / 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return 'rgb(255, 255, 255)';
}

function showOverlay(cues) {
  if (!Array.isArray(cues) || !cues.length) {
    console.warn("[romaji] showOverlay called with empty/invalid cues");
    if (renderer) renderer.stop();
    renderer = null;
    ensureOverlay(false);
    setNativeCaptionsVisible(true);
    isRomajiActive = false;
    updateMenuCheckmarks();
    return;
  }
  
  console.log("[romaji] showing overlay with", cues.length, "cues");
  console.log("[romaji] first cue:", cues[0]);
  
  ensureOverlay(true);
  
  if (!overlayEl) {
    console.error("[romaji] overlay element not created!");
    hideProgressOverlay();
    showToast("Failed to create caption overlay", "error");
    return;
  }
  
  console.log("[romaji] overlay element:", overlayEl);
  console.log("[romaji] overlay display:", overlayEl.style.display);
  console.log("[romaji] overlay visible:", overlayEl.offsetParent !== null);
  
  if (renderer) renderer.stop();
  renderer = new CaptionRenderer(videoEl, overlayEl, cues);
  renderer.start();
  setNativeCaptionsVisible(false);
  isRomajiActive = true;
  updateMenuCheckmarks();
  updateCaptionButton();
  startSubtitleDisplayWatcher();
  
  setTimeout(() => hideProgressOverlay(), 1000);
}

function setNativeCaptionsVisible(visible) {
  const captions = document.querySelector('.ytp-caption-window-container');
  if (captions) {
    captions.style.display = visible ? '' : 'none';
  }
  
  const subtitles = document.querySelectorAll('.caption-window');
  subtitles.forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
  
  if (!visible) {
    const player = document.querySelector('.html5-video-player');
    if (player) {
      player.classList.remove('ytp-show-captions-button');
    }
  }
}

function updateMenuCheckmarks() {
  const romajiItem = document.querySelector('[data-romaji-entry="romaji:auto"]');
  if (!romajiItem) return;
  
  romajiItem.setAttribute('aria-checked', isRomajiActive ? 'true' : 'false');
  
  if (isRomajiActive) {
    document.body.classList.add('romaji-active');
    
    const nativeItems = document.querySelectorAll('.ytp-menuitem[role="menuitemradio"]:not([data-romaji-entry])');
    nativeItems.forEach(item => {
      item.setAttribute('aria-checked', 'false');
    });
    
            updateSubtitleDisplay('Romaji');
  } else {
    document.body.classList.remove('romaji-active');
  }
}

function updateSubtitleDisplay(text) {
  const subtitleMenuItem = Array.from(document.querySelectorAll('.ytp-menuitem')).find(item => {
    const label = item.querySelector('.ytp-menuitem-label');
    return label && label.textContent.includes('Subtitles/CC');
  });
  
  if (subtitleMenuItem) {
    const contentEl = subtitleMenuItem.querySelector('.ytp-menuitem-content');
    if (contentEl) {
      contentEl.textContent = text;
    }
  }
}

function updateSubtitleCount() {
  const subtitleMenuItem = Array.from(document.querySelectorAll('.ytp-menuitem')).find(item => {
    const label = item.querySelector('.ytp-menuitem-label');
    return label && label.textContent.includes('Subtitles/CC');
  });
  
  if (subtitleMenuItem) {
    const countEl = subtitleMenuItem.querySelector('.ytp-menuitem-label-count');
    if (countEl) {
      const tracks = getCachedTracks();
      const hasJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || ""));
      const match = countEl.textContent.match(/\d+/);
      
      if (match && hasJa) {
        const currentCount = parseInt(match[0]);
        const originalCount = countEl.getAttribute('data-original-count');
        
        if (!originalCount) {
          countEl.setAttribute('data-original-count', currentCount);
          countEl.textContent = ` (${currentCount + 1})`;
        } else {
          const baseCount = parseInt(originalCount);
          countEl.textContent = ` (${baseCount + 1})`;
        }
      }
    }
  }
}

function updateCaptionButton() {
  setTimeout(() => {
    const captionDisplay = document.querySelector('.ytp-subtitles-button .ytp-subtitles-button-text');
    if (captionDisplay && isRomajiActive) {
      captionDisplay.textContent = 'Romaji';
    }
  }, 100);
}

class CaptionRenderer {
  constructor(video, host, cues) {
    this.video = video;
    this.host = host;
    this.cues = cues;
    this.raf = null;
    this.index = 0;
    this.active = -1;
    this.settingsCheckInterval = null;
  }
  
  start() {
    this.stop();
    console.log('[romaji] CaptionRenderer starting with', this.cues.length, 'cues');
    console.log('[romaji] video element:', this.video);
    console.log('[romaji] host element:', this.host);
    
    applyYouTubeCaptionSettings();
    
    this.settingsCheckInterval = setInterval(() => {
      applyYouTubeCaptionSettings();
    }, 500);
    
    const loop = () => {
      const t = this.video.currentTime;
      let i = this.index;
      while (i < this.cues.length && this.cues[i].end < t - 0.02) i++;
      while (i > 0 && this.cues[i - 1].start > t) i--;
      this.index = i;
      
      const cue = this.cues[i];
      if (cue && t >= cue.start && t <= cue.end) {
        if (this.active !== i) {
          this.active = i;
          this.host.textContent = cue.text;
          if (i < 5) {
            console.log('[romaji] showing cue', i, ':', cue.text.substring(0, 50));
          }
        }
      } else {
        if (this.active !== -1) {
          this.active = -1;
          this.host.textContent = "";
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    console.log('[romaji] CaptionRenderer loop started');
  }
  
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.settingsCheckInterval) clearInterval(this.settingsCheckInterval);
    this.raf = null;
    this.settingsCheckInterval = null;
    this.host.textContent = "";
    this.index = 0;
    this.active = -1;
    setNativeCaptionsVisible(true);
    
    const windowBg = document.querySelector('#romaji-window-background');
    if (windowBg) windowBg.remove();
  }
}

// ============================================================================
// STORAGE & CUSTOM TRACKS
// ============================================================================

async function listCustomTracks() {
  const vid = getCurrentVideoId();
  if (!vid) return [];
  
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith("subs:" + vid + ":") && v && typeof v === "object")
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => {
      const at = a.value && a.value.ts ? a.value.ts : 0;
      const bt = b.value && b.value.ts ? b.value.ts : 0;
      if (at !== bt) return bt - at;
      const an = (a.value && a.value.name) ? a.value.name.toLowerCase() : "";
      const bn = (b.value && b.value.name) ? b.value.name.toLowerCase() : "";
      return an.localeCompare(bn);
    });
}

function storageGet(key) { return chrome.storage.local.get([key]).then(v => v[key]); }

