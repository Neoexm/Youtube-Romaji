require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createRomajiClient, DEFAULT_ENGINE_VERSION } = require('./lib/romaji-client');

const DEFAULT_PORT = process.env.PORT || 3000;
const DEFAULT_MXM_KEY = process.env.MUSIXMATCH_API_KEY || '34048171d9684fd140aeed6460910642';
const MXM_BASE = 'https://api.musixmatch.com/ws/1.1';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const JAPANESE_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;

function getCached(cacheStore, key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cacheStore.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(cacheStore, key, data) {
  cacheStore.set(key, { data, ts: Date.now() });
  if (cacheStore.size <= 500) return;

  const cutoff = Date.now() - CACHE_TTL;
  for (const [candidateKey, value] of cacheStore) {
    if (value.ts < cutoff) cacheStore.delete(candidateKey);
  }
}

function createMusixmatchRequester({ apiKey = DEFAULT_MXM_KEY, baseUrl = MXM_BASE, httpClient = axios, logger = console } = {}) {
  return async function mxm(endpoint, params) {
    const url = `${baseUrl}/${endpoint}`;
    logger.log(`[mxm] ${endpoint}:`, JSON.stringify(params));

    const res = await httpClient.get(url, {
      params: { apikey: apiKey, ...params },
      timeout: 10000
    });

    const msg = res.data?.message;
    if (!msg || msg.header?.status_code !== 200) {
      const code = msg?.header?.status_code || 'unknown';
      const bodySnip = JSON.stringify(msg?.body || {}).substring(0, 200);
      logger.log('[mxm] error response:', { code, body: bodySnip });
      throw new Error(`Musixmatch ${endpoint}: ${code}`);
    }

    return msg.body;
  };
}

function parseLRC(lrcBody) {
  const cues = [];

  for (const line of lrcBody.split('\n')) {
    const match = line.trim().match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)$/);
    if (!match) continue;

    const mins = Number.parseInt(match[1], 10);
    const secs = Number.parseInt(match[2], 10);
    const ms = match[3].length === 2 ? Number.parseInt(match[3], 10) * 10 : Number.parseInt(match[3], 10);
    const text = match[4].trim();
    if (!text) continue;

    cues.push({ start: mins * 60 + secs + ms / 1000, text });
  }

  for (let index = 0; index < cues.length; index += 1) {
    cues[index].end = index + 1 < cues.length ? cues[index + 1].start : cues[index].start + 5;
  }

  return cues;
}

function levenshteinDistance(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, () => Array(a.length + 1).fill(0));

  for (let index = 0; index <= a.length; index += 1) matrix[0][index] = index;
  for (let index = 0; index <= b.length; index += 1) matrix[index][0] = index;

  for (let row = 1; row <= b.length; row += 1) {
    for (let col = 1; col <= a.length; col += 1) {
      const cost = a[col - 1] === b[row - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row][col - 1] + 1,
        matrix[row - 1][col] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[b.length][a.length];
}

function calculateSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 0.8;

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return Math.max(0, 1 - distance / maxLen);
}

function cleanTitle(raw) {
  let value = raw;
  value = value.replace(/【.*?】/g, '');
  value = value.replace(/\[.*?\]/g, '');
  value = value.replace(/\(.*?(official|mv|video|lyric|romaji|romanized|full|ver|version).*?\)/gi, '');
  value = value.replace(/\|.*$/g, '');
  value = value.replace(/[-–—]\s*(official|mv|video|lyric|romaji|romanized).*$/gi, '');
  value = value.replace(/\s*official\s+music\s+video\s*$/gi, '');
  value = value.replace(/\s*official\s+video\s*$/gi, '');
  value = value.replace(/\s*music\s+video\s*$/gi, '');
  value = value.replace(/\s+(mv|official|video|lyric|lyrics|romaji|romanized)\s*$/gi, '');
  return value.replace(/\s+/g, ' ').trim();
}

function extractPrimaryArtist(artist) {
  return artist
    .trim()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .split(/\s+(feat\.|ft\.|featuring|vs\.?|VS|&)\s+/i)[0]
    .trim();
}

