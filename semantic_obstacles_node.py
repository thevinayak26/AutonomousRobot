#!/usr/bin/env python3
"""
ATLAS semantic obstacles node. Runs on the PI.
Subscribes /detected_objects (JSON from laptop fusion node), maintains a
local object store with CLASS-CONDITIONED staleness decay (the paper
mechanism), publishes /semantic_obstacles as PointCloud2 discs in the map
frame for Nav2's obstacle layer to consume.

Key behavior: when the WiFi perception link dies, this node keeps running
on the Pi and decays its store gracefully. Person marks vanish fast
(people move), furniture marks persist longer. That decay IS the
"graceful degradation" the paper measures.

Run [PI]:
    source /opt/ros/jazzy/setup.bash
    python3 ~/semantic_obstacles_node.py

Nav2 wiring: add /semantic_obstacles as an observation source in the
obstacle layer of local and global costmaps (see instructions in the
master doc, requires pasting current nav2 params first).
"""

import json
import math
import time

import rclpy
from rclpy.node import Node

from std_msgs.msg import String, Float32
from sensor_msgs.msg import PointCloud2
from sensor_msgs_py import point_cloud2 as pc2
from std_msgs.msg import Header

# ---------------- tunables (paper parameters) ----------------
# Class-conditioned time-to-live in seconds. Detection older than its
# TTL is dropped from the costmap. This is the staleness-decay v1
# (hard TTL). v2 (exponential radius shrink) can replace it later.
CLASS_TTL = {
    "person": 3.0,        # people move: forget fast
    "dog": 3.0,
    "cat": 3.0,
    "chair": 45.0,        # furniture: persist
    "couch": 60.0,
    "bed": 60.0,
    "dining table": 60.0,
    "tv": 60.0,
}
DEFAULT_TTL = 20.0

# Disc radius per class in metres (the semantic inflation)
CLASS_RADIUS = {
    "person": 0.40,       # bigger buffer around humans
    "dog": 0.35,
    "cat": 0.30,
}
DEFAULT_RADIUS = 0.22

MERGE_DIST = 0.35         # detections closer than this update one object
PUBLISH_HZ = 5.0
POINT_Z = 0.05            # keep within costmap obstacle height band
LINK_STALE_S = 2.0        # warn when no detections arrive for this long
# SFI (Scene Freshness Index): weighted-sum survival over the store.
# lambda_c = ln(1/P_MIN)/TTL_c, byte-for-byte the dashboard convention
# (lib/semantic.js). Uniform weights v1. Empty store: 1.0 if link fresh,
# 0.0 if last detection older than LINK_DEAD_S.
P_MIN = 0.05
LINK_DEAD_S = 10.0
SFI_HZ = 1.0
# Four-branch departure detector + censored-MLE learner (paper mechanism).
# Censoring signal is LINK STATE only in v1 (no frustum check).
DEPART_GAP_S = 2.0      # link up, no re-detection this long -> departure-candidate
DEPART_CONFIRM_S = 6.0  # candidate this long -> confirmed-departed (event)
PRIOR_T = 30.0          # prior pseudo-exposure seconds (seeds lambda at TTL prior)
REMATCH_DIST = 1.0       # same-class fresh track within this = flicker re-track, not departure
# --------------------------------------------------------------


def disc_points(cx, cy, radius):
    """Filled disc of points around (cx, cy), ~7 cm spacing."""
    pts = [(cx, cy, POINT_Z)]
    step = 0.07
    r = step
    while r <= radius + 1e-6:
        n = max(6, int(2 * math.pi * r / step))
        for k in range(n):
            a = 2 * math.pi * k / n
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), POINT_Z))
        r += step
    return pts


