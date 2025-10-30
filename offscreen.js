console.log('[offscreen] script loading...');

const DICT_FILES = [
  'base.dat.gz',
  'check.dat.gz',
  'tid_map.dat.gz',
  'tid_pos.dat.gz',
  'tid.dat.gz',
  'unk_char.dat.gz',
  'unk_compat.dat.gz',
  'unk_invoke.dat.gz',
  'unk_map.dat.gz',
  'unk_pos.dat.gz',
  'unk.dat.gz'
];

async function preloadDictionaries() {
  console.log('[offscreen] pre-loading', DICT_FILES.length, 'dictionary files...');
  const startTime = performance.now();
  
  const originalFetch = window.fetch;
  const loadPromises = DICT_FILES.map(async filename => {
    const url = chrome.runtime.getURL('lib/kuromoji/dict/' + filename);
    try {
      const response = await originalFetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      window.dictCache.set(filename, arrayBuffer);
      console.log('[offscreen] loaded:', filename, '(' + (arrayBuffer.byteLength / 1024).toFixed(1) + ' KB)');
      return true;
    } catch (err) {
      console.error('[offscreen] failed to load:', filename, err);
      throw err;
    }
  });
  
  await Promise.all(loadPromises);
  window.preloadComplete = true;
  const elapsed = (performance.now() - startTime).toFixed(0);
  console.log('[offscreen] all dictionaries pre-loaded in', elapsed, 'ms');
  console.log('[offscreen] cache keys:', Array.from(window.dictCache.keys()));
}

function pickCtor(ns) {
  if (!ns) return null;
  if (typeof ns === 'function') return ns;
  if (ns && typeof ns.default === 'function') return ns.default;
  if (ns && typeof ns.Kuroshiro === 'function') return ns.Kuroshiro;
  if (ns && ns.default && typeof ns.default.Kuroshiro === 'function') return ns.default.Kuroshiro;
  return null;
}

const KuroCtor = pickCtor(window.Kuroshiro) || pickCtor(window.kuroshiro);
if (!KuroCtor) {
  console.error('[offscreen] Kuroshiro ctor not found. typeof window.Kuroshiro =', typeof window.Kuroshiro);
  throw new Error('Kuroshiro constructor not found');
}

const AnalyzerCtor =
  window.KuromojiAnalyzer ||
  window.KuroshiroAnalyzerKuromoji ||
  (window.kuroshiroAnalyzerKuromoji && window.kuroshiroAnalyzerKuromoji.default) ||
  window.kuroshiroAnalyzerKuromoji ||
  (window.Kuroshiro && window.Kuroshiro.Analyzer) ||
  (window.Kuro && window.Kuro.KuromojiAnalyzer) ||
  (window.Kuro && window.Kuro.default && window.Kuro.default.KuromojiAnalyzer);

if (typeof AnalyzerCtor !== 'function') {
  console.error('[offscreen] Analyzer ctor not found');
  throw new Error('KuromojiAnalyzer constructor not found');
}

const kuro = new KuroCtor();

let ready = false;
const queue = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'ROMAJI_INIT') {
    sendResponse({ ok: true, status: ready ? 'ready' : 'initializing' });
    return true;
  }

  if (msg.type === 'ROMAJI_CONVERT_BATCH') {
    const task = () => {
      const items = Array.isArray(msg.items) ? msg.items : [];
      Promise.all(items.map(t =>
        kuro.convert(String(t ?? ''), {
          to: 'romaji',
          mode: 'spaced',
          romajiSystem: 'hepburn'
        })
      ))
      .then(out => sendResponse({ ok: true, out }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    };
    if (!ready) {
      queue.push(task);
      return true;
    }
    task();
    return true;
  }
});

(async () => {
  try {
    await preloadDictionaries();
    
    const dictPath = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';
    console.log('[offscreen] creating analyzer with CDN dictPath:', dictPath);
    const analyzer = new AnalyzerCtor({ dictPath });
    console.log('[offscreen] analyzer created, initializing kuroshiro...');
    await kuro.init(analyzer);
    ready = true;
    console.log('[offscreen] kuroshiro initialized successfully with CDN dictionaries');
    while (queue.length) queue.shift()();
    chrome.runtime.sendMessage({ type: 'ROMAJI_OFFSCREEN_READY' }).catch(e => {
      console.error('[offscreen] failed to send ready message:', e);
    });
  } catch (e) {
    console.error('[offscreen] init failed:', e);
    console.error('[offscreen] error stack:', e.stack);
    const errMsg = e && e.message ? e.message : (e && e.type ? `${e.type} event` : String(e || 'unknown error'));
    chrome.runtime.sendMessage({ type: 'ROMAJI_OFFSCREEN_ERROR', error: errMsg }).catch(() => {});
  }
})();
