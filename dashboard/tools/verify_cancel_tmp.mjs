import puppeteer from 'puppeteer';
import { readFileSync, existsSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const assert = (c, m) => { if (c) { passed++; console.log('OK ' + m); } else { console.error('FAIL ' + m); process.exitCode = 1; } };
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1380, height: 820 });
page.on('pageerror', (e) => console.error('pageerror: ' + e.message));
await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 60; i++) { await sleep(500); const ok = await page.evaluate(() => !document.querySelector('.intro') && !document.querySelector('.map-skel')); if (ok) break; }
// expand
const [cx, cy] = await page.evaluate(() => { const r = document.querySelector('.map-stage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await page.mouse.click(cx, cy, { delay: 40 });
await sleep(600);
// toolbar row positions: close 12, layers 58, goal 104 from right
const pos = await page.evaluate(() => {
  const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return Math.round(window.innerWidth - r.right); };
  return { close: g('.map-close'), layers: g('.map-layers'), goal: g('.map-nav-toggle'), top: document.querySelector('.map-nav-toggle')?.getBoundingClientRect().top };
});
assert(pos.close === 12 && pos.layers === 58 && pos.goal === 104, `toolbar row aligned right (close ${pos.close}, layers ${pos.layers}, goal ${pos.goal})`);
assert(!(await page.evaluate(() => !!document.querySelector('.map-nav-cancel'))), 'no cancel button before a goal exists');
// arm, tap, send
await page.click('.map-nav-toggle'); await sleep(150);
await page.mouse.click(690, 410, { delay: 40 }); await sleep(300);
assert(await page.evaluate(() => !!document.querySelector('.map-goalchip')), 'chip appears');
await page.click('.map-goalchip .gc-send'); await sleep(500);
assert(await page.evaluate(() => !!document.querySelector('.map-nav-cancel')), 'cancel button appears after send');
const cancelR = await page.evaluate(() => Math.round(window.innerWidth - document.querySelector('.map-nav-cancel').getBoundingClientRect().right));
assert(cancelR === 150, `cancel button in the row (right ${cancelR})`);
await page.click('.map-nav-cancel'); await sleep(800);
const probe = existsSync('/tmp/cancel_probe.txt') ? readFileSync('/tmp/cancel_probe.txt', 'utf8') : '';
assert(probe.includes('cancel uuid=[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]'), `cancel service called w/ zero uuid (${probe.trim()})`);
assert(!(await page.evaluate(() => !!document.querySelector('.map-nav-cancel'))), 'cancel button gone (goal cleared)');
const hint = await page.evaluate(() => document.querySelector('.map-navhint')?.textContent);
assert(hint === 'Nav goal cancelled', `toast confirms ("${hint}")`);
await page.screenshot({ path: '/tmp/cancel_ui.png' });
await browser.close();
console.log((process.exitCode ? 'FAILED' : 'ALL PASSED') + ' - ' + passed);
