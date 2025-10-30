# YouTube Romaji + Custom Subtitles

A Chrome extension that adds romanized Japanese captions to YouTube videos and supports uploading custom subtitle files.

## Demo

https://github.com/user-attachments/assets/1a0cacaa-b300-4d0f-9878-ee97e093ca0a

## Features

### Romaji Captions
- Adds "Romaji (auto)" option to YouTube's caption menu for videos with Japanese subtitles
- Converts Japanese text (kanji, hiragana, katakana) to romaji using Hepburn romanization
- Displays romanized captions as an overlay synced with video playback
- Caches converted captions for faster loading on repeat views

### Custom Subtitles
- Upload your own subtitle files (.srt, .vtt, .ass, .ssa) for any YouTube video
- Manage multiple custom subtitle tracks per video
- Saved locally in browser storage, accessible only on your device

## How It Works

### Architecture
The extension uses a multi-component architecture to handle Japanese text processing:

1. **Content Script** (`content.js`)
   - Runs on YouTube pages
   - Injects "Romaji (auto)" menu item into caption settings
   - Fetches caption data from YouTube's TimedText API
   - Manages caption overlay rendering and synchronization

2. **Page Bridge** (`page-bridge.js`)
   - Runs in YouTube's page context (not isolated)
   - Extracts player data including available caption tracks
   - Sniffs TimedText API URLs to capture signed request parameters

3. **Background Service Worker** (`background.js`)
   - Routes messages between content script and offscreen document
   - Fetches caption data with proper credentials to avoid CORS issues
   - Manages cache pruning and storage

4. **Offscreen Document** (`offscreen.js`)
   - Loads and initializes Kuroshiro romanization library
   - Performs batch text conversion using Kuromoji morphological analyzer
   - Required because service workers cannot load DOM-dependent libraries

### Romanization Process

1. User selects "Romaji (auto)" from caption menu
2. Content script fetches Japanese captions from YouTube's TimedText API
3. Caption text sent to offscreen document in batches
4. Kuromoji analyzer tokenizes Japanese text into morphemes
5. Kuroshiro converts tokens to romaji using Hepburn system with spacing
6. Converted captions cached in browser storage
7. Content script renders romaji text synchronized with video playback

### Technical Details

**Japanese Text Processing:**
- Library: Kuroshiro v1.3.2 with KuromojiAnalyzer
- Romanization: Hepburn system (most common for English speakers)
- Mode: Spaced (adds spaces between morphemes for readability)
- Dictionary: Kuromoji 0.1.2 (11 dictionary files, ~15.7 MB total)

**Dictionary Loading:**
- Dictionaries bundled with extension and served locally
- Fetch interception wrapper serves files from memory cache
- Pre-loads all dictionary files on offscreen document initialization
- Uses CDN path with local fallback to avoid chrome-extension:// URL issues

**Caption Fetching:**
- Monitors YouTube's network requests to capture TimedText URLs
- Extracts signed parameters (pot token, signature, expiry)
- Tries multiple caption formats: as-is, json3, srv3, vtt, ttml
- Background worker fetches with credentials to bypass CORS restrictions

**Performance:**
- First load: ~500ms for dictionary initialization + conversion time
- Cached: Instant playback using stored conversions
- Storage: Indexed by video ID + caption track version
- Cache TTL: 30 days with automatic pruning

## Known Limitations

### Kanji Reading Ambiguity
The morphological analyzer sometimes selects incorrect readings for kanji with multiple pronunciations. Example:

- Input: あたし側にいるわ
- Expected: "atashi soba ni iru wa" (側 = そば, meaning "beside")
- Output: "atashi gawa ni iru wa" (側 = がわ, meaning "side/faction")

This occurs because:
- Kuromoji uses statistical models trained on standard Japanese text
- Song lyrics often drop particles and use non-standard phrasing
- YouTube captions lack furigana (reading hints) for disambiguation
- No practical client-side solution exists without manual corrections

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked"
5. Select the extension directory
