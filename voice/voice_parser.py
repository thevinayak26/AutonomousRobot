#!/usr/bin/env python3
"""ATLAS voice-command parser — Groq LLM, relative-motion schema.
Converts a transcript into MOVE / TURN / STOP / CANCEL / null JSON.
No ROS. No named locations. No map."""
import json
import os
import sys

from dotenv import load_dotenv
from groq import Groq

load_dotenv()

MODEL = os.environ.get("PARSER_MODEL", "llama-3.3-70b-versatile")

_client = None


def _get_client():
    global _client
    if _client is None:
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            raise RuntimeError("GROQ_API_KEY not set (check your .env)")
        _client = Groq(api_key=key)
    return _client


SYSTEM_PROMPT = """You convert a single spoken command transcript into JSON for a mobile robot.
Only output raw JSON, nothing else. Use exactly one of these shapes:

{"command":"MOVE","direction":"FORWARD","distance":3.0}
{"command":"MOVE","direction":"BACKWARD","distance":1.5}
{"command":"TURN","direction":"LEFT","angle":90}
{"command":"TURN","direction":"RIGHT","angle":45}
{"command":"STOP"}
{"command":"CANCEL"}
{"command":null}

Rules:
- direction for MOVE is always FORWARD or BACKWARD.
- direction for TURN is always LEFT or RIGHT.
- distance is in meters (a number). angle is in degrees (a number).
- Never invent a destination, room, or location name. This robot has no map.
  If the transcript names a place ("go to the kitchen"), output {"command":null}.
- If the transcript doesn't clearly match MOVE, TURN, STOP, or CANCEL, output {"command":null}.
- Output JSON only. No explanation, no markdown fences.
"""

_MOVE_DIRS = {"FORWARD", "BACKWARD"}
_TURN_DIRS = {"LEFT", "RIGHT"}


def _validate(obj):
    if not isinstance(obj, dict):
        return None
    cmd = obj.get("command")
    if cmd is None:
        return {"command": None}
    if cmd in ("STOP", "CANCEL"):
        return {"command": cmd}
    if cmd == "MOVE":
        d = obj.get("direction")
        if d not in _MOVE_DIRS:
            return None
        try:
            dist = float(obj.get("distance"))
        except (TypeError, ValueError):
            return None
        return {"command": "MOVE", "direction": d, "distance": dist}
    if cmd == "TURN":
        d = obj.get("direction")
        if d not in _TURN_DIRS:
            return None
        try:
            ang = float(obj.get("angle"))
        except (TypeError, ValueError):
            return None
        return {"command": "TURN", "direction": d, "angle": ang}
    return None


def parse(transcript):
    """transcript (str) -> normalized command dict. Never raises on bad input."""
    if not transcript or not transcript.strip():
        return {"command": None}

    client = _get_client()
    resp = client.chat.completions.create(
        model=MODEL,
        temperature=0,
        max_tokens=100,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": transcript.strip()},
        ],
    )
    raw = resp.choices[0].message.content
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return {"command": None}

    result = _validate(obj)
    return result if result is not None else {"command": None}


_TESTS = [
    "move forward 3 meters",
    "go backward 1.5 meters",
    "turn left 90 degrees",
    "turn right 45",
    "stop",
    "cancel",
    "go to the kitchen",
    "what time is it",
]

if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(json.dumps(parse(" ".join(sys.argv[1:])), ensure_ascii=False))
    else:
        for t in _TESTS:
            print(f"{t!r:35} -> {parse(t)}")
