// -----------------------------------------------------------------------------
// SemanticLinkSeg.jsx - freshness of the /detected_objects link (laptop fusion
// node → dashboard). Shows the age of the last message (green < 500 ms, amber
// < 2 s, red beyond - or none for 3 s), the detection count it carried, and a
// rolling 60 s sparkline of message age. Red is labelled "LINK LOST / semantic
// memory decaying": the fusion node only publishes while it has detections, so
// a growing age means the TTL stores (Pi costmap + Objects list) are fading.
// Data comes from useSemanticObjects' link tracker - the topic's ONE subscriber.
//
// Deliberately NO loading skeletons: when the websocket drops this tile must
// keep showing the (growing) age and the red LINK LOST state - hiding it behind
// a skeleton would mask exactly the condition it exists to surface.
// -----------------------------------------------------------------------------
const GREEN_MS = 500;
const AMBER_MS = 2000;
const NONE_MS = 3000;   // never-seen grace before we call the link lost
const SPARK_TOP_MIN = 1000;   // ms - floor of the sparkline scale
const SPARK_TOP_MAX = 10000;  // ms - cap so one long outage doesn't flatten it

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// 'ok' | 'warn' | 'lost' | 'wait' (wait = subscribed < 3 s ago, nothing yet)
function stateOf(link) {
  if (!link || link.ageMs == null) {
    return link && link.sinceSubMs != null && link.sinceSubMs >= NONE_MS ? 'lost' : 'wait';
  }
  if (link.ageMs < GREEN_MS) return 'ok';
  if (link.ageMs < AMBER_MS) return 'warn';
  return 'lost';
}

const STATE_COLOR = {
  ok: 'var(--path)',    // the theme's green
  warn: 'var(--gold)',
  lost: 'var(--coral)',
  wait: 'var(--dim)',
};
const STATE_LABEL = {
  ok: 'LIVE',
  warn: 'DELAYED',
  lost: 'LINK LOST / semantic memory decaying',
  wait: 'awaiting detections',
};

const fmtAge = (ms) =>
  ms == null ? '-' : ms < 10000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

// Message-age sparkline (60 × 1 Hz samples). Baseline pinned at 0 like the
// System Health latency line; nulls (pre-first-message) are skipped.
function AgeSparkline({ data = [], color }) {
  const W = 100;
  const H = 20;
  const vals = data.filter((v) => v != null);
  if (vals.length < 2) return <div className="spark spark-empty" />;
  const top = clamp(Math.max(...vals), SPARK_TOP_MIN, SPARK_TOP_MAX);
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

export default function SemanticLinkSeg({ link }) {
  const state = stateOf(link);
  const color = STATE_COLOR[state];

  return (
    <div className="seg semlink">
      <div className="seghead">
        <span className={'ic' + (state === 'ok' ? '' : ' off')} />
        <h3>Semantic Link</h3>
      </div>
      <div className="segbody">
        <div className="hgrid">
          <div className="hrow">
            <span className="k">Age</span>
            <AgeSparkline data={link?.history} color={color} />
            <span className="v" style={{ color }}>
              {fmtAge(link?.ageMs)}
            </span>
          </div>
          <div className="hrow">
            <span className="k">Objects</span>
            <span className="v">
              {link?.count != null ? `${link.count} det` : '-'}
            </span>
          </div>
          <div className="hrow">
            <span className="semlink-state" style={{ color }}>
              {STATE_LABEL[state]}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
