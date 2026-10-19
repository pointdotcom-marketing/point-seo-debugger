import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSeo } from '../src/lib/seo.js';
import { parseRobots, robotsAllows } from '../src/lib/robots.js';

const URL_ = 'https://example.com/blog/post';
const meta = (name, content, attr = 'name') => ({ name, content, attr, inHead: true });
const linkTag = (rel, href, extra = {}) => ({ rel, href, absHref: new URL(href, URL_).href, inHead: true, ...extra });

function page(overrides = {}) {
  return {
    titles: [{ text: 'How home equity investments work | Example', inHead: true }],
    lang: 'en',
    charset: 'UTF-8',
    doctype: 'html',
    metas: [
      meta('description', 'A clear, plain-English guide to how home equity investments work, what they cost, and when they make sense for homeowners.'),
      meta('viewport', 'width=device-width, initial-scale=1'),
      meta('og:title', 'How HEIs work', 'property'),
      meta('og:description', 'A guide.', 'property'),
      meta('og:image', 'https://example.com/og.png', 'property'),
      meta('og:url', URL_, 'property'),
      meta('og:type', 'article', 'property'),
      meta('twitter:card', 'summary_large_image'),
    ],
    linkTags: [linkTag('canonical', URL_), linkTag('icon', '/favicon.ico')],
    headings: [
      { level: 1, text: 'How home equity investments work', hidden: false },
      { level: 2, text: 'Costs', hidden: false },
    ],
    images: { total: 1, items: [{ src: 'https://example.com/a.jpg', alt: 'A house', width: 800, height: 600, hasDims: true }] },
    anchors: { total: 2, items: [
      { href: 'https://example.com/', raw: '/', text: 'Home', rel: '' },
      { href: 'https://other.com/', raw: 'https://other.com/', text: 'Other', rel: 'nofollow' },
    ] },
    wordCount: 900,
    ...overrides,
  };
}

const msgs = (r, area) => r.checks.filter((c) => !area || c.area === area).map((c) => `${c.severity}: ${c.message}`).join('\n');

test('a well-formed page has no errors or warnings', () => {
  const r = analyzeSeo(page(), URL_);
  assert.equal(r.counts.errors, 0, msgs(r));
  assert.equal(r.counts.warnings, 0, msgs(r));
  assert.equal(r.summary.indexable, true);
  assert.deepEqual(r.links.stats, { total: 2, unique: 2, internal: 1, external: 1, nofollow: 1, other: 0 });
});

test('noindex via meta or X-Robots-Tag makes the page not indexable', () => {
  let r = analyzeSeo(page({ metas: [...page().metas, meta('robots', 'noindex, follow')] }), URL_);
  assert.equal(r.summary.indexable, false);
  assert.match(msgs(r, 'robots'), /noindex \(meta robots\)/);
  r = analyzeSeo(page(), URL_, { http: { status: 200, xRobotsTag: 'googlebot: noindex' } });
  assert.equal(r.summary.indexable, false);
  assert.match(msgs(r, 'robots'), /X-Robots-Tag/);
});

test('robots.txt block is reported', () => {
  const r = analyzeSeo(page(), URL_, { robotsTxt: { allowed: false, rule: 'Disallow: /blog' } });
  assert.equal(r.summary.indexable, false);
  assert.match(msgs(r, 'robots'), /robots\.txt blocks Googlebot/);
});

test('title and description length use pixel widths when available', () => {
  const long = 'A very long title that goes on and on well beyond what Google will display in results';
  const r = analyzeSeo(page({ titles: [{ text: long, inHead: true }] }), URL_, { measure: (t) => t.length * 10 });
  assert.match(msgs(r, 'title'), /truncated.*px/);
  assert.ok(r.summary.titlePx > 580);
});

test('missing title, description, canonical, h1, lang, viewport', () => {
  const r = analyzeSeo(page({ titles: [], metas: [], linkTags: [], headings: [], lang: null }), URL_);
  assert.match(msgs(r, 'title'), /Missing <title>/);
  assert.match(msgs(r, 'description'), /Missing meta description/);
  assert.match(msgs(r, 'canonical'), /No rel="canonical"/);
  assert.match(msgs(r, 'headings'), /No <h1>/);
  assert.match(msgs(r, 'lang'), /Missing <html lang>/);
  assert.match(msgs(r, 'mobile'), /No meta viewport/);
});

test('canonical pointing elsewhere, multiple canonicals, and canonical in body', () => {
  let r = analyzeSeo(page({ linkTags: [linkTag('canonical', 'https://example.com/other')] }), URL_);
  assert.match(msgs(r, 'canonical'), /different URL/);
  r = analyzeSeo(page({ linkTags: [linkTag('canonical', URL_), linkTag('canonical', 'https://example.com/x', { inHead: false })] }), URL_);
  assert.match(msgs(r, 'canonical'), /2 different canonical URLs/);
  assert.match(msgs(r, 'canonical'), /outside <head>/);
  r = analyzeSeo(page({ linkTags: [linkTag('canonical', `${URL_}/`)] }), URL_);
  assert.doesNotMatch(msgs(r, 'canonical'), /different URL/, 'trailing slash is the same URL');
});

