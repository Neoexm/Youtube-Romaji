from __future__ import annotations

import json
import os
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any


HIRAGANA_START = 0x3040
HIRAGANA_END = 0x309F
KATAKANA_START = 0x30A0
KATAKANA_END = 0x30FF
KANJI_START = 0x4E00
KANJI_END = 0x9FFF

PARTICLE_PRONUNCIATION = {
    "は": "ワ",
    "へ": "エ",
    "を": "オ",
}

ASCII_PUNCTUATION = {
    "、": ",",
    "。": ".",
    "・": "-",
    "「": '"',
    "」": '"',
    "『": '"',
    "』": '"',
    "【": "[",
    "】": "]",
    "〜": "~",
}

BASE_ROMAJI = {
    "あ": "a",
    "い": "i",
    "う": "u",
    "え": "e",
    "お": "o",
    "か": "ka",
    "き": "ki",
    "く": "ku",
    "け": "ke",
    "こ": "ko",
    "さ": "sa",
    "し": "shi",
    "す": "su",
    "せ": "se",
    "そ": "so",
    "た": "ta",
    "ち": "chi",
    "つ": "tsu",
    "て": "te",
    "と": "to",
    "な": "na",
    "に": "ni",
    "ぬ": "nu",
    "ね": "ne",
    "の": "no",
    "は": "ha",
    "ひ": "hi",
    "ふ": "fu",
    "へ": "he",
    "ほ": "ho",
    "ま": "ma",
    "み": "mi",
    "む": "mu",
    "め": "me",
    "も": "mo",
    "や": "ya",
    "ゆ": "yu",
    "よ": "yo",
    "ら": "ra",
    "り": "ri",
    "る": "ru",
    "れ": "re",
    "ろ": "ro",
    "わ": "wa",
    "ゐ": "wi",
    "ゑ": "we",
    "を": "o",
    "ん": "n",
    "が": "ga",
    "ぎ": "gi",
    "ぐ": "gu",
    "げ": "ge",
    "ご": "go",
    "ざ": "za",
    "じ": "ji",
    "ず": "zu",
    "ぜ": "ze",
    "ぞ": "zo",
    "だ": "da",
    "ぢ": "ji",
    "づ": "zu",
    "で": "de",
    "ど": "do",
    "ば": "ba",
    "び": "bi",
    "ぶ": "bu",
    "べ": "be",
    "ぼ": "bo",
    "ぱ": "pa",
    "ぴ": "pi",
    "ぷ": "pu",
    "ぺ": "pe",
    "ぽ": "po",
    "ぁ": "a",
    "ぃ": "i",
    "ぅ": "u",
    "ぇ": "e",
    "ぉ": "o",
    "ゔ": "vu",
}

COMBO_ROMAJI = {
    "きゃ": "kya",
    "きゅ": "kyu",
    "きょ": "kyo",
    "ぎゃ": "gya",
    "ぎゅ": "gyu",
    "ぎょ": "gyo",
    "しゃ": "sha",
    "しゅ": "shu",
    "しょ": "sho",
    "じゃ": "ja",
    "じゅ": "ju",
    "じょ": "jo",
    "ちゃ": "cha",
    "ちゅ": "chu",
    "ちょ": "cho",
    "にゃ": "nya",
    "にゅ": "nyu",
    "にょ": "nyo",
    "ひゃ": "hya",
    "ひゅ": "hyu",
    "ひょ": "hyo",
    "びゃ": "bya",
    "びゅ": "byu",
    "びょ": "byo",
    "ぴゃ": "pya",
    "ぴゅ": "pyu",
    "ぴょ": "pyo",
    "みゃ": "mya",
    "みゅ": "myu",
    "みょ": "myo",
    "りゃ": "rya",
    "りゅ": "ryu",
    "りょ": "ryo",
    "てぃ": "ti",
    "でぃ": "di",
    "とぅ": "tu",
    "どぅ": "du",
    "ふぁ": "fa",
    "ふぃ": "fi",
    "ふぇ": "fe",
    "ふぉ": "fo",
    "うぃ": "wi",
    "うぇ": "we",
    "うぉ": "wo",
    "ゔぁ": "va",
    "ゔぃ": "vi",
    "ゔぇ": "ve",
    "ゔぉ": "vo",
    "つぁ": "tsa",
    "つぃ": "tsi",
    "つぇ": "tse",
    "つぉ": "tso",
    "しぇ": "she",
    "じぇ": "je",
    "ちぇ": "che",
    "てゅ": "tyu",
    "でゅ": "dyu",
}


