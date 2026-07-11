"""
observability.py -- ROS-free observability logic for ATLAS Option 3.

Departure evidence must accrue only while an object is OBSERVABLE:
    observable = in_frustum(pose, obj) AND NOT occluded(scan, pose, obj)

Integration contract with semantic_obstacles_node.py:
  - Each tick, per object: obs = observable(pose, o["x"], o["y"], ranges, meta)
    then o["t_obs"] = accrue_observable_gap(o, now, dt, obs)
  - Branches 2-3 compare o["t_obs"] instead of wall-clock gap.
  - Node resets o["t_obs"] = 0.0 wherever t_last resets.

Conventions: pose = (x, y, yaw) map frame, REP-103. scan_meta =
(angle_min, angle_increment, range_min, range_max). LiDAR yaw-aligned
with base_link (yaw=0 per start_robot.sh post-realignment).
"""

import math

HFOV_DEG = 55.0          # Logitech C270 horizontal FOV
HALF_HFOV = math.radians(HFOV_DEG) / 2.0
MAX_DET_RANGE = 5.0
OCCLUSION_MARGIN = 0.4   # scan must be this much CLOSER than object
OCCLUSION_BEAM_HALF_ANGLE = math.radians(4.0)
MIN_OCCLUDING_BEAMS = 2  # 1 lone closer beam = noise


def wrap_angle(a):
    while a <= -math.pi:
        a += 2.0 * math.pi
    while a > math.pi:
        a -= 2.0 * math.pi
    return a


def bearing_range(pose, ox, oy):
    px, py, pyaw = pose
    dx = ox - px
    dy = oy - py
    rng = math.hypot(dx, dy)
    brg = wrap_angle(math.atan2(dy, dx) - pyaw)
    return brg, rng


def in_frustum(pose, ox, oy, half_hfov=HALF_HFOV, max_range=MAX_DET_RANGE):
    brg, rng = bearing_range(pose, ox, oy)
    if rng > max_range:
        return False
    return abs(brg) <= half_hfov


def occluded(pose, ox, oy, scan_ranges, scan_meta,
             lidar_yaw_offset=0.0,
             margin=OCCLUSION_MARGIN,
             beam_half_angle=OCCLUSION_BEAM_HALF_ANGLE,
             min_beams=MIN_OCCLUDING_BEAMS):
    """Conservative: empty scan / no valid beams at bearing => True
    (treat as occluded, never fabricate departure evidence)."""
    if not scan_ranges:
        return True
    angle_min, angle_inc, range_min, range_max = scan_meta
    if angle_inc == 0.0:
        return True

    brg, rng = bearing_range(pose, ox, oy)
    beam_brg = wrap_angle(brg - lidar_yaw_offset)

    n = len(scan_ranges)
    lo = beam_brg - beam_half_angle
    hi = beam_brg + beam_half_angle
    i_lo = int(math.floor((lo - angle_min) / angle_inc))
    i_hi = int(math.ceil((hi - angle_min) / angle_inc))

    closer = 0
    valid = 0
    for i in range(i_lo, i_hi + 1):
        idx = i % n
        r = scan_ranges[idx]
        if r is None or math.isnan(r) or math.isinf(r):
            continue
        if r < range_min or r > range_max:
            continue
        valid += 1
        if r < rng - margin:
            closer += 1
    if valid == 0:
        return True
    return closer >= min_beams


def observable(pose, ox, oy, scan_ranges, scan_meta, lidar_yaw_offset=0.0):
    if pose is None:
        return False
    if not in_frustum(pose, ox, oy):
        return False
    return not occluded(pose, ox, oy, scan_ranges, scan_meta,
                        lidar_yaw_offset=lidar_yaw_offset)


def accrue_observable_gap(obj, now, dt, is_observable):
    t_obs = obj.get("t_obs", 0.0)
    if is_observable:
        t_obs += dt
    return t_obs
