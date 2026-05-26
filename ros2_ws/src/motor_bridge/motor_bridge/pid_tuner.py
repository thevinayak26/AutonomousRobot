#!/usr/bin/env python3
"""
PID Tuning Tool
Lets you adjust Kp, Ki, Kd on the fly and see wheel speed response.
Sends PID gains to Arduino via serial, monitors odom for actual speeds.

Usage:
  ros2 run motor_bridge pid_tuner

Commands (type and press Enter):
  kp 1.2        — set Kp to 1.2
  ki 0.5        — set Ki to 0.5
  kd 0.1        — set Kd to 0.1
  pid 0.8 0.3 0.05  — set all three at once
  test           — run a 5-second forward test at current gains
  spin           — run a 5-second spin test (turn in place)
  stop           — stop motors
  show           — show current PID values
  quit           — exit
"""

import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
import threading
import time
import sys


class PIDTuner(Node):
    def __init__(self):
        super().__init__('pid_tuner')

        self.cmd_pub = self.create_publisher(Twist, '/cmd_vel', 10)
        self.odom_sub = self.create_subscription(
            Odometry, '/odom', self.odom_callback, 10)

        self.current_linear = 0.0
        self.current_angular = 0.0
        self.kp = 0.8
        self.ki = 0.3
        self.kd = 0.05

        # For speed display
        self.display_timer = self.create_timer(0.5, self.display_speeds)
        self.testing = False

        self.get_logger().info('PID Tuner ready')
        self.get_logger().info('Type "help" for commands')
        self.get_logger().info(f'Current PID: Kp={self.kp} Ki={self.ki} Kd={self.kd}')

        # Start input thread
        self.input_thread = threading.Thread(target=self.input_loop, daemon=True)
        self.input_thread.start()

    def odom_callback(self, msg):
        self.current_linear = msg.twist.twist.linear.x
        self.current_angular = msg.twist.twist.angular.z

    def display_speeds(self):
        if self.testing:
            print(f'\r  linear: {self.current_linear:+.3f} m/s | '
                  f'angular: {self.current_angular:+.3f} rad/s    ', end='', flush=True)

    def send_pid_to_arduino(self):
        """Send PID gains via a special topic or directly via serial bridge."""
        # We'll publish a special message that serial_bridge can forward
        # For now, print the command to send manually
        print(f'\n  PID set to: Kp={self.kp} Ki={self.ki} Kd={self.kd}')
        print(f'  To send to Arduino, run in another terminal:')
        print(f'  ros2 topic pub --once /pid_gains geometry_msgs/msg/Vector3 '
              f'"{{x: {self.kp}, y: {self.ki}, z: {self.kd}}}"')
        print(f'  Or via serial monitor: P,{self.kp},{self.ki},{self.kd}')

    def run_test(self, linear, angular, duration):
        """Run a timed drive test."""
        self.testing = True
        print(f'\n  Running test: linear={linear} angular={angular} for {duration}s')
        print(f'  Speeds:')

        cmd = Twist()
        cmd.linear.x = linear
        cmd.angular.z = angular

        start = time.time()
        while time.time() - start < duration:
            self.cmd_pub.publish(cmd)
            time.sleep(0.1)

        # Stop
        self.cmd_pub.publish(Twist())
        self.testing = False
        print(f'\n  Test complete.')

    def input_loop(self):
        """Read commands from stdin."""
        time.sleep(1)  # Wait for node to initialize

        while rclpy.ok():
            try:
                print('\npid_tuner> ', end='', flush=True)
                line = input().strip()
                if not line:
                    continue

                parts = line.split()
                cmd = parts[0].lower()

                if cmd == 'kp' and len(parts) == 2:
                    self.kp = float(parts[1])
                    self.send_pid_to_arduino()

                elif cmd == 'ki' and len(parts) == 2:
                    self.ki = float(parts[1])
                    self.send_pid_to_arduino()

                elif cmd == 'kd' and len(parts) == 2:
                    self.kd = float(parts[1])
                    self.send_pid_to_arduino()

                elif cmd == 'pid' and len(parts) == 4:
                    self.kp = float(parts[1])
                    self.ki = float(parts[2])
                    self.kd = float(parts[3])
                    self.send_pid_to_arduino()

                elif cmd == 'test':
                    duration = float(parts[1]) if len(parts) > 1 else 5.0
                    self.run_test(0.15, 0.0, duration)

                elif cmd == 'spin':
                    duration = float(parts[1]) if len(parts) > 1 else 5.0
                    self.run_test(0.0, 0.5, duration)

                elif cmd == 'drive':
                    if len(parts) >= 3:
                        lin = float(parts[1])
                        ang = float(parts[2])
                        dur = float(parts[3]) if len(parts) > 3 else 5.0
                        self.run_test(lin, ang, dur)
                    else:
                        print('  Usage: drive <linear> <angular> [duration]')

                elif cmd == 'stop':
                    self.cmd_pub.publish(Twist())
                    self.testing = False
                    print('  Motors stopped.')

                elif cmd == 'show':
                    print(f'  Kp={self.kp} Ki={self.ki} Kd={self.kd}')
                    print(f'  linear: {self.current_linear:.3f} m/s')
                    print(f'  angular: {self.current_angular:.3f} rad/s')

                elif cmd in ['quit', 'exit', 'q']:
                    self.cmd_pub.publish(Twist())
                    print('  Bye!')
                    rclpy.shutdown()
                    return

                elif cmd == 'help':
                    print('  Commands:')
                    print('    kp <val>              — set Kp')
                    print('    ki <val>              — set Ki')
                    print('    kd <val>              — set Kd')
                    print('    pid <kp> <ki> <kd>    — set all three')
                    print('    test [duration]       — drive forward test')
                    print('    spin [duration]       — turn in place test')
                    print('    drive <lin> <ang> [s]  — custom drive test')
                    print('    stop                  — stop motors')
                    print('    show                  — show current values')
                    print('    quit                  — exit')

                else:
                    print(f'  Unknown command: {cmd}. Type "help".')

            except (ValueError, IndexError) as e:
                print(f'  Error: {e}')
            except EOFError:
                break


def main():
    rclpy.init()
    node = PIDTuner()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.cmd_pub.publish(Twist())
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
