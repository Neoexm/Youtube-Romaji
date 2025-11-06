import sys
import json
import argparse
import os
import subprocess
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)

from faster_whisper import WhisperModel
import pykakasi

def normalize_romaji(text):
    return text.lower().replace(',', '').replace('.', '').replace('!', '').replace('?', '').replace(';', '').replace(':', '').replace('"', '').replace("'", '').replace('(', '').replace(')', '').replace('[', '').replace(']', '').replace('{', '').replace('}', '').replace('  ', ' ').strip()

def japanese_to_romaji(text):
    kks = pykakasi.kakasi()
    result = kks.convert(text)
    romaji = ''.join([item['hepburn'] for item in result])
    return romaji

def detect_silence(audio_path):
    cmd = [
        'ffmpeg',
        '-i', audio_path,
        '-af', 'silencedetect=noise=-30dB:d=0.5',
        '-f', 'null',
        '-'
    ]
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    chunks = []
    silence_starts = []
    silence_ends = []
    
    for line in result.stderr.split('\n'):
        if 'silence_start:' in line:
            try:
                start = float(line.split('silence_start:')[1].strip())
                silence_starts.append(start)
            except:
                pass
        elif 'silence_end:' in line:
            try:
                end = float(line.split('silence_end:')[1].split('|')[0].strip())
                silence_ends.append(end)
            except:
                pass
    
    if not silence_ends:
        return None
    
    duration = get_audio_duration(audio_path)
    
    last_end = 0
    for i, silence_end in enumerate(silence_ends):
        next_start = silence_starts[i+1] if i+1 < len(silence_starts) else duration
        
        chunk_start = silence_end
        chunk_end = next_start
        
        if chunk_end - chunk_start > 5:
            chunks.append((chunk_start, min(chunk_end, chunk_start + 10)))
            
            remaining = chunk_end - (chunk_start + 10)
            offset = chunk_start + 10
            while remaining > 5:
                chunks.append((offset - 0.5, min(offset + 10, chunk_end)))
                offset += 10
                remaining = chunk_end - offset
    
    return chunks if chunks else None

def transcribe_with_whisper(audio_path, model_name, device, retry_mode='normal'):
    print(f"Loading Whisper model: {model_name} on {device}", file=sys.stderr)
    model = WhisperModel(model_name, device=device, compute_type="float16" if device == "cuda" else "int8")
    
    if retry_mode == 'normal':
        print("Transcribing (first pass: no VAD, temperature fallback)...", file=sys.stderr)
        segments, info = model.transcribe(
            audio_path,
            language="ja",
            task="transcribe",
            beam_size=5,
            best_of=5,
            condition_on_previous_text=False,
            vad_filter=False,
            no_speech_threshold=0.10,
            log_prob_threshold=-1.2,
            compression_ratio_threshold=2.6,
            temperature=[0, 0.2, 0.4, 0.6]
        )
    elif retry_mode == 'vad':
        print("Transcribing (retry A: with VAD)...", file=sys.stderr)
        segments, info = model.transcribe(
            audio_path,
            language="ja",
            task="transcribe",
            beam_size=5,
            best_of=5,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=300),
            no_speech_threshold=0.05,
            log_prob_threshold=-1.2,
            compression_ratio_threshold=2.6,
            temperature=[0, 0.2, 0.4, 0.6]
        )
    else:
        raise ValueError(f"Unknown retry_mode: {retry_mode}")
    
    print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})", file=sys.stderr)
    
    result_segments = []
    for segment in segments:
        text_ja = segment.text.strip()
        if not text_ja:
            continue
        
        text_romaji = japanese_to_romaji(text_ja)
        text_romaji_normalized = normalize_romaji(text_romaji)
        
        result_segments.append({
            'start': segment.start,
            'end': segment.end,
            'text_ja': text_ja,
            'text_romaji': text_romaji,
            'text_romaji_normalized': text_romaji_normalized
        })
    
    return result_segments

