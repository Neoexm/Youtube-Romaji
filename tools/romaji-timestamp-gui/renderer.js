const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const kuromoji = require('kuromoji');
const wanakana = require('wanakana');
const crypto = require('crypto');
const { spawn } = require('child_process');

let config = {};
let currentResult = null;
let tokenizer = null;
let whisperInProgress = false;

const logOutput = document.getElementById('logOutput');
const segmentsBody = document.getElementById('segmentsBody');
const segmentsTable = document.getElementById('segmentsTable');
const vttPreview = document.getElementById('vttPreview');
const fetchAlignBtn = document.getElementById('fetchAlignBtn');
const pushDbBtn = document.getElementById('pushDbBtn');

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'secrets.local.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
    log('Config loaded successfully', 'success');
  } catch (err) {
    log(`Failed to load config: ${err.message}`, 'error');
    log('Create secrets.local.json with ROMAJI_API_BASE, ROMAJI_API_TOKEN, and optionally YOUTUBE_API_KEY', 'info');
  }
}

function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  line.textContent = `[${timestamp}] ${message}`;
  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;
  console.log(message);
}

function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();
  
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) {
    return input;
  }
  
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/v\/([A-Za-z0-9_-]{11})/
  ];
  
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

async function initKuromoji() {
  if (tokenizer) return tokenizer;
  
  return new Promise((resolve, reject) => {
    log('Initializing Kuromoji tokenizer...', 'info');
    kuromoji.builder({ dicPath: 'node_modules/kuromoji/dict' }).build((err, tok) => {
      if (err) {
        reject(err);
      } else {
        tokenizer = tok;
        log('Kuromoji initialized', 'success');
        resolve(tokenizer);
      }
    });
  });
}

async function fetchGeniusRomaji(geniusUrl) {
  log(`Fetching Genius page: ${geniusUrl}`, 'info');
  
  try {
    const response = await axios.get(geniusUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    let lyricsText = '';
    const lyricsContainers = $('[class*="Lyrics__Container"]');
    
    lyricsContainers.each((i, elem) => {
      const html = $(elem).html();
      if (html) {
        lyricsText += html + '\n';
      }
    });
    
    if (!lyricsText) {
      throw new Error('No lyrics found on page');
    }
    
    lyricsText = lyricsText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\[.*?\]/g, '')
      .trim();
    
    const lines = lyricsText.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    const normalizedLines = lines.map(line => normalizeLine(line));
    
    log(`Extracted ${normalizedLines.length} lines from Genius`, 'success');
    return normalizedLines;
  } catch (err) {
    log(`Failed to fetch Genius: ${err.message}`, 'error');
    throw err;
  }
}

