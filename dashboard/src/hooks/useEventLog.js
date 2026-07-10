// -----------------------------------------------------------------------------
// useEventLog.js - the Event Stream tile, driven by REAL state transitions.
//
// The mockup invented random log lines; that would be dishonest on a live
// console (spec §1). Instead we watch the actual signals and emit an event only
// when something genuinely changes: link up/down, coverage crossing a milestone,
// and the robot starting or stopping. Every line corresponds to a real event.
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';

const MAX = 7;
const MILESTONES = [10, 25, 50, 75, 90];

// 24-hour wall-clock HH:MM:SS. The old MM:SS dropped the hour and read like a
// mission countdown (it sat right under the "Mission T+" clock), so a real wall
// time looked wrong / ambiguous — two events an hour apart printed identically.
// A full local clock time is unmistakably a timestamp.
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function useEventLog({ status, coverage, moving }) {
  const [events, setEvents] = useState([]);
  const seq = useRef(0);
  const prev = useRef({ status: null, milestone: 0, moving: null });

  const push = (type, msg) => {
    seq.current += 1;
    const ev = { id: seq.current, ts: stamp(), type, msg };
    setEvents((list) => [...list, ev].slice(-MAX));
  };

  // Link state transitions.
  useEffect(() => {
    const p = prev.current;
    if (p.status === status) return;
    if (status === 'connected') push('ok', 'rosbridge linked - telemetry live');
    else if (p.status === 'connected' && (status === 'down' || status === 'reconnecting'))
      push('alert', 'Link lost - reconnecting');
    p.status = status;
    if (status !== 'connected') {
      p.milestone = 0;
      p.moving = null;
    }
  }, [status]);

  // Coverage milestones (only forward, only once each).
  useEffect(() => {
    if (status !== 'connected' || coverage == null) return;
    const next = MILESTONES.filter((m) => m > prev.current.milestone && coverage >= m).pop();
    if (next) {
      prev.current.milestone = next;
      push('info', `Coverage milestone · ${next}%`);
    }
  }, [coverage, status]);

  // Motion start / stop.
  useEffect(() => {
    if (status !== 'connected') return;
    const p = prev.current;
    if (p.moving === moving) return;
    if (p.moving !== null) push(moving ? 'ok' : 'warn', moving ? 'Resumed exploration' : 'Robot idle - holding position');
    p.moving = moving;
  }, [moving, status]);

  return events;
}
