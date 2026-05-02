import modal
import os
import tempfile
import subprocess
import base64
import json

app = modal.App("viral-analyzer")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .run_commands("pip install yt-dlp")
    .pip_install(
        "faster-whisper==1.0.3",
        "pillow",
        "fastapi",
        "pydantic"
    )
)

@app.function(
    image=image,
    gpu="T4",
    timeout=300,
    memory=4096,
)
@modal.fastapi_endpoint(method="POST")
def analyze_video(item: dict) -> dict:
    from faster_whisper import WhisperModel
    from pydantic import BaseModel

    video_url = item.get("video_url", "")
    if not video_url:
        return {"error": "No video_url provided", "duration": 0, "full_transcript": "", "transcript_segments": [], "key_frames": [], "total_frames": 0}

    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = os.path.join(tmpdir, "video.mp4")
        frames_dir = os.path.join(tmpdir, "frames")
        audio_path = os.path.join(tmpdir, "audio.wav")
        os.makedirs(frames_dir, exist_ok=True)

        # 1. Download video
        result = subprocess.run([
            "yt-dlp", "-f", "best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", video_path,
            "--no-playlist", "--max-filesize", "50m",
            video_url
        ], capture_output=True, text=True, timeout=120)

        if not os.path.exists(video_path):
            return {
                "error": f"Download failed: {result.stderr[:300]}",
                "duration": 0, "language": "es",
                "full_transcript": "", "transcript_segments": [],
                "key_frames": [], "total_frames": 0
            }

        # 2. Get duration
        probe = subprocess.run([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", video_path
        ], capture_output=True, text=True)
        try:
            duration = float(json.loads(probe.stdout).get("format", {}).get("duration", 60))
        except:
            duration = 60.0

        # 3. Extract frames 1fps
        max_frames = min(int(duration), 60)
        subprocess.run([
            "ffmpeg", "-i", video_path,
            "-vf", "fps=1,scale=640:-1",
            "-frames:v", str(max_frames),
            os.path.join(frames_dir, "frame_%04d.jpg"),
            "-y", "-loglevel", "error"
        ], timeout=60)

        # 4. Extract audio
        subprocess.run([
            "ffmpeg", "-i", video_path,
            "-ar", "16000", "-ac", "1", "-vn",
            audio_path, "-y", "-loglevel", "error"
        ], timeout=60)

        # 5. Transcribe with Whisper
        model = WhisperModel("base", device="cuda", compute_type="float16")
        segments, info = model.transcribe(audio_path, beam_size=5, word_timestamps=True)

        transcript_segments = []
        full_text = ""
        for seg in segments:
            transcript_segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip()
            })
            full_text += seg.text + " "

        # 6. Key frames: hook + middle + cta
        frame_files = sorted(os.listdir(frames_dir))
        total = len(frame_files)
        key_indices = sorted(set([
            0, 1, 2,
            total // 2,
            max(0, total - 3),
            max(0, total - 2),
            max(0, total - 1)
        ]))

        key_frames = []
        for idx in key_indices:
            if 0 <= idx < total:
                with open(os.path.join(frames_dir, frame_files[idx]), "rb") as f:
                    key_frames.append({
                        "second": idx,
                        "b64": base64.b64encode(f.read()).decode(),
                        "section": "hook" if idx < 3 else ("cta" if idx >= total - 3 else "middle")
                    })

        return {
            "duration": round(duration),
            "language": info.language,
            "full_transcript": full_text.strip(),
            "transcript_segments": transcript_segments,
            "key_frames": key_frames,
            "total_frames": total
        }
