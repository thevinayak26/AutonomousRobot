// -----------------------------------------------------------------------------
// topics.js - THE single source of truth for every topic name / type.
// (DASHBOARD_BUILD_SPEC §6 contract + §4 networking.) Change a name here once and
// every tile that uses it follows. Names marked TBD are the *intended* contract;
// confirm against the rosbag / `ros2 topic list -t` and update here when firmware
// or later features land - no other file should hardcode a topic name.
// -----------------------------------------------------------------------------

// Derive the host from where the page was served, NOT hardcoded localhost - on a
// phone "localhost" is the phone (spec §4). Allow ?host=… override for dev.
const params = new URLSearchParams(window.location.search);
export const HOST =
  params.get('host') || window.location.hostname || 'localhost';

export const ROSBRIDGE_PORT = 9090;
export const VIDEO_PORT = 8080;   // Pi web_video_server (RAW /image_raw)
export const ANNOT_PORT = 8081;   // laptop fusion node (annotated YOLO MJPEG)

export const ROSBRIDGE_URL = `ws://${HOST}:${ROSBRIDGE_PORT}`;

// Camera host is SEPARATE from the ROS host: the annotated feed is served by the
// laptop fusion node, not the Pi. Default to wherever the dashboard is served from
// (the laptop runs both Vite and the :8081 server), overridable with ?camhost=.
export const CAM_HOST = params.get('camhost') || window.location.hostname || 'localhost';

// DEFAULT camera source: the laptop's annotated (boxed) MJPEG on :8081. This is also
// the fix for the one-consumer rule - the dashboard reads the laptop, and the fusion
// node stays the SOLE consumer of the Pi :8080.
export const annotatedUrl = () => `http://${CAM_HOST}:${ANNOT_PORT}/stream`;
// RAW Pi feed - fallback ONLY. Opening this adds a 2nd consumer of the Pi :8080 while
// fusion runs, which saturates a Pi core, so it is gated behind an explicit toggle.
export const rawCameraUrl = (topic = TOPICS.camera.name) =>
  `http://${HOST}:${VIDEO_PORT}/stream?topic=${topic}`;

// status: 'live'   - expected to be publishing now (Week 3 honest state, §1)
//         'node'   - needs one of our helper nodes (§5) running
//         'later'  - hardware/feature not built yet; tile shows offline placeholder
export const TOPICS = {
  map:        { name: '/map',        type: 'nav_msgs/OccupancyGrid',    status: 'live' },
  scan:       { name: '/scan',       type: 'sensor_msgs/LaserScan',     status: 'live' },
  // EKF (robot_localization) fused output - this is what the dashboard reads for
  // velocity / distance / heading. Raw wheel odom is /odom/wheel; bare /odom may not
  // be published at all. If velocity stays blank on the real robot, run
  // `ros2 topic list -t` and set this to whatever the EKF actually publishes.
  odom:       { name: '/odometry/filtered', type: 'nav_msgs/Odometry',  status: 'live' },
  imu:        { name: '/imu/data',   type: 'sensor_msgs/Imu',           status: 'live' },
  robotPose:  { name: '/robot_pose', type: 'geometry_msgs/PoseStamped', status: 'node' },  // §5a
  sysStats:   { name: '/sys_stats',  type: 'std_msgs/String',           status: 'node' },  // §5b (JSON)
  // Nav2 global plan - drawn as the planned route overlay on the map (pose-free,
  // it's already in the map frame). Only shows when Nav2 is navigating to a goal.
  plan:       { name: '/plan',       type: 'nav_msgs/Path',             status: 'live' },
  // Manual WASD teleop publishes here (the same topic teleop_twist_keyboard uses);
  // the robot's velocity bridge already subscribes to /cmd_vel.
  cmdVel:     { name: '/cmd_vel',    type: 'geometry_msgs/Twist',       status: 'live' },
  // Tap-to-navigate publishes a single Nav2 goal here (map frame). Same topic
  // RViz's "2D Nav Goal" uses; only meaningful while Nav2 is running (otherwise it
  // simply has no subscriber). Gated behind the map's nav-goal toggle.
  goal:       { name: '/goal_pose',  type: 'geometry_msgs/PoseStamped', status: 'live' },
  // TF tree - the map overlay composes map->odom->base_link from these to place the
  // robot + LiDAR scan in the map frame (so the scan shows ON the map without needing
  // a separate /robot_pose publisher). /tf_static is latched.
  tf:         { name: '/tf',         type: 'tf2_msgs/TFMessage',        status: 'live' },
  tfStatic:   { name: '/tf_static',  type: 'tf2_msgs/TFMessage',        status: 'live' },

  // Nav2 costmaps - both are LATCHED (transient_local) full grids: the Pi's Nav2
  // sets always_send_full_costmap:true, so complete OccupancyGrids stream at
  // publish_frequency. The dashboard overlays them on the map (see MapCanvas);
  // subscriptions are created only while the layer toggle is ON, so a hidden
  // overlay costs the Pi zero serialisation. Global is map frame; LOCAL is the
  // odom frame rolling window (expected to offset from /map by the 1-3 s WiFi
  // map->odom lag while driving - a frame artifact, not a bug).
  globalCostmap:  { name: '/global_costmap/costmap', type: 'nav_msgs/OccupancyGrid', status: 'live' },
  localCostmap:   { name: '/local_costmap/costmap',  type: 'nav_msgs/OccupancyGrid', status: 'live' },

  camera:         { name: '/image_raw',        type: 'sensor_msgs/Image', status: 'live' },
  // Semantic detections from the laptop fusion node (YOLO + LiDAR range → map xy),
  // std_msgs/String JSON. The dashboard mirrors the Pi's TTL store (see lib/semantic.js).
  detected:       { name: '/detected_objects',  type: 'std_msgs/String',   status: 'node' },

  // Not yet available - render honest "awaiting/offline" placeholders (§1, §4).
  ultrasonicLow:  { name: '/ultrasonic/front',  type: 'sensor_msgs/Range', status: 'later' },
  ultrasonicCliff:{ name: '/ultrasonic/cliff',  type: 'sensor_msgs/Range', status: 'later' },
};

// rosbridge QoS hints (spec §7/§10): /map is transient-local (latched) and large.
// QoS note: the rosbridge protocol has no per-subscription QoS field; durability
// matching happens SERVER-side - rosbridge (Jazzy) inspects the publisher's QoS
// and subscribes transient_local to latched topics automatically. That is how the
// live /map already reaches this dashboard; the costmaps ride the same mechanism.
// throttle_rate: 500 caps each costmap at <=2 Hz on the wire (perf budget).
export const SUB_OPTS = {
  map:     { throttle_rate: 250, queue_length: 1 },
  scan:    { throttle_rate: 100, queue_length: 1 },
  plan:    { throttle_rate: 200, queue_length: 1 },
  costmap: { throttle_rate: 500, queue_length: 1 },
};

// SLAM-toolbox map-save service (saves <name>.pgm + <name>.yaml on the robot). If
// the stack isn't slam_toolbox, point this at the relevant SaveMap service instead.
// Nav2 goal cancel. ROS 2 actions are services under the hood: this is
// NavigateToPose's hidden cancel service; an all-zero uuid + zero stamp means
// "cancel EVERY active goal". Called by the map's cancel-goal button.
export const CANCEL_NAV_SERVICE = {
  name: '/navigate_to_pose/_action/cancel_goal',
  type: 'action_msgs/srv/CancelGoal',
};

export const SAVE_MAP_SERVICE = {
  name: '/slam_toolbox/save_map',
  type: 'slam_toolbox/SaveMap',
};
