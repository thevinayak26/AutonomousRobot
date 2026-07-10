#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# fake_publisher.py - dev-time stand-in for the rosbag / real robot.
#
# Publishes the topics that are LIVE at the end of Week 3 (DASHBOARD_BUILD_SPEC
# §1/§6) with *correct message shapes*, so the dashboard can be built and the
# rosbridge wiring verified before the real bag is available. A small robot
# drives a loop around a rectangular room; the map fills in, LiDAR rays hit
# walls, odom/IMU/pose follow the motion.
#
# This is NOT a substitute for verifying against the real rosbag (Golden Rule 1).
# When the bag is provided: replay it instead of running this, and reconcile any
# message-shape differences in src/ros/topics.js.
#
# Usage:
#   source /opt/ros/jazzy/setup.bash
#   python3 tools/fake_publisher.py
#
# Topics:
#   /map        nav_msgs/OccupancyGrid    (transient_local / latched, 1 Hz)
#   /scan       sensor_msgs/LaserScan     (~10 Hz)
#   /odom       nav_msgs/Odometry         (~20 Hz)
#   /imu/data   sensor_msgs/Imu           (~20 Hz)
#   /robot_pose geometry_msgs/PoseStamped (map frame, ~15 Hz)  ← stands in for §5a
#   /sys_stats  std_msgs/String (JSON)    (1 Hz)                ← stands in for §5b
# -----------------------------------------------------------------------------
import json
import math
import os
import sys

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile,
    QoSDurabilityPolicy,
    QoSReliabilityPolicy,
    QoSHistoryPolicy,
)

from std_msgs.msg import String, Header, Bool, Float32
from geometry_msgs.msg import (
    PoseStamped, Quaternion, Point, Vector3, TransformStamped, Twist,
)
from nav_msgs.msg import OccupancyGrid, Odometry, MapMetaData, Path
from sensor_msgs.msg import LaserScan, Imu
from tf2_ros import TransformBroadcaster

# -- Room / map model (matches the mockup's room so visuals line up) ----------
RES = 0.05                      # m per cell
ROOM = dict(x=-3.2, y=-2.4, w=6.4, h=4.8)
GW = int(round(ROOM["w"] / RES))   # 128
GH = int(round(ROOM["h"] / RES))   # 96
ORIGIN_X = ROOM["x"]
ORIGIN_Y = ROOM["y"]

# -- Decode / orientation test mode -------------------------------------------
# Default keeps the original "robot explores, the map fills in slowly" behaviour.
# `--full` (or env FAKE_FULL_MAP=1) instead latches a FULLY-revealed map at once,
# with a bold asymmetric "F" landmark + one unknown pocket, so any dashboard
# decode/orientation bug (mirror, bad Y-flip, row-stride shear) is obvious at a
# glance - no waiting for the explore loop. The robot/scan/pose still move either
# way; only the /map reveal differs.
FULL_MAP = ("--full" in sys.argv) or (
    os.environ.get("FAKE_FULL_MAP", "").lower() not in ("", "0", "false", "no")
)

# A waypoint loop the robot drives (world coords, metres).
PATH = [(-2.6, -1.8), (2.6, -1.8), (2.6, 1.8),
        (-0.2, 1.8), (-0.2, -0.4), (-2.6, -0.4), (-2.6, -1.8)]


def yaw_to_quat(yaw: float) -> Quaternion:
    return Quaternion(x=0.0, y=0.0, z=math.sin(yaw / 2.0), w=math.cos(yaw / 2.0))


def in_wall(wx: float, wy: float) -> bool:
    """Truth map: outer walls (~0.1 m thick) + one interior divider."""
    edge = (wx < ROOM["x"] + 0.1 or wx > ROOM["x"] + ROOM["w"] - 0.1 or
            wy < ROOM["y"] + 0.1 or wy > ROOM["y"] + ROOM["h"] - 0.1)
    divider = (abs(wx + 0.2) < 0.07 and wy > -0.4)
    return edge or divider


