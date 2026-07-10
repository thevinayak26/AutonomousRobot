// Screenshot the dashboard for a visual review: both themes, the layers popover,
// and the expanded map (so the 2.5D rover + grid + scan show big). Run against
// rosbridge + fake_publisher.py --full + vite. Writes /tmp/atlas_<theme>[_tag].png.
//   node tools/shoot_themes.mjs
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 880, deviceScaleFactor: 1 });
await page.goto('http://localhost:5173/?host=localhost', { waitUntil: 'domcontentloaded' });

const theme = () =>
  page.evaluate(
    () =>
      document.documentElement.getAttribute('data-theme') ||
      document.body.getAttribute('data-theme') ||
      'unknown',
  );
const exists = (s) => page.evaluate((x) => !!document.querySelector(x), s);

// settle: intro overlay cleared + map canvas sized
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const introGone = await page.evaluate(() => !document.querySelector('.intro'));
  const sized = await page.evaluate(() => {
    const c = document.querySelector('#map');
    return !!(c && c.width);
  });
  if (introGone && sized) break;
}
await sleep(2800); // rosbridge WS connect + latched /map + first frames

// measure render smoothness (avg fps + worst frame) with live data flowing
const perf = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      let worst = 0;
      const start = performance.now();
      let last = start;
      const tick = (t) => {
        const dt = t - last;
        last = t;
        frames += 1;
        if (frames > 1 && dt > worst) worst = dt;
        if (t - start < 3000) requestAnimationFrame(tick);
        else resolve({ fps: Math.round((frames / (t - start)) * 1000), worstFrameMs: Math.round(worst) });
      };
      requestAnimationFrame(tick);
    }),
);
console.log('PERF', JSON.stringify(perf));

const shot = async (tag) => {
  const t = await theme();
  const p = `/tmp/atlas_${t}${tag ? `_${tag}` : ''}.png`;
  await page.screenshot({ path: p });
  console.log('shot', p);
};

// 1) docked dashboard
await shot('');

// 2) layers popover open (new control), then flip Grid on for the expanded demo
if (await exists('.map-layers .map-btn')) {
  await page.click('.map-layers .map-btn');
  await sleep(350);
  await shot('layers');
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.layers-row')];
    const g = rows.find((r) => r.textContent.includes('Grid'));
    if (g) g.querySelector('input').click();
  });
  await sleep(200);
  await page.click('.map-layers .map-btn'); // close popover
  await sleep(250);
}

// 3) expand → fullscreen map (2.5D rover + scan + grid show big)
if (await exists('.map-btn.map-expand')) {
  await page.click('.map-btn.map-expand');
  await sleep(750);
  await shot('expanded');
  await page.keyboard.press('Escape');
  await sleep(750);
}

// 4) flip theme → docked
await page.click('header button.toggle');
await sleep(900);
await shot('');

await browser.close();
console.log('done');
