window.dictCache = new Map();
window.preloadComplete = false;

const originalFetch = window.fetch;
window.fetch = function(url, options) {
  const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
  
  const isDictFile = (urlStr.includes('/dict/') || urlStr.includes('dict/')) && 
                     (urlStr.includes('.dat.gz') || urlStr.endsWith('.gz'));
  
  if (isDictFile) {
    const filename = urlStr.split('/').pop().split('?')[0];
    
    if (window.preloadComplete && window.dictCache.has(filename)) {
      console.log('[fetch-interceptor] SERVING from cache:', filename, '(' + (window.dictCache.get(filename).byteLength / 1024).toFixed(1) + ' KB)');
      const arrayBuffer = window.dictCache.get(filename);
      return Promise.resolve(new Response(arrayBuffer.slice(0), {
        status: 200,
        statusText: 'OK',
        headers: { 
          'Content-Type': 'application/octet-stream',
          'Content-Length': arrayBuffer.byteLength.toString()
        }
      }));
    } else if (!window.preloadComplete) {
      console.log('[fetch-interceptor] preload in progress, passing through:', filename);
    } else {
      console.warn('[fetch-interceptor] MISS - not in cache:', filename);
      console.warn('[fetch-interceptor] available:', Array.from(window.dictCache.keys()).join(', '));
    }
  }
  return originalFetch.apply(this, arguments);
};

console.log('[fetch-interceptor] installed and ready');
