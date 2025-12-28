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
let romajiTextTrack = null; // Native TextTrack for romanized subtitles
let captionStyleObserver = null; // Observes YouTube's caption style changes
let lastAppliedStyles = {}; // Cache of last applied styles

let latestTracksByVideo = new Map();
let latestYtCfg = {};
let lastVideoId = null;

let lastTimedtextUrl = null;
let lastTimedtextUrlASR = null;
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

(function installTimedtextSniffer() {
  if (window.__romajiSnifferInstalled) return;
  window.__romajiSnifferInstalled = true;

  const TIMEDTEXT_RE = /(\/api\/timedtext|[?&]t?imedtext\b)/i;

  const _fetch = window.fetch;
  window.fetch = function(input) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url && TIMEDTEXT_RE.test(url)) {
        window.postMessage({ source: 'romaji-bridge', type: 'TIMEDTEXT_URL', url }, '*');
      }
    } catch (e) {
      console.error('[romaji] fetch wrapper error:', e);
    }
    return _fetch.apply(this, arguments);
  };

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (url && TIMEDTEXT_RE.test(url)) {
        window.postMessage({ source: 'romaji-bridge', type: 'TIMEDTEXT_URL', url }, '*');
      }
    } catch (e) {
      console.error('[romaji] XHR wrapper error:', e);
    }
    return _open.apply(this, arguments);
  };
})();

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

// Extract video ID from a timedtext URL
function extractVideoIdFromTimedtextUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('v') || null;
  } catch (e) {
    console.error('[romaji] extractVideoIdFromTimedtextUrl error:', e);
    return null;
  }
}

// Helper to modify only the fmt parameter
function withFmt(urlStr, fmt) {
  try {
    const u = new URL(urlStr);
    if (fmt == null) {
      u.searchParams.delete('fmt');
    } else {
      u.searchParams.set('fmt', fmt);
    }
    return u.toString();
  } catch {
    return urlStr;
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
    
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const text = await res.text();
    const ok = res.ok && text.trim().length > 0;
    return { ok, text, ct: res.headers.get('content-type') || '' };
  } catch (err) {
    return { ok: false, text: '', ct: '', error: err.message };
  }
}

// ============================================================================
// PROACTIVE ROMANIZATION
// ============================================================================

const romanizationCache = new Map(); // videoId -> { status: 'pending'|'ready'|'error', cues: [...] }

