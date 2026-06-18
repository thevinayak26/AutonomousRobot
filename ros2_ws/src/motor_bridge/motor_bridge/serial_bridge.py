#!/usr/bin/env python3
"""
Serial bridge between ROS 2 and Arduino motor controller.

Subscribes to /cmd_vel, converts to motor PWM, sends to Arduino.
Reads encoder ticks from Arduino, publishes WHEEL odometry.

>>> CHANGES FOR EKF FUSION (vs the version from May 28) <<<
1. Odometry is now published on 'odom/wheel' (not 'odom').
   robot_localization (ekf_node) consumes this and outputs the fused 'odom'.
2. The odom->base_link TF broadcast is now GUARDED by the 'publish_tf' param,
   which defaults to FALSE. In EKF mode the EKF owns that transform, so this
   node must NOT also publish it (two publishers on one transform = broken TF).
   If you ever want to run WITHOUT the EKF again, set publish_tf:=true.
3. Pose/twist covariances are now filled in. robot_localization needs these to
   weight the fusion. Wheel heading is deliberately given a LOOSE covariance so
   the filter trusts the IMU gyro for turning.
"""
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist, TransformStamped
from nav_msgs.msg import Odometry
from tf2_ros import TransformBroadcaster
import serial
import math
import time
import threading


