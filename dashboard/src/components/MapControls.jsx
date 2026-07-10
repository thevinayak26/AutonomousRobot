// -----------------------------------------------------------------------------
// MapControls.jsx - the RViz-style camera toolbar that floats over the map.
//
// Buttons mutate the shared `viewRef` (the camera owned by MapCard); the canvas
// rAF loop in MapCanvas reads it next frame, so none of this triggers a React
// re-render. Docked, only the Expand affordance shows (the map is also tap-to-
// expand + drag/wheel navigable); expanded, the full set + a Close (Esc) shows.
//
// Zoom / rotate / recentre EASE instead of teleporting: each button writes a
// TARGET (tcx/tcy/tk/tphi + anim flag) onto the shared camera, and MapCanvas's draw
// loop glides the live camera toward it — so the toolbar feels as smooth as the
// drag/wheel gestures. Writing targets keeps this to plain ref-property mutation
// (the React Compiler forbids passing a ref into a helper). Moves compose off the
// in-flight target when one is running, so rapid taps still land a full step each.
// -----------------------------------------------------------------------------
const K_MIN = 0.35;
const K_MAX = 16;
const K_STEP = 1.35;
const R_STEP = Math.PI / 12; // 15° per rotate tap

const I = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const Svg = (p) => <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...I} {...p} />;

const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
const MinusIcon = () => <Svg><path d="M5 12h14" /></Svg>;
const RotLeftIcon = () => <Svg><path d="M3 12a9 9 0 1 1 3 6.7" /><path d="M3 17v-5h5" /></Svg>;
const RotRightIcon = () => <Svg><path d="M21 12a9 9 0 1 0-3 6.7" /><path d="M21 17v-5h-5" /></Svg>;
const TargetIcon = () => <Svg><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3" /></Svg>;
const FitIcon = () => <Svg><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" /></Svg>;
const ExpandIcon = () => <Svg><path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" /></Svg>;
const CloseIcon = () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>;
const GoalFlagIcon = () => <Svg><path d="M5 21V4" /><path d="M5 4h11l-3 3.5 3 3.5H5" /></Svg>;
const StopIcon = () => <Svg><circle cx="12" cy="12" r="9" /><rect x="8.8" y="8.8" width="6.4" height="6.4" rx="1" fill="currentColor" stroke="none" /></Svg>;

export default function MapControls({
  expanded, viewRef, pose, onExpand, onClose, navMode, onToggleNav, hasGoal, onCancelNav,
}) {
  // Seed the target from the in-flight target (if easing) else the live camera, so
  // untouched axes hold their heading and the changed axis composes cleanly.
  const zoom = (f) => () => {
    const v = viewRef.current;
    const bk = v.anim ? v.tk : v.k;
    v.tcx = v.anim ? v.tcx : v.cx;
    v.tcy = v.anim ? v.tcy : v.cy;
    v.tphi = v.anim ? v.tphi : v.phi;
    v.tk = Math.max(K_MIN, Math.min(K_MAX, bk * f));
    v.anim = true;
    v.init = true;
  };
  const rotate = (d) => () => {
    const v = viewRef.current;
    v.tcx = v.anim ? v.tcx : v.cx;
    v.tcy = v.anim ? v.tcy : v.cy;
    v.tk = v.anim ? v.tk : v.k;
    v.tphi = (v.anim ? v.tphi : v.phi) + d;
    v.anim = true;
    v.init = true;
  };
  const reset = () => { viewRef.current.fit = true; }; // eases back to the explored-bbox fit (MapCanvas owns the framing)
  const centerRobot = () => {
    if (!pose) return;
    const v = viewRef.current;
    const bk = v.anim ? v.tk : v.k;
    v.tphi = v.anim ? v.tphi : v.phi;
    v.tcx = pose.x;
    v.tcy = pose.y;
    v.tk = Math.max(bk, 2.6);
    v.anim = true;
    v.init = true;
  };

  if (!expanded) {
    return (
      <button type="button" className="map-btn map-expand" onClick={onExpand}
        title="Expand map" aria-label="Expand map">
        <ExpandIcon />
      </button>
    );
  }

  return (
    <>
      <button type="button" className="map-btn map-close" onClick={onClose}
        title="Close (Esc)" aria-label="Close map">
        <CloseIcon />
      </button>
      <button type="button" className={'map-btn map-nav-toggle' + (navMode ? ' on' : '')}
        onClick={onToggleNav} aria-pressed={navMode}
        title={navMode ? 'Nav goal: ARMED (tap map to pick a goal)' : 'Set a Nav2 goal'}
        aria-label="Toggle tap-to-navigate">
        <GoalFlagIcon />
      </button>
      {hasGoal && (
        <button type="button" className="map-btn map-nav-cancel" onClick={onCancelNav}
          title="Cancel the active Nav2 goal" aria-label="Cancel Nav2 goal">
          <StopIcon />
        </button>
      )}
      <div className="map-controls" role="toolbar" aria-label="Map view controls">
        <button type="button" className="map-btn" onClick={zoom(K_STEP)} title="Zoom in" aria-label="Zoom in"><PlusIcon /></button>
        <button type="button" className="map-btn" onClick={zoom(1 / K_STEP)} title="Zoom out" aria-label="Zoom out"><MinusIcon /></button>
        <span className="map-ctl-sep" />
        <button type="button" className="map-btn" onClick={rotate(-R_STEP)} title="Rotate left" aria-label="Rotate left"><RotLeftIcon /></button>
        <button type="button" className="map-btn" onClick={rotate(R_STEP)} title="Rotate right" aria-label="Rotate right"><RotRightIcon /></button>
        <span className="map-ctl-sep" />
        <button type="button" className="map-btn" onClick={centerRobot} title="Center on robot" aria-label="Center on robot" disabled={!pose}><TargetIcon /></button>
        <button type="button" className="map-btn" onClick={reset} title="Reset view (fit)" aria-label="Reset view"><FitIcon /></button>
      </div>
    </>
  );
}
