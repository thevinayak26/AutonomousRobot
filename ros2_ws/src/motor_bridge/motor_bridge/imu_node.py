#!/usr/bin/env python3
"""
MPU6050 IMU Node for Raspberry Pi 5 — with ONLINE GYRO BIAS TRACKING.

Reads accel + gyro over I2C, publishes sensor_msgs/Imu to /imu/data.

>>> WHY THIS EXISTS (the fix) <<<
The MPU6050 gyro has a slow, WANDERING zero-rate bias (measured on this unit:
~-0.2 to -5.5 deg/min, drifting and partially recovering). A one-shot startup
calibration captures only one instant of that wander, so yaw drifted between
corrections and the SLAM map doubled/smeared on turns.

This node continuously RE-ESTIMATES the gyro bias whenever the robot is COMMANDED
STILL (zero /cmd_vel, settled) and subtracts it live. While the robot is moving
the bias is FROZEN, so real rotation can never be mistaken for bias. A magnitude
gate is a safety net: it refuses to learn if the apparent (bias-corrected) rate is
large, which catches the case where the robot is physically moving even though
cmd_vel says otherwise (e.g. pushed by hand).

This pairs with unthrottled slam_toolbox: online bias keeps the EKF heading prior
honest AT REST and at the start of every motion; SLAM scan-matching keeps it
honest DURING sustained motion. Together they stop the drift.

Revert: restore imu_node.py.bak and `colcon build`.

Wiring:  VCC->Pin1(3.3V)  GND->Pin6  SDA->Pin3(GPIO2)  SCL->Pin5(GPIO3)
"""
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Imu
from geometry_msgs.msg import Twist
import math
import time

# MPU6050 registers
MPU6050_ADDR = 0x68
PWR_MGMT_1 = 0x6B
ACCEL_XOUT_H = 0x3B
GYRO_XOUT_H = 0x43
ACCEL_CONFIG = 0x1C
GYRO_CONFIG = 0x1B
ACCEL_SCALE = 16384.0   # raw counts per g   (±2g)
GYRO_SCALE = 131.0      # raw counts per deg/s (±250 deg/s)


