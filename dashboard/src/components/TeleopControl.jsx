// -----------------------------------------------------------------------------
// TeleopControl.jsx - game-style WASD manual driving (opt-in).
//
// A floating "Drive" toggle. ONLY while it is on does the page capture the keyboard
// and publish geometry_msgs/Twist to /cmd_vel (the same topic teleop_twist_keyboard
// uses), so normal use never hijacks your keys. Hold W/A/S/D (or the arrow keys) to
// drive, Shift to boost, Space for an immediate stop. A Twist is published at a steady
// rate while keys are held; releasing everything (or toggling off, or the window
// losing focus) publishes a zero Twist so the robot always stops. A live HUD shows the
// pressed keys and the current linear/angular command.
//
// Safety: this drives the real robot. Don't run it while Nav2 is autonomously
// navigating (both would fight over /cmd_vel). Speeds are deliberately gentle.
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import * as ROSLIB from 'roslib';
import { TOPICS } from '../ros/topics';

const LIN = 0.18;   // m/s   base forward/back speed
const ANG = 0.6;    // rad/s base turn rate
const BOOST = 1.7;  // Shift multiplier
const PUB_MS = 66;  // ~15 Hz command rate (also the watchdog cadence)

// keyboard -> logical direction key
const KEYMAP = {
  w: 'w', s: 's', a: 'a', d: 'd',
  arrowup: 'w', arrowdown: 's', arrowleft: 'a', arrowright: 'd',
};

const WheelIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v6M4.5 9.5l4.6 3M19.5 9.5l-4.6 3" />
  </svg>
);

