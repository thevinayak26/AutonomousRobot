// Browser verification for the navigable map (camera controls + fullscreen morph).
// Drives the real dashboard against fake_publisher --full + rosbridge and asserts
// canvas pixels / geometry, not just DOM presence. Run: node tools/verify_map_controls.mjs
//
// Metric notes: --map-free is intentionally near --inset (the map floats on a
// same-tone inset), so "gutter" can't be colour-classified. Walls and the
// unknown pocket ARE distinct, so geometry uses wall pixels (centroid, top-edge
// tilt) and zoom uses the unknown pocket's apparent area (grows ~k²).
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const fail = (msg) => { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1380, height: 820, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });

// Classify backing-store pixels by the live theme palette (tolerance match).
const stats = () => page.evaluate(() => {
  const cv = document.querySelector('#map');
  if (!cv) return null;
  const W = cv.width, H = cv.height;
  if (!W || !H) return null;
  const img = cv.getContext('2d').getImageData(0, 0, W, H).data;
  const gv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const hex = (h) => {
    h = h.replace('#', '');
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const C = {
    free: hex(gv('--map-free')), wall: hex(gv('--map-wall')),
    unk: hex(gv('--map-unknown')), accent: hex(gv('--accent')),
  };
  const near = (i, c, tol) =>
    Math.abs(img[i] - c[0]) <= tol && Math.abs(img[i + 1] - c[1]) <= tol && Math.abs(img[i + 2] - c[2]) <= tol;
  let free = 0, unk = 0;
  let wx = 0, wy = 0, wn = 0;          // wall centroid
  let ax = 0, ay = 0, an = 0;          // solid-accent centroid (robot marker)
  let wallMinYL = H, wallMinYR = H;    // top of wall pixels, left/right thirds
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      if (near(i, C.wall, 12)) {
        wx += x; wy += y; wn++;
        if (x < W / 3 && y < wallMinYL) wallMinYL = y;
        if (x > (2 * W) / 3 && y < wallMinYR) wallMinYR = y;
      } else if (near(i, C.unk, 12)) unk++;
      else if (near(i, C.free, 12)) free++;
      if (near(i, C.accent, 16)) { ax += x; ay += y; an++; }
    }
  }
  return {
    W, H, free, unk, wall: wn,
    wallC: wn ? [wx / wn, wy / wn] : null,
    robot: an > 5 ? [ax / an, ay / an] : null,
    wallMinYL, wallMinYR, palette: C,
  };
});

const rect = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}, sel);
const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const expandedAttr = () => page.evaluate(
  () => document.querySelector('.map-stage')?.dataset.expanded,
);
const glued = (a, b) =>
  Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) < 2 &&
  Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;

// -- 1. settle: intro gone, entrance rise finished, /map rendered ------------
let s0 = null;
let settled = false;
for (let i = 0; i < 60 && !settled; i++) {
  await sleep(500);
  if (await exists('.intro')) continue;
  const r1 = await rect('#mapBox');
  await sleep(300);
  const r2 = await rect('#mapBox');
  s0 = await stats();
  settled = r1 && r2 && glued(r1, r2) && s0 && s0.wall > 50;
}
assert(settled, 'page settled: intro gone, layout stable, /map rendered');
assert(s0.wall > 50, `wall cells visible (${s0.wall})`);
assert(s0.free > 1000, `free cells visible (${s0.free})`);
assert(s0.unk > 50, `unknown pocket visible (${s0.unk})`);
const poseText = await page.evaluate(() => document.querySelector('.pose-readout')?.textContent || '');
assert(/X\s[+-].*Y\s[+-].*θ\s[+-]/.test(poseText), `pose HUD live ("${poseText}")`);