function normalizeLine(line) {
  return line
    .toLowerCase()
    .replace(/[.,!?;:'"(){}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchYouTubeTrackList(videoId) {
  log(`Fetching YouTube caption tracks for ${videoId}`, 'info');
  
  try {
    const url = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data, { xmlMode: true });
    const tracks = [];
    
    $('track').each((i, elem) => {
      const track = {
        lang: $(elem).attr('lang_code'),
        name: $(elem).attr('name'),
        kind: $(elem).attr('kind')
      };
      tracks.push(track);
    });
    
    log(`Found ${tracks.length} caption tracks`, 'info');
    return tracks;
  } catch (err) {
    log(`Failed to fetch track list: ${err.message}`, 'error');
    return [];
  }
}

async function fetchYouTubeCaptionJSON3(videoId, lang, name, kind) {
  log(`Fetching captions: lang=${lang}, name=${name || 'default'}, kind=${kind || 'manual'}`, 'info');
  
  try {
    let url = `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=json3&lang=${lang}`;
    if (name) url += `&name=${encodeURIComponent(name)}`;
    if (kind) url += `&kind=${kind}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const data = response.data;
    if (!data.events || !Array.isArray(data.events)) {
      throw new Error('Invalid JSON3 format');
    }
    
    const lines = [];
    for (const event of data.events) {
      if (!event.segs) continue;
      
      const text = event.segs.map(s => s.utf8 || '').join('').trim();
      if (!text) continue;
      
      const startSec = (event.tStartMs || 0) / 1000;
      const endSec = ((event.tStartMs || 0) + (event.dDurationMs || 0)) / 1000;
      
      lines.push({ start: startSec, end: endSec, text });
    }
    
    log(`Fetched ${lines.length} caption lines`, 'success');
    return lines;
  } catch (err) {
    log(`Failed to fetch captions: ${err.message}`, 'error');
    return null;
  }
}

async function searchYouTubeForDonor(videoId) {
  log('Searching for donor video with Japanese captions...', 'info');
  
  if (config.YOUTUBE_API_KEY) {
    return await searchYouTubeWithAPI(videoId);
  } else {
    log('No YOUTUBE_API_KEY configured, skipping donor search', 'info');
    return null;
  }
}

async function searchYouTubeWithAPI(videoId) {
  try {
    const videoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${config.YOUTUBE_API_KEY}`;
    const videoRes = await axios.get(videoUrl);
    
    if (!videoRes.data.items || videoRes.data.items.length === 0) {
      throw new Error('Video not found');
    }
    
    const title = videoRes.data.items[0].snippet.title;
    log(`Original video title: ${title}`, 'info');
    
    const searchQueries = [
      `${title} 歌詞`,
      `${title} 字幕`,
      `${title} 歌ってみた`
    ];
    
    for (const query of searchQueries) {
      log(`Searching: ${query}`, 'info');
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=5&key=${config.YOUTUBE_API_KEY}`;
      const searchRes = await axios.get(searchUrl);
      
      if (!searchRes.data.items) continue;
      
      for (const item of searchRes.data.items) {
        const candidateId = item.id.videoId;
        if (candidateId === videoId) continue;
        
        log(`Checking candidate: ${candidateId}`, 'info');
        const captions = await getDonorCaptions(candidateId);
        if (captions) {
          log(`Found donor video: ${candidateId}`, 'success');
          return captions;
        }
      }
    }
    
    return null;
  } catch (err) {
    log(`YouTube API search failed: ${err.message}`, 'error');
    return null;
  }
}

async function getDonorCaptions(videoId) {
  const tracks = await fetchYouTubeTrackList(videoId);
  
  const manualJa = tracks.find(t => t.lang && t.lang.startsWith('ja') && t.kind !== 'asr');
  if (manualJa) {
    const captions = await fetchYouTubeCaptionJSON3(videoId, manualJa.lang, manualJa.name, null);
    if (captions && captions.length > 0) {
      log('timingPath=manualJA', 'info');
      return { captions, timingPath: 'manualJA' };
    }
  }
  
  const asrJa = tracks.find(t => t.lang && t.lang.startsWith('ja') && t.kind === 'asr');
  if (asrJa) {
    const captions = await fetchYouTubeCaptionJSON3(videoId, asrJa.lang, null, 'asr');
    if (captions && captions.length > 0) {
      log('timingPath=asrJA', 'info');
      return { captions, timingPath: 'asrJA' };
    }
  }
  
  return null;
}

async function alignWithWhisper(videoId, youtubeUrl, geniusRomajiLines) {
  if (whisperInProgress) {
    throw new Error('Whisper alignment already in progress');
  }
  
  whisperInProgress = true;
  
  try {
    log('Starting Whisper alignment...', 'info');
    
    const pythonBin = config.PYTHON_BIN || 'python';
    const whisperModel = config.WHISPER_MODEL || 'large-v3';
    const youtubeInputUrl = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;
    
    log(`Using Python: ${pythonBin}`, 'info');
    
    const scriptPath = path.join(__dirname, 'align', 'align_whisper.py');
    
    const args = [
      scriptPath,
      '--videoId', videoId,
      '--youtubeUrl', youtubeInputUrl,
      '--model', whisperModel
    ];
    
    return new Promise((resolve, reject) => {
      const proc = spawn(pythonBin, args);
      
      let stdout = '';
      let stderr = '';
      let downloadPhaseStarted = false;
      let downloadPhaseTime = 0;
      const DOWNLOAD_TIMEOUT = 120000;
      
      let downloadTimer = null;
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        const lines = stderr.split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            if (line.includes('Downloading audio') || line.includes('Progress:')) {
              if (!downloadPhaseStarted) {
                downloadPhaseStarted = true;
                downloadPhaseTime = Date.now();
                downloadTimer = setTimeout(() => {
                  log('Download timeout exceeded (120s), killing process', 'error');
                  proc.kill();
                  reject(new Error('Download timeout exceeded 120 seconds'));
                }, DOWNLOAD_TIMEOUT);
              }
            }
            
            if (line.includes('Ready:') || line.includes('Transcribed')) {
              if (downloadTimer) {
                clearTimeout(downloadTimer);
                downloadTimer = null;
              }
            }
            
            log(`[Whisper] ${line.trim()}`, 'info');
          }
        });
      });
      
      proc.on('close', (code) => {
        if (downloadTimer) {
          clearTimeout(downloadTimer);
        }
        
        if (code !== 0) {
          if (stderr.includes('DOWNLOAD_STALLED')) {
            reject(new Error('Download stalled: No progress for 30 seconds'));
          } else if (stderr.includes('AUDIO_DOWNLOAD_FAILED')) {
            reject(new Error('Audio download failed after all retry attempts'));
          } else if (stderr.includes('FFMPEG_NOT_FOUND')) {
            reject(new Error('FFmpeg not found. Please install FFmpeg and ensure it is in your PATH'));
          } else if (stderr.includes('WHISPER_NO_SEGMENTS')) {
            reject(new Error('Whisper transcription yielded zero segments after all retry strategies'));
          } else if (stderr.includes('ModuleNotFoundError') || stderr.includes('No module named')) {
            reject(new Error('Python dependencies not installed. Run: pip install -r requirements.txt'));
          } else {
            reject(new Error(`Whisper process exited with code ${code}. Check logs above.`));
          }
          return;
        }
        
        try {
          const result = JSON.parse(stdout);
          
          if (!result.segments || !Array.isArray(result.segments)) {
            reject(new Error('Invalid Whisper output format'));
            return;
          }
          
          if (result.segments.length === 0) {
            reject(new Error('Whisper returned zero segments'));
            return;
          }
          
          log(`Whisper transcribed ${result.segments.length} segments`, 'success');
          
          const whisperLines = result.segments.map(s => ({
            start: s.start,
            end: s.end,
            text: s.text_ja,
            normalized: s.text_romaji_normalized
          }));
          
          log('Aligning Whisper transcription to Genius romaji...', 'info');
          const alignments = alignSequencesSync(whisperLines, geniusRomajiLines);
          const segments = generateTimedSegments(alignments, whisperLines, geniusRomajiLines);
          
          const alignedLines = new Set();
          for (const align of alignments) {
            if (align.type === 'match') {
              alignedLines.add(align.target);
            } else if (align.type === 'merge_donor') {
              alignedLines.add(align.target);
            } else if (align.type === 'split_target') {
              if (Array.isArray(align.target)) {
                align.target.forEach(t => alignedLines.add(t));
              }
            }
          }
          
          const coverage = alignedLines.size / geniusRomajiLines.length;
          log(`Alignment coverage: ${(coverage * 100).toFixed(1)}% (${alignedLines.size}/${geniusRomajiLines.length} lines)`, 'info');
          
          if (coverage < 0.70) {
            reject(new Error(`Alignment coverage too low: ${(coverage * 100).toFixed(1)}% (need ≥70%)`));
            return;
          }
          
          const vtt = generateVTT(segments);
          
          log('timingPath=whisper', 'info');
          resolve({ segments, vtt, timingPath: 'whisper' });
          
        } catch (err) {
          reject(new Error(`Failed to parse Whisper output: ${err.message}`));
        }
      });
      
      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Whisper process: ${err.message}`));
      });
    });
  } finally {
    whisperInProgress = false;
  }
}

