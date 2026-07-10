#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# goal_probe.py - DASHBOARD TEST TOOL (laptop). The receiving end of the
# click-to-goal acceptance tests: subscribes /goal_pose and /cmd_vel and appends
# one JSON line per message to /tmp/goal_probe.jsonl, so verify_goal_link.mjs
# can assert (a) exactly the confirmed goals were published, with frame_id "map"
# and identity orientation, and (b) the idle dashboard publishes NOTHING on
# /cmd_vel (the zero-Twist keepalive regression guard).
#
# Run:  source /opt/ros/jazzy/setup.bash && python3 tools/goal_probe.py
# -----------------------------------------------------------------------------
import json
import time

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import PoseStamped, Twist

OUT = "/tmp/goal_probe.jsonl"


class GoalProbe(Node):
    def __init__(self):
        super().__init__("goal_probe")
        self.create_subscription(PoseStamped, "/goal_pose", self.on_goal, 10)
        self.create_subscription(Twist, "/cmd_vel", self.on_twist, 10)
        self.get_logger().info(f"goal_probe up - logging to {OUT}")

    def log(self, obj):
        obj["t_wall"] = time.time()
        with open(OUT, "a") as f:
            f.write(json.dumps(obj) + "\n")

    def on_goal(self, m):
        self.log({
            "topic": "goal_pose",
            "frame": m.header.frame_id,
            "x": m.pose.position.x, "y": m.pose.position.y, "z": m.pose.position.z,
            "qx": m.pose.orientation.x, "qy": m.pose.orientation.y,
            "qz": m.pose.orientation.z, "qw": m.pose.orientation.w,
        })

    def on_twist(self, m):
        self.log({"topic": "cmd_vel", "lx": m.linear.x, "az": m.angular.z})


def main():
    rclpy.init()
    rclpy.spin(GoalProbe())


if __name__ == "__main__":
    main()
