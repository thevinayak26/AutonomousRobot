#!/usr/bin/env python3
"""motion_executor.py — publishes MOVE/TURN/STOP/CANCEL as timed Twist
commands on /cmd_vel_nav. Open-loop (timed), no odometry feedback.

⚠️ THIS FILE MOVES THE ROBOT.
Speeds are capped well under velocity_smoother's limits
(max_velocity: [0.45, 0.0, 0.8] in nav2_params.yaml).

Publishes ONLY to /cmd_vel_nav — same as Nav2 would — so
velocity_smoother and collision_monitor still run downstream exactly
as before. Never publish directly to /cmd_vel or /cmd_vel_smoothed;
that would bypass the existing safety pipeline.
"""
import json
import math
import os
import sys
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist

# Tunable via env, both well under the smoother's hard caps (0.45 / 0.8)
LINEAR_SPEED = float(os.environ.get("MOVE_LINEAR_SPEED", 0.2))     # m/s
ANGULAR_SPEED = float(os.environ.get("TURN_ANGULAR_SPEED", 0.3))   # rad/s
# Flip to -1 if LEFT/RIGHT come out reversed on the real robot
ANGULAR_SIGN = float(os.environ.get("ANGULAR_SIGN", 1.0))
RATE_HZ = 20.0  # matches controller_frequency in nav2_params.yaml


class MotionExecutor(Node):
    def __init__(self):
        super().__init__("atlas_motion_executor")
        self.pub = self.create_publisher(Twist, "/cmd_vel_nav", 10)
        self._wait_for_subscriber(timeout=2.0)

    def _wait_for_subscriber(self, timeout):
        """ROS2 discovery isn't instant — publishing before velocity_smoother
        has discovered us silently drops messages. Wait until it's listening,
        or until timeout, whichever comes first."""
        start = time.time()
        while self.pub.get_subscription_count() == 0 and time.time() - start < timeout:
            time.sleep(0.05)
        if self.pub.get_subscription_count() == 0:
            print("[WARN] no subscriber found on /cmd_vel_nav after "
                  f"{timeout}s — is velocity_smoother running?", file=sys.stderr)

    def _publish_for(self, linear_x, angular_z, duration):
        period = 1.0 / RATE_HZ
        duration = max(duration, 0.3)  # floor so very short turns still get enough packets through
        end = time.time() + duration
        msg = Twist()
        msg.linear.x = linear_x
        msg.angular.z = angular_z
        while time.time() < end:
            self.pub.publish(msg)
            time.sleep(period)
        self._stop()

    def _stop(self):
        self.pub.publish(Twist())  # all zeros

    def run(self, cmd):
        if not isinstance(cmd, dict) or cmd.get("command") is None:
            print("[IGNORED] no valid command", file=sys.stderr)
            return

        c = cmd["command"]
        if c == "MOVE":
            direction = cmd["direction"]
            distance = cmd["distance"]
            sign = 1.0 if direction == "FORWARD" else -1.0
            duration = abs(distance) / LINEAR_SPEED
            print(f"MOVING: {direction} {distance}m (~{duration:.1f}s @ {LINEAR_SPEED} m/s)")
            self._publish_for(sign * LINEAR_SPEED, 0.0, duration)
            print("[DONE] stopped")
        elif c == "TURN":
            direction = cmd["direction"]
            angle_deg = cmd["angle"]
            angle_rad = math.radians(abs(angle_deg))
            sign = (1.0 if direction == "LEFT" else -1.0) * ANGULAR_SIGN
            duration = angle_rad / ANGULAR_SPEED
            print(f"TURNING: {direction} {angle_deg} deg (~{duration:.1f}s @ {math.degrees(ANGULAR_SPEED):.0f} deg/s)")
            self._publish_for(0.0, sign * ANGULAR_SPEED, duration)
            print("[DONE] stopped")
        elif c == "STOP":
            print("[STOP] zeroing velocity")
            self._stop()
        elif c == "CANCEL":
            print("[CANCEL] zeroing velocity")
            self._stop()
        else:
            print(f"[UNKNOWN] {cmd}", file=sys.stderr)


_node = None


def execute(cmd):
    """Entry point used by listen.py and voice_command_relay.py."""
    global _node
    if _node is None:
        if not rclpy.ok():
            rclpy.init()
        _node = MotionExecutor()
    _node.run(cmd)


def _shutdown():
    global _node
    if _node is not None:
        _node.destroy_node()
        rclpy.shutdown()
        _node = None


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cmd = json.loads(sys.argv[1])
    else:
        cmd = json.loads(sys.stdin.read())
    execute(cmd)
    _shutdown()