function parseSongInfo(title, channel) {
  const cleaned = cleanTitle(title);
  const jpBracket = cleaned.match(/^(.+?)\s*[「『](.+?)[」』]/);
  if (jpBracket) {
    return { artist: extractPrimaryArtist(jpBracket[1].trim()), track: jpBracket[2].trim() };
  }

  const dash = cleaned.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
  if (dash) {
    return { artist: extractPrimaryArtist(dash[1].trim()), track: dash[2].trim() };
  }

  const slash = cleaned.match(/^(.+?)\s*\/\s*(.+)$/);
  if (slash) {
    return { artist: extractPrimaryArtist(slash[2].trim()), track: slash[1].trim() };
  }

  return { artist: channel || '', track: cleaned };
}

function containsJapanese(text) {
  return JAPANESE_RE.test(text || '');
}

async function resolveTrack({ songInfo, duration, romajiClient, mxmRequest, logger }) {
  let track = null;

  try {
    const body = await mxmRequest('track.search', {
      q_track: songInfo.track,
      q_artist: songInfo.artist,
      f_lyrics_language: 'ja',
      f_has_lyrics: 1,
      page_size: 5,
      s_track_rating: 'desc'
    });
    if (body?.track_list?.length > 0) {
      track = body.track_list[0].track;
      logger.log(`[lyrics] ja-search: "${track.track_name}" by ${track.artist_name}`);
    } else {
      logger.log('[lyrics] ja-search: no results');
    }
  } catch (error) {
    logger.log(`[lyrics] ja-search failed: ${error.message}`);
  }

  if (!track) {
    try {
      const body = await mxmRequest('matcher.track.get', {
        q_track: songInfo.track,
        q_artist: songInfo.artist
      });
      if (body?.track) {
        track = body.track;
        logger.log(`[lyrics] matcher: "${track.track_name}" by ${track.artist_name}`);
      } else {
        logger.log('[lyrics] matcher: no result');
      }
    } catch (error) {
      logger.log(`[lyrics] matcher failed: ${error.message}`);
    }
  }

  if (!track) {
    try {
      const romanized = await romajiClient.romanizeText(songInfo.track, {
        source: 'lyrics-search',
        duration
      });
      logger.log(`[lyrics] romanized track: "${romanized.text}"`);

      const body = await mxmRequest('track.search', {
        q_track: romanized.text,
        q_artist: songInfo.artist,
        f_has_lyrics: 1,
        page_size: 10,
        s_track_rating: 'desc'
      });

      if (body?.track_list?.length > 0) {
        track = body.track_list[0].track;
        logger.log(`[lyrics] romanized-search: "${track.track_name}" by ${track.artist_name}`);
      } else {
        logger.log('[lyrics] romanized-search: no results');
      }
    } catch (error) {
      logger.log(`[lyrics] romanized-search failed: ${error.message}`);
    }
  }

  if (!track) {
    try {
      const simpleArtist = songInfo.artist.split(/\s+/)[0];
      const body = await mxmRequest('track.search', {
        q: `${simpleArtist} ${songInfo.track}`,
        f_has_lyrics: 1,
        page_size: 10,
        s_track_rating: 'desc'
      });
      if (body?.track_list?.length > 0) {
        track = body.track_list[0].track;
        logger.log(`[lyrics] simplified-search: "${track.track_name}" by ${track.artist_name}`);
      } else {
        logger.log('[lyrics] simplified-search: no results');
      }
    } catch (error) {
      logger.log(`[lyrics] simplified-search failed: ${error.message}`);
    }
  }

  if (!track) {
    try {
      const body = await mxmRequest('track.search', {
        q_track: songInfo.track,
        f_lyrics_language: 'ja',
        f_has_lyrics: 1,
        page_size: 10,
        s_track_rating: 'desc'
      });
      if (body?.track_list?.length > 0) {
        track = body.track_list[0].track;
        logger.log(`[lyrics] track-only: "${track.track_name}" by ${track.artist_name}`);
      } else {
        logger.log('[lyrics] track-only: no results');
      }
    } catch (error) {
      logger.log(`[lyrics] track-only failed: ${error.message}`);
    }
  }

  return track;
}

