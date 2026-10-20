// End-to-end check: loads the unpacked extension in Chromium, serves fixture pages from a local
// server, and asserts on what the side panel shows. Screenshots go to $SCREENSHOT_DIR (optional).
//   node tests/e2e.mjs
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromiumPath } from '../scripts/chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests/fixtures');
const shots = process.env.SCREENSHOT_DIR;
const HOSTNAME = 'www.example-home.com';
// A second site with AI-crawler rules, so its robots.txt doesn't change the main fixtures.
const AI_HOSTNAME = 'ai.example-home.com';

// --- Fixture server --------------------------------------------------------
const server = createServer(async (req, res) => {
  const host = req.headers.host;
  const path = new URL(req.url, `http://${host}`).pathname;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (host.startsWith(AI_HOSTNAME)) {
    if (path === '/robots.txt') return send(200, 'User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: anthropic-ai\nDisallow: /\n\nUser-agent: *\nContent-Signal: search=yes, ai-train=no\nAllow: /\n', { 'content-type': 'text/plain' });
    if (path === '/llms.txt') return send(200, '# Example Home\n> Home equity guides.\n\n## Guides\n- [HEI guide](/clean.html)\n', { 'content-type': 'text/plain' });
    // Simulates a firewall rule that blocks one AI crawler by User-Agent.
    if (/Bytespider/.test(req.headers['user-agent'] || '')) return send(403, 'Forbidden');
  }
  if (path === '/robots.txt') return send(200, `User-agent: *\nDisallow: /blocked/\n\nSitemap: http://${host}/sitemap.xml\n`, { 'content-type': 'text/plain' });
  const sitemap = { '/sitemap.xml': 'sitemap.xml', '/sitemaps/pages.xml': 'sitemap-pages.xml', '/sitemaps/more.xml.gz': 'sitemap-more.xml' }[path];
  if (sitemap) {
    const xml = (await readFile(join(fixtures, sitemap), 'utf8')).replaceAll('HOST', host);
    return path.endsWith('.gz') ? send(200, gzipSync(xml), { 'content-type': 'application/gzip' }) : send(200, xml, { 'content-type': 'application/xml' });
  }
  if (path === '/old-page') return send(301, '', { location: '/clean.html' });
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
const userDataDir = await mkdtemp(join(tmpdir(), 'point-seo-debugger-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: chromiumPath(),
  headless: true,
  viewport: { width: 420, height: 900 },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    // Resolve the fixture host locally and keep every other host offline so runs are deterministic.
    `--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1, MAP ${AI_HOSTNAME} 127.0.0.1, MAP * ~NOTFOUND`,
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

  // ---- AI crawler access ---------------------------------------------------
  const aiPage = await openPanel(`http://${AI_HOSTNAME}:${port}/clean.html`);
  await aiPage.panel.waitForFunction(() => globalThis.__seoLensState.ai?.llms);
  const ai = await aiPage.panel.evaluate(() => {
    const a = globalThis.__seoLensState.ai;
    return { bots: Object.fromEntries(a.bots.map((b) => [b.token, b.allowed])), signals: a.contentSignals, llms: a.llms, checks: a.checks.map((c) => c.message) };
  });
  await check('AI tab: robots.txt verdicts, Content-Signal, llms.txt, legacy token', () => {
    assert.equal(ai.bots.GPTBot, false);
    assert.equal(ai.bots.ClaudeBot, false);
    assert.equal(ai.bots['OAI-SearchBot'], true);
    assert.equal(ai.bots.PerplexityBot, true);
    assert.deepEqual(ai.signals[0].prefs, { search: 'yes', 'ai-train': 'no' });
    assert.equal(ai.llms.title, 'Example Home');
    assert.ok(ai.checks.some((m) => /"anthropic-ai"/.test(m)));
  });
  await check('AI tab: bot user-agent probe catches a firewall block', async () => {
    await aiPage.panel.click('button[data-tab="ai"]');
    await aiPage.panel.click('[data-ai-probe]');
    await aiPage.panel.waitForFunction(() => !globalThis.__seoLensState.aiProbeRunning && globalThis.__seoLensState.aiProbes?.size > 5, null, { timeout: 30000 });
    const probes = await aiPage.panel.evaluate(() => Object.fromEntries(globalThis.__seoLensState.aiProbes));
    assert.equal(probes.browser.outcome, 'served');
    assert.equal(probes.Bytespider.outcome, 'blocked', JSON.stringify(probes.Bytespider));
    assert.equal(probes.GPTBot.outcome, 'served');
    assert.match(await aiPage.panel.textContent('#content'), /1 bot user agent was blocked or challenged/);
  });
  if (shots) await aiPage.panel.screenshot({ path: join(shots, 'ai-tab.png'), fullPage: true });

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

  // ---- Sitemap scan -------------------------------------------------------
  const tabsBefore = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  let scan;
  await check('Tools tab links to a sitemap scan prefilled from robots.txt', async () => {
    await clean.panel.click('button[data-tab="tools"]');
    const href = await clean.panel.$eval('[data-scan-sitemap]', (a) => a.href);
    assert.match(href, /^chrome-extension:\/\/[^/]+\/src\/scan\/scan\.html\?/);
    scan = await context.newPage();
    scan.on('pageerror', (e) => pageErrors.push(`scan: ${e.message}`));
    await scan.goto(href);
    await scan.waitForFunction(() => document.getElementById('sitemap').value);
    assert.equal(await scan.inputValue('#sitemap'), `${origin}/sitemap.xml`);
  });

  await check('sitemap scan: reads nested + gzipped sitemaps and scans every URL in background tabs', async () => {
    // kitchen-sink.html injects a JSON-LD block 1.5s after load.
    await scan.fill('#settle', '2000');
    await scan.click('#start');
    await scan.waitForFunction(() => globalThis.__seoLensScan.phase === 'done', null, { timeout: 90000 });
    const s = await scan.evaluate(() => {
      const st = globalThis.__seoLensScan;
      return { sitemaps: st.crawl.sitemaps.map((m) => ({ url: m.url, type: m.type, urls: m.urls, errors: m.errors })), rows: st.rows, report: st.report };
    });
    const path = (u) => new URL(u).pathname;
    assert.deepEqual(s.sitemaps.map((m) => [path(m.url), m.type, m.urls]), [['/sitemap.xml', 'sitemapindex', 0], ['/sitemaps/pages.xml', 'urlset', 5], ['/sitemaps/more.xml.gz', 'urlset', 3]]);
    assert.equal(s.rows.length, 8, 'clean.html is listed twice but scanned once');
    assert.ok(s.rows.every((r) => !r.pending), 'every row was scanned');
    const row = Object.fromEntries(s.rows.map((r) => [path(r.url), r]));
    assert.equal(row['/clean.html'].status, 200);
    assert.equal(row['/clean.html'].indexable, true);
    assert.equal(row['/clean.html'].canonicalKind, 'self');
    assert.deepEqual(row['/clean.html'].types, ['WebSite', 'Organization', 'Article']);
    assert.ok(row['/clean.html'].rich.valid >= 1);
    assert.equal(row['/guides/'].canonicalKind, 'other');
    assert.equal(row['/missing-page'].status, 404);
    assert.ok(row['/kitchen-sink.html'].errors > 0);
    assert.equal(row['/kitchen-sink.html'].imagesMissingAlt, 1);
    assert.ok(row['/kitchen-sink.html'].types.includes('VideoObject'), 'JSON-LD injected after load is collected (tab was rendered)');

    const f = Object.fromEntries(s.report.findings.map((x) => [x.id, x]));
    const urls = (id) => (f[id].items || []).map((i) => path(i.url));
    assert.deepEqual(urls('noindex'), ['/noindex.html']);
    assert.deepEqual(urls('robots-blocked'), ['/blocked/page.html']);
    assert.deepEqual(urls('redirects'), ['/old-page']);
    assert.deepEqual(urls('non-200'), ['/missing-page']);
    const dup = f['duplicate-titles'].groups.find((g) => g.value.startsWith('How home equity'));
    assert.ok(dup, JSON.stringify(f['duplicate-titles']));
    assert.ok(['/', '/guides/'].every((p) => dup.urls.map(path).includes(p)), dup.urls.join(', '));
    assert.ok(!dup.urls.map(path).includes('/old-page'), 'the redirecting URL is not a duplicate');
    assert.ok(urls('canonical-elsewhere').includes('/guides/'));
  });

  await check('sitemap scan: closes its background tabs', async () => {
    await scan.waitForTimeout(300);
    assert.equal(await sw.evaluate(async () => (await chrome.tabs.query({})).length), tabsBefore + 1);
  });

  await check('sitemap scan: table filters, sorting, row details and site-wide findings', async () => {
    assert.match(await scan.textContent('#findings'), /Sitemap URLs that are noindex\s*1/);
    await scan.click('[data-row-filter="not-indexable"]');
    const notIndexable = await scan.$$eval('#table tr.row', (trs) => trs.map((tr) => new URL(tr.dataset.url).pathname));
    assert.deepEqual(notIndexable.sort(), ['/blocked/page.html', '/missing-page', '/noindex.html', '/old-page']);
    await scan.click('[data-row-filter="all"]');
    await scan.click('th[data-sort="errors"]');
    const first = await scan.$eval('#table tr.row', (tr) => tr.dataset.url);
    assert.match(first, /kitchen-sink/, 'sorted by errors, most first');
    await scan.click('#table tr.row');
    assert.match(await scan.textContent('#table tr.detail'), /hreflang/);
    await scan.fill('#search', 'noindex');
    assert.equal(await scan.locator('#table tr.row').count(), 1);
    await scan.fill('#search', '');
  });

  await check('sitemap scan: CSV export', async () => {
    const [download] = await Promise.all([scan.waitForEvent('download'), scan.click('#export')]);
    const body = await readFile(await download.path(), 'utf8');
    const lines = body.trim().split('\n');
    assert.match(lines[0], /^\uFEFF?"url","final url","status","indexable"/);
    assert.equal(lines.length, 9);
    assert.ok(lines.some((l) => l.includes('/noindex.html') && l.includes('"no","noindex"')));
  });
  if (shots) {
    await scan.setViewportSize({ width: 1280, height: 900 });
    await scan.screenshot({ path: join(shots, 'sitemap-scan.png'), fullPage: true });
  }

  await check('sitemap scan: pause and stop', async () => {
    await scan.fill('#concurrency', '1');
    await scan.fill('#settle', '600');
    await scan.click('#start');
    await scan.waitForFunction(() => globalThis.__seoLensScan.rows.filter((r) => !r.pending).length >= 1, null, { timeout: 30000 });
    await scan.click('#pause');
    const done = () => scan.evaluate(() => globalThis.__seoLensScan.rows.filter((r) => !r.pending).length);
    await scan.waitForFunction(() => !globalThis.__seoLensScan.rows.some((r) => r.running), null, { timeout: 30000 });
    const atPause = await done();
    await scan.waitForTimeout(1500);
    assert.equal(await done(), atPause, 'no progress while paused');
    assert.equal(await scan.textContent('#pause'), 'Resume');
    await scan.click('#stop');
    await scan.waitForFunction(() => globalThis.__seoLensScan.phase === 'done', null, { timeout: 30000 });
    assert.equal(await scan.evaluate(() => globalThis.__seoLensScan.stopped), true);
    assert.ok((await done()) < 8);
    await scan.waitForTimeout(300);
    assert.equal(await sw.evaluate(async () => (await chrome.tabs.query({})).length), tabsBefore + 1, 'stop closes the scan tabs');
  });
  await scan?.close();

  await check('no JavaScript errors in the side panel', () => assert.deepEqual(pageErrors, []));
} finally {
  await context.close();
  server.close();
  await rm(userDataDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
