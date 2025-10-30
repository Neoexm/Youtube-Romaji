# Quick Start Guide

## 1. Install Dependencies

```bash
cd server
npm install
```

## 2. Get API Key

1. Go to https://huggingface.co/settings/tokens
2. Create new token (free account)
3. Copy the token (starts with `hf_...`)

## 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your key:
```
HUGGINGFACE_API_KEY=hf_your_actual_key_here
PORT=3000
```

## 4. Start Server

```bash
npm start
```

You should see:
```
Romaji API Server listening on port 3000
Health check: http://localhost:3000/health
Romanize endpoint: POST http://localhost:3000/romanize
```

## 5. Test It

In another terminal:

```bash
node test.js
```

You should see:
```
Testing romanization API...

Input: こんにちは
Output: konnichiwa

Success!
```

## 6. Deploy (Optional)

See `DEPLOYMENT.md` for deployment instructions.

## Troubleshooting

### "API key not configured"
- Make sure `.env` file exists in `server/` directory
- Make sure it has `HUGGINGFACE_API_KEY=hf_...`
- Restart the server after creating `.env`

### "Model is loading" error
- HuggingFace models cold-start on first request
- Wait 10-20 seconds and try again
- Subsequent requests will be instant

### Port 3000 already in use
- Change PORT in `.env` to different number (e.g., 3001)
- Or kill the process: `lsof -ti:3000 | xargs kill -9` (Mac/Linux)

## Next Steps

1. Integrate API calls into your extension
2. Add caching for better performance
3. Deploy to production server
4. Monitor usage and costs

See `MIGRATION.md` for architecture details.