// -- 2. docked chrome + glue (regression: entrance-rise misglue) -------------
assert(await exists('.map-btn.map-expand'), 'docked: expand button present');
assert(!(await exists('.map-controls')), 'docked: toolbar hidden');
assert((await expandedAttr()) === 'false', 'docked: stage data-expanded=false');
const slotR = await rect('#mapBox');
const stageR0 = await rect('.map-stage');
assert(glued(stageR0, slotR),
  `docked: stage glued to card slot (stage ${stageR0.top.toFixed(1)},${stageR0.left.toFixed(1)} vs slot ${slotR.top.toFixed(1)},${slotR.left.toFixed(1)})`);
await page.screenshot({ path: '/tmp/atlas_1_docked.png' });

// -- 3. wheel zoom (docked) - unknown pocket area grows ~k² ------------------
const cx = stageR0.left + stageR0.width / 2;
const cy = stageR0.top + stageR0.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.wheel({ deltaY: -120 });
await page.mouse.wheel({ deltaY: -120 }); // k ≈ 1.43 total
await sleep(250);
const s1 = await stats();
assert(s1.unk > s0.unk * 1.6, `wheel zoom-in magnifies (pocket ${s0.unk} → ${s1.unk} px)`);

// -- 4. tap docked map → expands to fullscreen -------------------------------
await page.mouse.click(cx, cy, { delay: 40 });
await sleep(550); // morph is ~340ms
assert((await expandedAttr()) === 'true', 'tap on docked map expands');
const stageR1 = await rect('.map-stage');
assert(
  stageR1.left === 0 && stageR1.top === 0 && stageR1.width === 1380 && stageR1.height === 820,
  `expanded: stage fills viewport (${stageR1.width}x${stageR1.height}@${stageR1.left},${stageR1.top})`,
);
assert(await exists('.map-btn.map-close'), 'expanded: close button present');
assert(!(await exists('.map-btn.map-expand')), 'expanded: expand button gone');
const nBtns = await page.evaluate(() => document.querySelectorAll('.map-controls .map-btn').length);
assert(nBtns === 6, `expanded: toolbar has 6 buttons (${nBtns})`);
assert(await exists('.map-legend.in-stage'), 'expanded: legend overlays stage');
await page.screenshot({ path: '/tmp/atlas_2_expanded.png' });

// -- 5. camera persisted through expand; reset; zoom buttons -----------------
const sArrive = await stats();
await page.click('.map-controls .map-btn[aria-label="Reset view"]');
await sleep(250);
const sFitE = await stats();
assert(sArrive.unk > sFitE.unk * 1.5,
  `wheel zoom persisted through expand (pocket ${sArrive.unk} vs fit ${sFitE.unk})`);
assert(sFitE.wallMinYL > 4 && Math.abs(sFitE.wallMinYL - sFitE.wallMinYR) < 12,
  `reset: level fit (top wall L${sFitE.wallMinYL} vs R${sFitE.wallMinYR})`);
await page.click('.map-controls .map-btn[aria-label="Zoom in"]');
await page.click('.map-controls .map-btn[aria-label="Zoom in"]'); // k ≈ 1.82
await sleep(250);
const sZoom = await stats();
assert(sZoom.unk > sFitE.unk * 2, `zoom-in buttons magnify (pocket ${sFitE.unk} → ${sZoom.unk})`);
await page.click('.map-controls .map-btn[aria-label="Zoom out"]');
await page.click('.map-controls .map-btn[aria-label="Zoom out"]');
await sleep(250);
const sOut = await stats();
assert(Math.abs(sOut.unk - sFitE.unk) < sFitE.unk * 0.25,
  `zoom-out returns to fit (pocket ${sZoom.unk} → ${sOut.unk} ≈ ${sFitE.unk})`);

// -- 6. rotate buttons tilt the map ------------------------------------------
await page.click('.map-controls .map-btn[aria-label="Rotate right"]');
await page.click('.map-controls .map-btn[aria-label="Rotate right"]'); // 30°
await sleep(250);
const sRot = await stats();
assert(Math.abs(sRot.wallMinYL - sRot.wallMinYR) > 60,
  `rotate: top wall tilted (L${sRot.wallMinYL} vs R${sRot.wallMinYR})`);