async function fetchCues({ track, duration, mxmRequest, logger }) {
  let cues = null;
  let subtitleLang = null;

  if (track.has_subtitles) {
    try {
      const params = { commontrack_id: track.commontrack_id, subtitle_format: 'lrc' };
      if (duration) {
        params.f_subtitle_length = Math.round(duration);
        params.f_subtitle_length_max_deviation = 10;
      }

      const body = await mxmRequest('track.subtitle.get', params);
      if (body?.subtitle?.subtitle_body) {
        cues = parseLRC(body.subtitle.subtitle_body);
        subtitleLang = body.subtitle.subtitle_language;
        logger.log(`[lyrics] synced: ${cues.length} cues (lang: ${subtitleLang})`);
      }
    } catch (error) {
      logger.log(`[lyrics] subtitle failed: ${error.message}`);
    }
  }

  if (!cues || cues.length === 0) {
    try {
      const body = await mxmRequest('track.lyrics.get', { commontrack_id: track.commontrack_id });
      if (body?.lyrics?.lyrics_body) {
        subtitleLang = body.lyrics.lyrics_language;
        const lines = body.lyrics.lyrics_body.split('\n').filter((line) => line.trim());
        const avg = duration ? duration / lines.length : 4;
        cues = lines.map((text, index) => ({
          start: index * avg,
          end: (index + 1) * avg,
          text: text.trim()
        }));
        logger.log(`[lyrics] unsynced: ${cues.length} lines (lang: ${subtitleLang})`);
      }
    } catch (error) {
      logger.log(`[lyrics] lyrics failed: ${error.message}`);
    }
  }

  return { cues, subtitleLang };
}

async function validateMatch({ songInfo, track, cues, romajiClient, logger }) {
  const matchConfidence = calculateSimilarity(songInfo.track.toLowerCase(), track.track_name.toLowerCase());
  logger.log(`[lyrics] initial match confidence: ${matchConfidence.toFixed(2)} - "${track.track_name}"`);

  const cuesSample = cues.slice(0, 10).map((cue) => cue.text).join('');
  const hasJapaneseLyrics = containsJapanese(cuesSample);
  const inputIsRomanized = !containsJapanese(songInfo.track);

  let validatedConfidence = matchConfidence;
  if (inputIsRomanized && hasJapaneseLyrics) {
    try {
      const romanizedTrack = await romajiClient.romanizeText(track.track_name, {
        source: 'lyrics-validation'
      });
      const cleanedRomanized = romanizedTrack.text
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/\s*\[.*?\]\s*/g, '')
        .replace(/\s*\{.*?\}\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      validatedConfidence = calculateSimilarity(songInfo.track.toLowerCase(), cleanedRomanized.toLowerCase());
      logger.log(`[lyrics] revalidation (romanized): ${validatedConfidence.toFixed(2)} - "${cleanedRomanized}"`);
    } catch (error) {
      logger.log(`[lyrics] romanization for validation failed: ${error.message}`);
    }
  }

  return {
    matchConfidence,
    validatedConfidence,
    hasJapaneseLyrics,
    minConfidence: hasJapaneseLyrics ? 0.15 : 0.4
  };
}

