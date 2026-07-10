// -----------------------------------------------------------------------------
// useRobotData.js - the telemetry aggregation hook (spec §6/§7/§10).
//
// Subscribes ONCE to the high-rate motion/health topics that the text tiles need
// (/odom, /imu/data, /sys_stats) and accumulates the latest values in refs. A
// single 5 Hz sampler then publishes one React snapshot, so a 20 Hz odom stream
// can't trigger 20 re-renders/sec across the dashboard (§10 "don't re-render
// every frame"). The map keeps its own raw subscriptions for 60 fps canvas work;
// nothing here is subscribed twice.
//
// Everything returned is derived from REAL messages - no synthetic numbers. When
// a topic is silent the corresponding field stays null/false so tiles can show an
// honest "-" instead of a fake reading (Golden Rule 1, spec §1).
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import * as ROSLIB from 'roslib';
import { TOPICS } from './topics';
import { quatToYaw } from '../lib/geometry';

const SAMPLE_HZ = 5;
const MOVING_EPS = 0.02; // m/s below which we call the robot stopped

// Rate estimator that COUNTS messages in a trailing window (the method `ros2 topic
// hz` uses) — NOT an EMA of instantaneous 1/dt. Websocket delivery is bursty:
// several messages arrive in one event-loop tick (dt ~1-3 ms -> 1/dt ~300-1000 Hz),
// then a gap. Averaging 1/dt over-weights those tiny gaps, so a true 30 Hz stream
// read as 365-970 Hz and a 7 Hz LiDAR as ~285. Counting over a fixed window is
// immune to that burstiness and reports the real throughput.
function makeRate(win = 1000) {
  const stamps = []; // arrival times (ms), oldest first
  return {
    tick(now) {
      stamps.push(now);
      if (stamps.length > 600) stamps.splice(0, stamps.length - 600); // bound memory
    },
    valueAt(now) {
      while (stamps.length && now - stamps[0] > win) stamps.shift();
      if (stamps.length < 2) return 0;
      const span = (stamps[stamps.length - 1] - stamps[0]) / 1000;
      return span > 0 ? (stamps.length - 1) / span : 0;
    },
    stale(now, ms = 1500) {
      return !stamps.length || now - stamps[stamps.length - 1] > ms;
    },
  };
}

const EMPTY = {
  vel: null,
  dist: null,
  yaw: null,
  gyroZ: null,
  cpu: null,
  mem: null,
  uptime: null,
  odomHz: null,
  imuOk: false,
  odomOk: false,
  sysOk: false,
  moving: false,
};

export function useRobotData(ros, status) {
  const [data, setData] = useState(EMPTY);

  // Mutable accumulators (don't trigger renders) ----------------------------
  const last = useRef({
    vel: 0,
    dist: 0,
    yawOdom: null,
    yawImu: null,
    gyroZ: null,
    cpu: null,
    mem: null,
    uptime: null,
    px: null,
    py: null,
  });
  const odomRate = useRef(makeRate());
  const imuRate = useRef(makeRate());
  const sysRate = useRef(makeRate());

  useEffect(() => {
    if (status !== 'connected') return undefined;

    const odom = new ROSLIB.Topic({
      ros,
      name: TOPICS.odom.name,
      messageType: TOPICS.odom.type,
      // 25 ms ceiling (40 Hz) so the full ~30 Hz EKF stream gets through and the
      // measured rate matches the configured rate. The 5 Hz sampler still gates
      // re-renders, so this only feeds the rate counter + distance integration.
      throttle_rate: 25,
      queue_length: 1,
    });
    const imu = new ROSLIB.Topic({
      ros,
      name: TOPICS.imu.name,
      messageType: TOPICS.imu.type,
      throttle_rate: 50,
      queue_length: 1,
    });
    const sys = new ROSLIB.Topic({
      ros,
      name: TOPICS.sysStats.name,
      messageType: TOPICS.sysStats.type,
    });

    odom.subscribe((msg) => {
      odomRate.current.tick(performance.now());
      const lin = msg.twist?.twist?.linear;
      const pos = msg.pose?.pose?.position;
      const L = last.current;
      if (lin) L.vel = Math.hypot(lin.x || 0, lin.y || 0);
      if (pos) {
        if (L.px !== null) L.dist += Math.hypot(pos.x - L.px, pos.y - L.py);
        L.px = pos.x;
        L.py = pos.y;
      }
      L.yawOdom = quatToYaw(msg.pose?.pose?.orientation);
    });

    imu.subscribe((msg) => {
      imuRate.current.tick(performance.now());
      last.current.yawImu = quatToYaw(msg.orientation);
      last.current.gyroZ = msg.angular_velocity?.z ?? null;
    });

    sys.subscribe((msg) => {
      sysRate.current.tick(performance.now());
      try {
        const j = JSON.parse(msg.data);
        last.current.cpu = j.cpu ?? null;
        last.current.mem = j.mem ?? null;
        last.current.uptime = j.uptime_s ?? null;
      } catch {
        /* non-JSON /sys_stats payload - ignore rather than crash a tile */
      }
    });

    // One sampler → one snapshot per tick.
    const id = setInterval(() => {
      const now = performance.now();
      const L = last.current;
      const odomOk = !odomRate.current.stale(now);
      const imuOk = !imuRate.current.stale(now);
      const sysOk = !sysRate.current.stale(now, 3000);
      // Prefer IMU heading (it's the fused source); fall back to odom.
      const yaw = imuOk ? L.yawImu : L.yawOdom;
      setData({
        vel: odomOk ? L.vel : null,
        dist: L.dist,
        yaw: yaw ?? null,
        gyroZ: imuOk ? L.gyroZ : null,
        cpu: sysOk ? L.cpu : null,
        mem: sysOk ? L.mem : null,
        uptime: sysOk ? L.uptime : null,
        odomHz: odomOk ? odomRate.current.valueAt(now) : null,
        imuOk,
        odomOk,
        sysOk,
        moving: odomOk && L.vel > MOVING_EPS,
      });
    }, 1000 / SAMPLE_HZ);

    return () => {
      clearInterval(id);
      try { odom.unsubscribe(); } catch { /* socket gone */ }
      try { imu.unsubscribe(); } catch { /* socket gone */ }
      try { sys.unsubscribe(); } catch { /* socket gone */ }
    };
  }, [ros, status]);

  // When the link is down, present the empty snapshot rather than stale numbers.
  return status === 'connected' ? data : EMPTY;
}
