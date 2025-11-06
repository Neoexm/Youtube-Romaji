require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const ytdl = require('ytdl-core');

const app = express();
const PORT = process.env.PORT || 3000;

// Kuroshiro - lazy load only when needed (optional feature)
let kuroshiro = null;
let kuroshiroReady = false;

async function initKuroshiro() {
  if (kuroshiroReady || kuroshiro) return;
  
  try {
    console.log('[kuroshiro] lazy loading for Japanese text matching...');
    
    // Kuroshiro returns an object, need to access .default property
    const kuroshiroModule = require('kuroshiro');
    const KuromojiAnalyzer = require('kuroshiro-analyzer-kuromoji');
    
    console.log('[kuroshiro] module type:', typeof kuroshiroModule);
    console.log('[kuroshiro] module keys:', Object.keys(kuroshiroModule));
    
    // Access the actual Kuroshiro constructor from the module
    const Kuroshiro = kuroshiroModule.default || kuroshiroModule.Kuroshiro || kuroshiroModule;
    
    console.log('[kuroshiro] Kuroshiro type after extraction:', typeof Kuroshiro);
    
    kuroshiro = new Kuroshiro();
    await kuroshiro.init(new KuromojiAnalyzer());
    kuroshiroReady = true;
    console.log('[kuroshiro] ✓ ready');
  } catch (error) {
    console.error('[kuroshiro] ✗ initialization failed:', error.message);
    console.error('[kuroshiro] stack trace:', error.stack);
    console.log('[kuroshiro] will use position-based alignment instead');
    kuroshiroReady = false;
  }
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_ACTOR_ID = 'Zutb7WV9AFZTYtv0F'; // epctex/genius-scraper actor ID

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const sanitizedPath = (req.path || '').replace(/\n|\r/g, '');
  const sanitizedMethod = (req.method || '').replace(/\n|\r/g, '');
  console.log(`[${new Date().toISOString()}] ${sanitizedMethod} ${sanitizedPath}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Romaji API Server running' });
});

// ============================================================================
// YOUTUBE METADATA EXTRACTION
// ============================================================================

async function fetchYouTubeTitle(videoId) {
  // Method 1: Try ytdl-core first
  try {
    const sanitizedVideoId = String(videoId).replace(/\n|\r/g, '');
    console.log(`[youtube] Method 1: trying ytdl-core for ${sanitizedVideoId}`);
    const videoUrl = `https://www.youtube.com/watch?v=${sanitizedVideoId}`;
    const info = await ytdl.getInfo(videoUrl);
    const title = (info.videoDetails.title || '').replace(/\n|\r/g, ' ');
    const description = (info.videoDetails.description || '').replace(/\n|\r/g, ' ');
    console.log(`[youtube] ✓ ytdl-core success: ${title}`);
    console.log(`[youtube] description preview: ${description?.substring(0, 100)}...`);
    return { ok: true, title, description, method: 'ytdl-core' };
  } catch (error) {
    const sanitizedMessage = (error.message || '').replace(/\n|\r/g, ' ');
    console.error(`[youtube] ✗ ytdl-core failed - Status: ${error.statusCode || 'N/A'}, Message: ${sanitizedMessage}`);
  }

  // Method 2: Try YouTube oEmbed API (no API key required!)
  try {
    console.log(`[youtube] Method 2: trying oEmbed API`);
    const sanitizedVideoId = String(videoId).replace(/\n|\r/g, '');
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${sanitizedVideoId}&format=json`;
    const response = await axios.get(oembedUrl, { timeout: 5000 });
    const title = (response.data.title || '').replace(/\n|\r/g, ' ');
    const author = (response.data.author_name || '').replace(/\n|\r/g, ' ');
    
    if (title) {
      console.log(`[youtube] ✓ oEmbed success: ${title}`);
      console.log(`[youtube] channel: ${author}`);
      return { ok: true, title, author, method: 'oembed' };
    }
  } catch (error) {
    const sanitizedMessage = (error.message || '').replace(/\n|\r/g, ' ');
    console.error(`[youtube] ✗ oEmbed failed: ${sanitizedMessage}`);
  }

  // Method 3: Try YouTube Data API v3 if configured
  if (process.env.YOUTUBE_API_KEY) {
    try {
      console.log(`[youtube] Method 3: trying YouTube Data API v3`);
      const sanitizedVideoId = String(videoId).replace(/\n|\r/g, '');
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${sanitizedVideoId}&key=${process.env.YOUTUBE_API_KEY}&part=snippet`;
      const response = await axios.get(apiUrl, { timeout: 5000 });
      const snippet = response.data.items?.[0]?.snippet;
      
      if (snippet) {
        const title = (snippet.title || '').replace(/\n|\r/g, ' ');
        const description = (snippet.description || '').replace(/\n|\r/g, ' ');
        console.log(`[youtube] ✓ API v3 success: ${title}`);
        console.log(`[youtube] description preview: ${description?.substring(0, 100)}...`);
        return { ok: true, title, description, method: 'api-v3' };
      }
    } catch (error) {
      const sanitizedMessage = (error.message || '').replace(/\n|\r/g, ' ');
      console.error(`[youtube] ✗ API v3 failed: ${sanitizedMessage}`);
    }
  }

  const sanitizedVideoId = String(videoId).replace(/\n|\r/g, '');
  console.error(`[youtube] ✗ All methods failed for ${sanitizedVideoId}`);
  return { ok: false, error: 'All YouTube metadata fetch methods failed' };
}