function alignSequencesSync(donorLines, targetLines) {
  const n = donorLines.length;
  const m = targetLines.length;
  
  const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(Infinity));
  const backtrack = Array(n + 1).fill(null).map(() => Array(m + 1).fill(null));
  
  dp[0][0] = 0;
  
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      
      if (i > 0 && j > 0) {
        const cost = levenshteinDistance(donorLines[i - 1].normalized, targetLines[j - 1]);
        if (dp[i - 1][j - 1] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 1][j - 1] + cost;
          backtrack[i][j] = 'match';
        }
      }
      
      if (i > 0) {
        const cost = 2;
        if (dp[i - 1][j] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 1][j] + cost;
          backtrack[i][j] = 'skip_donor';
        }
      }
      
      if (j > 0) {
        const cost = 3;
        if (dp[i][j - 1] + cost < dp[i][j]) {
          dp[i][j] = dp[i][j - 1] + cost;
          backtrack[i][j] = 'skip_target';
        }
      }
      
      if (i > 1 && j > 0) {
        const merged = donorLines[i - 2].normalized + ' ' + donorLines[i - 1].normalized;
        const cost = levenshteinDistance(merged, targetLines[j - 1]);
        if (dp[i - 2][j - 1] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 2][j - 1] + cost;
          backtrack[i][j] = 'merge_donor';
        }
      }
      
      if (i > 0 && j > 1) {
        const merged = targetLines[j - 2] + ' ' + targetLines[j - 1];
        const cost = levenshteinDistance(donorLines[i - 1].normalized, merged);
        if (dp[i - 1][j - 2] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 1][j - 2] + cost;
          backtrack[i][j] = 'split_target';
        }
      }
    }
  }
  
  const alignments = [];
  let i = n, j = m;
  
  while (i > 0 || j > 0) {
    const action = backtrack[i][j];
    
    if (action === 'match') {
      alignments.unshift({ donor: i - 1, target: j - 1, type: 'match' });
      i--; j--;
    } else if (action === 'merge_donor') {
      alignments.unshift({ donor: [i - 2, i - 1], target: j - 1, type: 'merge_donor' });
      i -= 2; j--;
    } else if (action === 'split_target') {
      alignments.unshift({ donor: i - 1, target: [j - 2, j - 1], type: 'split_target' });
      i--; j -= 2;
    } else if (action === 'skip_donor') {
      i--;
    } else if (action === 'skip_target') {
      j--;
    } else {
      break;
    }
  }
  
  return alignments;
}

