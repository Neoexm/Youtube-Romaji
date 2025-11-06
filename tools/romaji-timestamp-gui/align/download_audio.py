import sys
import os
import time
import threading
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

try:
    import yt_dlp
except ImportError:
    print("DOWNLOAD_FAILED: yt-dlp not installed", file=sys.stderr)
    sys.exit(1)

def get_cache_dir():
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
        cache_dir = os.path.join(base, 'RomajiTool', 'audio')
    else:
        cache_dir = os.path.expanduser('~/.cache/romajitool/audio')
    
    os.makedirs(cache_dir, exist_ok=True)
    return cache_dir

def check_ffmpeg():
    import subprocess
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
        return True
    except:
        return False

def get_duration(path):
    import subprocess
    cmd = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())
    except:
        return 0

def check_cache(video_id, cache_dir):
    for ext in ['m4a', 'wav', 'webm', 'opus']:
        path = os.path.join(cache_dir, f"{video_id}.{ext}")
        if os.path.exists(path):
            age_hours = (time.time() - os.path.getmtime(path)) / 3600
            size_kb = os.path.getsize(path) / 1024
            
            if age_hours < 6 and size_kb > 200:
                duration = get_duration(path)
                print(f"Cache hit: {path} (age: {age_hours:.1f}h, size: {size_kb:.0f}KB, duration: {duration:.1f}s)", file=sys.stderr)
                if duration >= 5:
                    return path
    
    return None

class ProgressTracker:
    def __init__(self):
        self.last_progress_time = time.time()
        self.last_log_time = 0
        self.stalled = False
        self.lock = threading.Lock()
        
    def update(self):
        with self.lock:
            self.last_progress_time = time.time()
    
    def check_stall(self):
        with self.lock:
            elapsed = time.time() - self.last_progress_time
            if elapsed > 30:
                self.stalled = True
                return True
            return False
    
    def progress_hook(self, d):
        self.update()
        
        if d['status'] == 'downloading':
            current_time = time.time()
            if current_time - self.last_log_time >= 2:
                self.last_log_time = current_time
                
                percent = d.get('_percent_str', 'N/A')
                speed = d.get('_speed_str', 'N/A')
                eta = d.get('_eta_str', 'N/A')
                downloaded = d.get('downloaded_bytes', 0)
                
                print(f"Progress: {percent} | Speed: {speed} | ETA: {eta} | Downloaded: {downloaded/1024/1024:.1f}MB", file=sys.stderr)
        
        elif d['status'] == 'finished':
            print(f"Download finished: {d.get('filename', 'unknown')}", file=sys.stderr)

def download_with_ytdlp(url, cache_dir, tracker, use_fallback=False):
    cookies_path = None
    for loc in [os.path.join(os.path.dirname(__file__), '..', 'cookies.txt'),
                os.path.join(cache_dir, '..', 'cookies.txt')]:
        if os.path.exists(loc):
            cookies_path = loc
            print(f"Using cookies from: {cookies_path}", file=sys.stderr)
            break
    
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'noplaylist': True,
        'socket_timeout': 15,
        'retries': 3,
        'fragment_retries': 3,
        'http_chunk_size': 1048576,
        'noprogress': False,
        'paths': {'home': cache_dir},
        'outtmpl': {'default': '%(id)s.%(ext)s'},
        'progress_hooks': [tracker.progress_hook],
        'quiet': True,
        'no_warnings': True,
        'user_agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    
    if not use_fallback:
        ydl_opts['concurrent_fragment_downloads'] = 4
        ydl_opts['extractor_args'] = {'youtube': {'player_client': ['android']}}
    
    if cookies_path:
        ydl_opts['cookiefile'] = cookies_path
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            
            if tracker.check_stall():
                raise Exception("DOWNLOAD_STALLED")
            
            video_id = info['id']
            ext = info.get('ext', 'm4a')
            downloaded_path = os.path.join(cache_dir, f"{video_id}.{ext}")
            
            if os.path.exists(downloaded_path):
                return downloaded_path
            
            for ext_try in ['m4a', 'webm', 'opus', 'mp4']:
                try_path = os.path.join(cache_dir, f"{video_id}.{ext_try}")
                if os.path.exists(try_path):
                    return try_path
            
            raise Exception(f"Downloaded file not found")
    
    except Exception as e:
        if 'DOWNLOAD_STALLED' in str(e):
            raise
        print(f"yt-dlp error: {e}", file=sys.stderr)
        raise

