// Sitemap parsing (XML <urlset> / <sitemapindex>, plain-text URL lists), nested sitemap crawling
// and URL filtering. Pure functions; fetching is injected so the scan page and Node tests share it.
// https://www.sitemaps.org/protocol.html
// https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text of the first direct child `<prefix:tag>`; other namespaces (image:loc, video:…) don't match. */
function childText(block, prefix, tag) {
  const name = escapeRe(prefix + tag);
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i'));
  return m ? decodeXml(m[1]) : null;
}

function entries(xml, prefix, tag) {
  const name = escapeRe(prefix + tag);
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'gi');
  return [...xml.matchAll(re)].map((m) => ({ loc: childText(m[1], prefix, 'loc'), lastmod: childText(m[1], prefix, 'lastmod') }));
}

const isHttpUrl = (s) => /^https?:\/\/[^\s/]+/i.test(s || '');

/**
 * @returns {{type: 'urlset'|'sitemapindex'|'text'|'unknown', urls: {loc: string, lastmod: string|null}[],
 *   sitemaps: {loc: string, lastmod: string|null}[], errors: string[]}}
 */
export function parseSitemap(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const xml = src.replace(/<!--[\s\S]*?-->/g, '');
  const errors = [];
  const root = xml.match(/<([\w-]+:)?(urlset|sitemapindex)[\s>]/i);
  if (!root) {
    const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every(isHttpUrl)) return { type: 'text', urls: lines.map((loc) => ({ loc, lastmod: null })), sitemaps: [], errors };
    errors.push(/<html[\s>]/i.test(src) ? 'Not a sitemap (got an HTML page).' : 'Not a sitemap: no <urlset> or <sitemapindex> element.');
    return { type: 'unknown', urls: [], sitemaps: [], errors };
  }
  const prefix = root[1] || '';
  const type = root[2].toLowerCase();
  const items = entries(xml, prefix, type === 'urlset' ? 'url' : 'sitemap');
  const valid = items.filter((i) => isHttpUrl(i.loc));
  const bad = items.length - valid.length;
  if (bad) errors.push(`${bad} entr${bad === 1 ? 'y has' : 'ies have'} a missing or non-absolute <loc>.`);
  if (type === 'urlset' && items.length > 50000) errors.push(`${items.length} URLs; a sitemap may list at most 50,000.`);
  return type === 'urlset' ? { type, urls: valid, sitemaps: [], errors } : { type, urls: [], sitemaps: valid, errors };
}

/**
 * Follows sitemap indexes breadth-first and collects unique page URLs.
 * @param {string[]} roots  sitemap URLs to start from
 * @param {(url: string) => Promise<string>} fetchText  rejects on HTTP/network errors
 */
export async function crawlSitemaps(roots, fetchText, { maxSitemaps = 50, maxUrls = 50000 } = {}) {
  const queue = roots.map((url) => ({ url, parent: null }));
  const seenSitemaps = new Set();
  const seenUrls = new Set();
  const sitemaps = [];
  const urls = [];
  let truncated = false;
  while (queue.length && sitemaps.length < maxSitemaps && !truncated) {
    const { url, parent } = queue.shift();
    if (seenSitemaps.has(url)) continue;
    seenSitemaps.add(url);
    const entry = { url, parent, type: null, urls: 0, sitemaps: 0, errors: [] };
    sitemaps.push(entry);
    let parsed;
    try {
      parsed = parseSitemap(await fetchText(url));
    } catch (e) {
      entry.errors.push(e.message || String(e));
      continue;
    }
    entry.type = parsed.type;
    entry.errors.push(...parsed.errors);
    entry.sitemaps = parsed.sitemaps.length;
    for (const s of parsed.sitemaps) queue.push({ url: s.loc, parent: url });
    for (const u of parsed.urls) {
      if (seenUrls.has(u.loc)) continue;
      if (urls.length >= maxUrls) {
        truncated = true;
        break;
      }
      seenUrls.add(u.loc);
      urls.push({ ...u, sitemap: url });
      entry.urls++;
    }
  }
  const skippedSitemaps = new Set(queue.map((q) => q.url).filter((u) => !seenSitemaps.has(u))).size;
  return { urls, sitemaps, truncated, skippedSitemaps };
}

/** Sitemaps listed in robots.txt, else the conventional /sitemap.xml. */
export function defaultSitemaps(origin, robotsSitemaps = []) {
  return robotsSitemaps.length ? [...new Set(robotsSitemaps)] : [`${origin}/sitemap.xml`];
}

// Builds a URL predicate from a filter string. Space/comma separated terms; a URL passes when it
// matches any include term (or there are none) and no "!"-prefixed exclude term. Plain terms are
// case-insensitive substrings ("/blog/"); terms with "*" are globs matched against the whole URL
// or its path ("/blog/*", "*://*.example.com/*", "!*/tag/*").
export function compileFilter(spec) {
  const include = [];
  const exclude = [];
  for (const term of String(spec ?? '').split(/[\s,]+/).filter(Boolean)) {
    const negate = term.startsWith('!');
    const t = negate ? term.slice(1) : term;
    if (t) (negate ? exclude : include).push(termMatcher(t));
  }
  return (url) => (!include.length || include.some((m) => m(url))) && !exclude.some((m) => m(url));
}

function termMatcher(term) {
  if (!term.includes('*')) {
    const needle = term.toLowerCase();
    return (url) => url.toLowerCase().includes(needle);
  }
  const re = new RegExp(`^${term.split('*').map(escapeRe).join('.*')}$`, 'i');
  return (url) => {
    let path = url;
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      /* not a URL; match the raw string */
    }
    return re.test(url) || re.test(path);
  };
}

/** Applies the filter and page cap. */
export function selectUrls(urls, { filter = '', max = 100 } = {}) {
  const pass = compileFilter(filter);
  const matched = urls.filter((u) => pass(typeof u === 'string' ? u : u.loc));
  return { matched: matched.length, selected: matched.slice(0, Math.max(0, max)) };
}
