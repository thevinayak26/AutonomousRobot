#!/usr/bin/env python3
"""
Serial bridge between ROS 2 and Arduino motor controller.
Subscribes to /cmd_vel, converts to motor PWM, sends to Arduino.
Reads encoder ticks from Arduino, publishes odometry.
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
        self.declare_parameter('wheel_separation', 0.40)
        self.declare_parameter('ticks_per_metre', 7480.0)
        self.declare_parameter('max_pwm', 180)
        self.declare_parameter('max_linear_vel', 0.22)
        self.declare_parameter('max_angular_vel', 2.84)

        self.port = self.get_parameter('port').value
        self.baud = self.get_parameter('baud').value
        self.wheel_sep = self.get_parameter('wheel_separation').value
        self.ticks_per_m = self.get_parameter('ticks_per_metre').value
        self.max_pwm = self.get_parameter('max_pwm').value
        self.max_lin = self.get_parameter('max_linear_vel').value
        self.max_ang = self.get_parameter('max_angular_vel').value

        self.ser = None
        self.connect_serial()

        self.cmd_sub = self.create_subscription(Twist, 'cmd_vel', self.cmd_vel_callback, 10)
        self.odom_pub = self.create_publisher(Odometry, 'odom', 50)
        self.tf_broadcaster = TransformBroadcaster(self)

        self.x = 0.0
        self.y = 0.0
        self.theta = 0.0
        self.prev_left_ticks = 0
        self.prev_right_ticks = 0
        self.first_reading = True
        self.last_odom_time = self.get_clock().now()

        self.last_cmd_time = time.time()
        self.watchdog_timer = self.create_timer(0.1, self.watchdog_callback)

        # Store latest ticks from serial thread, publish from timer (ROS thread)
        self.latest_ticks = None
        self.ticks_lock = threading.Lock()

        # Timer to publish odom from ROS thread (not from serial thread)
        self.odom_timer = self.create_timer(0.05, self.odom_timer_callback)

        self.serial_thread = threading.Thread(target=self.read_serial, daemon=True)
        self.serial_thread.start()

        self.get_logger().info(f'Serial bridge started on {self.port}')

    def connect_serial(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.5)
            time.sleep(2)
            # Flush any garbage from Arduino reset
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
        # Arduino M1 = right motor, M2 = left motor
        # Right motor is physically reversed, so negate it
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
                        lt = -int(parts[2])
                        rt = -int(parts[1])
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
        self.odom_pub.publish(odom)

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
