const vidEl = document.getElementById("vid");
const titleEl = document.getElementById("title");
const fileEl = document.getElementById("file");
const nameEl = document.getElementById("name");
const saveEl = document.getElementById("save");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const listEl = document.getElementById("list");

let ctx = null;
let parsed = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let videoId = null;
  try {
    const url = new URL(tab.url);
    const vParam = url.searchParams.get("v");
    const shorts = url.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);
    videoId = vParam || (shorts ? shorts[1] : null);
  } catch (err) {
    videoId = null;
  }

  ctx = { tabId: tab.id, videoId };
  vidEl.textContent = videoId ? `Video ID: ${videoId}` : "No video detected";
  titleEl.textContent = await getTabTitle(tab.id);

  saveEl.disabled = true;
  fileEl.value = "";
  refreshList();

  fileEl.addEventListener("change", onFileChosen);
  saveEl.addEventListener("click", onSave);
  
  const clearCacheBtn = document.getElementById("clear-cache");
  clearCacheBtn.addEventListener("click", async () => {
    if (!confirm("Clear all romanization cache? This will not delete custom subtitles.")) {
      return;
    }
    
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter(k => k.startsWith("cache:"));
    
    if (cacheKeys.length === 0) {
      setStatus("No cache to clear", false);
      return;
    }
    
    await chrome.storage.local.remove(cacheKeys);
    setStatus(`Cleared ${cacheKeys.length} cached items`, false);
  });
}

function getTabTitle(tabId) {
  return new Promise(resolve => {
    chrome.scripting.executeScript(
      { target: { tabId }, func: () => document.title.replace(/\s*- YouTube\s*$/i, "") },
      res => resolve((res && res[0] && res[0].result) || "")
    );
  });
}

async function onFileChosen(e) {
  if (!ctx.videoId) {
    setStatus("Open a YouTube video", true);
    return;
  }
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) {
    setStatus("File too large", true);
    return;
  }
  const buf = await f.arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf));

  try {
    parsed = parseSubs(text, f.name.toLowerCase());
    if (!parsed.cues.length) throw new Error("No cues");
    renderPreview(parsed.cues.slice(0, 6));
    setStatus(`Parsed ${parsed.cues.length} cues`, false);
    if (!nameEl.value) nameEl.value = trimBase(f.name);
    saveEl.disabled = false;
  } catch (err) {
    setStatus(`Invalid subtitle: ${err.message}`, true);
    previewEl.innerHTML = "";
    saveEl.disabled = true;
  }
}

async function onSave() {
  if (!parsed || !ctx.videoId) return;
  const name = nameEl.value.trim();
  if (!name) {
    setStatus("Enter a track name", true);
    return;
  }
  const key = `subs:${ctx.videoId}:${Date.now()}`;
  const rec = {
    ts: Date.now(),
    name,
    meta: { title: titleEl.textContent || "", videoId: ctx.videoId },
    cues: parsed.cues
  };
  await chrome.storage.local.set({ [key]: rec });
  setStatus("Saved", false);
  saveEl.disabled = true;
  previewEl.innerHTML = "";
  fileEl.value = "";
  nameEl.value = "";
  parsed = null;
  refreshList();
}

async function refreshList() {
  listEl.innerHTML = "";
  if (!ctx.videoId) return;
  const all = await chrome.storage.local.get(null);
  const items = Object.entries(all)
    .filter(([k]) => k.startsWith(`subs:${ctx.videoId}:`))
    .sort((a, b) => {
      const at = a[1] && a[1].ts ? a[1].ts : 0;
      const bt = b[1] && b[1].ts ? b[1].ts : 0;
      if (at !== bt) return bt - at;
      return a[0].localeCompare(b[0]);
    });

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No custom tracks saved for this video.";
    listEl.appendChild(empty);
    return;
  }

  for (const [k, v] of items) {
    const row = document.createElement("div");
    row.className = "item";
    row.setAttribute("role", "listitem");

    const input = document.createElement("input");
    const displayName = v && v.name ? v.name : "Custom track";
    input.value = displayName;
    input.setAttribute("aria-label", `Rename ${displayName}`);
    input.addEventListener("change", async () => {
      v.name = input.value.trim() || displayName;
      v.ts = Date.now();
      await chrome.storage.local.set({ [k]: v });
      setStatus("Renamed", false);
      refreshList();
    });

    const btns = document.createElement("div");
    btns.className = "btns";

    const del = document.createElement("button");
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await chrome.storage.local.remove([k]);
      setStatus("Deleted", false);
      refreshList();
    });

    btns.appendChild(del);
    row.appendChild(input);
    row.appendChild(btns);
    listEl.appendChild(row);
  }
}

