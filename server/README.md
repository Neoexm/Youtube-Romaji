# Romaji API Server

[`server/index.js`](server/index.js) keeps the public Node/Express API surface, while the authoritative Japanese romanization pipeline now lives in the Python sidecar CLI at [`server/python/romanize_cli.py`](server/python/romanize_cli.py).

## Runtime architecture

1. [`server/index.js`](server/index.js) resolves video metadata and Musixmatch lyrics.
2. [`server/lib/romaji-client.js`](server/lib/romaji-client.js) invokes the Python sidecar with JSON over stdin/stdout.
3. [`server/python/romaji_service/pipeline.py`](server/python/romaji_service/pipeline.py) runs the canonical pipeline:
   - normalization
   - script/content inspection
   - contextual analysis hooks for KWJA
   - tokenization/reading extraction via SudachiPy when available
   - project override handling via [`server/config/romaji-overrides.json`](server/config/romaji-overrides.json)
   - optional fallback routing for Juman++
   - pronunciation resolution via [`pyopenjtalk.g2p()`](server/python/romaji_service/pipeline.py:460)
   - ASCII Hepburn romaji rendering
   - formatting cleanup

## Romanization style

- ASCII Hepburn only
- Explicit long vowels: `ou`, `uu`, `aa`, `ei`
- No macrons in API output
- Japanese punctuation is normalized to ASCII where practical
- Line breaks are preserved

## Optional NLP stack

The sidecar works in stdlib-only fallback mode, but the full production-quality stack is defined in [`server/python/requirements.optional-nlp.txt`](server/python/requirements.optional-nlp.txt):

- KWJA
- SudachiPy
- `sudachidict_full`
- pyopenjtalk

Install the optional stack locally with:

```bash
python -m pip install -r server/python/requirements.optional-nlp.txt
```

`Juman++` remains optional and is detected through the `JUMANPP_BIN` environment variable when present.

## Local development

Install Node dependencies:

```bash
cd server && npm ci
```

Run the API:

```bash
cd server && npm start
```

Run server tests:

```bash
cd server && npm test
```

Run Python pipeline tests from the repository root:

```bash
python -m unittest discover -s server/python/tests -t server/python -v
```
