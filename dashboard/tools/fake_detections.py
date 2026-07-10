#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# fake_detections.py - DASHBOARD TEST TOOL (laptop). Publishes /detected_objects in
# the exact schema atlas_fusion_node.py emits, so the semantic panel (Task 3) and the
# map icons (Task 3B) can be exercised WITHOUT the robot/YOLO. It demonstrates every
# icon type and both decay behaviours:
#
#   PERSISTENT furniture (stay solid, long TTL) - one of each glyph/colour:
#     chair          (sky/furniture, chair glyph)
#     couch          (sky/furniture, couch glyph)
#     dining table   (sky/furniture, table glyph)
#     backpack       (gold/other,    generic box glyph, default 20 s TTL)
#
#   CYCLING living things (appear, then fade out on their TTL, then reappear):
#     person  (coral/living, person glyph, TTL 3 s)  - visible first half of a 12 s cycle
#     dog     (coral/living, pet glyph,    TTL 3 s)  - visible first half of a 16 s cycle
#
# So while it runs you should see: 4 furniture icons parked and solid; a person and a
# dog blinking in and out and fading over ~3 s each time they leave, exactly the
# survival-probability fade opacity = exp(-lambda_c * age). Matches lib/semantic.js.
#
# Run:  source /opt/ros/jazzy/setup.bash && python3 tools/fake_detections.py
# -----------------------------------------------------------------------------
import json
import math
import time

import rclpy
from rclpy.node import Node
from std_msgs.msg import String

RATE_HZ = 5.0

# Persistent objects: (class, confidence, x, y). Always published.
FURNITURE = [
    ("chair", 0.86, 1.2, 0.6),
    ("couch", 0.79, -1.6, 1.2),
    ("dining table", 0.71, -1.8, -0.9),
    ("backpack", 0.64, 2.2, 1.5),
]
# Cycling objects: (class, confidence, x, y, period_s). Visible in the first half.
CYCLING = [
    ("person", 0.83, 2.0, -0.5, 12.0),
    ("dog", 0.68, -0.4, -1.6, 16.0),
]


class FakeDetections(Node):
    def __init__(self):
        super().__init__("fake_detections")
        self.pub = self.create_publisher(String, "/detected_objects", 10)
        self.t0 = time.time()
        self.create_timer(1.0 / RATE_HZ, self.tick)
        self.get_logger().info(
            "fake_detections up: chair/couch/dining table/backpack persistent; "
            "person + dog cycle in and out (watch them fade ~3 s after leaving)")

    def tick(self):
        now = time.time()
        t = now - self.t0
        dets = [self._det(cls, conf, x, y) for (cls, conf, x, y) in FURNITURE]
        for (cls, conf, x, y, period) in CYCLING:
            if (t % period) < (period / 2.0):
                wob = 0.12 * math.sin(t * 1.6)   # a little drift so it looks alive
                dets.append(self._det(cls, conf, x + wob, y + wob))
        msg = String()
        msg.data = json.dumps({
            "stamp_wall": now,
            "proc_ms": 11.0,
            "detections": dets,
        })
        self.pub.publish(msg)

    def _det(self, cls, conf, x, y):
        return {
            "cls": cls, "conf": conf,
            "x": round(x, 3), "y": round(y, 3),
            "range_m": round(math.hypot(x, y), 3),
            "bearing_deg": round(math.degrees(math.atan2(y, x)), 2),
            "t_wall": time.time(),
        }


def main():
    rclpy.init()
    node = FakeDetections()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
