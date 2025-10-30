# Deployment Guide

## Option 1: Railway (Easiest)

1. Go to [railway.app](https://railway.app)
2. Sign up with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repo
5. Add environment variable: `HUGGINGFACE_API_KEY=your_key`
6. Railway auto-detects Node.js and deploys
7. Get your URL: `https://your-app.railway.app`

**Cost:** $5/month for hobby plan (includes everything)

## Option 2: Fly.io

1. Install flyctl: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Initialize: `fly launch` (in server/ directory)
4. Set secrets: `fly secrets set HUGGINGFACE_API_KEY=your_key`
5. Deploy: `fly deploy`

**Cost:** Free tier available, then $0.0000022/sec

## Option 3: Heroku

1. Install Heroku CLI
2. Login: `heroku login`
3. Create app: `heroku create your-app-name`
4. Set env: `heroku config:set HUGGINGFACE_API_KEY=your_key`
5. Deploy: `git push heroku main`

**Cost:** $7/month for basic dyno

## Option 4: Your Own VPS

### Requirements
- Ubuntu 20.04+ or similar
- Node.js 18+
- nginx (for reverse proxy)
- SSL certificate (Let's Encrypt)

### Setup

1. SSH into your server
2. Install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

3. Clone your repo:
```bash
git clone your-repo-url
cd Youtube-Kanji/server
```

4. Install dependencies:
```bash
npm install --production
```

5. Create .env file:
```bash
nano .env
# Add: HUGGINGFACE_API_KEY=your_key
```

6. Install PM2 (process manager):
```bash
sudo npm install -g pm2
pm2 start index.js --name romaji-api
pm2 startup
pm2 save
```

7. Setup nginx reverse proxy:
```bash
sudo nano /etc/nginx/sites-available/romaji-api
```

Add:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

8. Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/romaji-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

9. Setup SSL with Let's Encrypt:
```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Getting HuggingFace API Key

1. Go to [huggingface.co](https://huggingface.co)
2. Sign up for free account
3. Go to Settings → Access Tokens
4. Create new token with "Read" permissions
5. Copy token (starts with `hf_...`)

**Free Tier:** 30,000 requests/month

## Updating Extension to Use Your Server

In your extension code, change the API URL:

```javascript
const ROMAJI_API_URL = 'https://your-deployed-url.com/romanize';
```

Build and reload extension.

## Monitoring

### Railway
- Built-in logs and metrics dashboard
- Real-time CPU/memory monitoring

### Fly.io
- `fly logs` - view logs
- `fly status` - check health

### PM2 (VPS)
- `pm2 logs romaji-api` - view logs
- `pm2 monit` - real-time monitoring
- `pm2 status` - check status

## Scaling

If you get popular:

1. **Add caching** - Cache romanized results in Redis
2. **Rate limiting** - Prevent abuse
3. **Load balancing** - Multiple instances
4. **CDN** - Cloudflare in front

But honestly, this simple setup can handle thousands of users.

## Cost Breakdown

**For 10,000 users making 10 requests each = 100K requests:**

- HuggingFace API: $6/month
- Railway hosting: $5/month
- **Total: $11/month**

Compare to client-side:
- 10,000 users × 800MB = 8TB bandwidth
- Most users experience browser freezes
- Terrible UX

Server-side is the OBVIOUS choice.
