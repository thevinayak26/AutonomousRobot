// One-off: expand the map, zoom in hard, and capture several high-DPI frames so the
// new 3-D rover model can be judged (and its heading checked as the robot moves).
// Writes /tmp/atlas_rover_{0..3}.png. Throwaway — not committed.
import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto('http://localhost:5173/?host=localhost', { waitUntil: 'domcontentloaded' });

for (let i = 0; i < 60; i++) {
  await sleep(500);
  const ok = await page.evaluate(() => !document.querySelector('.intro') && !!document.querySelector('#map')?.width);
  if (ok) break;
}
await sleep(2600);

// expand to fullscreen
if (await page.evaluate(() => !!document.querySelector('.map-btn.map-expand'))) {
  await page.click('.map-btn.map-expand');
  await sleep(800);
}

// zoom in hard on the canvas centre so the rover renders large
const box = await page.evaluate(() => {
  const c = document.querySelector('#map');
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const recenter = async () => {
  const btn = 'button[aria-label="Center on robot"]';
  if (await page.evaluate((s) => !!document.querySelector(s), btn)) await page.click(btn);
};
await recenter();
await sleep(200);
await page.mouse.move(box.x, box.y);
for (let i = 0; i < 7; i++) {
  await page.mouse.wheel({ deltaY: -120 });
  await sleep(70);
}
await sleep(400);

// several frames as the robot drives, recentering each time so it stays framed
for (let f = 0; f < 4; f++) {
  await recenter();
  await sleep(450);
  await page.screenshot({ path: `/tmp/atlas_rover_${f}.png` });
  console.log(`shot /tmp/atlas_rover_${f}.png`);
  await sleep(700);
}
await browser.close();
