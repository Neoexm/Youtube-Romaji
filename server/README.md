# Romaji API Server

Express API server that romanizes Japanese text using Genius-guided OpenAI GPT with Supabase caching.

## Architecture

The server uses a hybrid approach combining Genius lyrics as a reference with LLM romanization:

1. **Cache Check** - Check Supabase for existing romanization
2. **YouTube Metadata** - Extract video title for song identification
3. **Genius Lyrics Fetch** (Optional) - Retrieve romanized lyrics as reference
   - Search Genius.com for the song
   - Scrape lyrics via Apify Actor
4. **LLM Romanization** - Use OpenAI GPT with Genius reference (when available)
5. **Cache Storage** - Store result in Supabase for future requests

### Cost Optimization

- **With Genius Reference**: ~$0.015 per video (OpenAI + Apify)
- **Without Genius**: ~$0.014 per video (OpenAI only)
- **Cached Requests**: $0.00 (database lookup only)
- **Genius Benefit**: Improved romanization consistency and style matching

## How It Works

### 1. YouTube Title Extraction

Uses multiple fallback methods to fetch video metadata:
- **ytdl-core**: Primary method for extracting video details
- **oEmbed API**: Fallback method (no API key required)
- **YouTube Data API v3**: Optional fallback if API key configured

The title is cleaned to remove common artifacts:
- Removes YouTube metadata: `【】`, `[]`, `(Official Video)`, etc.
- Extracts song name from formats like "Artist - Song Title"
- Handles Japanese characters and mixed formats

### 2. Genius Lyrics Fetch (Optional)

Attempts to find and retrieve romanized lyrics as a reference:

**Multi-Strategy Search:**
1. Search with original title
2. If Japanese, romanize and search again
3. Try "genius romanizations [artist] [keywords]" pattern

**Apify Scraping:**
- Uses the epctex/genius-scraper actor
- Polls for completion (max 30 seconds)
- Extracts and cleans HTML lyrics
- Filters out section markers (`[Verse 1]`, `[Chorus]`, etc.)

### 3. Genius-Guided LLM Romanization

The core romanization uses OpenAI with a specialized prompt:

**System Prompt:**
- Japanese romanization specialist
- Hepburn romanization system
- Uses Genius lyrics as style guide (when available)
- Maintains exact line count
- Handles edge cases naturally

**User Prompt Variables:**
- `japanese_captions`: Original Japanese subtitle text
- `genius_romanized`: Genius lyrics OR "Not available"
- `line_count`: Number of input lines for validation

**LLM Benefits:**
- Handles credit lines (e.g., "ーツユ" artist tags)
- Manages timing splits naturally
- Consistent romanization style with Genius reference
- Works perfectly without Genius
- No complex alignment algorithms needed

### 4. Multi-Strategy Genius Search

For Japanese song titles, uses advanced search strategies:

1. **Direct Search**: Original title (Japanese or mixed)
2. **Romanized Search**: Convert title to romaji using Kuroshiro
3. **Artist-Focused Search**: Extract artist + keywords pattern
4. **Title Similarity**: Compare results against original title

This maximizes Genius hit rate for Japanese music.

### 5. Distributed Locking

Prevents concurrent processing of the same video:
- Inserts `PROCESSING` marker in cache
- Other requests wait up to 30 seconds
- Automatic cleanup on errors
- Race condition handling via unique constraint