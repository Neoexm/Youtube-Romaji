# Romaji Timestamp GUI Tool

Desktop Electron application for timestamping Genius romaji lyrics to YouTube videos and pushing the results to the database.

## Features

- Extract romaji lyrics from Genius
- Fetch Japanese captions from YouTube (manual or ASR)
- Search for donor videos with Japanese captions if needed
- Align romaji text to caption timestamps using sequence alignment
- Generate WebVTT format captions
- Push timed romaji to database for use in browser extension

## Requirements

- Node.js 18.0.0 or higher
- npm
- **Python 3.8 or higher** (for Whisper alignment)
- **ffmpeg** (system dependency for audio processing)

## Setup

### 1. Install Node.js dependencies

```bash
cd tools/romaji-timestamp-gui
npm install
```

### 2. Install Python dependencies (REQUIRED for Whisper)

**Important:** Whisper alignment requires Python dependencies. Install them before first use:

```bash
pip install -r requirements.txt
```

Or install manually:
```bash
pip install faster-whisper pykakasi yt-dlp
```

**Verify installation:**
```bash
python -c "import faster_whisper; import pykakasi; print('Dependencies OK')"
```

**Note:** Ensure `ffmpeg` is available in your system PATH:
- Windows: Download from https://ffmpeg.org/ and add to PATH
- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg` or equivalent

### 3. Create `secrets.local.json` in this directory:
```json
{
  "ROMAJI_API_BASE": "https://youtube-romaji-api.fly.dev",
  "ROMAJI_API_TOKEN": "your-api-token-here",
  "YOUTUBE_API_KEY": "",
  "ENABLE_DONOR": false,
  "WHISPER_BACKEND": "python-faster-whisper",
  "WHISPER_MODEL": "large-v3",
  "PYTHON_BIN": "python"
}
```

**Configuration fields:**
- `ROMAJI_API_BASE`: Base URL of your romaji API server
- `ROMAJI_API_TOKEN`: Authentication token for pushing to database
- `YOUTUBE_API_KEY`: (Optional) Google YouTube Data API key for donor video search
- `ENABLE_DONOR`: (Default: `false`) Enable donor video search as last fallback
- `WHISPER_BACKEND`: Whisper implementation to use (currently only `python-faster-whisper`)
- `WHISPER_MODEL`: Whisper model name (`tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3`)
- `PYTHON_BIN`: Path to Python executable (e.g., `python`, `python3`, or absolute path)


## Usage

### First-time setup checklist:
- ✅ Node dependencies installed (`npm install`)
- ✅ Python dependencies installed (`pip install -r requirements.txt`)
- ✅ ffmpeg in system PATH
- ✅ `secrets.local.json` created with API credentials

### Running the tool:

1. Start the application:
```bash
npm start
```

2. Enter the YouTube URL or video ID in the first field

3. Enter the Genius URL with romaji lyrics in the second field

4. Click "Fetch & Align" to:
   - Download romaji from Genius
   - Find Japanese captions (manual preferred, ASR fallback)
   - Search for donor videos if needed
   - Romanize Japanese captions using Kuromoji + Wanakana
   - Align sequences using dynamic programming
   - Generate timed segments and WebVTT

5. Review the generated segments and WebVTT preview

6. Click "Push to DB" to upload the timed romaji to your database

7. Results are automatically saved to `output/{videoId}.json`

## How It Works

### 1. Romaji Extraction

The tool fetches the Genius page and extracts lyrics from the page's content:
- Finds lyrics containers using CSS selectors
- Converts `<br>` tags to newlines
- Strips HTML tags and section headers like [Chorus], [Verse]
- Normalizes text (lowercase, removes punctuation, collapses spaces)

### 2. Caption Source Priority

The tool attempts to obtain Japanese captions in this strict order:

**1. Manual JA captions on target video** (preferred)
   - Fetches track list from YouTube TimedText API
   - Looks for tracks with `lang_code` starting with "ja" and `kind` != "asr"
   - Downloads in JSON3 format
   - **Result:** `timingPath=manualJA`

**2. ASR JA captions on target video** (fallback)
   - Auto-generated Japanese captions
   - Strict validation: ONLY accepts tracks with `lang` starting with "ja" AND `kind=asr`
   - Rejects any non-Japanese ASR or auto-translated tracks
   - **Result:** `timingPath=asrJA`

**3. Whisper forced alignment** (Whisper transcription + alignment)
   - Downloads audio using yt-dlp
   - Transcribes with faster-whisper (language=ja, VAD enabled)
   - Romanizes transcription with pykakasi
   - Aligns Whisper-generated romaji to Genius romaji using DP
   - **Result:** `timingPath=whisper`

**4. Donor video search** (disabled by default, requires `ENABLE_DONOR=true`)
   - Only runs if `ENABLE_DONOR=true` in config AND Whisper fails
   - Searches YouTube for videos with similar titles plus keywords: "歌詞", "字幕", "歌ってみた"
   - Checks each result for Japanese captions (manual first, then ASR)
   - Uses first match found
   - **Result:** `timingPath=donor`

### 3. Whisper Alignment

When no Japanese captions are available on the target video, Whisper provides forced alignment:

**Process:**
1. Download audio from YouTube with yt-dlp (best quality audio stream)
2. Transcribe with faster-whisper:
   - Model: Configured via `WHISPER_MODEL` (default: `large-v3`)
   - Language: Japanese (forced)
   - VAD: Enabled for better segment boundaries
   - Output: Timestamped Japanese text segments
3. Romanize each segment using pykakasi (kakasi → Hepburn romaji)
4. Normalize both Whisper romaji and Genius romaji (lowercase, no punctuation)
5. Perform DP sequence alignment between Whisper and Genius
6. Assign Whisper timestamps to aligned Genius lines

**Advantages:**
- Works even when no captions exist on YouTube
- More accurate than donor search for timing
- Handles variations in pronunciation

**Requirements:**
- Python 3.8+
- faster-whisper library
- pykakasi library
- yt-dlp for audio download
- ffmpeg (system dependency)

### 4. Alignment Algorithm

Uses dynamic programming sequence alignment similar to Needleman-Wunsch:

- **Donor preparation**: Romanizes Japanese captions using Kuromoji (tokenization) + Wanakana (katakana→romaji)
- **Normalization**: Both donor and target lines normalized (lowercase, no punctuation)
- **DP matrix**: Computes optimal alignment with these operations:
  - Match (1:1 line mapping) - cost based on Levenshtein distance
  - Skip donor line - cost 2
  - Skip target line - cost 3
  - Merge 2 donor lines → 1 target - cost based on merged similarity
  - Split 1 donor → 2 target lines - cost based on split similarity

### 5. Timestamp Assignment

- **1:1 matches**: Direct time copy from donor
- **Merged donor lines**: Use start of first + end of last donor line
- **Split target lines**: Divide donor time range proportionally

### 6. Output Generation

- **Segments**: Array of `{start, end, text}` objects with times in seconds
- **VTT**: Standard WebVTT format with timecodes
- **Hash**: SHA256 of concatenated romaji text for cache validation
- **Local file**: Saved to `output/{videoId}.json` for reference

## Troubleshooting

**"No Japanese captions found for alignment" / "All alignment methods failed"**
- Manual JA, ASR JA, and Whisper all failed
- Check Python dependencies are installed: `pip install faster-whisper pykakasi yt-dlp`
- Verify ffmpeg is in PATH
- Check Whisper logs for transcription errors
- If needed, enable donor search with `ENABLE_DONOR=true`

**"Failed to load config"**
- Ensure `secrets.local.json` exists in the tool directory
- Check JSON format is valid
- Verify required fields are present

**"Failed to push"**
- Check ROMAJI_API_BASE URL is correct
- Verify ROMAJI_API_TOKEN is valid
- Ensure server is running and accessible
- Check server logs for authentication errors

**Whisper transcription slow or failing**
- Large models (large-v3) require significant GPU/CPU resources
- Try a smaller model: `WHISPER_MODEL=medium` or `WHISPER_MODEL=base`
- First run downloads model files (normal, can be several GB)
- Use CUDA if available for faster processing
- Check disk space for model cache and temp audio files

**Kuromoji initialization slow**
- First run downloads dictionary files (normal)
- Subsequent runs should be faster

**Python execution fails**
- Verify `PYTHON_BIN` points to correct Python executable
- Try absolute path: `"PYTHON_BIN": "C:\\Python311\\python.exe"` (Windows)
- Ensure Python 3.8+ is installed: `python --version`

## Output Format

The tool saves results to `output/{videoId}.json`:

```json
{
  "videoId": "dQw4w9WgXcQ",
  "geniusUrl": "https://genius.com/...",
  "segments": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "kimi ga donna toki mo"
    }
  ],
  "vtt": "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nkimi ga donna toki mo\n\n...",
  "textHash": "abc123..."
}
```

## Database Schema

The server endpoint expects a `romanized_cache` table with these columns:
- `video_id` (TEXT, primary key)
- `romanized_text` (TEXT)
- `vtt` (TEXT, nullable)
- `segments` (JSONB, nullable)
- `timed` (BOOLEAN, nullable)
- `source` (TEXT, nullable)
- `genius_url` (TEXT, nullable)
- `text_hash` (TEXT, nullable)
- `tool_version` (TEXT, nullable)
- `updated_at` (TIMESTAMPTZ, nullable)

## License

Same as parent project