async function startProactiveRomanization(videoId, tracks) {
  const japaneseTrack = tracks.find(t => JAPANESE_LANG_RE.test(t.languageCode) && t.kind !== 'asr');
  
  if (!japaneseTrack) {
    console.log('[romaji] no manual Japanese track for proactive romanization');
    return;
  }
  
  if (romanizationCache.has(videoId)) {
    console.log('[romaji] already romanizing or romanized:', videoId);
    return;
  }
  
  console.log('[romaji] starting proactive romanization for:', videoId);
  romanizationCache.set(videoId, { status: 'pending', cues: null });
  
  try {
    const fetchResult = await fetchCaptionsUsingSniff();
    if (!fetchResult.ok) {
      throw new Error(fetchResult.error);
    }
    
    // CRITICAL FIX: Validate we're still on the same video after async fetch
    if (getCurrentVideoId() !== videoId) {
      console.warn('[romaji] video changed during proactive romanization, aborting');
      romanizationCache.delete(videoId);
      return;
    }
    
    const cues = parseTimedTextAuto(fetchResult.tag, fetchResult.body);
    if (cues.length === 0) {
      throw new Error('No cues parsed');
    }
    
    const romanizedCues = await romanizeCues(cues);
    
    // CRITICAL FIX: Validate again after romanization (could take several seconds)
    if (getCurrentVideoId() !== videoId) {
      console.warn('[romaji] video changed during romanization, discarding result');
      romanizationCache.delete(videoId);
      return;
    }
    
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
    const currentVideoId = getCurrentVideoId();
    
    // CRITICAL FIX: Validate that the sniffed URL belongs to the current video
    const urlVideoId = extractVideoIdFromTimedtextUrl(d.url);
    if (urlVideoId && urlVideoId !== currentVideoId) {
      console.warn('[romaji] ignoring timedtext URL for different video:', urlVideoId, '!==', currentVideoId);
      return;
    }
    
    lastVideoIdForTimedtext = currentVideoId;
    
    if (d.isASR) {
      lastTimedtextUrlASR = d.url;
      console.log('[romaji] sniffed ASR timedtext url (will use as fallback)');
    } else {
      lastTimedtextUrl = d.url;
      console.log('[romaji] sniffed manual timedtext url:', lastTimedtextUrl);
    }
    
    try {
      if (lastTimedtextUrl || lastTimedtextUrlASR) {
        const videoId = getCurrentVideoId();
        const tracks = latestTracksByVideo.get(videoId);
        if (tracks && tracks.length > 0) {
          startProactiveRomanization(videoId, tracks);
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
  
  // CRITICAL FIX: Handle initial load AND actual navigation
  // Skip if same video (handles yt-navigate-finish firing multiple times)
  if (newVideoId && newVideoId === videoId) {
    console.log("[romaji] same video detected, ignoring duplicate navigation event");
    return;
  }
  
  // Update tracking
  const oldVideoId = videoId;
  videoId = newVideoId;
  console.log("[romaji] navigation detected, videoId:", videoId, "(was:", oldVideoId, ")");
  
  tracksLoggedThisNav = false;
  
  // CRITICAL FIX: Only clear URLs if actually changing videos (not initial load)
  if (oldVideoId && oldVideoId !== newVideoId) {
    lastTimedtextUrl = null;
    lastTimedtextUrlASR = null;
    lastVideoIdForTimedtext = null;
    console.log("[romaji] cleared timedtext URLs for new video");
  }
  
  // Stop all caption style observers
  stopCaptionStyleObserver();
  if (overlayEl) {
    cleanupPositionObserver(overlayEl);
  }
  
  // Clear native TextTrack
  clearRomajiTextTrack();
  
  // Clear legacy overlay renderer
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
        const hasJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || ""));
        
        if (hasJa) {
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
              const hasJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || ""));
              
              if (hasJa) {
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
    if (isRomajiActive && contentEl.textContent !== 'Romaji') {
      contentEl.textContent = 'Romaji';
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
  const hasJa = tracks.some(t => JAPANESE_LANG_RE.test(t.languageCode || ""));
  console.log('[romaji] has Japanese track:', hasJa);
  
  if (hasJa) {
    console.log('[romaji] adding Romaji menu item');
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
  
  if (isRomajiActive) {
    setTimeout(() => updateSubtitleDisplay('Romaji'), 0);
  }
  
  menuEl.querySelectorAll('.ytp-menuitem[role="menuitemradio"]').forEach(item => {
    if (!item.hasAttribute('data-romaji-entry')) {
      item.addEventListener('click', () => {
        if (isRomajiActive) {
          console.log('[romaji] user switched to native caption, turning off romaji');
          
          // Stop all observers
          stopCaptionStyleObserver();
          if (overlayEl) {
            cleanupPositionObserver(overlayEl);
          }
          
          // Clear native TextTrack
          clearRomajiTextTrack();
          
          // Clear legacy overlay renderer
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
// TIMEDTEXT URL SNIFFER & CC TOGGLE
// ============================================================================

// Ensure we have a sniffed timedtext URL by toggling CC if needed
async function ensureSniffedTimedtextUrl() {
  const currentVid = getCurrentVideoId();
  
  // CRITICAL FIX: Double-check video ID in the URL itself
  if (lastTimedtextUrl && lastVideoIdForTimedtext === currentVid) {
    const urlVideoId = extractVideoIdFromTimedtextUrl(lastTimedtextUrl);
    if (urlVideoId === currentVid) {
      return true;
    } else {
      console.warn('[romaji] lastTimedtextUrl video ID mismatch, clearing:', urlVideoId, '!==', currentVid);
      lastTimedtextUrl = null;
      lastVideoIdForTimedtext = null;
    }
  }
  
  if (lastTimedtextUrlASR && lastVideoIdForTimedtext === currentVid) {
    const urlVideoId = extractVideoIdFromTimedtextUrl(lastTimedtextUrlASR);
    if (urlVideoId === currentVid) {
      console.log('[romaji] using ASR URL as fallback (no manual URL captured)');
      lastTimedtextUrl = lastTimedtextUrlASR;
      return true;
    } else {
      console.warn('[romaji] lastTimedtextUrlASR video ID mismatch, clearing:', urlVideoId, '!==', currentVid);
      lastTimedtextUrlASR = null;
      lastVideoIdForTimedtext = null;
    }
  }
  
  // Try to enable CC to trigger a timedtext request
  const ccBtn = document.querySelector('.ytp-subtitles-button');
  if (!ccBtn) {
    console.warn('[romaji] CC button not found');
    return false;
  }
  
  const wasActive = ccBtn.classList.contains('ytp-subtitles-button-active');
  
  // Click CC button to turn on captions (triggers timedtext request)
  if (!wasActive) {
    ccBtn.click();
  }
  
  // Wait up to 2 seconds for the sniffer to capture the URL
  const start = performance.now();
  while (!lastTimedtextUrl && performance.now() - start < 2000) {
    await sleep(100);
    
    // CRITICAL FIX: Abort if video changes while waiting
    if (getCurrentVideoId() !== currentVid) {
      console.warn('[romaji] video changed while waiting for timedtext URL');
      return false;
    }
  }
  
  // Leave CC on to keep requests flowing
  return !!lastTimedtextUrl;
}

// ============================================================================
// CAPTION SELECTION & FETCHING
// ============================================================================

async function onSelectRomaji() {
  console.log("[romaji] onSelectRomaji triggered");
  
  if (isRomajiActive) {
    console.log("[romaji] toggling off romaji");
    
    // Stop all observers
    stopCaptionStyleObserver();
    if (overlayEl) {
      cleanupPositionObserver(overlayEl);
    }
    
    // Clear native TextTrack
    clearRomajiTextTrack();
    
    // Clear legacy overlay renderer
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
  
  if (activeRomanization) {
    console.log("[romaji] romanization already in progress, ignoring");
    return;
  }
  
  activeRomanization = (async () => {
    try {
    const initialVideoId = getCurrentVideoId();
    if (!initialVideoId) {
      console.log("[romaji] no videoId available");
      return;
    }
    
    let tracks = getCachedTracks();
    
    // If no tracks from bridge, try youtubei fallback
    if (!tracks || tracks.length === 0) {
      console.log("[romaji] no tracks from bridge, trying youtubei fallback");
      
      const result = await fetchPlayerResponseFallback(initialVideoId);
      
      // CRITICAL FIX: Check if video changed during async operation
      if (getCurrentVideoId() !== initialVideoId) {
        console.warn('[romaji] video changed during track fetch, aborting');
        return;
      }
      
      if (result.ok && result.data) {
        const captionData = result.data.captions?.playerCaptionsTracklistRenderer;
        if (captionData?.captionTracks) {
          tracks = captionData.captionTracks;
          latestTracksByVideo.set(initialVideoId, tracks);
          console.log("[romaji] youtubei fallback provided tracks:", tracks.length);
        }
      }
    }
    
    if (!tracks || tracks.length === 0) {
      console.log("[romaji] no tracks available");
      return;
    }
    
    // Find Japanese track - MANUAL ONLY (no auto-generated)
    let track = tracks.find(t => JAPANESE_LANG_RE.test(t.languageCode) && t.kind !== 'asr');
    
    if (!track) {
      console.log("[romaji] no manual Japanese track found");
      alert('No manual Japanese subtitles found. Auto-generated subtitles are not supported.');
      return;
    }
    
    // CRITICAL: Validate that we actually have Japanese content
    // Fetch a sample to ensure we didn't grab English subs mislabeled as Japanese
    const sampleValidation = await fetchCaptionsUsingSniff();
    
    // CRITICAL FIX: Check if video changed during async fetch
    if (getCurrentVideoId() !== initialVideoId) {
      console.warn('[romaji] video changed during caption fetch, aborting');
      return;
    }
    
    if (!sampleValidation.ok) {
      throw new Error('Failed to fetch sample subtitles for validation');
    }
    
    const sampleCues = parseTimedTextAuto(sampleValidation.tag, sampleValidation.body);
    if (sampleCues.length === 0) {
      throw new Error('No subtitle content found');
    }
    
    // Check first few lines for Japanese characters
    const sampleText = sampleCues.slice(0, 5).map(c => c.text).join(' ');
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(sampleText);
    
    if (!hasJapanese) {
      console.error("[romaji] subtitle validation FAILED - no Japanese characters detected");
      console.error("[romaji] sample text:", sampleText.substring(0, 100));
      alert('The selected subtitles do not contain Japanese text. Please ensure Japanese subtitles are available.');
      return;
    }
    
    console.log(`[romaji] subtitle validation PASSED - Japanese content confirmed`);
    
    const trackName = (track.name && track.name.simpleText) || track.languageCode || 'Unknown';
    console.log(`[romaji] selected manual track: ${trackName}`);
    
    const vid = getCurrentVideoId();
    
    // CRITICAL FIX: Final check before proceeding
    if (vid !== initialVideoId) {
      console.warn('[romaji] video changed during processing, aborting');
      return;
    }
    
    const cached = romanizationCache.get(vid);
    
    if (cached?.status === 'ready') {
      console.log('[romaji] using proactively romanized cues');
      showOverlay(cached.cues);
    } else if (cached?.status === 'pending') {
      console.log('[romaji] romanization in progress, waiting for completion');
      alert('Subtitles are currently being romanized and will be displayed once finished.');
      
      const checkInterval = setInterval(() => {
        const updated = romanizationCache.get(vid);
        if (updated?.status === 'ready') {
          clearInterval(checkInterval);
          console.log('[romaji] romanization complete, showing overlay');
          showOverlay(updated.cues);
        } else if (updated?.status === 'error') {
          clearInterval(checkInterval);
          console.error('[romaji] romanization failed:', updated.error);
          alert(`Failed to romanize subtitles: ${updated.error}`);
        }
      }, 500);
    } else if (cached?.status === 'error') {
      console.error('[romaji] proactive romanization failed:', cached.error);
      alert(`Failed to romanize subtitles: ${cached.error}`);
    } else {
      console.log('[romaji] no proactive romanization found, starting now');
      startProactiveRomanization(vid, tracks);
      alert('Subtitles are being romanized and will be displayed once finished.');
      
      const checkInterval = setInterval(() => {
        const updated = romanizationCache.get(vid);
        if (updated?.status === 'ready') {
          clearInterval(checkInterval);
          console.log('[romaji] romanization complete, showing overlay');
          showOverlay(updated.cues);
        } else if (updated?.status === 'error') {
          clearInterval(checkInterval);
          console.error('[romaji] romanization failed:', updated.error);
          alert(`Failed to romanize subtitles: ${updated.error}`);
        }
      }, 500);
    }
    } catch (err) {
      console.error("[romaji] onSelectRomaji error:", err);
      alert('An error occurred while loading captions. Check the console for details.');
    } finally {
      activeRomanization = null;
    }
  })();
  
  return activeRomanization;
}

// Fetch captions using sniffed URL, trying different formats
async function fetchCaptionsUsingSniff() {
  // Ensure we have a sniffed timedtext URL
  if (!await ensureSniffedTimedtextUrl()) {
    throw new Error('Could not capture YouTube timedtext URL (pot)');
  }
  
  // Format strategies for manual subtitles only
  const order = [null, 'vtt', 'ttml', 'json3'];  // null === as-is
  
  for (const fmt of order) {
    const url = fmt ? withFmt(lastTimedtextUrl, fmt) : lastTimedtextUrl;
    const fmtLabel = fmt ?? 'asis';
    
    console.log(`[romaji] trying ${fmtLabel}...`);
    const r = await fetchRaw(url);
    
    if (r.ok) {
      return { ok: true, tag: fmtLabel, body: r.text, ct: r.ct };
    }
  }
  
  throw new Error('All format attempts returned empty');
}

// Auto-detect and parse caption text
function parseTimedTextAuto(tag, body) {
  // Try format based on tag
  if (tag === 'json3' || tag === 'srv3') {
    const cues = parseJson3(body);
    if (cues.length > 0) return cues;
  }
  
  if (tag === 'vtt' || tag === 'asis') {
    const cues = parseVtt(body);
    if (cues.length > 0) return cues;
  }
  
  if (tag === 'ttml') {
    const cues = parseTtml(body);
    if (cues.length > 0) return cues;
  }
  
  // Fallback: try all parsers
  let cues = parseJson3(body);
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
          key: latestYtCfg.INNERTUBE_API_KEY,
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
  const lines = vttText.split('\n');
  let i = 0;
  
  // Skip WEBVTT header
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }
  
  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Look for timestamp line
    if (line.includes('-->')) {
      const match = line.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
      if (match) {
        const startMs = parseInt(match[1]) * 3600000 + parseInt(match[2]) * 60000 + parseInt(match[3]) * 1000 + parseInt(match[4]);
        const endMs = parseInt(match[5]) * 3600000 + parseInt(match[6]) * 60000 + parseInt(match[7]) * 1000 + parseInt(match[8]);
        
        // Collect text lines until blank line
        i++;
        const textLines = [];
        while (i < lines.length && lines[i].trim()) {
          textLines.push(lines[i].trim());
          i++;
        }
        
        const text = textLines.join('\n').trim();
        if (text) {
          cues.push({
            start: startMs / 1000,
            end: endMs / 1000,
            text: text
          });
        }
      }
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
    
    // Try <text> tags (YouTube format)
    let elements = doc.querySelectorAll('text');
    if (elements.length === 0) {
      // Try <p> tags (standard TTML)
      elements = doc.querySelectorAll('p');
    }
    
    for (const elem of elements) {
      const start = parseFloat(elem.getAttribute('start') || elem.getAttribute('begin') || '0');
      const dur = parseFloat(elem.getAttribute('dur') || elem.getAttribute('duration') || '0');
      const end = elem.getAttribute('end') ? parseFloat(elem.getAttribute('end')) : start + dur;
      const text = elem.textContent.trim();
      
      if (text) {
        cues.push({
          start: start,
          end: end,
          text: text
        });
      }
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

async function romanizeCues(cues) {
  if (!cues?.length) return cues;
  console.log('[romaji] romanizing', cues.length, 'cues via API');
  
  const videoId = getCurrentVideoId();
  const fullText = cues.map(c => c.text).join('\n');
  
  try {
    const response = await fetch('https://youtube-romaji-api.fly.dev/romanize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, text: fullText })
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('[romaji] API response cached:', data.cached, 'timed:', data.timed);
    
    // DEBUG: Log first few chars of romanized text to detect empty responses
    if (data.romanized) {
      const preview = data.romanized.substring(0, 100);
      console.log('[romaji] romanized preview:', preview);
      if (!preview.trim()) {
        console.warn('[romaji] API returned empty romanized text!');
      }
    }
    
    const isTimed = data.timed && (data.vtt || data.segments);
    if (isTimed) {
      console.log('[romaji] using DB-timed romaji');
      
      if (data.vtt && data.segments) {
        console.log('[romaji] both vtt and segments present, preferring vtt');
        const timedCues = parseVtt(data.vtt);
        if (timedCues.length > 0) {
          console.log('[romaji] parsed', timedCues.length, 'timed cues from vtt');
          return timedCues;
        }
        console.log('[romaji] vtt parsing failed, falling back to segments');
      }
      
      if (data.vtt) {
        const timedCues = parseVtt(data.vtt);
        if (timedCues.length > 0) {
          console.log('[romaji] parsed', timedCues.length, 'timed cues from vtt');
          return timedCues;
        }
      }
      
      if (data.segments && Array.isArray(data.segments)) {
        console.log('[romaji] using', data.segments.length, 'timed segments');
        return data.segments.map(s => ({
          start: s.start,
          end: s.end,
          text: s.text
        }));
      }
      
      console.warn('[romaji] timed flag set but no valid vtt or segments, falling back to untimed');
    }
    
    const romanizedLines = data.romanized.split('\n');
    
    // CRITICAL FIX: Validate that API actually returned content
    const hasContent = romanizedLines.some(line => line && line.trim().length > 0);
    if (!hasContent) {
      console.error('[romaji] API returned no romanized content (all empty lines)');
      throw new Error('API returned empty romanization - this may be a cached corrupted result');
    }
    
    const r = [];
    for (let i = 0; i < cues.length; i++) {
      r.push({
        start: cues[i].start,
        end: cues[i].end,
        text: romanizedLines[i] || ''
      });
    }
    
    // Merge consecutive cues with identical text to prevent flicker
    const merged = [];
    for (let i = 0; i < r.length; i++) {
      const cue = r[i];
      
      // Skip empty cues
      if (!cue.text || cue.text.trim() === '') {
        continue;
      }
      
      // Check if next cue has the same text (continuation/timing split)
      let endTime = cue.end;
      while (i + 1 < r.length && r[i + 1].text === cue.text) {
        // Extend end time to include next cue
        endTime = r[i + 1].end;
        i++; // Skip the duplicate cue
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
    
    // CRITICAL FIX: If all cues were empty/merged away, return original cues
    if (merged.length === 0) {
      console.warn('[romaji] all romanized cues were empty or invalid, returning original cues');
      return cues;
    }
    
    console.log('[romaji] romanized', cues.length, 'cues →', merged.length, 'after merging duplicates');
    return merged;
  } catch (error) {
    console.error('[romaji] API call failed:', error);
    alert('Failed to romanize subtitles. Please try again later.');
    return cues;
  }
}

// ============================================================================
// YOUTUBE CAPTION STYLE MIRRORING
// ============================================================================

// Clear any existing Romaji TextTrack
function clearRomajiTextTrack() {
  if (romajiTextTrack && videoEl) {
    try {
      // Remove all cues
      const cues = Array.from(romajiTextTrack.cues || []);
      cues.forEach(cue => romajiTextTrack.removeCue(cue));
      
      // Disable the track
      romajiTextTrack.mode = 'disabled';
      
      console.log('[romaji] cleared Romaji TextTrack');
    } catch (e) {
      console.warn('[romaji] error clearing TextTrack:', e);
    }
  }
  romajiTextTrack = null;
}

// Get YouTube's caption settings from player configuration
function getYouTubeCaptionSettings() {
  try {
    // Try to get settings from YouTube's player
    const player = document.getElementById('movie_player');
    if (player && player.getOption) {
      const settings = {
        fontFamily: player.getOption('captions', 'fontFamily'),
        fontSize: player.getOption('captions', 'fontSize'),
        textColor: player.getOption('captions', 'textColor'),
        textOpacity: player.getOption('captions', 'textOpacity'),
        backgroundColor: player.getOption('captions', 'backgroundColor'),
        backgroundOpacity: player.getOption('captions', 'backgroundOpacity'),
        windowColor: player.getOption('captions', 'windowColor'),
        windowOpacity: player.getOption('captions', 'windowOpacity'),
        charEdgeStyle: player.getOption('captions', 'charEdgeStyle'),
        fontSizeIncrement: player.getOption('captions', 'fontSizeIncrement')
      };
      
      console.log('[romaji] YouTube caption settings from player:', settings);
      return settings;
    }
  } catch (e) {
    console.warn('[romaji] could not get caption settings from player:', e);
  }
  
  return null;
}

// Convert YouTube setting values to CSS
function convertYouTubeSettingsToCSS(settings) {
  if (!settings) return null;
  
  const css = {};
  
  // Font family mapping
  const fontMap = {
    0: 'Roboto, "YouTube Noto", Arial, sans-serif', // Proportional Sans-Serif
    1: 'Courier New, Courier, monospace', // Monospace Sans-Serif
    2: 'Times New Roman, Times, serif', // Proportional Serif
    3: 'Courier, monospace', // Monospace Serif
    4: 'Comic Sans MS, cursive', // Casual
    5: 'Gabriola, cursive', // Cursive
    6: 'Impact, fantasy', // Small Capitals
  };
  
  if (settings.fontFamily !== undefined) {
    css.fontFamily = fontMap[settings.fontFamily] || fontMap[0];
  }
  
  // Font size (0-4, where 2 is default 100%)
  const fontSizeMap = {
    0: '12px',   // 50%
    1: '16px',   // 75%
    2: '20px',   // 100%
    3: '24px',   // 150%
    4: '32px'    // 200%
  };
  
  const fontSizeIncrement = settings.fontSizeIncrement || 0;
  const baseFontSize = fontSizeMap[2]; // 100%
  const fontSizeIndex = Math.max(0, Math.min(4, 2 + fontSizeIncrement));
  css.fontSize = fontSizeMap[fontSizeIndex] || baseFontSize;
  
  // Text color with opacity
  if (settings.textColor !== undefined) {
    const opacity = settings.textOpacity !== undefined ? settings.textOpacity / 255 : 1;
    css.color = `rgba(${settings.textColor >> 16 & 255}, ${settings.textColor >> 8 & 255}, ${settings.textColor & 255}, ${opacity})`;
  }
  
  // Background color with opacity
  if (settings.backgroundColor !== undefined) {
    const bgOpacity = settings.backgroundOpacity !== undefined ? settings.backgroundOpacity / 255 : 0.75;
    css.backgroundColor = `rgba(${settings.backgroundColor >> 16 & 255}, ${settings.backgroundColor >> 8 & 255}, ${settings.backgroundColor & 255}, ${bgOpacity})`;
  }
  
  // Character edge style (text shadow)
  const edgeStyleMap = {
    0: 'none', // None
    1: '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000', // Raised
    2: '-1px -1px 0 #000, 1px 1px 0 #000, -1px 1px 0 #000, 1px -1px 0 #000', // Depressed
    3: '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 2px 2px 0 #000', // Uniform
    4: '2px 2px 4px rgba(0, 0, 0, 0.75)' // Drop shadow
  };
  
  if (settings.charEdgeStyle !== undefined) {
    css.textShadow = edgeStyleMap[settings.charEdgeStyle] || edgeStyleMap[0];
  }
  
  console.log('[romaji] converted settings to CSS:', css);
  return css;
}

// Get YouTube's caption window and extract computed styles
function getYouTubeCaptionStyles() {
  // YouTube applies caption styles to different elements depending on settings
  // Priority order: actual caption segment > caption window > defaults
  
  let captionTextElement =null;
  let captionWindow = null;
  let captionContainer = null;
  
  // Find the actual text span that YouTube renders - this has the real styles
  captionTextElement = document.querySelector('.ytp-caption-segment');
  
  // Find the caption window container
  captionWindow = document.querySelector('.caption-window');
  
  // Find the overall container
  captionContainer = document.querySelector('.ytp-caption-window-container');
  
  if (!captionTextElement && !captionWindow) {
    console.log('[romaji] no caption elements found, using defaults');
    return null;
  }
  
  // Use caption text element if available, otherwise fall back to window
  const primaryElement = captionTextElement || captionWindow;
  const computed = window.getComputedStyle(primaryElement);
  
  // Get background from window or container
  let backgroundColor = 'rgba(8, 8, 8, 0.75)'; // YouTube default
  let windowColor = 'transparent';
  
  if (captionWindow) {
    const windowComputed = window.getComputedStyle(captionWindow);
    if (windowComputed.backgroundColor && windowComputed.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      backgroundColor = windowComputed.backgroundColor;
    }
  }
  
  if (captionContainer) {
    const containerComputed = window.getComputedStyle(captionContainer);
    if (containerComputed.backgroundColor && containerComputed.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      windowColor = containerComputed.backgroundColor;
    }
  }
  
  // Extract comprehensive style properties
  const styles = {
    // Text styling
    fontFamily: computed.fontFamily || 'Roboto, "YouTube Noto", Arial, sans-serif',
    fontSize: computed.fontSize || '20px',
    fontWeight: computed.fontWeight || 'normal',
    fontStyle: computed.fontStyle || 'normal',
    
    // Color and opacity
    color: computed.color || 'rgb(255, 255, 255)',
    opacity: computed.opacity || '1',
    
    // Background
    backgroundColor: backgroundColor,
    windowColor: windowColor,
    
    // Text effects
    textShadow: computed.textShadow || 'none',
    
    // Layout
    textAlign: computed.textAlign || 'center',
    lineHeight: computed.lineHeight || '1.3',
    padding: computed.padding || '0',
    borderRadius: computed.borderRadius || '0',
    
    // Source info for debugging
    sourceElement: primaryElement.className
  };
  
  // DEBUG: Comprehensive logging
  console.log('[romaji] ===== CAPTION STYLE EXTRACTION =====');
  console.log('[romaji] Source element:', primaryElement.tagName, primaryElement.className);
  console.log('[romaji] Font:', styles.fontFamily, '@', styles.fontSize, styles.fontWeight);
  console.log('[romaji] Color:', styles.color, 'opacity:', styles.opacity);
  console.log('[romaji] Background:', styles.backgroundColor);
  console.log('[romaji] Text Shadow:', styles.textShadow);
  console.log('[romaji] Padding:', styles.padding, 'Border radius:', styles.borderRadius);
  console.log('[romaji] =====================================');
  
  return styles;
}

// Apply YouTube's caption styles to our overlay
function applyYouTubeCaptionStyles(element) {
  if (!element) return;
  
  // Try to get settings from YouTube's player API first (most accurate)
  const playerSettings = getYouTubeCaptionSettings();
  
  if (playerSettings) {
    const css = convertYouTubeSettingsToCSS(playerSettings);
    if (css) {
      console.log('[romaji] using YouTube player caption settings API');
      Object.entries(css).forEach(([prop, value]) => {
        element.style.setProperty(prop, value, 'important');
      });
      
      // Add base styling
      element.style.setProperty('text-align', 'center', 'important');
      element.style.setProperty('line-height', '1.3', 'important');
      element.style.setProperty('padding', '0.2em 0.4em', 'important');
      element.style.setProperty('border-radius', '0.1em', 'important');
      
      console.log('[romaji] applied player settings:', css);
      return;
    }
  }
  
  // Fallback: Extract from computed styles
  const styles = getYouTubeCaptionStyles();
  if (!styles) {
    console.warn('[romaji] no styles extracted, using safe defaults');
    element.style.setProperty('font-family', 'Roboto, Arial, sans-serif', 'important');
    element.style.setProperty('font-size', '20px', 'important');
    element.style.setProperty('color', '#fff', 'important');
    element.style.setProperty('background-color', 'rgba(8, 8, 8, 0.75)', 'important');
    element.style.setProperty('text-shadow', 'none', 'important');
    element.style.setProperty('font-weight', 'normal', 'important');
    element.style.setProperty('text-align', 'center', 'important');
    element.style.setProperty('line-height', '1.3', 'important');
    element.style.setProperty('padding', '0.2em 0.4em', 'important');
    element.style.setProperty('border-radius', '0.1em', 'important');
    return;
  }
  
  console.log('[romaji] using computed styles from caption window');
  
  // Apply extracted styles with !important to override CSS
  const styleMap = {
    'font-family': styles.fontFamily,
    'font-size': styles.fontSize,
    'color': styles.color,
    'background-color': styles.backgroundColor,
    'text-shadow': styles.textShadow,
    'font-weight': styles.fontWeight,
    'font-style': styles.fontStyle,
    'text-align': styles.textAlign,
    'line-height': styles.lineHeight,
    'padding': styles.padding,
    'border-radius': styles.borderRadius,
    'opacity': styles.opacity
  };
  
  Object.entries(styleMap).forEach(([prop, value]) => {
    if (value) {
      element.style.setProperty(prop, value, 'important');
    }
  });
  
  lastAppliedStyles = styles;
  
  // DEBUG: Log what we actually applied
  console.log('[romaji] final applied styles:', {
    fontFamily: element.style.fontFamily,
    fontSize: element.style.fontSize,
    color: element.style.color,
    backgroundColor: element.style.backgroundColor,
    textShadow: element.style.textShadow
  });
}

// Start observing YouTube's caption styles for changes
function startCaptionStyleObserver(overlayElement) {
  // Stop any existing observer
  stopCaptionStyleObserver();
  
  // Find the caption span element (where styles should be applied)
  const getCaptionSpan = () => {
    if (renderer && renderer.captionSpan) {
      return renderer.captionSpan;
    }
    return overlayElement.querySelector('.romaji-caption-text');
  };
  
  // Initial style application to the span
  const applyStylesToSpan = () => {
    const span = getCaptionSpan();
    if (span) {
      applyYouTubeCaptionStyles(span);
    }
  };
  
  applyStylesToSpan();
  
  // Create periodic refresh to catch settings changes
  // YouTube caption settings can change via player API without DOM mutations
  const refreshInterval = setInterval(() => {
    if (isRomajiActive && overlayElement) {
      applyStylesToSpan();
    } else {
      clearInterval(refreshInterval);
    }
  }, 500); // Check twice per second for responsiveness
  
  // Watch for DOM changes to ANY caption elements that could indicate style changes
  const observeElements = () => {
    const captionWindow = document.querySelector('.caption-window');
    const captionSegment = document.querySelector('.ytp-caption-segment');
    const captionContainer = document.querySelector('.ytp-caption-window-container');
    const allCaptionElements = document.querySelectorAll('[class*="caption"], [class*="ytp-caption"]');
    
    const elementsToWatch = new Set();
    
    if (captionWindow) elementsToWatch.add(captionWindow);
    if (captionSegment) elementsToWatch.add(captionSegment);
    if (captionContainer) elementsToWatch.add(captionContainer);
    allCaptionElements.forEach(el => elementsToWatch.add(el));
    
    if (elementsToWatch.size > 0) {
      elementsToWatch.forEach(el => {
        try {
          captionStyleObserver.observe(el, {
            attributes: true,
            childList: true,
            subtree: true
          });
        } catch (e) {
          // Element might not be observable, skip it
        }
      });
      console.log('[romaji] observing', elementsToWatch.size, 'caption-related elements');
    }
  };
  
  // Create main MutationObserver
  captionStyleObserver = new MutationObserver(() => {
    console.log('[romaji] caption DOM mutated, refreshing styles');
    applyStylesToSpan();
  });
  
  observeElements();
  
  // Also observe the entire document for caption element additions/changes
  const documentObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) {
          const className = node.className || '';
          if (typeof className === 'string' && (className.includes('caption') || className.includes('ytp-'))) {
            console.log('[romaji] new caption element added, refreshing styles');
            applyStylesToSpan();
            break;
          }
        }
      }
    }
  });
  
  documentObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Store all observers for cleanup
  captionStyleObserver._refreshInterval = refreshInterval;
  captionStyleObserver._documentObserver = documentObserver;
  
  console.log('[romaji] comprehensive caption style observer started');
}

// Stop caption style observer
function stopCaptionStyleObserver() {
  if (captionStyleObserver) {
    captionStyleObserver.disconnect();
    
    // Disconnect document observer if it exists
    if (captionStyleObserver._documentObserver) {
      captionStyleObserver._documentObserver.disconnect();
    }
    
    // Clear refresh interval if it exists
    if (captionStyleObserver._refreshInterval) {
      clearInterval(captionStyleObserver._refreshInterval);
    }
    
    captionStyleObserver = null;
    console.log('[romaji] caption style observer stopped');
  }
}

// Handle player control hover to adjust subtitle positioning
function setupPositionObserver(overlayElement) {
  if (!overlayElement) return;
  
  const player = document.querySelector('.html5-video-player');
  if (!player) return;
  
  // YouTube adds 'ytp-autohide' class when controls should auto-hide
  // When user hovers, this class is removed and controls show
  const positionObserver = new MutationObserver(() => {
    const hasAutohide = player.classList.contains('ytp-autohide');
    
    // When controls are showing (no autohide), move subtitles up
    // YouTube typically moves them from bottom: 60px to bottom: 105px
    if (!hasAutohide) {
      overlayElement.style.bottom = '105px';
    } else {
      overlayElement.style.bottom = '60px';
    }
  });
  
  positionObserver.observe(player, {
    attributes: true,
    attributeFilter: ['class']
  });
  
  // Store reference for cleanup
  overlayElement._positionObserver = positionObserver;
  
  console.log('[romaji] position observer setup complete');
}

// Clean up position observer
function cleanupPositionObserver(overlayElement) {
  if (overlayElement && overlayElement._positionObserver) {
    overlayElement._positionObserver.disconnect();
    overlayElement._positionObserver = null;
  }
}

// ============================================================================
// OVERLAY RENDERING WITH YOUTUBE STYLE MIRRORING
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
    playerContainer.appendChild(overlayEl);
  }
  overlayEl.style.display = visible ? "block" : "none";
  
  if (visible) {
    // Apply YouTube's caption styles when showing
    applyYouTubeCaptionStyles(overlayEl);
    startCaptionStyleObserver(overlayEl);
    setupPositionObserver(overlayEl);
  } else {
    // Clean up observers when hiding
    stopCaptionStyleObserver();
    cleanupPositionObserver(overlayEl);
  }
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
  
  console.log("[romaji] showing overlay with YouTube style mirroring, cues:", cues.length);
  ensureOverlay(true);
  if (renderer) renderer.stop();
  renderer = new CaptionRenderer(videoEl, overlayEl, cues);
  renderer.start();
  setNativeCaptionsVisible(false);
  isRomajiActive = true;
  updateMenuCheckmarks();
  updateCaptionButton();
  startSubtitleDisplayWatcher();
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
    this.captionSpan = null;
  }
  
  start() {
    this.stop();
    
    // Create a span element to hold the caption text
    // This allows background to wrap tightly around text
    if (!this.captionSpan) {
      this.captionSpan = document.createElement('span');
      this.captionSpan.className = 'romaji-caption-text';
      this.host.appendChild(this.captionSpan);
      
      // Apply initial styles to the span
      applyYouTubeCaptionStyles(this.captionSpan);
    }
    
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
          this.captionSpan.textContent = cue.text;
        }
      } else {
        if (this.active !== -1) {
          this.active = -1;
          this.captionSpan.textContent = "";
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    
    if (this.captionSpan) {
      this.captionSpan.remove();
      this.captionSpan = null;
    }
    
    this.host.textContent = "";
    this.index = 0;
    this.active = -1;
    setNativeCaptionsVisible(true);
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

