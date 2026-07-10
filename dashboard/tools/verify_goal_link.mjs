// Browser verification for click-to-goal (confirm chip + /goal_pose) and the
// Semantic Link freshness tile. Drives the real dashboard against rosbridge +
// fake_publisher --full; spawns/kills fake_detections itself to exercise the
// green→amber→red decay, and kills/restarts rosbridge to prove the tiles go
// stale (not crash) across a websocket drop. Pair with tools/goal_probe.py
// (writes /tmp/goal_probe.jsonl) for the wire-side assertions.
//
// Run (ROS sourced, rosbridge + fake_publisher --full + goal_probe + vite up):
//   node tools/verify_goal_link.mjs
import puppeteer from 'puppeteer';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const fail = (msg) => { console.error(`✗ FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : fail(msg));

const probeLines = () => {
  if (!existsSync('/tmp/goal_probe.jsonl')) return [];
  return readFileSync('/tmp/goal_probe.jsonl', 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
};
const allGoals = () => probeLines().filter((m) => m.topic === 'goal_pose');
const allTwists = () => probeLines().filter((m) => m.topic === 'cmd_vel');
// baseline at script start, so re-runs against an appending probe log stay valid
const goalsBase = allGoals().length;
const twistsBase = allTwists().length;
const goals = () => allGoals().slice(goalsBase);
const twists = () => allTwists().slice(twistsBase);

let fakeDet = null;
const startDetections = () => {
  fakeDet = spawn('python3', ['tools/fake_detections.py'], { stdio: 'ignore' });
};
const stopDetections = () => {
  if (fakeDet) { try { fakeDet.kill('SIGKILL'); } catch { /* gone */ } fakeDet = null; }
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1380, height: 820, deviceScaleFactor: 1 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });

const exists = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
const expandedAttr = () => page.evaluate(() => document.querySelector('.map-stage')?.dataset.expanded);
const linkState = () => page.evaluate(() => ({
  label: document.querySelector('.semlink-state')?.textContent ?? null,
  age: [...document.querySelectorAll('#c-strip .seg')].map((s) => s.textContent)
    .find((t) => t.includes('Semantic Link')) ?? null,
}));
// Count pixels near a colour (CSS var) within `rad` px of canvas point (cx, cy).
const colorNear = (cx, cy, varName, rad) => page.evaluate(({ cx, cy, varName, rad }) => {
  const cv = document.querySelector('#map');
  if (!cv || !cv.width) return -1;
  const gv = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  let h = gv.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const C = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const r = cv.getBoundingClientRect();
  const px = Math.round(cx - r.left);
  const py = Math.round(cy - r.top);
  const x0 = Math.max(0, px - rad), x1 = Math.min(cv.width, px + rad);
  const y0 = Math.max(0, py - rad), y1 = Math.min(cv.height, py + rad);
  const img = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let n = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (Math.abs(img[i] - C[0]) <= 22 && Math.abs(img[i + 1] - C[1]) <= 22
      && Math.abs(img[i + 2] - C[2]) <= 22) n++;
  }
  return n;
}, { cx, cy, varName, rad });

// -- 0. settle: intro gone, /map rendered ------------------------------------
let settled = false;
for (let i = 0; i < 60 && !settled; i++) {
  await sleep(500);
  if (await exists('.intro')) continue;
  settled = await page.evaluate(() => {
    const cv = document.querySelector('#map');
    return !!cv && cv.width > 100 && !document.querySelector('.map-skel');
  });
}
assert(settled, 'page settled: intro gone, /map rendered');

// -- 1. Semantic Link: no publisher yet → red LINK LOST after 3 s ------------
assert(await exists('.semlink-state'), 'Semantic Link tile mounted');
let lostSeen = false;
for (let i = 0; i < 25 && !lostSeen; i++) {
  await sleep(300);
  lostSeen = ((await linkState()).label || '').includes('LINK LOST');
}
assert(lostSeen, 'no publisher → tile shows "LINK LOST / semantic memory decaying"');

// -- 2. start fake_detections → LIVE, age green, count ≥ 4 -------------------
startDetections();
let live = null;
for (let i = 0; i < 40 && !(live && live.label === 'LIVE'); i++) {
  await sleep(300);
  live = await linkState();
}
assert(live && live.label === 'LIVE', `detections up → tile LIVE (label "${live?.label}")`);
const ageTxt = await page.evaluate(() => {
  const seg = [...document.querySelectorAll('#c-strip .seg')]
    .find((s) => s.querySelector('h3')?.textContent === 'Semantic Link');
  const rows = seg ? [...seg.querySelectorAll('.hrow')] : [];
  return rows.map((r) => r.textContent);
});
const ageMs = parseFloat((ageTxt[0] || '').replace(/[^0-9.]/g, ''));
assert(ageMs > 0 && ageMs < 500, `age readout green-range (${ageMs} ms, rows: ${JSON.stringify(ageTxt)})`);
assert(/([4-9]|\d\d) det/.test(ageTxt[1] || ''), `detection count ≥ 4 ("${ageTxt[1]}")`);
await sleep(3200); // history samples at 1 Hz; the polyline needs ≥2 non-null points
const sparkPts = await page.evaluate(() => {
  const seg = [...document.querySelectorAll('#c-strip .seg')]
    .find((s) => s.querySelector('h3')?.textContent === 'Semantic Link');
  return seg?.querySelector('svg.spark polyline')?.getAttribute('points')?.split(' ').length ?? 0;
});
assert(sparkPts >= 2, `age sparkline drawing (${sparkPts} points)`);
await page.screenshot({ path: '/tmp/goal_link_1_live.png' });

const stageCenter = () => page.evaluate(() => {
  const r = document.querySelector('.map-stage')?.getBoundingClientRect();
  return r ? [r.left + r.width / 2, r.top + r.height / 2] : null;
});

// -- 3. expand map; disarmed tap must NOT open the chip ----------------------
const [dcx, dcy] = await stageCenter();
await page.mouse.click(dcx, dcy, { delay: 40 }); // tap docked map → expand
await sleep(600);
assert((await expandedAttr()) === 'true', 'map expanded');
assert(await exists('.map-btn.map-nav-toggle'), 'nav-goal toggle present (expanded)');
const armed0 = await page.evaluate(() => document.querySelector('.map-nav-toggle')?.getAttribute('aria-pressed'));
assert(armed0 === 'false', 'nav-goal toggle defaults DISARMED');
await page.mouse.click(690, 410, { delay: 40 });
await sleep(300);
assert(!(await exists('.map-goalchip')), 'disarmed tap: no confirm chip');
assert(goals().length === 0, 'disarmed tap: nothing published on /goal_pose');

// -- 4. center on robot, arm, tap centre → chip coords ≈ robot pose ----------
await page.click('.map-controls .map-btn[aria-label="Center on robot"]');
await sleep(800); // easing settles
await page.click('.map-btn.map-nav-toggle');
await sleep(150);
assert(await exists('.map-navhint'), 'armed: hint visible');
const hud = await text('.pose-readout');
const hm = /X\s([+-][\d.]+)\s·\sY\s([+-][\d.]+)/.exec(hud || '');
assert(hm, `pose HUD parsable ("${hud}")`);
const goldBase = await colorNear(690, 410, '--gold', 30);
await page.mouse.click(690, 410, { delay: 40 }); // tap the centred robot
await sleep(300);
assert(await exists('.map-goalchip'), 'armed tap: confirm chip appears');
const chipTxt = await text('.map-goalchip .gc-xy');
const cm = /X\s([+-]?[\d.]+)\s·\sY\s([+-]?[\d.]+)/.exec(chipTxt || '');
assert(cm, `chip shows computed coords ("${chipTxt}")`);
if (cm && hm) {
  const dx = Math.abs(parseFloat(cm[1]) - parseFloat(hm[1]));
  const dy = Math.abs(parseFloat(cm[2]) - parseFloat(hm[2]));
  assert(dx < 0.3 && dy < 0.3,
    `pixel→map conversion matches robot pose (Δ ${dx.toFixed(3)}, ${dy.toFixed(3)} m)`);
}
assert(goals().length === 0, 'chip open: still nothing published');
const goldPending = await colorNear(690, 410, '--gold', 30);
assert(goldPending > goldBase + 15, `pending marker drawn (gold px ${goldBase} → ${goldPending})`);
await page.screenshot({ path: '/tmp/goal_link_2_chip.png' });

// -- 5. cancel → chip gone, nothing sent -------------------------------------
await page.click('.map-goalchip .gc-cancel');
await sleep(250);
assert(!(await exists('.map-goalchip')), 'cancel: chip dismissed');
assert(goals().length === 0, 'cancel: nothing published');

// -- 6. re-tap, SEND → exactly one PoseStamped, frame map, identity quat -----
const greenBase = await colorNear(690, 410, '--path', 30);
await page.mouse.click(690, 410, { delay: 40 });
await sleep(300);
const chipTxt2 = await text('.map-goalchip .gc-xy');
const cm2 = /X\s([+-]?[\d.]+)\s·\sY\s([+-]?[\d.]+)/.exec(chipTxt2 || '');
await page.click('.map-goalchip .gc-send');
await sleep(700);
assert(!(await exists('.map-goalchip')), 'send: chip dismissed');
const hint = await text('.map-navhint');
assert((hint || '').startsWith('Goal sent'), `send: toast confirms ("${hint}")`);
const g = goals();
assert(g.length === 1, `exactly one /goal_pose published (${g.length})`);
if (g.length === 1 && cm2) {
  assert(g[0].frame === 'map', `frame_id "map" ("${g[0].frame}")`);
  assert(g[0].qx === 0 && g[0].qy === 0 && g[0].qz === 0 && g[0].qw === 1,
    `identity orientation z0 w1 (got z ${g[0].qz}, w ${g[0].qw})`);
  const dx = Math.abs(g[0].x - parseFloat(cm2[1]));
  const dy = Math.abs(g[0].y - parseFloat(cm2[2]));
  assert(dx < 0.01 && dy < 0.01, `published coords match chip (Δ ${dx.toFixed(4)}, ${dy.toFixed(4)})`);
  assert(g[0].z === 0, 'position z = 0');
}
const greenSent = await colorNear(690, 410, '--path', 30);
assert(greenSent > greenBase + 15, `sent-goal marker drawn (path px ${greenBase} → ${greenSent})`);
await page.screenshot({ path: '/tmp/goal_link_3_sent.png' });

// -- 7. Esc collapses AND disarms; marker persists docked --------------------
await page.keyboard.press('Escape');
await sleep(600);
assert((await expandedAttr()) === 'false', 'Esc collapses');
await page.click('.map-btn.map-expand');
await sleep(600);
const armed1 = await page.evaluate(() => document.querySelector('.map-nav-toggle')?.getAttribute('aria-pressed'));
assert(armed1 === 'false', 're-expanded: nav toggle DISARMED again');
assert(!(await exists('.map-goalchip')), 're-expanded: no stale chip');
await page.keyboard.press('Escape');
await sleep(600);

// -- 8. stop detections → DELAYED (amber) then LINK LOST (red) ---------------
stopDetections();
let sawDelayed = false;
let sawLost = false;
for (let i = 0; i < 40 && !sawLost; i++) {
  await sleep(180);
  const l = (await linkState()).label || '';
  if (l === 'DELAYED') sawDelayed = true;
  if (l.includes('LINK LOST')) sawLost = true;
}
assert(sawDelayed, 'decay passes through DELAYED (amber)');
assert(sawLost, 'then LINK LOST / semantic memory decaying (red)');
await page.screenshot({ path: '/tmp/goal_link_4_lost.png' });

// -- 9. detections return → LIVE again ----------------------------------------
startDetections();
let back = null;
for (let i = 0; i < 40 && back !== 'LIVE'; i++) {
  await sleep(300);
  back = (await linkState()).label;
}
assert(back === 'LIVE', `recovery → LIVE (label "${back}")`);

// -- 10. websocket drop: stale tiles, no crash; reconnect restores -----------
// [t] trick: the regex still matches rosbridge itself but not this command's own
// sh wrapper (whose cmdline contains the pattern text)
try { execSync('pkill -9 -f "rosbridge_websocke[t]"'); } catch { /* none matched */ }
await sleep(2500);
const skel = await exists('.map-skel');
assert(skel, 'ws down: map shows connecting overlay (stale, not crashed)');
let lostAgain = false;
for (let i = 0; i < 25 && !lostAgain; i++) {
  await sleep(300);
  lostAgain = ((await linkState()).label || '').includes('LINK LOST');
}
assert(lostAgain, 'ws down: link tile decays to LINK LOST (keeps ticking)');
const domAlive = await page.evaluate(() => !!document.querySelector('#c-strip'));
assert(domAlive, 'ws down: app still rendering (no white screen)');
// restart rosbridge; the dashboard auto-reconnects (backoff ≤ 8 s)
spawn('bash', ['-c',
  'source /opt/ros/jazzy/setup.bash && exec ros2 launch rosbridge_server rosbridge_websocket_launch.xml'],
{ detached: true, stdio: 'ignore' }).unref();
let reconnected = false;
for (let i = 0; i < 60 && !reconnected; i++) {
  await sleep(500);
  if (await exists('.map-skel')) continue;
  // require the occupancy grid to actually be painted again (wall pixels), so
  // the marker-cleared check below can't pass against a blank canvas
  const [ccx, ccy] = (await stageCenter()) || [0, 0];
  const walls = await colorNear(ccx, ccy, '--map-wall', 300);
  reconnected = walls > 50;
}
assert(reconnected, 'ws restored: reconnected, /map re-rendered');
let liveAgain = null;
for (let i = 0; i < 40 && liveAgain !== 'LIVE'; i++) {
  await sleep(300);
  liveAgain = (await linkState()).label;
}
assert(liveAgain === 'LIVE', `ws restored: link tile LIVE again ("${liveAgain}")`);
// goal marker must NOT survive the reconnect (map-specific coords, never cached)
const [dcx2, dcy2] = await stageCenter();
await page.mouse.click(dcx2, dcy2, { delay: 40 });
await sleep(600);
const greenAfter = await colorNear(690, 410, '--path', 30);
assert(greenAfter <= greenBase + 15,
  `goal marker cleared by reconnect (path px ${greenSent} → ${greenAfter}, base ${greenBase})`);
await page.keyboard.press('Escape');
await sleep(400);
await page.screenshot({ path: '/tmp/goal_link_5_reconnected.png' });

// -- 11. idle /cmd_vel silence + console hygiene -----------------------------
assert(twists().length === 0, `idle dashboard published NOTHING on /cmd_vel (${twists().length} msgs)`);
assert(goals().length === 1, `total /goal_pose publishes exactly 1 (${goals().length})`);
const realErrors = consoleErrors.filter((e) => !/WebSocket|ros.*closed|favicon|ERR_CONNECTION/i.test(e));
assert(realErrors.length === 0,
  realErrors.length ? `no console errors - got: ${realErrors.join(' | ')}` : 'no console errors');

stopDetections();
await browser.close();
console.log(`\n${process.exitCode ? 'FAILED' : 'ALL PASSED'} - ${passed} assertions passed`);