function cleanSongTitle(rawTitle) {
  let cleaned = rawTitle;
  
  // Remove common YouTube artifacts
  cleaned = cleaned.replace(/【.*?】/g, ''); // Remove 【brackets】
  cleaned = cleaned.replace(/\[.*?\]/g, ''); // Remove [brackets]
  cleaned = cleaned.replace(/\(.*?(official|mv|video|lyric|romaji|romanized).*?\)/gi, '');
  cleaned = cleaned.replace(/\|.*$/g, ''); // Remove everything after |
  cleaned = cleaned.replace(/[-–—]\s*(official|mv|video|lyric|romaji|romanized).*$/gi, '');
  
  // Remove standalone MV, OFFICIAL, VIDEO, etc. at the end
  cleaned = cleaned.replace(/\s+(mv|official|video|lyric|lyrics|romaji|romanized)\s*$/gi, '');
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  const sanitizedRaw = (rawTitle || '').replace(/\n|\r/g, ' ');
  const sanitizedCleaned = (cleaned || '').replace(/\n|\r/g, ' ');
  console.log(`[youtube] cleaned title: "${sanitizedRaw}" -> "${sanitizedCleaned}"`);
  return cleaned;
}

// ============================================================================
// GENIUS SEARCH & SCRAPING
// ============================================================================

async function performGeniusSearch(query, originalTitle = null) {
  const searchUrl = `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`;
  const sanitizedQuery = (query || '').replace(/\n|\r/g, ' ');
  console.log(`[genius] trying query: "${sanitizedQuery}"`);
  
  const response = await axios.get(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    },
    timeout: 10000
  });
  
  const sections = response.data?.response?.sections || [];
  const songSection = sections.find(s => s.type === 'song') || sections.find(s => s.hits?.length > 0);
  
  if (!songSection || !songSection.hits || songSection.hits.length === 0) {
    return null;
  }
  
  // Filter for romanized versions as primary preference
  const romanizedHits = songSection.hits.filter(hit => {
    const artist = hit.result?.primary_artist?.name?.toLowerCase() || '';
    const title = hit.result?.title?.toLowerCase() || '';
    return artist.includes('romanization') || title.includes('romanized');
  });
  
  // Use romanized if available, otherwise fall back to all results
  const hits = romanizedHits.length > 0 ? romanizedHits : songSection.hits;
  
  console.log(`[genius] found ${hits.length} results${romanizedHits.length > 0 ? ' (romanized)' : ''}`);
  
  // Log results
  hits.slice(0, 5).forEach((hit, i) => {
    const sanitizedTitle = (hit.result?.title || '').replace(/\n|\r/g, ' ');
    const sanitizedArtist = (hit.result?.primary_artist?.name || '').replace(/\n|\r/g, ' ');
    console.log(`[genius]   ${i + 1}. "${sanitizedTitle}" by ${sanitizedArtist}`);
  });
  
  // If we have originalTitle, find best match by title similarity
  if (originalTitle && hits.length > 1) {
    const sanitizedOriginal = (originalTitle || '').replace(/\n|\r/g, ' ');
    console.log(`[genius] comparing against original title: "${sanitizedOriginal}"`);
    
    // Romanize original title if it's Japanese for better matching
    let comparisonTitle = originalTitle;
    if (isJapaneseText(originalTitle) && kuroshiroReady && kuroshiro) {
      try {
        comparisonTitle = await kuroshiro.convert(originalTitle, {
          to: 'romaji',
          mode: 'spaced',
          romajiSystem: 'hepburn'
        });
        console.log(`[genius] romanized comparison title: "${comparisonTitle}"`);
      } catch (error) {
        console.log(`[genius] couldn't romanize title for comparison: ${error.message}`);
      }
    }
    
    const normalizedOriginal = normalizeText(comparisonTitle);
    
    // Score each result by title similarity
    const scoredHits = hits.map(hit => {
      const title = hit.result?.title || '';
      const normalizedTitle = normalizeText(title);
      const similarity = stringSimilarity.compareTwoStrings(normalizedOriginal, normalizedTitle);
      
      return { hit, similarity, title };
    });
    
    // Sort by similarity descending
    scoredHits.sort((a, b) => b.similarity - a.similarity);
    
  // Log similarity scores
  scoredHits.slice(0, 3).forEach((item, i) => {
    const sanitizedTitle = (item.title || '').replace(/\n|\r/g, ' ');
    console.log(`[genius]   match ${i + 1}: "${sanitizedTitle}" (${(item.similarity * 100).toFixed(1)}% similar)`);
  });    // Return best match if it's reasonably similar
    if (scoredHits[0].similarity > 0.2) {
      console.log(`[genius] selected best match by title similarity`);
      return scoredHits[0].hit;
    }
  }
  
  return hits[0];
}

