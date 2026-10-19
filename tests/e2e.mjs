// End-to-end check: loads the unpacked extension in Chromium, serves fixture pages from a local
// server, and asserts on what the side panel shows. Screenshots go to $SCREENSHOT_DIR (optional).
//   node tests/e2e.mjs
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromiumPath } from '../scripts/chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests/fixtures');
const shots = process.env.SCREENSHOT_DIR;
const HOSTNAME = 'www.example-home.com';

// --- Fixture server --------------------------------------------------------
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  const path = new URL(req.url, `http://${host}`).pathname;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (path === '/robots.txt') return send(200, `User-agent: *\nDisallow: /blocked/\n\nSitemap: http://${host}/sitemap.xml\n`, { 'content-type': 'text/plain' });
  if (path === '/assets/icon.png') return send(200, await readFile(join(root, 'src/icons/icon-128.png')), { 'content-type': 'image/png' });
  const file = { '/kitchen-sink.html': 'kitchen-sink.html', '/clean.html': 'clean.html', '/noindex.html': 'noindex.html', '/blocked/page.html': 'clean.html', '/': 'clean.html', '/guides/': 'clean.html' }[path];
  if (!file) return send(404, 'Not found');
  const html = (await readFile(join(fixtures, file), 'utf8')).replaceAll('HOST', host);
  send(200, html, path === '/noindex.html' ? { 'x-robots-tag': 'noindex' } : {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://${HOSTNAME}:${port}`;

// --- Browser ---------------------------------------------------------------
const userDataDir = await mkdtemp(join(tmpdir(), 'seo-lens-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromiumPath(),
  headless: true,
  viewport: { width: 420, height: 900 },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    // Resolve the fixture host locally and keep every other host offline so runs are deterministic.
    `--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1, MAP * ~NOTFOUND`,
  ],
});

let failures = 0;
const pageErrors = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.log(`✖ ${name}\n  ${e.message.split('\n').join('\n  ')}`);
  }
}

