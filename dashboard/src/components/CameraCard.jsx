// -----------------------------------------------------------------------------
// CameraCard.jsx - Camera tile (spec Task 2).
//
// DEFAULT source is the laptop fusion node's ANNOTATED (YOLO-boxed) MJPEG on :8081
// (annotatedUrl, host = ?camhost= or wherever the dashboard is served). That is also
// the one-consumer fix: the dashboard reads the LAPTOP, so atlas_fusion_node.py stays
// the sole consumer of the Pi :8080. The RAW Pi feed (:8080) is available only behind
// an explicit toggle, labelled with the one-consumer warning (opening it while fusion
// runs adds a 2nd Pi consumer and saturates a Pi core).
//
// Either way the <img> falls back to the honest "no signal" placeholder on load error,
// and the ⤢ control expands the view to a body-portaled fullscreen overlay (Esc/✕).
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { annotatedUrl, rawCameraUrl } from '../ros/topics';
import GlassSurface from './GlassSurface';
import GlowCard from './GlowCard';

const I = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const ExpandIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...I}>
    <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" />
  </svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...I}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// The camera surface, shared verbatim between the docked card and the fullscreen
// overlay so they can never drift apart.
function CamView({ src, live, setLive, today, big, raw, ar, setAr }) {
  return (
    <div className={'camview' + (big ? ' big' : '')} style={ar ? { '--cam-ar': ar } : undefined}>
      <img
        key={src}
        src={src}
        alt="camera feed"
        onLoad={(e) => {
          setLive(true);
          // size the docked view to the stream's true aspect (4:3 fallback in CSS)
          const { naturalWidth: w, naturalHeight: h } = e.target;
          if (w && h) setAr(`${w} / ${h}`);
        }}
        onError={() => setLive(false)}
        style={{ display: live ? 'block' : 'none' }}
      />
      {!live && (
        <>
          <div className="camnoise" />
          <div className="camstatus">
            <span className="d" />
            NO&nbsp;SIGNAL
          </div>
          <div className="camchrome">
            <span className="ccorner tl" />
            <span className="ccorner tr" />
            <span className="ccorner bl" />
            <span className="ccorner br" />
          </div>
          <div className="camcenter">
            <GlassSurface
              width={big ? 360 : 244}
              height={big ? 190 : 134}
              borderRadius={16}
              blur={9}
              displace={1}
              distortionScale={-120}
              brightness={60}
              backgroundOpacity={0.12}
              saturation={1.3}
            >
              <div className="cam-glass-inner">
                <div className="big">Awaiting feed</div>
                <div className="sub">{raw ? 'RAW · Pi :8080' : 'ANNOTATED · :8081'} · {today}</div>
                <div className="chip">{raw ? 'no stream on Pi :8080' : 'start atlas_fusion_node (:8081)'}</div>
              </div>
            </GlassSurface>
          </div>
        </>
      )}
      {live && (
        <div className="camstatus live">
          <span className="d" />
          {raw ? 'LIVE · RAW' : 'LIVE · YOLO'}
        </div>
      )}
    </div>
  );
}

export default function CameraCard({ theme }) {
  const [raw, setRaw] = useState(false); // false = annotated laptop :8081 (default)
  const [live, setLive] = useState(false);
  const [ar, setAr] = useState(null); // stream aspect ratio, e.g. "320 / 240"
  const [expanded, setExpanded] = useState(false);
  const src = raw ? rawCameraUrl() : annotatedUrl();
  const today = new Date()
    .toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' })
    .toUpperCase();

  // Esc closes; lock background scroll while the overlay is up (mirrors MapCard).
  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  const toggleSource = () => { setRaw((v) => !v); setLive(false); };
  const shared = { src, live, setLive, today, raw, ar, setAr };

  return (
    <GlowCard id="c-cam" theme={theme}>
      <div className="head">
        <span className={'ic' + (live ? '' : ' off')} />
        <h2>Camera</h2>
        <span className="r">
          {live ? (raw ? 'raw · Pi :8080' : 'annotated · :8081') : 'offline · no stream'}
        </span>
      </div>
      <div className="cam-slot">
        <CamView {...shared} big={false} />
        <button
          type="button"
          className={'map-btn cam-src' + (raw ? ' on' : '')}
          onClick={toggleSource}
          title={raw
            ? 'Raw Pi feed (:8080). WARNING: a 2nd consumer of the Pi camera while fusion runs saturates a Pi core. Click for the annotated laptop feed.'
            : 'Annotated laptop feed (:8081, YOLO boxes). Click for the raw Pi feed (:8080, adds a 2nd Pi consumer).'}
          aria-label="Toggle camera source"
        >
          {raw ? 'RAW' : 'YOLO'}
        </button>
        <button
          type="button"
          className="map-btn cam-expand"
          onClick={() => setExpanded(true)}
          title="Expand camera"
          aria-label="Expand camera"
        >
          <ExpandIcon />
        </button>
        {raw && <div className="cam-warn">raw Pi feed · keep to ONE consumer</div>}
      </div>

      {expanded &&
        createPortal(
          <div className="cam-stage" role="dialog" aria-label="Camera (fullscreen)">
            <button
              type="button"
              className="map-btn cam-close"
              onClick={() => setExpanded(false)}
              title="Close (Esc)"
              aria-label="Close camera"
            >
              <CloseIcon />
            </button>
            <CamView {...shared} big />
          </div>,
          document.body,
        )}
    </GlowCard>
  );
}