class IMUNode(Node):
    def __init__(self):
        super().__init__('imu_node')
        self.declare_parameter('i2c_bus', 1)
        self.declare_parameter('publish_rate', 50.0)
        self.declare_parameter('frame_id', 'imu_link')
        # --- online bias-tracking params ---
        self.declare_parameter('bias_alpha', 0.01)      # EMA gain when still (~2s lock at 50Hz)
        self.declare_parameter('settle_sec', 0.5)       # wait after motion stops before learning
        self.declare_parameter('motion_gate_dps', 3.0)  # don't learn if |corrected rate| > this (deg/s)

        self.i2c_bus  = self.get_parameter('i2c_bus').value
        self.rate     = self.get_parameter('publish_rate').value
        self.frame_id = self.get_parameter('frame_id').value
        self.bias_alpha = self.get_parameter('bias_alpha').value
        self.settle_sec = self.get_parameter('settle_sec').value
        self.motion_gate_raw = self.get_parameter('motion_gate_dps').value * GYRO_SCALE

        self.imu_pub = self.create_publisher(Imu, '/imu/data', 50)
        self.cmd_sub = self.create_subscription(Twist, '/cmd_vel', self.cmd_cb, 10)

        # Live gyro bias in RAW counts. Seeded by startup calibration, then tracked online.
        self.bias_x = 0.0
        self.bias_y = 0.0
        self.bias_z = 0.0
        # Accel offsets (static; accel is not used for heading).
        self.accel_offset_x = 0.0
        self.accel_offset_y = 0.0
        self.accel_offset_z = 0.0

        self.last_motion_time = time.time()   # last time a NONZERO cmd_vel arrived
        self._log_counter = 0
        self._learning = False

        self.i2c = None
        self.connect_i2c()
        if self.i2c is not None:
            self.calibrate()
            self.timer = self.create_timer(1.0 / self.rate, self.publish_imu)
            self.get_logger().info(
                f'IMU node started at {self.rate}Hz | ONLINE bias tracking ON '
                f'(alpha={self.bias_alpha}, gate={self.motion_gate_raw/GYRO_SCALE:.1f} deg/s)')
        else:
            self.get_logger().error('Failed to connect to MPU6050. Check wiring.')

    def cmd_cb(self, msg):
        if abs(msg.linear.x) > 1e-4 or abs(msg.angular.z) > 1e-4 or abs(msg.linear.y) > 1e-4:
            self.last_motion_time = time.time()

    def _is_still(self):
        # Still = enough time elapsed since the last NONZERO velocity command.
        return (time.time() - self.last_motion_time) > self.settle_sec

    def connect_i2c(self):
        try:
            import smbus2
            self.i2c = smbus2.SMBus(self.i2c_bus)
            self.i2c.write_byte_data(MPU6050_ADDR, PWR_MGMT_1, 0x00)
            time.sleep(0.1)
            self.i2c.write_byte_data(MPU6050_ADDR, ACCEL_CONFIG, 0x00)
            self.i2c.write_byte_data(MPU6050_ADDR, GYRO_CONFIG, 0x00)
            who = self.i2c.read_byte_data(MPU6050_ADDR, 0x75)
            if who != 0x68:
                self.get_logger().warn(f'WHO_AM_I returned {who}, expected 0x68')
            self.get_logger().info('MPU6050 connected successfully')
        except Exception as e:
            self.get_logger().error(f'I2C connection failed: {e}')
            self.get_logger().error('Enable I2C: sudo raspi-config -> Interface Options -> I2C')
            self.i2c = None

    def read_raw_data(self, reg):
        high = self.i2c.read_byte_data(MPU6050_ADDR, reg)
        low = self.i2c.read_byte_data(MPU6050_ADDR, reg + 1)
        value = (high << 8) | low
        if value > 32767:
            value -= 65536
        return value

    def calibrate(self):
        """Seed the bias from 500 still readings at startup. Robot MUST be motionless."""
        self.get_logger().info('Calibrating IMU — keep robot DEAD STILL for ~10 seconds...')
        samples = 500
        gx = gy = gz = ax = ay = az = 0.0
        for _ in range(samples):
            try:
                gx += self.read_raw_data(GYRO_XOUT_H)
                gy += self.read_raw_data(GYRO_XOUT_H + 2)
                gz += self.read_raw_data(GYRO_XOUT_H + 4)
                ax += self.read_raw_data(ACCEL_XOUT_H)
                ay += self.read_raw_data(ACCEL_XOUT_H + 2)
                az += self.read_raw_data(ACCEL_XOUT_H + 4)
            except Exception:
                pass
            time.sleep(0.02)
        self.bias_x = gx / samples
        self.bias_y = gy / samples
        self.bias_z = gz / samples
        self.accel_offset_x = ax / samples
        self.accel_offset_y = ay / samples
        self.accel_offset_z = (az / samples) - ACCEL_SCALE
        self.get_logger().info(
            f'Initial gyro bias seeded: z={self.bias_z:.1f} raw '
            f'({self.bias_z / GYRO_SCALE * 60:.2f} deg/min). Online tracking will refine it.')

    def publish_imu(self):
        if self.i2c is None:
            return
        try:
            ax_raw = self.read_raw_data(ACCEL_XOUT_H)
            ay_raw = self.read_raw_data(ACCEL_XOUT_H + 2)
            az_raw = self.read_raw_data(ACCEL_XOUT_H + 4)
            gx_raw = self.read_raw_data(GYRO_XOUT_H)
            gy_raw = self.read_raw_data(GYRO_XOUT_H + 2)
            gz_raw = self.read_raw_data(GYRO_XOUT_H + 4)

            # --- ONLINE BIAS UPDATE: only when commanded-still AND apparent rate is small ---
            still = self._is_still()
            self._learning = still
            if still:
                cz = gz_raw - self.bias_z
                if abs(cz) < self.motion_gate_raw:
                    self.bias_z += self.bias_alpha * cz   # EMA toward current raw -> tracks wander
                cx = gx_raw - self.bias_x
                if abs(cx) < self.motion_gate_raw:
                    self.bias_x += self.bias_alpha * cx
                cy = gy_raw - self.bias_y
                if abs(cy) < self.motion_gate_raw:
                    self.bias_y += self.bias_alpha * cy

            # Apply current bias, convert to SI
            ax = ((ax_raw - self.accel_offset_x) / ACCEL_SCALE) * 9.81
            ay = ((ay_raw - self.accel_offset_y) / ACCEL_SCALE) * 9.81
            az = ((az_raw - self.accel_offset_z) / ACCEL_SCALE) * 9.81
            gx = ((gx_raw - self.bias_x) / GYRO_SCALE) * (math.pi / 180.0)
            gy = ((gy_raw - self.bias_y) / GYRO_SCALE) * (math.pi / 180.0)
            gz = ((gz_raw - self.bias_z) / GYRO_SCALE) * (math.pi / 180.0)

            msg = Imu()
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.header.frame_id = self.frame_id
            msg.orientation_covariance[0] = -1.0
            msg.angular_velocity.x = gx
            msg.angular_velocity.y = gy
            msg.angular_velocity.z = -gz  # IMU yaw inverted: left turn must be +z (CCW)
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

            # Periodic visibility into the tracker (~every 10s) — watch z converge toward 0.
            self._log_counter += 1
            if self._log_counter >= int(self.rate * 10):
                self._log_counter = 0
                state = 'learning' if self._learning else 'FROZEN (moving)'
                self.get_logger().info(
                    f'[bias] z={self.bias_z / GYRO_SCALE * math.pi / 180:.5f} rad/s '
                    f'({self.bias_z / GYRO_SCALE * 60:.2f} deg/min) | {state}')
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
