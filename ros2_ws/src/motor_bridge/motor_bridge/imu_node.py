#!/usr/bin/env python3
"""
MPU6050 IMU Node for Raspberry Pi 5
Reads accelerometer and gyroscope data over I2C.
Publishes sensor_msgs/Imu to /imu/data topic.

Wiring:
  MPU6050 VCC → Pi Pin 1 (3.3V)
  MPU6050 GND → Pi Pin 6 (GND)
  MPU6050 SDA → Pi Pin 3 (GPIO 2 / SDA)
  MPU6050 SCL → Pi Pin 5 (GPIO 3 / SCL)

Usage:
  ros2 run motor_bridge imu_node
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Imu
import struct
import math
import time

# MPU6050 registers
MPU6050_ADDR = 0x68
PWR_MGMT_1 = 0x6B
ACCEL_XOUT_H = 0x3B
GYRO_XOUT_H = 0x43
ACCEL_CONFIG = 0x1C
GYRO_CONFIG = 0x1B

# Scale factors
ACCEL_SCALE = 16384.0  # ±2g
GYRO_SCALE = 131.0     # ±250 deg/s


class IMUNode(Node):
    def __init__(self):
        super().__init__('imu_node')

        self.declare_parameter('i2c_bus', 1)
        self.declare_parameter('publish_rate', 50.0)  # Hz
        self.declare_parameter('frame_id', 'imu_link')

        self.i2c_bus = self.get_parameter('i2c_bus').value
        self.rate = self.get_parameter('publish_rate').value
        self.frame_id = self.get_parameter('frame_id').value

        self.imu_pub = self.create_publisher(Imu, '/imu/data', 50)

        # Calibration offsets (calculated at startup)
        self.gyro_offset_x = 0.0
        self.gyro_offset_y = 0.0
        self.gyro_offset_z = 0.0
        self.accel_offset_x = 0.0
        self.accel_offset_y = 0.0
        self.accel_offset_z = 0.0

        # I2C setup
        self.i2c = None
        self.connect_i2c()

        if self.i2c is not None:
            self.calibrate()
            self.timer = self.create_timer(1.0 / self.rate, self.publish_imu)
            self.get_logger().info(f'IMU node started at {self.rate}Hz on I2C bus {self.i2c_bus}')
        else:
            self.get_logger().error('Failed to connect to MPU6050. Check wiring.')

    def connect_i2c(self):
        try:
            import smbus2
            self.i2c = smbus2.SMBus(self.i2c_bus)

            # Wake up MPU6050 (it starts in sleep mode)
            self.i2c.write_byte_data(MPU6050_ADDR, PWR_MGMT_1, 0x00)
            time.sleep(0.1)

            # Set accelerometer to ±2g
            self.i2c.write_byte_data(MPU6050_ADDR, ACCEL_CONFIG, 0x00)

            # Set gyroscope to ±250 deg/s
            self.i2c.write_byte_data(MPU6050_ADDR, GYRO_CONFIG, 0x00)

            # Verify connection by reading WHO_AM_I register
            who = self.i2c.read_byte_data(MPU6050_ADDR, 0x75)
            if who != 0x68:
                self.get_logger().warn(f'WHO_AM_I returned {who}, expected 0x68')

            self.get_logger().info('MPU6050 connected successfully')

        except Exception as e:
            self.get_logger().error(f'I2C connection failed: {e}')
            self.get_logger().error('Make sure I2C is enabled: sudo raspi-config → Interface Options → I2C')
            self.i2c = None

    def read_raw_data(self, reg):
        """Read two bytes from register and return signed 16-bit value."""
        high = self.i2c.read_byte_data(MPU6050_ADDR, reg)
        low = self.i2c.read_byte_data(MPU6050_ADDR, reg + 1)
        value = (high << 8) | low
        if value > 32767:
            value -= 65536
        return value

    def calibrate(self):
        """Average 200 readings at rest to get offsets."""
        self.get_logger().info('Calibrating IMU — keep robot still for 4 seconds...')
        samples = 500
        gx_sum = 0.0
        gy_sum = 0.0
        gz_sum = 0.0
        ax_sum = 0.0
        ay_sum = 0.0
        az_sum = 0.0

        for i in range(samples):
            try:
                gx_sum += self.read_raw_data(GYRO_XOUT_H)
                gy_sum += self.read_raw_data(GYRO_XOUT_H + 2)
                gz_sum += self.read_raw_data(GYRO_XOUT_H + 4)
                ax_sum += self.read_raw_data(ACCEL_XOUT_H)
                ay_sum += self.read_raw_data(ACCEL_XOUT_H + 2)
                az_sum += self.read_raw_data(ACCEL_XOUT_H + 4)
            except Exception:
                pass
            time.sleep(0.02)

        self.gyro_offset_x = gx_sum / samples
        self.gyro_offset_y = gy_sum / samples
        self.gyro_offset_z = gz_sum / samples
        self.accel_offset_x = ax_sum / samples
        self.accel_offset_y = ay_sum / samples
        # Z axis offset accounts for gravity (1g = 16384 at ±2g scale)
        self.accel_offset_z = (az_sum / samples) - ACCEL_SCALE

        self.get_logger().info(
            f'Calibration done. Gyro offsets: '
            f'x={self.gyro_offset_x:.1f} y={self.gyro_offset_y:.1f} z={self.gyro_offset_z:.1f}')

    def publish_imu(self):
        """Read IMU and publish."""
        if self.i2c is None:
            return

        try:
            # Read raw values
            ax_raw = self.read_raw_data(ACCEL_XOUT_H)
            ay_raw = self.read_raw_data(ACCEL_XOUT_H + 2)
            az_raw = self.read_raw_data(ACCEL_XOUT_H + 4)
            gx_raw = self.read_raw_data(GYRO_XOUT_H)
            gy_raw = self.read_raw_data(GYRO_XOUT_H + 2)
            gz_raw = self.read_raw_data(GYRO_XOUT_H + 4)

            # Apply calibration offsets and convert to SI units
            # Accelerometer: m/s²
            ax = ((ax_raw - self.accel_offset_x) / ACCEL_SCALE) * 9.81
            ay = ((ay_raw - self.accel_offset_y) / ACCEL_SCALE) * 9.81
            az = ((az_raw - self.accel_offset_z) / ACCEL_SCALE) * 9.81

            # Gyroscope: rad/s
            gx = ((gx_raw - self.gyro_offset_x) / GYRO_SCALE) * (math.pi / 180.0)
            gy = ((gy_raw - self.gyro_offset_y) / GYRO_SCALE) * (math.pi / 180.0)
            gz = ((gz_raw - self.gyro_offset_z) / GYRO_SCALE) * (math.pi / 180.0)

            # Create and publish message
            msg = Imu()
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.header.frame_id = self.frame_id

            # We don't compute orientation, set to unknown
            msg.orientation_covariance[0] = -1.0

            msg.angular_velocity.x = gx
            msg.angular_velocity.y = gy
            msg.angular_velocity.z = gz
            msg.angular_velocity_covariance[0] = 0.01
            msg.angular_velocity_covariance[4] = 0.01
            msg.angular_velocity_covariance[8] = 0.01

            msg.linear_acceleration.x = ax
            msg.linear_acceleration.y = ay
            msg.linear_acceleration.z = az
            msg.linear_acceleration_covariance[0] = 0.1
            msg.linear_acceleration_covariance[4] = 0.1
            msg.linear_acceleration_covariance[8] = 0.1

            self.imu_pub.publish(msg)

        except Exception as e:
            self.get_logger().warn(f'IMU read error: {e}')


def main():
    rclpy.init()
    node = IMUNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node.i2c:
            node.i2c.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
