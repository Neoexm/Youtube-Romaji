from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from romaji_service.pipeline import PronunciationRomajiPipeline


class PronunciationRomajiPipelineTests(unittest.TestCase):
    def setUp(self):
        self.pipeline = PronunciationRomajiPipeline()

    def test_required_examples(self):
        cases = {
            "こんにちは": "konnichiwa",
            "こんばんは": "konbanwa",
            "学校": "gakkou",
            "東京": "toukyou",
            "大丈夫": "daijoubu",
            "元気？": "genki?",
            "しんよう": "shinyou",
            "コンピューター": "konpyuutaa",
        }

        for source, expected in cases.items():
            with self.subTest(source=source):
                result = self.pipeline.romanize_text(source)
                self.assertEqual(result["text"], expected)

    def test_line_breaks_and_emoji_are_preserved(self):
        result = self.pipeline.romanize_text("こんにちは🙂\n東京")
        self.assertEqual(result["text"], "konnichiwa🙂\ntoukyou")

    def test_override_file_is_applied(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            override_path = Path(temp_dir) / "overrides.json"
            override_path.write_text(
                json.dumps(
                    {
                        "text_overrides": {},
                        "token_overrides": {
                            "推し": {"reading": "オシ"}
                        },
                        "romaji_overrides": {
                            "推し活": "oshikatsu-custom"
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            pipeline = PronunciationRomajiPipeline(override_path)
            self.assertEqual(pipeline.romanize_text("推し")["text"], "oshi")
            self.assertEqual(pipeline.romanize_text("推し活")["text"], "oshikatsu-custom")

    def test_health_reports_python_pipeline_and_optional_components(self):
        health = self.pipeline.health()
        self.assertEqual(health["name"], "python-pronunciation-pipeline")
        self.assertIn(health["mode"], {"full-stack", "fallback"})
        self.assertIn("kwja", health["components"])
        self.assertIn("sudachipy", health["components"])
        self.assertIn("pyopenjtalk", health["components"])


if __name__ == "__main__":
    unittest.main()
