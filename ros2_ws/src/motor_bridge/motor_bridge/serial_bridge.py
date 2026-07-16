#!/usr/bin/env python3
"""
Serial bridge between ROS 2 and Arduino PID motor controller (V / velocity mode).

Clean rewrite 2026-06-27 (v2). Division of responsibility:
  * FIRMWARE owns motion smoothing: slew-rate ramp, friction floor, PID with
    filtered derivative and conditional-integration anti-windup. The bridge does
    NOT ramp or deadband-bump anymore. Stacking a second ramp here fought the
    firmware ramp and caused low-speed stutter, so it was removed.
  * BRIDGE is a thin, safe pass-through: cmd_vel -> wheel tps -> "V,..." plus
    odometry out, plus all the hard safety (true 'S' stop, watchdog, clamp,
    NaN reject, gains-on-connect).

One control timer (50 ms) owns every serial write so there is never more than
one writer. cmd_vel only updates the target; the timer sends it (or a true stop).

EKF MODE: odom on 'odom/wheel'; publish_tf defaults False (EKF owns
odom->base_link); covariances filled; wheel yaw loose so EKF trusts the IMU.

Sign / slot conventions (firmware rewrite 2026-06-27, verified on ground):
  Firmware "E,leftTicks,rightTicks". Right ISR now counts POSITIVE on forward,
  so BOTH raw values are positive when driving forward.
  Send slots cross: firmware slot1 = our RIGHT, slot2 = our LEFT
      -> cmd = f"V,{right_tps},{left_tps}".
  Decode (both positive on forward): lt = int(parts[2]), rt = int(parts[1]).
  Do not change signs without an on-ground spin test.
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

        # ---- parameters -------------------------------------------------
        self.declare_parameter('port', '/dev/ttyACM0')
        self.declare_parameter('baud', 115200)
        self.declare_parameter('wheel_separation', 0.247)
        self.declare_parameter('ticks_per_metre', 5030.0)
        self.declare_parameter('max_linear_vel', 0.50)
        self.declare_parameter('max_angular_vel', 2.84)
        self.declare_parameter('publish_tf', False)

        # PID gains pushed to firmware on connect.
        self.declare_parameter('pid_kp', 0.15)
        self.declare_parameter('pid_ki', 0.08)
        self.declare_parameter('pid_kd', 0.0)

        self.declare_parameter('control_period', 0.05)
        self.declare_parameter('cmd_timeout', 0.5)

        self.port = self.get_parameter('port').value
        self.baud = self.get_parameter('baud').value
        self.wheel_sep = self.get_parameter('wheel_separation').value
        self.ticks_per_m = self.get_parameter('ticks_per_metre').value
        self.max_lin = self.get_parameter('max_linear_vel').value
        self.max_ang = self.get_parameter('max_angular_vel').value
        self.publish_tf = self.get_parameter('publish_tf').value
        self.kp = self.get_parameter('pid_kp').value
        self.ki = self.get_parameter('pid_ki').value
        self.kd = self.get_parameter('pid_kd').value
        self.ctrl_dt = self.get_parameter('control_period').value
        self.cmd_timeout = self.get_parameter('cmd_timeout').value

        # Hard clamp: max physical wheel speed (m/s).
        self.max_wheel_vel = self.max_lin + self.max_ang * self.wheel_sep / 2.0

        # ---- serial -----------------------------------------------------
        self.ser = None
        self.serial_lock = threading.Lock()
        self.stopped = True
        self.connect_serial()

        # ---- target state (set by cmd_vel, sent by control timer) -------
        self.target_left_tps = 0.0
        self.target_right_tps = 0.0
        self.last_cmd_time = time.time()

        # ---- odometry state --------------------------------------------
        self.x = 0.0
        self.y = 0.0
        self.theta = 0.0
        self.prev_left_ticks = 0
        self.prev_right_ticks = 0
        self.first_reading = True
        self.last_odom_time = self.get_clock().now()
        self.latest_ticks = None
        self.ticks_lock = threading.Lock()

        # ---- ROS interfaces --------------------------------------------
        self.cmd_sub = self.create_subscription(Twist, 'cmd_vel', self.cmd_vel_callback, 10)
        self.odom_pub = self.create_publisher(Odometry, 'odom/wheel', 50)
        self.tf_broadcaster = TransformBroadcaster(self)

        # ---- timers -----------------------------------------------------
        self.control_timer = self.create_timer(self.ctrl_dt, self.control_loop)
        self.odom_timer = self.create_timer(0.05, self.odom_timer_callback)

        # ---- serial read thread ----------------------------------------
        self.serial_thread = threading.Thread(target=self.read_serial, daemon=True)
        self.serial_thread.start()

        mode = 'WHEEL ODOM ONLY (EKF owns TF)' if not self.publish_tf else 'STANDALONE (broadcasting TF)'
        self.get_logger().info(
            f'Serial bridge (PID V-mode, thin pass-through) on {self.port} | {mode} | '
            f'gains Kp={self.kp} Ki={self.ki} Kd={self.kd} | '
            f'max_wheel={self.max_wheel_vel:.2f} m/s | firmware owns slew+floor')

    # ====================================================================
    #  helpers
    # ====================================================================
    def _vel_to_tps(self, vel):
        """Identity velocity mapping with deadband offset:
        send_tps = (|vel| + 0.0966) * ticks_per_m, signed.
        Firmware V targets are plain tps (verified 2026-07-03 sweep, linear).
        +0.0966 m/s flat offset retained to lift low commands above the
        minPWM 30 deadband. Old affine /2.802 divisor removed."""
        if abs(vel) <= 1e-3:
            return 0.0
        a = abs(vel)
        a = max(a + 0.0966, 0.05 + 0.0966)
        return math.copysign(a, vel) * self.ticks_per_m

    # ====================================================================
    #  serial connect / read
    # ====================================================================
    def connect_serial(self):
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.5)
            time.sleep(2)
            self.ser.reset_input_buffer()
            self.ser.write(b"S\n")
            time.sleep(0.05)
            self.ser.write(f"P,{self.kp},{self.ki},{self.kd}\n".encode())
            self.stopped = True
            self.get_logger().info(f'Connected to Arduino on {self.port} (sent S + gains)')
        except serial.SerialException as e:
            self.get_logger().error(f'Failed to connect: {e}')
            self.ser = None

    def read_serial(self):
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
                        # Both wheels positive on forward (firmware rewrite).
                        lt = int(parts[2])
                        rt = int(parts[1])
                        with self.ticks_lock:
                            self.latest_ticks = (lt, rt)
                # 'D,' debug lines (commanded PWM) are ignored here.
            except (serial.SerialException, ValueError, OSError) as e:
                self.get_logger().warn(f'Serial read error: {e}')
                time.sleep(0.5)

    # ====================================================================
    #  command intake (sets targets only)
    # ====================================================================
    def cmd_vel_callback(self, msg):
        self.last_cmd_time = time.time()
        lin = msg.linear.x
        ang = msg.angular.z

        if not (math.isfinite(lin) and math.isfinite(ang)):
            self.get_logger().warn('Non-finite cmd_vel rejected; stopping.')
            self.target_left_tps = 0.0
            self.target_right_tps = 0.0
            return

        left_vel = lin - (ang * self.wheel_sep / 2.0)
        right_vel = lin + (ang * self.wheel_sep / 2.0)

        left_vel = max(-self.max_wheel_vel, min(self.max_wheel_vel, left_vel))
        right_vel = max(-self.max_wheel_vel, min(self.max_wheel_vel, right_vel))

        self.target_left_tps = self._vel_to_tps(left_vel)
        self.target_right_tps = self._vel_to_tps(right_vel)

    # ====================================================================
    #  control loop: the single serial writer
    # ====================================================================
    def control_loop(self):
        # Watchdog: no recent command -> zero target.
        if time.time() - self.last_cmd_time > self.cmd_timeout:
            self.target_left_tps = 0.0
            self.target_right_tps = 0.0

        # Firmware owns slew + friction floor; send target straight through.
        if abs(self.target_left_tps) < 1e-3 and abs(self.target_right_tps) < 1e-3:
            self.send_stop()
            return

        self.send_velocity(self.target_left_tps, self.target_right_tps)

    def send_velocity(self, left_tps, right_tps):
        """Slot order crosses L/R: slot1 = our RIGHT, slot2 = our LEFT."""
        if self.ser and self.ser.is_open:
            cmd = f"V,{right_tps:.0f},{left_tps:.0f}\n"
            print("TX:", cmd.strip())
            try:
                with self.serial_lock:
                    self.ser.write(cmd.encode())
                self.stopped = False
            except serial.SerialException:
                self.get_logger().warn('Serial write failed')

    def send_stop(self):
        """True stop: firmware 'S' exits PID mode and halts. Idempotent."""
        if self.stopped:
            return
        if self.ser and self.ser.is_open:
            try:
                with self.serial_lock:
                    self.ser.write(b"S\n")
                self.stopped = True
            except serial.SerialException:
                self.get_logger().warn('Serial stop write failed')

    # ====================================================================
    #  odometry
    # ====================================================================
    def odom_timer_callback(self):
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

        raw_dl = left_ticks - self.prev_left_ticks
        raw_dr = right_ticks - self.prev_right_ticks
        dt = (now - self.last_odom_time).nanoseconds / 1e9

        max_ticks = self.max_wheel_vel * self.ticks_per_m * max(dt, 0.02) * 3.0
        if abs(raw_dl) > max_ticks or abs(raw_dr) > max_ticks:
            self.get_logger().warn(
                f'ODOM GLITCH rejected dL={raw_dl} dR={raw_dr} max={max_ticks:.0f} dt={dt:.3f}s')
            return

        delta_left = raw_dl / self.ticks_per_m
        delta_right = raw_dr / self.ticks_per_m
        self.prev_left_ticks = left_ticks
        self.prev_right_ticks = right_ticks

        delta_dist = (delta_left + delta_right) / 2.0
        delta_theta = (delta_right - delta_left) / self.wheel_sep

        self.x += delta_dist * math.cos(self.theta + delta_theta / 2.0)
        self.y += delta_dist * math.sin(self.theta + delta_theta / 2.0)
        self.theta += delta_theta

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

        odom.pose.covariance[0]  = 0.02
        odom.pose.covariance[7]  = 0.02
        odom.pose.covariance[14] = 1e6
        odom.pose.covariance[21] = 1e6
        odom.pose.covariance[28] = 1e6
        odom.pose.covariance[35] = 0.2
        odom.twist.covariance[0]  = 0.01
        odom.twist.covariance[7]  = 1e6
        odom.twist.covariance[14] = 1e6
        odom.twist.covariance[21] = 1e6
        odom.twist.covariance[28] = 1e6
        odom.twist.covariance[35] = 0.1

        self.odom_pub.publish(odom)

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
            try:
                node.ser.write(b"S\n")
            except Exception:
                pass
            node.ser.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
