// -----------------------------------------------------------------------------
// UltrasonicSeg.jsx - front-low + cliff ultrasonics.
// HONESTY (spec §1): these sensors aren't on the robot yet
// (TOPICS.ultrasonic*.status === 'later'), so the tile renders an explicit
// offline state with empty tracks and "-" - never the mockup's invented numbers.
// When the topics go live, swap in the real sensor_msgs/Range readings here.
// -----------------------------------------------------------------------------
export default function UltrasonicSeg() {
  return (
    <div className="seg">
      <div className="seghead">
        <span className="ic off" />
        <h3>Ultrasonic</h3>
        <span className="r">offline</span>
      </div>
      <div className="segbody">
        <div className="uson offline">
          <div className="ub">
            <span className="uvl">-</span>
            <div className="utrk">
              <div className="ufl" style={{ height: '0%' }} />
            </div>
            <span className="ulb">FRONT-LOW</span>
          </div>
          <div className="ub">
            <span className="uvl">-</span>
            <div className="utrk">
              <div className="ufl" style={{ height: '0%' }} />
            </div>
            <span className="ulb">CLIFF ↓</span>
          </div>
        </div>
        <div className="offline-note">SENSOR NOT INSTALLED</div>
      </div>
    </div>
  );
}
