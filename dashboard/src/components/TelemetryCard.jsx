// -----------------------------------------------------------------------------
// TelemetryCard.jsx - Coverage / Frontiers / Distance / Velocity.
// Coverage + frontiers are computed from the real /map; distance is integrated
// from /odom; velocity is the /odom twist magnitude. While the data hasn't
// arrived (loading, or value still null) a shimmer skeleton shows instead of a
// number.
// -----------------------------------------------------------------------------
import Skeleton from './Skeleton';
import GlowCard from './GlowCard';

const VEL_MAX = 0.3; // m/s, for the velocity bar scale

export default function TelemetryCard({ coverage, frontiers, dist, vel, moving, loading, theme }) {
  const wait = (v) => loading || v == null;
  const velPct = vel != null ? Math.min(100, (vel / VEL_MAX) * 100) : 0;
  return (
    <GlowCard id="c-tel" theme={theme}>
      <div className="head">
        <span className="ic" />
        <h2>Telemetry</h2>
        <span className="r">{loading ? 'awaiting link' : moving ? 'exploring' : 'holding'}</span>
      </div>
      <div className="tel-body">
        <div className="stat">
          <span className="k">Coverage</span>
          {wait(coverage) ? (
            <Skeleton width={70} height={26} style={{ marginTop: 3 }} />
          ) : (
            <span className="v accent">
              {coverage}
              <small>%</small>
            </span>
          )}
          <div className="track">
            <i style={{ width: (wait(coverage) ? 0 : coverage) + '%' }} />
          </div>
        </div>
        <div className="stat">
          <span className="k">Frontiers</span>
          {wait(frontiers) ? (
            <Skeleton width={60} height={26} style={{ marginTop: 3 }} />
          ) : (
            <span className="v">
              {frontiers}
              <small> open</small>
            </span>
          )}
        </div>
        <div className="stat">
          <span className="k">Distance</span>
          {wait(dist) ? (
            <Skeleton width={80} height={26} style={{ marginTop: 3 }} />
          ) : (
            <span className="v">
              {dist.toFixed(1)}
              <small> m</small>
            </span>
          )}
        </div>
        <div className="stat">
          <span className="k">Velocity</span>
          {wait(vel) ? (
            <Skeleton width={90} height={26} style={{ marginTop: 3 }} />
          ) : (
            <span className="v gold">
              {Math.round(vel * 100)}
              <small> cm/s</small>
            </span>
          )}
          <div className="track gold">
            <i style={{ width: velPct + '%' }} />
          </div>
        </div>
      </div>
    </GlowCard>
  );
}
