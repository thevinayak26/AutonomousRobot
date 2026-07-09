#!/usr/bin/env python3
"""
ATLAS fusion node. Runs on the LAPTOP (GPU).
Pipeline: Pi MJPEG stream -> YOLO26 (RTX 5060) -> bearing per bbox
          -> LiDAR range in that angular sector (/scan over DDS)
          -> (x, y) in map frame via TF -> /detected_objects (JSON)
          -> /detected_objects_markers (RViz) -> annotated preview window.

Transport decisions (do not change without re-testing):
  - Video: requests + JPEG byte markers. cv2.VideoCapture does NOT work
    with web_video_server multipart MJPEG (July 2 handoff).
  - ROS: native DDS, domain 0, verified working laptop<->Pi.

Run:  source /opt/ros/jazzy/setup.bash
      source ~/yolo_env/bin/activate   (needs rclpy visible; see notes)
      python3 atlas_fusion_node.py [--host 192.168.5.100]
"""

import argparse
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
import requests

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy

from sensor_msgs.msg import LaserScan
from std_msgs.msg import String
from visualization_msgs.msg import Marker, MarkerArray
from geometry_msgs.msg import PointStamped

import tf2_ros
import tf2_geometry_msgs  # noqa: F401  (registers PointStamped transform)

from ultralytics import YOLO


# ---------------- tunables ----------------
HFOV_DEG_DEFAULT = 55.0      # C270 horizontal FOV. [Likely] ~55; VERIFY by measurement.
CAM_YAW_OFFSET_DEG = 0.0     # camera yaw relative to LiDAR zero. Measure and set.
CONF_THRESHOLD = 0.4
INFER_HZ = 5.0               # matches camera fps; no point going faster
CLASSES_KEPT = None          # None = all classes; or e.g. {"person", "chair"}
SECTOR_EXTRA_DEG = 1.0       # widen bbox sector slightly for sparse LiDAR
# Per-instance footprint radius: measured from bbox angular width + LiDAR range,
# clamped to class floors (truncated/occluded bboxes) and a 1.0 m ceiling.
R_BUFFER_M = 0.10
CLASS_R_FLOOR = {"person": 0.30, "chair": 0.35, "backpack": 0.20,
                 "couch": 0.50, "dining table": 0.50, "bed": 0.50}
R_FLOOR_DEFAULT = 0.30
R_CEIL_M = 1.0
MAX_RANGE_M = 8.0            # ignore fused hits beyond this
ANNOT_PORT = 8081           # laptop MJPEG server for the annotated (boxed) preview
JPEG_QUALITY = 70           # dashboard preview quality (speed over fidelity)
# -------------------------------------------


class FrameHub:
    """Latest annotated JPEG + a client counter, shared between the ROS timer thread
    (producer) and the HTTP server threads (consumers). Frames are encoded ONLY when
    at least one client is connected, so a closed dashboard costs nothing."""

    def __init__(self):
        self.cond = threading.Condition()
        self.jpeg = None
        self.seq = 0
        self.clients = 0

    def publish(self, jpeg_bytes):
        with self.cond:
            self.jpeg = jpeg_bytes
            self.seq += 1
            self.cond.notify_all()

    def has_clients(self):
        with self.cond:
            return self.clients > 0


class _MjpegHandler(BaseHTTPRequestHandler):
    hub = None  # set on the class before the server starts

    def log_message(self, *_):
        pass  # keep the ROS console clean

    def do_GET(self):
        if self.path.split("?")[0] not in ("/stream", "/"):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        hub = self.hub
        with hub.cond:
            hub.clients += 1
        last = -1
        try:
            while True:
                with hub.cond:
                    if hub.seq == last:
                        hub.cond.wait(timeout=1.0)
                    jpeg, seq = hub.jpeg, hub.seq
                if jpeg is None or seq == last:
                    continue
                last = seq
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                self.wfile.write(jpeg)
                self.wfile.write(b"\r\n")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with hub.cond:
                hub.clients -= 1


