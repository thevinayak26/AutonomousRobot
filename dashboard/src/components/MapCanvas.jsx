// -----------------------------------------------------------------------------
// MapCanvas.jsx - the live SLAM map (spec §7 Map, §9, §10).
//
// Renders the real /map OccupancyGrid to a canvas and overlays, every animation
// frame, the live /scan (rays + points), the robot's travelled trail, frontier
// markers, and the oriented robot marker from /robot_pose. It is the ONLY
// subscriber to /map, /scan and /robot_pose, and it does double duty: alongside
// rendering it derives coverage %, frontier count, scan Hz and pose, and reports
// them upward (throttled) via onStats so the telemetry/health tiles don't have to
// re-subscribe.
//
// Camera (RViz-style navigation): a translate+scale+rotate view sits ON TOP of
// the aspect-fit. The whole camera is a small `view` object - { cx, cy (world
// point at viewport centre), k (zoom × fit), phi (rotation rad) } - held in a ref
// OWNED BY MapCard and passed in, so it survives expand→fullscreen→collapse and so
// the toolbar buttons can drive it. Drag pans, wheel zooms toward the cursor, two
// fingers pinch-zoom/rotate, a short tap (when docked) asks MapCard to expand.
//
// Implementation note: every imperative routine lives INSIDE the subscription
// effect, closing over per-connection state. Nothing imperative runs in the
// render phase - that keeps the React-Compiler lints satisfied and the hot path
// (canvas) completely off React's state cycle (§10 "don't re-render every frame").
//
// Performance: the OccupancyGrid is rasterised into an offscreen bitmap once per
// /map message (1 Hz), cached, and re-rasterised only on a theme change (colours
// come from CSS vars). Per-frame work is just one transformed drawImage + a few
// hundred points.
//
// Y-flip note: ROS map origin is bottom-left, canvas y is top-down, so grid row
// y maps to (height-1-y); world↔screen and screen↔world both apply the same flip.
// -----------------------------------------------------------------------------
import { useEffect, useRef } from 'react';
import * as ROSLIB from 'roslib';
import { TOPICS, SUB_OPTS } from '../ros/topics';
import { quatToYaw } from '../lib/geometry';
import { classGroup } from '../lib/semantic';
import { drawObjectSprite } from '../lib/mapSprites';

const PAD = 14;          // px gutter around the fitted map (at k = 1)
const TRAIL_MAX = 400;   // trail points kept
const REPORT_MS = 400;   // how often derived stats are pushed upward
const K_MIN = 0.35;      // zoom-out limit (× aspect-fit)
const K_MAX = 16;        // zoom-in limit
const TAP_PX = 8;        // pointer travel under this (and quick) = a tap, not a drag
const TAP_MS = 350;
const ROBOT_RADIUS_M = 0.12; // real chassis radius (m); rover is drawn to true footprint

