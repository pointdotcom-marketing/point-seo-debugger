import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage, parseBlock } from '../src/lib/validator.js';
import '../src/lib/markup.js';
import { parseHtml } from './mini-dom.js';

const { extractMicrodata, extractRdfa } = globalThis.SeoLensMarkup;

const run = (...objs) => analyzePage({ url: 'https://example.com/page', blocks: objs.map((o) => ({ text: typeof o === 'string' ? o : JSON.stringify(o), location: 'head' })) });
const codes = (r) => r.blocks.flatMap((b) => b.issues.map((i) => i.code));
const feature = (r, id) => r.features.find((f) => f.featureId === id);
const messages = (f) => f.issues.map((i) => `${i.severity}: ${i.message}`).join('\n');

test('clean Organization + WebSite has no errors or warnings', () => {
  const r = run(
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Example Co',
      url: 'https://example.com/',
      logo: 'https://example.com/logo.png',
      sameAs: ['https://www.linkedin.com/company/example'],
    },
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Example', url: 'https://example.com/' },
  );
  assert.equal(r.counts.errors, 0, JSON.stringify(r, null, 1));
  assert.equal(r.counts.warnings, 0);
  assert.equal(feature(r, 'organization').status, 'valid');
  assert.equal(feature(r, 'site-name').status, 'valid');
});

test('invalid JSON is reported with a location and still checked via repair', () => {
  const r = run('{\n  "@context": "https://schema.org",\n  "@type": "Organisation",\n  "name": "X",\n}');
  const issue = r.blocks[0].issues.find((i) => i.code === 'invalid-json');
  assert.ok(issue, 'expected invalid-json');
  assert.match(issue.message, /line \d+, column \d+/);
  assert.match(issue.message, /trailing commas/);
  const typo = r.blocks[0].issues.find((i) => i.code === 'unknown-type');
  assert.match(typo.message, /Did you mean "Organization"/);
});

test('raw newlines and curly quotes are repaired', () => {
  const r = parseBlock('{"@type": “Thing”, "name": "line one\nline two"}');
  assert.ok(r.error);
  assert.equal(r.data.name, 'line one\nline two');
  assert.equal(r.data['@type'], 'Thing');
});

test('missing @context and @type are errors', () => {
  const r = run({ name: 'No context' });
  assert.deepEqual(codes(r).sort(), ['missing-context', 'missing-type']);
});

test('unknown property suggests the right casing', () => {
  const r = run({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Hi', DatePublished: '2026-01-01' });
  const issue = r.blocks[0].issues.find((i) => i.code === 'unknown-property');
  assert.match(issue.message, /Did you mean "datePublished"/);
});

test('property not defined for the type is a warning', () => {
  const r = run({ '@context': 'https://schema.org', '@type': 'Person', name: 'A', headline: 'nope' });
  assert.ok(codes(r).includes('property-domain'));
});

test('value format checks: dates, URLs, enums, placeholders, untyped objects', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: '{{wf {"path":"name"} }}',
    image: '/img/product.jpg',
    releaseDate: 'March 3, 2026',
    manufacturer: { name: 'Acme' },
    offers: { '@type': 'Offer', price: '10.00', priceCurrency: 'USD', availability: 'In stock' },
  });
  const c = codes(r);
  for (const expected of ['placeholder', 'relative-url', 'invalid-date', 'missing-nested-type', 'invalid-enum']) {
    assert.ok(c.includes(expected), `expected ${expected} in ${c}`);
  }
});

test('enum values accept short names and http/https URLs', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Widget',
    image: 'https://example.com/w.jpg',
    offers: [
      { '@type': 'Offer', price: 5, priceCurrency: 'USD', availability: 'InStock' },
      { '@type': 'Offer', price: 5, priceCurrency: 'USD', availability: 'http://schema.org/OutOfStock' },
    ],
  });
  assert.ok(!codes(r).includes('invalid-enum'), codes(r).join());
});

