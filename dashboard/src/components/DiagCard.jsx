// -----------------------------------------------------------------------------
// DiagCard.jsx - the live ROS topic list + per-topic health.
//
// Shows the FULL `ros2 topic list` (rosapi/topics, via useRosTopics) so every topic
// the graph advertises appears here, in a scrollable list that stays a fixed card
// height. The handful of topics the dashboard actually depends on are pulled to the
// top and carry a real live/stale dot + measured Hz (derived from existing signals,
// no new subscriptions) - so a topic-name mismatch (the /odom vs /odometry/filtered
// bug) still reads at a glance. Untracked topics show a neutral "advertised" dot.
// -----------------------------------------------------------------------------
import GlowCard from './GlowCard';
import { TOPICS } from '../ros/topics';
import { useRosTopics } from '../ros/useRosTopics';

const shortType = (t) => (t ? t.split('/').pop() : '');

function DiagRow({ name, type, state, hz }) {
  // state: 'ok' (tracked + live) | 'stale' (tracked + not) | 'present' (advertised)
  return (
    <div className="diag-row">
      <span className={`diag-dot ${state}`} />
      <span className="diag-name">{name}</span>
      <span className="diag-type" title={type}>{shortType(type)}</span>
      <span className="diag-hz">
        {state === 'ok'
          ? hz != null
            ? `${Math.round(hz)} Hz`
            : 'live'
          : state === 'stale'
            ? 'stale'
            : ''}
      </span>
    </div>
  );
}

export default function DiagCard({ ros, status, robot, scanHz, pose, health, theme }) {
  const connected = status === 'connected';
  const { topics } = useRosTopics(ros, status);

  // The topics the dashboard depends on - these get a real health dot + Hz.
  const tracked = {
    [TOPICS.odom.name]: { type: TOPICS.odom.type, ok: connected && robot.odomOk, hz: robot.odomHz },
    [TOPICS.imu.name]: { type: TOPICS.imu.type, ok: connected && robot.imuOk, hz: null },
    [TOPICS.scan.name]: { type: TOPICS.scan.type, ok: connected && scanHz != null, hz: scanHz },
    [TOPICS.robotPose.name]: { type: TOPICS.robotPose.type, ok: connected && !!pose, hz: null },
    [TOPICS.sysStats.name]: { type: TOPICS.sysStats.type, ok: connected && robot.sysOk, hz: null },
  };

  // Prefer the live rosapi list; fall back to the known contract when it's empty
  // (rosapi absent, or not connected) so the card is never blank.
  const live = topics.length
    ? topics
    : Object.entries(tracked).map(([name, t]) => ({ name, type: t.type }));

  const rows = live.map(({ name, type }) => {
    const t = tracked[name];
    if (t) return { name, type: type || t.type, state: t.ok ? 'ok' : 'stale', hz: t.hz };
    return { name, type, state: 'present', hz: null };
  });
  // Tracked topics first (their health is what matters), then everything A-Z.
  rows.sort((a, b) => {
    const at = tracked[a.name] ? 0 : 1;
    const bt = tracked[b.name] ? 0 : 1;
    return at - bt || a.name.localeCompare(b.name);
  });

  return (
    <GlowCard id="c-diag" theme={theme}>
      <div className="head">
        <span className={`ic ${connected ? '' : 'off'}`} />
        <h2>Topic Health</h2>
        <span className="r">
          {connected ? `${rows.length} topics · ${health?.nodeCount ?? '-'} nodes` : 'offline'}
        </span>
      </div>
      <div className="diag-body">
        {rows.map((r) => (
          <DiagRow key={r.name} {...r} />
        ))}
      </div>
    </GlowCard>
  );
}
