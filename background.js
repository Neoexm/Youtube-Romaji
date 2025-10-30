/*
 * Background Service Worker for YouTube Romaji Captions
 * 
 * Purpose: Handle caption fetching and playerResponse fallback
 * 
 * Why background fetch?
 * - YouTube's TimedText URLs require credentials and have CORS restrictions
 * - Content scripts face CORB (Cross-Origin Read Blocking) when fetching JSON/XML
 * - Background service workers can fetch with credentials and avoid CORB issues
 * 
 * yt-dlp-inspired strategy:
 * - ALWAYS try the signed baseUrl as-is first (YouTube may have already set optimal fmt)
 * - Only modify 'fmt' parameter if needed for fallback
 * - NEVER touch other parameters (signature, expire, sparams, ei, etc.)
 * - Stop at first non-empty response body
 * 
 * Format preferences (based on yt-dlp behavior):
 * - Manual subtitles: as-is → vtt → ttml → json3
 * - ASR subtitles: as-is → json3 → srv3 → vtt → ttml
 * 
 * Why youtubei/v1/player fallback?
 * - Last resort when page-bridge fails to provide playerResponse
 * - Requires proper headers to avoid 403 errors
 */

const TTL_DAYS = 30;
const DAY_MS = 86_400_000;
const OFFSCREEN_TIMEOUT_MS = 30000;

function now() {
  return Date.now();
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const cutoff = now() - TTL_DAYS * DAY_MS;
  const toDelete = [];
  for (const [k, v] of Object.entries(all)) {
    if (!/^subs:|^cache:/.test(k)) continue;
    const ts = v && v.ts ? v.ts : 0;
    if (ts && ts < cutoff) toDelete.push(k);
  }
  if (toDelete.length) await chrome.storage.local.remove(toDelete);
}

// Fetch raw captions from YouTube - NO URL MUTATIONS
// Content script handles format strategy and passes exact URL
async function fetchTimedTextRaw(url) {
  console.log('[romaji-bg] fetchTimedTextRaw called');
  
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'Invalid URL provided' };
  }
  
  console.log('[romaji-bg] fetching from:', url.substring(0, 150) + '...');
  
  try {
    const response = await fetch(url, {
      credentials: 'include',
      method: 'GET'
    });
    
    console.log('[romaji-bg] response status:', response.status);
    
    if (!response.ok) {
      console.error('[romaji-bg] fetch failed with status:', response.status);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    const body = await response.text();
    console.log('[romaji-bg] response length:', body.length);
    
    if (!body || body.trim().length === 0) {
      console.warn('[romaji-bg] empty response received');
      return { ok: false, error: 'Empty response' };
    }
    
    console.log('[romaji-bg] fetch successful, length:', body.length);
    return { ok: true, body };
    
  } catch (err) {
    console.error('[romaji-bg] fetch error:', err);
    return { ok: false, error: err.message || 'Network error' };
  }
}

// Fetch playerResponse from youtubei/v1/player API (fallback when page-bridge fails)
async function fetchPlayerResponse(videoId, ytcfg) {
  console.log('[romaji-bg] fetchPlayerResponse called for videoId:', videoId);
  
  if (!videoId) {
    return { ok: false, error: 'No videoId provided' };
  }
  
  if (!ytcfg || !ytcfg.key) {
    console.warn('[romaji-bg] No INNERTUBE_API_KEY provided, using default');
  }
  
  const key = ytcfg?.key || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const clientName = ytcfg?.clientName || 'WEB';
  const clientVersion = ytcfg?.clientVersion || '2.20231219.01.00';
  const visitor = ytcfg?.visitor || '';
  const hl = ytcfg?.hl || 'en';
  const gl = ytcfg?.gl || 'US';
  
  const url = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}`;
  
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const utcOff = String(-new Date().getTimezoneOffset());
  
  const headers = {
    'Content-Type': 'application/json',
    'Referer': 'https://www.youtube.com/',
    'X-YouTube-Client-Name': clientName,
    'X-YouTube-Client-Version': clientVersion,
    'X-YouTube-Time-Zone': tz,
    'X-YouTube-UTC-Offset': utcOff
  };
  
  if (visitor) {
    headers['X-Goog-Visitor-Id'] = visitor;
  }
  
  const body = {
    context: {
      client: {
        clientName,
        clientVersion,
        hl,
        gl
      }
    },
    videoId
  };
  
  try {
    console.log('[romaji-bg] POSTing to youtubei/v1/player');
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      mode: 'cors',
      referrer: 'https://www.youtube.com/',
      headers,
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      console.warn('[romaji-bg] youtubei fetch failed:', response.status);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    const data = await response.json();
    
    if (data?.videoDetails) {
      console.log('[romaji-bg] playerResponse fetched successfully');
      return { ok: true, data };
    } else {
      console.warn('[romaji-bg] playerResponse has no videoDetails');
      return { ok: false, error: 'Invalid playerResponse structure' };
    }
    
  } catch (err) {
    console.error('[romaji-bg] youtubei fetch error:', err);
    return { ok: false, error: err.message || 'Network error' };
  }
}

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    console.log('[romaji-bg] extension installed/updated');
    if (chrome.alarms) chrome.alarms.create("prune", { periodInMinutes: 360 });
  });
}

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    console.log('[romaji-bg] extension started');
    if (chrome.alarms) chrome.alarms.create("prune", { periodInMinutes: 360 });
    prune();
  });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(a => {
    if (a.name === "prune") prune();
  });
}

// Kuromoji offscreen bridge removed - now using API

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (!msg || !msg.type) return;
    
    if (msg.type === 'FETCH_TIMEDTEXT_RAW') {
      console.log('[bg] received FETCH_TIMEDTEXT_RAW request');
      fetchTimedTextRaw(msg.url).then(send);
      return true;
    }
    
    if (msg.type === 'FETCH_PLAYER_RESPONSE') {
      console.log('[bg] received FETCH_PLAYER_RESPONSE request');
      fetchPlayerResponse(msg.videoId, msg.ytcfg).then(send);
      return true;
    }
    
    if (msg.type === "storageGet") {
      chrome.storage.local.get(msg.keys || null).then(send);
      return true;
    }
    if (msg.type === "storageSet") {
      chrome.storage.local.set(msg.payload || {}).then(() => send({ ok: true }));
      return true;
    }
    if (msg.type === "storageRemove") {
      chrome.storage.local.remove(msg.keys || []).then(() => send({ ok: true }));
      return true;
    }
  });
}
