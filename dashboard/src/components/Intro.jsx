// -----------------------------------------------------------------------------
// Intro.jsx - a short cinematic boot sequence shown once per page load. The ATLAS
// wordmark resolves out of a blurred, wide-tracked state while expanding rings and
// a progress bar play, then the whole overlay fades to reveal the dashboard
// (whose cards are already doing their staggered rise underneath). Self-unmounts
// after the animation so it never blocks interaction.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';

export default function Intro() {
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDone(true), 2600);
    return () => clearTimeout(t);
  }, []);

  if (done) return null;

  return (
    <div className="intro" aria-hidden="true">
      <div className="intro-ring" />
      <div className="intro-ring two" />
      <div className="intro-core">
        <div className="intro-logo">
          Atl<b>a</b>s
        </div>
        <div className="intro-tag">Autonomous Console</div>
        <div className="intro-bar">
          <i />
        </div>
        <div className="intro-status">INITIALIZING TELEMETRY LINK</div>
      </div>
    </div>
  );
}
