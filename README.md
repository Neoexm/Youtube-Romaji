# YouTube Romaji + Custom Subtitles

This repository contains a Chrome extension and a Node/Express backend that add pronunciation-based romaji captions to YouTube videos.

## What changed in the migration

The old active Kuroshiro path has been retired from production. The only authoritative romanization path is now:

1. [`content.js`](content.js) asks the backend for romaji cues.
2. [`server/index.js`](server/index.js) resolves Musixmatch lyrics.
3. [`server/lib/romaji-client.js`](server/lib/romaji-client.js) invokes the Python sidecar.
4. [`server/python/romaji_service/pipeline.py`](server/python/romaji_service/pipeline.py) produces pronunciation-aware ASCII Hepburn romaji.

## Romanization pipeline

The canonical path separates the following stages:

1. normalization
2. script/content inspection
3. contextual analysis
4. tokenization/reading extraction
5. override handling
6. fallback routing
7. pronunciation resolution
8. romaji rendering
9. cleanup/formatting

Project overrides live in [`server/config/romaji-overrides.json`](server/config/romaji-overrides.json).

## Stack ownership

- Public API and extension integration stay in Node/Express.
- Japanese NLP lives in the Python sidecar CLI at [`server/python/romanize_cli.py`](server/python/romanize_cli.py).
- The standalone desktop tool in [`romaji_gui_tool.py`](romaji_gui_tool.py) was migrated to the same Python pipeline, so there is no remaining OpenAI-only romanization path in the repo.

## Required output style

- `こんにちは` → `konnichiwa`
- `こんばんは` → `konbanwa`
- `元気？` → `genki?`
- `大丈夫` → `daijoubu`
- `学校` → `gakkou`
- `しんよう` → `shinyou`
- `東京` → `toukyou`
- `コンピューター` → `konpyuutaa`

## Local setup

Install extension dependencies:

```bash
npm ci
```

Install backend dependencies:

```bash
cd server && npm ci
```

Optional full NLP stack for the Python sidecar:

```bash
python -m pip install -r server/python/requirements.optional-nlp.txt
```

## Development commands

Run linting:

```bash
npm run lint
```

Run all tests:

```bash
npm test
```

Run only the Python pipeline tests:

```bash
npm run test:python
```

Run the backend only:

```bash
cd server && npm start
```
