#!/bin/bash
# ROBOT STARTUP SCRIPT — Run this on the Pi after SSH
# Usage:
#   bash ~/start_robot.sh                  — base system only (teleop from laptop)
#   bash ~/start_robot.sh --safe           — base + safety layer (teleop with collision avoidance)
#   bash ~/start_robot.sh --explore        — base + safety + autonomous frontier exploration
#   bash ~/start_robot.sh --benchmark      — base + coverage benchmark (drive manually)
#   bash ~/start_robot.sh --explore --benchmark  — autonomous + benchmark
#
# Press Ctrl+C to stop everything.

set -e

# Parse flags
USE_SAFETY=false
USE_EXPLORE=false
USE_BENCHMARK=false

for arg in "$@"; do
    case $arg in
        --safe)     USE_SAFETY=true ;;
        --explore)  USE_SAFETY=true; USE_EXPLORE=true ;;
        --benchmark) USE_BENCHMARK=true ;;
    esac
done

echo "============================================"
echo "  AUTONOMOUS NAVIGATION ROBOT - STARTING"
echo "============================================"
echo ""

if $USE_EXPLORE; then
    echo "  Mode: AUTONOMOUS EXPLORATION"
elif $USE_SAFETY; then
    echo "  Mode: TELEOP WITH SAFETY"
else
    echo "  Mode: BASIC TELEOP"
fi
if $USE_BENCHMARK; then
    echo "  Benchmark: ENABLED"
fi
echo ""

# Step 0: Sync clock via NTP (needs internet/WiFi)
echo "[1/7] Syncing clock..."
sudo timedatectl set-ntp true 2>/dev/null
sleep 2
if timedatectl show | grep -q "NTPSynchronized=yes"; then
    echo "      Clock synced via NTP: $(date)"
else
    echo "      WARNING: NTP sync failed. Time may be wrong: $(date)"
    echo "      Run from laptop: ssh ubuntu@PI_IP \"echo 'ubuntu123' | sudo -S date -s '\$(date -u)'\""
fi
echo ""

# Step 1: Source ROS
echo "[2/7] Sourcing ROS 2 Jazzy..."
source /opt/ros/jazzy/setup.bash
source ~/ros2_ws/install/setup.bash
echo "      Done."
echo ""

# Step 2: Create slam params if missing
echo "[3/7] Checking SLAM params..."
if [ ! -f /tmp/slam_params.yaml ]; then
    cat > /tmp/slam_params.yaml << 'EOF'
slam_toolbox:
  ros__parameters:
    solver_plugin: solver_plugins::CeresSolver
    ceres_linear_solver: SPARSE_NORMAL_CHOLESKY
    ceres_preconditioner: SCHUR_JACOBI
    ceres_trust_strategy: LEVENBERG_MARQUARDT
    ceres_dogleg_type: TRADITIONAL_DOGLEG
    ceres_loss_function: None
    odom_frame: odom
    map_frame: map
    base_frame: base_link
    scan_topic: /scan
    mode: mapping
    debug_logging: false
    throttle_scans: 1
    transform_publish_period: 0.02
    map_update_interval: 2.0
    resolution: 0.05
    max_laser_range: 12.0
    minimum_time_interval: 0.5
    transform_timeout: 0.2
    tf_buffer_duration: 30.0
    stack_size_to_use: 40000000
    use_scan_matching: true
    use_scan_barycenter: true
    minimum_travel_distance: 0.1
    minimum_travel_heading: 0.1
    scan_buffer_size: 10
    scan_buffer_maximum_scan_distance: 10.0
    link_match_minimum_response_fine: 0.1
    link_scan_maximum_distance: 1.5
    loop_search_maximum_distance: 3.0
    do_loop_closing: true
    loop_match_minimum_chain_size: 10
    loop_match_maximum_variance_coarse: 3.0
    loop_match_minimum_response_coarse: 0.35
    loop_match_minimum_response_fine: 0.45
    correlation_search_space_dimension: 0.5
    correlation_search_space_resolution: 0.01
    correlation_search_space_smear_deviation: 0.1
    loop_search_space_dimension: 8.0
    loop_search_space_resolution: 0.05
    loop_search_space_smear_deviation: 0.03
    distance_variance_penalty: 0.5
    angle_variance_penalty: 1.0
    fine_search_angle_offset: 0.00349
    coarse_search_angle_offset: 0.349
    coarse_angle_resolution: 0.0349
    minimum_angle_penalty: 0.9
    minimum_distance_penalty: 0.5
    use_response_expansion: true
EOF
    echo "      Created /tmp/slam_params.yaml"
else
    echo "      Already exists."
fi
echo ""