class SemanticObstacles(Node):
    def __init__(self):
        super().__init__("semantic_obstacles")
        self.store = []   # list of dicts: cls, x, y, conf, t_last, censored_T
        self.last_rx = 0.0
        self.link_warned = False
        self.link_down_at = None
        self.stats = {}   # cls -> {"D": events, "T": exposure seconds}

        self.create_subscription(String, "/detected_objects", self.on_det, 10)
        self.pub = self.create_publisher(PointCloud2, "/semantic_obstacles", 5)
        self.sfi_pub = self.create_publisher(Float32, "/sfi", 5)
        self.create_timer(1.0 / PUBLISH_HZ, self.tick)
        self.create_timer(1.0 / SFI_HZ, self.publish_sfi)
        self.get_logger().info(
            "semantic_obstacles up: class-conditioned TTL decay, "
            f"publish {PUBLISH_HZ} Hz on /semantic_obstacles")

    def on_det(self, msg):
        try:
            payload = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        now = time.time()
        self.last_rx = now
        if self.link_warned:
            self.get_logger().info("perception link restored")
            self.link_warned = False

        for d in payload.get("detections", []):
            cls, x, y = d.get("cls"), d.get("x"), d.get("y")
            if cls is None or x is None or y is None:
                continue
            # merge with nearest existing object of same class
            best, best_d = None, MERGE_DIST
            for o in self.store:
                if o["cls"] != cls:
                    continue
                dd = math.hypot(o["x"] - x, o["y"] - y)
                if dd < best_d:
                    best, best_d = o, dd
            if best is not None:
                best["x"], best["y"] = x, y
                best["conf"] = d.get("conf", best["conf"])
                best["t_last"] = now
                best.pop("censored_T", None)
            else:
                self.store.append({
                    "cls": cls, "x": x, "y": y,
                    "conf": d.get("conf", 0.0), "t_last": now,
                })

    def _stats(self, cls):
        if cls not in self.stats:
            ttl = CLASS_TTL.get(cls, DEFAULT_TTL)
            prior_lam = math.log(1.0 / P_MIN) / ttl
            # seed: prior_lam = D0/T0 with T0 = PRIOR_T
            self.stats[cls] = {"D": prior_lam * PRIOR_T, "T": PRIOR_T}
        return self.stats[cls]

    def lambda_hat(self, cls):
        st = self._stats(cls)
        return st["D"] / max(st["T"], 1e-6)

    def publish_sfi(self):
        now = time.time()
        msg = Float32()
        if not self.store:
            if self.last_rx and now - self.last_rx > LINK_DEAD_S:
                msg.data = 0.0   # memory empty because link dead
            else:
                msg.data = 1.0   # nothing tracked, nothing stale
        else:
            num, den = 0.0, 0.0
            for o in self.store:
                ttl = CLASS_TTL.get(o["cls"], DEFAULT_TTL)
                lam = math.log(1.0 / P_MIN) / ttl
                age = now - o["t_last"]
                w = 1.0
                num += w * math.exp(-lam * age)
                den += w
            msg.data = num / den
        self.sfi_pub.publish(msg)

    def tick(self):
        now = time.time()

        # link health log (the degradation experiment reads this)
        if self.last_rx and now - self.last_rx > LINK_STALE_S \
                and not self.link_warned:
            self.get_logger().warn(
                f"perception link stale >{LINK_STALE_S}s: "
                "store decaying, no new detections")
            self.link_warned = True

        # four-branch departure detector + censored-MLE decay
        link_fresh = self.last_rx and (now - self.last_rx) <= LINK_STALE_S
        if not link_fresh and self.link_down_at is None and self.last_rx:
            self.link_down_at = self.last_rx  # censor instant = last message
        if link_fresh:
            self.link_down_at = None
        dt = 1.0 / PUBLISH_HZ
        keep = []
        for o in self.store:
            gap = now - o["t_last"]
            lam = self.lambda_hat(o["cls"])
            if link_fresh:
                self._stats(o["cls"])["T"] += dt   # time-at-risk accrues every tick
                if gap < DEPART_GAP_S:
                    keep.append(o)            # confirmed-present
                elif gap < DEPART_CONFIRM_S:
                    keep.append(o)            # departure-candidate
                else:                          # confirmed-departed: check flicker first
                    rematch = any(
                        p2 is not o and p2["cls"] == o["cls"]
                        and (now - p2["t_last"]) < DEPART_GAP_S
                        and math.hypot(p2["x"] - o["x"], p2["y"] - o["y"]) < REMATCH_DIST
                        for p2 in self.store)
                    if rematch:
                        # same object re-tracked nearby: drop stale twin, NO event
                        self.get_logger().info(
                            f"flicker-rematch: {o['cls']} stale twin dropped, no departure")
                    else:
                        st = self._stats(o["cls"])
                        st["D"] += 1.0
                        self.get_logger().info(
                            f"departure: {o['cls']} after {gap:.1f}s, "
                            f"lambda_hat={self.lambda_hat(o['cls']):.4f}")
            else:
                # censored branch: exposure was accrued live while link was
                # fresh; during the outage no time-at-risk accrues (censored).
                if math.exp(-lam * gap) >= P_MIN:
                    keep.append(o)            # decaying on learned rate
        self.store = keep

        # build cloud
        pts = []
        for o in self.store:
            pts.extend(disc_points(
                o["x"], o["y"],
                CLASS_RADIUS.get(o["cls"], DEFAULT_RADIUS)))

        header = Header()
        header.stamp = self.get_clock().now().to_msg()
        header.frame_id = "map"
        cloud = pc2.create_cloud_xyz32(header, pts)
        self.pub.publish(cloud)


def main():
    rclpy.init()
    node = SemanticObstacles()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
