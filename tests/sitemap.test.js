import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, crawlSitemaps, compileFilter, selectUrls, defaultSitemaps } from '../src/lib/sitemap.js';

const urlset = (...locs) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${locs.map((l) => `  <url><loc>${l}</loc><lastmod>2026-01-02</lastmod></url>`).join('\n')}
</urlset>`;
const index = (...locs) => `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}
</sitemapindex>`;

test('parses a urlset with lastmod, entities, CDATA and image extensions', () => {
  const xml = `<?xml version="1.0"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
    <!-- <url><loc>https://example.com/commented-out</loc></url> -->
    <url>
      <loc>https://example.com/a?x=1&amp;y=2</loc>
      <lastmod>2026-03-01</lastmod>
      <image:image><image:loc>https://example.com/img.png</image:loc></image:image>
    </url>
    <url><loc><![CDATA[https://example.com/b]]></loc></url>
    <url><loc>/relative</loc></url>
  </urlset>`;
  const r = parseSitemap(xml);
  assert.equal(r.type, 'urlset');
  assert.deepEqual(r.urls, [
    { loc: 'https://example.com/a?x=1&y=2', lastmod: '2026-03-01' },
    { loc: 'https://example.com/b', lastmod: null },
  ]);
  assert.match(r.errors[0], /1 entry has a missing or non-absolute <loc>/);
});

test('parses a sitemap index, including namespace-prefixed XML', () => {
  const r = parseSitemap(index('https://example.com/s1.xml', 'https://example.com/s2.xml'));
  assert.equal(r.type, 'sitemapindex');
  assert.deepEqual(r.sitemaps.map((s) => s.loc), ['https://example.com/s1.xml', 'https://example.com/s2.xml']);
  const prefixed = parseSitemap('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://example.com/p</sm:loc></sm:url></sm:urlset>');
  assert.deepEqual(prefixed.urls.map((u) => u.loc), ['https://example.com/p']);
});

test('plain-text sitemaps and non-sitemaps', () => {
  assert.deepEqual(parseSitemap('https://example.com/a\nhttps://example.com/b\n').urls.map((u) => u.loc), ['https://example.com/a', 'https://example.com/b']);
  const html = parseSitemap('<!doctype html><html><body>Not found</body></html>');
  assert.equal(html.type, 'unknown');
  assert.match(html.errors[0], /HTML page/);
});

test('crawlSitemaps follows nested indexes, dedupes and records errors', async () => {
  const files = {
    'https://example.com/sitemap.xml': index('https://example.com/pages.xml', 'https://example.com/nested.xml', 'https://example.com/missing.xml'),
    'https://example.com/nested.xml': index('https://example.com/posts.xml', 'https://example.com/pages.xml'),
    'https://example.com/pages.xml': urlset('https://example.com/', 'https://example.com/about'),
    'https://example.com/posts.xml': urlset('https://example.com/blog/a', 'https://example.com/about'),
  };
  const fetchText = async (u) => {
    if (!(u in files)) throw new Error('HTTP 404');
    return files[u];
  };
  const r = await crawlSitemaps(['https://example.com/sitemap.xml'], fetchText);
  assert.deepEqual(r.urls.map((u) => u.loc), ['https://example.com/', 'https://example.com/about', 'https://example.com/blog/a']);
  assert.equal(r.urls[2].sitemap, 'https://example.com/posts.xml');
  assert.equal(r.sitemaps.length, 5, 'pages.xml is fetched once');
  assert.deepEqual(r.sitemaps.find((s) => s.url.endsWith('missing.xml')).errors, ['HTTP 404']);
  assert.equal(r.truncated, false);

  const capped = await crawlSitemaps(['https://example.com/sitemap.xml'], fetchText, { maxUrls: 2 });
  assert.equal(capped.urls.length, 2);
  assert.equal(capped.truncated, true);
  const few = await crawlSitemaps(['https://example.com/sitemap.xml'], fetchText, { maxSitemaps: 2 });
  assert.equal(few.sitemaps.length, 2);
  assert.equal(few.skippedSitemaps, 2);
});

test('compileFilter: substrings, globs and exclusions', () => {
  const urls = ['https://example.com/', 'https://example.com/blog/a', 'https://example.com/blog/tag/x', 'https://example.com/en/blog/b', 'https://example.com/about'];
  const run = (spec) => urls.filter(compileFilter(spec));
  assert.deepEqual(run(''), urls);
  assert.deepEqual(run('/blog/'), ['https://example.com/blog/a', 'https://example.com/blog/tag/x', 'https://example.com/en/blog/b']);
  assert.deepEqual(run('/blog/*'), ['https://example.com/blog/a', 'https://example.com/blog/tag/x'], 'a glob starting with / is anchored to the path');
  assert.deepEqual(run('/blog/ !*/tag/*'), ['https://example.com/blog/a', 'https://example.com/en/blog/b']);
  assert.deepEqual(run('/about, BLOG/A'), ['https://example.com/blog/a', 'https://example.com/about']);
  assert.deepEqual(run('*://example.com/'), ['https://example.com/']);
});

test('selectUrls applies the filter then the cap', () => {
  const urls = Array.from({ length: 10 }, (_, i) => ({ loc: `https://example.com/${i % 2 ? 'blog' : 'page'}/${i}` }));
  const r = selectUrls(urls, { filter: '/blog/', max: 3 });
  assert.equal(r.matched, 5);
  assert.deepEqual(r.selected.map((u) => u.loc), ['https://example.com/blog/1', 'https://example.com/blog/3', 'https://example.com/blog/5']);
});

test('defaultSitemaps prefers robots.txt entries', () => {
  assert.deepEqual(defaultSitemaps('https://example.com', []), ['https://example.com/sitemap.xml']);
  assert.deepEqual(defaultSitemaps('https://example.com', ['https://example.com/a.xml', 'https://example.com/a.xml']), ['https://example.com/a.xml']);
});
