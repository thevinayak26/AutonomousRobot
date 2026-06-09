from launch import LaunchDescription
from launch_ros.actions import Node
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from ament_index_python.packages import get_package_share_directory
import os

def generate_launch_description():
    return LaunchDescription([
        # Serial bridge (Arduino communication)
        Node(
            package='motor_bridge',
            executable='serial_bridge',
            name='serial_bridge',
            parameters=[{
                'port': '/dev/ttyACM0',
                'baud': 115200,
                'wheel_separation': 0.247,
                'ticks_per_metre': 5030.0,
                'max_pwm': 180,
                'max_linear_vel': 0.22,
                'max_angular_vel': 2.84,
            }],
            output='screen',
        ),

        # RPLiDAR
        Node(
            package='rplidar_ros',
            executable='rplidar_node',
            name='rplidar_node',
            parameters=[{
                'serial_port': '/dev/ttyUSB0',
                'serial_baudrate': 115200,
                'frame_id': 'laser',
                'angle_compensate': True,
            }],
            output='screen',
        ),

        # Static transform: base_link to laser
        Node(
            package='tf2_ros',
            executable='static_transform_publisher',
            arguments=['0', '0', '0.15', '0', '0', '0', 'base_link', 'laser'],
            output='screen',
        ),

        # SLAM Toolbox
        Node(
            package='slam_toolbox',
            executable='async_slam_toolbox_node',
            name='slam_toolbox',
            parameters=[{
                'use_sim_time': False,
                'base_frame': 'base_link',
                'odom_frame': 'odom',
                'map_frame': 'map',
            }],
            output='screen',
        ),

        # Foxglove Bridge (dashboard access)
        Node(
            package='foxglove_bridge',
            executable='foxglove_bridge',
            name='foxglove_bridge',
            output='screen',
        ),
    ])
