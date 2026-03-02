const TTL_DAYS = 30;
const DAY_MS = 86_400_000;

async function prune() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - TTL_DAYS * DAY_MS;
  const toDelete = [];
  for (const [k, v] of Object.entries(all)) {
    if (!/^subs:/.test(k)) continue;
    const ts = v?.ts || 0;
    if (ts && ts < cutoff) toDelete.push(k);
  }
  if (toDelete.length) await chrome.storage.local.remove(toDelete);
}

if (chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms?.create("prune", { periodInMinutes: 360 });
  });
}

if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    chrome.alarms?.create("prune", { periodInMinutes: 360 });
    prune();
  });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(a => {
    if (a.name === "prune") prune();
  });
}

if (chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (!msg?.type) return;

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
