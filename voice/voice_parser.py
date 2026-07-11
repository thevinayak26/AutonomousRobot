#!/usr/bin/env python3
"""ATLAS voice-command parser (offline, rule-based, multilingual)."""
import json
import sys

COMMANDS = {
    "NAVIGATE": {
        "en": ["go", "move", "navigate", "head", "drive"],
        "hi": ["जा", "चलो", "चल", "पहुँच"],
        "hi_rom": ["jao", "jaao", "chalo", "chal"],
        "es": ["ir", "ve", "anda"],
        "ta": ["போ"],
    },
    "STOP": {
        "en": ["stop", "halt", "freeze"],
        "hi": ["रुको", "ठहरो"],
        "hi_rom": ["ruko", "ruk", "thahro"],
        "es": ["para", "detente", "alto"],
        "ta": ["நிறுத்து"],
    },
    "RETURN": {
        "en": ["return", "come back", "go back", "home"],
        "hi": ["वापस", "घर"],
        "hi_rom": ["wapas", "vapas", "ghar"],
        "es": ["vuelve", "regresa"],
        "ta": ["திரும்பு"],
    },
}

TARGETS = {
    "kitchen": ["kitchen", "रसोई", "rasoi", "ra so i", "cocina", "சமையலறை"],
    "lab":     ["lab", "laboratory", "प्रयोगशाला", "prayogshala", "laboratorio"],
    "door":    ["door", "दरवाजा", "darwaza", "darvaza", "puerta", "கதவு"],
    "charger": ["charger", "charging", "चार्जर", "cargador"],
}

TARGETLESS = {"STOP", "RETURN"}


def _norm(s):
    # collapse whitespace so "ra so i" and "rasoi" both have a chance
    return " ".join(s.split())


def _matches(text_low, text_raw, phrases):
    text_low_ns = text_low.replace(" ", "")
    for p in phrases:
        target = text_low if p.isascii() else text_raw
        if p.isascii():
            # try normal substring, and space-stripped (handles "ra so i")
            if p.lower() in text_low or p.replace(" ", "") in text_low_ns:
                return True
        else:
            if p in text_raw:
                return True
    return False


def parse(transcript):
    if not transcript:
        return None
    raw = _norm(transcript.strip())
    low = raw.lower()
    command = None
    for cmd, langs in COMMANDS.items():
        for phrases in langs.values():
            if _matches(low, raw, phrases):
                command = cmd
                break
        if command:
            break
    if command is None:
        return None
    if command in TARGETLESS:
        return {"command": command, "target": None}
    target = None
    for tgt, phrases in TARGETS.items():
        if _matches(low, raw, phrases):
            target = tgt
            break
    if target is None:
        return None
    return {"command": command, "target": target}


_TESTS = [
    ("go to the kitchen", {"command": "NAVIGATE", "target": "kitchen"}),
    ("रसोई में जाओ", {"command": "NAVIGATE", "target": "kitchen"}),
    ("Ra so i me jao", {"command": "NAVIGATE", "target": "kitchen"}),
    ("rasoi me jao", {"command": "NAVIGATE", "target": "kitchen"}),
    ("ve a la cocina", {"command": "NAVIGATE", "target": "kitchen"}),
    ("navigate to the lab", {"command": "NAVIGATE", "target": "lab"}),
    ("stop", {"command": "STOP", "target": None}),
    ("रुको", {"command": "STOP", "target": None}),
    ("ruko", {"command": "STOP", "target": None}),
    ("come back home", {"command": "RETURN", "target": None}),
    ("go", None),
    ("what time is it", None),
    ("", None),
]


def _run_selftest():
    passed = 0
    for text, expected in _TESTS:
        got = parse(text)
        ok = got == expected
        passed += ok
        print(f"[{'PASS' if ok else 'FAIL'}] {text!r:40} -> {got}")
    print(f"\n{passed}/{len(_TESTS)} tests passed")
    return passed == len(_TESTS)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(json.dumps(parse(" ".join(sys.argv[1:])), ensure_ascii=False))
    else:
        _run_selftest()
