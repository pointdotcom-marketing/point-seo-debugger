import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml } from './mini-dom.js';
import { extractRawHtml, compareRawRendered, blockKey } from '../src/lib/raw-html.js';

const URL_ = 'https://example.com/guides/hei';
const ORG = '{ "@context": "https://schema.org", "@type": "Organization", "name": "Example" }';

const HTML = `<!doctype html>
<html lang="en">
<head>
  <title>  HEI   guide | Example </title>
  <meta name="description" content="How home equity investments work.">
  <meta name="robots" content="index, follow">
  <meta property="og:title" content="HEI guide">
  <meta property="og:image" content="https://example.com/a.png">
  <meta property="og:image" content="https://example.com/b.png">
  <link rel="canonical" href="/guides/hei">
  <link rel="alternate" hreflang="en-US" href="/guides/hei">
  <noscript><link rel="canonical" href="/nojs"></noscript>
  <script type="application/ld+json">${ORG}</script>
</head>
<body>
  <svg><title>Icon</title></svg>
  <script type="application/ld+json">{ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [] }</script>
</body>
</html>`;

const raw = () => extractRawHtml(parseHtml(HTML), URL_);

test('extractRawHtml: titles, metas, links and JSON-LD from server HTML', () => {
  const r = raw();
  assert.deepEqual(r.titles, [{ text: '  HEI   guide | Example ', inHead: true }], 'svg <title> is skipped');
  assert.equal(r.metas.find((m) => m.name === 'description').content, 'How home equity investments work.');
  assert.equal(r.metas.filter((m) => m.name === 'og:image').length, 2);
  assert.equal(r.metas.find((m) => m.name === 'og:title').attr, 'property');
  const canon = r.linkTags.filter((l) => l.rel === 'canonical');
  assert.equal(canon.length, 1, '<noscript> contents are ignored');
  assert.equal(canon[0].absHref, 'https://example.com/guides/hei');
  assert.equal(r.linkTags.find((l) => l.hreflang).hreflang, 'en-US');
  assert.deepEqual(r.blocks.map((b) => b.location), ['head', 'body']);
});

test('extractRawHtml: <base href> resolves relative links', () => {
  const r = extractRawHtml(parseHtml('<html><head><base href="https://cdn.example.com/x/"><link rel="canonical" href="page"></head></html>'), URL_);
  assert.equal(r.linkTags.find((l) => l.rel === 'canonical').absHref, 'https://cdn.example.com/x/page');
});

test('blockKey ignores whitespace and key order', () => {
  assert.equal(blockKey('{"a":1,"b":[1,2]}'), blockKey('{\n  "b": [1, 2],\n  "a": 1\n}'));
  assert.notEqual(blockKey('{"b":[2,1]}'), blockKey('{"b":[1,2]}'));
  assert.equal(blockKey('{ "a": 1, }'), blockKey('{  "a": 1,\n}'), 'invalid JSON compares by squashed text');
});

test('identical server and rendered HTML: everything is "in HTML", no checks', () => {
  const c = compareRawRendered(raw(), raw());
  assert.equal(c.items.length, 7);
  assert.ok(c.items.every((i) => i.status === 'html'), JSON.stringify(c.items.filter((i) => i.status !== 'html')));
  assert.deepEqual(c.blocks.map((b) => b.status), ['html', 'html']);
  assert.deepEqual(c.removedBlocks, []);
  assert.deepEqual(c.checks, []);
});

test('reformatted JSON-LD still matches its server block', () => {
  const rendered = raw();
  rendered.blocks = [{ text: JSON.stringify(JSON.parse(ORG)), location: 'head' }, rendered.blocks[1]];
  assert.deepEqual(compareRawRendered(raw(), rendered).blocks.map((b) => b.status), ['html', 'html']);
});