# Step 3: Set permissions
echo "[4/7] Setting device permissions..."
sudo chmod 666 /dev/ttyACM0 2>/dev/null && echo "      /dev/ttyACM0 ready (Arduino)" || echo "      WARNING: /dev/ttyACM0 not found — is Arduino plugged in?"
sudo chmod 666 /dev/ttyUSB0 2>/dev/null && echo "      /dev/ttyUSB0 ready (LiDAR)" || echo "      WARNING: /dev/ttyUSB0 not found — is LiDAR plugged in?"
echo ""

# Step 4: Kill any leftover ROS nodes from previous runs
echo "[5/7] Cleaning up old processes..."
pkill -f serial_bridge 2>/dev/null || true
pkill -f rplidar 2>/dev/null || true
pkill -f slam_toolbox 2>/dev/null || true
pkill -f static_transform_publisher 2>/dev/null || true
pkill -f safety_layer 2>/dev/null || true
pkill -f frontier_explorer 2>/dev/null || true
pkill -f coverage_benchmark 2>/dev/null || true
sleep 2
echo "      Done."
echo ""

# Step 5: Launch core nodes
echo "[6/7] Starting core ROS nodes..."
echo ""

# Serial bridge
echo "      Starting serial_bridge..."
ros2 run motor_bridge serial_bridge &
SERIAL_PID=$!
sleep 3

# LiDAR
echo "      Starting LiDAR..."
ros2 run rplidar_ros rplidar_composition --ros-args -p serial_port:=/dev/ttyUSB0 -p serial_baudrate:=115200 -p scan_mode:=Standard &
LIDAR_PID=$!
sleep 3

# Static transform
echo "      Starting static transform (base_link -> laser_frame)..."
ros2 run tf2_ros static_transform_publisher 0 0 0.15 0 0 0 base_link laser_frame &
TF_PID=$!
sleep 2

# SLAM
echo "      Starting SLAM..."
ros2 run slam_toolbox async_slam_toolbox_node --ros-args --params-file /tmp/slam_params.yaml &
SLAM_PID=$!
sleep 10

# Activate SLAM lifecycle
echo "      Activating SLAM..."
ros2 lifecycle set /slam_toolbox configure
sleep 2
ros2 lifecycle set /slam_toolbox activate
sleep 2

# Track extra PIDs
SAFETY_PID=""
EXPLORE_PID=""
BENCH_PID=""

# Step 6: Launch optional nodes
echo "[7/7] Starting optional nodes..."
echo ""

if $USE_SAFETY; then
    echo "      Starting safety layer..."
    ros2 run motor_bridge safety_layer &
    SAFETY_PID=$!
    sleep 1
fi

if $USE_EXPLORE; then
    echo "      Starting frontier explorer..."
    ros2 run motor_bridge frontier_explorer --ros-args -r cmd_vel:=cmd_vel_raw &
    EXPLORE_PID=$!
    sleep 1
fi

if $USE_BENCHMARK; then
    echo "      Starting coverage benchmark..."
    ros2 run motor_bridge coverage_benchmark &
    BENCH_PID=$!
    sleep 1
fi

echo ""
echo "============================================"
echo "  ALL NODES RUNNING"
echo "============================================"
echo ""
echo "  Serial Bridge : PID $SERIAL_PID"
echo "  LiDAR         : PID $LIDAR_PID"
echo "  Static TF     : PID $TF_PID"
echo "  SLAM          : PID $SLAM_PID"
[ -n "$SAFETY_PID" ]  && echo "  Safety Layer  : PID $SAFETY_PID"
[ -n "$EXPLORE_PID" ] && echo "  Explorer      : PID $EXPLORE_PID"
[ -n "$BENCH_PID" ]   && echo "  Benchmark     : PID $BENCH_PID"
echo ""

if $USE_EXPLORE; then
    echo "  Robot will explore autonomously!"
    echo "  Press Ctrl+C to stop."
elif $USE_SAFETY; then
    echo "  On your LAPTOP, run:"
    echo "    ros2 run teleop_twist_keyboard teleop_twist_keyboard --ros-args -r cmd_vel:=cmd_vel_raw"
    echo "  (publishes to cmd_vel_raw, safety layer filters to cmd_vel)"
else
    echo "  On your LAPTOP, run:"
    echo "    rviz2                                    (visualize map)"
    echo "    ros2 run teleop_twist_keyboard teleop_twist_keyboard  (drive)"
fi
echo ""
echo "  Press Ctrl+C to stop everything."
echo "============================================"
echo ""

# Trap Ctrl+C to kill all background nodes
cleanup() {
    echo ""
    echo "Stopping all nodes..."
    kill $SERIAL_PID $LIDAR_PID $TF_PID $SLAM_PID $SAFETY_PID $EXPLORE_PID $BENCH_PID 2>/dev/null
    wait $SERIAL_PID $LIDAR_PID $TF_PID $SLAM_PID $SAFETY_PID $EXPLORE_PID $BENCH_PID 2>/dev/null
    echo "All nodes stopped."
    exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for any background process to exit
wait
