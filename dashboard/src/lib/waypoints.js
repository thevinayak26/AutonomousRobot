export const WAYPOINTS = [
  { key: 'dock',    name: 'Dock',    x: -2.6, y: -1.8 },
  { key: 'desk',    name: 'Desk A',  x: 2.6,  y: -1.8 },
  { key: 'window',  name: 'Window',  x: 2.6,  y: 1.8 },
  { key: 'doorway', name: 'Doorway', x: -0.2, y: 1.8 },
];
export const WAYPOINT_BY_KEY = Object.fromEntries(WAYPOINTS.map((w) => [w.key, w]));
