/*
 * Page-World Bridge for YouTube Romaji Captions
 * 
 * Purpose: Extract ytInitialPlayerResponse, ytcfg, and sniff timedtext URLs
 * 
 * Why a page-world bridge?
 * - Content scripts run in an isolated world and cannot reliably access page variables
 * - ytcfg and ytInitialPlayerResponse are JavaScript objects in the page world
 * - YouTube's CSP blocks inline scripts, so we inject this as a web_accessible_resource
 * - This script runs in the page world and can directly access window.ytcfg
 * 
 * Why sniff timedtext URLs?
 * - YouTube's /api/timedtext URLs require a 'pot' token and other signed parameters
 * - These parameters (pot, c, cver, etc.) are dynamically generated
 * - By intercepting YouTube's own requests, we get the exact working URL
 * - We can then reuse it, changing only the 'fmt' parameter
 * 
 * Flow:
 * 1. Script injected into page world by content script
 * 2. Hooks fetch() and XMLHttpRequest to capture timedtext URLs
 * 3. Posts player data and sniffed URLs to content script via events
 * 4. Listens for yt-navigate-finish and re-extracts on SPA navigation
 */

(() => {
  const ORIGIN_TAG = 'romaji-bridge';

  if (window.__romajiBridgeLoaded) {
    console.log('[romaji-bridge] already loaded, skipping');
    return;
  }

  if (window !== window.top) return;
  if (location.origin !== 'https://www.youtube.com') return;

  const emit = (url) => {
    try {
      const isASR = url.includes('&kind=asr') || url.includes('&caps=asr');
      window.postMessage({ 
        source: ORIGIN_TAG, 
        type: 'TIMEDTEXT_URL', 
        url,
        isASR 
      }, '*');
    } catch {}
  };

  // Hook fetch
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const input = args[0];
      const url = (typeof input === 'string') ? input : input?.url || '';
      if (typeof url === 'string' && url.includes('/api/timedtext')) {
        emit(String(url));
      }
    } catch {}
    return _fetch.apply(this, args);
  };

  // Hook XHR
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (typeof url === 'string' && url.includes('/api/timedtext')) {
        emit(url);
      }
    } catch {}
    return _open.call(this, method, url, ...rest);
  };

  // Player data extraction (existing functionality)
  function safeGetYtCfg() {
    try {
      const all = window.ytcfg && (window.ytcfg.getAll?.() || window.ytcfg.data_);
      if (!all) return {};
      // Whitelist only what we need to keep payload small
      const pick = (k) => all[k];
      return {
        INNERTUBE_API_KEY: pick('INNERTUBE_API_KEY'),
        INNERTUBE_CLIENT_NAME: pick('INNERTUBE_CLIENT_NAME'),
        INNERTUBE_CLIENT_VERSION: pick('INNERTUBE_CLIENT_VERSION'),
        VISITOR_DATA: pick('VISITOR_DATA'),
        HL: pick('HL'),
        GL: pick('GL')
      };
    } catch { return {}; }
  }

  function getPlayerResponseNow() {
    // 1) Global snapshot
    if (window.ytInitialPlayerResponse?.videoDetails) return window.ytInitialPlayerResponse;

    // 2) Component APIs
    const ytd = document.querySelector('ytd-player');
    const pr2 = ytd?.getPlayerResponse?.();
    if (pr2?.videoDetails) return pr2;

    const movie = document.getElementById('movie_player');
    const pr3 = movie?.getPlayerResponse?.();
    if (pr3?.videoDetails) return pr3;

    // 3) Legacy args
    const args = window.ytplayer?.config?.args;
    if (args?.player_response) {
      try {
        const pr4 = typeof args.player_response === 'string' ? JSON.parse(args.player_response) : args.player_response;
        if (pr4?.videoDetails) return pr4;
      } catch {}
    }
    if (args?.raw_player_response?.videoDetails) return args.raw_player_response;

    return null;
  }

  function getCaptionTracks(pr) {
    return pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || location.pathname.split('/').filter(Boolean).pop() || null;
    } catch { return null; }
  }

  function pushState(tag = 'tick') {
    const pr = getPlayerResponseNow();
    const tracks = getCaptionTracks(pr);
    const ytcfg = safeGetYtCfg();
    window.postMessage({
      source: ORIGIN_TAG,
      type: 'YT_STATE',
      tag,
      videoId: getVideoId(),
      ytcfg,
      hasPlayer: !!pr,
      hasVideoDetails: !!(pr && pr.videoDetails),
      captionTracks: tracks
    }, '*');
  }

  // Initial attempts (check every 200ms for up to 4 seconds)
  let attempts = 0;
  const iv = setInterval(() => {
    attempts++;
    pushState('boot');
    if (attempts >= 20) clearInterval(iv);
  }, 200);

  // On SPA navigation finish, push fresh data
  document.addEventListener('yt-navigate-finish', () => {
    let n = 0;
    const iv2 = setInterval(() => {
      n++;
      pushState('navigate-finish');
      if (n >= 20) clearInterval(iv2);
    }, 200);
  }, true);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    pushState('ready');
  } else {
    document.addEventListener('DOMContentLoaded', () => pushState('domcontentloaded'), { once: true });
  }

  console.log('[romaji-bridge] initialized (player data + timedtext sniffing only)');
})();