test('items added, changed and removed by JavaScript', () => {
  const r = raw();
  const rendered = raw();
  rendered.titles = [{ text: 'New title', inHead: true }];
  rendered.metas = rendered.metas.filter((m) => m.name !== 'description' && m.name !== 'og:title');
  rendered.metas.push({ name: 'twitter:card', attr: 'name', content: 'summary_large_image', inHead: true });
  rendered.linkTags = rendered.linkTags.filter((l) => l.rel !== 'canonical');
  rendered.linkTags.push({ rel: 'alternate', hreflang: 'es', href: '/es', absHref: 'https://example.com/es', inHead: true });
  rendered.blocks = [
    r.blocks[0],
    { text: '{ "@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [{ "@type": "ListItem", "position": 1, "name": "Home" }] }' },
    { text: '{ "@context": "https://schema.org", "@type": "VideoObject", "name": "Intro" }' },
  ];
  const c = compareRawRendered(r, rendered);
  const s = (k) => c.byKey[k]?.status;
  assert.equal(s('title'), 'changed');
  assert.equal(c.byKey.title.raw, 'HEI guide | Example');
  assert.equal(s('description'), 'removed');
  assert.equal(s('canonical'), 'removed');
  assert.equal(s('og:title'), 'removed');
  assert.equal(s('og:image'), 'html');
  assert.equal(s('twitter:card'), 'added');
  assert.equal(s('hreflang:en-us'), 'html');
  assert.equal(s('hreflang:es'), 'added');
  assert.equal(s('robots'), 'html');
  assert.deepEqual(c.blocks.map((b) => b.status), ['html', 'changed', 'added']);
  assert.deepEqual(c.removedBlocks, []);

  const t = c.checks.map((x) => `${x.area}/${x.severity}: ${x.message}`).join('\n');
  assert.match(t, /title\/info: JavaScript changes title from "HEI guide \| Example" to "New title"/);
  assert.match(t, /description\/warning: The meta description is in the server HTML .* JavaScript removes it/);
  assert.match(t, /canonical\/warning: The canonical link is in the server HTML/);
  assert.match(t, /structured data\/warning: 1 JSON-LD block is only added by JavaScript \(VideoObject\)\. Google renders JavaScript in a later pass/);
  assert.match(t, /structured data\/info: JavaScript changes 1 JSON-LD block \(BreadcrumbList\)/);
  assert.match(t, /social\/warning: 1 social tag is added or changed by JavaScript \(twitter:card\)/);
  assert.match(t, /hreflang\/info: 1 hreflang link differs/);
  assert.doesNotMatch(t, /robots/);
});

test('important tags that only exist after JavaScript are warnings', () => {
  const empty = { titles: [], metas: [], linkTags: [], blocks: [] };
  const c = compareRawRendered(empty, raw());
  assert.equal(c.byKey.title.status, 'added');
  assert.equal(c.byKey.canonical.status, 'added');
  assert.deepEqual(c.blocks.map((b) => b.status), ['added', 'added']);
  const warn = c.checks.filter((x) => x.severity === 'warning').map((x) => x.area);
  for (const area of ['title', 'description', 'canonical', 'robots', 'structured data', 'social']) assert.ok(warn.includes(area), `${area} in ${warn}`);
  assert.match(c.checks.find((x) => x.area === 'structured data').message, /2 JSON-LD blocks are only added by JavaScript \(Organization, BreadcrumbList\)/);
});

test('JSON-LD removed by JavaScript is listed', () => {
  const rendered = raw();
  rendered.blocks = [rendered.blocks[1]];
  const c = compareRawRendered(raw(), rendered);
  assert.deepEqual(c.blocks.map((b) => b.status), ['html']);
  assert.deepEqual(c.removedBlocks.map((b) => b.types), [['Organization']]);
  assert.ok(c.checks.some((x) => x.area === 'structured data' && /removes 1 JSON-LD block .*\(Organization\)/.test(x.message)));
});

test('noindex in server HTML but removed by JavaScript is an error', () => {
  const r = raw();
  r.metas = r.metas.map((m) => (m.name === 'robots' ? { ...m, content: 'noindex' } : m));
  const c = compareRawRendered(r, raw());
  assert.deepEqual(c.noindex, { raw: true, rendered: false });
  assert.equal(c.byKey.robots.status, 'changed');
  const errors = c.checks.filter((x) => x.severity === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].area, 'robots');
  assert.match(errors[0].message, /most restrictive/);
});

test('noindex only added by JavaScript is an error', () => {
  const rendered = raw();
  rendered.metas = [...rendered.metas, { name: 'googlebot', attr: 'name', content: 'none', inHead: true }];
  const c = compareRawRendered(raw(), rendered);
  assert.deepEqual(c.noindex, { raw: false, rendered: true });
  assert.equal(c.byKey.googlebot.status, 'added');
  assert.deepEqual(c.checks.filter((x) => x.severity === 'error').map((x) => x.area), ['robots']);
});

test('non-noindex robots change is a warning', () => {
  const rendered = raw();
  rendered.metas = rendered.metas.map((m) => (m.name === 'robots' ? { ...m, content: 'index, nofollow' } : m));
  const c = compareRawRendered(raw(), rendered);
  assert.deepEqual(c.checks.map((x) => `${x.area}/${x.severity}`), ['robots/warning']);
  assert.match(c.checks[0].message, /from "follow, index" to "index, nofollow"/);
});
