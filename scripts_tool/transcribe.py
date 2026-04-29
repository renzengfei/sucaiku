#!/usr/bin/env python3
"""本地视频 → Whisper 字幕转写
用法: transcribe.py <video_path> [model_name]
    model_name: large-v3 (默认) / large-v3-turbo / medium / small
环境变量:
    WHISPER_PROMPT  可选，专有名词/关键词（空格分隔），通过 faster-whisper 的 hotwords 偏向识别，不影响分段
    WHISPER_LANG    可选，强制语言（如 "en"），留空则自动检测
输出到 stdout（JSON）：{"language": str, "duration": float, "segments": [{"start": float, "end": float, "text": str}]}
"""
import os
import sys
import json
import time
from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe.py <video_path> [model_name]"}), file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) >= 3 else "large-v3"
    hotwords = os.environ.get("WHISPER_PROMPT", "") or None
    language = os.environ.get("WHISPER_LANG") or None
    t0 = time.time()

    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    segments_iter, info = model.transcribe(
        video_path,
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=400),
        hotwords=hotwords,
        no_speech_threshold=0.3,
        condition_on_previous_text=False,
    )

    segments = []
    for s in segments_iter:
        segments.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()})

    elapsed = round(time.time() - t0, 2)
    print(json.dumps({
        "model": model_name,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "elapsed_seconds": elapsed,
        "hotwords": hotwords or "",
        "segments": segments,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
