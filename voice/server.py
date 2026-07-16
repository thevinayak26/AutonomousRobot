#!/usr/bin/env python3
"""server.py — Flask front door for the dashboard's voice/text command box.

POST /transcribe : multipart audio  -> Groq Whisper -> voice_parser -> JSON
POST /parse       : {"text": "..."} -> voice_parser -> JSON
GET  /health      : liveness check

This file does NOT touch ROS and does NOT move the robot — it only
returns parsed command JSON. voice_command_relay.py is what actually
moves the robot, triggered by whatever the dashboard publishes to
/voice_command after receiving this response.
"""
import os
import sys
import tempfile

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from groq import Groq

from voice_parser import parse

load_dotenv()

STT_MODEL = os.environ.get("STT_MODEL", "whisper-large-v3-turbo")

app = Flask(__name__)
CORS(app)  # dashboard is served from a different origin/port than this server

_client = None


def _get_client():
    global _client
    if _client is None:
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            raise RuntimeError("GROQ_API_KEY not set (check your .env)")
        _client = Groq(api_key=key)
    return _client


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/transcribe")
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "no audio file in request"}), 400

    audio_file = request.files["audio"]
    suffix = os.path.splitext(audio_file.filename or "clip.webm")[1] or ".webm"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        client = _get_client()
        with open(tmp_path, "rb") as f:
            resp = client.audio.transcriptions.create(
                file=(os.path.basename(tmp_path), f.read()),
                model=STT_MODEL,
            )
        heard = " ".join(resp.text.split())
    except Exception as e:
        print(f"[transcribe] error: {e}", file=sys.stderr)
        return jsonify({"error": str(e)}), 500
    finally:
        os.unlink(tmp_path)

    cmd = parse(heard)
    return jsonify({"heard": heard, **cmd})


@app.post("/parse")
def parse_text():
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "no text in request"}), 400

    cmd = parse(text)
    return jsonify({"heard": text, **cmd})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5005)
