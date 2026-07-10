// -----------------------------------------------------------------------------
// WaypointsSeg.jsx - operator-defined goal points. The list is app config (these
// are where we *want* the robot to go), but the distance column and the "active"
// (nearest) highlight are computed live from the real /robot_pose - so it stays
// truthful as the robot moves.
// -----------------------------------------------------------------------------
import Skeleton from '../Skeleton';

const WAYPOINTS = [
  { name: 'Dock', x: -2.6, y: -1.8 },
  { name: 'Desk A', x: 2.6, y: -1.8 },
  { name: 'Window', x: 2.6, y: 1.8 },
  { name: 'Doorway', x: -0.2, y: 1.8 },
];

export default function WaypointsSeg({ pose, loading }) {
  let activeIdx = -1;
  if (pose) {
    let best = Infinity;
    WAYPOINTS.forEach((w, i) => {
      const d = Math.hypot(w.x - pose.x, w.y - pose.y);
      if (d < best) {
        best = d;
        activeIdx = i;
      }
    });
  }
  return (
    <div className="seg">
      <div className="seghead">
        <span className="ic" />
        <h3>Waypoints</h3>
      </div>
      <div className="segbody">
        <div>
          {WAYPOINTS.map((w, i) => {
            const d = pose ? Math.hypot(w.x - pose.x, w.y - pose.y) : null;
            return (
              <div className={'wp' + (i === activeIdx ? ' active' : '')} key={w.name}>
                <span className="pin" />
                <span className="nm">{w.name}</span>
                {loading ? (
                  <span className="co" style={{ marginLeft: 'auto' }}>
                    <Skeleton width={40} height={9} />
                  </span>
                ) : (
                  <span className="co">{d != null ? d.toFixed(1) + ' m' : `${w.x}, ${w.y}`}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