function createServerApp(options = {}) {
  const logger = options.logger || console;
  const httpClient = options.httpClient || axios;
  const romajiClient = options.romajiClient || createRomajiClient();
  const mxmRequest = options.mxmRequest || createMusixmatchRequester({
    apiKey: options.mxmKey || DEFAULT_MXM_KEY,
    httpClient,
    logger
  });
  const cacheStore = options.cacheStore || new Map();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    logger.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      const health = await romajiClient.getHealth();
      res.json({ status: 'ok', engine: health });
    } catch (error) {
      res.json({
        status: 'degraded',
        engine: {
          name: 'python-pronunciation-pipeline',
          version: DEFAULT_ENGINE_VERSION,
          error: error.message
        }
      });
    }
  });

  app.post('/lyrics', async (req, res) => {
    try {
      let { videoId, title, artist, duration } = req.body;

      if (!title && !videoId) {
        return res.status(400).json({ ok: false, error: 'Provide title or videoId' });
      }

      if (!title && videoId) {
        try {
          const oembed = await httpClient.get(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
            { timeout: 5000 }
          );
          title = oembed.data.title || '';
          if (!artist) artist = oembed.data.author_name || '';
        } catch {
          return res.json({ ok: false, error: 'Could not fetch video info' });
        }
      }

      const cacheKey = `mxm:${DEFAULT_ENGINE_VERSION}:${videoId || title}`;
      const cached = getCached(cacheStore, cacheKey);
      if (cached) {
        logger.log(`[lyrics] cache hit: ${videoId || title}`);
        return res.json(cached);
      }

      const songInfo = parseSongInfo(title, artist);
      logger.log(`[lyrics] searching: "${songInfo.track}" by "${songInfo.artist}"`);

      const track = await resolveTrack({ songInfo, duration, romajiClient, mxmRequest, logger });
      if (!track) {
        const response = { ok: false, error: 'Song not found on Musixmatch' };
        setCache(cacheStore, cacheKey, response);
        return res.json(response);
      }

      const { cues, subtitleLang } = await fetchCues({ track, duration, mxmRequest, logger });
      if (!cues || cues.length === 0) {
        const response = { ok: false, error: 'No lyrics found or lyrics not available for this song' };
        setCache(cacheStore, cacheKey, response);
        return res.json(response);
      }

      const validation = await validateMatch({ songInfo, track, cues, romajiClient, logger });
      if (validation.validatedConfidence < validation.minConfidence) {
        logger.log(
          `[lyrics] match confidence too low: ${validation.validatedConfidence.toFixed(2)} ` +
          `(threshold: ${validation.minConfidence}, hasJP: ${validation.hasJapaneseLyrics})`
        );
        logger.log(`[lyrics]   searched: "${songInfo.track}"`);
        logger.log(`[lyrics]   matched: "${track.track_name}"`);
        const response = { ok: false, error: 'Could not find accurate match on Musixmatch' };
        setCache(cacheStore, cacheKey, response);
        return res.json(response);
      }

      logger.log(
        `[lyrics] passed validation: confidence ${validation.matchConfidence.toFixed(2)} ` +
        `(threshold: ${validation.minConfidence})`
      );

      if (subtitleLang && subtitleLang !== 'ja' && !validation.hasJapaneseLyrics) {
        const response = { ok: false, error: `Lyrics are in ${subtitleLang}, not Japanese` };
        setCache(cacheStore, cacheKey, response);
        return res.json(response);
      }

      const batch = await romajiClient.romanizeBatch(
        cues.map((cue) => cue.text),
        { source: 'lyrics-cues', preserve_line_breaks: true }
      );

      const romanized = cues.map((cue, index) => ({
        start: cue.start,
        end: cue.end,
        text: batch.items[index]?.text || cue.text
      }));

      const synced = cues.length > 1 && cues[1].start > 0;
      const response = {
        ok: true,
        cues: romanized,
        synced,
        trackName: track.track_name,
        artistName: track.artist_name,
        romajiEngine: batch.engine,
        romajiWarnings: batch.warnings
      };

      setCache(cacheStore, cacheKey, response);
      logger.log(`[lyrics] done: ${romanized.length} cues, synced=${synced}`);
      return res.json(response);
    } catch (error) {
      logger.error('[lyrics] error:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  return { app, romajiClient, cacheStore };
}

async function startServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const host = options.host || '0.0.0.0';
  const logger = options.logger || console;
  const { app, romajiClient } = createServerApp(options);

  let health = null;
  try {
    health = await romajiClient.getHealth();
  } catch (error) {
    logger.error('[romaji] health check failed:', error.message);
  }

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      logger.log(`Romaji API Server listening on port ${port}`);
      logger.log(`Musixmatch API Key: ${DEFAULT_MXM_KEY ? 'configured' : 'MISSING'}`);
      if (health) {
        logger.log(
          `[romaji] engine=${health.name} mode=${health.mode} ` +
          `kwja=${health.components.kwja.available} ` +
          `sudachi=${health.components.sudachipy.available} ` +
          `pyopenjtalk=${health.components.pyopenjtalk.available}`
        );
      }
      resolve({ server, app, health });
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[startup] failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_ENGINE_VERSION,
  calculateSimilarity,
  cleanTitle,
  createMusixmatchRequester,
  createServerApp,
  extractPrimaryArtist,
  levenshteinDistance,
  parseLRC,
  parseSongInfo,
  startServer
};
