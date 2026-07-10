import puppeteer from 'puppeteer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto('http://localhost:5173/?host=localhost', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 60; i++) { await sleep(400); const ok = await page.evaluate(() => !document.querySelector('.intro')); if (ok) break; }
await sleep(1500);
const clip = { x: 0, y: 0, width: 520, height: 150 };
await page.screenshot({ path: '/tmp/atlas_logo_rest.png', clip });
// report the cursor CSS the browser computes on the logo
const cur = await page.evaluate(() => getComputedStyle(document.querySelector('.brand-logo')).cursor);
console.log('cursor on .brand-logo =', cur);
await page.hover('.brand-logo');
await sleep(700);
await page.screenshot({ path: '/tmp/atlas_logo_hover.png', clip });
console.log('logo shots saved');
await browser.close();
