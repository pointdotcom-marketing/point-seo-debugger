// Renders the toolbar icons from an inline SVG using Playwright's Chromium.
import { chromium } from 'playwright';
import { chromiumPath } from './chromium.mjs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b7de9"/><stop offset="1" stop-color="#0b57d0"/></linearGradient></defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
  <path d="M50 30c-12 0-16 6-16 16v8c0 6-3 10-10 10 7 0 10 4 10 10v8c0 10 4 16 16 16" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M78 30c12 0 16 6 16 16v8c0 6 3 10 10 10-7 0-10 4-10 10v8c0 10-4 16-16 16" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="64" cy="64" r="8" fill="#fff"/>
</svg>`;

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `src/icons/icon-${size}.png`, omitBackground: true });
}
await browser.close();
console.log('icons written');
