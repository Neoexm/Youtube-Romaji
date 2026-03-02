let videoEl = null;
let videoId = null;
let overlayEl = null;
let renderer = null;
let isRomajiActive = false;

let menuWired = false;
let lastUrl = null;
let captionMenuObserver = null;

const SERVER_URL = 'https://youtube-romaji-api.fly.dev';
const lyricsCache = new Map();

function $(sel, root = document) { return root.querySelector(sel); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCurrentVideoId() {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = location.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

function getVideoTitle() {
  const el = document.querySelector('#title h1 yt-formatted-string, #title h1');
  if (el?.textContent) return el.textContent.trim();
  return (document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
}

function getChannelName() {
  const el = document.querySelector('#channel-name a, ytd-channel-name a');
  return el?.textContent?.trim() || '';
}

function getVideoDuration() {
  const v = document.querySelector('video');
  return v?.duration || 0;
}

// ============================================================================
// LYRICS FETCHING
// ============================================================================

async function fetchRomajiLyrics(vid) {
  if (lyricsCache.has(vid)) return lyricsCache.get(vid);

  const title = getVideoTitle();
  const artist = getChannelName();
  const duration = getVideoDuration();

  console.log(`[romaji] fetching: "${title}" by "${artist}" (${Math.round(duration)}s)`);

  try {
    const res = await fetch(`${SERVER_URL}/lyrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: vid, title, artist, duration })
    });

    const data = await res.json();
    lyricsCache.set(vid, data);
    return data;
  } catch (err) {
    console.error('[romaji] fetch error:', err);
    const result = { ok: false, error: err.message };
    lyricsCache.set(vid, result);
    return result;
  }
}

// ============================================================================
// INIT
// ============================================================================

start();

async function start() {
  console.log("[romaji] starting");
  await waitForPlayer();
  console.log("[romaji] player ready");
  setupNavigationListener();
  observeSettingsMenu();
}

async function waitForPlayer() {
  for (;;) {
    videoEl = $("video");
    if ($("ytd-player") && videoEl) return;
    await sleep(300);
  }
}

// ============================================================================
// NAVIGATION
// ============================================================================

function setupNavigationListener() {
  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => onNavigation(), 250);
  });

  const mo = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => onNavigation(), 250);
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

function onNavigation() {
  const newVideoId = getCurrentVideoId();
  if (newVideoId === videoId) return;

  videoId = newVideoId;
  console.log("[romaji] nav:", videoId);

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

  if (captionMenuObserver) captionMenuObserver.disconnect();

  captionMenuObserver = new MutationObserver(muts => {
    for (const mut of muts) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains("ytp-panel")) {
          const title = $(".ytp-panel-title", node);
          if (title && /Subtitles|Captions|字幕|자막/i.test(title.textContent || "")) {
            injectRomajiEntry($(".ytp-panel-menu", node));
          }
        }
      }
    }
  });

  captionMenuObserver.observe(holder, { childList: true, subtree: true });
  menuWired = true;
}

function injectRomajiEntry(menuEl) {
  if (!menuEl) return;
  menuEl.querySelectorAll("[data-romaji-entry]").forEach(n => n.remove());

  const li = document.createElement("div");
  li.className = "ytp-menuitem";
  li.setAttribute("role", "menuitemradio");
  li.setAttribute("aria-checked", isRomajiActive ? "true" : "false");
  li.tabIndex = 0;
  li.dataset.romajiEntry = "romaji:auto";

  const label = document.createElement("div");
  label.className = "ytp-menuitem-label";
  label.textContent = "Romaji";

  const content = document.createElement("div");
  content.className = "ytp-menuitem-content";

  li.appendChild(label);
  li.appendChild(content);

  const handler = () => onToggleRomaji();
  li.addEventListener("click", handler);
  li.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  });

  menuEl.appendChild(li);

  // custom subtitle tracks
  listCustomTracks().then(tracks => {
    for (const t of tracks) {
      if (!t.value?.name) continue;
      const item = buildCustomMenuItem(t.value.name, t.key);
      menuEl.appendChild(item);
    }
  });

  // wire native items to turn off romaji
  menuEl.querySelectorAll('.ytp-menuitem[role="menuitemradio"]:not([data-romaji-entry])').forEach(item => {
    item.addEventListener('click', () => {
      if (isRomajiActive) {
        if (renderer) renderer.stop();
        renderer = null;
        ensureOverlay(false);
        setNativeCaptionsVisible(true);
        isRomajiActive = false;
        updateMenuCheckmarks();
      }
    });
  });
}

function buildCustomMenuItem(label, storageKey) {
  const li = document.createElement("div");
  li.className = "ytp-menuitem";
  li.setAttribute("role", "menuitemradio");
  li.setAttribute("aria-checked", "false");
  li.tabIndex = 0;
  li.dataset.romajiEntry = `custom:${storageKey}`;

  const name = document.createElement("div");
  name.className = "ytp-menuitem-label";
  name.textContent = label;

  const filler = document.createElement("div");
  filler.className = "ytp-menuitem-content";

  li.appendChild(name);
  li.appendChild(filler);

  li.addEventListener("click", async () => {
    const rec = await storageGet(storageKey);
    if (rec?.cues) showOverlay(rec.cues);
  });

  return li;
}

// ============================================================================
// ROMAJI TOGGLE
// ============================================================================

let fetchingLyrics = false;

async function onToggleRomaji() {
  if (isRomajiActive) {
    if (renderer) renderer.stop();
    renderer = null;
    ensureOverlay(false);
    setNativeCaptionsVisible(true);
    isRomajiActive = false;
    updateMenuCheckmarks();
    return;
  }

  const vid = getCurrentVideoId();
  if (!vid || fetchingLyrics) return;

  // close the menu
  const backBtn = document.querySelector('.ytp-panel-back-button');
  if (backBtn) backBtn.click();

  fetchingLyrics = true;
  console.log("[romaji] fetching lyrics for:", vid);

  try {
    const result = await fetchRomajiLyrics(vid);

    if (!result.ok) {
      alert(result.error || 'No romaji lyrics found.');
      return;
    }

    if (!result.cues?.length) {
      alert('No lyrics found.');
      return;
    }

    if (!result.synced) {
      console.warn('[romaji] only unsynced lyrics available');
    }

    if (result.trackName) {
      console.log(`[romaji] matched: "${result.trackName}" by ${result.artistName}`);
    }

    showOverlay(result.cues);
  } catch (err) {
    console.error('[romaji] error:', err);
    alert('Failed to fetch lyrics. Check console.');
  } finally {
    fetchingLyrics = false;
  }
}

// ============================================================================
// OVERLAY
// ============================================================================

function ensureOverlay(visible) {
  if (!overlayEl) {
    const player = document.querySelector('.html5-video-player');
    if (!player) return;
    overlayEl = document.createElement("div");
    overlayEl.id = "romaji-caption-overlay";
    player.appendChild(overlayEl);
  }
  overlayEl.style.display = visible ? "block" : "none";
}

function showOverlay(cues) {
  if (!cues?.length) return;
  videoEl = document.querySelector('video');
  ensureOverlay(true);
  if (renderer) renderer.stop();
  renderer = new CaptionRenderer(videoEl, overlayEl, cues);
  renderer.start();
  setNativeCaptionsVisible(false);
  isRomajiActive = true;
  updateMenuCheckmarks();
}

function setNativeCaptionsVisible(visible) {
  const container = document.querySelector('.ytp-caption-window-container');
  if (container) container.style.display = visible ? '' : 'none';
  document.querySelectorAll('.caption-window').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function updateMenuCheckmarks() {
  const romajiItem = document.querySelector('[data-romaji-entry="romaji:auto"]');
  if (romajiItem) {
    romajiItem.setAttribute('aria-checked', isRomajiActive ? 'true' : 'false');
  }

  if (isRomajiActive) {
    document.body.classList.add('romaji-active');
    document.querySelectorAll('.ytp-menuitem[role="menuitemradio"]:not([data-romaji-entry])').forEach(item => {
      item.setAttribute('aria-checked', 'false');
    });
  } else {
    document.body.classList.remove('romaji-active');
  }
}

// ============================================================================
// CAPTION RENDERER
// ============================================================================

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
// STORAGE (custom subtitle tracks)
// ============================================================================

async function listCustomTracks() {
  const vid = getCurrentVideoId();
  if (!vid) return [];
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k, v]) => k.startsWith("subs:" + vid + ":") && v && typeof v === "object")
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (b.value?.ts || 0) - (a.value?.ts || 0));
}

function storageGet(key) {
  return chrome.storage.local.get([key]).then(v => v[key]);
}