async function searchGeniusForSong(songTitle) {
  try {
    const sanitizedTitle = (songTitle || '').replace(/\n|\r/g, ' ');
    console.log(`[genius] 🔍 searching for: "${sanitizedTitle}"`);
    
    // Strategy 1: Try original title first
    let result = await performGeniusSearch(songTitle, songTitle);
    
    // Strategy 2: If no results and title contains Japanese, try romanizing it
    if (!result && isJapaneseText(songTitle)) {
      console.log(`[genius] no results with Japanese title, trying romanized version...`);
      
      // Initialize kuroshiro if needed
      if (!kuroshiroReady) {
        await initKuroshiro();
      }
      
      if (kuroshiroReady && kuroshiro) {
        try {
          const romanizedTitle = await kuroshiro.convert(songTitle, {
            to: 'romaji',
            mode: 'spaced',
            romajiSystem: 'hepburn'
          });
          
          const sanitizedSongTitle = (songTitle || '').replace(/\n|\r/g, ' ');
          const sanitizedRomanized = (romanizedTitle || '').replace(/\n|\r/g, ' ');
          console.log(`[genius] romanized: "${sanitizedSongTitle}" → "${sanitizedRomanized}"`);
          result = await performGeniusSearch(romanizedTitle, songTitle);
        } catch (error) {
          console.log(`[genius] romanization failed: ${error.message}`);
        }
      }
    }
    
    // Strategy 3: Try searching for "genius romanizations [artist] [keywords]" pattern
    if (!result) {
      // Extract artist name and song part from title (before and after " - ")
      const titleMatch = songTitle.match(/^([^-–—]+)\s*[-–—]\s*(.+)$/);
      if (titleMatch) {
        const artistName = titleMatch[1].trim();
        const songPart = titleMatch[2].trim();
        
        const sanitizedArtist = (artistName || '').replace(/\n|\r/g, ' ');
        console.log(`[genius] trying "genius romanizations" pattern with artist: "${sanitizedArtist}"`);
        
        // Try romanizing artist name if Japanese
        let searchArtist = artistName;
        let searchKeywords = '';
        
        if (isJapaneseText(artistName) && kuroshiroReady && kuroshiro) {
          try {
            searchArtist = await kuroshiro.convert(artistName, {
              to: 'romaji',
              mode: 'spaced',
              romajiSystem: 'hepburn'
            });
            const sanitizedArtistName = (artistName || '').replace(/\n|\r/g, ' ');
            const sanitizedSearchArtist = (searchArtist || '').replace(/\n|\r/g, ' ');
            console.log(`[genius] romanized artist: "${sanitizedArtistName}" → "${sanitizedSearchArtist}"`);
          } catch (error) {
            const sanitizedMessage = (error.message || '').replace(/\n|\r/g, ' ');
            console.log(`[genius] artist romanization failed: ${sanitizedMessage}`);
          }
        }
        
        // Extract keywords from song title for more specific search
        if (isJapaneseText(songPart) && kuroshiroReady && kuroshiro) {
          try {
            const romanizedSong = await kuroshiro.convert(songPart, {
              to: 'romaji',
              mode: 'spaced',
              romajiSystem: 'hepburn'
            });
            
            // Extract first few meaningful words (not common words or punctuation)
            const words = romanizedSong.toLowerCase()
              .replace(/mv|video|official|lyrics|romanized|\.|,|!|\?/gi, '')
              .trim()
              .split(/\s+/)
              .filter(w => w.length > 2)  // Skip short words
              .slice(0, 3);  // Take first 3 meaningful words
            
            if (words.length > 0) {
              searchKeywords = ' ' + words.join(' ');
              console.log(`[genius] extracted keywords from song title: "${searchKeywords.trim()}"`);
            }
          } catch (error) {
            console.log(`[genius] song title romanization failed: ${error.message}`);
          }
        }
        
        // Search with artist + keywords for better specificity
        const searchQuery = `genius romanizations ${searchArtist}${searchKeywords}`;
        console.log(`[genius] full search query: "${searchQuery}"`);
        result = await performGeniusSearch(searchQuery, songTitle);
      }
    }
    
    if (!result) {
      console.log(`[genius] ✗ no results found after trying all strategies`);
      return { ok: false, reason: 'no_results' };
    }
    
    const songUrl = result.result?.url;
    const songTitleResult = result.result?.title;
    const artistName = result.result?.primary_artist?.name;
    
    if (!songUrl) {
      console.log(`[genius] ✗ no URL in result`);
      return { ok: false, reason: 'no_url' };
    }
    
    const sanitizedSongTitle = (songTitleResult || '').replace(/\n|\r/g, ' ');
    const sanitizedArtistName = (artistName || '').replace(/\n|\r/g, ' ');
    const sanitizedUrl = (songUrl || '').replace(/\n|\r/g, ' ');
    console.log(`[genius] ✓ selected: "${sanitizedSongTitle}" by ${sanitizedArtistName}`);
    console.log(`[genius] ✓ URL: ${sanitizedUrl}`);
    
    return {
      ok: true,
      url: songUrl,
      title: songTitleResult,
      artist: artistName
    };
  } catch (error) {
    const sanitizedMessage = (error.message || '').replace(/\n|\r/g, ' ');
    console.error(`[genius] ✗ search error:`, sanitizedMessage);
    if (error.response) {
      console.error(`[genius] response status: ${error.response.status}`);
    }
    return { ok: false, reason: 'search_error', error: error.message };
  }
}

// ============================================================================
// APIFY GENIUS LYRICS RETRIEVAL
// ============================================================================

