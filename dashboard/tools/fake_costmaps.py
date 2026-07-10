#!/usr/bin/env python3
# ------------------------------------------------------------------------------
# fake_costmaps.py - dev-time stand-in for the Nav2 costmap publishers, so the
# dashboard's costmap overlays can be built/verified offline (laptop only, no
# robot). Run ALONGSIDE tools/fake_publisher.py (it provides /map, TF and
# /odometry/filtered; this script reuses the same room geometry so the inflation
# hugs the same walls the map shows).
#
#   source /opt/ros/jazzy/setup.bash
#   python3 tools/fake_costmaps.py
#
# Publishes (matching the real Nav2 contract the dashboard subscribes to):
#   /global_costmap/costmap  nav_msgs/OccupancyGrid  map frame,  latched, 1 Hz
#   /local_costmap/costmap   nav_msgs/OccupancyGrid  odom frame, latched, 2 Hz,
#                            3.0x3.0 m rolling window centred on the robot
#
# Both use RELIABLE + TRANSIENT_LOCAL QoS like real Nav2 (always_send_full_costmap
# is true on the robot, so full grids at publish_frequency). Costs follow the
# Nav2 convention seen over rosbridge: 0 free, 1..98 inflation, 99 inscribed,
# 100 lethal, -1 unknown. Inflation is an exponential decay of the distance to
# the nearest wall (BFS distance field), like Nav2's inflation layer.
# ------------------------------------------------------------------------------
import math
from collections import deque

import rclpy
from rclpy.node import Node
from rclpy.qos import (
    QoSProfile,
    QoSDurabilityPolicy,
    QoSReliabilityPolicy,
    QoSHistoryPolicy,
)
from nav_msgs.msg import OccupancyGrid, Odometry

# Same room model as fake_publisher.py (keep in step with it).
RES = 0.05
ROOM = dict(x=-3.2, y=-2.4, w=6.4, h=4.8)
GW = int(round(ROOM["w"] / RES))   # 128
GH = int(round(ROOM["h"] / RES))   # 96
ORIGIN_X = ROOM["x"]
ORIGIN_Y = ROOM["y"]

INSCRIBED_M = 0.14   # robot radius-ish: cells closer than this are cost 99
CUTOFF_M = 0.65      # inflation reaches ~zero here
DECAY = 3.0          # exp decay steepness (Nav2 cost_scaling_factor flavour)

LOCAL_SIZE_M = 3.0   # local costmap window edge
LOCAL_HZ = 2.0
GLOBAL_HZ = 1.0


def in_wall(wx: float, wy: float) -> bool:
    """Truth walls - identical to fake_publisher.py."""
    edge = (wx < ROOM["x"] + 0.1 or wx > ROOM["x"] + ROOM["w"] - 0.1 or
            wy < ROOM["y"] + 0.1 or wy > ROOM["y"] + ROOM["h"] - 0.1)
    divider = (abs(wx + 0.2) < 0.07 and wy > -0.4)
    return edge or divider


def build_cost_field():
    """Distance-to-wall (BFS, 8-connected) -> Nav2-style inflated cost grid."""
    wall = [False] * (GW * GH)
    dist = [math.inf] * (GW * GH)
    q = deque()
    for gy in range(GH):
        for gx in range(GW):
            wx = ORIGIN_X + (gx + 0.5) * RES
            wy = ORIGIN_Y + (gy + 0.5) * RES
            if in_wall(wx, wy):
                i = gy * GW + gx
                wall[i] = True
                dist[i] = 0.0
                q.append((gx, gy))
    diag = RES * math.sqrt(2.0)
    while q:
        gx, gy = q.popleft()
        d0 = dist[gy * GW + gx]
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                nx, ny = gx + dx, gy + dy
                if nx < 0 or ny < 0 or nx >= GW or ny >= GH:
                    continue
                step = diag if dx and dy else RES
                j = ny * GW + nx
                if d0 + step < dist[j] - 1e-9:
                    dist[j] = d0 + step
                    q.append((nx, ny))
    cost = [0] * (GW * GH)
    for i, d in enumerate(dist):
        if wall[i]:
            cost[i] = 100
        elif d <= INSCRIBED_M:
            cost[i] = 99
        elif d < CUTOFF_M:
            c = int(round(98 * math.exp(-DECAY * (d - INSCRIBED_M))))
            cost[i] = max(1, min(98, c))
        else:
            cost[i] = 0
    return cost


class FakeCostmaps(Node):
    def __init__(self):
        super().__init__("fake_costmaps")
        latched = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            history=QoSHistoryPolicy.KEEP_LAST,
        )
        self.pub_global = self.create_publisher(
            OccupancyGrid, "/global_costmap/costmap", latched)
        self.pub_local = self.create_publisher(
            OccupancyGrid, "/local_costmap/costmap", latched)
        # fake_publisher's odom == map (identity TF), so following the filtered
        # odom keeps the local window glued to the moving robot.
        self.create_subscription(
            Odometry, "/odometry/filtered", self._on_odom, 20)
        self.rx, self.ry = 0.0, 0.0
        self.cost = build_cost_field()
        self.create_timer(1.0 / GLOBAL_HZ, self._pub_global)
        self.create_timer(1.0 / LOCAL_HZ, self._pub_local)
        self.get_logger().info("fake costmaps up: global 1 Hz, local 2 Hz")

    def _on_odom(self, msg):
        self.rx = msg.pose.pose.position.x
        self.ry = msg.pose.pose.position.y

    def _grid(self, frame, w, h, ox, oy, data):
        g = OccupancyGrid()
        g.header.frame_id = frame
        g.header.stamp = self.get_clock().now().to_msg()
        g.info.resolution = RES
        g.info.width = w
        g.info.height = h
        g.info.origin.position.x = ox
        g.info.origin.position.y = oy
        g.info.origin.orientation.w = 1.0
        g.data = data
        return g

    def _pub_global(self):
        self.pub_global.publish(
            self._grid("map", GW, GH, ORIGIN_X, ORIGIN_Y, self.cost))

    def _pub_local(self):
        n = int(round(LOCAL_SIZE_M / RES))
        # window origin snapped to the global grid so the crop below is exact
        gx0 = int(round((self.rx - LOCAL_SIZE_M / 2 - ORIGIN_X) / RES))
        gy0 = int(round((self.ry - LOCAL_SIZE_M / 2 - ORIGIN_Y) / RES))
        data = [-1] * (n * n)
        for y in range(n):
            gy = gy0 + y
            if gy < 0 or gy >= GH:
                continue
            row = gy * GW
            for x in range(n):
                gx = gx0 + x
                if 0 <= gx < GW:
                    data[y * n + x] = self.cost[row + gx]
        ox = ORIGIN_X + gx0 * RES
        oy = ORIGIN_Y + gy0 * RES
        # odom frame: fake stack broadcasts map->odom identity, so same numbers
        self.pub_local.publish(self._grid("odom", n, n, ox, oy, data))


def main():
    rclpy.init()
    node = FakeCostmaps()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
