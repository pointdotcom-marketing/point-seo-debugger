import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePage, buildSiteReport, canonicalKind, csvRows, ROW_FILTERS } from '../src/lib/site-report.js';

const meta = (name, content) => ({ name, content, attr: 'name', inHead: true });

/** A collected page shaped like content.js output. */
function page(url, { title = 'How home equity investments work | Example', description = 'A plain-English guide to how home equity investments work, what they cost, and when they make sense.', canonical = url, robots = null, h1 = 1, imgNoAlt = 0, jsonld = null } = {}) {
  return {
    url,
    title,
    blocks: jsonld ? [{ text: JSON.stringify(jsonld), location: 'head' }] : [],
    markupItems: [],
    seo: {
      titles: title ? [{ text: title, inHead: true }] : [],
      lang: 'en',
      charset: 'UTF-8',
      doctype: 'html',
      metas: [meta('viewport', 'width=device-width'), ...(description ? [meta('description', description)] : []), ...(robots ? [meta('robots', robots)] : [])],
      linkTags: canonical ? [{ rel: 'canonical', href: canonical, absHref: canonical, inHead: true }] : [],
      headings: Array.from({ length: h1 }, () => ({ level: 1, text: 'Heading', hidden: false })),
      images: { total: imgNoAlt, items: Array.from({ length: imgNoAlt }, (_, i) => ({ src: `/i${i}.png`, alt: null, width: 100, height: 100, hasDims: true })) },
      anchors: { total: 0, items: [] },
      wordCount: 300,
    },
  };
}
const ok = (url) => ({ status: 200, redirected: false, finalUrl: url, xRobotsTag: null });
const allowed = { allowed: true, rule: null };

test('canonicalKind', () => {
  assert.equal(canonicalKind(null, 'https://a.com/x'), 'missing');
  assert.equal(canonicalKind('https://A.com/x/', 'https://a.com/x#top'), 'self');
  assert.equal(canonicalKind('https://a.com/y', 'https://a.com/x'), 'other');
  assert.equal(canonicalKind('https://a.com/y', 'https://a.com/x', 'https://a.com/y'), 'self', 'final URL after a redirect counts');
});

