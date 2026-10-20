// Server HTML vs rendered DOM. Extracts the SEO-relevant head data (titles, meta tags, link[rel],
// JSON-LD) from the HTML the server sent, and compares it with what content.js collected after
// JavaScript ran, so each item can be labelled "in HTML", "added/changed/removed by JavaScript".
// Pure functions over a Document (DOMParser in the side panel, tests/mini-dom.js in unit tests).

export const PROVENANCE_LABEL = {
  html: 'in HTML',
  added: 'added by JavaScript',
  changed: 'changed by JavaScript',
  removed: 'removed by JavaScript',
};

const JS_NOTE = 'Google renders JavaScript in a later pass, and other crawlers and AI bots may never see it.';

const lower = (s) => String(s ?? '').toLowerCase();
const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const kids = (el) => Array.from(el.children || []);

function resolve(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * Pulls titles, meta tags, link[rel] tags and JSON-LD out of a parsed server response, in the same
 * shape content.js reports for the live page.
 * @param {Document} doc  e.g. new DOMParser().parseFromString(html, 'text/html')
 * @param {string} url    the response URL, for resolving relative hrefs
 */
export function extractRawHtml(doc, url) {
  const out = { titles: [], metas: [], linkTags: [], blocks: [] };
  const found = [];
  // DOMParser documents have scripting off, so <noscript> contents parse as real tags. A browser
  // with JavaScript treats them as text, so skip them to keep both sides comparable.
  const walk = (el, inHead) => {
    const tag = lower(el.tagName);
    if (tag === 'svg' || tag === 'noscript' || tag === 'template') return;
    found.push([el, tag, inHead]);
    for (const c of kids(el)) walk(c, inHead || tag === 'head');
  };
  if (doc.documentElement) walk(doc.documentElement, false);

  const baseEl = found.find(([el, tag]) => tag === 'base' && el.getAttribute('href'));
  const base = baseEl ? resolve(baseEl[0].getAttribute('href'), url) : url;

  for (const [el, tag, inHead] of found) {
    const a = (n) => el.getAttribute(n);
    const has = (n) => el.hasAttribute(n);
    if (tag === 'title') out.titles.push({ text: el.textContent, inHead });
    else if (tag === 'meta') {
      out.metas.push({
        name: (a('name') || a('property') || a('http-equiv') || a('itemprop') || '').trim(),
        attr: has('property') ? 'property' : has('http-equiv') ? 'http-equiv' : has('name') ? 'name' : has('itemprop') ? 'itemprop' : has('charset') ? 'charset' : '',
        content: a('content') ?? a('charset') ?? '',
        inHead,
      });
    } else if (tag === 'link' && has('rel')) {
      out.linkTags.push({ rel: lower(a('rel')).trim(), href: a('href') ?? '', absHref: has('href') ? resolve(a('href'), base) : '', hreflang: a('hreflang'), inHead });
    } else if (tag === 'script' && lower(a('type')).trim() === 'application/ld+json') {
      out.blocks.push({ text: el.textContent, location: inHead ? 'head' : 'body' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Whitespace/key-order-insensitive identity for a JSON-LD block; invalid JSON falls back to its text. */
export function blockKey(text) {
  try {
    return `json:${JSON.stringify(sortKeys(JSON.parse(text)))}`;
  } catch {
    return `text:${squash(text)}`;
  }
}

function blockTypes(text) {
  try {
    const data = JSON.parse(text);
    const nodes = (Array.isArray(data) ? data : [data]).flatMap((n) => (n && Array.isArray(n['@graph']) ? n['@graph'] : [n]));
    return [...new Set(nodes.flatMap((n) => (n && n['@type'] ? [].concat(n['@type']) : [])).map(String))].sort();
  } catch {
    return [];
  }
}

const metaList = (metas, name) => (metas || []).filter((m) => lower(m.name) === name).map((m) => squash(m.content));
const firstTitle = (titles) => {
  const t = (titles || []).find((x) => x.inHead !== false);
  return t ? squash(t.text) : null;
};
const relLinks = (links, rel) => (links || []).filter((l) => l.rel.split(/\s+/).includes(rel));
const directives = (values) => [...new Set(values.flatMap((v) => v.split(',')).map((d) => lower(d).trim()).filter(Boolean))].sort();
const isNoindex = (d) => d.includes('noindex') || d.includes('none');

function status(raw, rendered, same) {
  if (raw == null && rendered == null) return null;
  if (raw == null) return 'added';
  if (rendered == null) return 'removed';
  return same(raw, rendered) ? 'html' : 'changed';
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compares server HTML with the rendered page.
 * @param {{titles, metas, linkTags, blocks}} raw       from extractRawHtml
 * @param {{titles, metas, linkTags, blocks}} rendered  from content.js (page.seo plus page.blocks)
 * @returns {{
 *   items: {key: string, label: string, area: string, status: string, raw: any, rendered: any}[],
 *   byKey: Record<string, object>,
 *   blocks: {status: string, raw: string|null}[],   // one per rendered JSON-LD block, same order
 *   removedBlocks: {text: string, types: string[]}[],
 *   noindex: {raw: boolean, rendered: boolean},
 *   checks: {area: string, severity: string, message: string}[],
 * }}
 */
export function compareRawRendered(raw, rendered) {
  const items = [];
  const add = (key, label, area, r, x, same = (a, b) => a === b) => {
    const s = status(r, x, same);
    if (s) items.push({ key, label, area, status: s, raw: r, rendered: x });
  };

  add('title', 'Title', 'title', firstTitle(raw.titles), firstTitle(rendered.titles));
  add('description', 'Meta description', 'description', metaList(raw.metas, 'description')[0] ?? null, metaList(rendered.metas, 'description')[0] ?? null);
  const canon = (side) => relLinks(side.linkTags, 'canonical')[0]?.absHref ?? null;
  add('canonical', 'Canonical', 'canonical', canon(raw), canon(rendered));
  for (const name of ['robots', 'googlebot']) {
    const d = (side) => {
      const v = metaList(side.metas, name);
      return v.length ? directives(v) : null;
    };
    add(name, `Meta ${name}`, 'robots', d(raw), d(rendered), sameList);
  }

  // Open Graph / X tags can repeat (several og:image), so each name compares as a list.
  const social = (side) => {
    const m = new Map();
    for (const t of side.metas || []) {
      const n = lower(t.name);
      if (n.startsWith('og:') || n.startsWith('twitter:')) m.set(n, [...(m.get(n) || []), squash(t.content)]);
    }
    return m;
  };
  const rawSocial = social(raw);
  const renderedSocial = social(rendered);
  for (const n of new Set([...rawSocial.keys(), ...renderedSocial.keys()])) {
    add(n, n, 'social', rawSocial.get(n) ?? null, renderedSocial.get(n) ?? null, sameList);
  }

  const hreflang = (side) => new Map(relLinks(side.linkTags, 'alternate').filter((l) => l.hreflang).map((l) => [lower(l.hreflang), l.absHref]));
  const rawHl = hreflang(raw);
  const renderedHl = hreflang(rendered);
  for (const lang of new Set([...rawHl.keys(), ...renderedHl.keys()])) {
    add(`hreflang:${lang}`, `hreflang ${lang}`, 'hreflang', rawHl.get(lang) ?? null, renderedHl.get(lang) ?? null);
  }

  // JSON-LD: exact matches first; a leftover rendered block with the same @type as a leftover raw
  // block counts as changed (e.g. a tag manager rewriting dateModified), the rest as added/removed.
  const pool = (raw.blocks || []).map((b) => ({ text: b.text ?? '', key: blockKey(b.text ?? ''), types: blockTypes(b.text ?? ''), used: false }));
  const blocks = (rendered.blocks || []).map((b) => {
    const key = blockKey(b.text ?? '');
    const hit = pool.find((p) => !p.used && p.key === key);
    if (hit) hit.used = true;
    return { status: hit ? 'html' : null, raw: hit ? hit.text : null, types: blockTypes(b.text ?? '') };
  });
  for (const b of blocks.filter((x) => !x.status)) {
    const sig = b.types.join(',');
    const hit = sig && pool.find((p) => !p.used && p.types.join(',') === sig);
    if (hit) hit.used = true;
    b.status = hit ? 'changed' : 'added';
    b.raw = hit ? hit.text : null;
  }
  const removedBlocks = pool.filter((p) => !p.used).map((p) => ({ text: p.text, types: p.types }));

  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const robotsDirectives = (side) => directives([...metaList(side.metas, 'robots'), ...metaList(side.metas, 'googlebot')]);
  const noindex = { raw: isNoindex(robotsDirectives(raw)), rendered: isNoindex(robotsDirectives(rendered)) };

  return { items, byKey, blocks: blocks.map(({ status: s, raw: r }) => ({ status: s, raw: r })), removedBlocks, noindex, checks: renderingChecks(items, blocks, removedBlocks, noindex) };
}

function renderingChecks(items, blocks, removedBlocks, noindex) {
  const checks = [];
  const add = (area, severity, message) => checks.push({ area, severity, message });
  const get = (key) => items.find((i) => i.key === key);
  const show = (v) => (Array.isArray(v) ? v.join(', ') : v);

  // Google uses the most restrictive robots rule it sees, and may not render a noindex page at all.
  if (noindex.raw && !noindex.rendered) {
    add('robots', 'error', 'The server HTML has noindex, and JavaScript removes it. Google uses the most restrictive rule and may skip rendering a noindex page, so treat this page as not indexable.');
  } else if (!noindex.raw && noindex.rendered) {
    add('robots', 'error', `noindex is only added by JavaScript. Crawlers that don't render JavaScript will index this page, and Google may index the server HTML before rendering. Put the robots tag in the HTML.`);
  } else {
    for (const key of ['robots', 'googlebot']) {
      const i = get(key);
      if (!i || i.status === 'html') continue;
      if (i.status === 'added') add('robots', 'warning', `Meta ${key} (${show(i.rendered)}) is only added by JavaScript. ${JS_NOTE}`);
      else if (i.status === 'changed') add('robots', 'warning', `JavaScript changes meta ${key} from "${show(i.raw)}" to "${show(i.rendered)}". Google uses the most restrictive of the two.`);
      else add('robots', 'warning', `JavaScript removes meta ${key} ("${show(i.raw)}"). Google still sees it in the server HTML.`);
    }
  }

  const single = [
    ['title', 'title', 'The title'],
    ['description', 'description', 'The meta description'],
    ['canonical', 'canonical', 'The canonical link'],
  ];
  for (const [key, area, what] of single) {
    const i = get(key);
    if (!i || i.status === 'html') continue;
    if (i.status === 'added') add(area, 'warning', `${what} only exists after JavaScript runs. ${JS_NOTE}`);
    else if (i.status === 'removed') add(area, 'warning', `${what} is in the server HTML ("${i.raw}") but JavaScript removes it. Crawlers that don't render JavaScript still use it.`);
    else add(area, key === 'canonical' ? 'warning' : 'info', `JavaScript changes ${what.slice(4)} from "${i.raw}" to "${i.rendered}". Crawlers that don't render JavaScript see the original${key === 'canonical' ? ', so Google gets conflicting canonical signals' : ''}.`);
  }

  const added = blocks.filter((b) => b.status === 'added');
  const changed = blocks.filter((b) => b.status === 'changed');
  const typesOf = (list) => {
    const t = [...new Set(list.flatMap((b) => b.types))];
    return t.length ? ` (${t.join(', ')})` : '';
  };
  if (added.length) add('structured data', 'warning', `${added.length} JSON-LD block${added.length === 1 ? ' is' : 's are'} only added by JavaScript${typesOf(added)}. ${JS_NOTE}`);
  if (changed.length) add('structured data', 'info', `JavaScript changes ${changed.length} JSON-LD block${changed.length === 1 ? '' : 's'}${typesOf(changed)} after load. Crawlers that don't render JavaScript see the server version.`);
  if (removedBlocks.length) add('structured data', 'info', `JavaScript removes ${removedBlocks.length} JSON-LD block${removedBlocks.length === 1 ? '' : 's'} from the server HTML${typesOf(removedBlocks)}.`);

  // Facebook, LinkedIn, X and Slack fetch the HTML without running scripts.
  const socialJs = items.filter((i) => i.area === 'social' && (i.status === 'added' || i.status === 'changed'));
  if (socialJs.length) {
    const names = socialJs.map((i) => i.key);
    add('social', 'warning', `${names.length} social tag${names.length === 1 ? ' is' : 's are'} added or changed by JavaScript (${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}). Facebook, LinkedIn, X and Slack don't run JavaScript, so link previews use the server HTML.`);
  }
  const hlJs = items.filter((i) => i.area === 'hreflang' && i.status !== 'html');
  if (hlJs.length) add('hreflang', 'info', `${hlJs.length} hreflang link${hlJs.length === 1 ? ' differs' : 's differ'} between the server HTML and the rendered page. Put hreflang in the HTML so every crawler sees the same set.`);
  return checks;
}