async function fetchGeniusLyricsViaApify(geniusUrl) {
  try {
    const sanitizedUrl = (geniusUrl || '').replace(/\n|\r/g, ' ');
    console.log(`[apify] 📥 fetching lyrics from: ${sanitizedUrl}`);
    
    if (!APIFY_API_TOKEN) {
      console.error(`[apify] ✗ API token not configured`);
      return { ok: false, reason: 'no_api_token' };
    }
    
    const sanitizedActorId = (APIFY_ACTOR_ID || '').replace(/\n|\r/g, ' ');
    console.log(`[apify] using actor: ${sanitizedActorId}`);
    
    // Start the Apify actor run (epctex/genius-scraper format)
    const runResponse = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_API_TOKEN}`,
      {
        startUrls: [geniusUrl],  // Array of strings, not objects
        maxItems: 1,
        endPage: 1,
        includeComments: false,
        proxy: {
          useApifyProxy: true
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      }
    );
    
    const runId = runResponse.data?.data?.id;
    if (!runId) {
      console.error(`[apify] ✗ no run ID in response`);
      throw new Error('No run ID returned from Apify');
    }
    
    console.log(`[apify] ✓ actor run started: ${runId}`);
    
    // Wait for the run to complete (poll for status)
    let status = 'RUNNING';
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max wait
    
    while (status === 'RUNNING' && attempts < maxAttempts) {
      await sleep(1000);
      attempts++;
      
      const statusResponse = await axios.get(
        `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs/${runId}?token=${APIFY_API_TOKEN}`
      );
      
      status = statusResponse.data?.data?.status;
      console.log(`[apify] run status: ${status} (attempt ${attempts}/${maxAttempts})`);
    }
    
    if (status !== 'SUCCEEDED') {
      throw new Error(`Actor run failed with status: ${status}`);
    }
    
    // Fetch the dataset items (lyrics)
    const defaultDatasetId = runResponse.data?.data?.defaultDatasetId;
    if (!defaultDatasetId) {
      throw new Error('No dataset ID in run response');
    }
    
    const datasetResponse = await axios.get(
      `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${APIFY_API_TOKEN}`
    );
    
    const items = datasetResponse.data;
    console.log(`[apify] dataset contains ${items?.length || 0} items`);
    
    if (!items || items.length === 0) {
      console.log(`[apify] ✗ no lyrics found in dataset`);
      return { ok: false, reason: 'no_lyrics' };
    }
    
    const lyricsData = items[0];
    console.log(`[apify] item keys:`, Object.keys(lyricsData));
    
    // epctex/genius-scraper returns HTML in 'lyrics' field
    let lyrics = lyricsData.lyrics;
    
    if (!lyrics || lyrics.trim().length === 0) {
      console.log(`[apify] ✗ empty lyrics field`);
      console.log(`[apify] full item:`, JSON.stringify(lyricsData, null, 2));
      return { ok: false, reason: 'empty_lyrics' };
    }
    
    // Strip HTML tags to get plain text
    lyrics = lyrics
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    
    console.log(`[apify] ✓ lyrics retrieved (${lyrics.length} chars, ${lyrics.split('\n').length} lines)`);
    
    return {
      ok: true,
      lyrics: lyrics,
      songTitle: lyricsData.title || '',
      artistName: lyricsData.primaryArtist || ''
    };
  } catch (error) {
    console.error(`[apify] fetch error:`, error.message);
    return { ok: false, reason: 'fetch_error', error: error.message };
  }
}

// ============================================================================
// LYRIC-TO-SUBTITLE ALIGNMENT
// ============================================================================

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')     // Normalize whitespace
    .trim();
}

// Detect if text is primarily Japanese
function isJapaneseText(text) {
  // Check for Hiragana, Katakana, or Kanji characters
  const japaneseChars = text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g);
  const totalChars = text.replace(/\s/g, '').length;
  
  if (totalChars === 0) return false;
  
  const japaneseRatio = (japaneseChars?.length || 0) / totalChars;
  return japaneseRatio > 0.3; // At least 30% Japanese characters
}

async function alignLyricsToSubtitles(geniusLyrics, subtitleLines) {
  console.log(`[align] aligning ${subtitleLines.length} subtitle lines`);
  console.log(`[align] first 3 subtitle lines:`, subtitleLines.slice(0, 3));
  
  // Check if subtitles are in Japanese
  const firstLine = subtitleLines[0] || '';
  const isJapanese = isJapaneseText(firstLine);
  console.log(`[align] detected language: ${isJapanese ? 'Japanese' : 'non-Japanese (English/Romaji)'}`);
  
  if (!isJapanese) {
    console.log(`[align] ⚠ non-Japanese subtitles detected, using position-based alignment`);
    return alignByPosition(geniusLyrics, subtitleLines);
  }
  
  // Initialize kuroshiro for Japanese text matching
  if (!kuroshiroReady) {
    console.log(`[align] initializing kuroshiro for Japanese content matching...`);
    await initKuroshiro();
    
    if (!kuroshiroReady) {
      console.log(`[align] ⚠ kuroshiro initialization failed, using position-based fallback`);
      return alignByPosition(geniusLyrics, subtitleLines);
    }
  }
  
  // Split Genius lyrics into lines and remove ONLY section markers
  const allLines = geniusLyrics.split('\n').map(line => line.trim());
  const rawCount = allLines.length;
  
  const lyricsLines = allLines
    .filter(line => {
      if (line.length === 0) return false;  // Remove empty lines
      // Remove section markers like [Intro: Artist], [Verse 1: ...]
      if (line.match(/^\[.*:.*\]$/)) return false;
      // Remove pure section markers like [Chorus], [Verse 1], [Bridge] (with optional numbers)
      if (line.match(/^\[(Intro|Outro|Verse|Chorus|Bridge|Refrain|Breakdown|Pre-Chorus|Post-Chorus)(\s+\d+)?\]$/i)) return false;
      // Remove Genius metadata headers with Japanese quotes like [Artist「Song」metadata]
      if (line.match(/^\[.*[「」].*\]$/)) return false;
      return true;  // Keep everything else, including "Mm", "Ah", etc.
    });
  
  const filteredCount = rawCount - lyricsLines.length;
  console.log(`[align] genius: ${rawCount} raw lines → ${lyricsLines.length} lyric lines (removed ${filteredCount} section markers only)`);
  console.log(`[align] first 5 genius lines:`, lyricsLines.slice(0, 5));
  
  if (lyricsLines.length === 0) {
    console.log(`[align] ✗ no lyric lines after filtering`);
    return { ok: false, reason: 'no_lyric_lines' };
  }
  
  // Romanize Japanese subtitles for comparison
  console.log(`[align] romanizing ${subtitleLines.length} Japanese subtitle lines for content matching...`);
  const romanizedSubtitles = [];
  
  for (let i = 0; i < subtitleLines.length; i++) {
    const subLine = subtitleLines[i];
    try {
      const romanized = await kuroshiro.convert(subLine, {
        to: 'romaji',
        mode: 'spaced',
        romajiSystem: 'hepburn'
      });
      romanizedSubtitles.push(romanized);
      
      if (i < 3) {
        console.log(`[align]   ${i + 1}. "${subLine}" → "${romanized}"`);
      }
    } catch (error) {
      console.error(`[align] ✗ failed to romanize: "${subLine.substring(0, 30)}..."`);
      romanizedSubtitles.push('');
    }
  }
  
  console.log(`[align] first 3 romanized subtitles:`, romanizedSubtitles.slice(0, 3));
  
  // Match romanized subtitles with Genius lyrics - allow empty romaji when already covered
  console.log(`[align] performing intelligent content-based matching (allowing continuation lines)...`);
  const aligned = [];
  let lyricsIndex = 0;
  let totalSimilarity = 0;
  const matchDetails = [];
  
  for (let i = 0; i < subtitleLines.length; i++) {
    const romanizedSub = romanizedSubtitles[i];
    const normalizedSub = normalizeText(romanizedSub);
    
    if (!normalizedSub) {
      aligned.push(lyricsIndex < lyricsLines.length ? lyricsLines[lyricsIndex++] : '');
      continue;
    }
    
    // Check if this subtitle is already covered by the previous romanization (continuation line)
    if (i > 0 && aligned[i - 1]) {
      const prevRomanization = aligned[i - 1];
      // For substring check, remove ALL spaces to handle different spacing
      const prevNoSpaces = normalizeText(prevRomanization).replace(/\s+/g, '');
      const currentNoSpaces = normalizedSub.replace(/\s+/g, '');
      
      // If current subtitle romanization is already contained in previous romanization
      // OR if they match very closely, this is likely a continuation/timing split
      if (prevNoSpaces.includes(currentNoSpaces) && currentNoSpaces.length > 3) {
        // This subtitle is already covered - extend the previous romanization
        aligned.push(prevRomanization);  // Reuse previous romanization to "extend" timing
        totalSimilarity += 0.95;  // High confidence - it's an intentional continuation
        
        matchDetails.push({
          original: subtitleLines[i],
          romanizedSub: romanizedSub,
          matched: prevRomanization,
          score: 0.95,
          continuation: true
        });
        
        console.log(`[align] line ${i + 1}: continuation/timing split detected (substring match), extending previous romanization`);
        continue;
      }
    }
    
    // Try combining 1, 2, 3, or 4 consecutive Genius lines to match this subtitle
    let bestCombination = null;
    let bestScore = 0;
    const maxLinesToCombine = 4;
    
    for (let numLines = 1; numLines <= maxLinesToCombine; numLines++) {
      if (lyricsIndex + numLines > lyricsLines.length) break;
      
      // Combine numLines consecutive lines
      const combinedLines = lyricsLines.slice(lyricsIndex, lyricsIndex + numLines);
      const combined = combinedLines.join(', ');
      const normalizedCombined = normalizeText(combined);
      
      const score = stringSimilarity.compareTwoStrings(normalizedSub, normalizedCombined);
      
      if (score > bestScore) {
        bestScore = score;
        bestCombination = {
          text: combined,
          lines: combinedLines,
          numLines: numLines,
          score: score
        };
      }
      
      // Perfect match found
      if (score > 0.90) break;
    }
    
    // Anti-greedy check: If we're combining multiple lines, verify the next subtitle
    // won't need the content we're consuming - UNLESS it's a continuation line
    if (bestCombination && bestCombination.numLines > 1 && i < subtitleLines.length - 1) {
      const nextRomanizedSub = romanizedSubtitles[i + 1];
      const nextNormalizedSub = normalizeText(nextRomanizedSub);
      
      if (nextNormalizedSub) {
        // Check if next subtitle would be covered as a continuation of our combination
        const normalizedCombination = normalizeText(bestCombination.text);
        const nextIsContinuation = normalizedCombination.includes(nextNormalizedSub);
        
        if (nextIsContinuation) {
          // Next subtitle is a continuation/timing split - allow the combination!
          console.log(`[align] line ${i + 1}: next line is continuation, allowing full combination`);
        } else {
          // Check if the next subtitle would match well with any of the lines we're about to consume
          let shouldReduceCombination = false;
          
          for (let j = 1; j < bestCombination.numLines; j++) {
            const potentialNextLine = normalizeText(bestCombination.lines[j]);
            const nextMatchScore = stringSimilarity.compareTwoStrings(nextNormalizedSub, potentialNextLine);
            
            // Check if next subtitle needs this ENTIRE line (not just part of it)
            // by seeing if the Genius line also contains most of the next subtitle's content
            const reverseMatchScore = potentialNextLine.includes(nextNormalizedSub) ? 1.0 :
                                     stringSimilarity.compareTwoStrings(potentialNextLine, nextNormalizedSub);
            
            // Only reduce if:
            // 1. Next subtitle matches this line well (>75%), AND
            // 2. This line fully contains or highly matches the next subtitle (>80%)
            // This ensures we only block when next subtitle needs the WHOLE line, not just part of it
            if (nextMatchScore > 0.75 && reverseMatchScore > 0.80) {
              console.log(`[align] anti-greedy: next subtitle fully needs line ${j} (match: ${(nextMatchScore * 100).toFixed(1)}%, coverage: ${(reverseMatchScore * 100).toFixed(1)}%), reducing combination`);
              shouldReduceCombination = true;
              
              // Reduce to only first j lines
              bestCombination = {
                text: bestCombination.lines.slice(0, j).join(', '),
                lines: bestCombination.lines.slice(0, j),
                numLines: j,
                score: stringSimilarity.compareTwoStrings(normalizedSub, normalizeText(bestCombination.lines.slice(0, j).join(', ')))
              };
              break;
            }
          }
        }
      }
    }
    
    // Use the best combination found
    if (bestCombination && bestCombination.score > 0.4) {
      aligned.push(bestCombination.text);
      lyricsIndex += bestCombination.numLines;
      totalSimilarity += bestCombination.score;
      
      matchDetails.push({
        original: subtitleLines[i],
        romanizedSub: romanizedSub,
        matched: bestCombination.text,
        score: bestCombination.score,
        combined: bestCombination.numLines > 1 ? bestCombination.numLines : undefined
      });
    } else {
      // No good match - use sequential
      if (lyricsIndex < lyricsLines.length) {
        aligned.push(lyricsLines[lyricsIndex]);
        lyricsIndex++;
        totalSimilarity += 0.3;
        matchDetails.push({
          original: subtitleLines[i],
          romanizedSub: romanizedSub,
          matched: lyricsLines[lyricsIndex - 1],
          score: 0.3,
          sequential: true
        });
      } else {
        aligned.push('');
        totalSimilarity += 0;
      }
    }
  }
  
  const avgConfidence = totalSimilarity / subtitleLines.length;
  console.log(`[align] kuroshiro-based matching complete`);
  console.log(`[align] average confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  
  // Log match statistics
  const goodMatches = matchDetails.filter(m => m.score > 0.6).length;
  const okMatches = matchDetails.filter(m => m.score > 0.3 && m.score <= 0.6).length;
  const poorMatches = matchDetails.filter(m => m.score <= 0.3).length;
  console.log(`[align] match quality: ${goodMatches} excellent (>60%), ${okMatches} good (30-60%), ${poorMatches} weak (<30%)`);
  
  // Log ALL matches for debugging alignment issues
  console.log(`[align] ALL ${matchDetails.length} matches:`);
  matchDetails.forEach((match, i) => {
    const status = match.continuation ? 'CONTINUATION (timing split)' :
                   match.combined ? `combined ${match.combined} lines` :
                   match.sequential ? 'sequential' : 'single line';
    console.log(`  ${i + 1}. JAP: "${match.original.substring(0, 45)}${match.original.length > 45 ? '...' : ''}"`);
    console.log(`     ROM: "${match.romanizedSub.substring(0, 55)}${match.romanizedSub.length > 55 ? '...' : ''}"`);
    console.log(`     GENIUS: "${match.matched.substring(0, 55)}${match.matched.length > 55 ? '...' : ''}" (${(match.score * 100).toFixed(1)}% - ${status})`);
  });
  
  // Lower threshold for kuroshiro - it's doing real content matching
  const MIN_CONFIDENCE = 0.45;
  if (avgConfidence < MIN_CONFIDENCE) {
    console.log(`[align] ✗ confidence too low (${(avgConfidence * 100).toFixed(1)}% < ${(MIN_CONFIDENCE * 100).toFixed(1)}%)`);
    
    return {
      ok: false,
      reason: 'low_confidence',
      confidence: avgConfidence,
      aligned: aligned,
      matchDetails
    };
  }
  
  console.log(`[align] ✓ kuroshiro alignment successful (confidence: ${(avgConfidence * 100).toFixed(1)}%)`);
  
  return {
    ok: true,
    aligned: aligned,
    confidence: avgConfidence,
    method: 'kuroshiro-content-matching'
  };
}

