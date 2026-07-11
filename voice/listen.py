#!/usr/bin/env python3
"""ATLAS voice listener (push-to-talk, offline). Stage 2.
Record -> whisper.cpp -> parse -> command JSON on stdout. No ROS."""
import argparse, json, os, subprocess, sys, tempfile
from voice_parser import parse

DEF_BIN = os.environ.get("WHISPER_BIN", "./build/bin/whisper-cli")
DEF_MODEL = os.environ.get("WHISPER_MODEL", "./models/ggml-small.bin")

def record(path, secs):
    subprocess.run(["sox", "-d", path, "trim", "0", str(secs)], check=True)

def transcribe(wav, model, lang, wbin):
    out = subprocess.run([wbin, "-m", model, "-f", wav, "-l", lang, "-nt"],
                         capture_output=True, text=True)
    return " ".join(out.stdout.split())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="en")
    ap.add_argument("--model", default=DEF_MODEL)
    ap.add_argument("--bin", default=DEF_BIN)
    ap.add_argument("--secs", type=int, default=3)
    ap.add_argument("--wav", default=None)
    a = ap.parse_args()
    if a.wav:
        wav = a.wav
    else:
        fd, wav = tempfile.mkstemp(suffix=".wav"); os.close(fd)
        print(f"recording {a.secs}s, speak now...", file=sys.stderr)
        record(wav, a.secs)
    text = transcribe(wav, a.model, a.lang, a.bin)
    print(f"heard: {text}", file=sys.stderr)
    cmd = parse(text)
    print(json.dumps(cmd, ensure_ascii=False))
    return 0 if cmd else 1

if __name__ == "__main__":
    sys.exit(main())
