// -----------------------------------------------------------------------------
// mapSprites.js - volumetric 2.5D sprites for the semantic map icons (Task 3B, 3D).
//
// Pure canvas drawing (NO three.js, NO 3D scene): each object is a miniature
// replica of the real thing — a chair with four legs and an open-frame backrest,
// a couch with armrests and seat cushions, a table on tapered legs, a bed with
// headboard/duvet/pillows, a TV with a glowing panel, an articulated person and
// a quadruped dog/cat — built from the SAME visual grammar as the map itself:
// rectangular footprints on the floor extruded with the walls' cavalier lean
// (tops shift up-and-right as they rise, LEAN below) and lit by the same
// screen-fixed upper-left light (bright caps, medium west faces, dim fronts),
// grounded by a soft shadow offset down-right like the wall shadows. People and
// pets WALK (two-segment limbs swing, body bobs) when moving; stand otherwise.
// The caller owns opacity (survival), zoom scaling, the 20-object cap, and
// painter ordering (draw far→near).
// -----------------------------------------------------------------------------
import { iconType } from './semantic';

const LEAN = 0.35; // cavalier lean: an h-tall top lands (h*LEAN, -h) from its base

const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const sh = (rgb, f, a = 1) => `rgba(${cl(rgb[0] * f) | 0},${cl(rgb[1] * f) | 0},${cl(rgb[2] * f) | 0},${a})`;

// where the top of an h-tall extrusion lands, given its floor point
const top = (x, y, h) => [x + h * LEAN, y - h];

function poly(ctx, pts, fill) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function rr(ctx, x, y, w, h, rad) {
  const q = Math.min(rad, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

// soft elliptical contact shadow, offset down-right like the wall shadows
function ground(ctx, cx, cy, rx, ry) {
  ctx.save();
  ctx.translate(cx + rx * 0.1, cy + ry * 0.22);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, rx * 0.1, 0, 0, rx);
  g.addColorStop(0, 'rgba(0,0,0,0.33)');
  g.addColorStop(0.65, 'rgba(0,0,0,0.16)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, 7);
  ctx.fill();
  ctx.restore();
}

// A solid drawn exactly like the map walls: w×d footprint on the floor (centre
// x,y — y1 is the front edge), extruded h up with the cavalier lean. Visible
// faces under the screen-fixed upper-left light: bright cap (gradient falling
// off to the lower-right), medium west face (lit at its top), dim front face
// with an ambient-occlusion falloff toward the floor. Cap edges get a two-tone
// bevel: lit back/west edges, dark east/front edges, so every solid reads as a
// crisp machined block instead of flat fills.
function box(ctx, x, y, w, d, h, rgb, o = {}) {
  const x0 = x - w / 2, x1 = x + w / 2;
  const y0 = y - d / 2, y1 = y + d / 2;
  const ox = h * LEAN;
  const s = o.side ?? 0.84;
  const sg = ctx.createLinearGradient(x0 + ox, y0 - h, x0, y1);
  sg.addColorStop(0, sh(rgb, s * 1.14));
  sg.addColorStop(1, sh(rgb, s * 0.68));
  poly(ctx, [[x0, y0], [x0, y1], [x0 + ox, y1 - h], [x0 + ox, y0 - h]], sg);
  const f = o.front ?? 0.6;
  const fg = ctx.createLinearGradient(0, y1 - h, 0, y1);
  fg.addColorStop(0, sh(rgb, f * 1.24));
  fg.addColorStop(0.72, sh(rgb, f * 0.88));
  fg.addColorStop(1, sh(rgb, f * 0.6));
  poly(ctx, [[x0, y1], [x1, y1], [x1 + ox, y1 - h], [x0 + ox, y1 - h]], fg);
  const c = o.cap ?? 1.26;
  const cg = ctx.createLinearGradient(x0 + ox, y0 - h, x1 + ox, y1 - h);
  cg.addColorStop(0, sh(rgb, c * 1.16));
  cg.addColorStop(1, sh(rgb, c * 0.82));
  poly(ctx, [[x0 + ox, y0 - h], [x1 + ox, y0 - h], [x1 + ox, y1 - h], [x0 + ox, y1 - h]], cg);
  if (o.stroke !== false) {
    const lw = Math.max(0.9, h * 0.05);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = sh(rgb, Math.min(1.9, c * 1.3), 0.85); // edges catching the light
    ctx.beginPath();
    ctx.moveTo(x0 + ox, y1 - h);
    ctx.lineTo(x0 + ox, y0 - h);
    ctx.lineTo(x1 + ox, y0 - h);
    ctx.stroke();
    ctx.strokeStyle = sh(rgb, 0.4, 0.6); // edges falling into shade
    ctx.beginPath();
    ctx.moveTo(x1 + ox, y0 - h);
    ctx.lineTo(x1 + ox, y1 - h);
    ctx.lineTo(x0 + ox, y1 - h);
    ctx.stroke();
  }
}

// a slim leg/post from the floor up, same lean; tapered foot so it reads turned
function leg(ctx, x, y, h, w, rgb, f, taper = 0.7) {
  const ox = h * LEAN;
  poly(ctx, [
    [x - (w * taper) / 2, y], [x + (w * taper) / 2, y],
    [x + w / 2 + ox, y - h], [x - w / 2 + ox, y - h],
  ], sh(rgb, f));
}

// a limb drawn as a cylinder: wide dark pass, then a narrower lit core offset
// toward the upper-left light — reads as a rounded 3D member, not a flat stick
function limb(ctx, pts, w, rgb, f) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [lw, ff, off] of [[w, f * 0.72, 0], [w * 0.55, f * 1.2, w * 0.13]]) {
    ctx.strokeStyle = sh(rgb, ff);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] - off, pts[0][1] - off);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] - off, pts[i][1] - off);
    ctx.stroke();
  }
}