// Fallback: Position-based alignment (when kuroshiro not available)
function alignByPosition(geniusLyrics, subtitleLines) {
  const allLines = geniusLyrics.split('\n').map(line => line.trim());
  
  // Filter out ONLY section markers, keep all actual lyrics
  const lyricsLines = allLines.filter(line => {
    if (line.length === 0) return false;
    if (line.match(/^\[.*:.*\]$/)) return false;  // [Section: Artist]
    if (line.match(/^\[(Intro|Outro|Verse|Chorus|Bridge|Refrain|Breakdown|Pre-Chorus|Post-Chorus)\]$/i)) return false;
    return true;  // Keep everything else
  });
  
  console.log(`[align] filtered genius: ${allLines.length} → ${lyricsLines.length} lines (removed ${allLines.length - lyricsLines.length} non-lyric lines)`);
  console.log(`[align] position fallback: ${lyricsLines.length} lyrics for ${subtitleLines.length} subs`);
  
  if (lyricsLines.length === 0) {
    console.log(`[align] ✗ no lyrics after filtering`);
    return { ok: false, reason: 'no_lyric_lines' };
  }
  
  const aligned = [];
  const ratio = lyricsLines.length / subtitleLines.length;
  console.log(`[align] line ratio: ${ratio.toFixed(2)} (genius/subs)`);
  
  if (ratio < 1.0) {
    // Genius has FEWER lines than subtitles - subtitles are more detailed
    // Use proportional mapping to spread Genius lines across subtitles
    console.log(`[align] Genius < Subs: spreading ${lyricsLines.length} genius lines across ${subtitleLines.length} subs`);
    
    for (let i = 0; i < subtitleLines.length; i++) {
      const geniusIdx = Math.floor(i * ratio);
      const clampedIdx = Math.min(geniusIdx, lyricsLines.length - 1);
      aligned.push(lyricsLines[clampedIdx]);
    }
  } else if (ratio >= 1.0 && ratio <= 1.5) {
    // Genius has MORE lines - some subtitles might combine multiple Genius lines
    // Try to intelligently merge
    console.log(`[align] Genius > Subs: condensing ${lyricsLines.length} genius lines to ${subtitleLines.length} subs`);
    
    const linesPerSub = ratio;
    let geniusIdx = 0;
    
    for (let i = 0; i < subtitleLines.length; i++) {
      const startIdx = Math.floor(i * linesPerSub);
      const endIdx = Math.floor((i + 1) * linesPerSub);
      
      // Combine multiple Genius lines if needed
      const linesToCombine = lyricsLines.slice(startIdx, Math.min(endIdx, lyricsLines.length));
      
      if (linesToCombine.length > 1) {
        // Combine with comma
        aligned.push(linesToCombine.join(', '));
      } else if (linesToCombine.length ===1) {
        aligned.push(linesToCombine[0]);
      } else {
        aligned.push(lyricsLines[lyricsLines.length - 1] || '');
      }
    }
  } else {
    // Ratio > 1.5 - very different, use proportional
    console.log(`[align] Large difference (ratio ${ratio.toFixed(2)}): using proportional mapping`);
    
    for (let i = 0; i < subtitleLines.length; i++) {
      const geniusIdx = Math.floor(i * ratio);
      const clampedIdx = Math.min(geniusIdx, lyricsLines.length - 1);
      aligned.push(lyricsLines[clampedIdx]);
    }
  }
  
  console.log(`[align] ✓ position-based alignment complete (${aligned.length} lines)`);
  
  return {
    ok: true,
    aligned: aligned,
    confidence: 0.70,
    method: 'position-fallback'
  };
}

