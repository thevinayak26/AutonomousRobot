#!/usr/bin/env python3
"""
Minimal Nav2 launch — PHASE 1 (goal navigation).
Starts ONLY the 5 core nodes needed to drive to a goal:
  controller_server, planner_server, behavior_server, bt_navigator, velocity_smoother
Plus a lifecycle_manager scoped to exactly those nodes.

Deliberately EXCLUDES collision_monitor and docking_server — the default
nav2_bringup navigation_launch.py includes them, and they hang bringup when
unconfigured. Not needed for Phase 1; costmaps handle obstacle avoidance.

Usage:
  ros2 launch ~/nav2_config/nav2_phase1_launch.py
"""

import os
from launch import LaunchDescription
from launch_ros.actions import Node

# Absolute path to your params file
PARAMS = os.path.expanduser('~/nav2_config/nav2_params.yaml')


def generate_launch_description():
    return LaunchDescription([
        Node(
            package='nav2_controller',
            executable='controller_server',
            name='controller_server',
            output='screen',
            parameters=[PARAMS],
            remappings=[('cmd_vel', 'cmd_vel_nav')],
        ),
        Node(
            package='nav2_planner',
            executable='planner_server',
            name='planner_server',
            output='screen',
            parameters=[PARAMS],
        ),
        Node(
            package='nav2_behaviors',
            executable='behavior_server',
            name='behavior_server',
            output='screen',
            parameters=[PARAMS],
        ),
        Node(
            package='nav2_bt_navigator',
            executable='bt_navigator',
            name='bt_navigator',
            output='screen',
            parameters=[PARAMS],
        ),
        Node(
            package='nav2_velocity_smoother',
            executable='velocity_smoother',
            name='velocity_smoother',
            output='screen',
            parameters=[PARAMS],
            remappings=[('cmd_vel', 'cmd_vel_nav'),
                        ('cmd_vel_smoothed', 'cmd_vel')],
        ),
        Node(
            package='nav2_lifecycle_manager',
            executable='lifecycle_manager',
            name='lifecycle_manager_navigation',
            output='screen',
            parameters=[{
                'autostart': True,
                'node_names': [
                    'controller_server',
                    'planner_server',
                    'behavior_server',
                    'bt_navigator',
                    'velocity_smoother',
                ],
            }],
        ),
    ])
