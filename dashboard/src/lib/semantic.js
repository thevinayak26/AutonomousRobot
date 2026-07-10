// -----------------------------------------------------------------------------
// semantic.js - the dashboard's mirror of the Pi's semantic_obstacles_node.py.
//
// The Pi node keeps a class-conditioned object store and drops each object with a
// HARD per-class TTL (NOT an exponential decay - the master-doc prose describes an
// exp() model, but the shipped node uses a hard TTL, and the dashboard must match
// the costmap/RViz, not the prose). Keep these constants byte-for-byte in step with
// semantic_obstacles_node.py so the dashboard forgets an object at the same instant
// the costmap does. Values verified against the repo copy on 2026-07-05.
// -----------------------------------------------------------------------------
export const CLASS_TTL = {
  person: 3.0,
  dog: 3.0,
  cat: 3.0,
  chair: 45.0,
  couch: 60.0,
  bed: 60.0,
  'dining table': 60.0,
  tv: 60.0,
};
export const DEFAULT_TTL = 20.0;
export const MERGE_DIST = 0.35; // detections closer than this update the same object

export const ttlFor = (cls) => (cls in CLASS_TTL ? CLASS_TTL[cls] : DEFAULT_TTL);

// Survival probability for the dashboard fade: opacity = exp(-lambda_c * age).
// The Pi node forgets an object with a HARD TTL, so there is no published lambda;
// we derive one from that TTL so the exponential curve reaches P_MIN exactly at the
// drop instant: lambda_c = ln(1/P_MIN) / TTL_c. Result: person decays fast (~3 s),
// furniture slowly, and every fade bottoms out the moment the costmap forgets it.
export const P_MIN = 0.05;
export const lambdaFor = (cls) => Math.log(1 / P_MIN) / ttlFor(cls);
export const survival = (cls, age) => Math.exp(-lambdaFor(cls) * age);

// Visual grouping (dashboard-only): people/animals read as alerts (coral), furniture
// as static context (sky), everything else neutral (gold). Used by both the list
// panel and the map icons so a class always looks the same in both places.
const LIVING = new Set(['person', 'dog', 'cat']);
const FURNITURE = new Set(['chair', 'couch', 'sofa', 'bed', 'dining table', 'table', 'bench', 'tv']);
export function classGroup(cls) {
  if (LIVING.has(cls)) return 'living';
  if (FURNITURE.has(cls)) return 'furniture';
  return 'other';
}
export const GROUP_VAR = { living: '--coral', furniture: '--sky', other: '--gold' };

export function iconType(cls) {
  if (cls === 'person') return 'person';
  if (cls === 'dog' || cls === 'cat') return 'pet';
  if (cls === 'chair') return 'chair';
  if (cls === 'couch' || cls === 'sofa' || cls === 'bed') return 'couch';
  if (cls === 'dining table' || cls === 'table') return 'table';
  return 'box';
}
