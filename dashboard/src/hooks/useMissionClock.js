// -----------------------------------------------------------------------------
// useMissionClock.js - "Mission T+ HH:MM:SS" counting from the first successful
// rosbridge link. Resets if the link drops and re-establishes, so the clock
// reflects the current session rather than wall-clock time.
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';

const fmt = (s) =>
  [Math.floor(s / 3600), Math.floor((s / 60) % 60), Math.floor(s % 60)]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

export function useMissionClock(status) {
  const startRef = useRef(null);
  const [text, setText] = useState('00:00:00');

  useEffect(() => {
    if (status !== 'connected') {
      startRef.current = null;
      return undefined;
    }
    startRef.current = Date.now();
    const id = setInterval(() => {
      setText(fmt((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  return status === 'connected' ? text : '00:00:00';
}