async function romanizeJapanese(text) {
  const tok = await initKuromoji();
  const tokens = tok.tokenize(text);
  
  const romaji = tokens.map(token => {
    if (token.reading) {
      return wanakana.toRomaji(token.reading);
    }
    return token.surface_form;
  }).join('');
  
  return romaji;
}

async function alignSequences(donorLines, targetLines) {
  log('Performing sequence alignment...', 'info');
  
  const n = donorLines.length;
  const m = targetLines.length;
  
  const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(Infinity));
  const backtrack = Array(n + 1).fill(null).map(() => Array(m + 1).fill(null));
  
  dp[0][0] = 0;
  
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      
      if (i > 0 && j > 0) {
        const cost = levenshteinDistance(donorLines[i - 1].normalized, targetLines[j - 1]);
        if (dp[i - 1][j - 1] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 1][j - 1] + cost;
          backtrack[i][j] = 'match';
        }
      }
      
      if (i > 0) {
        const cost = 2;
        if (dp[i - 1][j] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 1][j] + cost;
          backtrack[i][j] = 'skip_donor';
        }
      }
      
      if (j > 0) {
        const cost = 3;
        if (dp[i][j - 1] + cost < dp[i][j]) {
          dp[i][j] = dp[i][j - 1] + cost;
          backtrack[i][j] = 'skip_target';
        }
      }
      
      if (i > 1 && j > 0) {
        const merged = donorLines[i - 2].normalized + ' ' + donorLines[i - 1].normalized;
        const cost = levenshteinDistance(merged, targetLines[j - 1]);
        if (dp[i - 2][j - 1] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 2][j - 1] + cost;
          backtrack[i][j] = 'merge_donor';
        }
      }
      
      if (i > 0 && j > 1) {
        const merged = targetLines[j - 2] + ' ' + targetLines[j - 1];
        const cost = levenshteinDistance(donorLines[i - 1].normalized, merged);
        if (dp[i - 1][j - 2] + cost < dp[i][j]) {
          dp[i][j] = dp[i - 1][j - 2] + cost;
          backtrack[i][j] = 'split_target';
        }
      }
    }
  }
  
  const alignments = [];
  let i = n, j = m;
  
  while (i > 0 || j > 0) {
    const action = backtrack[i][j];
    
    if (action === 'match') {
      alignments.unshift({ donor: i - 1, target: j - 1, type: 'match' });
      i--; j--;
    } else if (action === 'merge_donor') {
      alignments.unshift({ donor: [i - 2, i - 1], target: j - 1, type: 'merge_donor' });
      i -= 2; j--;
    } else if (action === 'split_target') {
      alignments.unshift({ donor: i - 1, target: [j - 2, j - 1], type: 'split_target' });
      i--; j -= 2;
    } else if (action === 'skip_donor') {
      i--;
    } else if (action === 'skip_target') {
      j--;
    } else {
      break;
    }
  }
  
  log(`Aligned ${alignments.length} segments`, 'success');
  return alignments;
}