class SerialBridge(Node):
    def __init__(self):
        super().__init__('serial_bridge')

        self.declare_parameter('port', '/dev/ttyACM0')
        self.declare_parameter('baud', 115200)
        self.declare_parameter('wheel_separation', 0.247)
        self.declare_parameter('ticks_per_metre', 5030.0)
        self.declare_parameter('max_pwm', 180)
        self.declare_parameter('max_linear_vel', 0.45)
        self.declare_parameter('max_angular_vel', 2.84)
        # NEW: when False (default), do NOT broadcast odom->base_link.
        # The EKF publishes that transform instead. Set true only if running
        # without robot_localization.
        self.declare_parameter('publish_tf', False)

        self.port = self.get_parameter('port').value
        self.baud = self.get_parameter('baud').value
        self.wheel_sep = self.get_parameter('wheel_separation').value
        self.ticks_per_m = self.get_parameter('ticks_per_metre').value
        self.max_pwm = self.get_parameter('max_pwm').value
        self.max_lin = self.get_parameter('max_linear_vel').value
        self.max_ang = self.get_parameter('max_angular_vel').value
        self.publish_tf = self.get_parameter('publish_tf').value

        self.ser = None
        self.connect_serial()

        self.cmd_sub = self.create_subscription(Twist, 'cmd_vel', self.cmd_vel_callback, 10)
        # CHANGED: 'odom' -> 'odom/wheel' so the EKF can fuse it.
        self.odom_pub = self.create_publisher(Odometry, 'odom/wheel', 50)
        self.tf_broadcaster = TransformBroadcaster(self)  # only used if publish_tf

        self.x = 0.0
        self.y = 0.0
        self.theta = 0.0
        self.prev_left_ticks = 0
        self.prev_right_ticks = 0
        self.first_reading = True
        self.last_odom_time = self.get_clock().now()

        self.last_cmd_time = time.time()
        self.watchdog_timer = self.create_timer(0.1, self.watchdog_callback)

        self.latest_ticks = None
        self.ticks_lock = threading.Lock()

        self.odom_timer = self.create_timer(0.05, self.odom_timer_callback)

        self.serial_thread = threading.Thread(target=self.read_serial, daemon=True)
        self.serial_thread.start()

        mode = 'WHEEL ODOM ONLY (EKF owns TF)' if not self.publish_tf else 'STANDALONE (broadcasting TF)'
        self.get_logger().info(f'Serial bridge started on {self.port} | mode: {mode}')

    def connect_serial(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.5)
            time.sleep(2)
            self.ser.reset_input_buffer()
            self.get_logger().info(f'Connected to Arduino on {self.port}')
        except serial.SerialException as e:
            self.get_logger().error(f'Failed to connect: {e}')
            self.ser = None

    def cmd_vel_callback(self, msg):
        self.last_cmd_time = time.time()
        lin = msg.linear.x
        ang = msg.angular.z
        left_vel = lin - (ang * self.wheel_sep / 2.0)
        right_vel = lin + (ang * self.wheel_sep / 2.0)
        left_pwm = int(self.max_pwm * left_vel / self.max_lin) if self.max_lin != 0 else 0
        right_pwm = int(self.max_pwm * right_vel / self.max_lin) if self.max_lin != 0 else 0
        left_pwm = max(-255, min(255, left_pwm))
        right_pwm = max(-255, min(255, right_pwm))
        self.send_motor_command(left_pwm, right_pwm)

    def send_motor_command(self, left, right):
        # Arduino M1 = right motor, M2 = left motor.
        # Right motor is physically reversed, so negate it.
        # Send: first value -> M1 (right motor), second value -> M2 (left motor)
        if self.ser and self.ser.is_open:
            cmd = f"M,{-right},{left}\n"
            try:
                self.ser.write(cmd.encode())
            except serial.SerialException:
                self.get_logger().warn('Serial write failed')

    def watchdog_callback(self):
        if time.time() - self.last_cmd_time > 0.5:
            self.send_motor_command(0, 0)

    def read_serial(self):
        """Background thread: reads serial lines and stores ticks."""
        while rclpy.ok():
            if self.ser is None or not self.ser.is_open:
                time.sleep(1)
                self.connect_serial()
                continue
            try:
                line = self.ser.readline().decode('utf-8', errors='ignore').strip()
                if line.startswith('E,'):
                    parts = line.split(',')
                    if len(parts) == 3:
                        # NOTE: keep these signs CONSISTENT with the on-ground
                        # calibration you verified. If forward drive makes x
                        # DECREASE, flip the signs here (and only here).
                        lt = int(parts[1])
                        rt = -int(parts[2])
                        with self.ticks_lock:
                            self.latest_ticks = (lt, rt)
            except (serial.SerialException, ValueError, OSError) as e:
                self.get_logger().warn(f'Serial read error: {e}')
                time.sleep(0.5)

    def odom_timer_callback(self):
        """Called from ROS timer thread — safe to publish."""
        with self.ticks_lock:
            ticks = self.latest_ticks
            self.latest_ticks = None

        if ticks is None:
            return

        left_ticks, right_ticks = ticks
        now = self.get_clock().now()

        if self.first_reading:
            self.prev_left_ticks = left_ticks
            self.prev_right_ticks = right_ticks
            self.first_reading = False
            self.last_odom_time = now
            self.get_logger().info(f'First encoder reading: L={left_ticks} R={right_ticks}')
            return

        delta_left = (left_ticks - self.prev_left_ticks) / self.ticks_per_m
        delta_right = (right_ticks - self.prev_right_ticks) / self.ticks_per_m
        self.prev_left_ticks = left_ticks
        self.prev_right_ticks = right_ticks

        delta_dist = (delta_left + delta_right) / 2.0
        delta_theta = (delta_right - delta_left) / self.wheel_sep

        self.x += delta_dist * math.cos(self.theta + delta_theta / 2.0)
        self.y += delta_dist * math.sin(self.theta + delta_theta / 2.0)
        self.theta += delta_theta

        dt = (now - self.last_odom_time).nanoseconds / 1e9
        self.last_odom_time = now
        if dt <= 0:
            return

        linear_vel = delta_dist / dt
        angular_vel = delta_theta / dt

        odom = Odometry()
        odom.header.stamp = now.to_msg()
        odom.header.frame_id = 'odom'
        odom.child_frame_id = 'base_link'
        odom.pose.pose.position.x = self.x
        odom.pose.pose.position.y = self.y
        odom.pose.pose.orientation.z = math.sin(self.theta / 2.0)
        odom.pose.pose.orientation.w = math.cos(self.theta / 2.0)
        odom.twist.twist.linear.x = linear_vel
        odom.twist.twist.angular.z = angular_vel

        # --- Covariances for robot_localization ---------------------------
        # Diagonal order: [x, y, z, roll, pitch, yaw]
        # Wheel heading (yaw) is loose on purpose so the EKF trusts the IMU.
        odom.pose.covariance[0]  = 0.02    # x
        odom.pose.covariance[7]  = 0.02    # y
        odom.pose.covariance[14] = 1e6     # z (unused in 2D)
        odom.pose.covariance[21] = 1e6     # roll (unused)
        odom.pose.covariance[28] = 1e6     # pitch (unused)
        odom.pose.covariance[35] = 0.2     # yaw (loose)
        odom.twist.covariance[0]  = 0.01   # vx (fused)
        odom.twist.covariance[7]  = 1e6    # vy (no sideways motion)
        odom.twist.covariance[14] = 1e6    # vz
        odom.twist.covariance[21] = 1e6    # v roll
        odom.twist.covariance[28] = 1e6    # v pitch
        odom.twist.covariance[35] = 0.1    # v yaw (IMU is preferred, so loose here)
        # -------------------------------------------------------------------

        self.odom_pub.publish(odom)

        # Only broadcast TF if explicitly told to (i.e. running WITHOUT the EKF).
        # In EKF mode this stays off and robot_localization publishes odom->base_link.
        if self.publish_tf:
            t = TransformStamped()
            t.header.stamp = now.to_msg()
            t.header.frame_id = 'odom'
            t.child_frame_id = 'base_link'
            t.transform.translation.x = self.x
            t.transform.translation.y = self.y
            t.transform.rotation.z = math.sin(self.theta / 2.0)
            t.transform.rotation.w = math.cos(self.theta / 2.0)
            self.tf_broadcaster.sendTransform(t)


def main():
    rclpy.init()
    node = SerialBridge()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if node.ser and node.ser.is_open:
            node.ser.write(b"S\n")
            node.ser.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