def download_with_pytube(url, cache_dir, video_id):
    try:
        from pytube import YouTube
        print("Trying pytube fallback...", file=sys.stderr)
        
        yt = YouTube(url)
        stream = yt.streams.filter(only_audio=True).first()
        
        if not stream:
            raise Exception("No audio stream found")
        
        output_path = stream.download(output_path=cache_dir, filename=f"{video_id}.mp4")
        return output_path
        
    except Exception as e:
        print(f"pytube error: {e}", file=sys.stderr)
        raise

def preprocess_audio(input_path, video_id, cache_dir):
    import subprocess
    
    output_path = os.path.join(cache_dir, f"{video_id}_preprocessed.wav")
    
    if os.path.exists(output_path):
        age_hours = (time.time() - os.path.getmtime(output_path)) / 3600
        if age_hours < 6:
            print(f"Using cached preprocessed audio: {output_path}", file=sys.stderr)
            return output_path
    
    print("Transcoding to 16kHz mono WAV with normalization...", file=sys.stderr)
    
    cmd = [
        'ffmpeg',
        '-i', input_path,
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,volume=5dB',
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        output_path
    ]
    
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=60)
        print(f"Preprocessed audio saved: {output_path}", file=sys.stderr)
        return output_path
    except subprocess.TimeoutExpired:
        raise Exception("FFmpeg transcoding timeout")
    except Exception as e:
        raise Exception(f"FFmpeg error: {e}")

def download_audio(video_id, url):
    if not check_ffmpeg():
        print("FFMPEG_NOT_FOUND", file=sys.stderr)
        sys.exit(1)
    
    cache_dir = get_cache_dir()
    print(f"Cache directory: {cache_dir}", file=sys.stderr)
    
    cached = check_cache(video_id, cache_dir)
    if cached:
        duration = get_duration(cached)
        if duration < 5:
            print(f"Cached audio too short: {duration}s, re-downloading", file=sys.stderr)
            os.remove(cached)
        else:
            print(f"Ready: {cached}", file=sys.stderr)
            return cached
    
    print(f"Downloading audio for {video_id}...", file=sys.stderr)
    
    tracker = ProgressTracker()
    
    def watchdog():
        while not tracker.stalled:
            time.sleep(5)
            if tracker.check_stall():
                print("DOWNLOAD_STALLED: No progress for 30 seconds", file=sys.stderr)
                break
    
    watchdog_thread = threading.Thread(target=watchdog, daemon=True)
    watchdog_thread.start()
    
    downloaded_path = None
    
    try:
        downloaded_path = download_with_ytdlp(url, cache_dir, tracker, use_fallback=False)
    except Exception as e:
        if 'DOWNLOAD_STALLED' in str(e):
            print("DOWNLOAD_STALLED", file=sys.stderr)
            sys.exit(1)
        
        print(f"First attempt failed, trying fallback mode...", file=sys.stderr)
        tracker = ProgressTracker()
        
        try:
            downloaded_path = download_with_ytdlp(url, cache_dir, tracker, use_fallback=True)
        except:
            print("yt-dlp fallback failed, trying pytube...", file=sys.stderr)
            try:
                downloaded_path = download_with_pytube(url, cache_dir, video_id)
            except:
                print("AUDIO_DOWNLOAD_FAILED", file=sys.stderr)
                sys.exit(1)
    
    if not downloaded_path or not os.path.exists(downloaded_path):
        print("AUDIO_DOWNLOAD_FAILED: File not found after download", file=sys.stderr)
        sys.exit(1)
    
    duration = get_duration(downloaded_path)
    print(f"Downloaded audio duration: {duration:.1f}s", file=sys.stderr)
    
    if duration < 5:
        print(f"Audio too short: {duration}s", file=sys.stderr)
        sys.exit(1)
    
    preprocessed = preprocess_audio(downloaded_path, video_id, cache_dir)
    
    final_duration = get_duration(preprocessed)
    if final_duration < 5:
        print(f"Preprocessed audio too short: {final_duration}s", file=sys.stderr)
        sys.exit(1)
    
    print(f"Ready: {preprocessed}", file=sys.stderr)
    return preprocessed

if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser()
    parser.add_argument('--videoId', required=True)
    parser.add_argument('--url', required=True)
    
    args = parser.parse_args()
    
    try:
        result_path = download_audio(args.videoId, args.url)
        print(result_path)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)