test('merchant listing: bad price, bad currency, AggregateOffer, zero price', () => {
  const base = { '@context': 'https://schema.org', '@type': 'Product', name: 'Widget', image: 'https://example.com/w.jpg' };
  let f = feature(run({ ...base, offers: { '@type': 'Offer', price: '$1,299', priceCurrency: 'US$' } }), 'merchant-listing');
  assert.equal(f.status, 'invalid');
  assert.match(messages(f), /plain number/);
  assert.match(messages(f), /ISO 4217/);

  f = feature(run({ ...base, offers: { '@type': 'AggregateOffer', lowPrice: 10, priceCurrency: 'USD' } }), 'merchant-listing');
  assert.match(messages(f), /not an AggregateOffer/);

  f = feature(run({ ...base, offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' } }), 'merchant-listing');
  assert.match(messages(f), /greater than 0/);
});

test('product snippet needs one of review / aggregateRating / offers', () => {
  const f = feature(run({ '@context': 'https://schema.org', '@type': 'Product', name: 'Widget' }), 'product-snippet');
  assert.equal(f.status, 'invalid');
  assert.match(messages(f), /"review" or "aggregateRating" or "offers"/);
});

test('breadcrumb: missing item on a middle crumb and bad positions', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
      { '@type': 'ListItem', position: 3, name: 'Blog' },
      { '@type': 'ListItem', position: 4, name: 'Post' },
    ],
  });
  const f = feature(r, 'breadcrumb');
  assert.equal(f.status, 'invalid');
  assert.match(messages(f), /Only the last crumb may omit it/);
  assert.match(messages(f), /positions should be 1, 2, 3/);
});

test('breadcrumb nested in WebPage.breadcrumb is detected', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.com/' },
        { '@type': 'ListItem', position: 2, name: 'Here' },
      ],
    },
  });
  assert.equal(feature(r, 'breadcrumb').status, 'valid');
});

test('FAQPage is reported as deprecated (no longer shown since May 2026)', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }],
  });
  const f = feature(r, 'faq');
  assert.equal(f.status, 'deprecated');
  assert.match(f.statusNote, /May 7, 2026/);
});

test('@graph with @id references resolves across nodes and blocks', () => {
  const r = run(
    {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Organization', '@id': 'https://example.com/#org', name: 'Example', url: 'https://example.com/', logo: 'https://example.com/l.png' },
        {
          '@type': 'BlogPosting',
          headline: 'Hello',
          datePublished: '2026-01-02T08:00:00-08:00',
          dateModified: '2026-01-03T08:00:00-08:00',
          image: 'https://example.com/hero.jpg',
          author: { '@id': 'https://example.com/#jane' },
          publisher: { '@id': 'https://example.com/#org' },
        },
      ],
    },
    { '@context': 'https://schema.org', '@type': 'Person', '@id': 'https://example.com/#jane', name: 'Jane Doe', url: 'https://example.com/jane' },
  );
  const article = feature(r, 'article');
  assert.equal(article.status, 'valid', messages(article));
  assert.equal(r.counts.errors, 0);
});

test('article author as a string and "By" prefix are flagged', () => {
  let f = feature(run({ '@context': 'https://schema.org', '@type': 'Article', headline: 'H', author: 'Jane' }), 'article');
  assert.match(messages(f), /plain string/);
  f = feature(run({ '@context': 'https://schema.org', '@type': 'Article', headline: 'H', author: { '@type': 'Person', name: 'By Jane', url: 'https://x.com' } }), 'article');
  assert.match(messages(f), /just the name/);
});

test('date ordering and timezone recommendations', () => {
  const f = feature(
    run({ '@context': 'https://schema.org', '@type': 'Article', headline: 'H', datePublished: '2026-02-01', dateModified: '2026-01-01T00:00:00Z' }),
    'article',
  );
  assert.match(messages(f), /no time or timezone/);
  assert.match(messages(f), /is before "datePublished"/);
});

