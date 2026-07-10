import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto('http://localhost:5173/?host=localhost', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 60; i++) { await sleep(500); const ok = await page.evaluate(() => !document.querySelector('.intro') && !!document.querySelector('#map')?.width); if (ok) break; }
await sleep(2400);
// flip to light theme
const tg = '[aria-label="Toggle dark/light theme"]';
if (await page.evaluate((s)=>document.documentElement.getAttribute('data-theme'), tg) !== 'light') await page.click(tg);
await sleep(500);
if (await page.evaluate(() => !!document.querySelector('.map-btn.map-expand'))) { await page.click('.map-btn.map-expand'); await sleep(800); }
const recenter = async () => { const b='button[aria-label="Center on robot"]'; if (await page.evaluate((s)=>!!document.querySelector(s), b)) await page.click(b); };
await recenter(); await sleep(200);
const box = await page.evaluate(() => { const c = document.querySelector('#map'); const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; });
await page.mouse.move(box.x, box.y);
for (let i=0;i<7;i++){ await page.mouse.wheel({deltaY:-120}); await sleep(70); }
await recenter(); await sleep(600);
await page.screenshot({ path: '/tmp/atlas_rover_light.png' });
console.log('light shot saved');
await browser.close();
