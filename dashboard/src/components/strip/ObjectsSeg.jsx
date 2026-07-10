// -----------------------------------------------------------------------------
// ObjectsSeg.jsx - the semantic "Detected Objects" list (spec Task 3). Rows are the
// live store from useSemanticObjects (class, confidence, map x/y, age). Row opacity
// is the survival cue: fresh = solid, near-expiry = faint, gone at the class TTL -
// so a person fades out ~3 s after leaving while a chair lingers, matching RViz.
// -----------------------------------------------------------------------------
import Skeleton from '../Skeleton';
import { classGroup, GROUP_VAR } from '../../lib/semantic';

export default function ObjectsSeg({ objects, loading }) {
  const list = objects || [];
  return (
    <div className="seg">
      <div className="seghead">
        <span className="ic" />
        <h3>Objects</h3>
        {!loading && list.length > 0 && <span className="r">{list.length} live</span>}
      </div>
      <div className="segbody">
        {loading ? (
          <div className="obj-list">
            {[0, 1].map((i) => (
              <div className="obj" key={i}>
                <Skeleton width={130} height={10} />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="obj-empty">no objects detected</div>
        ) : (
          <div className="obj-list">
            {list.map((o) => (
              <div className="obj" key={o.id} style={{ opacity: o.opacity }}>
                <span className="obj-dot" style={{ background: `var(${GROUP_VAR[classGroup(o.cls)]})` }} />
                <span className="obj-cls">{o.cls}</span>
                <span className="obj-conf num">{Math.round((o.conf ?? 0) * 100)}%</span>
                <span className="obj-xy num">{o.x.toFixed(1)}, {o.y.toFixed(1)} m</span>
                <span className="obj-age num">{o.age.toFixed(1)}s</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
