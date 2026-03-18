from __future__ import annotations

import json
import os
import sys
import traceback

from romaji_service.pipeline import PronunciationRomajiPipeline


for stream_name in ("stdin", "stdout", "stderr"):
    stream = getattr(sys, stream_name, None)
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8")


PIPELINE = PronunciationRomajiPipeline()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def main() -> int:
    raw = sys.stdin.read().strip()
    payload = json.loads(raw or "{}")
    action = payload.get("action")

    if action == "health":
        emit({"ok": True, "health": PIPELINE.health()})
        return 0

    if action == "romanize_text":
        text = payload.get("text", "")
        context = payload.get("context") or {}
        emit({"ok": True, "result": PIPELINE.romanize_text(text, context)})
        return 0

    if action == "romanize_batch":
        texts = payload.get("texts") or []
        context = payload.get("context") or {}
        emit({"ok": True, "result": PIPELINE.romanize_batch(texts, context)})
        return 0

    emit({"ok": False, "error": f"Unsupported action: {action}"})
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # pragma: no cover - defensive CLI path
        debug = os.environ.get("ROMAJI_DEBUG") == "1"
        error_payload = {"ok": False, "error": str(exc)}
        if debug:
            error_payload["traceback"] = traceback.format_exc()
        emit(error_payload)
        raise SystemExit(1)