test('event: online-only location is rejected', () => {
  const f = feature(
    run({ '@context': 'https://schema.org', '@type': 'Event', name: 'Webinar', startDate: '2026-11-01T10:00:00-07:00', location: { '@type': 'VirtualLocation', url: 'https://zoom.us/x' } }),
    'event',
  );
  assert.equal(f.status, 'invalid');
  assert.match(messages(f), /physical Place/);
});

test('self-serving ratings on an Organization are flagged', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Example',
    url: 'https://example.com/',
    logo: 'https://example.com/l.png',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.8', reviewCount: '1200' },
  });
  const f = feature(r, 'review-snippet');
  assert.match(messages(f), /self-serving/);
});

test('ratings: out of range, fraction and percent forms', () => {
  const mk = (ratingValue) =>
    feature(run({ '@context': 'https://schema.org', '@type': 'Product', name: 'W', aggregateRating: { '@type': 'AggregateRating', ratingValue, ratingCount: 3 } }), 'review-snippet');
  assert.match(messages(mk(7)), /outside the 1–5 scale/);
  assert.doesNotMatch(messages(mk('60%')), /ratingValue/);
  assert.doesNotMatch(messages(mk('6 / 10')), /ratingValue/);
  assert.equal(mk(4.5).status, 'valid');
});

test('LocalBusiness subtype (FinancialService) uses local business rules, not Organization', () => {
  const r = run({
    '@context': 'https://schema.org',
    '@type': 'FinancialService',
    name: 'Example Lending',
    address: { '@type': 'PostalAddress', streetAddress: '1 Main St', addressLocality: 'Palo Alto', addressRegion: 'CA', postalCode: '94301', addressCountry: 'US' },
  });
  assert.ok(feature(r, 'local-business'));
  assert.ok(!feature(r, 'organization'));
});

