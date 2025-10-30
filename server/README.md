# Romaji API Server

Express API server that romanizes Japanese text using OpenAI GPT-5 with Supabase caching.

## Setup

### 1. Supabase Database Setup

Create a table in your Supabase project:

```sql
CREATE TABLE romanized_cache (
  id BIGSERIAL PRIMARY KEY,
  video_id TEXT UNIQUE NOT NULL,
  romanized_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_video_id ON romanized_cache(video_id);
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in:
- `OPENAI_API_KEY` - Your OpenAI API key
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_KEY` - Your Supabase anon/public key

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Locally

```bash
npm start
```

### 5. Deploy to Fly.io

```bash
fly launch
fly secrets set OPENAI_API_KEY=your_key_here
fly secrets set SUPABASE_URL=your_url_here
fly secrets set SUPABASE_KEY=your_key_here
fly deploy
```

## API Endpoints

### GET /health
Health check endpoint.

### POST /romanize
Romanize Japanese text.

**Request:**
```json
{
  "videoId": "dQw4w9WgXcQ",
  "text": "きみがどんなときも　あたし側にいるわ"
}
```

**Response:**
```json
{
  "romanized": "kimi ga donna toki mo atashi soba ni iru wa",
  "cached": false
}
```

## Caching Strategy

- First request for a video ID: Calls OpenAI (high reasoning), stores in Supabase
- Subsequent requests: Returns cached result instantly
- Cost: ~$0.014 per unique video, $0 for cached hits