test('heading level skips and empty headings', () => {
  const r = analyzeSeo(page({ headings: [{ level: 1, text: 'T' }, { level: 3, text: 'Skipped' }, { level: 2, text: '' }] }), URL_);
  assert.match(msgs(r, 'headings'), /skip 1 time/);
  assert.match(msgs(r, 'headings'), /1 empty heading/);
  assert.equal(r.headings.items[1].skip, true);
});

test('image alt checks ignore tracking pixels', () => {
  const r = analyzeSeo(
    page({
      images: {
        total: 4,
        items: [
          { src: 'a.jpg', alt: null, width: 400, height: 300, hasDims: true },
          { src: 'b.jpg', alt: '', width: 400, height: 300, hasDims: true },
          { src: 'c.jpg', alt: 'IMG_2041.jpg', width: 400, height: 300, hasDims: false },
          { src: 'px.gif', alt: null, width: 1, height: 1, hasDims: false },
        ],
      },
    }),
    URL_,
  );
  assert.equal(r.images.missingAlt, 1);
  assert.match(msgs(r, 'images'), /1 image is missing an alt/);
  assert.match(msgs(r, 'images'), /filename as alt/);
  assert.deepEqual(r.images.items[3].flags, ['tracking pixel']);
});

test('links: empty anchor text, staging hosts, http, javascript', () => {
  const r = analyzeSeo(
    page({
      anchors: {
        total: 4,
        items: [
          { href: 'https://example.com/a', raw: '/a', text: '', rel: '' },
          { href: 'https://example-site.webflow.io/b', raw: 'https://example-site.webflow.io/b', text: 'B', rel: '' },
          { href: 'http://example.com/c', raw: 'http://example.com/c', text: 'C', rel: '' },
          { href: 'javascript:void(0)', raw: 'javascript:void(0)', text: 'D', rel: '' },
        ],
      },
    }),
    URL_,
  );
  const m = msgs(r, 'links');
  assert.match(m, /no anchor text/);
  assert.match(m, /staging\/preview host \(e\.g\. example-site\.webflow\.io\)/);
  assert.match(m, /http:\/\/ on an https site/);
  assert.match(m, /javascript: link/);
});

test('hreflang validation', () => {
  const r = analyzeSeo(
    page({
      linkTags: [
        linkTag('canonical', URL_),
        linkTag('alternate', 'https://example.com/es/blog/post', { hreflang: 'es' }),
        linkTag('alternate', '/fr/blog/post', { hreflang: 'fr_FR' }),
      ],
    }),
    URL_,
  );
  const m = msgs(r, 'hreflang');
  assert.match(m, /Invalid hreflang code: fr_FR/);
  assert.match(m, /must be absolute/);
  assert.match(m, /self-reference/);
  assert.match(m, /No x-default/);
});

test('social: missing og:image, relative og:url, og via name=', () => {
  const r = analyzeSeo(page({ metas: [meta('description', 'x'.repeat(80)), meta('viewport', 'width=device-width'), meta('og:title', 'T'), meta('og:url', '/blog/post', 'property')] }), URL_);
  const m = msgs(r, 'social');
  assert.match(m, /Missing og:image/);
  assert.match(m, /og:url must be an absolute URL/);
  assert.match(m, /name= instead of property=/);
});

test('robots.txt: most specific group, longest match, allow wins ties, wildcards', () => {
  const txt = `
User-agent: *
Disallow: /

User-agent: Googlebot
Disallow: /private/
Allow: /private/public-page
Disallow: /*.pdf$
Allow: /tie
Disallow: /tie

Sitemap: https://example.com/sitemap.xml
`;
  const p = parseRobots(txt);
  assert.deepEqual(p.sitemaps, ['https://example.com/sitemap.xml']);
  assert.equal(robotsAllows(txt, 'https://example.com/blog').allowed, true, 'googlebot group overrides *');
  assert.equal(robotsAllows(txt, 'https://example.com/private/x').allowed, false);
  assert.equal(robotsAllows(txt, 'https://example.com/private/public-page').allowed, true);
  assert.equal(robotsAllows(txt, 'https://example.com/files/a.pdf').allowed, false);
  assert.equal(robotsAllows(txt, 'https://example.com/files/a.pdf?x=1').allowed, true, '$ anchors the end');
  assert.equal(robotsAllows(txt, 'https://example.com/tie').allowed, true);
  assert.equal(robotsAllows(txt, 'https://example.com/anything', 'bingbot').allowed, false);
  assert.equal(robotsAllows('', 'https://example.com/').allowed, true);
});
