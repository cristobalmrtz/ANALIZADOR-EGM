import modal
import os
import tempfile
import subprocess
import base64
import json
from pathlib import Path

app = modal.App("viral-analyzer")

# Image with all dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "yt-dlp")
    .pip_install(
        "faster-whisper==1.0.3",
        "yt-dlp",
        "pillow",
        "requests"
    )
)

@app.function(
    image=image,
    gpu="T4",
    timeout=300,
    memory=4096,
)
def analyze_video(video_url: str) -> dict:
    """
    Download video, extract frames with ffmpeg, transcribe with Whisper.
    Returns frames (base64) + full transcription with timestamps.
    """
    import whisper
    from faster_whisper import WhisperModel
    from PIL import Image
    import io

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "video.mp4")
        frames_dir = os.path.join(tmpdir, "frames")
        audio_path = os.path.join(tmpdir, "audio.wav")
        os.makedirs(frames_dir, exist_ok=True)

        # 1. Download video with yt-dlp
        result = subprocess.run([
            "yt-dlp",
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", video_path,
            "--no-playlist",
            "--max-filesize", "50m",
            video_url
        ], capture_output=True, text=True, timeout=120)

        if not os.path.exists(video_path):
            raise Exception(f"Failed to download video: {result.stderr[:500]}")

        # 2. Get video duration
        probe = subprocess.run([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", video_path
        ], capture_output=True, text=True)
        probe_data = json.loads(probe.stdout)
        duration = float(probe_data.get("format", {}).get("duration", 60))

        # 3. Extract frames - 1 per second, max 60 frames
        frame_rate = 1
        max_frames = min(int(duration), 60)
        subprocess.run([
            "ffmpeg", "-i", video_path,
            "-vf", f"fps={frame_rate},scale=640:-1",
            "-frames:v", str(max_frames),
            os.path.join(frames_dir, "frame_%04d.jpg"),
            "-y", "-loglevel", "error"
        ], check=True, timeout=60)

        # 4. Extract audio for Whisper
        subprocess.run([
            "ffmpeg", "-i", video_path,
            "-ar", "16000", "-ac", "1", "-vn",
            audio_path, "-y", "-loglevel", "error"
        ], check=True, timeout=60)

        # 5. Transcribe with faster-whisper
        model = WhisperModel("base", device="cuda", compute_type="float16")
        segments, info = model.transcribe(
            audio_path,
            beam_size=5,
            language=None,  # auto-detect
            word_timestamps=True
        )

        transcript_segments = []
        full_text = ""
        for seg in segments:
            transcript_segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip()
            })
            full_text += seg.text + " "

        # 6. Encode key frames as base64 (first 3s, middle, last 3s)
        frame_files = sorted(os.listdir(frames_dir))
        key_indices = []
        # First 3 seconds (hook)
        key_indices.extend([0, 1, 2])
        # Middle
        mid = len(frame_files) // 2
        key_indices.extend([mid-1, mid, mid+1])
        # Last 3 seconds
        key_indices.extend([len(frame_files)-3, len(frame_files)-2, len(frame_files)-1])

        key_frames = []
        for idx in sorted(set(key_indices)):
            if 0 <= idx < len(frame_files):
                frame_path = os.path.join(frames_dir, frame_files[idx])
                with open(frame_path, "rb") as f:
                    frame_b64 = base64.b64encode(f.read()).decode()
                key_frames.append({
                    "second": idx,
                    "b64": frame_b64,
                    "section": "hook" if idx < 3 else ("middle" if idx < len(frame_files) - 3 else "cta")
                })

        return {
            "duration": round(duration),
            "language": info.language,
            "full_transcript": full_text.strip(),
            "transcript_segments": transcript_segments,
            "key_frames": key_frames,
            "total_frames": len(frame_files)
        }


@app.local_entrypoint()
def main(url: str = "https://www.tiktok.com/@test"):
    result = analyze_video.remote(url)
    print(f"Duration: {result['duration']}s")
    print(f"Language: {result['language']}")
    print(f"Transcript: {result['full_transcript'][:200]}")
    print(f"Frames extracted: {result['total_frames']}")