@dataclass
class Token:
    surface: str
    kind: str
    reading: str | None = None
    part_of_speech: tuple[str, ...] = ()
    source: str = "preserved"


def is_hiragana(char: str) -> bool:
    code = ord(char)
    return HIRAGANA_START <= code <= HIRAGANA_END


def is_katakana(char: str) -> bool:
    code = ord(char)
    return KATAKANA_START <= code <= KATAKANA_END or char == "ー"


def is_kana(char: str) -> bool:
    return is_hiragana(char) or is_katakana(char)


def is_kanji(char: str) -> bool:
    code = ord(char)
    return KANJI_START <= code <= KANJI_END


def is_japanese_char(char: str) -> bool:
    return is_hiragana(char) or is_katakana(char) or is_kanji(char)


def katakana_to_hiragana(text: str) -> str:
    converted: list[str] = []
    for char in text:
        if char == "ー":
            converted.append(char)
        elif is_katakana(char) and char != "ヴ":
            converted.append(chr(ord(char) - 0x60))
        elif char == "ヴ":
            converted.append("ゔ")
        else:
            converted.append(char)
    return "".join(converted)


def hiragana_to_katakana(text: str) -> str:
    converted: list[str] = []
    for char in text:
        if is_hiragana(char):
            converted.append(chr(ord(char) + 0x60))
        else:
            converted.append(char)
    return "".join(converted)


def last_vowel(value: str) -> str:
    for char in reversed(value):
        if char in "aeiou":
            return char
    return ""


def next_syllable_romaji(text: str, index: int) -> str:
    if index >= len(text):
        return ""
    hira = katakana_to_hiragana(text[index:])
    if not hira:
        return ""
    if hira[0] == "っ":
        return next_syllable_romaji(hira, 1)
    if len(hira) >= 2 and hira[:2] in COMBO_ROMAJI:
        return COMBO_ROMAJI[hira[:2]]
    return BASE_ROMAJI.get(hira[0], "")


def kana_to_ascii_hepburn(text: str) -> str:
    hira = katakana_to_hiragana(text.replace(" ", ""))
    output: list[str] = []
    index = 0

    while index < len(hira):
        char = hira[index]

        if char == "っ":
            upcoming = next_syllable_romaji(hira, index + 1)
            if upcoming.startswith("ch"):
                output.append("t")
            elif upcoming:
                output.append(upcoming[0])
            index += 1
            continue

        if char == "ん":
            upcoming = next_syllable_romaji(hira, index + 1)
            _ = upcoming
            output.append("n")
            index += 1
            continue

        if char == "ー":
            if output:
                output.append(last_vowel(output[-1]))
            index += 1
            continue

        pair = hira[index : index + 2]
        if pair in COMBO_ROMAJI:
            output.append(COMBO_ROMAJI[pair])
            index += 2
            continue

        if char in ASCII_PUNCTUATION:
            output.append(ASCII_PUNCTUATION[char])
            index += 1
            continue

        if char.isspace():
            output.append(char)
            index += 1
            continue

        output.append(BASE_ROMAJI.get(char, char))
        index += 1

    return "".join(output)