// soft specular sheen for cushions/pads: a small radial highlight near the
// upper-left of the surface
function sheen(ctx, x, y, rx, ry, a = 0.5) {
  const g = ctx.createRadialGradient(x - rx * 0.3, y - ry * 0.4, 0, x, y, Math.max(rx, ry));
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(0.55, `rgba(255,255,255,${a * 0.25})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, 7);
  ctx.fill();
}

// point on a box's sheared front face: u across [0..1] west→east, v up [0..1]
const fpt = (x0, x1, yB, h, u, v) => [x0 + u * (x1 - x0) + v * h * LEAN, yB - v * h];

function frontQuad(ctx, x0, x1, yB, h, u0, u1, v0, v1, fill) {
  poly(ctx, [
    fpt(x0, x1, yB, h, u0, v0), fpt(x0, x1, yB, h, u1, v0),
    fpt(x0, x1, yB, h, u1, v1), fpt(x0, x1, yB, h, u0, v1),
  ], fill);
}

// ---- furniture ---------------------------------------------------------------

// an office task chair: 5-star base on casters, a metallic gas lift, a padded
// seat pan and a tall padded backrest with a lumbar seam, plus two armrests
function drawChair(ctx, cx, cy, r, rgb) {
  const DK = [44, 48, 58]; // dark trim: base, casters, lift, arm posts
  const seatH = 0.62 * r, seatT = 0.2 * r, W = 1.0 * r, D = 0.68 * r;
  ground(ctx, cx, cy, r * 0.8, r * 0.38);
  // 5-star base: spokes radiate on the floor ellipse, rear ones first; each
  // ends in a twin-wheel caster with a glint
  const spokes = [];
  for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI) / 5;
    spokes.push([cx + Math.cos(a) * r * 0.58, cy + Math.sin(a) * r * 0.3, Math.sin(a)]);
  }
  spokes.sort((p, q) => p[2] - q[2]);
  for (const [ex, ey, sy2] of spokes) {
    const f = sy2 < 0 ? 0.75 : 1.15;
    limb(ctx, [[cx, cy - 0.06 * r], [ex, ey - 0.07 * r]], Math.max(2.4, r * 0.11), DK, f);
    ctx.fillStyle = sh(DK, f * 0.8);
    ctx.beginPath();
    ctx.ellipse(ex, ey, r * 0.095, r * 0.115, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = sh(DK, f * 2.4);
    ctx.beginPath();
    ctx.arc(ex - r * 0.03, ey - r * 0.05, r * 0.032, 0, 7);
    ctx.fill();
  }
  // gas lift: a short metallic column up to the seat pan
  const lift = seatH - 0.1 * r;
  const lg = ctx.createLinearGradient(cx - 0.09 * r, 0, cx + 0.12 * r, 0);
  lg.addColorStop(0, sh(DK, 2.1));
  lg.addColorStop(0.45, sh(DK, 1.25));
  lg.addColorStop(1, sh(DK, 0.6));
  poly(ctx, [
    [cx - 0.09 * r, cy - 0.04 * r], [cx + 0.09 * r, cy - 0.04 * r],
    [cx + 0.07 * r + lift * LEAN, cy - lift], [cx - 0.07 * r + lift * LEAN, cy - lift],
  ], lg);
  // backrest rises from the rear of the seat pan: padded front + lumbar seam
  const bW = W * 0.88, bH = 1.05 * r;
  const [bx, by] = top(cx, cy - D / 2 + 0.1 * r, seatH + seatT);
  box(ctx, bx, by, bW, 0.14 * r, bH, rgb, { cap: 1.34 });
  frontQuad(ctx, bx - bW / 2, bx + bW / 2, by + 0.07 * r, bH, 0.1, 0.9, 0.1, 0.9, sh(rgb, 0.82));
  frontQuad(ctx, bx - bW / 2, bx + bW / 2, by + 0.07 * r, bH, 0.1, 0.9, 0.42, 0.47, sh(rgb, 0.56));
  const bc = fpt(bx - bW / 2, bx + bW / 2, by + 0.07 * r, bH, 0.42, 0.68);
  sheen(ctx, bc[0], bc[1], bW * 0.3, bH * 0.2, 0.2);
  // padded seat pan with a cushion sheen, sitting on the lift
  const [px, py] = top(cx, cy, seatH);
  box(ctx, px, py, W, D, seatT, rgb, { cap: 1.42, front: 0.72 });
  const [scx, scy] = top(px, py, seatT);
  sheen(ctx, scx - W * 0.08, scy, W * 0.34, D * 0.26, 0.3);
  // armrests: dark T-posts up from the seat sides with small pads
  for (const s2 of [-1, 1]) {
    const ax = px + s2 * (W / 2 - 0.06 * r), ay = py - seatT + 0.02 * r;
    limb(ctx, [[ax, ay], [ax + 0.26 * r * LEAN, ay - 0.26 * r]], Math.max(2, r * 0.08), DK, s2 < 0 ? 0.9 : 1.2);
    box(ctx, ax + 0.26 * r * LEAN, ay - 0.26 * r, 0.3 * r, 0.14 * r, 0.07 * r, DK, { cap: 1.6, front: 0.9, stroke: false });
  }
}

function drawCouch(ctx, cx, cy, r, rgb) {
  const W = 2.3 * r, D = 0.95 * r, armW = 0.34 * r, baseH = 0.52 * r;
  ground(ctx, cx, cy, W * 0.6, D * 0.58);
  // backrest with a centre seam → two back cushions
  const backD = 0.3 * r, backH = 1.18 * r;
  box(ctx, cx, cy - D / 2 + backD / 2, W, backD, backH, rgb, { cap: 1.28, front: 0.62 });
  frontQuad(ctx, cx - W / 2, cx + W / 2, cy - D / 2 + backD, backH, 0.489, 0.511, 0.12, 0.86, sh(rgb, 0.42));
  // seat platform between the arms, two plump cushions sitting proud of it
  const innerW = W - 2 * armW;
  box(ctx, cx, cy + 0.02 * r, innerW, D * 0.92, baseH, rgb, { front: 0.55, cap: 1.08 });
  const [tx, ty] = top(cx, cy + 0.02 * r, baseH);
  const cw = innerW / 2 - 0.06 * r;
  for (const s of [-1, 1]) {
    const ccx = tx + s * (cw / 2 + 0.05 * r), ccy = ty + 0.03 * r;
    box(ctx, ccx, ccy, cw, D * 0.84, 0.2 * r, rgb, { cap: 1.42, front: 0.78 });
    const [ux, uy] = top(ccx, ccy, 0.2 * r);
    sheen(ctx, ux - cw * 0.08, uy, cw * 0.32, D * 0.2, 0.25);
  }
  // armrests, each capped with a soft rounded highlight
  for (const s of [-1, 1]) {
    const ax = cx + (s * (W - armW)) / 2;
    box(ctx, ax, cy, armW, D, 0.9 * r, rgb, { cap: 1.3, front: 0.64 });
    const [hx, hy] = top(ax, cy, 0.9 * r);
    ctx.fillStyle = sh(rgb, 1.55, 0.45);
    ctx.beginPath();
    ctx.ellipse(hx, hy, armW * 0.3, D * 0.3, 0, 0, 7);
    ctx.fill();
  }
}

function drawTable(ctx, cx, cy, r, rgb) {
  const W = 2.05 * r, D = 1.05 * r, H = 0.78 * r, T = 0.15 * r;
  const ix = W / 2 - 0.14 * r, iy = D / 2 - 0.1 * r, lw = 0.13 * r;
  ground(ctx, cx, cy, W * 0.56, D * 0.52);
  leg(ctx, cx - ix, cy - iy, H, lw, rgb, 0.42);
  leg(ctx, cx + ix, cy - iy, H, lw, rgb, 0.5);
  leg(ctx, cx - ix, cy + iy, H, lw, rgb, 0.66);
  leg(ctx, cx + ix, cy + iy, H, lw, rgb, 0.8);
  // apron beam shadowing the underside, then the raised top
  const [ax, ay] = top(cx, cy, H - 0.14 * r);
  box(ctx, ax, ay, W * 0.82, D * 0.74, 0.14 * r, rgb, { front: 0.38, side: 0.42, cap: 0.5, stroke: false });
  const [px, py] = top(cx, cy, H);
  box(ctx, px, py, W, D, T, rgb, { cap: 1.3, front: 0.62 });
  // faint grain streaks running along the top
  const [gx, gy] = top(px, py, T);
  ctx.strokeStyle = sh(rgb, 1.08, 0.55);
  ctx.lineWidth = Math.max(0.8, r * 0.04);
  for (const t of [-0.28, 0.05, 0.34]) {
    ctx.beginPath();
    ctx.moveTo(gx - W * 0.44, gy + D * t * 0.9);
    ctx.lineTo(gx + W * 0.44, gy + D * t * 0.9 - r * 0.03);
    ctx.stroke();
  }
}

function drawBed(ctx, cx, cy, r, rgb) {
  const W = 2.25 * r, D = 1.45 * r;
  ground(ctx, cx, cy, W * 0.58, D * 0.5);
  box(ctx, cx, cy - D / 2 + 0.08 * r, W, 0.14 * r, 0.85 * r, rgb, { cap: 1.22, front: 0.52 }); // headboard
  box(ctx, cx, cy, W, D, 0.3 * r, rgb, { front: 0.48, side: 0.6, cap: 0.9 });                  // frame
  const [mx, my] = top(cx, cy, 0.3 * r);
  const mw = W * 0.97, md = D * 0.95, mh = 0.26 * r;
  box(ctx, mx, my, mw, md, mh, rgb, { cap: 1.46, front: 0.85 });                               // mattress
  // duvet over the foot two-thirds: covers the mattress front and the cap up to
  // a softly lit fold edge
  const [ux, uy] = top(mx, my, mh);
  frontQuad(ctx, mx - mw / 2, mx + mw / 2, my + md / 2, mh, 0, 1, 0, 1, sh(rgb, 0.62));
  const bTop = uy - md / 2 + md * 0.36;
  ctx.fillStyle = sh(rgb, 1.0);
  ctx.fillRect(ux - mw / 2, bTop, mw, md / 2 + (uy - bTop));
  ctx.fillStyle = sh(rgb, 1.2);
  ctx.fillRect(ux - mw / 2, bTop, mw, 0.05 * r);
  // two plump pillows against the headboard, each grounded by a soft shadow
  for (const s of [-1, 1]) {
    const px = ux + s * mw * 0.24, py = uy - md / 2 + 0.16 * r;
    ctx.fillStyle = sh(rgb, 0.7, 0.6);
    ctx.beginPath();
    ctx.ellipse(px + 0.03 * r, py + 0.05 * r, mw * 0.15, 0.13 * r, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = sh(rgb, 1.72);
    rr(ctx, px - mw * 0.15, py - 0.11 * r, mw * 0.3, 0.22 * r, 0.11 * r);
    ctx.fill();
  }
}

function drawTV(ctx, cx, cy, r, rgb) {
  const DK = [30, 33, 41]; // near-black chassis, matching the rover's tires/LiDAR
  ground(ctx, cx, cy, r * 0.85, r * 0.32);
  box(ctx, cx, cy, 0.95 * r, 0.3 * r, 0.08 * r, DK, { cap: 1.5, front: 0.9, side: 1.1, stroke: false });
  leg(ctx, cx, cy - 0.02 * r, 0.28 * r, 0.16 * r, DK, 1.2, 1);
  const [nx, ny] = top(cx, cy, 0.3 * r);
  const W = 1.9 * r, H = 1.12 * r;
  box(ctx, nx, ny, W, 0.1 * r, H, DK, { cap: 2.0, side: 1.5, front: 1.05, stroke: false });
  // glass: near-black with the picture's glow rising from the bottom, a diagonal
  // sheen, and a standby LED on the bezel
  const x0 = nx - W / 2, x1 = nx + W / 2, yB = ny + 0.05 * r;
  const gb = fpt(x0, x1, yB, H, 0.5, 0.05), gt = fpt(x0, x1, yB, H, 0.5, 0.93);
  const gg = ctx.createLinearGradient(gb[0], gb[1], gt[0], gt[1]);
  gg.addColorStop(0, sh(rgb, 0.55, 0.8));
  gg.addColorStop(0.5, 'rgba(8,10,16,0.97)');
  gg.addColorStop(1, 'rgba(18,22,32,0.97)');
  frontQuad(ctx, x0, x1, yB, H, 0.03, 0.97, 0.05, 0.93, gg);
  frontQuad(ctx, x0, x1, yB, H, 0.06, 0.3, 0.05, 0.93, 'rgba(255,255,255,0.06)');
  const led = fpt(x0, x1, yB, H, 0.5, 0.02);
  ctx.fillStyle = sh(rgb, 1.8);
  ctx.beginPath();
  ctx.arc(led[0], led[1], Math.max(1, r * 0.035), 0, 7);
  ctx.fill();
}

// generic/unknown classes: a slatted wooden crate with a lit top-left edge
function drawCrate(ctx, cx, cy, r, rgb) {
  const W = 1.1 * r, D = 0.8 * r, H = 0.95 * r;
  ground(ctx, cx, cy, W * 0.7, D * 0.56);
  box(ctx, cx, cy, W, D, H, rgb, { cap: 1.28 });
  const x0 = cx - W / 2, x1 = cx + W / 2, yB = cy + D / 2;
  frontQuad(ctx, x0, x1, yB, H, 0.03, 0.97, 0.3, 0.35, sh(rgb, 0.38));
  frontQuad(ctx, x0, x1, yB, H, 0.03, 0.97, 0.63, 0.68, sh(rgb, 0.38));
  frontQuad(ctx, x0, x1, yB, H, 0.44, 0.56, 0.02, 0.98, sh(rgb, 0.52, 0.55)); // strap band
  const [kx, ky] = top(cx, cy, H);
  ctx.lineWidth = Math.max(0.8, r * 0.045);
  ctx.strokeStyle = sh(rgb, 0.55, 0.8);
  ctx.beginPath();
  ctx.moveTo(kx - W * 0.44, ky);
  ctx.lineTo(kx + W * 0.44, ky);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.strokeStyle = sh(rgb, 1.7, 0.8);
  ctx.beginPath();
  ctx.moveTo(kx - W / 2, ky + D / 2);
  ctx.lineTo(kx - W / 2, ky - D / 2);
  ctx.lineTo(kx + W / 2, ky - D / 2);
  ctx.stroke();
}

// ---- living things -----------------------------------------------------------

function drawPerson(ctx, cx, cy, r, rgb, walking, phase) {
  const bob = walking ? Math.abs(Math.sin(phase)) * r * 0.09 : 0;
  const hipY = cy - r * 1.25 - bob;
  const shoY = hipY - r * 0.9;
  const headR = r * 0.42;
  const headY = shoY - r * 0.18 - headR;
  const s = walking ? Math.sin(phase) : 0;
  ground(ctx, cx, cy, r * 0.6, r * 0.25);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // two-segment legs (hip→knee→heel): the knee leads whichever leg is swinging
  // forward, and a small foot grounds each stride
  const drawLeg = (dir, f) => {
    const footX = cx + dir * (walking ? s * r * 0.5 : r * 0.16);
    const bias = walking ? Math.max(0, dir * Math.cos(phase)) * r * 0.2 + r * 0.02 : r * 0.03;
    const kx = (cx + footX) / 2 + bias;
    const ky = hipY + (cy - hipY) * 0.52;
    limb(ctx, [[cx, hipY], [kx, ky], [footX, cy - r * 0.06]], Math.max(2.6, r * 0.3), rgb, f);
    ctx.fillStyle = sh(rgb, f * 0.8);
    ctx.beginPath();
    ctx.ellipse(footX + r * 0.1, cy - r * 0.045, r * 0.18, r * 0.085, 0, 0, 7);
    ctx.fill();
  };
  // two-segment arms swinging opposite the legs, ending in a hand
  const drawArm = (dir, f) => {
    const sw = walking ? -s * dir * r * 0.45 : dir * r * 0.06;
    limb(ctx, [
      [cx + dir * r * 0.3, shoY + r * 0.06],
      [cx + dir * r * 0.32 + sw * 0.5, shoY + r * 0.5],
      [cx + dir * r * 0.18 + sw, shoY + r * 0.92],
    ], Math.max(2.2, r * 0.22), rgb, f);
    ctx.fillStyle = sh(rgb, f * 1.12);
    ctx.beginPath();
    ctx.arc(cx + dir * r * 0.18 + sw, shoY + r * 0.92, r * 0.105, 0, 7);
    ctx.fill();
  };

  drawArm(-1, 0.52);
  drawLeg(-1, 0.55);
  drawLeg(1, 0.95);
  // torso: shoulders wider than the hips, rounded, side-lit from the left
  const tg = ctx.createLinearGradient(cx - r * 0.46, 0, cx + r * 0.46, 0);
  tg.addColorStop(0, sh(rgb, 1.3));
  tg.addColorStop(0.55, sh(rgb, 1.02));
  tg.addColorStop(1, sh(rgb, 0.66));
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.34, hipY + r * 0.1);
  ctx.lineTo(cx - r * 0.44, shoY + r * 0.16);
  ctx.quadraticCurveTo(cx - r * 0.46, shoY - r * 0.08, cx - r * 0.24, shoY - r * 0.12);
  ctx.lineTo(cx + r * 0.24, shoY - r * 0.12);
  ctx.quadraticCurveTo(cx + r * 0.46, shoY - r * 0.08, cx + r * 0.44, shoY + r * 0.16);
  ctx.lineTo(cx + r * 0.34, hipY + r * 0.1);
  ctx.quadraticCurveTo(cx, hipY + r * 0.22, cx - r * 0.34, hipY + r * 0.1);
  ctx.closePath();
  ctx.fill();
  // neck, then a sphere-shaded head with a specular glint
  ctx.fillStyle = sh(rgb, 0.85);
  ctx.fillRect(cx - r * 0.09, shoY - r * 0.24, r * 0.18, r * 0.18);
  const hg = ctx.createRadialGradient(cx - headR * 0.35, headY - headR * 0.38, headR * 0.1, cx, headY, headR);
  hg.addColorStop(0, sh(rgb, 1.45));
  hg.addColorStop(0.7, sh(rgb, 1.05));
  hg.addColorStop(1, sh(rgb, 0.7));
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, 7);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx - headR * 0.32, headY - headR * 0.42, headR * 0.22, headR * 0.13, -0.6, 0, 7);
  ctx.fill();
  drawArm(1, 1.08);
}

// dog/cat: side-profile quadruped — capsule body, four legs in a diagonal gait,
// sphere head with snout/nose/eye, breed ears (pricked for cat, floppy for dog)
// and a tail that wags while walking
function drawPet(ctx, cls, cx, cy, r, rgb, walking, phase) {
  const cat = cls === 'cat';
  const L = (cat ? 1.15 : 1.4) * r, BH = (cat ? 0.42 : 0.5) * r, legH = (cat ? 0.5 : 0.6) * r;
  const bob = walking ? Math.abs(Math.sin(phase * 1.3)) * r * 0.04 : 0;
  const byC = cy - legH - BH / 2 - bob;
  ground(ctx, cx, cy, L * 0.6, r * 0.22);
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2.2, r * 0.16);
  const fx = cx + L * 0.33, rx = cx - L * 0.33;
  for (const [x, off, f] of [[fx, Math.PI, 0.5], [rx, 0, 0.5], [fx, 0, 0.95], [rx, Math.PI, 0.95]]) {
    const sw = walking ? Math.sin(phase + off) * r * 0.26 : 0;
    const lift = walking ? Math.max(0, Math.sin(phase + off)) * r * 0.06 : 0;
    limb(ctx, [[x, byC + BH * 0.2], [x + sw, cy - r * 0.02 - lift]], Math.max(2.2, r * 0.16), rgb, f);
  }
  const bg = ctx.createLinearGradient(0, byC - BH, 0, byC + BH);
  bg.addColorStop(0, sh(rgb, 1.28));
  bg.addColorStop(1, sh(rgb, 0.64));
  ctx.fillStyle = bg;
  rr(ctx, cx - L / 2, byC - BH / 2, L, BH, BH / 2);
  ctx.fill();
  sheen(ctx, cx - L * 0.1, byC - BH * 0.22, L * 0.32, BH * 0.24, 0.22);
  const wag = walking ? Math.sin(phase * 2) * r * 0.16 : 0;
  ctx.strokeStyle = sh(rgb, 0.9);
  ctx.lineWidth = Math.max(2, r * (cat ? 0.1 : 0.13));
  ctx.beginPath();
  ctx.moveTo(cx - L / 2 + r * 0.05, byC - BH * 0.15);
  if (cat) ctx.quadraticCurveTo(cx - L / 2 - r * 0.3, byC - BH * 0.9, cx - L / 2 - r * 0.18 + wag, byC - BH * 1.7);
  else ctx.quadraticCurveTo(cx - L / 2 - r * 0.32, byC - BH * 0.5, cx - L / 2 - r * 0.42 + wag, byC - BH * 1.1);
  ctx.stroke();
  const hr = (cat ? 0.3 : 0.34) * r;
  const hx = cx + L / 2 + hr * 0.3, hy = byC - BH / 2 - hr * 0.3;
  if (cat) {
    poly(ctx, [[hx - hr * 0.75, hy - hr * 0.5], [hx - hr * 0.4, hy - hr * 1.5], [hx - hr * 0.05, hy - hr * 0.75]], sh(rgb, 0.8));
    poly(ctx, [[hx + hr * 0.05, hy - hr * 0.75], [hx + hr * 0.45, hy - hr * 1.45], [hx + hr * 0.75, hy - hr * 0.45]], sh(rgb, 1.1));
  }
  const hg = ctx.createRadialGradient(hx - hr * 0.35, hy - hr * 0.38, hr * 0.1, hx, hy, hr);
  hg.addColorStop(0, sh(rgb, 1.42));
  hg.addColorStop(0.7, sh(rgb, 1.02));
  hg.addColorStop(1, sh(rgb, 0.68));
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(hx, hy, hr, 0, 7);
  ctx.fill();
  const snw = hr * (cat ? 0.7 : 1.0), snh = hr * 0.55;
  ctx.fillStyle = sh(rgb, 1.15);
  rr(ctx, hx + hr * 0.45, hy - snh * 0.3, snw, snh, snh * 0.45);
  ctx.fill();
  ctx.fillStyle = 'rgba(10,10,14,0.85)';
  ctx.beginPath();
  ctx.arc(hx + hr * 0.45 + snw * 0.95, hy - snh * 0.3 + snh * 0.35, Math.max(1, r * 0.05), 0, 7);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(hx + hr * 0.3, hy - hr * 0.2, Math.max(1, r * 0.055), 0, 7);
  ctx.fill();
  if (!cat) { // floppy ear draped from the top-rear of the head
    ctx.fillStyle = sh(rgb, 0.62);
    ctx.beginPath();
    ctx.ellipse(hx - hr * 0.45, hy - hr * 0.42, hr * 0.28, hr * 0.52, 0.5, 0, 7);
    ctx.fill();
  }
}

// Draw one object sprite. cx,cy is the FLOOR point (projected map xy). r is the
// base screen size; alpha is survival opacity. walking/phase animate people/pets.
export function drawObjectSprite(ctx, cls, cx, cy, r, rgb, alpha, walking, phase) {
  const type = iconType(cls);
  ctx.save();
  ctx.globalAlpha = Math.max(0.1, Math.min(1, alpha));
  let ly = 0.55; // label offset (× r) below the floor point, clears the footprint
  if (type === 'person') {
    drawPerson(ctx, cx, cy, r, rgb, walking, phase);
    ly = 0.42;
  } else if (type === 'pet') {
    drawPet(ctx, cls, cx, cy, r, rgb, walking, phase);
    ly = 0.42;
  } else if (type === 'chair') {
    drawChair(ctx, cx, cy, r, rgb);
  } else if (type === 'couch') {
    if (cls === 'bed') { drawBed(ctx, cx, cy, r, rgb); ly = 0.92; }
    else { drawCouch(ctx, cx, cy, r, rgb); ly = 0.62; }
  } else if (type === 'table') {
    drawTable(ctx, cx, cy, r, rgb);
    ly = 0.66;
  } else if (cls === 'tv') {
    drawTV(ctx, cx, cy, r, rgb);
  } else {
    drawCrate(ctx, cx, cy, r, rgb);
  }

  // label, white with a dark halo so it reads on any map colour
  ctx.font = `600 ${Math.round(r * 0.62)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(cls, cx, cy + r * ly);
  ctx.fillStyle = '#fff';
  ctx.fillText(cls, cx, cy + r * ly);
  ctx.restore();
}