test('summarizePage: a clean page', () => {
  const url = 'https://example.com/guide';
  const r = summarizePage({
    url,
    page: page(url, { jsonld: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' }, { '@type': 'ListItem', position: 2, name: 'Guide' }] } }),
    http: ok(url),
    robotsTxt: allowed,
  });
  assert.equal(r.status, 200);
  assert.equal(r.indexable, true);
  assert.equal(r.canonicalKind, 'self');
  assert.equal(r.h1Count, 1);
  assert.equal(r.titleLength, 42);
  assert.deepEqual(r.types, ['BreadcrumbList']);
  assert.equal(r.rich.valid, 1);
  assert.equal(r.redirectTo, null);
});

test('summarizePage: noindex header, robots block, redirect and load failure', () => {
  const url = 'https://example.com/p';
  const noindex = summarizePage({ url, page: page(url), http: { ...ok(url), xRobotsTag: 'noindex' }, robotsTxt: allowed });
  assert.equal(noindex.noindex, true);
  assert.equal(noindex.indexable, false);
  assert.deepEqual(noindex.notIndexable, ['noindex']);

  const blocked = summarizePage({ url, page: page(url), http: ok(url), robotsTxt: { allowed: false, rule: 'Disallow: /p' } });
  assert.equal(blocked.indexable, false);
  assert.deepEqual(blocked.notIndexable, ['blocked by robots.txt']);

  const final = 'https://example.com/new';
  const redirected = summarizePage({ url, page: page(final), http: { status: 200, redirected: true, finalUrl: final }, robotsTxt: allowed });
  assert.equal(redirected.redirectTo, final);
  assert.equal(redirected.canonicalKind, 'self');
  assert.ok(redirected.issues.some((i) => /redirects to/.test(i.message)));

  const failed = summarizePage({ url, page: null, http: { error: 'timed out' }, error: 'Tab load timed out' });
  assert.equal(failed.loaded, false);
  assert.equal(failed.indexable, false);
  assert.equal(failed.errors, 1);
  assert.match(failed.issues[0].message, /Tab load timed out/);
});

test('buildSiteReport: duplicates, canonicals, non-200s, noindex, robots and redirects', () => {
  const u = (p) => `https://example.com${p}`;
  const rows = [
    summarizePage({ url: u('/'), page: page(u('/'), { canonical: u('/home') }), http: ok(u('/')), robotsTxt: allowed }),
    summarizePage({ url: u('/guides/'), page: page(u('/guides/')), http: ok(u('/guides/')), robotsTxt: allowed }),
    summarizePage({ url: u('/unique'), page: page(u('/unique'), { title: 'Something else entirely here', description: '' }), http: ok(u('/unique')), robotsTxt: allowed }),
    summarizePage({ url: u('/private'), page: page(u('/private'), { title: 'Private', robots: 'noindex' }), http: ok(u('/private')), robotsTxt: allowed }),
    summarizePage({ url: u('/blocked/x'), page: page(u('/blocked/x'), { title: 'Blocked' }), http: ok(u('/blocked/x')), robotsTxt: { allowed: false, rule: 'Disallow: /blocked/' } }),
    summarizePage({ url: u('/gone'), page: page(u('/gone'), { title: '' }), http: { status: 404, redirected: false, finalUrl: u('/gone') }, robotsTxt: allowed }),
    summarizePage({ url: u('/old'), page: page(u('/guides/')), http: { status: 200, redirected: true, finalUrl: u('/guides/') }, robotsTxt: allowed }),
  ];
  const report = buildSiteReport(rows);
  const f = Object.fromEntries(report.findings.map((x) => [x.id, x]));

  assert.equal(f['duplicate-titles'].count, 1);
  assert.deepEqual(f['duplicate-titles'].groups[0].urls, [u('/'), u('/guides/')], 'redirecting URLs are not counted as duplicates');
  assert.equal(f['duplicate-descriptions'].groups[0].urls.length, 4);
  assert.deepEqual(f['canonical-elsewhere'].items, [{ url: u('/'), detail: `→ ${u('/home')}` }]);
  assert.deepEqual(f['non-200'].items, [{ url: u('/gone'), detail: 'HTTP 404' }]);
  assert.deepEqual(f.noindex.items.map((i) => i.url), [u('/private')]);
  assert.deepEqual(f['robots-blocked'].items, [{ url: u('/blocked/x'), detail: 'Disallow: /blocked/' }]);
  assert.deepEqual(f.redirects.items.map((i) => i.url), [u('/old')]);
  assert.deepEqual(f['missing-descriptions'].items.map((i) => i.url), [u('/unique')]);
  assert.equal(f['missing-titles'].count, 0, 'the 404 page is reported as non-200, not as a missing title');

  assert.equal(report.totals.pages, 7);
  assert.equal(report.totals.indexable, 3);

  const filter = (id) => rows.filter(ROW_FILTERS.find(([k]) => k === id)[2]).map((r) => r.url);
  assert.deepEqual(filter('not-indexable'), [u('/private'), u('/blocked/x'), u('/gone'), u('/old')]);
  assert.deepEqual(filter('missing-description'), [u('/unique')]);
  assert.deepEqual(filter('canonical-other'), [u('/')]);
});

test('csvRows has a header and one row per page', () => {
  const url = 'https://example.com/a';
  const rows = csvRows([summarizePage({ url, page: page(url, { imgNoAlt: 2 }), http: ok(url), robotsTxt: allowed })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, rows[1].length);
  const rec = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]));
  assert.equal(rec.status, '200');
  assert.equal(rec.indexable, 'yes');
  assert.equal(rec['images missing alt'], 2);
  assert.match(rec.issues, /\[warning\] 2 images are missing an alt/);
});
