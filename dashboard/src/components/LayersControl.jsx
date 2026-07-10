// -----------------------------------------------------------------------------
// LayersControl.jsx - a "layers" button + popover that floats over the map.
//
// Toggles which overlays MapCanvas draws (scan / frontiers / trail / robot / path /
// grid), offers a manual "Download PNG" of the current map view, and a "Save map"
// (SLAM-toolbox) action. The toggle state is owned by App (persisted to localStorage)
// and flows down through MapCard; flipping one only updates a ref inside MapCanvas,
// so the ROS subscriptions are untouched.
//
// The popover is PORTALED to <body> and position:fixed, anchored under the button via
// getBoundingClientRect. The map "stage" it lives over sets overflow:hidden (needed
// for the expand morph), which would otherwise clip a tall popover at the docked
// card's bottom edge - escaping to <body> lets every row show, docked or fullscreen.
// -----------------------------------------------------------------------------
import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

const LayersIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2 2 7l10 5 10-5-10-5Z" />
    <path d="m2 17 10 5 10-5" />
    <path d="m2 12 10 5 10-5" />
  </svg>
);
const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);
const SaveIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </svg>
);

const LAYER_DEFS = [
  ['scan', 'LiDAR scan'],
  ['frontiers', 'Frontiers'],
  ['trail', 'Trail'],
  ['robot', 'Robot'],
  ['path', 'Nav2 path'],
  ['objects', 'Objects'],
  ['gcost', 'Global costmap'],
  ['lcost', 'Local costmap'],
  ['grid', 'Grid'],
];

export default function LayersControl({ layers, onChange, onDownloadPng, onSaveMap, saveState }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const toggle = (key) => () => onChange({ ...layers, [key]: !layers[key] });
  const saveLabel =
    saveState === 'saving' ? 'Saving…' : saveState === 'ok' ? 'Map saved' : saveState === 'err' ? 'Save failed' : 'Save map';

  // Anchor the body-portaled popover under the button, re-place on resize, and
  // close on an outside click. Recomputed whenever it (re)opens.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (b) setPos({ top: b.bottom + 6, right: Math.max(8, window.innerWidth - b.right) });
    };
    place();
    const onResize = () => place();
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div className="map-layers">
      <button
        ref={btnRef}
        type="button"
        className="map-btn"
        title="Layers"
        aria-label="Map layers"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LayersIcon />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="layers-pop"
          role="menu"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
        >
          <div className="layers-pop-title">Layers</div>
          {LAYER_DEFS.map(([key, label]) => (
            <label className="layers-row" key={key}>
              <span className="layers-label">{label}</span>
              <input type="checkbox" checked={!!layers[key]} onChange={toggle(key)} />
              <span className="lswitch" aria-hidden="true" />
            </label>
          ))}
          <button type="button" className="layers-download" onClick={onDownloadPng}>
            <DownloadIcon /> Download PNG
          </button>
          {onSaveMap && (
            <button
              type="button"
              className="layers-download"
              onClick={onSaveMap}
              disabled={saveState === 'saving'}
            >
              <SaveIcon /> {saveLabel}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