try {
  const isOurs = (w) => w.url().endsWith('/src/background.js');
  const sw = context.serviceWorkers().find(isOurs) || (await context.waitForEvent('serviceworker', { predicate: isOurs }));
  const extId = new URL(sw.url()).host;
  // The worker can be reported before Chrome has attached extension APIs to it.
  for (let i = 0; i < 50 && !(await sw.evaluate(() => typeof chrome?.tabs?.query === 'function')); i++) await new Promise((r) => setTimeout(r, 100));
  if (shots) await mkdir(shots, { recursive: true });

  const tabIdFor = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  const badge = (tabId) => sw.evaluate(async (id) => ({ text: await chrome.action.getBadgeText({ tabId: id }), title: await chrome.action.getTitle({ tabId: id }) }), tabId);

  async function openPanel(url, { waitNetwork = true } = {}) {
    const page = await context.newPage();
    await page.goto(url);
    const tabId = await tabIdFor(url);
    const panel = await context.newPage();
    panel.on('pageerror', (e) => pageErrors.push(`${url}: ${e.message}`));
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html?tabId=${tabId}`);
    await panel.waitForFunction(() => globalThis.__seoLensState?.seo);
    if (waitNetwork) await panel.waitForFunction(() => !globalThis.__seoLensState.httpPending && !globalThis.__seoLensState.robotsPending);
    return { page, panel, tabId };
  }
  const read = (panel) =>
    panel.evaluate(() => {
      const s = globalThis.__seoLensState;
      return {
        seo: { counts: s.seo.counts, summary: s.seo.summary, checks: s.seo.checks, links: s.seo.links.stats, images: { total: s.seo.images.total, missingAlt: s.seo.images.missingAlt }, hreflang: s.seo.hreflang },
        schema: {
          counts: s.schema.counts,
          features: s.schema.features.map((f) => ({ id: f.featureId, status: f.status, blockLabel: f.blockLabel, issues: f.issues.map((i) => i.message) })),
          blockIssues: s.schema.blocks.flatMap((b) => b.issues.map((i) => i.code)),
          blocks: s.schema.blocks.map((b) => ({ format: b.format, label: b.label, types: b.types, data: b.data, issues: b.issues.map((i) => i.code) })),
        },
      };
    });
  const text = (r) => r.seo.checks.map((c) => `${c.area}/${c.severity}: ${c.message}`).join('\n');

  // ---- Kitchen sink -------------------------------------------------------
  const ks = await openPanel(`${origin}/kitchen-sink.html`, { waitNetwork: false });
  await check('live update picks up JSON-LD injected after load', async () => {
    await ks.panel.waitForFunction(() => globalThis.__seoLensState.schema.features.some((f) => f.featureId === 'video'), null, { timeout: 8000 });
  });
  await ks.panel.waitForFunction(() => !globalThis.__seoLensState.httpPending && !globalThis.__seoLensState.robotsPending);
  let r = await read(ks.panel);

  await check('kitchen sink: on-page SEO checks', () => {
    const t = text(r);
    assert.equal(r.seo.summary.indexable, true);
    assert.equal(r.seo.summary.http.status, 200);
    assert.equal(r.seo.summary.robotsTxt.allowed, true);
    for (const re of [/title\/warning: Title will likely be truncated.*px/, /description\/warning: Description is short/, /canonical\/warning: Canonical is relative/, /hreflang\/error: Invalid hreflang code: es_MX/, /headings\/info: Heading levels skip/, /headings\/warning: 1 empty heading/, /images\/warning: 1 image is missing an alt/, /images\/warning: 1 image has a filename as alt/, /links\/warning: .*staging\/preview host/, /links\/warning: .*no anchor text/, /links\/info: 1 javascript: link/, /social\/warning: og:image must be an absolute URL/]) {
      assert.match(t, re);
    }
    assert.equal(r.seo.images.missingAlt, 1);
    assert.ok(r.seo.summary.titlePx > 580, `titlePx=${r.seo.summary.titlePx}`);
  });

  await check('kitchen sink: structured data', () => {
    const f = Object.fromEntries(r.schema.features.filter((x) => x.blockLabel.startsWith('Block ')).map((x) => [x.id, x]));
    assert.ok(r.schema.blockIssues.includes('invalid-json'));
    assert.equal(f.breadcrumb.status, 'invalid');
    assert.equal(f.faq.status, 'deprecated');
    assert.equal(f.article.status, 'valid', f.article.issues.join('\n'));
    assert.ok(f['review-snippet'].issues.some((m) => /self-serving/.test(m)));
    assert.ok(f['merchant-listing'].issues.some((m) => /plain number/.test(m)));
    assert.ok(r.schema.blockIssues.includes('invalid-enum'));
  });

  await check('kitchen sink: Microdata is converted and checked like JSON-LD', async () => {
    assert.equal(r.schema.counts.microdata, 1);
    const md = r.schema.blocks.find((b) => b.format === 'microdata');
    assert.equal(md.label, 'Microdata item 1');
    assert.deepEqual(md.types, ['Product']);
    assert.equal(md.data.name, 'Equity Calculator Pro', 'name comes from the itemref');
    assert.deepEqual(md.data.offers, { '@type': 'Offer', price: '49.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
    assert.ok(md.issues.includes('unknown-property'), md.issues.join(', '));
    const merchant = r.schema.features.find((x) => x.id === 'merchant-listing' && x.blockLabel === 'Microdata item 1');
    assert.ok(merchant, 'merchant listing rules ran on the Microdata Product');
    assert.notEqual(merchant.status, 'invalid', merchant.issues.join('\n'));
    await ks.panel.click('button[data-tab="schema"]');
    await ks.panel.click('[data-schema-view="source"]');
    const card = ks.panel.locator('article.card', { hasText: 'Microdata item 1' });
    assert.match(await card.locator('.format-tag').textContent(), /Microdata/);
    assert.match(await card.locator('pre.code').textContent(), /"Equity Calculator Pro"/);
    await ks.panel.click('[data-schema-view="google"]');
    assert.equal(await ks.panel.locator('article.card', { hasText: 'Microdata item 1' }).locator('.format-tag').first().textContent(), 'Microdata');
  });

  await check('toolbar badge shows the error count', async () => {
    const b = await badge(ks.tabId);
    assert.match(b.text, /^\d+$/);
    assert.ok(+b.text > 0);
    assert.match(b.title, /JSON-LD/);
    assert.match(b.title, /1 Microdata item/);
  });

  await check('clicking a heading highlights it on the page', async () => {
    await ks.panel.click('button[data-tab="headings"]');
    await ks.panel.click('.hrow[data-index="1"]');
    await ks.page.waitForFunction(() => document.querySelectorAll('h1,h2,h3,h4,h5,h6')[1].style.outline.includes('solid'), null, { timeout: 3000 });
  });

  await check('link checker reports 404s and unreachable hosts', async () => {
    await ks.panel.click('button[data-tab="links"]');
    await ks.panel.click('[data-check-links]');
    await ks.panel.waitForFunction(() => !globalThis.__seoLensState.linkCheckRunning, null, { timeout: 30000 });
    const status = await ks.panel.evaluate(() => Object.fromEntries(globalThis.__seoLensState.linkStatus));
    const find = (suffix) => Object.entries(status).find(([u]) => u.endsWith(suffix))?.[1];
    assert.equal(find('/missing-page')?.status, 404);
    assert.equal(find('/guides/')?.status, 200);
    assert.ok(find('consumerfinance.gov/')?.error, 'external host should fail (offline in test)');
  });

  if (shots) {
    for (const tab of ['overview', 'schema', 'headings', 'images', 'links', 'social', 'tools']) {
      await ks.panel.click(`button[data-tab="${tab}"]`);
      await ks.panel.waitForTimeout(300);
      await ks.panel.screenshot({ path: join(shots, `kitchen-${tab}.png`), fullPage: true });
    }
    for (const view of ['issues', 'source']) {
      await ks.panel.click('button[data-tab="schema"]');
      await ks.panel.click(`[data-schema-view="${view}"]`);
      await ks.panel.screenshot({ path: join(shots, `kitchen-schema-${view}.png`), fullPage: true });
    }
    await ks.panel.emulateMedia({ colorScheme: 'dark' });
    await ks.panel.click('button[data-tab="overview"]');
    await ks.panel.screenshot({ path: join(shots, 'kitchen-overview-dark.png'), fullPage: true });
  }

  // ---- Clean page ---------------------------------------------------------
  const clean = await openPanel(`${origin}/clean.html`);
  r = await read(clean.panel);
  await check('clean page: no errors or warnings', () => {
    assert.equal(r.seo.counts.errors + r.schema.counts.errors, 0, text(r) + JSON.stringify(r.schema.features));
    assert.equal(r.seo.counts.warnings + r.schema.counts.warnings, 0, text(r) + JSON.stringify(r.schema.features, null, 1));
    assert.ok(r.schema.features.some((f) => f.id === 'article' && f.status === 'valid'));
  });
  await check('clean page: badge is a check mark', async () => {
    assert.equal((await badge(clean.tabId)).text, '✓');
  });
  if (shots) await clean.panel.screenshot({ path: join(shots, 'clean-overview.png'), fullPage: true });

  // ---- Noindex via header, robots.txt block ------------------------------
  const ni = await openPanel(`${origin}/noindex.html`);
  r = await read(ni.panel);
  await check('X-Robots-Tag noindex header makes the page not indexable', () => {
    assert.equal(r.seo.summary.indexable, false);
    assert.match(text(r), /robots\/error: Page is noindex \(X-Robots-Tag header\)/);
  });
  if (shots) await ni.panel.screenshot({ path: join(shots, 'noindex-overview.png'), fullPage: true });

  const bl = await openPanel(`${origin}/blocked/page.html`);
  r = await read(bl.panel);
  await check('robots.txt Disallow makes the page not indexable', () => {
    assert.equal(r.seo.summary.indexable, false);
    assert.match(text(r), /robots\.txt blocks Googlebot.*Disallow: \/blocked\//);
  });

  // ---- Non-web page -------------------------------------------------------
  await check('panel explains it can\'t run on chrome:// pages', async () => {
    const p = await context.newPage();
    await p.goto('chrome://version');
    // Without the "tabs" permission Chrome hides chrome:// URLs, so take the URL-less tab.
    const id = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => !t.url)?.id);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html?tabId=${id}`);
    await panel.waitForSelector('.empty p');
    assert.match(await panel.textContent('.empty p'), /only runs on web pages/);
  });

  await check('no JavaScript errors in the side panel', () => assert.deepEqual(pageErrors, []));
} finally {
  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
