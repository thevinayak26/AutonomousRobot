// -----------------------------------------------------------------------------
// App.jsx - ATLAS Console (Phase 2): the full dashboard.
//
// Composition only: it owns the connection + derived-data hooks and distributes
// their output to the tiles. The data discipline (spec §10) lives in the hooks -
// each ROS topic is subscribed exactly once (MapCanvas: /map,/scan,/robot_pose;
// useRobotData: /odom,/imu,/sys_stats; useRosHealth: /rosapi/nodes) and React
// state updates are throttled, so a 20 Hz robot doesn't cause 20 Hz re-renders.
//
// HONESTY (spec §1): tiles whose hardware/feature isn't built yet (camera,
// ultrasonics) render explicit offline states; everything else is real data.
// -----------------------------------------------------------------------------
import { useState, useEffect } from 'react';
import { useRos } from './ros/useRos';
import { useRobotData } from './ros/useRobotData';
import { useRosHealth } from './ros/useRosHealth';
import { useSemanticObjects } from './ros/useSemanticObjects';
import { useTheme } from './hooks/useTheme';
import { useMissionClock } from './hooks/useMissionClock';
import { useEventLog } from './hooks/useEventLog';
import Header from './components/Header';
import Intro from './components/Intro';
import MapCard from './components/MapCard';
import CameraCard from './components/CameraCard';
import TelemetryCard from './components/TelemetryCard';
import StripCard from './components/StripCard';
import DiagCard from './components/DiagCard';

const EMPTY_MAP_STATS = { pose: null, coverage: null, frontiers: null, scanHz: null };

// Map overlay visibility - persisted so a chosen view survives a reload.
const DEFAULT_LAYERS = {
  scan: true, frontiers: true, trail: true, robot: true, path: true, objects: true, grid: false,
  gcost: false, lcost: false, // Nav2 costmap overlays - off by default (opt-in bandwidth)
};
const LAYERS_KEY = 'atlas.mapLayers';
function loadLayers() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYERS_KEY));
    return saved && typeof saved === 'object' ? { ...DEFAULT_LAYERS, ...saved } : DEFAULT_LAYERS;
  } catch {
    return DEFAULT_LAYERS;
  }
}

function deriveMode(status, moving, coverage) {
  if (status !== 'connected') return 'Standby';
  if (coverage != null && coverage >= 95) return 'Complete';
  return moving ? 'Exploring' : 'Idle';
}

export default function App() {
  const { theme, toggle } = useTheme();
  const { ros, status } = useRos();
  const clock = useMissionClock(status);
  const robot = useRobotData(ros, status);
  const health = useRosHealth(ros, status);
  const { objects, link } = useSemanticObjects(ros, status);

  // Stats the map derives and reports up (pose/coverage/frontiers/scanHz).
  const [mapStats, setMapStats] = useState(EMPTY_MAP_STATS);
  const { pose, coverage, frontiers, scanHz } = mapStats;

  // Which map overlays are visible (persisted across reloads).
  const [layers, setLayers] = useState(loadLayers);
  useEffect(() => {
    try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layers)); } catch { /* private mode */ }
  }, [layers]);

  const mode = deriveMode(status, robot.moving, coverage);
  const events = useEventLog({ status, coverage, moving: robot.moving });
  const loading = status !== 'connected';

  return (
    <>
      <Intro />
      <Header
        clock={clock}
        mode={mode}
        hz={robot.odomHz}
        latency={health.latencyMs}
        status={status}
        ros={ros}
        theme={theme}
        onToggleTheme={toggle}
      />
      <main>
        <MapCard
          ros={ros}
          status={status}
          theme={theme}
          pose={pose}
          coverage={coverage}
          loading={loading}
          onStats={setMapStats}
          layers={layers}
          onLayersChange={setLayers}
          objects={objects}
        />
        <CameraCard theme={theme} />
        <TelemetryCard
          coverage={coverage}
          frontiers={frontiers}
          dist={robot.dist}
          vel={robot.vel}
          moving={robot.moving}
          loading={loading}
          theme={theme}
        />
        <StripCard
          ros={ros}
          status={status}
          robot={robot}
          health={health}
          scanHz={scanHz}
          events={events}
          pose={pose}
          objects={objects}
          link={link}
          loading={loading}
          theme={theme}
        />
        <DiagCard
          ros={ros}
          status={status}
          robot={robot}
          scanHz={scanHz}
          pose={pose}
          health={health}
          theme={theme}
        />
      </main>
    </>
  );
}