export default function TeleopControl({ ros, status }) {
  const connected = status === 'connected';
  const [active, setActive] = useState(false);
  const [held, setHeld] = useState({ w: false, a: false, s: false, d: false });
  const [boost, setBoost] = useState(false);

  // Refs the publish loop reads without re-subscribing on every keypress. Synced in
  // effects (writing a ref during render trips react-hooks/refs under the Compiler).
  const heldRef = useRef(held);
  const boostRef = useRef(boost);
  // On-screen joystick vector (phone only), normalised to [-1, 1]. The publish loop
  // reads this ref; the knob's screen position lives in React state for rendering.
  const joyRef = useRef({ x: 0, y: 0, active: false, pointerId: null });
  const [knob, setKnob] = useState({ kx: 0, ky: 0, nx: 0, ny: 0 });
  const [joyOn, setJoyOn] = useState(false); // knob grabbed (drives the .on visual)
  const joyBaseRef = useRef(null);
  useEffect(() => { heldRef.current = held; }, [held]);
  useEffect(() => { boostRef.current = boost; }, [boost]);

  // Joystick is a PHONE affordance: show it only on a touch-primary device, and
  // hide it the moment a physical keyboard is used (covers a tablet with a keyboard
  // attached) - exactly the user's rule "no joystick when a keyboard is connected".
  const [touchPrimary] = useState(
    () => typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false,
  );
  const [hasKeyboard, setHasKeyboard] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (KEYMAP[k] || k === 'shift' || k === ' ' || k === 'spacebar') setHasKeyboard(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const phone = touchPrimary && !hasKeyboard;

  // Driving requires both the toggle ON and a live link; losing the link tears the
  // effect down (publishing a stop) and hides the HUD, without forcing state in an
  // effect. A deliberate re-toggle (or reconnect) resumes - and with no keys held it
  // only ever publishes a zero Twist until you press one.
  const driving = active && connected;

  useEffect(() => {
    if (!driving) return undefined;

    const topic = new ROSLIB.Topic({
      ros, name: TOPICS.cmdVel.name, messageType: TOPICS.cmdVel.type,
    });
    try { topic.advertise(); } catch { /* connection raced */ }

    // Publish a PLAIN object, not `new ROSLIB.Message(...)`: roslib v2's ESM build
    // doesn't export Message (only Ros/Topic/Service), so the old `new ROSLIB.Message`
    // threw "Message is not a constructor" on EVERY publish — that's why teleop never
    // moved the robot a millimetre and why toggling off crashed the page. Topic.publish
    // serialises whatever object it's given. (Same lesson as useRosHealth.js's
    // ServiceRequest note.) Still guarded so a mid-publish link drop can't bubble into
    // React — the robot's own 0.5 s watchdog stops it if commands stop arriving.
    const publish = (lin, ang) => {
      try {
        topic.publish({
          linear: { x: lin, y: 0, z: 0 },
          angular: { x: 0, y: 0, z: ang },
        });
      } catch { /* link gone mid-publish; watchdog covers the stop */ }
    };
    const stop = () => publish(0, 0);

    // Edge-triggered publishing (spec Task 4): stream commands ONLY while a control
    // is actively engaged (a WASD key held or the joystick grabbed). On release,
    // publish exactly ONE zero Twist, then go silent. There is NO idle keepalive:
    // an idle Drive-ON must put ZERO traffic on /cmd_vel so it can never contaminate
    // a CLI motor test. Holding a key still streams at PUB_MS (the robot's 0.5 s
    // watchdog needs fresh commands), which is active driving, not idle keepalive.
    let wasEngaged = false;
    const tick = () => {
      const h = heldRef.current;
      const j = joyRef.current;
      const engaged = j.active || h.w || h.a || h.s || h.d;
      if (engaged) {
        const m = boostRef.current ? BOOST : 1;
        let lin;
        let ang;
        if (j.active) {
          // Joystick wins while held: push up (−screen y) = forward, push left = turn
          // left (CCW = +angular). Magnitude is proportional, so a gentle nudge crawls.
          lin = -j.y * LIN * m;
          ang = -j.x * ANG * m;
        } else {
          lin = ((h.w ? 1 : 0) - (h.s ? 1 : 0)) * LIN * m;
          ang = ((h.a ? 1 : 0) - (h.d ? 1 : 0)) * ANG * m;
        }
        publish(lin, ang);
        wasEngaged = true;
      } else if (wasEngaged) {
        publish(0, 0); // the single stop Twist on release, then silence
        wasEngaged = false;
      }
    };
    const timer = setInterval(tick, PUB_MS);

    const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const onDown = (e) => {
      if (e.repeat || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'spacebar') {
        e.preventDefault();
        setHeld({ w: false, a: false, s: false, d: false });
        stop();
        wasEngaged = false; // immediate stop already sent; don't let tick send a duplicate
        return;
      }
      if (k === 'shift') { setBoost(true); return; }
      const dir = KEYMAP[k];
      if (!dir) return;
      e.preventDefault();
      setHeld((s) => (s[dir] ? s : { ...s, [dir]: true }));
    };
    const onUp = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'shift') { setBoost(false); return; }
      const dir = KEYMAP[k];
      if (!dir) return;
      setHeld((s) => (s[dir] ? { ...s, [dir]: false } : s));
    };
    // Lose focus -> drop everything and stop (don't keep driving while alt-tabbed).
    const onBlur = () => {
      setHeld({ w: false, a: false, s: false, d: false });
      setBoost(false);
      stop();
      wasEngaged = false;
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);

    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
      // Leave the robot stopped, then drop the publisher. Both are guarded (publish
      // is wrapped above; unadvertise here) so cleanup can NEVER throw — that was the
      // crash. No setState in cleanup either: key/boost reset moved to the toggle
      // handler, which is the only place the effect tears down on purpose.
      stop();
      try { topic.unadvertise(); } catch { /* already gone */ }
    };
  }, [driving, ros]);

  // Toggle handler: flip the switch and clear any latched keys so a fresh ON never
  // shows stale pressed keys (resetting unconditionally is safe — they're already
  // false when turning ON).
  const toggle = () => {
    setActive((a) => !a);
    setHeld({ w: false, a: false, s: false, d: false });
    setBoost(false);
    // Re-centre the stick so a fresh ON never resumes a latched vector.
    joyRef.current = { x: 0, y: 0, active: false, pointerId: null };
    setJoyOn(false);
    setKnob({ kx: 0, ky: 0, nx: 0, ny: 0 });
  };

  // --- joystick gesture (phone) ---
  const joySet = (e) => {
    const base = joyBaseRef.current;
    if (!base) return;
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const max = r.width / 2 - 22; // keep the knob inside the ring (knob radius ≈ 22)
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > max && dist > 0) { dx = (dx / dist) * max; dy = (dy / dist) * max; }
    const nx = max ? dx / max : 0;
    const ny = max ? dy / max : 0;
    joyRef.current.x = nx;
    joyRef.current.y = ny;
    joyRef.current.active = true;
    setKnob({ kx: dx, ky: dy, nx, ny });
  };
  const joyDown = (e) => {
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    joyRef.current.pointerId = e.pointerId;
    setJoyOn(true);
    joySet(e);
  };
  const joyMove = (e) => {
    if (joyRef.current.pointerId !== e.pointerId) return;
    joySet(e);
  };
  const joyEnd = (e) => {
    if (joyRef.current.pointerId !== e.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    joyRef.current = { x: 0, y: 0, active: false, pointerId: null };
    setJoyOn(false);
    setKnob({ kx: 0, ky: 0, nx: 0, ny: 0 }); // recentres → next tick publishes a stop
  };

  // Live joystick command for the HUD readout (matches the publish loop's mapping).
  const jLin = -knob.ny * LIN;
  const jAng = -knob.nx * ANG;

  const mult = boost ? BOOST : 1;
  const lin = ((held.w ? 1 : 0) - (held.s ? 1 : 0)) * LIN * mult;
  const ang = ((held.a ? 1 : 0) - (held.d ? 1 : 0)) * ANG * mult;

  return (
    <div className="teleop">
      {driving && phone && (
        <div className="teleop-hud joy" role="status">
          <div
            className={`teleop-joy ${joyOn ? 'on' : ''}`}
            ref={joyBaseRef}
            onPointerDown={joyDown}
            onPointerMove={joyMove}
            onPointerUp={joyEnd}
            onPointerCancel={joyEnd}
          >
            <span className="teleop-joy-ring" />
            <span className="teleop-joy-cross" />
            <span
              className="teleop-joy-knob"
              style={{ transform: `translate(${knob.kx}px, ${knob.ky}px)` }}
            />
          </div>
          <div className="teleop-read">
            <div><span>lin</span><b className="num">{jLin.toFixed(2)}</b> m/s</div>
            <div><span>ang</span><b className="num">{jAng.toFixed(2)}</b> rad/s</div>
          </div>
          <div className="teleop-hint">Drag to drive · release to stop</div>
        </div>
      )}
      {driving && !phone && (
        <div className="teleop-hud" role="status">
          <div className="teleop-keys">
            <span className={`tk ${held.w ? 'on' : ''}`}>W</span>
            <div className="tk-row">
              <span className={`tk ${held.a ? 'on' : ''}`}>A</span>
              <span className={`tk ${held.s ? 'on' : ''}`}>S</span>
              <span className={`tk ${held.d ? 'on' : ''}`}>D</span>
            </div>
          </div>
          <div className="teleop-read">
            <div><span>lin</span><b className="num">{lin.toFixed(2)}</b> m/s</div>
            <div><span>ang</span><b className="num">{ang.toFixed(2)}</b> rad/s</div>
            {boost && <div className="teleop-boost">BOOST</div>}
          </div>
          <button type="button" className="teleop-stop" onClick={() => {
            setHeld({ w: false, a: false, s: false, d: false });
          }}>
            STOP
          </button>
          <div className="teleop-hint">Hold W A S D · Shift = boost · Space = stop</div>
        </div>
      )}
      <button
        type="button"
        className={`teleop-toggle ${driving ? 'on' : ''}`}
        onClick={toggle}
        disabled={!connected}
        aria-pressed={driving}
        title={connected ? 'Toggle manual WASD driving' : 'Connect to drive'}
      >
        <WheelIcon />
        <span className="teleop-label">
          <b>Manual Drive</b>
          <em>
            {driving
              ? phone ? 'joystick live' : 'WASD live'
              : connected ? (phone ? 'tap to drive' : 'keyboard off') : 'offline'}
          </em>
        </span>
        <span className="teleop-switch" aria-hidden="true"><span className="teleop-knob" /></span>
      </button>
    </div>
  );
}
