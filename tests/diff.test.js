import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage } from '../src/lib/validator.js';
import { analyzeSeo } from '../src/lib/seo.js';
import { buildSnapshot, diffSnapshots, diffJson, addSnapshot, snapshotKey, timeAgo, counterpartUrl, normalizeHost, aliasOrigin, normalizeJson } from '../src/lib/diff.js';

const URL_ = 'https://example.com/blog/post';
const meta = (name, content, attr = 'name') => ({ name, content, attr, inHead: true });
const linkTag = (rel, href, extra = {}) => ({ rel, href, absHref: new URL(href, URL_).href, inHead: true, ...extra });

const article = (overrides = {}) => ({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', '@id': 'https://example.com/#org', name: 'Example', url: 'https://example.com/', logo: 'https://example.com/logo.png' },
    { '@type': 'Article', headline: 'How HEIs work', datePublished: '2026-02-01', image: 'https://example.com/a.jpg', author: { '@type': 'Person', name: 'Jane Doe', url: 'https://example.com/jane' }, ...overrides },
  ],
});

function page({ title = 'How home equity investments work | Example', headings, anchors, ld = article(), metas = [] } = {}) {
  return {
    url: URL_,
    title,
    blocks: [{ text: JSON.stringify(ld), location: 'head' }],
    markupItems: [],
    seo: {
      titles: [{ text: title, inHead: true }],
      lang: 'en',
      charset: 'UTF-8',
      doctype: 'html',
      metas: [
        meta('description', 'A clear, plain-English guide to how home equity investments work, what they cost, and when they make sense for homeowners.'),
        meta('viewport', 'width=device-width, initial-scale=1'),
        meta('og:title', 'How HEIs work', 'property'),
        meta('og:image', 'https://example.com/og.png', 'property'),
        ...metas,
      ],
      linkTags: [linkTag('canonical', URL_), linkTag('icon', '/favicon.ico')],
      headings: headings ?? [
        { level: 1, text: 'How home equity investments work', hidden: false },
        { level: 2, text: 'Costs', hidden: false },
      ],
      images: { total: 1, items: [{ src: 'https://example.com/a.jpg', alt: 'A house', width: 800, height: 600, hasDims: true }] },
      anchors: anchors ?? { total: 2, items: [
        { href: 'https://example.com/', raw: '/', text: 'Home', rel: '' },
        { href: 'https://other.com/', raw: 'https://other.com/', text: 'Other', rel: '' },
      ] },
      wordCount: 900,
    },
  };
}

const snap = (p, at = 1000) => buildSnapshot(p, analyzePage(p), analyzeSeo(p.seo, p.url), at);

test('identical pages have no changes', () => {
  const d = diffSnapshots(snap(page()), snap(page(), 2000));
  assert.equal(d.total, 0);
  assert.deepEqual(d.fields, []);
  assert.deepEqual(d.blocks, []);
});

test('snapshot keeps the summary fields, headings, counts and normalized JSON-LD', () => {
  const s = snap(page({ metas: [meta('twitter:card', 'summary')] }));
  assert.equal(s.fields.title, 'How home equity investments work | Example');
  assert.equal(s.fields.canonical, URL_);
  assert.equal(s.fields['og:title'], 'How HEIs work');
  assert.equal(s.fields['twitter:card'], 'summary');
  assert.deepEqual(s.headings.map((h) => h.level), [1, 2]);
  assert.equal(s.metrics.links, 2);
  assert.equal(s.blocks.length, 1);
  assert.deepEqual(Object.keys(s.blocks[0].data), ['@context', '@graph'], 'keys are sorted');
  assert.ok(JSON.stringify(s).length < 5000, 'snapshot stays small');
});

