#!/bin/bash
pkill -f '[r]os2'; pkill -f '[s]lam_toolbox'; pkill -f '[n]av2'; pkill -f '[s]emantic'
sleep 2
sudo rm -f /dev/shm/fastrtps_*
sudo fuser -k 8080/tcp 2>/dev/null
source /opt/ros/jazzy/setup.bash

echo 'Bringup + Camera'
bash ~/start_robot.sh --camera &
sleep 25
ros2 topic list | grep -q /map && echo '/map OK' || echo 'WARN: /map not up'

echo 'Nav2'
ros2 launch ~/nav2_config/nav2_phase1_launch.py &
sleep 15

echo 'Semantic'
python3 ~/semantic_obstacles_node.py &
sleep 5

echo 'Node list'
ros2 node list
echo 'Pi stack up. Ctrl-C here kills EVERYTHING (all children).'
wait