class PronunciationRomajiPipeline:
    def __init__(self, overrides_path: str | os.PathLike[str] | None = None):
        self.overrides_path = Path(overrides_path) if overrides_path else self._default_overrides_path()
        self.overrides = self._load_overrides(self.overrides_path)
        self.token_overrides = dict(self.overrides.get("token_overrides", {}))
        self.text_overrides = dict(self.overrides.get("text_overrides", {}))
        self.romaji_overrides = dict(self.overrides.get("romaji_overrides", {}))
        self._token_keys = sorted(self.token_overrides.keys(), key=len, reverse=True)

        self._kwja_error: str | None = None
        self._sudachi_error: str | None = None
        self._pyopenjtalk_error: str | None = None

        self._kwja = self._load_kwja()
        self._sudachi_tokenizer, self._sudachi_split_mode = self._load_sudachi()
        self._pyopenjtalk = self._load_pyopenjtalk()

    def _default_overrides_path(self) -> Path:
        return Path(__file__).resolve().parents[2] / "config" / "romaji-overrides.json"

    def _load_overrides(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {"text_overrides": {}, "token_overrides": {}, "romaji_overrides": {}}
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def _load_kwja(self) -> Any | None:
        try:
            from kwja import KWJA  # type: ignore

            return KWJA()
        except Exception as exc:  # pragma: no cover - optional dependency
            self._kwja_error = str(exc)
            return None

    def _load_sudachi(self) -> tuple[Any | None, Any | None]:
        try:
            from sudachipy import Dictionary, SplitMode  # type: ignore

            try:
                tokenizer = Dictionary(dict="full").create()
            except Exception:
                tokenizer = Dictionary().create()
            return tokenizer, SplitMode.C
        except Exception as exc:  # pragma: no cover - optional dependency
            self._sudachi_error = str(exc)
            return None, None

    def _load_pyopenjtalk(self) -> Any | None:
        try:
            import pyopenjtalk  # type: ignore

            return pyopenjtalk
        except Exception as exc:  # pragma: no cover - optional dependency
            self._pyopenjtalk_error = str(exc)
            return None

    def _jumanpp_health(self) -> dict[str, Any]:
        candidate = os.environ.get("JUMANPP_BIN") or shutil.which("jumanpp")
        return {
            "available": bool(candidate),
            "path": candidate,
        }

    def health(self) -> dict[str, Any]:
        full_stack = self._sudachi_tokenizer is not None and self._pyopenjtalk is not None
        return {
            "name": "python-pronunciation-pipeline",
            "version": "1.0.0",
            "mode": "full-stack" if full_stack else "fallback",
            "components": {
                "kwja": {
                    "available": self._kwja is not None,
                    "error": self._kwja_error,
                },
                "sudachipy": {
                    "available": self._sudachi_tokenizer is not None,
                    "error": self._sudachi_error,
                },
                "pyopenjtalk": {
                    "available": self._pyopenjtalk is not None,
                    "error": self._pyopenjtalk_error,
                },
                "jumanpp": self._jumanpp_health(),
            },
            "override_path": str(self.overrides_path),
        }

    def normalize_text(self, text: str) -> str:
        normalized = unicodedata.normalize("NFKC", text)
        normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
        return normalized.translate(str.maketrans(ASCII_PUNCTUATION))

    def inspect_text(self, text: str) -> dict[str, Any]:
        japanese_count = sum(1 for char in text if is_japanese_char(char))
        ascii_count = sum(1 for char in text if ord(char) < 128 and not char.isspace())
        line_count = text.count("\n") + 1 if text else 0
        return {
            "has_japanese": japanese_count > 0,
            "japanese_count": japanese_count,
            "ascii_count": ascii_count,
            "line_count": line_count,
        }

    def contextual_analysis(self, text: str) -> dict[str, Any]:
        if self._kwja is None:
            return {"status": "unavailable", "reason": self._kwja_error}

        for method_name in ("apply_to_document", "apply_to_sentence", "predict"):
            method = getattr(self._kwja, method_name, None)
            if callable(method):
                try:
                    result = method(text)
                    return {"status": "used", "method": method_name, "summary": type(result).__name__}
                except Exception as exc:  # pragma: no cover - optional dependency
                    return {"status": "failed", "method": method_name, "reason": str(exc)}

        if callable(self._kwja):
            try:
                result = self._kwja(text)
                return {"status": "used", "method": "__call__", "summary": type(result).__name__}
            except Exception as exc:  # pragma: no cover - optional dependency
                return {"status": "failed", "method": "__call__", "reason": str(exc)}

        return {"status": "available", "reason": "No supported adapter method was found"}

    def romanize_text(self, text: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
        context = context or {}
        normalized = self.normalize_text(text)
        inspection = self.inspect_text(normalized)
        stages: dict[str, Any] = {
            "normalization": {"input": text, "normalized": normalized},
            "inspection": inspection,
            "contextual_analysis": self.contextual_analysis(normalized) if inspection["has_japanese"] else {"status": "skipped"},
        }

        if normalized in self.text_overrides:
            override = self.text_overrides[normalized]
            result_text = override.get("romaji") or kana_to_ascii_hepburn(override.get("reading", normalized))
            stages["override_handling"] = {"mode": "exact-text", "key": normalized}
            stages["tokenization"] = {"mode": "skipped"}
            stages["fallback_routing"] = {"used": False}
            stages["pronunciation_resolution"] = {"source": "override"}
            stages["romaji_rendering"] = {"text": result_text}
            stages["cleanup"] = {"text": result_text}
            return {
                "text": result_text,
                "confidence": 1.0,
                "warnings": [],
                "engine": self.health(),
                "context": context,
                "stages": stages,
                "tokens": [
                    {
                        "surface": normalized,
                        "reading": override.get("reading"),
                        "romaji": result_text,
                        "source": "text_override",
                        "confidence": 1.0,
                    }
                ],
            }

        if not inspection["has_japanese"]:
            stages["tokenization"] = {"mode": "skipped"}
            stages["override_handling"] = {"mode": "non-japanese"}
            stages["fallback_routing"] = {"used": False}
            stages["pronunciation_resolution"] = {"source": "preserved"}
            stages["romaji_rendering"] = {"text": normalized}
            stages["cleanup"] = {"text": normalized}
            return {
                "text": normalized,
                "confidence": 1.0,
                "warnings": [],
                "engine": self.health(),
                "context": context,
                "stages": stages,
                "tokens": [],
            }

        tokens, tokenization_mode = self.tokenize(normalized)
        rendered_tokens: list[dict[str, Any]] = []
        warnings: list[str] = []

        for token in tokens:
            rendered = self._render_token(token)
            rendered_tokens.append(rendered)
            if rendered["warning"]:
                warnings.append(rendered["warning"])

        result_text = "".join(token["romaji"] for token in rendered_tokens)
        confidence_values = [token["confidence"] for token in rendered_tokens if token["kind"] != "whitespace"]
        confidence = round(sum(confidence_values) / len(confidence_values), 3) if confidence_values else 1.0

        stages["tokenization"] = {"mode": tokenization_mode, "token_count": len(tokens)}
        stages["override_handling"] = {
            "token_overrides_used": [token["surface"] for token in rendered_tokens if token["source"] in {"token_override", "romaji_override"}],
        }
        stages["fallback_routing"] = {
            "used": tokenization_mode == "fallback" or any(token["source"] == "unknown-kanji" for token in rendered_tokens),
            "jumanpp_available": self._jumanpp_health()["available"],
        }
        stages["pronunciation_resolution"] = {
            "pyopenjtalk": self._pyopenjtalk is not None,
            "sources": sorted({token["source"] for token in rendered_tokens}),
        }
        stages["romaji_rendering"] = {"text": result_text}
        stages["cleanup"] = {"text": result_text}

        return {
            "text": result_text,
            "confidence": confidence,
            "warnings": warnings,
            "engine": self.health(),
            "context": context,
            "stages": stages,
            "tokens": rendered_tokens,
        }

    def romanize_batch(self, texts: list[str], context: dict[str, Any] | None = None) -> dict[str, Any]:
        context = context or {}
        items = [self.romanize_text(text, context) for text in texts]
        warnings = [warning for item in items for warning in item["warnings"]]
        return {
            "items": items,
            "warnings": warnings,
            "engine": self.health(),
        }

    def tokenize(self, text: str) -> tuple[list[Token], str]:
        if self._sudachi_tokenizer is not None:
            try:
                return self._tokenize_with_sudachi(text), "sudachi"
            except Exception:
                pass
        return self._fallback_tokenize(text), "fallback"

    def _tokenize_with_sudachi(self, text: str) -> list[Token]:
        tokens: list[Token] = []
        for morpheme in self._sudachi_tokenizer.tokenize(text, self._sudachi_split_mode):
            surface = morpheme.surface()
            reading = morpheme.reading_form()
            if reading == "*":
                reading = None
            pos = tuple(morpheme.part_of_speech())
            kind = "japanese" if any(is_japanese_char(char) for char in surface) else ("whitespace" if surface.isspace() else "other")
            source = "sudachi"
            if surface in self.token_overrides:
                reading = self.token_overrides[surface].get("reading", reading)
                source = "token_override"
            tokens.append(Token(surface=surface, kind=kind, reading=reading, part_of_speech=pos, source=source))
        return tokens

    def _fallback_tokenize(self, text: str) -> list[Token]:
        tokens: list[Token] = []
        index = 0
        protected_keys = sorted({*self._token_keys, *self.romaji_overrides.keys()}, key=len, reverse=True)

        while index < len(text):
            char = text[index]

            if char.isspace():
                end = index + 1
                while end < len(text) and text[end].isspace():
                    end += 1
                tokens.append(Token(surface=text[index:end], kind="whitespace", source="preserved"))
                index = end
                continue

            matched_override = next((key for key in protected_keys if text.startswith(key, index)), None)
            if matched_override:
                reading = self.token_overrides.get(matched_override, {}).get("reading")
                source = "token_override" if matched_override in self.token_overrides else "romaji_override"
                tokens.append(Token(surface=matched_override, kind="japanese", reading=reading, source=source))
                index += len(matched_override)
                continue

            if is_kana(char):
                end = index + 1
                while end < len(text) and is_kana(text[end]):
                    end += 1
                surface = text[index:end]
                tokens.append(Token(surface=surface, kind="japanese", reading=hiragana_to_katakana(surface), source="kana"))
                index = end
                continue

            if is_kanji(char):
                end = index + 1
                while end < len(text) and is_kanji(text[end]):
                    end += 1
                surface = text[index:end]
                reading = self.token_overrides.get(surface, {}).get("reading")
                source = "token_override" if surface in self.token_overrides else "unknown-kanji"
                tokens.append(Token(surface=surface, kind="japanese", reading=reading, source=source))
                index = end
                continue

            tokens.append(Token(surface=char, kind="other", source="preserved"))
            index += 1

        return tokens

    def _is_particle(self, token: Token) -> bool:
        if token.surface not in PARTICLE_PRONUNCIATION:
            return False
        if token.part_of_speech and token.part_of_speech[0] == "助詞":
            return True
        return token.source == "particle"

    def _pyopenjtalk_pronunciation(self, token: Token) -> str | None:
        if self._pyopenjtalk is None:
            return None

        candidates = [token.surface]
        if token.reading and token.reading not in candidates:
            candidates.append(token.reading)

        for candidate in candidates:
            if not candidate:
                continue
            try:
                kana = self._pyopenjtalk.g2p(candidate, kana=True)
                if kana:
                    return kana.replace(" ", "")
            except Exception:
                continue
        return None

    def _render_token(self, token: Token) -> dict[str, Any]:
        if token.kind == "whitespace":
            return {
                "surface": token.surface,
                "reading": token.reading,
                "romaji": token.surface,
                "source": token.source,
                "confidence": 1.0,
                "warning": None,
                "kind": token.kind,
            }

        if token.surface in self.romaji_overrides:
            return {
                "surface": token.surface,
                "reading": token.reading,
                "romaji": self.romaji_overrides[token.surface],
                "source": "romaji_override",
                "confidence": 1.0,
                "warning": None,
                "kind": token.kind,
            }

        if token.kind != "japanese":
            return {
                "surface": token.surface,
                "reading": token.reading,
                "romaji": token.surface,
                "source": token.source,
                "confidence": 1.0,
                "warning": None,
                "kind": token.kind,
            }

        if self._is_particle(token):
            pronunciation = PARTICLE_PRONUNCIATION[token.surface]
            return {
                "surface": token.surface,
                "reading": pronunciation,
                "romaji": kana_to_ascii_hepburn(pronunciation),
                "source": "particle-rule",
                "confidence": 0.97,
                "warning": None,
                "kind": token.kind,
            }

        pronunciation = self._pyopenjtalk_pronunciation(token)
        if pronunciation:
            return {
                "surface": token.surface,
                "reading": pronunciation,
                "romaji": kana_to_ascii_hepburn(pronunciation),
                "source": "pyopenjtalk",
                "confidence": 0.95,
                "warning": None,
                "kind": token.kind,
            }

        if token.reading:
            confidence = 0.92 if token.source == "token_override" else 0.8
            return {
                "surface": token.surface,
                "reading": token.reading,
                "romaji": kana_to_ascii_hepburn(token.reading),
                "source": token.source,
                "confidence": confidence,
                "warning": None,
                "kind": token.kind,
            }

        if all(is_kana(char) for char in token.surface):
            katakana = hiragana_to_katakana(token.surface)
            return {
                "surface": token.surface,
                "reading": katakana,
                "romaji": kana_to_ascii_hepburn(katakana),
                "source": "kana-fallback",
                "confidence": 0.7,
                "warning": None,
                "kind": token.kind,
            }

        warning = f"Low-confidence token left unresolved: {token.surface}"
        return {
            "surface": token.surface,
            "reading": token.reading,
            "romaji": token.surface,
            "source": token.source,
            "confidence": 0.1,
            "warning": warning,
            "kind": token.kind,
        }

