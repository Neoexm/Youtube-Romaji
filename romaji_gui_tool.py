import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import json
from openai import OpenAI
import os
from pathlib import Path

class RomajiGUITool:
    def __init__(self, root):
        self.root = root
        self.root.title("Romaji Romanization Tool")
        self.root.geometry("900x700")
        
        self.openai_client = None
        self.setup_ui()
        self.load_config()
        
    def setup_ui(self):
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        
        ttk.Label(main_frame, text="OpenAI API Key:", font=('Arial', 10, 'bold')).grid(row=0, column=0, sticky=tk.W, pady=(0, 5))
        
        api_frame = ttk.Frame(main_frame)
        api_frame.grid(row=1, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        api_frame.columnconfigure(0, weight=1)
        
        self.api_key_var = tk.StringVar()
        api_entry = ttk.Entry(api_frame, textvariable=self.api_key_var, show="*", width=50)
        api_entry.grid(row=0, column=0, sticky=(tk.W, tk.E), padx=(0, 5))
        
        ttk.Button(api_frame, text="Save Key", command=self.save_api_key).grid(row=0, column=1)
        
        separator1 = ttk.Separator(main_frame, orient='horizontal')
        separator1.grid(row=2, column=0, sticky=(tk.W, tk.E), pady=10)
        
        ttk.Label(main_frame, text="Variables:", font=('Arial', 10, 'bold')).grid(row=3, column=0, sticky=tk.W, pady=(0, 5))
        
        var_frame = ttk.Frame(main_frame)
        var_frame.grid(row=4, column=0, sticky=(tk.W, tk.E), pady=(0, 10))
        var_frame.columnconfigure(1, weight=1)
        
        ttk.Label(var_frame, text="Genius Romanized:").grid(row=0, column=0, sticky=(tk.W, tk.N), pady=2)
        self.genius_text = scrolledtext.ScrolledText(var_frame, height=4, wrap=tk.WORD)
        self.genius_text.grid(row=0, column=1, sticky=(tk.W, tk.E), padx=(5, 0), pady=2)
        self.genius_text.insert("1.0", "Not available")
        
        ttk.Label(var_frame, text="Line Count:").grid(row=1, column=0, sticky=tk.W, pady=2)
        self.line_count_var = tk.StringVar(value="0")
        ttk.Entry(var_frame, textvariable=self.line_count_var).grid(row=1, column=1, sticky=(tk.W, tk.E), padx=(5, 0), pady=2)
        
        separator2 = ttk.Separator(main_frame, orient='horizontal')
        separator2.grid(row=5, column=0, sticky=(tk.W, tk.E), pady=10)
        
        ttk.Label(main_frame, text="Japanese Captions (Input):", font=('Arial', 10, 'bold')).grid(row=6, column=0, sticky=tk.W, pady=(0, 5))
        
        self.input_text = scrolledtext.ScrolledText(main_frame, height=12, width=80, wrap=tk.WORD)
        self.input_text.grid(row=7, column=0, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        self.input_text.bind('<KeyRelease>', self.update_line_count)
        
        main_frame.rowconfigure(7, weight=1)
        
        btn_frame = ttk.Frame(main_frame)
        btn_frame.grid(row=8, column=0, pady=10)
        
        self.romanize_btn = ttk.Button(btn_frame, text="Romanize", command=self.romanize, width=20)
        self.romanize_btn.grid(row=0, column=0, padx=5)
        
        ttk.Button(btn_frame, text="Clear All", command=self.clear_all, width=20).grid(row=0, column=1, padx=5)
        
        ttk.Label(main_frame, text="Romanized Output:", font=('Arial', 10, 'bold')).grid(row=9, column=0, sticky=tk.W, pady=(0, 5))
        
        self.output_text = scrolledtext.ScrolledText(main_frame, height=12, width=80, wrap=tk.WORD)
        self.output_text.grid(row=10, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        main_frame.rowconfigure(10, weight=1)
        
        self.status_var = tk.StringVar(value="Ready")
        status_bar = ttk.Label(main_frame, textvariable=self.status_var, relief=tk.SUNKEN, anchor=tk.W)
        status_bar.grid(row=11, column=0, sticky=(tk.W, tk.E), pady=(10, 0))
        
    def update_line_count(self, event=None):
        text = self.input_text.get("1.0", tk.END).strip()
        if text:
            line_count = len(text.split('\n'))
            self.line_count_var.set(str(line_count))
        else:
            self.line_count_var.set("0")
    
    def load_config(self):
        config_path = Path.home() / ".romaji_tool_config.json"
        if config_path.exists():
            try:
                with open(config_path, 'r') as f:
                    config = json.load(f)
                    if 'api_key' in config:
                        self.api_key_var.set(config['api_key'])
                        self.init_openai_client()
            except Exception as e:
                print(f"Error loading config: {e}")
    
    def save_api_key(self):
        api_key = self.api_key_var.get().strip()
        if not api_key:
            messagebox.showwarning("Warning", "Please enter an API key")
            return
        
        config_path = Path.home() / ".romaji_tool_config.json"
        try:
            with open(config_path, 'w') as f:
                json.dump({'api_key': api_key}, f)
            
            self.init_openai_client()
            messagebox.showinfo("Success", "API key saved successfully")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to save API key: {e}")
    
    def init_openai_client(self):
        api_key = self.api_key_var.get().strip()
        if api_key:
            self.openai_client = OpenAI(api_key=api_key)
    
    def romanize(self):
        if not self.openai_client:
            messagebox.showerror("Error", "Please set your OpenAI API key first")
            return
        
        japanese_text = self.input_text.get("1.0", tk.END).strip()
        if not japanese_text:
            messagebox.showwarning("Warning", "Please enter Japanese text to romanize")
            return
        
        genius_romanized = self.genius_text.get("1.0", tk.END).strip()
        genius_romanized = genius_romanized.replace('~', '\\~')
        
        line_count = self.line_count_var.get().strip()
        
        self.status_var.set("Romanizing...")
        self.romanize_btn.config(state=tk.DISABLED)
        self.root.update_idletasks()
        
        try:
            response = self.openai_client.responses.create(
                prompt={
                    'id': 'pmpt_6903b00f45ec81909db49935f61cabc8050221356ced0cef',
                    'version': '3',
                    'variables': {
                        'japanese_captions': japanese_text,
                        'genius_romanized': genius_romanized,
                        'line_count': line_count
                    }
                }
            )
            
            romanized = response.output_text.strip()
            
            self.output_text.delete("1.0", tk.END)
            self.output_text.insert("1.0", romanized)
            
            self.status_var.set(f"Romanization complete ({len(romanized.split(chr(10)))} lines)")
        except Exception as e:
            messagebox.showerror("Error", f"Romanization failed: {e}")
            self.status_var.set("Error occurred")
        finally:
            self.romanize_btn.config(state=tk.NORMAL)
    
    def clear_all(self):
        self.input_text.delete("1.0", tk.END)
        self.output_text.delete("1.0", tk.END)
        self.genius_text.delete("1.0", tk.END)
        self.genius_text.insert("1.0", "Not available")
        self.line_count_var.set("0")
        self.status_var.set("Cleared")

def main():
    root = tk.Tk()
    app = RomajiGUITool(root)
    root.mainloop()

if __name__ == "__main__":
    main()