// Layer visibility defaults (overridden by the persisted set passed from App).
const DEFAULT_LAYERS = {
  scan: true, frontiers: true, trail: true, robot: true, path: true, objects: true, grid: false,
  gcost: false, lcost: false,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
// Lighten/darken an [r,g,b] by factor f (>1 lighter, <1 darker) → css rgb() string.
const shade = (rgb, f) => `rgb(${rgb.map((c) => Math.round(clamp(c * f, 0, 255))).join(',')})`;
const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

export default function MapCanvas({
  ros, status, theme, onStats, layers = DEFAULT_LAYERS,
  view: viewProp, expanded = false, onRequestExpand, navMode = false, onGoalPick,
  goal = null, objects,
}) {
  const canvasRef = useRef(null);
  const dirtyRef = useRef(false); // theme changed → bitmap needs re-rasterising

  // The camera. Owned by MapCard when provided (so it persists across the
  // expand/collapse remount and the toolbar can mutate it); a local fallback
  // keeps MapCanvas usable standalone. `init` is set the first time we frame a map.
  const localView = useRef({ cx: 0, cy: 0, k: 1, phi: 0, init: false });
  const view = viewProp || localView;

  // Latest expand state / callback, read by the gesture closure without
  // re-subscribing ROS topics when they change. Synced in an effect (writing a
  // ref during render trips react-hooks/refs and isn't safe under the Compiler).
  const expandedRef = useRef(expanded);
  const requestExpandRef = useRef(onRequestExpand);
  const navModeRef = useRef(navMode);
  const onGoalPickRef = useRef(onGoalPick);
  useEffect(() => {
    expandedRef.current = expanded;
    requestExpandRef.current = onRequestExpand;
    navModeRef.current = navMode;
    onGoalPickRef.current = onGoalPick;
  }, [expanded, onRequestExpand, navMode, onGoalPick]);

  // Nav2 goal marker ({x, y, pending}) - the picked-but-unconfirmed point (gold,
  // dashed) or the last SENT goal (path green). Read by the draw loop via a ref,
  // like layers/objects, so chip interactions never rebuild the subscriptions.
  const goalRef = useRef(goal);
  useEffect(() => {
    goalRef.current = goal;
  }, [goal]);

  // Idle cursor signals the mode: crosshair when arming a Nav2 goal, grab otherwise.
  useEffect(() => {
    const cv = canvasRef.current;
    if (cv) cv.style.cursor = navMode ? 'crosshair' : 'grab';
  }, [navMode]);

  // Layer visibility toggles, read by the draw loop via a ref so flipping one
  // doesn't tear down/rebuild the ROS subscriptions (mirrors expandedRef above).
  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  // Semantic objects (Task 3B): read by the draw loop via a ref so a new snapshot
  // (~5 Hz) never tears down/rebuilds the ROS subscriptions - mirrors layersRef.
  const objectsRef = useRef(objects);
  useEffect(() => {
    objectsRef.current = objects;
  }, [objects]);

  // A theme flip changes the map colours; flag it and let the rAF loop re-raster
  // the cached map message (no resubscribe, no render-phase work).
  useEffect(() => {
    dirtyRef.current = true;
  }, [theme]);

  useEffect(() => {
    if (status !== 'connected') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    // ---- per-connection state (closure, never touches React) ----
    let bitmap = null;     // offscreen canvas with the rasterised grid
    let mapMsg = null;     // last raw /map (for re-raster on theme change)
    let meta = null;       // { width, height, resolution, originX, originY, known }
    let wallRects = [];    // merged wall rectangles (bitmap px) for 2.5D extrusion
    // Nav2 costmap overlays: each is rasterised ONCE per message (<=2 Hz on the
    // wire via throttle_rate) into an offscreen RGBA bitmap; the frame loop only
    // does a transformed drawImage. Subscribed lazily while its layer toggle is
    // ON so a hidden overlay costs the Pi (and the WiFi link) nothing.
    const costmaps = { g: null, l: null };  // key -> { bitmap, meta }
    const cmTopics = { g: null, l: null };  // key -> live ROSLIB.Topic (or null)
    let scan = null;       // latest LaserScan
    let pose = null;       // effective robot pose { x, y, yaw } in the MAP frame
    let lastTfPose = 0;    // when TF last yielded a pose (TF is preferred source)
    const tfTree = new Map(); // child frame -> { parent, x, y, yaw } (planar)
    let plan = [];         // [[wx, wy], …] Nav2 global path (map frame)
    let frontiers = [];    // [[wx, wy], …] cluster centroids
    let coverage = null;   // %
    let frontierCount = null;
    const trail = [];      // [[wx, wy], …]
    const scanRate = { last: 0, hz: 0, lastSeen: 0 };
    let raf = 0;
    let lastReport = 0;
    let lastT = null;      // most recent transform, for gesture hit-testing
    const pointers = new Map(); // active pointerId -> { x, y } in canvas px
    let gesture = null;    // { mode:'pan'|'pinch', … }
    // Toolbar moves set a camera target (view.current.t*) + anim flag; this factor
    // eases the live camera toward it each frame (drag/wheel clear anim to take over).
    const easeReduce = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

    // Cached theme colours: getComputedStyle is costly, so read the CSS vars ONCE
    // per theme change (flagged by dirtyRef) instead of ~8x every animation frame.
    let palette = null;
    const readPalette = () => ({
      inset: cssVar('--inset'),
      accent: cssVar('--accent'),
      sky: cssVar('--sky'),
      gold: cssVar('--gold'),
      coral: cssVar('--coral'),
      path: cssVar('--path'),
      cardEdge: cssVar('--card-edge'),
      dim: cssVar('--dim'),
      txt: cssVar('--txt'),
      mapWall: cssVar('--map-wall'), // base colour for the extruded 2.5D walls
    });

    const detectFrontiers = (data, w, h, info) => {
      const isFree = (i) => data[i] >= 0 && data[i] < 65;
      const isUnknown = (i) => data[i] < 0;
      const frontier = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!isFree(i)) continue;
          const nb = [x > 0 && i - 1, x < w - 1 && i + 1, y > 0 && i - w, y < h - 1 && i + w];
          if (nb.some((j) => j !== false && isUnknown(j))) frontier[i] = 1;
        }
      }
      const seen = new Uint8Array(w * h);
      const centroids = [];
      const stack = [];
      for (let s = 0; s < frontier.length; s++) {
        if (!frontier[s] || seen[s]) continue;
        stack.length = 0;
        stack.push(s);
        seen[s] = 1;
        let sx = 0;
        let sy = 0;
        let n = 0;
        while (stack.length) {
          const i = stack.pop();
          const x = i % w;
          const y = (i / w) | 0;
          sx += x;
          sy += y;
          n++;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (frontier[j] && !seen[j]) {
                seen[j] = 1;
                stack.push(j);
              }
            }
          }
        }
        if (n >= 3) {
          centroids.push([
            info.origin.position.x + (sx / n + 0.5) * info.resolution,
            info.origin.position.y + (sy / n + 0.5) * info.resolution,
          ]);
        }
      }
      frontiers = centroids;
      frontierCount = centroids.length;
    };

    // Merge contiguous wall cells into a small set of maximal rectangles (greedy:
    // grow right, then down). Per /map only. Turning thousands of wall cells into a
    // few hundred rects is what lets the per-frame 2.5D extrusion stay at 60 fps.
    const buildWallRects = (mask, w, h, bbox) => {
      const x0 = bbox ? bbox.x0 : 0;
      const y0 = bbox ? bbox.y0 : 0;
      const x1 = bbox ? bbox.x1 : w;
      const y1 = bbox ? bbox.y1 : h;
      const used = new Uint8Array(w * h);
      const rects = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * w + x;
          if (!mask[idx] || used[idx]) continue;
          let rw = 1;
          while (x + rw < x1 && mask[idx + rw] && !used[idx + rw]) rw++;
          let rh = 1;
          grow: while (y + rh < y1) {
            const row = (y + rh) * w + x;
            for (let k = 0; k < rw; k++) {
              if (!mask[row + k] || used[row + k]) break grow;
            }
            rh++;
          }
          for (let yy = y; yy < y + rh; yy++) {
            for (let xx = x; xx < x + rw; xx++) used[yy * w + xx] = 1;
          }
          rects.push({ x, y, w: rw, h: rh });
        }
      }
      return rects;
    };

    const rasterize = (msg) => {
      const w = msg.info.width;
      const h = msg.info.height;
      const data = msg.data;
      // Defensive: a malformed / truncated grid (data.length ≠ w·h, or a non-array
      // payload from an exotic rosbridge transport) must not smear rows - treat
      // anything missing as unknown rather than indexing off the end.
      if (!data || typeof data.length !== 'number' || !w || !h) return;
      mapMsg = msg;
      if (!bitmap || bitmap.width !== w || bitmap.height !== h) {
        bitmap = document.createElement('canvas');
        bitmap.width = w;
        bitmap.height = h;
      }
      const octx = bitmap.getContext('2d');
      const img = octx.createImageData(w, h);
      const cUnknown = hexToRgb(cssVar('--map-unknown'));
      const cFree = hexToRgb(cssVar('--map-free'));
      const cWall = hexToRgb(cssVar('--map-wall'));
      let known = 0;
      // Bounding box of known (explored) cells, in bitmap pixel coords, so the
      // view can frame the actual map instead of the full grid (which often has
      // large unexplored padding off to one side - the "empty left band").
      let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
      const n = w * h;
      const wallMask = new Uint8Array(n); // bitmap-space wall flags, for extrusion
      for (let i = 0; i < n; i++) {
        const v = i < data.length ? data[i] : -1;
        const c = v < 0 ? cUnknown : v >= 65 ? cWall : cFree;
        const x = i % w;
        const y = h - 1 - ((i / w) | 0); // flip Y
        if (v >= 0) {
          known++;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
        if (v >= 65) wallMask[y * w + x] = 1;
        const p = (y * w + x) * 4;
        img.data[p] = c[0];
        img.data[p + 1] = c[1];
        img.data[p + 2] = c[2];
        img.data[p + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      meta = {
        width: w,
        height: h,
        resolution: msg.info.resolution,
        originX: msg.info.origin.position.x,
        originY: msg.info.origin.position.y,
        // null until at least one known cell; falls back to full-grid framing
        known: bx1 >= bx0 ? { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 } : null,
      };
      coverage = n ? Math.round((known / n) * 100) : 0;
      wallRects = buildWallRects(wallMask, w, h, meta.known);
      detectFrontiers(data, w, h, msg.info);
    };

    // Rasterise a Nav2 costmap (OccupancyGrid, 0 free … 100 lethal, -1 unknown)
    // into an RGBA bitmap: free/unknown fully transparent, low cost cool blue
    // rising to lethal red, alpha baked in (~0.25 → ~0.6, lethal pops harder).
    // Same y-flip as the map raster. Colours are absolute (a cost scale), not
    // themed, so no re-raster is needed on theme change.
    const rasterizeCostmap = (msg, key) => {
      const w = msg.info?.width;
      const h = msg.info?.height;
      const data = msg.data;
      if (!data || typeof data.length !== 'number' || !w || !h) return;
      let cvs = costmaps[key]?.bitmap;
      if (!cvs || cvs.width !== w || cvs.height !== h) {
        cvs = document.createElement('canvas');
        cvs.width = w;
        cvs.height = h;
      }
      const c2 = cvs.getContext('2d');
      const img = c2.createImageData(w, h);
      const n = w * h;
      for (let i = 0; i < n; i++) {
        const v = i < data.length ? data[i] : -1;
        if (v <= 0) continue; // unknown / free stays transparent - map shows through
        const x = i % w;
        const y = h - 1 - ((i / w) | 0); // flip Y (grid origin is bottom-left)
        const p = (y * w + x) * 4;
        const t = v >= 100 ? 1 : v / 100;
        img.data[p] = 70 + 185 * t;      // blue (low) → red (lethal)
        img.data[p + 1] = 130 - 85 * t;
        img.data[p + 2] = 255 - 210 * t;
        img.data[p + 3] = v >= 99 ? 195 : 60 + 95 * t;
      }
      c2.putImageData(img, 0, 0);
      costmaps[key] = {
        bitmap: cvs,
        meta: {
          width: w,
          height: h,
          resolution: msg.info.resolution,
          originX: msg.info.origin.position.x,
          originY: msg.info.origin.position.y,
          frame: (msg.header?.frame_id || 'map').replace(/^\//, ''),
        },
      };
    };

    // Lazily (un)subscribe a costmap with the layer toggle: ON creates the topic
    // (rosbridge re-delivers the latched grid immediately), OFF tears it down and
    // clears the cached bitmap so the overlay vanishes at once.
    const CM_DEFS = { g: TOPICS.globalCostmap, l: TOPICS.localCostmap };
    const ensureCostmapSub = (key, on) => {
      if (on && !cmTopics[key]) {
        const t = new ROSLIB.Topic({
          ros, name: CM_DEFS[key].name, messageType: CM_DEFS[key].type, ...SUB_OPTS.costmap,
        });
        t.subscribe((m) => rasterizeCostmap(m, key));
        cmTopics[key] = t;
      } else if (!on && cmTopics[key]) {
        try { cmTopics[key].unsubscribe(); } catch { /* socket gone */ }
        cmTopics[key] = null;
        costmaps[key] = null;
      }
    };

    // world (m) ↔ bitmap pixel (y-down, matches the rasterised offscreen grid)
    const worldToPx = (wx, wy) => [
      (wx - meta.originX) / meta.resolution,
      meta.height - (wy - meta.originY) / meta.resolution,
    ];
    const setCenterFromPx = (cpx, cpy) => {
      view.current.cx = meta.originX + cpx * meta.resolution;
      view.current.cy = meta.originY + (meta.height - cpy) * meta.resolution;
    };

    const makeTransform = (cssW, cssH) => {
      if (!meta) return null;
      // Aspect-fit the explored region (known-cell bbox) so the map centres and
      // fills the surface; the camera (k, phi, centre) is layered on top.
      const b = meta.known || { x0: 0, y0: 0, x1: meta.width, y1: meta.height };
      const bw = b.x1 - b.x0;
      const bh = b.y1 - b.y0;
      const sFit = Math.min((cssW - PAD * 2) / bw, (cssH - PAD * 2) / bh);
      const v = view.current;
      if (!v.init) {
        // default view: centre of the explored bbox, fit scale, no rotation
        setCenterFromPx((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        v.k = 1;
        v.phi = 0;
        v.init = true;
      }
      const s = sFit * clamp(v.k, K_MIN, K_MAX);
      const cosp = Math.cos(v.phi);
      const sinp = Math.sin(v.phi);
      const cpx = (v.cx - meta.originX) / meta.resolution;
      const cpy = meta.height - (v.cy - meta.originY) / meta.resolution;
      const Cx = cssW / 2;
      const Cy = cssH / 2;
      const px = (gpx, gpy) => {
        const ux = (gpx - cpx) * s;
        const uy = (gpy - cpy) * s;
        return [cosp * ux - sinp * uy + Cx, sinp * ux + cosp * uy + Cy];
      };
      return {
        s, sFit, cosp, sinp, cpx, cpy, Cx, Cy, phi: v.phi,
        px,
        toScreen(wx, wy) {
          const [gpx, gpy] = worldToPx(wx, wy);
          return px(gpx, gpy);
        },
      };
    };

    // ---- gesture helpers ----
    const screenToPx = (T, sx, sy) => {
      const ux = sx - T.Cx;
      const uy = sy - T.Cy;
      const rx = (T.cosp * ux + T.sinp * uy) / T.s; // rotate by -phi, undo scale
      const ry = (-T.sinp * ux + T.cosp * uy) / T.s;
      return [rx + T.cpx, ry + T.cpy];
    };
    // Re-centre so bitmap-px (gpx,gpy) lands at screen (sx,sy) for a given s, phi.
    const anchorPx = (gpx, gpy, sx, sy, s, phi) => {
      const cosp = Math.cos(phi);
      const sinp = Math.sin(phi);
      const ux = sx - lastT.Cx;
      const uy = sy - lastT.Cy;
      const rx = (cosp * ux + sinp * uy) / s;
      const ry = (-sinp * ux + cosp * uy) / s;
      setCenterFromPx(gpx - rx, gpy - ry);
    };

    const canvasXY = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const onPointerDown = (e) => {
      if (!lastT || !meta) return;
      // A finger touch takes over from any easing/coasting camera move.
      view.current.anim = false; view.current.fit = false; view.current.momentum = false;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const [x, y] = canvasXY(e);
      pointers.set(e.pointerId, { x, y });
      if (pointers.size === 1) {
        const [gpx, gpy] = screenToPx(lastT, x, y);
        gesture = { mode: 'pan', id: e.pointerId, gpx, gpy, downX: x, downY: y, downT: performance.now(), moved: false };
        canvas.style.cursor = 'grabbing';
      } else if (pointers.size === 2) {
        const it = [...pointers.entries()];
        const A0 = screenToPx(lastT, it[0][1].x, it[0][1].y);
        const A1 = screenToPx(lastT, it[1][1].x, it[1][1].y);
        gesture = { mode: 'pinch', ids: [it[0][0], it[1][0]], A0, A1, sFit: lastT.sFit };
      }
    };

    const onPointerMove = (e) => {
      if (!pointers.has(e.pointerId) || !lastT) return;
      const [x, y] = canvasXY(e);
      pointers.set(e.pointerId, { x, y });
      if (gesture && gesture.mode === 'pan' && pointers.size === 1) {
        if (Math.hypot(x - gesture.downX, y - gesture.downY) > TAP_PX) gesture.moved = true;
        anchorPx(gesture.gpx, gesture.gpy, x, y, lastT.s, view.current.phi);
        // Track centre velocity (world units/ms, lightly smoothed) for flick momentum.
        const nowT = performance.now();
        const cx = view.current.cx;
        const cy = view.current.cy;
        if (gesture.pt != null) {
          const dt = nowT - gesture.pt;
          if (dt > 0) {
            const a = 0.5;
            gesture.vx = (1 - a) * (gesture.vx || 0) + a * ((cx - gesture.pcx) / dt);
            gesture.vy = (1 - a) * (gesture.vy || 0) + a * ((cy - gesture.pcy) / dt);
          }
        }
        gesture.pcx = cx; gesture.pcy = cy; gesture.pt = nowT;
      } else if (gesture && gesture.mode === 'pinch' && pointers.size >= 2) {
        const p0 = pointers.get(gesture.ids[0]);
        const p1 = pointers.get(gesture.ids[1]);
        if (!p0 || !p1) return;
        // Solve the similarity (scale·rotation·translation) that keeps both
        // grabbed world points under both fingers. z = (q0-q1)/(A0-A1) (complex);
        // |z| = scale, arg z = rotation; then centre from one anchor.
        const dqx = p0.x - p1.x;
        const dqy = p0.y - p1.y;
        const dAx = gesture.A0[0] - gesture.A1[0];
        const dAy = gesture.A0[1] - gesture.A1[1];
        const denom = dAx * dAx + dAy * dAy;
        if (denom < 1e-9) return;
        let zx = (dqx * dAx + dqy * dAy) / denom;
        let zy = (dqy * dAx - dqx * dAy) / denom;
        const phi = Math.atan2(zy, zx);
        let s = Math.hypot(zx, zy);
        const k = clamp(s / gesture.sFit, K_MIN, K_MAX);
        s = k * gesture.sFit;
        zx = s * Math.cos(phi);
        zy = s * Math.sin(phi);
        const ex = p0.x - lastT.Cx;
        const ey = p0.y - lastT.Cy;
        const s2 = s * s;
        const cpx = gesture.A0[0] - (ex * zx + ey * zy) / s2;
        const cpy = gesture.A0[1] - (ey * zx - ex * zy) / s2;
        view.current.k = k;
        view.current.phi = phi;
        view.current.init = true;
        setCenterFromPx(cpx, cpy);
      }
    };

    const endPointer = (e) => {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      const wasPan = gesture && gesture.mode === 'pan' && gesture.id === e.pointerId;
      const tap = wasPan && !gesture.moved && performance.now() - gesture.downT < TAP_MS;
      const [ux, uy] = canvasXY(e);
      // Snapshot the flick velocity before the gesture is torn down (fresh + real move).
      const flick = wasPan && gesture.moved && !easeReduce
        ? { vx: gesture.vx || 0, vy: gesture.vy || 0, t: gesture.pt || 0 }
        : null;
      pointers.delete(e.pointerId);
      if (tap && navModeRef.current && expandedRef.current) {
        pickGoal(ux, uy); // armed tap on the (expanded) map → propose a goal (confirm chip)
      } else if (tap && !expandedRef.current && requestExpandRef.current) {
        requestExpandRef.current(); // a clean tap on the docked map → expand
      }
      if (pointers.size === 1) {
        // dropped from pinch to one finger → resume panning with the remainder
        const [id, p] = [...pointers.entries()][0];
        const [gpx, gpy] = screenToPx(lastT, p.x, p.y);
        gesture = { mode: 'pan', id, gpx, gpy, downX: p.x, downY: p.y, downT: performance.now(), moved: true };
      } else if (pointers.size === 0) {
        gesture = null;
        canvas.style.cursor = navModeRef.current ? 'crosshair' : 'grab';
        // Launch a coasting flick if the release was recent and fast enough. The
        // camera centre is in world metres but lastT.s is screen-px per BITMAP-pixel,
        // so px/metre = s / resolution — used to judge/cap the flick in screen space.
        if (flick && performance.now() - flick.t < 60) {
          let vx = flick.vx * 16.7; // world metres/ms → per ~60fps frame
          let vy = flick.vy * 16.7;
          const pxPerM = (lastT && meta) ? lastT.s / meta.resolution : 1;
          const spd = Math.hypot(vx, vy) * pxPerM; // screen px/frame
          const CAP = 45;
          if (spd > CAP) { const r = CAP / spd; vx *= r; vy *= r; }
          if (spd > 6) {
            const cam = view.current;
            cam.mvx = vx; cam.mvy = vy; cam.momentum = true;
          }
        }
      }
    };

    const onWheel = (e) => {
      if (!lastT || !meta) return;
      // Wheel zoom overrides any easing/coasting camera move.
      view.current.anim = false; view.current.fit = false; view.current.momentum = false;
      e.preventDefault();
      const [x, y] = canvasXY(e);
      const [gpx, gpy] = screenToPx(lastT, x, y);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = clamp(view.current.k * factor, K_MIN, K_MAX);
      view.current.k = k;
      view.current.init = true;
      anchorPx(gpx, gpy, x, y, lastT.sFit * k, view.current.phi); // keep cursor world fixed
    };

    // ---- semantic object sprites (Task 3B, 3D) ----
    // Per-object animation state (persists across frames): a smoothed world position
    // (so 5 Hz detections move smoothly at 60 fps), a walk phase, and a speed estimate
    // that decides standing vs walking for people.
    const spriteState = new Map(); // id -> { x, y, phase, speed }
    let lastIconT = 0;
    const OBJ_MAX = 20;
    const drawObjectIcons = (ctx2, T2) => {
      const objs = objectsRef.current;
      const nowT = performance.now();
      const dt = lastIconT ? Math.min(0.1, (nowT - lastIconT) / 1000) : 0.016;
      lastIconT = nowT;
      if (!objs || !objs.length || !T2) { spriteState.clear(); return; }
      const r = clamp(11 + T2.s * 0.6, 14, 30); // sprite base size, grows with zoom
      const seen = new Set();
      // Project + smooth, then paint far→near so nearer sprites overlap correctly.
      const items = objs.slice(0, OBJ_MAX).map((o) => {
        seen.add(o.id);
        let st = spriteState.get(o.id);
        if (!st) { st = { x: o.x, y: o.y, phase: 0, speed: 0 }; spriteState.set(o.id, st); }
        const a = 0.28; // position smoothing toward the latest detection
        const dx = (o.x - st.x) * a;
        const dy = (o.y - st.y) * a;
        st.x += dx; st.y += dy;
        const inst = Math.hypot(dx, dy) / Math.max(dt, 1e-3); // m/s of the smoothed dot
        st.speed = st.speed * 0.75 + inst * 0.25;
        const walking = st.speed > 0.06;
        if (walking) st.phase += dt * 9; // stride cadence
        const [px, py] = T2.toScreen(st.x, st.y);
        const grp = classGroup(o.cls);
        const hex = grp === 'living' ? palette.coral : grp === 'furniture' ? palette.sky : palette.gold;
        return { o, px, py, rgb: hexToRgb(hex), walking, phase: st.phase };
      });
      items.sort((p, q) => p.py - q.py);
      ctx2.save();
      for (const it of items) {
        drawObjectSprite(ctx2, it.o.cls, it.px, it.py, r, it.rgb, it.o.opacity, it.walking, it.phase);
      }
      ctx2.restore();
      // Drop state for objects that expired.
      for (const id of spriteState.keys()) if (!seen.has(id)) spriteState.delete(id);
    };

    const draw = () => {
      const cv = canvasRef.current;
      if (!cv) {
        raf = requestAnimationFrame(draw);
        return;
      }
      // Reset/fit request from the toolbar: the fit framing (bbox centre, k=1, phi=0)
      // is only known here, so the button raises `fit` and we turn it into an eased
      // target toward the same view makeTransform would snap to.
      const cam = view.current;
      if (cam.fit && meta) {
        const b = meta.known || { x0: 0, y0: 0, x1: meta.width, y1: meta.height };
        cam.tcx = meta.originX + ((b.x0 + b.x1) / 2) * meta.resolution;
        cam.tcy = meta.originY + (meta.height - (b.y0 + b.y1) / 2) * meta.resolution;
        cam.tk = 1;
        cam.tphi = 0;
        cam.anim = true;
        cam.fit = false;
      }
      // Ease the camera toward a toolbar target (set by MapControls). Exponential
      // ease-out: most of the motion is in the first frames, then it settles and
      // clears the flag. Reduced-motion (or being effectively there) snaps at once.
      if (cam.anim) {
        cam.momentum = false; // a toolbar move wins over any coasting flick
        const s = easeReduce ? 1 : 0.3;
        cam.cx += (cam.tcx - cam.cx) * s;
        cam.cy += (cam.tcy - cam.cy) * s;
        cam.k += (cam.tk - cam.k) * s;
        cam.phi += (cam.tphi - cam.phi) * s;
        if (easeReduce
          || (Math.abs(cam.tk - cam.k) < 1e-3
            && Math.abs(cam.tphi - cam.phi) < 1e-4
            && Math.hypot(cam.tcx - cam.cx, cam.tcy - cam.cy) < 1e-3)) {
          cam.cx = cam.tcx; cam.cy = cam.tcy; cam.k = cam.tk; cam.phi = cam.tphi;
          cam.anim = false;
        }
      } else if (cam.momentum && pointers.size === 0) {
        // Coast after a flick-pan: decay the centre velocity (world units/frame) and
        // stop once it slows below ~0.5 px/frame on screen. Cancelled by any pointer.
        cam.cx += cam.mvx;
        cam.cy += cam.mvy;
        cam.mvx *= 0.88;
        cam.mvy *= 0.88;
        const pxPerM = (lastT && meta) ? lastT.s / meta.resolution : 1;
        if (Math.hypot(cam.mvx, cam.mvy) * pxPerM < 0.5) cam.momentum = false;
      }
      if (dirtyRef.current || !palette) {
        palette = readPalette(); // theme changed (or first frame): refresh colours
      }
      if (dirtyRef.current && mapMsg) {
        rasterize(mapMsg);
        dirtyRef.current = false;
      }
      const ctx = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const cssW = cv.clientWidth;
      const cssH = cv.clientHeight;
      if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const inset = palette.inset;
      ctx.fillStyle = inset;
      ctx.fillRect(0, 0, cssW, cssH);

      const T = makeTransform(cssW, cssH);
      lastT = T;
      const L = layersRef.current;
      ensureCostmapSub('g', !!L.gcost);
      ensureCostmapSub('l', !!L.lcost);
      if (T && bitmap) {
        const { accent, sky, gold, path: pathCol } = palette;

        // The grid bitmap, under the full translate·rotate·scale camera.
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.translate(T.Cx, T.Cy);
        ctx.rotate(T.phi);
        ctx.scale(T.s, T.s);
        ctx.translate(-T.cpx, -T.cpy);
        ctx.drawImage(bitmap, 0, 0);
        ctx.restore();

        // Nav2 costmap overlays (global under local), painted between the floor
        // and the 3D walls so inflation reads as colour on the ground. Each grid
        // is placed by its own origin/resolution in map-bitmap px space; an
        // odom-frame grid (the local costmap) is additionally moved by the live
        // map->odom TF. If that transform lags (the known 1-3 s WiFi delay) the
        // window shows slightly offset while driving - a frame artifact, not a
        // bug - and if it is briefly missing we draw at the last identity rather
        // than freezing the frame.
        for (const key of ['g', 'l']) {
          if (!(key === 'g' ? L.gcost : L.lcost)) continue;
          const cm = costmaps[key];
          if (!cm) continue;
          const off = cm.meta.frame === 'map'
            ? { x: 0, y: 0, yaw: 0 }
            : lookupPose(cm.meta.frame, 'map') || { x: 0, y: 0, yaw: 0 };
          const k = cm.meta.resolution / meta.resolution;
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.translate(T.Cx, T.Cy);
          ctx.rotate(T.phi);
          ctx.scale(T.s, T.s);
          ctx.translate(-T.cpx, -T.cpy);
          // frame origin in map px, then a world-yaw rotation (negated: px space
          // is y-down), then the grid's own origin offset inside that frame
          const [fpx, fpy] = worldToPx(off.x, off.y);
          ctx.translate(fpx, fpy);
          ctx.rotate(-off.yaw);
          ctx.drawImage(
            cm.bitmap,
            cm.meta.originX / meta.resolution,
            -(cm.meta.originY + cm.meta.height * cm.meta.resolution) / meta.resolution,
            cm.meta.width * k,
            cm.meta.height * k,
          );
          ctx.restore();
        }

        // 2.5D walls: extrude each merged wall rectangle into a solid block using an
        // OBLIQUE (cavalier) projection — the cap is the base shifted up-and-right in
        // screen space, so the connecting side faces have real area and read as 3D
        // (a straight-up lift collapses the left/right faces to zero width → looks
        // flat). The floor stays a flat top-down draw and the gesture inverse is
        // untouched; this is purely a screen-space overlay. Lighting is fixed to the
        // screen (upper-left) so it stays consistent as the map rotates. Skipped for
        // pathological maps (very many rects) so a noisy grid can't blow the budget.
        if (wallRects.length && wallRects.length < 3000) {
          const wallRgb = hexToRgb(palette.mapWall);
          const lift = clamp(T.s * 1.35, 12, 52);  // block height (screen px), grows w/ zoom
          const ox = lift * 0.5;                    // cavalier lean: cap shifts right…
          const oy = -lift;                         // …and up
          const shx = Math.max(3, lift * 0.22);     // grounding-shadow offset (down-right)
          const shy = Math.max(4, lift * 0.30);
          const LX = -0.55, LY = -0.83;            // screen-space light dir (upper-left)
          const capCol = shade(wallRgb, 1.2);
          const capStroke = shade(wallRgb, 0.42);
          ctx.lineJoin = 'round';
          // pass 1: grounding shadows (all rects first, so no block sits on a neighbour's shadow)
          ctx.fillStyle = 'rgba(0,0,0,0.34)';
          for (const r of wallRects) {
            const s0 = T.px(r.x, r.y), s1 = T.px(r.x + r.w, r.y);
            const s2 = T.px(r.x + r.w, r.y + r.h), s3 = T.px(r.x, r.y + r.h);
            ctx.beginPath();
            ctx.moveTo(s0[0] + shx, s0[1] + shy);
            ctx.lineTo(s1[0] + shx, s1[1] + shy);
            ctx.lineTo(s2[0] + shx, s2[1] + shy);
            ctx.lineTo(s3[0] + shx, s3[1] + shy);
            ctx.closePath();
            ctx.fill();
          }
          // pass 2: side faces + lit cap per rect
          for (const r of wallRects) {
            const base = [
              T.px(r.x, r.y), T.px(r.x + r.w, r.y),
              T.px(r.x + r.w, r.y + r.h), T.px(r.x, r.y + r.h),
            ];
            const cap = base.map((p) => [p[0] + ox, p[1] + oy]);
            // winding sign (screen space, y-down) → outward edge normals
            let area2 = 0;
            for (let i = 0; i < 4; i++) {
              const a = base[i], c = base[(i + 1) % 4];
              area2 += a[0] * c[1] - c[0] * a[1];
            }
            const flip = area2 < 0;
            for (let i = 0; i < 4; i++) {
              const P = base[i], Q = base[(i + 1) % 4];
              let nx = Q[1] - P[1], ny = -(Q[0] - P[0]); // right-hand normal
              if (flip) { nx = -nx; ny = -ny; }
              if (nx * ox + ny * oy > 0) continue;        // back-facing → cull
              const nl = Math.hypot(nx, ny) || 1;
              const litf = Math.max(0, (nx * LX + ny * LY) / nl);
              ctx.fillStyle = shade(wallRgb, 0.3 + 0.5 * litf);
              const Pc = cap[i], Qc = cap[(i + 1) % 4];
              ctx.beginPath();
              ctx.moveTo(P[0], P[1]);
              ctx.lineTo(Q[0], Q[1]);
              ctx.lineTo(Qc[0], Qc[1]);
              ctx.lineTo(Pc[0], Pc[1]);
              ctx.closePath();
              ctx.fill();
            }
            // lit top cap
            ctx.fillStyle = capCol;
            ctx.beginPath();
            ctx.moveTo(cap[0][0], cap[0][1]);
            ctx.lineTo(cap[1][0], cap[1][1]);
            ctx.lineTo(cap[2][0], cap[2][1]);
            ctx.lineTo(cap[3][0], cap[3][1]);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = capStroke;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        // Frame the explored region (rotates with the view) so the aspect-fit
        // gutters read as a deliberate display surface, not dead space.
        const b = meta.known || { x0: 0, y0: 0, x1: meta.width, y1: meta.height };
        const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
        ctx.strokeStyle = palette.cardEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        corners.forEach(([gx, gy], i) => {
          const [sx, sy] = T.px(gx, gy);
          if (i) ctx.lineTo(sx, sy);
          else ctx.moveTo(sx, sy);
        });
        ctx.closePath();
        ctx.stroke();

        // optional metric grid (1 m spacing), faint, aligned to the map cells
        if (L.grid) {
          const stepPx = Math.max(1, Math.round(1 / meta.resolution));
          ctx.strokeStyle = accent + '24';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let gx = Math.ceil(b.x0 / stepPx) * stepPx; gx <= b.x1; gx += stepPx) {
            const [lx0, ly0] = T.px(gx, b.y0);
            const [lx1, ly1] = T.px(gx, b.y1);
            ctx.moveTo(lx0, ly0); ctx.lineTo(lx1, ly1);
          }
          for (let gy = Math.ceil(b.y0 / stepPx) * stepPx; gy <= b.y1; gy += stepPx) {
            const [lx0, ly0] = T.px(b.x0, gy);
            const [lx1, ly1] = T.px(b.x1, gy);
            ctx.moveTo(lx0, ly0); ctx.lineTo(lx1, ly1);
          }
          ctx.stroke();
        }

        // /scan: faint rays + glowing laser points
        if (scan && pose && L.scan) {
          const { angle_min, angle_increment, ranges, range_max } = scan;
          const [rpx, rpy] = T.toScreen(pose.x, pose.y);
          ctx.strokeStyle = sky + '2e';
          ctx.lineWidth = 1;
          ctx.beginPath();
          const pts = [];
          for (let i = 0; i < ranges.length; i++) {
            const r = ranges[i];
            if (!Number.isFinite(r) || r <= 0 || r >= range_max) continue;
            const ang = pose.yaw + angle_min + i * angle_increment;
            const [sx, sy] = T.toScreen(pose.x + r * Math.cos(ang), pose.y + r * Math.sin(ang));
            ctx.moveTo(rpx, rpy);
            ctx.lineTo(sx, sy);
            pts.push([sx, sy]);
          }
          ctx.stroke();
          // Additive blend so overlapping returns bloom like a real laser. NO
          // per-point shadowBlur (it's the single most expensive canvas op and we
          // draw hundreds of points/frame) - the glow comes from a translucent
          // halo under 'lighter' plus a bright core.
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = sky + '55';
          for (const [sx, sy] of pts) {
            ctx.beginPath();
            ctx.arc(sx, sy, 3, 0, 7);
            ctx.fill();
          }
          // bright hot core
          ctx.fillStyle = 'rgba(220,245,255,0.9)';
          for (const [sx, sy] of pts) {
            ctx.beginPath();
            ctx.arc(sx, sy, 1, 0, 7);
            ctx.fill();
          }
          ctx.restore();
        }

        // travelled trail
        if (trail.length > 1 && L.trail) {
          ctx.strokeStyle = accent + '88';
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          for (let i = 0; i < trail.length; i++) {
            const [sx, sy] = T.toScreen(trail[i][0], trail[i][1]);
            if (i) ctx.lineTo(sx, sy);
            else ctx.moveTo(sx, sy);
          }
          ctx.stroke();
        }

        // Nav2 global plan - the route the robot intends to take (map frame, so
        // pose-free). Drawn as a bright green line with a soft halo + a goal dot,
        // distinct from the pink "where it's been" trail.
        if (plan.length > 1 && L.path) {
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.strokeStyle = pathCol + '40';
          ctx.lineWidth = 6;
          ctx.beginPath();
          for (let i = 0; i < plan.length; i++) {
            const [sx, sy] = T.toScreen(plan[i][0], plan[i][1]);
            if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
          }
          ctx.stroke();
          ctx.strokeStyle = pathCol;
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = 0; i < plan.length; i++) {
            const [sx, sy] = T.toScreen(plan[i][0], plan[i][1]);
            if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
          }
          ctx.stroke();
          // goal dot at the end of the plan
          const [gx, gy] = T.toScreen(plan[plan.length - 1][0], plan[plan.length - 1][1]);
          ctx.fillStyle = pathCol;
          ctx.beginPath();
          ctx.arc(gx, gy, 4, 0, 7);
          ctx.fill();
          ctx.strokeStyle = pathCol + '66';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(gx, gy, 8, 0, 7);
          ctx.stroke();
        }

        // Nav2 goal marker: the picked-but-unconfirmed point (gold, dashed ring)
        // or the last SENT goal (path green, same semantics as the plan's goal
        // dot). World-fixed like every overlay, so it tracks pan/zoom/rotate and
        // shows docked too. MapCard owns the value; it is never cached across
        // connections (rule: goal coords are map-specific).
        const gm = goalRef.current;
        if (gm) {
          const [sx, sy] = T.toScreen(gm.x, gm.y);
          const col = gm.pending ? gold : pathCol;
          ctx.save();
          ctx.strokeStyle = col;
          ctx.fillStyle = col;
          ctx.lineWidth = 2;
          if (gm.pending) ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(sx, sy, 9, 0, 7);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(sx, sy, 2.6, 0, 7);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            ctx.moveTo(sx + ax * 6, sy + ay * 6);
            ctx.lineTo(sx + ax * 13, sy + ay * 13);
          }
          ctx.stroke();
          ctx.restore();
        }

        // frontier markers (toggleable)
        if (L.frontiers) for (const [fx, fy] of frontiers) {
          const [sx, sy] = T.toScreen(fx, fy);
          ctx.fillStyle = gold;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, 7);
          ctx.fill();
          ctx.strokeStyle = gold + '55';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(sx, sy, 7, 0, 7);
          ctx.stroke();
        }

        // robot marker — a stylised top-down 3-D rover that mirrors the real
        // two-tier round chassis: extruded MDF-style decks (accent), a black
        // LiDAR puck, two chunky side wheels, gold standoffs and sky-blue
        // forward ultrasonic sensors that also point the heading. It is drawn to
        // the robot's TRUE footprint (metres → px via the map resolution) with a
        // visible floor when zoomed out, so its size tracks the walls. 3-D shading
        // is screen-fixed (upper-left light, like the walls); only the wheels and
        // front sensors rotate with the heading. Toggleable via the layers panel.
        if (pose && L.robot) {
          const [sx, sy] = T.toScreen(pose.x, pose.y);
          const hd = T.phi - pose.yaw;                    // heading in screen space
          const fwx = Math.cos(hd), fwy = Math.sin(hd);   // forward unit (screen)
          const rgx = -Math.sin(hd), rgy = Math.cos(hd);  // robot-right unit (screen)
          const pxPerM = meta ? T.s / meta.resolution : T.s * 20;
          const R = clamp(ROBOT_RADIUS_M * pxPerM, 12, 58); // body radius (px)
          const acc = hexToRgb(accent);
          const skyR = hexToRgb(sky);
          const goldR = hexToRgb(gold);

          // an extruded disc: a dark "thickness" (base circle) under a lit cap
          // shifted up-and-right, matching the walls' oblique projection + light.
          // Returns the cap centre so things can be stacked on top of it.
          const disc = (cx, cy, rad, lift, capLo, capHi, sideLo, sideHi, stroke) => {
            const ox = lift * 0.34, oy = -lift;
            const gs = ctx.createLinearGradient(cx, cy + rad, cx, cy - rad);
            gs.addColorStop(0, sideLo); gs.addColorStop(1, sideHi);
            ctx.fillStyle = gs;
            ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7); ctx.fill();
            const gc = ctx.createLinearGradient(cx + ox, cy + oy + rad, cx + ox, cy + oy - rad);
            gc.addColorStop(0, capLo); gc.addColorStop(1, capHi);
            ctx.fillStyle = gc;
            ctx.beginPath(); ctx.arc(cx + ox, cy + oy, rad, 0, 7); ctx.fill();
            if (stroke) { ctx.lineWidth = Math.max(1, rad * 0.04); ctx.strokeStyle = stroke; ctx.stroke(); }
            return [cx + ox, cy + oy];
          };

          // soft accent presence halo, then a ground shadow offset down-right
          const halo = ctx.createRadialGradient(sx, sy, R * 0.5, sx, sy, R * 1.7);
          halo.addColorStop(0, accent + '00');
          halo.addColorStop(0.66, accent + '22');
          halo.addColorStop(1, accent + '00');
          ctx.fillStyle = halo;
          ctx.beginPath(); ctx.arc(sx, sy, R * 1.7, 0, 7); ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          ctx.beginPath();
          ctx.ellipse(sx + R * 0.18, sy + R * 0.24, R * 1.16, R * 1.0, 0, 0, 7);
          ctx.fill();

          // chunky dark tires on each side, rolling along the heading; drawn first
          // so the decks overlap their inner half and the tread pokes out (as real)
          for (const side of [-1, 1]) {
            const wx = sx + rgx * R * 1.12 * side;
            const wy = sy + rgy * R * 1.12 * side;
            ctx.save();
            ctx.translate(wx, wy);
            ctx.rotate(hd);
            const wl = R * 1.12, ww = R * 0.52;
            ctx.fillStyle = '#15171d';
            roundRect(ctx, -wl / 2, -ww / 2, wl, ww, ww * 0.4);
            ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.10)'; // top sheen
            roundRect(ctx, -wl / 2, -ww / 2, wl, ww * 0.32, ww * 0.32);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.08)'; // tread
            ctx.lineWidth = Math.max(1, ww * 0.1);
            for (let t = -2; t <= 2; t++) {
              const tx = t * wl * 0.16;
              ctx.beginPath();
              ctx.moveTo(tx, -ww * 0.42);
              ctx.lineTo(tx, ww * 0.42);
              ctx.stroke();
            }
            ctx.restore();
          }

          // lower deck (in shadow) then upper deck (lit) → the two-tier thickness
          disc(sx, sy + R * 0.08, R * 1.04, R * 0.16,
            shade(acc, 0.5), shade(acc, 0.66), shade(acc, 0.3), shade(acc, 0.42),
            shade(acc, 0.5));
          const [dx, dy] = disc(sx, sy - R * 0.06, R * 0.96, R * 0.22,
            shade(acc, 1.08), shade(acc, 1.55), shade(acc, 0.42), shade(acc, 0.6),
            shade(acc, 0.72));

          // gold standoffs poking up through the upper deck
          ctx.fillStyle = shade(goldR, 1.12);
          for (const ang of [-2.3, -0.84, 0.84, 2.3]) {
            const gxp = dx + Math.cos(ang) * R * 0.8;
            const gyp = dy + Math.sin(ang) * R * 0.8;
            ctx.beginPath(); ctx.arc(gxp, gyp, Math.max(1.2, R * 0.07), 0, 7); ctx.fill();
          }

          // front "headlight" arc + two sky-blue ultrasonic sensors → heading cue
          ctx.strokeStyle = shade(acc, 1.7);
          ctx.lineWidth = Math.max(1.5, R * 0.1);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(dx, dy, R * 0.9, hd - 0.5, hd + 0.5);
          ctx.stroke();
          ctx.lineCap = 'butt';
          for (const side of [-1, 1]) {
            const ux = dx + fwx * R * 0.74 + rgx * R * 0.24 * side;
            const uy = dy + fwy * R * 0.74 + rgy * R * 0.24 * side;
            ctx.fillStyle = shade(skyR, 0.8);
            ctx.beginPath(); ctx.arc(ux, uy, Math.max(1.6, R * 0.13), 0, 7); ctx.fill();
            ctx.fillStyle = shade(skyR, 1.5);
            ctx.beginPath(); ctx.arc(ux - R * 0.03, uy - R * 0.04, Math.max(0.8, R * 0.05), 0, 7); ctx.fill();
          }

          // LiDAR puck — a tall black cylinder with a glossy cap + accent scan ring
          const lx = dx + fwx * R * 0.04, ly = dy + fwy * R * 0.04;
          const [px2, py2] = disc(lx, ly, R * 0.38, R * 0.27,
            'rgb(26,28,34)', 'rgb(40,44,52)', 'rgb(12,13,17)', 'rgb(20,22,28)',
            shade(acc, 0.55));
          ctx.strokeStyle = accent + 'cc'; // spinning scan ring
          ctx.lineWidth = Math.max(1, R * 0.05);
          ctx.beginPath(); ctx.arc(px2, py2, R * 0.27, 0, 7); ctx.stroke();
          const gl = ctx.createRadialGradient(px2 - R * 0.11, py2 - R * 0.13, 1, px2, py2, R * 0.38);
          gl.addColorStop(0, 'rgba(255,255,255,0.5)');
          gl.addColorStop(0.5, 'rgba(255,255,255,0.05)');
          gl.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = gl;
          ctx.beginPath(); ctx.arc(px2, py2, R * 0.42, 0, 7); ctx.fill();
        }

        // semantic detection icons on top of everything (Task 3B, toggleable)
        if (L.objects) drawObjectIcons(ctx, T);
        else spriteState.clear();
      } else {
        ctx.fillStyle = palette.dim;
        ctx.font = '13px monospace';
        ctx.fillText('awaiting /map ...', 16, 24);
      }

      // push derived stats upward (throttled)
      const now = performance.now();
      if (now - lastReport > REPORT_MS) {
        lastReport = now;
        onStats({
          pose,
          coverage,
          frontiers: frontierCount,
          scanHz: scanRate.lastSeen && now - scanRate.lastSeen < 1500 ? scanRate.hz : null,
        });
      }

      raf = requestAnimationFrame(draw);
    };

    // ---- pose source: prefer TF (map->base_link), fall back to /robot_pose ----
    // The on-map LiDAR + robot marker need the robot's pose in the MAP frame. The
    // robot doesn't publish /robot_pose, but it does broadcast TF (slam_toolbox
    // map->odom, EKF odom->base_link), so we compose that chain ourselves.
    const norm = (f) => (f || '').replace(/^\//, '');
    const setTfs = (transforms) => {
      for (const t of transforms || []) {
        const tr = t.transform.translation;
        tfTree.set(norm(t.child_frame_id), {
          parent: norm(t.header.frame_id),
          x: tr.x, y: tr.y, yaw: quatToYaw(t.transform.rotation),
        });
      }
    };
    const lookupPose = (target, root) => {
      const chain = [];
      let f = norm(target);
      let guard = 0;
      while (f !== root) {
        const node = tfTree.get(f);
        if (!node || guard++ > 64) return null; // chain broken or cyclic
        chain.push(node);
        f = node.parent;
      }
      let X = 0, Y = 0, TH = 0; // compose root -> target
      for (let i = chain.length - 1; i >= 0; i--) {
        const n = chain[i];
        const c = Math.cos(TH), s = Math.sin(TH);
        X += c * n.x - s * n.y;
        Y += s * n.x + c * n.y;
        TH += n.yaw;
      }
      return { x: X, y: Y, yaw: TH };
    };
    const poseFromTf = () => {
      for (const base of ['base_link', 'base_footprint']) {
        const p = lookupPose(base, 'map');
        if (p) return p;
      }
      return null;
    };
    const setPose = (p) => {
      pose = p;
      const lastPt = trail[trail.length - 1];
      if (!lastPt || Math.hypot(p.x - lastPt[0], p.y - lastPt[1]) > 0.02) {
        trail.push([p.x, p.y]);
        if (trail.length > TRAIL_MAX) trail.shift();
      }
    };

    const mapTopic = new ROSLIB.Topic({
      ros, name: TOPICS.map.name, messageType: TOPICS.map.type, ...SUB_OPTS.map,
    });
    const scanTopic = new ROSLIB.Topic({
      ros, name: TOPICS.scan.name, messageType: TOPICS.scan.type, ...SUB_OPTS.scan,
    });
    const poseTopic = new ROSLIB.Topic({
      ros, name: TOPICS.robotPose.name, messageType: TOPICS.robotPose.type,
    });
    const planTopic = new ROSLIB.Topic({
      ros, name: TOPICS.plan.name, messageType: TOPICS.plan.type, ...SUB_OPTS.plan,
    });
    const tfTopic = new ROSLIB.Topic({
      ros, name: TOPICS.tf.name, messageType: TOPICS.tf.type, throttle_rate: 50, queue_length: 1,
    });
    const tfStaticTopic = new ROSLIB.Topic({
      ros, name: TOPICS.tfStatic.name, messageType: TOPICS.tfStatic.type,
    });
    // Tap-to-navigate PICK (gated by navMode): a tap is converted to map-frame
    // metres here - the exact inverse of the render transform, using the live
    // /map metadata (origin, resolution) - and reported UP. MapCard shows the
    // confirm chip and owns the actual /goal_pose publish, so nothing goes on
    // the wire from a tap alone.
    // bitmap px → world (m): exact inverse of worldToPx.
    const pxToWorld = (gpx, gpy) => [
      meta.originX + gpx * meta.resolution,
      meta.originY + (meta.height - gpy) * meta.resolution,
    ];
    const pickGoal = (sx, sy) => {
      if (!lastT || !meta) return; // no real occupancy grid yet - nothing to convert against
      const [gpx, gpy] = screenToPx(lastT, sx, sy);
      const [wx, wy] = pxToWorld(gpx, gpy);
      if (onGoalPickRef.current) onGoalPickRef.current({ x: wx, y: wy });
    };

    mapTopic.subscribe((msg) => rasterize(msg));
    scanTopic.subscribe((msg) => {
      scan = msg;
      const now = performance.now();
      // TRUE sensor rate comes from the LaserScan's own scan_time field (seconds per
      // revolution, set by the rplidar driver) — it's immune to the 100 ms rosbridge
      // throttle and websocket jitter that made the old receive-interval estimate read
      // high/unstable. Only fall back to inter-arrival if the driver leaves it at 0.
      const st = msg.scan_time;
      if (st && st > 0 && st < 2) {
        const hz = 1 / st;
        scanRate.hz = scanRate.hz ? scanRate.hz + 0.3 * (hz - scanRate.hz) : hz;
      } else if (scanRate.last) {
        const dt = (now - scanRate.last) / 1000;
        if (dt > 0) scanRate.hz = scanRate.hz ? scanRate.hz + 0.25 * (1 / dt - scanRate.hz) : 1 / dt;
      }
      scanRate.last = now;
      scanRate.lastSeen = now;
    });
    poseTopic.subscribe((msg) => {
      // Fallback only: skip if TF gave us a pose in the last ~1.2 s.
      if (performance.now() - lastTfPose < 1200) return;
      const p = msg.pose.position;
      setPose({ x: p.x, y: p.y, yaw: quatToYaw(msg.pose.orientation) });
    });
    planTopic.subscribe((msg) => {
      // nav_msgs/Path -> [[x,y], …]; an empty plan (goal reached/cancelled) clears it.
      plan = (msg.poses || []).map((ps) => [ps.pose.position.x, ps.pose.position.y]);
    });
    const onTf = (msg) => {
      setTfs(msg.transforms);
      const p = poseFromTf();
      if (p) { lastTfPose = performance.now(); setPose(p); }
    };
    tfTopic.subscribe(onTf);
    tfStaticTopic.subscribe((msg) => setTfs(msg.transforms));

    canvas.style.cursor = navModeRef.current ? 'crosshair' : 'grab';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', endPointer);
      canvas.removeEventListener('wheel', onWheel);
      try { mapTopic.unsubscribe(); } catch { /* gone */ }
      try { scanTopic.unsubscribe(); } catch { /* gone */ }
      try { poseTopic.unsubscribe(); } catch { /* gone */ }
      try { planTopic.unsubscribe(); } catch { /* gone */ }
      try { tfTopic.unsubscribe(); } catch { /* gone */ }
      try { tfStaticTopic.unsubscribe(); } catch { /* gone */ }
      try { cmTopics.g?.unsubscribe(); } catch { /* gone */ }
      try { cmTopics.l?.unsubscribe(); } catch { /* gone */ }
    };
  }, [ros, status, onStats, view]);

  return <canvas id="map" ref={canvasRef} />;
}
