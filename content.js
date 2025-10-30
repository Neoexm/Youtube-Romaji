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

let romajiReady = false;

async function bgCall(type, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('bg timeout'));
      }
    }, timeoutMs);
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      if (resp?.success === false) {
        return reject(new Error(resp.error || 'bg call failed'));
      }
      resolve(resp);
    });
  });
}

// Kuromoji removed - now using API for romanization

function scrubCueText(t) {
  return String(t ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

let videoEl = null;
let videoId = null;
let overlayEl = null;
let renderer = null;
let isRomajiActive = false;

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
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(function installTimedtextSniffer() {
  if (window.__romajiSnifferInstalled) return;
  window.__romajiSnifferInstalled = true;

  const TIMEDTEXT_RE = /(\/api\/timedtext|[?&]t?imedtext\b)/i;

  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (url && TIMEDTEXT_RE.test(url)) {
        window.postMessage({ source: 'romaji-bridge', type: 'TIMEDTEXT_URL', url }, '*');
      }
    } catch {}
    return _fetch.apply(this, arguments);
  };

  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (url && TIMEDTEXT_RE.test(url)) {
        window.postMessage({ source: 'romaji-bridge', type: 'TIMEDTEXT_URL', url }, '*');
      }
    } catch {}
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
  } catch {}
  return null;
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
    
    const cues = parseTimedTextAuto(fetchResult.tag, fetchResult.body);
    if (cues.length === 0) {
      throw new Error('No cues parsed');
    }
    
    const romanizedCues = await romanizeCues(cues);
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
    lastVideoIdForTimedtext = getCurrentVideoId();
    
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
    } catch {}
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

async function onNavigation(event) {
  const newVideoId = getCurrentVideoId();
  if (newVideoId === videoId) return;
  
  videoId = newVideoId;
  console.log("[romaji] navigation detected, videoId:", videoId);
  
  tracksLoggedThisNav = false;
  
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
  
  li.addEventListener("click", evt => {
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
  
  // Prefer manual URL, fallback to ASR if manual not available
  if (lastTimedtextUrl && lastVideoIdForTimedtext === currentVid) {
    return true;
  }
  
  if (lastTimedtextUrlASR && lastVideoIdForTimedtext === currentVid) {
    console.log('[romaji] using ASR URL as fallback (no manual URL captured)');
    lastTimedtextUrl = lastTimedtextUrlASR;
    return true;
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
  }
  
  // Leave CC on to keep requests flowing
  return !!lastTimedtextUrl;
}

// ============================================================================
// CAPTION SELECTION & FETCHING
// ============================================================================

function turnOffRomaji() {
  console.log('[romaji] turning off romaji captions');
  if (renderer) renderer.stop();
  renderer = null;
  ensureOverlay(false);
  setNativeCaptionsVisible(true);
  isRomajiActive = false;
  stopSubtitleDisplayWatcher();
  updateMenuCheckmarks();
}

async function onSelectRomaji() {
  console.log("[romaji] onSelectRomaji triggered");
  
  if (isRomajiActive) {
    console.log("[romaji] toggling off romaji");
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
    let tracks = getCachedTracks();
    
    // If no tracks from bridge, try youtubei fallback
    if (!tracks || tracks.length === 0) {
      console.log("[romaji] no tracks from bridge, trying youtubei fallback");
      const vid = getCurrentVideoId();
      if (!vid) {
        console.log("[romaji] no videoId available");
        return;
      }
      
      const result = await fetchPlayerResponseFallback(vid);
      if (result.ok && result.data) {
        const captionData = result.data.captions?.playerCaptionsTracklistRenderer;
        if (captionData?.captionTracks) {
          tracks = captionData.captionTracks;
          latestTracksByVideo.set(vid, tracks);
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
    
    const trackName = (track.name && track.name.simpleText) || track.languageCode || 'Unknown';
    console.log(`[romaji] selected manual track: ${trackName}`);
    
    const vid = getCurrentVideoId();
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
    console.log('[romaji] API response cached:', data.cached);
    
    const romanizedLines = data.romanized.split('\n');
    const r = [];
    for (let i = 0; i < cues.length; i++) {
      r.push({ 
        start: cues[i].start, 
        end: cues[i].end, 
        text: romanizedLines[i] || '' 
      });
    }
    
    console.log('[romaji] romanized', cues.length, 'cues');
    return r;
  } catch (error) {
    console.error('[romaji] API call failed:', error);
    alert('Failed to romanize subtitles. Please try again later.');
    return cues;
  }
}

function splitJapaneseBlocks(s) {
  const out = [];
  let cur = "";
  for (const ch of s) {
    if (/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー]$/u.test(ch)) {
      cur += ch;
    } else {
      if (cur) out.push(cur);
      cur = "";
      out.push(ch);
    }
  }
  if (cur) out.push(cur);
  return out;
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
    playerContainer.appendChild(overlayEl);
  }
  overlayEl.style.display = visible ? "block" : "none";
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

function closeSettingsMenu() {
  const settingsBtn = document.querySelector('.ytp-settings-button');
  if (settingsBtn) {
    settingsBtn.click();
  }
}

function backToSettingsPanel() {
  const backBtn = document.querySelector('.ytp-panel-back-button');
  if (backBtn) {
    console.log('[romaji] clicking back button to return to settings');
    backBtn.click();
  } else {
    console.warn('[romaji] back button not found, menu may have closed');
  }
}

class CaptionRenderer {
  constructor(video, host, cues) {
    this.video = video;
    this.host = host;
    this.cues = cues;
    this.raf = null;
    this.index = 0;
    this.active = -1;
  }
  
  start() {
    this.stop();
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
  }
  
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
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
function storageSet(obj) { return chrome.storage.local.set(obj); }

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return String(h >>> 0);
}