def transcribe_chunks(audio_path, chunks, model_name, device):
    print(f"Transcribing {len(chunks)} chunks...", file=sys.stderr)
    model = WhisperModel(model_name, device=device, compute_type="float16" if device == "cuda" else "int8")
    
    all_segments = []
    cache_dir = get_cache_dir()
    
    for i, (start, end) in enumerate(chunks):
        chunk_path = os.path.join(cache_dir, f"chunk_{i}.wav")
        
        cmd = [
            'ffmpeg',
            '-i', audio_path,
            '-ss', str(start),
            '-to', str(end),
            '-ar', '16000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            '-y',
            chunk_path
        ]
        
        subprocess.run(cmd, capture_output=True, check=True)
        
        segments, _ = model.transcribe(
            chunk_path,
            language="ja",
            task="transcribe",
            beam_size=5,
            best_of=5,
            condition_on_previous_text=False,
            vad_filter=False,
            no_speech_threshold=0.10,
            log_prob_threshold=-1.2,
            compression_ratio_threshold=2.6,
            temperature=[0, 0.2, 0.4, 0.6]
        )
        
        for segment in segments:
            text_ja = segment.text.strip()
            if not text_ja:
                continue
            
            text_romaji = japanese_to_romaji(text_ja)
            text_romaji_normalized = normalize_romaji(text_romaji)
            
            all_segments.append({
                'start': start + segment.start,
                'end': start + segment.end,
                'text_ja': text_ja,
                'text_romaji': text_romaji,
                'text_romaji_normalized': text_romaji_normalized
            })
        
        os.remove(chunk_path)
    
    all_segments.sort(key=lambda x: x['start'])
    return all_segments

def main():
    parser = argparse.ArgumentParser(description='Whisper alignment for Japanese audio')
    parser.add_argument('--videoId', required=True, help='YouTube video ID')
    parser.add_argument('--youtubeUrl', help='Full YouTube URL')
    parser.add_argument('--audioPath', help='Path to audio file (optional)')
    parser.add_argument('--model', default='large-v3', help='Whisper model name')
    parser.add_argument('--device', default='auto', help='Device: auto, cpu, or cuda')
    
    args = parser.parse_args()
    
    if args.device == 'auto':
        try:
            import torch
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
        except ImportError:
            device = 'cpu'
    else:
        device = args.device
    
    print(f"Using device: {device}", file=sys.stderr)
    
    audio_path = args.audioPath
    if not audio_path:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        download_script = os.path.join(script_dir, 'download_audio.py')
        
        url = args.youtubeUrl if args.youtubeUrl else f"https://www.youtube.com/watch?v={args.videoId}"
        
        cmd = ['python', download_script, '--videoId', args.videoId, '--url', url]
        
        print(f"Downloading audio...", file=sys.stderr)
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(result.stderr, file=sys.stderr)
            sys.exit(result.returncode)
        
        for line in result.stderr.split('\n'):
            if line.strip():
                print(line, file=sys.stderr)
        
        audio_path = result.stdout.strip()
    
    if not os.path.exists(audio_path):
        print(f"Error: Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)
    
    preprocessed_path = audio_path
    print(f"Using audio: {preprocessed_path}", file=sys.stderr)
    
    segments = transcribe_with_whisper(preprocessed_path, args.model, device, 'normal')
    
    if len(segments) == 0:
        print("First pass yielded 0 segments, trying retry A (VAD)...", file=sys.stderr)
        segments = transcribe_with_whisper(preprocessed_path, args.model, device, 'vad')
    
    if len(segments) == 0:
        print("Retry A yielded 0 segments, trying retry B (chunk-based)...", file=sys.stderr)
        chunks = detect_silence(preprocessed_path)
        if chunks:
            segments = transcribe_chunks(preprocessed_path, chunks, args.model, device)
        else:
            print("Could not detect silence chunks", file=sys.stderr)
    
    if len(segments) == 0:
        print("WHISPER_NO_SEGMENTS", file=sys.stderr)
        sys.exit(1)
    
    print(f"Transcribed {len(segments)} segments", file=sys.stderr)
    
    output = {'segments': segments}
    print(json.dumps(output, ensure_ascii=False))

if __name__ == '__main__':
    main()