function levenshteinDistance(a, b) {
  const matrix = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

function generateTimedSegments(alignments, donorLines, targetLines) {
  const segments = [];
  
  for (const align of alignments) {
    if (align.type === 'match') {
      const donor = donorLines[align.donor];
      segments.push({
        start: donor.start,
        end: donor.end,
        text: targetLines[align.target]
      });
    } else if (align.type === 'merge_donor') {
      const donors = align.donor.map(idx => donorLines[idx]);
      const start = donors[0].start;
      const end = donors[donors.length - 1].end;
      segments.push({
        start,
        end,
        text: targetLines[align.target]
      });
    } else if (align.type === 'split_target') {
      const donor = donorLines[align.donor];
      const duration = donor.end - donor.start;
      const targetIndices = align.target;
      const numSplits = targetIndices.length;
      const splitDuration = duration / numSplits;
      
      targetIndices.forEach((targetIdx, i) => {
        segments.push({
          start: donor.start + i * splitDuration,
          end: donor.start + (i + 1) * splitDuration,
          text: targetLines[targetIdx]
        });
      });
    }
  }
  
  return segments;
}

function generateVTT(segments) {
  let vtt = 'WEBVTT\n\n';
  
  segments.forEach((seg, idx) => {
    const startTime = formatVTTTime(seg.start);
    const endTime = formatVTTTime(seg.end);
    vtt += `${idx + 1}\n${startTime} --> ${endTime}\n${seg.text}\n\n`;
  });
  
  return vtt;
}

function formatVTTTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function displaySegments(segments) {
  segmentsBody.innerHTML = '';
  
  segments.slice(0, 50).forEach(seg => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${seg.start.toFixed(2)}s</td>
      <td>${seg.end.toFixed(2)}s</td>
      <td>${seg.text}</td>
    `;
    segmentsBody.appendChild(row);
  });
  
  if (segments.length > 50) {
    const row = document.createElement('tr');
    row.innerHTML = `<td colspan="3" style="text-align:center;font-style:italic;">... and ${segments.length - 50} more segments</td>`;
    segmentsBody.appendChild(row);
  }
  
  segmentsTable.style.display = 'table';
}

function displayVTT(vtt) {
  const preview = vtt.split('\n').slice(0, 30).join('\n');
  const remaining = vtt.split('\n').length - 30;
  
  vttPreview.textContent = preview + (remaining > 0 ? `\n\n... and ${remaining} more lines` : '');
}

async function handleFetchAlign() {
  try {
    fetchAlignBtn.disabled = true;
    pushDbBtn.disabled = true;
    currentResult = null;
    
    logOutput.innerHTML = '';
    segmentsBody.innerHTML = '';
    segmentsTable.style.display = 'none';
    vttPreview.textContent = '';
    
    const youtubeInput = document.getElementById('youtubeUrl').value.trim();
    const geniusUrl = document.getElementById('geniusUrl').value.trim();
    
    if (!youtubeInput || !geniusUrl) {
      log('Please provide both YouTube and Genius URLs', 'error');
      return;
    }
    
    const videoId = extractVideoId(youtubeInput);
    if (!videoId) {
      log('Invalid YouTube URL or video ID', 'error');
      return;
    }
    
    log(`Video ID: ${videoId}`, 'info');
    
    const geniusLines = await fetchGeniusRomaji(geniusUrl);
    
    log('Pipeline: (1) Manual JA → (2) ASR JA → (3) Whisper → (4) Donor (if enabled)', 'info');
    
    let segments, vtt, timingPath;
    
    const captionResult = await getDonorCaptions(videoId);
    
    if (captionResult) {
      log('Romanizing captions...', 'info');
      const tok = await initKuromoji();
      
      for (const line of captionResult.captions) {
        const tokens = tok.tokenize(line.text);
        const romaji = tokens.map(token => {
          if (token.reading) {
            return wanakana.toRomaji(token.reading);
          }
          return token.surface_form;
        }).join('');
        line.normalized = normalizeLine(romaji);
      }
      
      const alignments = await alignSequences(captionResult.captions, geniusLines);
      segments = generateTimedSegments(alignments, captionResult.captions, geniusLines);
      vtt = generateVTT(segments);
      timingPath = captionResult.timingPath;
      
    } else {
      log('No manual or ASR JA captions found on current video', 'info');
      
      try {
        const whisperResult = await alignWithWhisper(videoId, youtubeInput, geniusLines);
        segments = whisperResult.segments;
        vtt = whisperResult.vtt;
        timingPath = whisperResult.timingPath;
      } catch (whisperErr) {
        log(`Whisper alignment failed: ${whisperErr.message}`, 'error');
        
        if (whisperErr.message.includes('coverage too low')) {
          log('Whisper transcription succeeded but alignment coverage insufficient', 'error');
        }
        
        if (config.ENABLE_DONOR === true || config.ENABLE_DONOR === 'true') {
          log('ENABLE_DONOR=true, searching for donor video...', 'info');
          const donorResult = await searchYouTubeForDonor(videoId);
          
          if (donorResult) {
            log('Romanizing donor captions...', 'info');
            const tok = await initKuromoji();
            
            for (const line of donorResult) {
              const tokens = tok.tokenize(line.text);
              const romaji = tokens.map(token => {
                if (token.reading) {
                  return wanakana.toRomaji(token.reading);
                }
                return token.surface_form;
              }).join('');
              line.normalized = normalizeLine(romaji);
            }
            
            const alignments = await alignSequences(donorResult, geniusLines);
            segments = generateTimedSegments(alignments, donorResult, geniusLines);
            vtt = generateVTT(segments);
            timingPath = 'donor';
            log('timingPath=donor', 'info');
          } else {
            log('No donor video found with Japanese captions', 'error');
            return;
          }
        } else {
          log('ENABLE_DONOR=false, donor search disabled', 'info');
          log('All alignment methods failed', 'error');
          return;
        }
      }
    }
    
    displaySegments(segments);
    displayVTT(vtt);
    
    const romanizedText = segments.map(s => s.text).join('\n');
    const textHash = crypto.createHash('sha256').update(romanizedText).digest('hex');
    
    currentResult = {
      videoId,
      geniusUrl,
      segments,
      vtt,
      textHash,
      timingPath
    };
    
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const outputPath = path.join(outputDir, `${videoId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(currentResult, null, 2));
    log(`Saved to ${outputPath}`, 'success');
    
    pushDbBtn.disabled = false;
    log('Ready to push to database', 'success');
    
  } catch (err) {
    log(`Error: ${err.message}`, 'error');
    console.error(err);
  } finally {
    fetchAlignBtn.disabled = false;
  }
}

async function handlePushDb() {
  if (!currentResult) {
    log('No result to push', 'error');
    return;
  }
  
  if (!config.ROMAJI_API_BASE || !config.ROMAJI_API_TOKEN) {
    log('ROMAJI_API_BASE or ROMAJI_API_TOKEN not configured', 'error');
    return;
  }
  
  try {
    pushDbBtn.disabled = true;
    log('Pushing to database...', 'info');
    
    const url = `${config.ROMAJI_API_BASE}/romaji/upsertTimed`;
    const response = await axios.post(url, {
      videoId: currentResult.videoId,
      source: 'genius',
      geniusUrl: currentResult.geniusUrl,
      vtt: currentResult.vtt,
      segments: currentResult.segments,
      textHash: currentResult.textHash,
      toolVersion: 'gui-1'
    }, {
      headers: {
        'Authorization': `Bearer ${config.ROMAJI_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 200) {
      log('Successfully pushed to database!', 'success');
    } else {
      log(`Unexpected response: ${response.status}`, 'error');
    }
    
  } catch (err) {
    log(`Failed to push: ${err.message}`, 'error');
    if (err.response) {
      log(`Server response: ${JSON.stringify(err.response.data)}`, 'error');
    }
  } finally {
    pushDbBtn.disabled = false;
  }
}

fetchAlignBtn.addEventListener('click', handleFetchAlign);
pushDbBtn.addEventListener('click', handlePushDb);

loadConfig();