test('sitelinks search box SearchAction gets an informational note', () => {
  const f = feature(
    run({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Ex', url: 'https://example.com/', potentialAction: { '@type': 'SearchAction', target: 'https://example.com/?q={q}', 'query-input': 'required name=q' } }),
    'site-name',
  );
  assert.match(messages(f), /retired the sitelinks search box/);
});

test('no structured data produces a page-level note', () => {
  const r = analyzePage({ url: 'https://example.com', blocks: [] });
  assert.deepEqual(r.pageIssues.map((i) => i.code), ['no-structured-data']);
});

// ---------------------------------------------------------------------------
// Microdata and RDFa, converted by markup.js and checked like JSON-LD.

const BASE = 'https://example.com/shop/page';
const resolve = (u) => new URL(u, BASE).href;
const markup = (html) => {
  const doc = parseHtml(html);
  return [...extractMicrodata(doc, resolve), ...extractRdfa(doc, resolve)];
};
const runMarkup = (html, blocks = []) => analyzePage({ url: BASE, blocks, markupItems: markup(html) });

test('Microdata Product with offers converts to JSON-LD and passes the merchant listing rules', () => {
  const html = `<html><head><title>x</title></head><body>
    <div itemscope itemtype="https://schema.org/Product" itemid="#widget">
      <h1 itemprop="name">Widget   Pro</h1>
      <img itemprop="image" src="/img/widget.jpg" alt="Widget">
      <p itemprop="description">A very good widget.</p>
      <meta itemprop="sku" content="W-1">
      <div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Acme</span></div>
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <span itemprop="price" content="1299.00">$1,299</span>
        <meta itemprop="priceCurrency" content="USD">
        <link itemprop="availability" href="https://schema.org/InStock">In stock
        <a itemprop="url" href="/widget">Buy</a>
      </div>
    </div></body></html>`;
  const [item] = markup(html);
  assert.equal(item.format, 'microdata');
  assert.equal(item.location, 'body');
  assert.deepEqual(item.data, {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': 'https://example.com/shop/page#widget',
    name: 'Widget Pro',
    image: 'https://example.com/img/widget.jpg',
    description: 'A very good widget.',
    sku: 'W-1',
    brand: { '@type': 'Brand', name: 'Acme' },
    offers: { '@type': 'Offer', price: '1299.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: 'https://example.com/widget' },
  });

  const r = runMarkup(html);
  assert.equal(r.counts.errors, 0, JSON.stringify(r.blocks[0].issues) + JSON.stringify(r.features, null, 1));
  assert.equal(r.counts.microdata, 1);
  assert.equal(r.blocks[0].label, 'Microdata item 1');
  assert.equal(r.blocks[0].format, 'microdata');
  assert.deepEqual(r.blocks[0].types, ['Product']);
  const f = feature(r, 'merchant-listing');
  assert.equal(f.blockLabel, 'Microdata item 1');
  assert.notEqual(f.status, 'invalid', messages(f));
  assert.equal(feature(r, 'product-snippet').status, 'warnings', messages(feature(r, 'product-snippet')));
  // A bad price in Microdata gets the same error as in JSON-LD.
  const bad = runMarkup(html.replace('content="1299.00"', 'content="$1,299"'));
  assert.match(messages(feature(bad, 'merchant-listing')), /plain number/);
});

test('Microdata: nested itemprop items, multi-token itemprop, time and separate top-level items', () => {
  const r = runMarkup(`<article itemscope itemtype="http://schema.org/BlogPosting">
      <h1 itemprop="headline name">Hello</h1>
      <time itemprop="datePublished" datetime="2026-02-01T09:00:00-08:00">Feb 1</time>
      <meta itemprop="dateModified" content="2026-03-01T09:00:00-08:00">
      <img itemprop="image" src="https://example.com/a.jpg">
      <div itemprop="author" itemscope itemtype="https://schema.org/Person">
        <a itemprop="url" href="/authors/jane"><span itemprop="name">Jane Doe</span></a>
      </div>
      <div itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Not the author</span></div>
      <span itemprop="authr">typo</span>
    </article>`);
  assert.equal(r.blocks.length, 2, 'the non-property itemscope is its own top-level item');
  const post = r.blocks[0].data;
  assert.equal(post.headline, 'Hello');
  assert.equal(post.name, 'Hello');
  assert.equal(post.datePublished, '2026-02-01T09:00:00-08:00');
  assert.deepEqual(post.author, { '@type': 'Person', url: 'https://example.com/authors/jane', name: 'Jane Doe' });
  assert.ok(!JSON.stringify(post).includes('Not the author'), 'nested item properties stay out of the parent');
  assert.equal(r.blocks[1].label, 'Microdata item 2');
  assert.deepEqual(r.blocks[1].types, ['Organization']);
  const typo = r.blocks[0].issues.find((i) => i.code === 'unknown-property');
  assert.match(typo.message, /"authr" is not a schema.org property/);
  assert.equal(feature(r, 'article').status, 'valid', messages(feature(r, 'article')));
});

test('Microdata: itemref pulls in properties from elsewhere on the page', () => {
  const r = runMarkup(`<body>
      <div itemscope itemtype="https://schema.org/Product" itemref="product-name product-offer missing-id">
        <img itemprop="image" src="https://example.com/w.jpg">
      </div>
      <h1 id="product-name" itemprop="name">Widget</h1>
      <section id="product-offer">
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="10.00"><meta itemprop="priceCurrency" content="USD">
        </div>
      </section>
    </body>`);
  assert.equal(r.blocks.length, 1, 'itemref targets with itemprop are not top-level items');
  const p = r.blocks[0].data;
  assert.equal(p.name, 'Widget');
  assert.deepEqual(p.offers, { '@type': 'Offer', price: '10.00', priceCurrency: 'USD' });
  assert.ok(r.blocks[0].issues.some((i) => i.code === 'itemref-missing' && /missing-id/.test(i.message)));
  assert.notEqual(feature(r, 'product-snippet').status, 'invalid', messages(feature(r, 'product-snippet')));
});

test('Microdata: itemscope without itemtype is a missing-type error', () => {
  const r = runMarkup('<div itemscope><span itemprop="name">x</span></div>');
  const issue = r.blocks[0].issues.find((i) => i.code === 'missing-type');
  assert.match(issue.message, /itemscope has no itemtype/);
});

test('RDFa BreadcrumbList (Google\'s example markup) is checked like JSON-LD', () => {
  const html = `<html><head><meta property="og:title" content="Not an item"></head><body>
    <ol vocab="https://schema.org/" typeof="BreadcrumbList">
      <li property="itemListElement" typeof="ListItem">
        <a property="item" typeof="WebPage" href="/books"><span property="name">Books</span></a>
        <meta property="position" content="1">
      </li>
      <li property="itemListElement" typeof="ListItem">
        <a property="item" typeof="WebPage" href="https://example.com/books/sciencefiction"><span property="name">Science Fiction</span></a>
        <meta property="position" content="2">
      </li>
      <li property="itemListElement" typeof="ListItem">
        <span property="name">Award Winners</span>
        <meta property="position" content="3">
      </li>
    </ol></body></html>`;
  const items = markup(html);
  assert.equal(items.length, 1, 'og: meta outside any typeof is ignored');
  assert.equal(items[0].format, 'rdfa');
  assert.deepEqual(items[0].data.itemListElement[0], {
    '@type': 'ListItem',
    item: { '@type': 'WebPage', '@id': 'https://example.com/books', name: 'Books' },
    position: '1',
  });
  const r = runMarkup(html);
  assert.equal(r.counts.rdfa, 1);
  assert.equal(r.blocks[0].label, 'RDFa item 1');
  const f = feature(r, 'breadcrumb');
  assert.equal(f.status, 'valid', messages(f));
  assert.equal(f.blockLabel, 'RDFa item 1');
  assert.equal(r.counts.errors + r.counts.warnings, 0, JSON.stringify(r.blocks[0].issues));

  // Drop the middle crumb's link and the breadcrumb rule catches it.
  const broken = runMarkup(html.replace(/<a property="item" typeof="WebPage" href="https:\/\/example.com\/books\/sciencefiction">(.*?)<\/a>/, '$1'));
  assert.match(messages(feature(broken, 'breadcrumb')), /Only the last crumb may omit it/);
});

test('RDFa: schema: prefix works without vocab; bare terms without vocab are flagged', () => {
  const prefixed = runMarkup('<div typeof="schema:Organization"><span property="schema:name">Acme</span><a property="schema:url" href="/">home</a><img property="schema:logo" src="/l.png"></div>');
  assert.deepEqual(prefixed.blocks[0].data, { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', url: 'https://example.com/', logo: 'https://example.com/l.png' });
  assert.equal(feature(prefixed, 'organization').status, 'valid', messages(feature(prefixed, 'organization')));

  const bare = runMarkup('<div typeof="Organization"><span property="name">Acme</span></div>');
  assert.ok(bare.blocks[0].issues.some((i) => i.code === 'rdfa-no-vocab' && /"Organization"/.test(i.message)));
});

test('JSON-LD blocks keep their indexes and labels when Microdata and RDFa are present', () => {
  const r = runMarkup(
    '<div vocab="https://schema.org/" typeof="Person"><span property="name">A</span></div><div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">B</span></div>',
    [{ text: JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Ex', url: 'https://example.com/' }), location: 'head' }],
  );
  assert.deepEqual(r.blocks.map((b) => [b.index, b.format, b.label]), [
    [0, 'jsonld', 'Block 1'],
    [1, 'microdata', 'Microdata item 1'],
    [2, 'rdfa', 'RDFa item 1'],
  ]);
  assert.equal(r.counts.blocks, 1);
  assert.equal(feature(r, 'site-name').blockLabel, 'Block 1');
  assert.deepEqual(r.pageIssues, []);
});
