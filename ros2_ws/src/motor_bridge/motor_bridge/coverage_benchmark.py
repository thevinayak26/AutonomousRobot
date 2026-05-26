#!/usr/bin/env python3
"""
Coverage Benchmark Script
Measures how many square meters the robot covers in a given time period.
Also tracks distance traveled and average speed.

Usage:
  ros2 run motor_bridge coverage_benchmark
  OR
  python3 coverage_benchmark.py

Subscribes to /map (OccupancyGrid) and /odom (Odometry).
Runs for 90 seconds by default (configurable via parameter).
Prints results at the end.
"""

import rclpy
from rclpy.node import Node
from nav_msgs.msg import OccupancyGrid, Odometry
import time
import math


class CoverageBenchmark(Node):
    def __init__(self):
        super().__init__('coverage_benchmark')

        self.declare_parameter('duration', 90.0)  # seconds
        self.duration = self.get_parameter('duration').value

        # Map subscription
        self.map_sub = self.create_subscription(
            OccupancyGrid, '/map', self.map_callback, 10)

        # Odom subscription for distance tracking
        self.odom_sub = self.create_subscription(
            Odometry, '/odom', self.odom_callback, 10)

        # Map stats
        self.free_cells = 0
        self.occupied_cells = 0
        self.unknown_cells = 0
        self.resolution = 0.05  # default, updated from map
        self.map_received = False

        # Distance tracking
        self.total_distance = 0.0
        self.prev_x = None
        self.prev_y = None

        # Timing
        self.start_time = None
        self.started = False
        self.finished = False

        # Snapshots for comparison
        self.initial_free = 0
        self.snapshots = []  # (time, free_cells, distance)

        # Timer for periodic updates
        self.update_timer = self.create_timer(5.0, self.print_update)

        self.get_logger().info(f'Coverage Benchmark ready')
        self.get_logger().info(f'Duration: {self.duration:.0f} seconds')
        self.get_logger().info(f'Waiting for first map message...')
        self.get_logger().info(f'Start driving the robot to begin!')

    def map_callback(self, msg):
        if self.finished:
            return

        self.resolution = msg.info.resolution

        free = 0
        occupied = 0
        unknown = 0

        for cell in msg.data:
            if cell == 0:
                free += 1
            elif cell == 100:
                occupied += 1
            else:
                unknown += 1

        self.free_cells = free
        self.occupied_cells = occupied
        self.unknown_cells = unknown
        self.map_received = True

    def odom_callback(self, msg):
        if self.finished:
            return

        x = msg.pose.pose.position.x
        y = msg.pose.pose.position.y

        if self.prev_x is not None:
            dx = x - self.prev_x
            dy = y - self.prev_y
            dist = math.sqrt(dx * dx + dy * dy)

            # Only count meaningful movement (filter noise)
            if dist > 0.001 and dist < 1.0:
                # Start the timer on first real movement
                if not self.started and dist > 0.01:
                    self.started = True
                    self.start_time = time.time()
                    self.initial_free = self.free_cells
                    self.get_logger().info('='*50)
                    self.get_logger().info('  BENCHMARK STARTED — robot is moving!')
                    self.get_logger().info(f'  Initial free area: {self.get_free_area():.2f} m²')
                    self.get_logger().info('='*50)

                if self.started:
                    self.total_distance += dist

        self.prev_x = x
        self.prev_y = y

        # Check if time is up
        if self.started and not self.finished:
            elapsed = time.time() - self.start_time
            if elapsed >= self.duration:
                self.finish_benchmark()

    def get_free_area(self):
        return self.free_cells * self.resolution * self.resolution

    def get_occupied_area(self):
        return self.occupied_cells * self.resolution * self.resolution

    def print_update(self):
        if not self.started or self.finished:
            return

        elapsed = time.time() - self.start_time
        remaining = self.duration - elapsed
        free_area = self.get_free_area()
        new_area = free_area - (self.initial_free * self.resolution * self.resolution)

        self.snapshots.append((elapsed, self.free_cells, self.total_distance))

        self.get_logger().info(
            f'[{elapsed:.0f}s / {self.duration:.0f}s] '
            f'Area: {free_area:.2f} m² (+{new_area:.2f}) | '
            f'Distance: {self.total_distance:.2f} m | '
            f'Remaining: {remaining:.0f}s'
        )

    def finish_benchmark(self):
        self.finished = True
        elapsed = time.time() - self.start_time

        free_area = self.get_free_area()
        initial_area = self.initial_free * self.resolution * self.resolution
        new_area = free_area - initial_area
        occupied_area = self.get_occupied_area()
        avg_speed = self.total_distance / elapsed if elapsed > 0 else 0
        coverage_rate = new_area / elapsed if elapsed > 0 else 0

        self.get_logger().info('')
        self.get_logger().info('='*60)
        self.get_logger().info('  COVERAGE BENCHMARK RESULTS')
        self.get_logger().info('='*60)
        self.get_logger().info(f'  Duration:           {elapsed:.1f} seconds')
        self.get_logger().info(f'  Total free area:    {free_area:.2f} m²')
        self.get_logger().info(f'  New area covered:   {new_area:.2f} m²')
        self.get_logger().info(f'  Wall area mapped:   {occupied_area:.2f} m²')
        self.get_logger().info(f'  Distance traveled:  {self.total_distance:.2f} m')
        self.get_logger().info(f'  Average speed:      {avg_speed:.3f} m/s')
        self.get_logger().info(f'  Coverage rate:      {coverage_rate:.4f} m²/s')
        self.get_logger().info(f'  Map resolution:     {self.resolution} m/cell')
        self.get_logger().info(f'  Free cells:         {self.free_cells}')
        self.get_logger().info(f'  Occupied cells:     {self.occupied_cells}')
        self.get_logger().info('='*60)
        self.get_logger().info('')
        self.get_logger().info(f'  METRIC: {self.total_distance:.2f} meters in {elapsed:.0f} seconds')
        self.get_logger().info(f'  TARGET: 4.0 meters in 90 seconds')
        if self.total_distance >= 4.0:
            self.get_logger().info(f'  STATUS: *** TARGET MET ***')
        else:
            self.get_logger().info(f'  STATUS: Target not yet met ({self.total_distance:.2f}/4.0 m)')
        self.get_logger().info('='*60)
        self.get_logger().info('')
        self.get_logger().info('Benchmark complete. You can Ctrl+C now.')


def main():
    rclpy.init()
    node = CoverageBenchmark()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
