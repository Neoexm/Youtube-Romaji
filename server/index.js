require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const MXM_KEY = process.env.MUSIXMATCH_API_KEY || '34048171d9684fd140aeed6460910642';
const MXM_BASE = 'https://api.musixmatch.com/ws/1.1';

let kuroshiro = null;
let kuroshiroReady = false;

async function initKuroshiro() {
  if (kuroshiroReady) return;
  try {
    console.log('[kuroshiro] initializing...');
    const kuroshiroModule = require('kuroshiro');
    const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
    const Kuroshiro = kuroshiroModule.default || kuroshiroModule;
    kuroshiro = new Kuroshiro();
    await kuroshiro.init(new KuromojiAnalyzer());
    kuroshiroReady = true;
    console.log('[kuroshiro] ready');
  } catch (err) {
    console.error('[kuroshiro] init failed:', err.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============================================================================
// CACHE
// ============================================================================

const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 500) {
    const cutoff = Date.now() - CACHE_TTL;
    for (const [k, v] of cache) {
      if (v.ts < cutoff) cache.delete(k);
    }
  }
}

// ============================================================================
// MUSIXMATCH HELPERS
// ============================================================================

async function mxm(endpoint, params) {
  const url = `${MXM_BASE}/${endpoint}`;
  console.log(`[mxm] ${endpoint}:`, JSON.stringify(params));
  const res = await axios.get(url, {
    params: { apikey: MXM_KEY, ...params },
    timeout: 10000
  });
  const msg = res.data?.message;
  if (!msg || msg.header?.status_code !== 200) {
    const code = msg?.header?.status_code || 'unknown';
    const bodySnip = JSON.stringify(msg?.body || {}).substring(0, 200);
    console.log(`[mxm] error response:`, { code, body: bodySnip });
    throw new Error(`Musixmatch ${endpoint}: ${code}`);
  }
  return msg.body;
}

function parseLRC(lrcBody) {
  const cues = [];

  for (const line of lrcBody.split('\n')) {
    const m = line.trim().match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
    if (!m) continue;
    const mins = parseInt(m[1]);
    const secs = parseInt(m[2]);
    const ms = m[3].length === 2 ? parseInt(m[3]) * 10 : parseInt(m[3]);
    const text = m[4].trim();
    if (!text) continue;
    cues.push({ start: mins * 60 + secs + ms / 1000, text });
  }

  for (let i = 0; i < cues.length; i++) {
    cues[i].end = i + 1 < cues.length ? cues[i + 1].start : cues[i].start + 5;
  }

  return cues;
}

// ============================================================================
// STRING SIMILARITY
// ============================================================================

function calculateSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  // Check if one is a substring of the other
  if (a.includes(b) || b.includes(a)) return 0.8;

  // Levenshtein distance based similarity
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  const similarity = 1 - distance / maxLen;

  return Math.max(0, similarity);
}

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1)
    .fill(null)
    .map(() => Array(a.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }

  return matrix[b.length][a.length];
}

// ============================================================================

function cleanTitle(raw) {
  let s = raw;
  s = s.replace(/【.*?】/g, '');
  s = s.replace(/\[.*?\]/g, '');
  s = s.replace(/\(.*?(official|mv|video|lyric|romaji|romanized|full|ver|version).*?\)/gi, '');
  s = s.replace(/\|.*$/g, '');
  s = s.replace(/[-–—]\s*(official|mv|video|lyric|romaji|romanized).*$/gi, '');
  s = s.replace(/\s*official\s+music\s+video\s*$/gi, '');
  s = s.replace(/\s*official\s+video\s*$/gi, '');
  s = s.replace(/\s*music\s+video\s*$/gi, '');
  s = s.replace(/\s+(mv|official|video|lyric|lyrics|romaji|romanized)\s*$/gi, '');
  return s.replace(/\s+/g, ' ').trim();
}

function parseSongInfo(title, channel) {
  const cleaned = cleanTitle(title);

  // Japanese bracket format: Artist「Song」 or Artist『Song』
  const jpBracket = cleaned.match(/^(.+?)\s*[「『](.+?)[」』]/);
  if (jpBracket) {
    let artist = jpBracket[1].trim();
    artist = extractPrimaryArtist(artist);
    return { artist, track: jpBracket[2].trim() };
  }

  // Standard dash format: Artist - Song
  const dash = cleaned.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
  if (dash) {
    let artist = dash[1].trim();
    artist = extractPrimaryArtist(artist);
    return { artist, track: dash[2].trim() };
  }

  // Slash format: Song / Artist (common in JP YouTube)
  const slash = cleaned.match(/^(.+?)\s*\/\s*(.+)$/);
  if (slash) {
    let artist = slash[2].trim();
    artist = extractPrimaryArtist(artist);
    return { artist, track: slash[1].trim() };
  }

  return { artist: channel || '', track: cleaned };
}

