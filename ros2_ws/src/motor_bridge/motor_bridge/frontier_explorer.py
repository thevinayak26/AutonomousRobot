#!/usr/bin/env python3
"""
frontier_explorer.py — Autonomous frontier-based exploration for Nav2.

ARCHITECTURE (deliberate — do not "simplify" this to cmd_vel):
  This node is a Nav2 ACTION CLIENT. It NEVER publishes /cmd_vel.
  It finds the nearest unexplored frontier on the SLAM /map, sends a
  NavigateToPose goal, and lets Nav2 (global planner + controller + costmaps
  + recovery behaviors) do the driving and obstacle avoidance. When a goal
  finishes it picks the next frontier. Exploration ends when no reachable
  frontier remains.

  Why action-based, not direct-drive: a direct cmd_vel explorer bypasses the
  planner, costmaps, and recovery — a dead end past Week 6. Routing every goal
  through Nav2 is the layer Weeks 7-10 build on.

INPUTS:   /map (nav_msgs/OccupancyGrid), TF map -> base_link
OUTPUTS:  NavigateToPose goals on /navigate_to_pose
RUN:      ros2 run motor_bridge frontier_explorer
          (do NOT remap cmd_vel — this node does not use it)

PRECONDITION: single-goal NavigateToPose must already drive the robot correctly
              before running this. This only AUTOMATES goal-sending; it cannot
              fix a broken nav chain.
"""

import math
from collections import deque

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient

from nav_msgs.msg import OccupancyGrid
from geometry_msgs.msg import PoseStamped
from nav2_msgs.action import NavigateToPose
from action_msgs.msg import GoalStatus

import tf2_ros


# OccupancyGrid cell semantics
UNKNOWN = -1
FREE_THRESH = 25       # cells in 0..FREE_THRESH are "free enough" to stand on