// ============================================================================
// GENIUS-GUIDED LLM ROMANIZATION
// ============================================================================

async function romanizeWithGeniusReference(japaneseText, geniusLyrics = null) {
  const referenceStatus = geniusLyrics ? 'Genius reference' : 'NO reference';
  console.log(`[llm] romanizing with ${referenceStatus}`);
  
  try {
    const lineCount = japaneseText.split('\n').length;
    
    const response = await openai.responses.create({
      prompt: {
        id: 'pmpt_6903b00f45ec81909db49935f61cabc8050221356ced0cef',
        version: '3',
        variables: {
          japanese_captions: japaneseText,
          genius_romanized: geniusLyrics || 'Not available',
          line_count: String(lineCount)
        }
      }
    });
    
    const romanized = response.output_text.trim();
    console.log(`[llm] ✓ romanization successful (${romanized.split('\n').length} lines)`);
    
    return {
      ok: true,
      romanized,
      source: geniusLyrics ? 'llm-genius-guided' : 'llm-only'
    };
  } catch (error) {
    console.error(`[llm] ✗ romanization error:`, error.message);
    throw error;
  }
}

// ============================================================================
// MAIN ROMANIZATION ENDPOINT
// ============================================================================

app.post('/romanize', async (req, res) => {
  try {
    const { videoId, text } = req.body;

    if (!videoId || !text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Invalid request. Provide videoId and text.' });
    }

    const sanitizedVideoId = String(videoId).replace(/\n|\r/g, '');
    console.log(`[romanize] videoId: ${sanitizedVideoId}, text length: ${text.length}`);

    // Check cache first
    const { data: cached, error: cacheError } = await supabase
      .from('romanized_cache')
      .select('romanized_text, vtt, segments, timed')
      .eq('video_id', videoId)
      .single();

    if (cached && !cacheError) {
      console.log(`[romanize] cache HIT for ${sanitizedVideoId}`);
      const response = { romanized: cached.romanized_text, cached: true };
      if (cached.vtt) response.vtt = cached.vtt;
      if (cached.segments) response.segments = cached.segments;
      if (cached.timed) response.timed = cached.timed;
      return res.json(response);
    }

    console.log(`[romanize] cache MISS for ${sanitizedVideoId}, attempting to acquire lock...`);

    // Acquire distributed lock
    const { error: lockError } = await supabase
      .from('romanized_cache')
      .insert([{
        video_id: videoId,
        romanized_text: 'PROCESSING',
        created_at: new Date().toISOString()
      }])
      .select();

    if (lockError) {
      if (lockError.code === '23505') {
        console.log(`[romanize] race condition detected for ${sanitizedVideoId}, another request is processing`);
        
        let retries = 0;
        while (retries < 30) {
          await sleep(1000);
          
          const { data: retryCheck } = await supabase
            .from('romanized_cache')
            .select('romanized_text')
            .eq('video_id', videoId)
            .single();
          
          if (retryCheck && retryCheck.romanized_text !== 'PROCESSING') {
            console.log(`[romanize] processing complete by another request for ${sanitizedVideoId}`);
            return res.json({ romanized: retryCheck.romanized_text, cached: true });
          }
          
          retries++;
        }
        
        return res.status(408).json({ error: 'Timeout waiting for romanization to complete' });
      }
      
      throw lockError;
    }

    console.log(`[romanize] lock acquired for ${sanitizedVideoId}`);

    // Start romanization process
    let romanized = null;
    let source = 'llm-only';
    let geniusLyrics = null;
    
    try {
      // Step 1: Try to get Genius lyrics as reference
      console.log(`[romanize] ========== STEP 1: Attempting Genius Lyrics Fetch ==========`);
      
      // 1a. Get YouTube video title
      const titleResult = await fetchYouTubeTitle(videoId);
      
      if (titleResult.ok) {
        const cleanedTitle = cleanSongTitle(titleResult.title);
        const sanitizedCleanedTitle = (cleanedTitle || '').replace(/\n|\r/g, ' ');
        console.log(`[romanize] searching Genius for: "${sanitizedCleanedTitle}"`);
        
        // 1b. Search Genius
        const searchResult = await searchGeniusForSong(cleanedTitle);
        
        if (searchResult.ok) {
          // 1c. Fetch lyrics
          const lyricsResult = await fetchGeniusLyricsViaApify(searchResult.url);
          
          if (lyricsResult.ok) {
            geniusLyrics = lyricsResult.lyrics;
            console.log(`[romanize] ✓ Genius lyrics retrieved (${geniusLyrics.length} chars)`);
          } else {
            console.log(`[romanize] ✗ Genius lyrics unavailable: ${lyricsResult.reason}`);
          }
        } else {
          console.log(`[romanize] ✗ Genius search failed: ${searchResult.reason}`);
        }
      } else {
        console.log(`[romanize] ✗ YouTube title fetch failed, skipping Genius`);
      }
      
      // Step 2: Romanize with LLM (with or without Genius reference)
      console.log(`[romanize] ========== STEP 2: LLM Romanization ==========`);
      const llmResult = await romanizeWithGeniusReference(text, geniusLyrics);
      
      romanized = llmResult.romanized;
      source = llmResult.source;
      
      const sanitizedSource = (source || '').replace(/\n|\r/g, '');
      console.log(`[romanize] ✓✓✓ Romanization complete (source: ${sanitizedSource})`);
      
      // Update cache with result
      await supabase
        .from('romanized_cache')
        .update({
          romanized_text: romanized,
          source: source,
          genius_reference: geniusLyrics ? 'available' : 'unavailable'
        })
        .eq('video_id', videoId);

      console.log(`[romanize] ✓ cached result for ${sanitizedVideoId} (source: ${sanitizedSource})`);

      res.json({
        romanized,
        cached: false,
        source
      });
    } catch (processingError) {
      // If anything fails during processing, clean up the lock
      await supabase
        .from('romanized_cache')
        .delete()
        .eq('video_id', videoId);
      
      throw processingError;
    }
  } catch (error) {
    console.error('[romanize] error:', error);
    res.status(500).json({ error: error.message || 'Romanization failed' });
  }
});