def start_mjpeg_server(hub, port=ANNOT_PORT):
    _MjpegHandler.hub = hub
    srv = ThreadingHTTPServer(("0.0.0.0", port), _MjpegHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class MjpegReader(threading.Thread):
    """Reads Pi MJPEG via requests, keeps only the latest frame."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url = url
        self.latest = None          # (frame_bgr, wall_time)
        self.lock = threading.Lock()
        self.ok = False

    def run(self):
        buf = b""
        while True:
            try:
                r = requests.get(self.url, stream=True, timeout=5)
                self.ok = True
                for chunk in r.iter_content(chunk_size=4096):
                    buf += chunk
                    a = buf.find(b"\xff\xd8")
                    b = buf.find(b"\xff\xd9")
                    if a != -1 and b != -1 and b > a:
                        jpg = buf[a:b + 2]
                        buf = buf[b + 2:]
                        frame = cv2.imdecode(
                            np.frombuffer(jpg, dtype=np.uint8), cv2.IMREAD_COLOR)
                        if frame is not None:
                            with self.lock:
                                self.latest = (frame, time.time())
                    if len(buf) > 1_000_000:
                        buf = b""  # desync guard
            except Exception as e:
                self.ok = False
                print(f"[stream] reconnecting after error: {e}")
                time.sleep(2)

    def get(self):
        with self.lock:
            return self.latest


class FusionNode(Node):
    def __init__(self, host):
        super().__init__("atlas_fusion")

        self.declare_parameter("hfov_deg", HFOV_DEG_DEFAULT)
        self.declare_parameter("cam_yaw_offset_deg", CAM_YAW_OFFSET_DEG)
        self.hfov = math.radians(
            self.get_parameter("hfov_deg").value)
        self.cam_yaw = math.radians(
            self.get_parameter("cam_yaw_offset_deg").value)

        # latest scan
        self.scan = None
        qos = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT)
        self.create_subscription(LaserScan, "/scan", self.on_scan, qos)

        # outputs
        self.pub_json = self.create_publisher(String, "/detected_objects", 10)
        self.pub_markers = self.create_publisher(
            MarkerArray, "/detected_objects_markers", 10)

        # TF
        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        # video + model
        url = f"http://{host}:8080/stream?topic=/image_raw&type=mjpeg"
        self.get_logger().info(f"Stream: {url}")
        self.reader = MjpegReader(url)
        self.reader.start()

        self.model = YOLO("yolo26n.pt")
        self.get_logger().info("YOLO26 loaded (GPU expected; check nvidia-smi)")

        # Annotated MJPEG server on the LAPTOP (:8081). The dashboard reads THIS, so
        # atlas_fusion_node stays the SOLE consumer of the Pi :8080 (one-consumer rule).
        self.frame_hub = FrameHub()
        start_mjpeg_server(self.frame_hub, ANNOT_PORT)
        self.get_logger().info(f"Annotated MJPEG: http://0.0.0.0:{ANNOT_PORT}/stream")

        self.timer = self.create_timer(1.0 / INFER_HZ, self.tick)
        self.last_frame_time = 0.0

    def on_scan(self, msg):
        self.scan = msg

    # ---- geometry ----
    def bbox_to_bearing(self, cx, width):
        """Pixel center -> bearing in laser frame. ROS: CCW positive, x fwd."""
        frac = (cx - width / 2.0) / width          # -0.5 .. +0.5, right = +
        return -frac * self.hfov + self.cam_yaw    # right of center = negative

    def range_in_sector(self, bearing, half_width):
        """Median of valid LiDAR returns inside [bearing +- half_width]."""
        s = self.scan
        if s is None:
            return None
        lo = bearing - half_width
        hi = bearing + half_width
        n = len(s.ranges)
        vals = []
        for i in range(n):
            a = s.angle_min + i * s.angle_increment
            # normalize to [-pi, pi]
            a = math.atan2(math.sin(a), math.cos(a))
            if lo <= a <= hi:
                r = s.ranges[i]
                if s.range_min < r < min(s.range_max, MAX_RANGE_M) \
                        and math.isfinite(r):
                    vals.append(r)
        if not vals:
            return None
        vals.sort()
        near = vals[0]; cluster = [v for v in vals if v - near < 0.3]; return sum(cluster) / len(cluster)

    def laser_to_map(self, r, bearing, stamp):
        pt = PointStamped()
        pt.header.frame_id = "laser_frame"
        pt.header.stamp = rclpy.time.Time().to_msg()
        pt.point.x = r * math.cos(bearing)
        pt.point.y = r * math.sin(bearing)
        pt.point.z = 0.0
        try:
            out = self.tf_buffer.transform(
                pt, "map", timeout=rclpy.duration.Duration(seconds=0.2))
            return out.point.x, out.point.y
        except Exception as e:
            self.get_logger().warn(f"TF map lookup failed: {e}", throttle_duration_sec=5.0)
            return None

    # ---- main loop ----
    def tick(self):
        got = self.reader.get()
        if got is None:
            return
        frame, t_cap = got
        if t_cap == self.last_frame_time:
            return  # no new frame
        self.last_frame_time = t_cap
        t0 = time.time()

        h, w = frame.shape[:2]
        res = self.model(frame, conf=CONF_THRESHOLD, verbose=False, imgsz=320)[0]

        detections = []
        markers = MarkerArray()
        stamp = self.get_clock().now().to_msg()

        for i, box in enumerate(res.boxes):
            cls = self.model.names[int(box.cls)]
            if CLASSES_KEPT and cls not in CLASSES_KEPT:
                continue
            conf = float(box.conf)
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            cx = (x1 + x2) / 2.0

            bearing = self.bbox_to_bearing(cx, w)
            half = ((x2 - x1) / 2.0 / w) * self.hfov \
                + math.radians(SECTOR_EXTRA_DEG)
            rng = self.range_in_sector(bearing, half)

            color = (0, 255, 0) if rng else (0, 165, 255)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            label = f"{cls} {rng:.2f}m" if rng else f"{cls} no-range"
            cv2.putText(frame, label, (x1, y1 - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

            if rng is None:
                continue
            xy = self.laser_to_map(rng, bearing, stamp)
            if xy is None:
                continue
            mx, my = xy

            dtheta = ((x2 - x1) / w) * self.hfov
            width_m = 2.0 * rng * math.tan(dtheta / 2.0)
            r_obj = min(max(width_m / 2.0 + R_BUFFER_M,
                            CLASS_R_FLOOR.get(cls, R_FLOOR_DEFAULT)), R_CEIL_M)

            detections.append({
                "cls": cls, "conf": round(conf, 3),
                "r": round(r_obj, 3),
                "x": round(mx, 3), "y": round(my, 3),
                "range_m": round(rng, 3),
                "bearing_deg": round(math.degrees(bearing), 2),
                "t_wall": t_cap,
            })

            mk = Marker()
            mk.header.frame_id = "map"
            mk.header.stamp = stamp
            mk.ns = "atlas_fusion"
            mk.id = i
            mk.type = Marker.SPHERE
            mk.action = Marker.ADD
            mk.pose.position.x = mx
            mk.pose.position.y = my
            mk.pose.position.z = 0.1
            mk.scale.x = mk.scale.y = mk.scale.z = 0.25
            mk.color.a = 0.9
            mk.color.r = 1.0 if cls == "person" else 0.1
            mk.color.g = 0.2 if cls == "person" else 0.8
            mk.color.b = 0.2
            mk.lifetime = rclpy.duration.Duration(seconds=1.5).to_msg()
            markers.markers.append(mk)

        # HEARTBEAT: publish EVERY processed frame, empty detections included.
        # Message absence now identifies LINK state, not scene state - this is
        # what makes link censoring exogenous by construction (paper claim 1.4).
        msg = String()
        msg.data = json.dumps({
            "stamp_wall": time.time(),
            "proc_ms": round((time.time() - t0) * 1000.0, 1),
            "detections": detections,
        })
        self.pub_json.publish(msg)
        if detections:
            self.pub_markers.publish(markers)

        cv2.putText(frame, f"proc {round((time.time()-t0)*1000)} ms",
                    (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)

        # Serve the annotated frame to the dashboard (:8081). Encode only when a client
        # is connected so a closed dashboard adds zero cost to the inference loop.
        if self.frame_hub.has_clients():
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
            if ok:
                self.frame_hub.publish(buf.tobytes())

        cv2.imshow("ATLAS fusion", frame)
        if cv2.waitKey(1) == 27:
            rclpy.shutdown()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.5.100")
    args = ap.parse_args()

    rclpy.init()
    node = FusionNode(args.host)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