function setStatus(text, isErr) {
  statusEl.textContent = text;
  statusEl.className = isErr ? "err" : "ok";
}

function trimBase(n) {
  return n.replace(/\.(srt|vtt|ass|ssa|txt)$/i, "");
}

function renderPreview(cues) {
  previewEl.innerHTML = cues
    .map(c => `<div>[${formatTime(c.start)} → ${formatTime(c.end)}] ${escapeHtml(c.text)}</div>`)
    .join("");
}

function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(3);
  return `${m}:${String(s).padStart(6, "0")}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function parseSubs(text, name) {
  if (/\.vtt$/.test(name) || /^WEBVTT/m.test(text)) return parseVTT(text);
  if (/\.srt$/.test(name)) return parseSRT(text);
  if (/\.(ass|ssa)$/.test(name) || /^\[Script Info\]/m.test(text)) return parseASS(text);
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}/m.test(text)) return parseSRT(text);
  if (/^WEBVTT/m.test(text)) return parseVTT(text);
  return parseSRT(text);
}

function parseSRT(t) {
  const blocks = t.replace(/\r/g, "").split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0])) i = 1;
    const m = lines[i].match(
      /(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/
    );
    if (!m) continue;
    const s = h(m[1], m[2], m[3], m[4]);
    const e = h(m[5], m[6], m[7], m[8]);
    const text = lines.slice(i+1).join("\n").trim();
    if (text) cues.push({ start: s, end: e, text });
  }
  return { cues };
  function h(H, M, S, ms) {
    return (+H) * 3600 + (+M) * 60 + (+S) + (+ms) / 1000;
  }
}

function parseVTT(t) {
  const lines = t.replace(/\r/g, "").split("\n");
  const cues = [];
  let i = 0;
  if (/^WEBVTT/.test(lines[0])) i = 1;
  while (i < lines.length) {
    while (i < lines.length && /^\s*$/.test(lines[i])) i++;
    if (i >= lines.length) break;
    if (/^[^\d]*$/.test(lines[i]) && !/-->/.test(lines[i])) i++;
    if (i >= lines.length) break;
    const m = lines[i].match(/(\d+:)?\d{2}:\d{2}\.\d{3}\s*-->\s*(\d+:)?\d{2}:\d{2}\.\d{3}/);
    if (!m) { i++; continue; }
    const [a, b] = lines[i].split(/-->/).map(s => s.trim());
    i++;
    const text = [];
    while (i < lines.length && /\S/.test(lines[i])) { text.push(lines[i]); i++; }
    cues.push({ start: v(a), end: v(b), text: text.join("\n").trim() });
  }
  return { cues };
  function v(x) {
    const m = x.match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
    const h = m[1] || 0;
    return h * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  }
}

function parseASS(t) {
  const lines = t.replace(/\r/g, "").split("\n");
  let fmt = null;
  const cues = [];
  for (const ln of lines) {
    if (/^Format:/i.test(ln)) {
      fmt = ln.split(":")[1].split(",").map(s => s.trim());
    } else if (/^Dialogue:/i.test(ln) && fmt) {
      const rest = ln.split(":")[1];
      const parts = splitAss(rest, fmt.length);
      const map = {};
      fmt.forEach((k, i) => map[k.toLowerCase()] = parts[i]);
      const s = assTime(map.start || parts[1]);
      const e = assTime(map.end || parts[2]);
      let text = (map.text || parts[fmt.indexOf("Text")])
        .replace(/{[^}]*}/g, "")
        .replace(/\\N/gi, "\n")
        .trim();
      if (text) cues.push({ start: s, end: e, text });
    }
  }
  return { cues };
  function assTime(x) {
    const m = String(x).trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + ((+m[4]) * 10) / 1000;
  }
  function splitAss(s, n) {
    const out = [];
    let cur = "";
    let braces = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "," && braces === 0 && out.length < n - 1) {
        out.push(cur);
        cur = "";
        continue;
      }
      if (ch === "{") braces++;
      if (ch === "}") braces--;
      cur += ch;
    }
    out.push(cur);
    return out;
  }
}
