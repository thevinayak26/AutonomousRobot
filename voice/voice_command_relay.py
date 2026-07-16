#!/usr/bin/env python3
"""voice_command_relay.py — subscribes to /voice_command (std_msgs/String,
JSON) and executes MOVE/TURN/STOP/CANCEL via motion_executor.

Kept separate from atlas_voice_bridge.py on purpose: that node still owns
the old NAVIGATE/target -> Nav2 schema. This one owns the new
relative-motion schema. Don't run both against live dashboard traffic at
once unless you want both reacting to the same message.

⚠️ This node moves the robot.
"""
import json

import rclpy
from rclpy.node import Node
from std_msgs.msg import String

from motion_executor import execute, _shutdown


class VoiceCommandRelay(Node):
    def __init__(self):
        super().__init__("voice_command_relay")
        self.create_subscription(String, "/voice_command", self.on_cmd, 10)
        self.get_logger().info("voice_command_relay up, listening on /voice_command")

    def on_cmd(self, msg):
        try:
            cmd = json.loads(msg.data)
        except json.JSONDecodeError:
            self.get_logger().warn(f"bad JSON on /voice_command: {msg.data!r}")
            return
        self.get_logger().info(f"executing: {cmd}")
        execute(cmd)


def main():
    rclpy.init()
    node = VoiceCommandRelay()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        _shutdown()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
