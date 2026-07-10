// -----------------------------------------------------------------------------
// useRosHealth.js - System-Health tile data sourced from REAL rosbridge state.
//
// Calls the rosapi service /rosapi/nodes on a 2 s poll. The response gives the
// live ROS node list (real "N nodes up"), and timing the round-trip gives a real
// link-latency figure - no invented "12 ms". rosapi ships with rosbridge_server
// by default; if it's somehow absent the hook degrades to nulls and the tile
// shows "-" rather than guessing.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import * as ROSLIB from 'roslib';

const POLL_MS = 1500;   // a touch faster than the old 2 s so the meter reads "live"
const HIST_MAX = 40;    // samples kept for the latency sparkline (~1 min @ 1.5 s)

const EMPTY = { latencyMs: null, nodes: [], nodeCount: null, ok: false, history: [] };

export function useRosHealth(ros, status) {
  const [health, setHealth] = useState(EMPTY);

  useEffect(() => {
    if (status !== 'connected') return undefined;

    const nodesSvc = new ROSLIB.Service({
      ros,
      name: '/rosapi/nodes',
      serviceType: 'rosapi/Nodes',
    });

    let alive = true;
    let timer = null;
    let hist = []; // rolling latency samples (null = a failed/timed-out poll = gap)

    const poll = () => {
      const t0 = performance.now();
      // roslib v2 dropped ROSLIB.ServiceRequest - callService takes a plain object.
      nodesSvc.callService(
        {},
        (res) => {
          if (!alive) return;
          const latencyMs = Math.round(performance.now() - t0);
          hist = [...hist, latencyMs].slice(-HIST_MAX);
          const nodes = res?.nodes || [];
          setHealth({ latencyMs, nodes, nodeCount: nodes.length, ok: true, history: hist });
          timer = setTimeout(poll, POLL_MS);
        },
        () => {
          if (!alive) return;
          hist = [...hist, null].slice(-HIST_MAX);
          setHealth((h) => ({ ...h, ok: false, history: hist }));
          timer = setTimeout(poll, POLL_MS);
        }
      );
    };
    poll();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ros, status]);

  return status === 'connected' ? health : EMPTY;
}
