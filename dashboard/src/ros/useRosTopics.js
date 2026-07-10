// -----------------------------------------------------------------------------
// useRosTopics.js - the live `ros2 topic list` via the rosapi/topics service.
//
// rosapi ships with rosbridge_server, so this needs no robot-side helper: it asks
// rosbridge for the full topic graph on a slow poll (the list rarely changes) and
// returns [{ name, type }] sorted by name. If rosapi is missing the hook degrades
// to an empty list and the card falls back to its known contract topics. Pairs with
// useRosHealth (which uses /rosapi/nodes the same way).
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import * as ROSLIB from 'roslib';

const POLL_MS = 5000;
const EMPTY = { topics: [], ok: false };

export function useRosTopics(ros, status) {
  const [data, setData] = useState(EMPTY);

  useEffect(() => {
    if (status !== 'connected') return undefined;

    const svc = new ROSLIB.Service({
      ros,
      name: '/rosapi/topics',
      serviceType: 'rosapi/Topics',
    });

    let alive = true;
    let timer = null;

    const poll = () => {
      svc.callService(
        {},
        (res) => {
          if (!alive) return;
          const names = res?.topics || [];
          const types = res?.types || [];
          const topics = names
            .map((name, i) => ({ name, type: types[i] || '' }))
            .sort((a, b) => a.name.localeCompare(b.name));
          setData({ topics, ok: true });
          timer = setTimeout(poll, POLL_MS);
        },
        () => {
          if (!alive) return;
          setData((d) => ({ ...d, ok: false }));
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

  // Mirror useRosHealth: surface EMPTY while disconnected without a setState-in-effect.
  return status === 'connected' ? data : EMPTY;
}
