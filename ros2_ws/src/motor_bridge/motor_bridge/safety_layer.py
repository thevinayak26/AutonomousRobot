#!/usr/bin/env python3
"""
Obstacle Avoidance Safety Layer
Sits between cmd_vel sources and the actual cmd_vel topic.
Monitors LiDAR scan and slows/stops the robot before hitting walls.

Architecture:
  teleop/frontier_explorer publish to /cmd_vel_raw
  This node subscribes to /cmd_vel_raw and /scan
  Publishes safe velocities to /cmd_vel

Usage:
  ros2 run motor_bridge safety_layer

Then make sure teleop and frontier_explorer publish to /cmd_vel_raw:
  ros2 run teleop_twist_keyboard teleop_twist_keyboard --ros-args -r cmd_vel:=cmd_vel_raw
  ros2 run motor_bridge frontier_explorer --ros-args -r cmd_vel:=cmd_vel_raw
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from sensor_msgs.msg import LaserScan
import math


class SafetyLayer(Node):
    def __init__(self):
        super().__init__('safety_layer')

        # Parameters
        self.declare_parameter('stop_distance', 0.20)       # meters — full stop
        self.declare_parameter('slow_distance', 0.50)       # meters — start slowing
        self.declare_parameter('side_stop_distance', 0.15)   # meters — side collision
        self.declare_parameter('front_angle', 45.0)          # degrees — front cone half-angle
        self.declare_parameter('side_angle', 90.0)           # degrees — side detection angle
        self.declare_parameter('min_speed_factor', 0.3)      # minimum speed multiplier when slowing

        self.stop_dist = self.get_parameter('stop_distance').value
        self.slow_dist = self.get_parameter('slow_distance').value
        self.side_stop_dist = self.get_parameter('side_stop_distance').value
        self.front_angle = math.radians(self.get_parameter('front_angle').value)
        self.side_angle = math.radians(self.get_parameter('side_angle').value)
        self.min_speed_factor = self.get_parameter('min_speed_factor').value

        # Subscribers
        self.cmd_raw_sub = self.create_subscription(
            Twist, '/cmd_vel_raw', self.cmd_raw_callback, 10)
        self.scan_sub = self.create_subscription(
            LaserScan, '/scan', self.scan_callback, 10)

        # Publisher
        self.cmd_pub = self.create_publisher(Twist, '/cmd_vel', 10)

        # State
        self.front_min_dist = float('inf')
        self.left_min_dist = float('inf')
        self.right_min_dist = float('inf')
        self.rear_min_dist = float('inf')
        self.scan_received = False
        self.last_cmd = Twist()
        self.obstacles_stopped = 0

        self.get_logger().info('Safety Layer active')
        self.get_logger().info(f'Stop: {self.stop_dist}m | Slow: {self.slow_dist}m')
        self.get_logger().info('Listening on /cmd_vel_raw → publishing to /cmd_vel')

    def scan_callback(self, msg):
        """Process LiDAR scan to find minimum distances in each direction."""
        front_min = float('inf')
        left_min = float('inf')
        right_min = float('inf')
        rear_min = float('inf')

        angle = msg.angle_min
        for r in msg.ranges:
            if r < msg.range_min or r > msg.range_max or math.isnan(r) or math.isinf(r):
                angle += msg.angle_increment
                continue

            # Normalize angle to [-pi, pi]
            a = angle
            while a > math.pi:
                a -= 2 * math.pi
            while a < -math.pi:
                a += 2 * math.pi

            # Front: -front_angle to +front_angle
            if abs(a) < self.front_angle:
                front_min = min(front_min, r)
            # Left: front_angle to side_angle
            elif a > 0 and a < self.side_angle:
                left_min = min(left_min, r)
            # Right: -side_angle to -front_angle
            elif a < 0 and a > -self.side_angle:
                right_min = min(right_min, r)
            # Rear: beyond side_angle
            elif abs(a) > math.pi - self.front_angle:
                rear_min = min(rear_min, r)

            angle += msg.angle_increment

        self.front_min_dist = front_min
        self.left_min_dist = left_min
        self.right_min_dist = right_min
        self.rear_min_dist = rear_min
        self.scan_received = True

    def cmd_raw_callback(self, msg):
        """Receive raw cmd_vel, apply safety limits, publish safe cmd_vel."""
        if not self.scan_received:
            # No scan yet — pass through but at reduced speed
            safe = Twist()
            safe.linear.x = msg.linear.x * 0.5
            safe.angular.z = msg.angular.z
            self.cmd_pub.publish(safe)
            return

        safe = Twist()
        safe.linear.x = msg.linear.x
        safe.angular.z = msg.angular.z

        # Forward motion safety
        if msg.linear.x > 0:
            if self.front_min_dist < self.stop_dist:
                # Too close — full stop forward, allow turning
                safe.linear.x = 0.0
                self.obstacles_stopped += 1
                if self.obstacles_stopped % 20 == 1:
                    self.get_logger().warn(
                        f'STOP — obstacle at {self.front_min_dist:.2f}m ahead')
            elif self.front_min_dist < self.slow_dist:
                # Slow down proportionally
                factor = (self.front_min_dist - self.stop_dist) / (self.slow_dist - self.stop_dist)
                factor = max(self.min_speed_factor, min(1.0, factor))
                safe.linear.x = msg.linear.x * factor

        # Backward motion safety
        if msg.linear.x < 0:
            if self.rear_min_dist < self.stop_dist:
                safe.linear.x = 0.0
                if self.obstacles_stopped % 20 == 1:
                    self.get_logger().warn(
                        f'STOP — obstacle at {self.rear_min_dist:.2f}m behind')

        # Turning safety — prevent turning into walls
        if msg.angular.z > 0 and self.left_min_dist < self.side_stop_dist:
            # Trying to turn left but wall on left
            safe.angular.z = 0.0
        elif msg.angular.z < 0 and self.right_min_dist < self.side_stop_dist:
            # Trying to turn right but wall on right
            safe.angular.z = 0.0

        self.cmd_pub.publish(safe)


def main():
    rclpy.init()
    node = SafetyLayer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        # Stop robot on shutdown
        stop = Twist()
        node.cmd_pub.publish(stop)
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
