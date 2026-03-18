import json
import sys
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, scrolledtext, ttk

PROJECT_ROOT = Path(__file__).resolve().parent
PYTHON_SIDECAR_ROOT = PROJECT_ROOT / "server" / "python"

if str(PYTHON_SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_SIDECAR_ROOT))

from romaji_service.pipeline import PronunciationRomajiPipeline  # noqa: E402


class RomajiGUITool:
    def __init__(self, root):
        self.root = root
        self.root.title("Pronunciation Romaji Tool")
        self.root.geometry("980x760")

        self.pipeline = PronunciationRomajiPipeline()
        self.setup_ui()
        self.refresh_engine_status()

    def setup_ui(self):
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)

        title = ttk.Label(
            main_frame,
            text="Authoritative pronunciation-based romaji pipeline",
            font=("Arial", 11, "bold"),
        )
        title.grid(row=0, column=0, sticky=tk.W, pady=(0, 6))

        self.engine_var = tk.StringVar(value="Engine: loading...")
        engine_label = ttk.Label(main_frame, textvariable=self.engine_var)
        engine_label.grid(row=1, column=0, sticky=tk.W, pady=(0, 10))

        ttk.Label(main_frame, text="Japanese text", font=("Arial", 10, "bold")).grid(
            row=2, column=0, sticky=tk.W, pady=(0, 5)
        )

        self.input_text = scrolledtext.ScrolledText(main_frame, height=12, width=90, wrap=tk.WORD)
        self.input_text.grid(row=3, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))

        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=4, column=0, sticky=tk.W, pady=(0, 10))

        self.romanize_btn = ttk.Button(button_frame, text="Romanize", command=self.romanize, width=18)
        self.romanize_btn.grid(row=0, column=0, padx=(0, 8))

        ttk.Button(button_frame, text="Clear", command=self.clear_all, width=18).grid(
            row=0, column=1, padx=(0, 8)
        )
        ttk.Button(button_frame, text="Refresh engine info", command=self.refresh_engine_status, width=18).grid(
            row=0, column=2
        )

        ttk.Label(main_frame, text="Romaji output", font=("Arial", 10, "bold")).grid(
            row=5, column=0, sticky=tk.W, pady=(0, 5)
        )

        self.output_text = scrolledtext.ScrolledText(main_frame, height=12, width=90, wrap=tk.WORD)
        self.output_text.grid(row=6, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))

        ttk.Label(main_frame, text="Pipeline details", font=("Arial", 10, "bold")).grid(
            row=7, column=0, sticky=tk.W, pady=(0, 5)
        )

        self.details_text = scrolledtext.ScrolledText(main_frame, height=10, width=90, wrap=tk.WORD)
        self.details_text.grid(row=8, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        main_frame.rowconfigure(3, weight=1)
        main_frame.rowconfigure(6, weight=1)
        main_frame.rowconfigure(8, weight=1)

        self.status_var = tk.StringVar(value="Ready")
        status_bar = ttk.Label(main_frame, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_bar.grid(row=9, column=0, sticky=(tk.W, tk.E), pady=(10, 0))

    def refresh_engine_status(self):
        health = self.pipeline.health()
        components = health["components"]
        mode = health["mode"]
        status_bits = [
            f"mode={mode}",
            f"kwja={'yes' if components['kwja']['available'] else 'no'}",
            f"sudachi={'yes' if components['sudachipy']['available'] else 'no'}",
            f"pyopenjtalk={'yes' if components['pyopenjtalk']['available'] else 'no'}",
            f"jumanpp={'yes' if components['jumanpp']['available'] else 'no'}",
        ]
        self.engine_var.set("Engine: " + ", ".join(status_bits))

    def romanize(self):
        japanese_text = self.input_text.get("1.0", tk.END).rstrip("\n")
        if not japanese_text.strip():
            messagebox.showwarning("Warning", "Please enter Japanese text to romanize")
            return

        self.status_var.set("Romanizing...")
        self.romanize_btn.config(state=tk.DISABLED)
        self.root.update_idletasks()

        try:
            result = self.pipeline.romanize_text(japanese_text, {"source": "gui"})
            self.output_text.delete("1.0", tk.END)
            self.output_text.insert("1.0", result["text"])

            details = {
                "confidence": result["confidence"],
                "warnings": result["warnings"],
                "engine": result["engine"],
                "stages": result["stages"],
            }
            self.details_text.delete("1.0", tk.END)
            self.details_text.insert("1.0", json.dumps(details, indent=2, ensure_ascii=False))

            self.status_var.set(
                f"Romanization complete (confidence={result['confidence']:.2f}, warnings={len(result['warnings'])})"
            )
        except Exception as exc:
            messagebox.showerror("Error", f"Romanization failed: {exc}")
            self.status_var.set("Error occurred")
        finally:
            self.romanize_btn.config(state=tk.NORMAL)

    def clear_all(self):
        self.input_text.delete("1.0", tk.END)
        self.output_text.delete("1.0", tk.END)
        self.details_text.delete("1.0", tk.END)
        self.status_var.set("Cleared")


def main():
    root = tk.Tk()
    RomajiGUITool(root)
    root.mainloop()


if __name__ == "__main__":
    main()