// ============================================================================
// TIMED ROMAJI UPSERT ENDPOINT (from GUI tool)
// ============================================================================

app.post('/romaji/upsertTimed', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.ROMAJI_API_TOKEN;
    
    if (!expectedToken) {
      return res.status(500).json({ error: 'Server not configured for timed romaji uploads' });
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    
    const token = authHeader.substring(7);
    if (token !== expectedToken) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    const { videoId, source, geniusUrl, vtt, segments, textHash, toolVersion } = req.body;
    
    if (!videoId || !vtt || !segments || !Array.isArray(segments)) {
      return res.status(400).json({ error: 'Missing required fields: videoId, vtt, segments' });
    }
    
    const sanitizedVideoId = String(videoId).replace(/\n|\r/g, '');
    console.log(`[upsertTimed] upserting timed romaji for ${sanitizedVideoId}, segments: ${segments.length}`);
    
    const romanizedText = segments.map(s => s.text).join('\n');
    
    const { data, error } = await supabase
      .from('romanized_cache')
      .upsert({
        video_id: videoId,
        romanized_text: romanizedText,
        vtt: vtt,
        segments: segments,
        timed: true,
        source: source || 'gui-tool',
        genius_url: geniusUrl,
        text_hash: textHash,
        tool_version: toolVersion,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'video_id'
      })
      .select();
    
    if (error) {
      console.error('[upsertTimed] error:', error);
      return res.status(500).json({ error: error.message });
    }
    
    console.log(`[upsertTimed] successfully upserted timed romaji for ${sanitizedVideoId}`);
    res.json({ ok: true, message: 'Timed romaji saved successfully' });
  } catch (error) {
    console.error('[upsertTimed] error:', error);
    res.status(500).json({ error: error.message || 'Failed to save timed romaji' });
  }
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Romaji API Server listening on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`Supabase configured: ${!!process.env.SUPABASE_URL}`);
  console.log(`Apify API Token configured: ${!!APIFY_API_TOKEN}`);
  console.log(`Genius-first romanization enabled: ${!!APIFY_API_TOKEN}`);
});