class FrontierExplorer(Node):
    def __init__(self):
        super().__init__('frontier_explorer')

        # ---- tunables (override with --ros-args -p name:=value) ----
        self.declare_parameter('min_frontier_size', 8)      # cells; ignore smaller clusters (noise)
        self.declare_parameter('goal_timeout_sec', 60.0)    # cancel + blacklist a goal after this
        self.declare_parameter('blacklist_radius', 0.30)    # m; failed goals blacklist nearby frontiers
        self.declare_parameter('revisit_radius', 0.30)      # m; skip frontiers near a just-completed goal
        self.declare_parameter('planning_period', 2.0)      # s; (re)evaluate cadence when idle
        self.declare_parameter('robot_base_frame', 'base_link')
        self.declare_parameter('map_frame', 'map')

        self.min_frontier_size = self.get_parameter('min_frontier_size').value
        self.goal_timeout      = self.get_parameter('goal_timeout_sec').value
        self.blacklist_radius  = self.get_parameter('blacklist_radius').value
        self.revisit_radius    = self.get_parameter('revisit_radius').value
        self.planning_period   = self.get_parameter('planning_period').value
        self.base_frame        = self.get_parameter('robot_base_frame').value
        self.map_frame         = self.get_parameter('map_frame').value

        # ---- state ----
        self.map = None
        self.navigating = False
        self.current_goal_handle = None
        self.goal_start_time = None
        self.last_goal = None                 # (wx, wy) of the goal currently in flight
        self.blacklist = []                   # (wx, wy) points that failed
        self.recent_goals = deque(maxlen=6)   # (wx, wy) recently completed, loop-guard

        # ---- ROS I/O ----
        self.map_sub = self.create_subscription(OccupancyGrid, '/map', self.map_callback, 10)
        self.nav_client = ActionClient(self, NavigateToPose, '/navigate_to_pose')

        self.tf_buffer = tf2_ros.Buffer()
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self)

        self.timer = self.create_timer(self.planning_period, self.explore_cycle)
        self.get_logger().info('Frontier explorer up — waiting for /map and Nav2 action server...')

    # ------------------------------------------------------------------ map
    def map_callback(self, msg):
        self.map = msg

    def robot_position(self):
        """(wx, wy) of base_link in the map frame, or None if TF not ready."""
        try:
            t = self.tf_buffer.lookup_transform(self.map_frame, self.base_frame, rclpy.time.Time())
            return (t.transform.translation.x, t.transform.translation.y)
        except Exception:
            return None

    # ------------------------------------------------------- frontier search
    def find_frontiers(self):
        """Return [((wx, wy), size), ...] frontier-cluster centroids in world coords."""
        grid = self.map
        w, h = grid.info.width, grid.info.height
        res = grid.info.resolution
        ox = grid.info.origin.position.x
        oy = grid.info.origin.position.y
        arr = np.array(grid.data, dtype=np.int16).reshape(h, w)

        free = (arr >= 0) & (arr <= FREE_THRESH)
        unknown = (arr == UNKNOWN)

        # A frontier cell = free AND has an unknown 4-neighbor.
        un = np.zeros_like(unknown)
        un[1:, :]  |= unknown[:-1, :]
        un[:-1, :] |= unknown[1:, :]
        un[:, 1:]  |= unknown[:, :-1]
        un[:, :-1] |= unknown[:, 1:]
        frontier = free & un

        cells = np.argwhere(frontier)         # rows of [y, x]
        if len(cells) == 0:
            return []
        cellset = {(int(c[1]), int(c[0])) for c in cells}   # (x, y)

        # 8-connectivity BFS clustering over the (few) frontier cells.
        clusters = []
        visited = set()
        for cell in cellset:
            if cell in visited:
                continue
            q = deque([cell])
            visited.add(cell)
            comp = []
            while q:
                cx, cy = q.popleft()
                comp.append((cx, cy))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nb = (cx + dx, cy + dy)
                        if nb in cellset and nb not in visited:
                            visited.add(nb)
                            q.append(nb)
            if len(comp) >= self.min_frontier_size:
                sx = sum(c[0] for c in comp) / len(comp)
                sy = sum(c[1] for c in comp) / len(comp)
                wx = ox + (sx + 0.5) * res
                wy = oy + (sy + 0.5) * res
                clusters.append(((wx, wy), len(comp)))
        return clusters

    def _near_any(self, wx, wy, points, radius):
        return any(math.hypot(wx - px, wy - py) < radius for px, py in points)

    # ------------------------------------------------------- state machine
    def explore_cycle(self):
        # while a goal is in flight, only run the timeout watchdog
        if self.navigating:
            if self.goal_start_time is not None:
                elapsed = (self.get_clock().now() - self.goal_start_time).nanoseconds / 1e9
                if elapsed > self.goal_timeout:
                    self.get_logger().warn(f'Goal timed out after {elapsed:.0f}s — cancelling + blacklisting.')
                    if self.last_goal:
                        self.blacklist.append(self.last_goal)
                    self.cancel_current_goal()
            return

        if self.map is None:
            return
        if not self.nav_client.server_is_ready():
            self.get_logger().info('Waiting for Nav2 /navigate_to_pose server...', throttle_duration_sec=5.0)
            return

        robot = self.robot_position()
        if robot is None:
            self.get_logger().info('Waiting for map->base_link TF...', throttle_duration_sec=5.0)
            return

        clusters = self.find_frontiers()
        clusters = [c for c in clusters
                    if not self._near_any(c[0][0], c[0][1], self.blacklist, self.blacklist_radius)
                    and not self._near_any(c[0][0], c[0][1], self.recent_goals, self.revisit_radius)]

        if not clusters:
            self.get_logger().info('No reachable frontiers left — exploration COMPLETE.')
            return

        rx, ry = robot
        clusters.sort(key=lambda c: math.hypot(c[0][0] - rx, c[0][1] - ry))
        (gx, gy), size = clusters[0]
        self.send_goal(gx, gy, rx, ry, size)

    def send_goal(self, gx, gy, rx, ry, size):
        goal = NavigateToPose.Goal()
        ps = PoseStamped()
        ps.header.frame_id = self.map_frame
        ps.header.stamp = self.get_clock().now().to_msg()
        ps.pose.position.x = gx
        ps.pose.position.y = gy
        yaw = math.atan2(gy - ry, gx - rx)        # face the frontier
        ps.pose.orientation.z = math.sin(yaw / 2.0)
        ps.pose.orientation.w = math.cos(yaw / 2.0)
        goal.pose = ps

        self.navigating = True
        self.last_goal = (gx, gy)
        self.goal_start_time = self.get_clock().now()
        self.get_logger().info(f'Exploring frontier at ({gx:.2f}, {gy:.2f}) [{size} cells]')
        fut = self.nav_client.send_goal_async(goal)
        fut.add_done_callback(self.goal_response_cb)

    def goal_response_cb(self, future):
        handle = future.result()
        if not handle.accepted:
            self.get_logger().warn('Goal REJECTED by Nav2 — blacklisting, will retry elsewhere.')
            if self.last_goal:
                self.blacklist.append(self.last_goal)
            self._reset_nav_state()
            return
        self.current_goal_handle = handle
        handle.get_result_async().add_done_callback(self.goal_result_cb)

    def goal_result_cb(self, future):
        status = future.result().status
        if status == GoalStatus.STATUS_SUCCEEDED:
            self.get_logger().info('Frontier reached. Picking next.')
            if self.last_goal:
                self.recent_goals.append(self.last_goal)   # loop-guard, not a hard blacklist
        else:
            self.get_logger().warn(f'Goal ended status={status} — blacklisting this frontier.')
            if self.last_goal:
                self.blacklist.append(self.last_goal)
        self._reset_nav_state()

    def cancel_current_goal(self):
        if self.current_goal_handle is not None:
            self.current_goal_handle.cancel_goal_async()
        self._reset_nav_state()

    def _reset_nav_state(self):
        self.navigating = False
        self.current_goal_handle = None
        self.goal_start_time = None
        self.last_goal = None


def main():
    rclpy.init()
    node = FrontierExplorer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