function extractPrimaryArtist(artist) {
  artist = artist.trim();
  artist = artist.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  artist = artist.split(/\s+(feat\.|ft\.|featuring|vs\.?|VS|&)\s+/i)[0].trim();
  return artist;
}

// ============================================================================
// ROMANIZATION
// ============================================================================

async function romanize(text) {
  if (!kuroshiroReady || !kuroshiro) {
    throw new Error('Kuroshiro not ready');
  }
  return kuroshiro.convert(text, {
    to: 'romaji',
    mode: 'spaced',
    romajiSystem: 'hepburn'
  });
}

// ============================================================================
// ENDPOINTS
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', kuroshiro: kuroshiroReady });
});

app.post('/lyrics', async (req, res) => {
  try {
    let { videoId, title, artist, duration } = req.body;

    if (!title && !videoId) {
      return res.status(400).json({ ok: false, error: 'Provide title or videoId' });
    }

    if (!title && videoId) {
      try {
        const oembed = await axios.get(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
          { timeout: 5000 }
        );
        title = oembed.data.title || '';
        if (!artist) artist = oembed.data.author_name || '';
      } catch (e) {
        return res.json({ ok: false, error: 'Could not fetch video info' });
      }
    }

    const cacheKey = `mxm:${videoId || title}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[lyrics] cache hit: ${videoId || title}`);
      return res.json(cached);
    }

    const songInfo = parseSongInfo(title, artist);
    console.log(`[lyrics] searching: "${songInfo.track}" by "${songInfo.artist}"`);

    // Find track on Musixmatch
    let track = null;

    // Strategy 1: search with Japanese language filter
    try {
      const body = await mxm('track.search', {
        q_track: songInfo.track,
        q_artist: songInfo.artist,
        f_lyrics_language: 'ja',
        f_has_lyrics: 1,
        page_size: 5,
        s_track_rating: 'desc'
      });
      if (body?.track_list?.length > 0) {
        track = body.track_list[0].track;
        console.log(`[lyrics] ja-search: "${track.track_name}" by ${track.artist_name}`);
      } else {
        console.log(`[lyrics] ja-search: no results`);
      }
    } catch (e) {
      console.log(`[lyrics] ja-search failed: ${e.message}`);
    }

    // Strategy 2: matcher (fuzzy)
    if (!track) {
      try {
        const body = await mxm('matcher.track.get', {
          q_track: songInfo.track,
          q_artist: songInfo.artist
        });
        if (body?.track) {
          track = body.track;
          console.log(`[lyrics] matcher: "${track.track_name}" by ${track.artist_name}`);
        } else {
          console.log(`[lyrics] matcher: no result`);
        }
      } catch (e) {
        console.log(`[lyrics] matcher failed: ${e.message}`);
      }
    }

    // Strategy 3: romanize the track name and search (before broad match attempts)
    if (!track && kuroshiroReady) {
      try {
        const romanized = await romanize(songInfo.track);
        console.log(`[lyrics] romanized track: "${romanized}"`);
        const body = await mxm('track.search', {
          q_track: romanized,
          q_artist: songInfo.artist,
          f_has_lyrics: 1,
          page_size: 10,
          s_track_rating: 'desc'
        });
        if (body?.track_list?.length > 0) {
          track = body.track_list[0].track;
          console.log(`[lyrics] romanized-search: "${track.track_name}" by ${track.artist_name}`);
        } else {
          console.log(`[lyrics] romanized-search: no results`);
        }
      } catch (e) {
        console.log(`[lyrics] romanized-search failed: ${e.message}`);
      }
    }

    // Strategy 4: simplified artist search (broad fallback)
    if (!track) {
      try {
        const simpleArtist = songInfo.artist.split(/\s+/)[0];
        const body = await mxm('track.search', {
          q: `${simpleArtist} ${songInfo.track}`,
          f_has_lyrics: 1,
          page_size: 10,
          s_track_rating: 'desc'
        });
        if (body?.track_list?.length > 0) {
          track = body.track_list[0].track;
          console.log(`[lyrics] simplified-search: "${track.track_name}" by ${track.artist_name}`);
        } else {
          console.log(`[lyrics] simplified-search: no results`);
        }
      } catch (e) {
        console.log(`[lyrics] simplified-search failed: ${e.message}`);
      }
    }

    // Strategy 5: try matching by track title alone
    if (!track) {
      try {
        const body = await mxm('track.search', {
          q_track: songInfo.track,
          f_lyrics_language: 'ja',
          f_has_lyrics: 1,
          page_size: 10,
          s_track_rating: 'desc'
        });
        if (body?.track_list?.length > 0) {
          track = body.track_list[0].track;
          console.log(`[lyrics] track-only: "${track.track_name}" by ${track.artist_name}`);
        } else {
          console.log(`[lyrics] track-only: no results`);
        }
      } catch (e) {
        console.log(`[lyrics] track-only failed: ${e.message}`);
      }
    }

    if (!track) {
      const response = { ok: false, error: 'Song not found on Musixmatch' };
      setCache(cacheKey, response);
      return res.json(response);
    }

    // Calculate match confidence (will validate after we get lyrics)
    const matchConfidence = calculateSimilarity(
      songInfo.track.toLowerCase(),
      track.track_name.toLowerCase()
    );
    console.log(`[lyrics] initial match confidence: ${matchConfidence.toFixed(2)} - "${track.track_name}"`)

    // Get synced subtitles
    let cues = null;
    let subtitleLang = null;

    if (track.has_subtitles) {
      try {
        const params = { commontrack_id: track.commontrack_id, subtitle_format: 'lrc' };
        if (duration) {
          params.f_subtitle_length = Math.round(duration);
          params.f_subtitle_length_max_deviation = 10;
        }
        const body = await mxm('track.subtitle.get', params);
        if (body?.subtitle?.subtitle_body) {
          cues = parseLRC(body.subtitle.subtitle_body);
          subtitleLang = body.subtitle.subtitle_language;
          console.log(`[lyrics] synced: ${cues.length} cues (lang: ${subtitleLang})`);
        }
      } catch (e) {
        console.log(`[lyrics] subtitle failed: ${e.message}`);
      }
    }

    // Fallback: unsynced lyrics
    if (!cues || cues.length === 0) {
      try {
        const body = await mxm('track.lyrics.get', {
          commontrack_id: track.commontrack_id
        });
        if (body?.lyrics?.lyrics_body) {
          subtitleLang = body.lyrics.lyrics_language;
          const lines = body.lyrics.lyrics_body.split('\n').filter(l => l.trim());
          const avg = duration ? duration / lines.length : 4;
          cues = lines.map((text, i) => ({
            start: i * avg,
            end: (i + 1) * avg,
            text: text.trim()
          }));
          console.log(`[lyrics] unsynced: ${cues.length} lines (lang: ${subtitleLang})`);
        }
      } catch (e) {
        console.log(`[lyrics] lyrics failed: ${e.message}`);
      }
    }

    if (!cues || cues.length === 0) {
      const response = { ok: false, error: 'No lyrics found or lyrics not available for this song' };
      setCache(cacheKey, response);
      return res.json(response);
    }

    // Revalidate match now that we have cues - be lenient if lyrics are actually Japanese
    const cuesSample = cues.slice(0, 10).map(c => c.text).join('');
    const hasJapaneseLyrics = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(cuesSample);
    const minConfidence = hasJapaneseLyrics ? 0.15 : 0.4;

    if (matchConfidence < minConfidence) {
      console.log(`[lyrics] match confidence too low: ${matchConfidence.toFixed(2)} (threshold: ${minConfidence}, hasJP: ${hasJapaneseLyrics})`);
      console.log(`[lyrics]   searched: "${songInfo.track}"`);
      console.log(`[lyrics]   matched: "${track.track_name}"`);
      const response = { ok: false, error: 'Could not find accurate match on Musixmatch' };
      setCache(cacheKey, response);
      return res.json(response);
    }

    console.log(`[lyrics] passed validation: confidence ${matchConfidence.toFixed(2)} (threshold: ${minConfidence})`);

    // Verify Japanese content
    if (subtitleLang && subtitleLang !== 'ja') {
      const hasJP = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(cuesSample);
      if (!hasJP) {
        const response = { ok: false, error: `Lyrics are in ${subtitleLang}, not Japanese` };
        setCache(cacheKey, response);
        return res.json(response);
      }
    }

    // Romanize
    if (!kuroshiroReady) await initKuroshiro();
    if (!kuroshiroReady) {
      return res.json({ ok: false, error: 'Romanization engine failed to load' });
    }

    const romanized = [];
    for (const cue of cues) {
      try {
        const text = await romanize(cue.text);
        romanized.push({ start: cue.start, end: cue.end, text: text || cue.text });
      } catch (e) {
        romanized.push({ start: cue.start, end: cue.end, text: cue.text });
      }
    }

    const synced = cues.length > 1 && cues[1].start > 0;

    const response = {
      ok: true,
      cues: romanized,
      synced,
      trackName: track.track_name,
      artistName: track.artist_name
    };

    setCache(cacheKey, response);
    console.log(`[lyrics] done: ${romanized.length} cues, synced=${synced}`);
    res.json(response);

  } catch (err) {
    console.error('[lyrics] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// STARTUP
// ============================================================================

initKuroshiro().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Romaji API Server listening on port ${PORT}`);
    console.log(`Musixmatch API Key: ${MXM_KEY ? 'configured' : 'MISSING'}`);
    console.log(`Kuroshiro: ${kuroshiroReady ? 'ready' : 'failed'}`);
  });
});