await page.screenshot({ path: '/tmp/atlas_3_rotated.png' });
await page.click('.map-controls .map-btn[aria-label="Rotate left"]');
await page.click('.map-controls .map-btn[aria-label="Rotate left"]');
await sleep(250);
const sUnrot = await stats();
assert(Math.abs(sUnrot.wallMinYL - sUnrot.wallMinYR) < 12,
  `rotate left restores level view (L${sUnrot.wallMinYL} vs R${sUnrot.wallMinYR})`);

// -- 7. center-on-robot ------------------------------------------------------
await page.click('.map-controls .map-btn[aria-label="Center on robot"]');
await sleep(250);
const sCtr = await stats();
assert(sCtr.robot, 'robot marker visible after centering');
if (sCtr.robot) {
  const d = Math.hypot(sCtr.robot[0] - sCtr.W / 2, sCtr.robot[1] - sCtr.H / 2);
  assert(d < 180, `robot near viewport centre (off by ${Math.round(d)}px)`);
}

// -- 8. drag pan (expanded, from fit, horizontal so no wall clips) -----------
await page.click('.map-controls .map-btn[aria-label="Reset view"]');
await sleep(250);
const sPre = await stats();
await page.mouse.move(690, 410);
await page.mouse.down();
await page.mouse.move(830, 410, { steps: 6 });
await page.mouse.up();
await sleep(250);
const sPan = await stats();
const dx = sPan.wallC[0] - sPre.wallC[0];
const dy = sPan.wallC[1] - sPre.wallC[1];
assert(Math.abs(dx - 140) < 25 && Math.abs(dy) < 25,
  `drag pans map with cursor (walls moved ${Math.round(dx)},${Math.round(dy)} ≈ 140,0)`);

// -- 9. Esc collapses; camera (pan) persists docked --------------------------
await page.keyboard.press('Escape');
await sleep(550);
assert((await expandedAttr()) === 'false', 'Esc collapses fullscreen');
const stageR2 = await rect('.map-stage');
const slotR2 = await rect('#mapBox');
assert(glued(stageR2, slotR2), 'collapsed: stage re-glued to card slot');
const sDock = await stats();
assert(sDock.wallC[0] - s0.wallC[0] > 35,
  `pan persisted across collapse (walls +${Math.round(sDock.wallC[0] - s0.wallC[0])}px right of baseline)`);

// -- 10. expand button path + reset for a clean state -----------------------
await page.click('.map-btn.map-expand');
await sleep(550);
assert((await expandedAttr()) === 'true', 'expand button expands');
await page.click('.map-controls .map-btn[aria-label="Reset view"]');
await page.keyboard.press('Escape');
await sleep(550);

// -- 11. theme flip re-rasterises the bitmap with the new palette -----------
const paletteBefore = (await stats()).palette;
await page.click('header button.toggle');
await sleep(400);
const sTheme = await stats();
const changed = JSON.stringify(sTheme.palette.wall) !== JSON.stringify(paletteBefore.wall);
assert(changed, 'theme flip changes map palette vars');
assert(sTheme.free > 1000 && sTheme.wall > 50,
  `bitmap re-rasterised to new theme (free ${sTheme.free}, wall ${sTheme.wall})`);
await page.screenshot({ path: '/tmp/atlas_4_light_docked.png' });
await page.click('header button.toggle'); // restore

// -- console hygiene ---------------------------------------------------------
const realErrors = consoleErrors.filter((e) => !/WebSocket|ros.*closed|favicon/i.test(e));
assert(realErrors.length === 0,
  realErrors.length ? `no console errors - got: ${realErrors.join(' | ')}` : 'no console errors');

await browser.close();
console.log(`\n${process.exitCode ? 'FAILED' : 'ALL PASSED'} - ${passed} assertions passed`);
