# ATLAS Voice: Offline Multilingual Command System

Mic -> whisper.cpp -> transcript -> voice_parser.py -> command JSON -> (ROS bridge) -> Nav2

## Status (2026-07-11)
- Stage 1 parser: DONE, self-tests pass. EN/HI/ES/TA verbs; STOP/RETURN targetless.
- Stage 2 listener: push-to-talk driver, validated live (small model, -l hi).
- Stage 3 ROS publishing: NOT STARTED. Robot-side. Needs locations.yaml + roslibpy node on /goal_pose.

## Known limitations (read before demoing)
1. One language per run. -l hi mis-hears English and vice versa. Need a per-utterance toggle or auto-detect test.
2. Use the small model for Hindi; base romanizes and is unreliable.
3. Whisper mangles single short words; Hindi verbs are stem-matched. Prefer two-word commands.
4. New whisper mis-spelling = add a synonym to the dict, no code change.

## Use
    python3 voice_parser.py "go to the kitchen"     # typed text
    python3 voice_parser.py                          # self-tests
    python3 listen.py --lang hi --model ./models/ggml-small.bin --secs 4
    python3 listen.py --wav command.wav --lang hi

Output: {"command": "NAVIGATE", "target": "kitchen"}  (null = do nothing)

## Stage 3 (on the robot)
- Copy locations.example.yaml -> locations.yaml, capture poses from RViz (map frame).
- roslibpy node reads JSON, publishes PoseStamped on /goal_pose.
- Notify Sampoorn before publishing into the nav stack (standing rule).
- Run whisper on the laptop, not the Pi (split-compute, like YOLO).
