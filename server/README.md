# Romaji API Server

Simple backend server for AI-powered romanization.

## Why Server-Side?

Running ML models client-side sucks:
- 800MB download per user
- Browser freezes during initialization
- Slow inference on weak hardware
- Massive battery drain

Server-side is how EVERY AI company does it for good reasons.

## Architecture

```
Browser Extension
      ↓
  This Server (stores API key)
      ↓
HuggingFace / OpenAI / Anthropic
      ↓
  Returns romanized text
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set your API key:
```bash
# Create .env file
echo "HUGGINGFACE_API_KEY=your_key_here" > .env
```

3. Start server:
```bash
npm start
```

## API Endpoint

### POST /romanize

Request:
```json
{
  "text": "こんにちは"
}
```

Response:
```json
{
  "romanized": "konnichiwa"
}
```

## Cost Estimates

- HuggingFace Inference API: ~$0.06 per 1000 requests
- OpenAI GPT-3.5: ~$0.0015 per 1K tokens
- First 30K requests/month are basically free

## Deployment

Deploy to:
- Railway (easiest)
- Fly.io
- Heroku
- Your own VPS

Takes 5 minutes.
