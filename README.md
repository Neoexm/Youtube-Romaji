# YouTube Romaji + Custom Subtitles

A Chrome extension that adds romanized Japanese captions to YouTube videos and supports uploading custom subtitle files.

## Demo

https://github.com/user-attachments/assets/1a0cacaa-b300-4d0f-9878-ee97e093ca0a

## Features

### Romaji Captions
- Adds "Romaji" option to YouTube's caption menu for videos with Japanese manual subtitles
- Converts Japanese text (kanji, hiragana, katakana) to romaji using Hepburn romanization via OpenAI GPT-5
- Proactive background romanization starts automatically when Japanese subtitles are detected
- Displays romanized captions as an overlay synced with video playback
- Shared database caching for instant loading across all users (first user romanizes, everyone benefits)

### Custom Subtitles
- Upload your own subtitle files (.srt, .vtt, .ass, .ssa) for any YouTube video
- Manage multiple custom subtitle tracks per video
- Saved locally in browser storage, accessible only on your device

## How It Works

### Architecture
The extension uses a server-side API architecture for high-quality romanization:

1. **Content Script** (`content.js`)
   - Runs on YouTube pages
   - Injects "Romaji" menu item into caption settings
   - Fetches caption data from YouTube's TimedText API
   - Sends full caption text to API for romanization
   - Manages caption overlay rendering and synchronization

2. **Page Bridge** (`page-bridge.js`)
   - Runs in YouTube's page context (not isolated)
   - Extracts player data including available caption tracks
   - Sniffs TimedText API URLs to capture signed request parameters

3. **Background Service Worker** (`background.js`)
   - Fetches caption data with proper credentials to avoid CORS issues
   - Handles cross-origin requests for YouTube APIs

4. **Romanization API** (deployed on Fly.io)
   - Express.js server with OpenAI integration
   - Uses GPT-5 with high reasoning for accurate romanization
   - Supabase database caching (shared across all users)
   - Deployed at: https://youtube-romaji-api.fly.dev/

### Romanization Process

1. User opens a YouTube video with Japanese manual subtitles
2. Extension detects Japanese track and proactively fetches captions
3. Full caption text sent to API with video ID
4. API checks Supabase database for cached romanization
5. If cache miss: GPT-5 romanizes text using Hepburn rules
6. Result stored in database and returned to extension
7. Content script renders romaji text synchronized with video playback
8. User can click "Romaji" anytime - if ready, shows immediately; if pending, auto-shows when complete

### Technical Details

**Japanese Text Processing:**
- Model: OpenAI GPT-5 with reasoning_effort: 'high'
- Romanization: Hepburn system with specific rules:
  - Particles: は→wa, へ→e, を→o
  - Small tsu (っ): Gemination (doubles next consonant)
  - N (ん): Context-aware (m before b/m/p, n otherwise)
  - Long vowels: ou→ō, uu→ū, aa→ā
- Prompt managed via OpenAI Prompt API for easy updates

**Caption Fetching:**
- Monitors YouTube's network requests to capture TimedText URLs
- Extracts signed parameters (pot token, signature, expiry)
- Tries multiple caption formats: as-is, json3, srv3, vtt, ttml
- Background worker fetches with credentials to bypass CORS restrictions

**Performance:**
- First request (cache miss): ~2-4 seconds (API call + GPT-5 reasoning)
- Cached requests: ~200-500ms (database lookup)
- Proactive romanization: Starts automatically when Japanese subs detected

**Manual Subtitles Only:**
- Auto-generated subtitles are NOT supported
- Extension only romanizes manual Japanese subtitle tracks
- This ensures high-quality source text for accurate romanization

## Known Limitations

### Manual Subtitles Required
Auto-generated subtitles are not supported due to lower quality and accuracy. The extension only works with manually created Japanese subtitle tracks.

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked"
5. Select the extension directory
