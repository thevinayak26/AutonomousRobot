// -----------------------------------------------------------------------------
// StripCard.jsx - the bottom strip: Attitude · Ultrasonic · Event Stream ·
// System Health · Waypoints. Pure layout; each segment owns its own rendering.
// -----------------------------------------------------------------------------
import AttitudeSeg from './strip/AttitudeSeg';
import UltrasonicSeg from './strip/UltrasonicSeg';
import EventStreamSeg from './strip/EventStreamSeg';
import ObjectsSeg from './strip/ObjectsSeg';
import SemanticLinkSeg from './strip/SemanticLinkSeg';
import SystemHealthSeg from './strip/SystemHealthSeg';
import WaypointsSeg from './strip/WaypointsSeg';
import GlowCard from './GlowCard';

export default function StripCard({ robot, health, scanHz, events, pose, objects, link, loading, theme }) {
  return (
    <GlowCard id="c-strip" theme={theme}>
      <AttitudeSeg
        yaw={robot.yaw}
        gyroZ={robot.gyroZ}
        imuOk={robot.imuOk}
        lidarOk={scanHz != null}
        loading={loading}
      />
      <UltrasonicSeg />
      <EventStreamSeg events={events} loading={loading} />
      <ObjectsSeg objects={objects} loading={loading} />
      <SemanticLinkSeg link={link} />
      <SystemHealthSeg
        latencyMs={health.latencyMs}
        latencyHistory={health.history}
        scanHz={scanHz}
        cpu={robot.cpu}
        nodeCount={health.nodeCount}
        healthOk={health.ok}
        loading={loading}
      />
      <WaypointsSeg pose={pose} loading={loading} />
    </GlowCard>
  );
}