def in_glyph(wx: float, wy: float) -> bool:
    """A bold 'F' in the upper-LEFT interior - an unmistakable orientation key.
    Correct decode → a normal 'F' (stem on the left, bars to the right, top bar
    up). A horizontal mirror flips the bars; a bad Y-flip drops it to the lower
    half / upside-down; a row-stride bug shears it. World metres."""
    stem = (-2.60 <= wx <= -2.42) and (0.40 <= wy <= 2.00)   # vertical spine
    top  = (-2.60 <= wx <= -1.70) and (1.82 <= wy <= 2.00)   # top arm
    mid  = (-2.60 <= wx <= -2.02) and (1.05 <= wy <= 1.23)   # middle arm (shorter)
    return stem or top or mid


def in_unknown_pocket(wx: float, wy: float) -> bool:
    """A right-of-centre rectangle kept UNKNOWN in --full mode, so all three cell
    types (wall/free/unknown) and frontier detection are exercised immediately,
    and so the map is asymmetric on the right as well as the left."""
    return (0.90 <= wx <= 2.00) and (-0.20 <= wy <= 0.90)


class FakePublisher(Node):
    def __init__(self):
        super().__init__("fake_publisher")

        # /map is latched (transient-local) - matches slam_toolbox & spec §10.
        map_qos = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )
        self.pub_map = self.create_publisher(OccupancyGrid, "/map", map_qos)
        self.pub_scan = self.create_publisher(LaserScan, "/scan", 10)
        self.pub_odom = self.create_publisher(Odometry, "/odom", 20)
        # EKF fused output the dashboard subscribes to (see src/ros/topics.js). We
        # publish it alongside /odom so the offline harness exercises the real topic.
        self.pub_odom_filtered = self.create_publisher(
            Odometry, "/odometry/filtered", 20)
        self.pub_imu = self.create_publisher(Imu, "/imu/data", 20)
        self.pub_pose = self.create_publisher(PoseStamped, "/robot_pose", 10)
        self.pub_sys = self.create_publisher(String, "/sys_stats", 10)
        # Nav2-style global plan stand-in (so the dashboard's path overlay has data
        # offline): a short route from the robot toward the waypoints ahead.
        self.pub_plan = self.create_publisher(Path, "/plan", 10)
        self.tf = TransformBroadcaster(self)

        # Extra topics a real Nav2 graph advertises - we just advertise them (no data)
        # so the dashboard's Topic Health card shows a long, realistic `ros2 topic
        # list` and its scroll behaviour can be exercised offline.
        extra = [
            ("/cmd_vel_nav", Twist), ("/goal_pose", PoseStamped), ("/local_plan", Path),
            ("/global_costmap/costmap", OccupancyGrid), ("/local_costmap/costmap", OccupancyGrid),
            ("/amcl_pose", PoseStamped), ("/initialpose", PoseStamped), ("/odom/wheel", Odometry),
            ("/scan_filtered", LaserScan), ("/map_updates", OccupancyGrid), ("/waypoints", Path),
            ("/joint_states", String), ("/robot_description", String), ("/diagnostics", String),
            ("/behavior_tree_log", String), ("/battery_state", Float32), ("/emergency_stop", Bool),
            ("/speed_limit", Float32), ("/cmd_vel_smoothed", Twist),
        ]
        self._extra_pubs = [self.create_publisher(t, n, 10) for n, t in extra]

        # Truth + discovered grids. -1 unknown, 0 free, 100 occupied.
        self.truth = bytearray(GW * GH)
        for gy in range(GH):
            for gx in range(GW):
                wx = ORIGIN_X + (gx + 0.5) * RES
                wy = ORIGIN_Y + (gy + 0.5) * RES
                occ = in_wall(wx, wy) or in_glyph(wx, wy)
                self.truth[gy * GW + gx] = 100 if occ else 0
        self.grid = [-1] * (GW * GH)

        # --full: reveal the whole truth map at once (minus one unknown pocket),
        # so decode/orientation is judgeable instantly. reveal() is a no-op then.
        if FULL_MAP:
            for gy in range(GH):
                for gx in range(GW):
                    wx = ORIGIN_X + (gx + 0.5) * RES
                    wy = ORIGIN_Y + (gy + 0.5) * RES
                    if not in_unknown_pocket(wx, wy):
                        self.grid[gy * GW + gx] = self.truth[gy * GW + gx]

        # Motion state
        self.seg = 0            # current path segment index
        self.t_seg = 0.0        # progress 0..1 along the segment
        self.x, self.y = PATH[0]
        self.yaw = 0.0
        self.prev_x, self.prev_y = self.x, self.y
        self.v = 0.0
        self.gyro_z = 0.0
        self.dist = 0.0
        self.start = self.get_clock().now()

        # Timers
        self.create_timer(0.05, self.step)          # 20 Hz motion + odom + imu
        self.create_timer(0.10, self.publish_scan)  # 10 Hz scan
        self.create_timer(1.00, self.publish_map)   # 1 Hz map
        self.create_timer(1.00, self.publish_sys)   # 1 Hz sys_stats
        self.create_timer(0.50, self.publish_plan)  # 2 Hz global plan
        self.publish_map()                          # latch one immediately
        mode = ("FULL static map + 'F' landmark + unknown pocket" if FULL_MAP
                else "explore (map fills in as the robot drives)")
        self.get_logger().info(
            f"fake_publisher up - grid {GW}x{GH} (w x h, non-square) @ {RES} m, "
            f"mode: {mode}. Publishing /map /scan /odom /imu/data /robot_pose "
            f"/sys_stats. Tip: pass --full for an instant decode/orientation test."
        )

    # -- header helper --
    def header(self, frame: str) -> Header:
        h = Header()
        h.stamp = self.get_clock().now().to_msg()
        h.frame_id = frame
        return h

    # -- 20 Hz: advance motion, publish odom + imu + pose + TF, reveal map --
    def step(self):
        speed = 0.18  # m/s nominal
        ax, ay = PATH[self.seg]
        bx, by = PATH[(self.seg + 1) % len(PATH)]
        seg_len = math.hypot(bx - ax, by - ay)
        self.t_seg += (speed * 0.05) / max(seg_len, 1e-6)
        if self.t_seg >= 1.0:
            self.t_seg = 0.0
            self.seg = (self.seg + 1) % len(PATH)
            ax, ay = PATH[self.seg]
            bx, by = PATH[(self.seg + 1) % len(PATH)]
        nx = ax + (bx - ax) * self.t_seg
        ny = ay + (by - ay) * self.t_seg

        new_yaw = math.atan2(by - ay, bx - ax)
        self.gyro_z = (new_yaw - self.yaw) / 0.05
        # normalize gyro spikes at segment turns
        if self.gyro_z > math.pi / 0.05:
            self.gyro_z -= 2 * math.pi / 0.05
        elif self.gyro_z < -math.pi / 0.05:
            self.gyro_z += 2 * math.pi / 0.05
        self.yaw = new_yaw

        step_d = math.hypot(nx - self.x, ny - self.y)
        self.dist += step_d
        self.v = step_d / 0.05
        self.prev_x, self.prev_y = self.x, self.y
        self.x, self.y = nx, ny

        self.reveal()
        self.publish_odom()
        self.publish_imu()
        self.publish_pose()
        self.publish_tf()

    def reveal(self):
        """Mark cells near the robot as discovered (sensor coverage)."""
        if FULL_MAP:
            return  # map is already fully latched; keep it static
        R = 1.6
        gx0 = max(0, int((self.x - R - ORIGIN_X) / RES))
        gx1 = min(GW, int((self.x + R - ORIGIN_X) / RES) + 1)
        gy0 = max(0, int((self.y - R - ORIGIN_Y) / RES))
        gy1 = min(GH, int((self.y + R - ORIGIN_Y) / RES) + 1)
        for gy in range(gy0, gy1):
            for gx in range(gx0, gx1):
                wx = ORIGIN_X + (gx + 0.5) * RES
                wy = ORIGIN_Y + (gy + 0.5) * RES
                if math.hypot(wx - self.x, wy - self.y) <= R:
                    idx = gy * GW + gx
                    if self.grid[idx] == -1:
                        self.grid[idx] = self.truth[idx]

    def publish_odom(self):
        msg = Odometry()
        msg.header = self.header("odom")
        msg.child_frame_id = "base_link"
        msg.pose.pose.position = Point(x=self.x, y=self.y, z=0.0)
        msg.pose.pose.orientation = yaw_to_quat(self.yaw)
        msg.twist.twist.linear = Vector3(x=self.v, y=0.0, z=0.0)
        msg.twist.twist.angular = Vector3(x=0.0, y=0.0, z=self.gyro_z)
        self.pub_odom.publish(msg)
        self.pub_odom_filtered.publish(msg)  # same shape, on the EKF topic name

    def publish_imu(self):
        msg = Imu()
        msg.header = self.header("base_link")
        msg.orientation = yaw_to_quat(self.yaw)
        msg.angular_velocity = Vector3(x=0.0, y=0.0, z=self.gyro_z)
        msg.linear_acceleration = Vector3(x=0.0, y=0.0, z=9.81)
        self.pub_imu.publish(msg)

    def publish_pose(self):
        msg = PoseStamped()
        msg.header = self.header("map")
        msg.pose.position = Point(x=self.x, y=self.y, z=0.0)
        msg.pose.orientation = yaw_to_quat(self.yaw)
        self.pub_pose.publish(msg)

    def publish_tf(self):
        # map -> odom (identity here; no drift in sim) and odom -> base_link.
        now = self.get_clock().now().to_msg()
        t1 = TransformStamped()
        t1.header.stamp = now
        t1.header.frame_id = "map"
        t1.child_frame_id = "odom"
        t1.transform.rotation.w = 1.0
        t2 = TransformStamped()
        t2.header.stamp = now
        t2.header.frame_id = "odom"
        t2.child_frame_id = "base_link"
        t2.transform.translation.x = self.x
        t2.transform.translation.y = self.y
        t2.transform.rotation = yaw_to_quat(self.yaw)
        self.tf.sendTransform([t1, t2])

    def publish_scan(self):
        n = 360
        amin, amax = -math.pi, math.pi
        ainc = (amax - amin) / n
        rmax = 5.0
        ranges = []
        for i in range(n):
            ang = amin + i * ainc + self.yaw
            r = 0.0
            hit = float("inf")
            while r < rmax:
                px = self.x + math.cos(ang) * r
                py = self.y + math.sin(ang) * r
                gx = int((px - ORIGIN_X) / RES)
                gy = int((py - ORIGIN_Y) / RES)
                if gx < 0 or gy < 0 or gx >= GW or gy >= GH:
                    break
                if self.truth[gy * GW + gx] == 100:
                    hit = r
                    break
                r += 0.04
            ranges.append(hit if math.isfinite(hit) else float("inf"))

        msg = LaserScan()
        msg.header = self.header("laser_frame")
        msg.angle_min = amin
        msg.angle_max = amax
        msg.angle_increment = ainc
        msg.time_increment = 0.0
        msg.scan_time = 0.1
        msg.range_min = 0.05
        msg.range_max = rmax
        msg.ranges = ranges
        self.pub_scan.publish(msg)

    def publish_map(self):
        msg = OccupancyGrid()
        msg.header = self.header("map")
        meta = MapMetaData()
        meta.resolution = RES
        meta.width = GW
        meta.height = GH
        meta.origin.position = Point(x=ORIGIN_X, y=ORIGIN_Y, z=0.0)
        meta.origin.orientation.w = 1.0
        msg.info = meta
        msg.data = [int(v) for v in self.grid]
        self.pub_map.publish(msg)

    def publish_plan(self):
        # A simple global plan: from the robot's current pose, through the next few
        # waypoints on its loop, interpolated so the overlay reads as a smooth route.
        goals = [PATH[(self.seg + 1 + k) % len(PATH)] for k in range(3)]
        knots = [(self.x, self.y)] + goals
        msg = Path()
        msg.header = self.header("map")
        for i in range(len(knots) - 1):
            ax, ay = knots[i]
            bx, by = knots[i + 1]
            steps = 8
            for s in range(steps):
                t = s / steps
                ps = PoseStamped()
                ps.header = msg.header
                ps.pose.position = Point(x=ax + (bx - ax) * t, y=ay + (by - ay) * t, z=0.0)
                ps.pose.orientation.w = 1.0
                msg.poses.append(ps)
        self.pub_plan.publish(msg)

    def publish_sys(self):
        uptime = (self.get_clock().now() - self.start).nanoseconds / 1e9
        # Lightly varying fake health (clearly synthetic, not pretending to be a Pi).
        cpu = 30.0 + 8.0 * math.sin(uptime / 7.0)
        mem = 44.0 + 4.0 * math.sin(uptime / 11.0)
        payload = {
            "cpu": round(cpu, 1),
            "mem": round(mem, 1),
            "uptime_s": int(uptime),
            "source": "fake_publisher",
        }
        self.pub_sys.publish(String(data=json.dumps(payload)))


def main():
    rclpy.init()
    node = FakePublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
