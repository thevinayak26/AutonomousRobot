#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# sys_stats_node.py - publishes the robot's CPU / memory / uptime as JSON on
# /sys_stats, which is what the dashboard's System Health tile reads for the CPU
# bar (src/ros/useRobotData.js expects keys: cpu, mem, uptime_s).
#
# RUN THIS ON THE ROBOT (the Pi) so it reports the Pi's load - the dashboard runs
# elsewhere and only subscribes. It is a standalone helper: it does NOT touch any
# existing robot file. Dependency-free (no psutil needed) - it reads /proc.
#
# Add to the robot's startup AFTER ROS is sourced, e.g. in start_robot.sh:
#     python3 ~/AutonomousRobot/dashboard/tools/sys_stats_node.py &
# (adjust the path to wherever this file lives on the Pi).
# -----------------------------------------------------------------------------
import json
import time

import rclpy
from rclpy.node import Node
from std_msgs.msg import String


def _read_cpu_times():
    """Aggregate CPU jiffies from /proc/stat -> (idle, total)."""
    with open("/proc/stat", "r") as f:
        parts = f.readline().split()
    vals = [int(v) for v in parts[1:]]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
    return idle, sum(vals)


def _mem_percent():
    """Used-memory percentage from /proc/meminfo."""
    info = {}
    with open("/proc/meminfo", "r") as f:
        for line in f:
            k, _, rest = line.partition(":")
            info[k] = int(rest.split()[0])  # kB
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    if not total:
        return None
    return round((total - avail) / total * 100.0, 1)


class SysStats(Node):
    def __init__(self):
        super().__init__("sys_stats_node")
        self.pub = self.create_publisher(String, "/sys_stats", 10)
        self.start = time.monotonic()
        self.prev_idle, self.prev_total = _read_cpu_times()
        self.create_timer(1.0, self.tick)
        self.get_logger().info("sys_stats_node up - publishing CPU/mem/uptime on /sys_stats (1 Hz)")

    def tick(self):
        idle, total = _read_cpu_times()
        d_idle = idle - self.prev_idle
        d_total = total - self.prev_total
        self.prev_idle, self.prev_total = idle, total
        cpu = round((1.0 - d_idle / d_total) * 100.0, 1) if d_total > 0 else 0.0
        payload = {
            "cpu": cpu,
            "mem": _mem_percent(),
            "uptime_s": int(time.monotonic() - self.start),
            "source": "sys_stats_node",
        }
        self.pub.publish(String(data=json.dumps(payload)))


def main():
    rclpy.init()
    node = SysStats()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
