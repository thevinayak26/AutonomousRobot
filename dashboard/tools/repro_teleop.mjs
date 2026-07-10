// Reproduce the teleop bug: toggle Manual Drive on, hold W, toggle off.
// Captures console errors, page errors, and whether the ErrorBoundary ("Dashboard
// crashed") rendered after toggling off. Run against rosbridge + vite.
//   node tools/repro_teleop.mjs
import puppeteer from 'puppeteer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 880, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));

await page.goto('http://localhost:5173/?host=localhost', { waitUntil: 'domcontentloaded' });

// Wait until rosbridge connected => the Manual Drive button is enabled.
let connected = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  connected = await page.evaluate(() => {
    const b = document.querySelector('.teleop-toggle');
    return !!(b && !b.disabled);
  });
  if (connected) break;
}
console.log('CONNECTED(button enabled):', connected);

const state = () => page.evaluate(() => ({
  crashed: !![...document.querySelectorAll('h1')].find((h) => /Dashboard crashed/i.test(h.textContent)),
  toggleOn: !!document.querySelector('.teleop-toggle.on'),
  hud: !!document.querySelector('.teleop-hud'),
  wLit: !!document.querySelector('.teleop-keys .tk.on'),
  teleopPresent: !!document.querySelector('.teleop'),
}));

// 1) toggle ON
await page.click('.teleop-toggle');
await sleep(500);
console.log('after ON  :', JSON.stringify(await state()));

// 2) hold W (real key events on window)
await page.keyboard.down('w');
await sleep(2500); // long enough for the 15 Hz publish loop + ros2 topic echo to catch it
console.log('while W   :', JSON.stringify(await state()));

// 3) release W
await page.keyboard.up('w');
await sleep(400);

// 4) toggle OFF  <-- the reported crash point
await page.click('.teleop-toggle');
await sleep(800);
console.log('after OFF :', JSON.stringify(await state()));

// 5) toggle ON again (does it recover, or stay crashed?)
const stillThere = await page.evaluate(() => !!document.querySelector('.teleop-toggle'));
if (stillThere) {
  await page.click('.teleop-toggle');
  await sleep(500);
  console.log('after ON2 :', JSON.stringify(await state()));
}

console.log('ERRORS(' + errors.length + '):');
for (const e of errors) console.log('  - ' + e.split('\n').slice(0, 3).join(' | '));

await browser.close();
console.log('done');