test('changed title, headings, links and JSON-LD properties are reported', () => {
  const before = snap(page());
  const after = snap(
    page({
      title: 'Home equity investments, explained | Example',
      headings: [{ level: 1, text: 'How home equity investments work' }, { level: 2, text: 'Fees' }, { level: 2, text: 'FAQ' }],
      anchors: { total: 1, items: [{ href: 'https://example.com/', raw: '/', text: 'Home', rel: '' }] },
      ld: article({ headline: 'HEIs, explained', dateModified: '2026-03-01', image: undefined }),
    }),
  );
  const d = diffSnapshots(before, after);
  assert.deepEqual(d.fields.map((f) => [f.label, f.before, f.after]), [['Title', 'How home equity investments work | Example', 'Home equity investments, explained | Example']]);
  assert.deepEqual(d.headings.added.map((h) => h.text), ['Fees', 'FAQ']);
  assert.deepEqual(d.headings.removed.map((h) => h.text), ['Costs']);
  assert.deepEqual(d.metrics.find((m) => m.key === 'links'), { key: 'links', label: 'Links', before: 2, after: 1, delta: -1 });
  assert.equal(d.blocks.length, 1);
  assert.deepEqual(
    d.blocks[0].changes.map((c) => `${c.kind} ${c.path}`),
    ['added @graph[Article].dateModified', 'changed @graph[Article].headline', 'removed @graph[Article].image'],
  );
  assert.ok(d.total >= 7);
});

test('issues fixed and introduced are listed', () => {
  // The "before" page's Article has no image (a Google error); the "after" page fixes that but drops the H1.
  const before = snap(page({ ld: article({ image: undefined }) }));
  const after = snap(page({ headings: [{ level: 2, text: 'Costs' }] }));
  const d = diffSnapshots(before, after);
  assert.ok(d.issues.fixed.some((i) => /image/.test(i.message)), JSON.stringify(d.issues.fixed));
  assert.ok(d.issues.introduced.some((i) => i.area === 'headings' && /h1/i.test(i.message)), JSON.stringify(d.issues.introduced));
});

test('JSON-LD blocks are paired by type, so an added block does not shift the others', () => {
  const p = page();
  const extra = { ...p, blocks: [{ text: JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [] }), location: 'head' }, ...p.blocks] };
  const d = diffSnapshots(snap(p), snap(extra));
  assert.deepEqual(d.blocks.map((b) => [b.status, b.types.join()]), [['added', 'BreadcrumbList']]);
});

test('a block that stops parsing is reported', () => {
  const p = page();
  const broken = { ...p, blocks: [{ text: '{"@context": "https://schema.org", "@type": "Article",, }', location: 'head' }] };
  const d = diffSnapshots(snap(p), snap(broken));
  assert.equal(d.blocks.length, 1);
  assert.ok(d.issues.introduced.some((i) => /Invalid JSON/.test(i.message)));
});

test('diffJson: nested objects, arrays by index, @graph nodes by @id/@type', () => {
  assert.deepEqual(diffJson({ a: { b: 1 } }, { a: { b: 2 } }), [{ path: 'a.b', kind: 'changed', before: 1, after: 2 }]);
  assert.deepEqual(diffJson({ a: [1, 2] }, { a: [1, 3, 4] }), [
    { path: 'a[1]', kind: 'changed', before: 2, after: 3 },
    { path: 'a[2]', kind: 'added', after: 4 },
  ]);
  const g = (nodes) => ({ '@graph': nodes });
  assert.deepEqual(
    diffJson(g([{ '@id': '#a', name: 'A' }, { '@type': 'Thing', name: 'T' }]), g([{ '@type': 'Thing', name: 'T2' }, { '@id': '#a', name: 'A' }])),
    [{ path: '@graph[Thing].name', kind: 'changed', before: 'T', after: 'T2' }],
  );
  assert.deepEqual(diffJson('x', null), [{ path: '(root)', kind: 'changed', before: 'x', after: null }]);
  assert.deepEqual(normalizeJson({ b: 1, a: [{ d: 1, c: 2 }] }), { a: [{ c: 2, d: 1 }], b: 1 });
});

