// -----------------------------------------------------------------------------
// SystemHealthSeg.jsx - Link / Scan / CPU / Nodes, all from real sources:
//   Link   round-trip latency of a /rosapi/nodes call (useRosHealth)
//   Scan   measured /scan rate (reported by MapCanvas)
//   CPU    parsed from /sys_stats JSON (useRobotData)
//   Nodes  live ROS node count from /rosapi/nodes
// Missing sources render "-" and a muted bar, never a fabricated value.
// -----------------------------------------------------------------------------
import Skeleton from '../Skeleton';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const NODE_BARS = 10; // visual cap

// Map a round-trip latency (ms) to a status colour. Good link ≲ 80 ms, usable to
// ~200 ms, sluggish beyond — same thresholds used for the value text and the line.
const latColor = (ms) =>
  ms == null ? 'var(--dim)' : ms <= 80 ? 'var(--accent)' : ms <= 200 ? 'var(--gold)' : 'var(--coral)';

// Inline SVG sparkline of recent latency samples (nulls = failed polls = skipped).
// Baseline pinned at 0 ms so the line height reads as absolute latency, not a
// rescaled wiggle. non-scaling-stroke keeps it crisp under the stretched viewBox.
function Sparkline({ data = [], color }) {
  const W = 100;
  const H = 20;
  const vals = data.filter((v) => v != null);
  if (vals.length < 2) return <div className="spark spark-empty" />;
  const top = Math.max(...vals, 30); // a little headroom so a flat low line isn't glued to the top
  const n = data.length;
  const pts = [];
  data.forEach((v, i) => {
    if (v == null) return;
    const x = (i / (n - 1)) * W;
    const y = H - (clamp(v, 0, top) / top) * H;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function SystemHealthSeg({ latencyMs, latencyHistory = [], scanHz, cpu, nodeCount, healthOk, loading }) {
  const scanPct = scanHz != null ? clamp((scanHz / 10) * 100, 0, 100) : 0;
  const cpuPct = cpu != null ? clamp(cpu, 0, 100) : 0;
  const cpuCls = cpu == null ? '' : cpu > 90 ? 'coral' : cpu > 70 ? 'gold' : '';
  const shownBars = nodeCount != null ? clamp(nodeCount, 0, NODE_BARS) : 0;
  const val = (node) => (loading ? <Skeleton width={44} height={11} /> : node);

  return (
    <div className="seg">
      <div className="seghead">
        <span className={'ic' + (healthOk ? '' : ' off')} />
        <h3>System Health</h3>
      </div>
      <div className="segbody">
        <div className="hgrid">
          <div className="hrow">
            <span className="k">Link</span>
            <Sparkline data={latencyHistory} color={latColor(latencyMs)} />
            {val(
              <span className="v" style={{ color: latColor(latencyMs) }}>
                {latencyMs != null ? latencyMs + ' ms' : '-'}
              </span>
            )}
          </div>
          <div className="hrow">
            <span className="k">Scan</span>
            <div className="hbar">
              <i style={{ width: scanPct + '%' }} />
            </div>
            {val(<span className="v">{scanHz != null ? scanHz.toFixed(1) + ' Hz' : '-'}</span>)}
          </div>
          <div className="hrow">
            <span className="k">CPU</span>
            <div className="hbar">
              <i className={cpuCls} style={{ width: cpuPct + '%' }} />
            </div>
            {val(<span className="v">{cpu != null ? Math.round(cpu) + '%' : '-'}</span>)}
          </div>
          <div>
            <div className="hrow" style={{ marginBottom: 3 }}>
              <span className="k">Nodes</span>
              {val(
                <span className={'v' + (nodeCount ? ' ok' : '')}>
                  {nodeCount != null ? `${nodeCount} up` : '-'}
                </span>
              )}
            </div>
            <div className="nodes">
              {Array.from({ length: NODE_BARS }).map((_, i) => (
                <div className={'nd' + (i < shownBars ? '' : ' off')} key={i} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
