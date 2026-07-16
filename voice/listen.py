#!/usr/bin/env python3
"""ATLAS voice listener — push-to-talk, Groq-hosted Whisper + LLM parser.
Record -> Groq Whisper -> voice_parser -> motion_executor (print only).
No ROS. Robot is NOT moved by this file."""
import argparse
import json
import os
import subprocess
import sys
import tempfile

from dotenv import load_dotenv
from groq import Groq

from voice_parser import parse
from motion_executor import execute

load_dotenv()

STT_MODEL = os.environ.get("STT_MODEL", "whisper-large-v3-turbo")

_client = None


def _get_client():
    global _client
    if _client is None:
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            raise RuntimeError("GROQ_API_KEY not set (check your .env)")
        _client = Groq(api_key=key)
    return _client


def record(path, secs):
    subprocess.run(["sox", "-d", path, "trim", "0", str(secs)], check=True)


def transcribe(wav_path, lang):
    client = _get_client()
    with open(wav_path, "rb") as f:
        resp = client.audio.transcriptions.create(
            file=(os.path.basename(wav_path), f.read()),
            model=STT_MODEL,
            language=lang,
        )
    return " ".join(resp.text.split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en")
    ap.add_argument("--secs", type=int, default=3)
    ap.add_argument("--wav", default=None, help="use an existing wav instead of recording")
    a = ap.parse_args()

    if a.wav:
        wav = a.wav
    else:
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        print(f"recording {a.secs}s, speak now...", file=sys.stderr)
        record(wav, a.secs)

    text = transcribe(wav, a.lang)
    print(f"heard: {text}", file=sys.stderr)

    cmd = parse(text)
    print(json.dumps(cmd, ensure_ascii=False))
    execute(cmd)
    return 0 if cmd.get("command") else 1


if __name__ == "__main__":
    sys.exit(main())