test('aliasOrigin makes staging and live compare on content', () => {
  const live = snap(page());
  const staging = aliasOrigin(live, 'https://example.com', 'https://example.webflow.io');
  assert.equal(staging.fields.canonical, 'https://example.webflow.io/blog/post');
  assert.ok(diffSnapshots(live, staging).total > 0);
  assert.equal(diffSnapshots(live, aliasOrigin(staging, 'https://example.webflow.io', 'https://example.com')).total, 0);
});

test('addSnapshot keeps the last N per URL and evicts the oldest overall when over budget', () => {
  const mk = (url, takenAt, pad = 0) => ({ url, takenAt, fields: { pad: 'x'.repeat(pad) } });
  let store = {};
  for (let i = 1; i <= 7; i++) store = addSnapshot(store, mk('https://a.com/p#frag', i));
  assert.deepEqual(Object.keys(store), ['https://a.com/p']);
  assert.deepEqual(store['https://a.com/p'].map((s) => s.takenAt), [7, 6, 5, 4, 3]);

  store = addSnapshot({}, mk('https://a.com/', 1, 400));
  store = addSnapshot(store, mk('https://b.com/', 2, 400));
  store = addSnapshot(store, mk('https://c.com/', 3, 400), { maxBytes: 1000 });
  assert.deepEqual(Object.keys(store).sort(), ['https://b.com/', 'https://c.com/'], 'oldest snapshot (a.com) evicted');
  // The new snapshot is kept even if it alone is over budget.
  store = addSnapshot(store, mk('https://d.com/', 4, 2000), { maxBytes: 1000 });
  assert.deepEqual(Object.keys(store), ['https://d.com/']);
  assert.equal(snapshotKey('https://a.com/x?y=1#z'), 'https://a.com/x?y=1');
});

test('timeAgo', () => {
  const now = 10_000_000;
  assert.equal(timeAgo(now - 5_000, now), 'just now');
  assert.equal(timeAgo(now - 3 * 60_000, now), '3 min ago');
  assert.equal(timeAgo(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(timeAgo(now - 26 * 3_600_000, now), '1 day ago');
  assert.equal(timeAgo(now - 72 * 3_600_000, now), '3 days ago');
});

test('counterpartUrl: configured host pairs work in both directions', () => {
  const pairs = [{ staging: 'point-staging.webflow.io', production: 'www.point.com' }];
  assert.deepEqual(counterpartUrl('https://point-staging.webflow.io/heloc?x=1#top', pairs), { url: 'https://www.point.com/heloc?x=1', reason: 'mapping', role: 'staging' });
  assert.deepEqual(counterpartUrl('https://www.point.com/heloc', pairs), { url: 'https://point-staging.webflow.io/heloc', reason: 'mapping', role: 'production' });
  assert.equal(counterpartUrl('https://other.com/heloc', pairs), null);
});

test('counterpartUrl: a webflow.io page falls back to its canonical host', () => {
  assert.deepEqual(counterpartUrl('https://point.webflow.io/blog/a', [], { canonical: 'https://www.point.com/blog/a' }), { url: 'https://www.point.com/blog/a', reason: 'canonical', role: 'staging' });
  assert.deepEqual(counterpartUrl('https://point.webflow.io/blog/a', [], { canonical: 'https://point.webflow.io/blog/a', ogUrl: 'https://www.point.com/x' }).url, 'https://www.point.com/blog/a');
  assert.equal(counterpartUrl('https://point.webflow.io/blog/a', []), null);
});

test('normalizeHost accepts URLs and bare hosts', () => {
  assert.equal(normalizeHost('https://Point.webflow.io/path'), 'point.webflow.io');
  assert.equal(normalizeHost(' www.point.com '), 'www.point.com');
  assert.equal(normalizeHost('localhost:8080'), 'localhost:8080');
  assert.equal(normalizeHost(''), '');
});
