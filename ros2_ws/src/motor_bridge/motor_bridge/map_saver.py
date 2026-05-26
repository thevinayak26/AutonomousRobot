#!/usr/bin/env python3
"""
Map Saver
Subscribes to /map and saves the occupancy grid as a PNG image.
Useful for documentation and reports.

Usage:
  ros2 run motor_bridge map_saver
  OR
  python3 map_saver.py

Saves to ~/maps/map_YYYYMMDD_HHMMSS.png
Also saves a YAML metadata file with map info.
"""

import rclpy
from rclpy.node import Node
from nav_msgs.msg import OccupancyGrid
import numpy as np
import os
import time
from datetime import datetime


class MapSaver(Node):
    def __init__(self):
        super().__init__('map_saver')

        self.declare_parameter('output_dir', os.path.expanduser('~/maps'))
        self.declare_parameter('auto_save_interval', 0.0)  # 0 = save once and exit

        self.output_dir = self.get_parameter('output_dir').value
        self.auto_interval = self.get_parameter('auto_save_interval').value

        os.makedirs(self.output_dir, exist_ok=True)

        self.map_sub = self.create_subscription(
            OccupancyGrid, '/map', self.map_callback, 10)

        self.map_received = False
        self.save_count = 0

        if self.auto_interval > 0:
            self.auto_timer = self.create_timer(self.auto_interval, self.auto_save)
            self.get_logger().info(f'Auto-saving every {self.auto_interval}s to {self.output_dir}')
        else:
            self.get_logger().info(f'Will save one map to {self.output_dir} and exit')

        self.latest_msg = None

    def map_callback(self, msg):
        self.latest_msg = msg
        if not self.map_received:
            self.map_received = True
            self.get_logger().info(
                f'Map received: {msg.info.width}x{msg.info.height}, '
                f'resolution={msg.info.resolution}m')

            if self.auto_interval <= 0:
                # Save once and exit
                self.save_map(msg)
                self.get_logger().info('Single save complete. Shutting down.')
                raise SystemExit(0)

    def auto_save(self):
        if self.latest_msg:
            self.save_map(self.latest_msg)

    def save_map(self, msg):
        width = msg.info.width
        height = msg.info.height
        resolution = msg.info.resolution

        # Convert occupancy grid to image
        # OccupancyGrid: -1 = unknown, 0 = free, 100 = occupied
        data = np.array(msg.data, dtype=np.int8).reshape((height, width))

        # Create RGB image
        img = np.zeros((height, width, 3), dtype=np.uint8)

        # Unknown = gray (128, 128, 128)
        unknown_mask = data == -1
        img[unknown_mask] = [128, 128, 128]

        # Free = white (255, 255, 255)
        free_mask = data == 0
        img[free_mask] = [255, 255, 255]

        # Occupied = black (0, 0, 0)
        occupied_mask = data == 100
        img[occupied_mask] = [0, 0, 0]

        # Partially occupied = gradient
        partial_mask = (~unknown_mask) & (~free_mask) & (~occupied_mask)
        if np.any(partial_mask):
            partial_vals = data[partial_mask].astype(np.float32)
            gray = (255 * (1.0 - partial_vals / 100.0)).astype(np.uint8)
            img[partial_mask, 0] = gray
            img[partial_mask, 1] = gray
            img[partial_mask, 2] = gray

        # Flip vertically (ROS origin is bottom-left, image origin is top-left)
        img = np.flipud(img)

        # Generate filename
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        self.save_count += 1
        png_path = os.path.join(self.output_dir, f'map_{timestamp}.png')
        yaml_path = os.path.join(self.output_dir, f'map_{timestamp}.yaml')

        # Save PNG using raw PPM (no PIL dependency needed)
        ppm_path = png_path.replace('.png', '.ppm')
        with open(ppm_path, 'wb') as f:
            f.write(f'P6\n{width} {height}\n255\n'.encode())
            f.write(img.tobytes())

        # Try to convert to PNG if possible
        try:
            import subprocess
            subprocess.run(['convert', ppm_path, png_path],
                         capture_output=True, timeout=10)
            os.remove(ppm_path)
            saved_path = png_path
        except (FileNotFoundError, subprocess.TimeoutExpired):
            # ImageMagick not available, keep PPM
            saved_path = ppm_path

        # Save metadata
        origin = msg.info.origin.position
        with open(yaml_path, 'w') as f:
            f.write(f'image: {os.path.basename(saved_path)}\n')
            f.write(f'resolution: {resolution}\n')
            f.write(f'origin: [{origin.x}, {origin.y}, 0.0]\n')
            f.write(f'width: {width}\n')
            f.write(f'height: {height}\n')
            f.write(f'free_cells: {int(np.sum(free_mask))}\n')
            f.write(f'occupied_cells: {int(np.sum(occupied_mask))}\n')
            f.write(f'unknown_cells: {int(np.sum(unknown_mask))}\n')
            f.write(f'free_area_m2: {float(np.sum(free_mask)) * resolution * resolution:.2f}\n')
            f.write(f'timestamp: {timestamp}\n')

        free_area = float(np.sum(free_mask)) * resolution * resolution
        self.get_logger().info(
            f'Map saved: {saved_path} '
            f'({width}x{height}, {free_area:.2f}m² free)')

        return saved_path


def main():
    rclpy.init()
    node = MapSaver()
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
