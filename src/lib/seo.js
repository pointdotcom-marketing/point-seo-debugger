// On-page SEO checks: title/description, canonical, robots, language, headings, images, links,
// hreflang and social (Open Graph / X) tags. Pure functions over the data content.js collects.
import { isAbsoluteUrl } from './formats.js';

// Approximate Google desktop SERP truncation widths.
export const TITLE_MAX_PX = 580;
export const DESCRIPTION_MAX_PX = 920;
export const TITLE_FONT = '20px Arial';
export const DESCRIPTION_FONT = '14px Arial';

// Hosts that usually mean a link points at a staging/preview build instead of production.
const STAGING_HOST = /(^localhost$|^127\.|\.local$|\.test$|\.webflow\.io$|\.vercel\.app$|\.netlify\.app$|\.pages\.dev$|\.herokuapp\.com$|^staging\.|^stage\.|^dev\.|^preview\.)/i;
const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

const lower = (s) => String(s ?? '').toLowerCase();
const stripHash = (u) => String(u).split('#')[0];

function sameUrl(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const norm = (u) => `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '') || '/'}${u.search}`;
    return norm(x) === norm(y);
  } catch {
    return stripHash(a) === stripHash(b);
  }
}

function sameSite(a, b) {
  const base = (h) => h.replace(/^www\./, '').toLowerCase();
  return base(a) === base(b);
}

/** Returns contents of <meta> tags whose name/property matches (case-insensitive). */
function metaValues(metas, ...names) {
  const wanted = names.map(lower);
  return metas.filter((m) => wanted.includes(lower(m.name))).map((m) => m.content);
}

function parseRobotsDirectives(values) {
  const directives = new Set();
  for (const v of values) {
    for (const part of String(v).split(',')) {
      const d = part.trim().toLowerCase();
      if (d) directives.add(d);
    }
  }
  return [...directives];
}

/**
 * @param {object} seo         data from content.js
 * @param {string} url         page URL
 * @param {object} [opts]
 * @param {(text: string, font: string) => number} [opts.measure]  pixel width measurer (canvas in the browser)
 * @param {{status?: number, redirected?: boolean, finalUrl?: string, xRobotsTag?: string|null}} [opts.http]
 * @param {{allowed: boolean, rule: string|null}|null} [opts.robotsTxt]
 */
export function analyzeSeo(seo, url, { measure, http, robotsTxt } = {}) {
  const checks = [];
  const add = (area, severity, message) => checks.push({ area, severity, message });
  const page = new URL(url);
  const metas = seo.metas || [];
  const links = seo.linkTags || [];

  // --- Title -------------------------------------------------------------
  const titles = (seo.titles || []).filter((t) => t.inHead !== false);
  const title = (titles[0]?.text ?? '').replace(/\s+/g, ' ').trim();
  const titlePx = measure ? Math.round(measure(title, TITLE_FONT)) : null;
  if (!title) add('title', 'error', 'Missing <title>.');
  else {
    if (titles.length > 1) add('title', 'warning', `${titles.length} <title> tags; Google uses one. Remove the extras.`);
    if (title.length < 15) add('title', 'warning', `Title is short (${title.length} characters). Aim for a descriptive 30–60.`);
    if (titlePx ? titlePx > TITLE_MAX_PX : title.length > 60) {
      add('title', 'warning', `Title will likely be truncated in Google (${title.length} chars${titlePx ? `, ~${titlePx}px of ~${TITLE_MAX_PX}px` : ''}).`);
    }
  }

  // --- Description -------------------------------------------------------
  const descriptions = metaValues(metas, 'description');
  const description = (descriptions[0] ?? '').replace(/\s+/g, ' ').trim();
  const descriptionPx = measure ? Math.round(measure(description, DESCRIPTION_FONT)) : null;
  if (!description) add('description', 'warning', 'Missing meta description. Google will pick a snippet from the page text.');
  else {
    if (descriptions.length > 1) add('description', 'warning', `${descriptions.length} meta descriptions; keep one.`);
    if (description.length < 50) add('description', 'warning', `Description is short (${description.length} characters). Aim for 120–160.`);
    if (descriptionPx ? descriptionPx > DESCRIPTION_MAX_PX : description.length > 160) {
      add('description', 'info', `Description may be truncated (${description.length} chars${descriptionPx ? `, ~${descriptionPx}px of ~${DESCRIPTION_MAX_PX}px` : ''}).`);
    }
    if (title && description.toLowerCase() === title.toLowerCase()) add('description', 'warning', 'Description is identical to the title.');
  }

  // --- Canonical ---------------------------------------------------------
  const canonicals = links.filter((l) => l.rel.split(/\s+/).includes('canonical'));
  const canonical = canonicals[0]?.absHref || null;
  if (!canonicals.length) add('canonical', 'warning', 'No rel="canonical". Add a self-referencing canonical to avoid duplicate-URL issues.');
  else {
    const distinct = new Set(canonicals.map((c) => c.absHref));
    if (distinct.size > 1) add('canonical', 'error', `${distinct.size} different canonical URLs; Google may ignore all of them.`);
    if (canonicals.some((c) => !c.inHead)) add('canonical', 'error', 'A canonical link is outside <head>; Google ignores it there.');
    if (canonicals.some((c) => c.href && !/^https?:\/\//i.test(c.href))) add('canonical', 'warning', `Canonical is relative ("${canonicals[0].href}"); use an absolute URL.`);
    if (canonical && !sameUrl(canonical, url)) add('canonical', 'warning', `Canonical points to a different URL: ${canonical}. This page asks not to be indexed itself.`);
    if (canonical && page.protocol === 'https:' && canonical.startsWith('http:')) add('canonical', 'warning', 'Canonical uses http:// on an https page.');
  }

  // --- Indexability ------------------------------------------------------
  const robotsMeta = parseRobotsDirectives(metaValues(metas, 'robots'));
  const googlebotMeta = parseRobotsDirectives(metaValues(metas, 'googlebot'));
  const headerDirectives = parseRobotsDirectives(http?.xRobotsTag ? [http.xRobotsTag.replace(/^[a-z-]+:\s*(?=[a-z])/i, '')] : []);
  const all = [...new Set([...robotsMeta, ...googlebotMeta, ...headerDirectives])];
  const noindex = all.includes('noindex') || all.includes('none');
  const nofollow = all.includes('nofollow') || all.includes('none');
  if (noindex) {
    const where = [robotsMeta.some((d) => d === 'noindex' || d === 'none') && 'meta robots', googlebotMeta.some((d) => d === 'noindex' || d === 'none') && 'meta googlebot', headerDirectives.some((d) => d === 'noindex' || d === 'none') && 'X-Robots-Tag header'].filter(Boolean);
    add('robots', 'error', `Page is noindex (${where.join(', ')}). It won't appear in Google.`);
  }
  if (nofollow) add('robots', 'warning', 'nofollow: Google won\'t follow links on this page.');
  if (all.includes('nosnippet') || all.includes('max-snippet:0')) add('robots', 'warning', 'nosnippet / max-snippet:0 hides the text snippet in results.');
  const unavailable = all.find((d) => d.startsWith('unavailable_after:'));
  if (unavailable && Date.parse(unavailable.slice(18)) < Date.now()) add('robots', 'error', `unavailable_after date has passed (${unavailable.slice(18).trim()}).`);
  if (robotsTxt && !robotsTxt.allowed) add('robots', 'error', `robots.txt blocks Googlebot from this URL (${robotsTxt.rule}). Google can't crawl it, so it can't see noindex/canonical either.`);
  if (http?.status && http.status >= 400) add('http', 'error', `Server returned HTTP ${http.status}.`);
  else if (http?.status && http.status >= 300) add('http', 'warning', `Server returned HTTP ${http.status}.`);
  if (http?.redirected && http.finalUrl && !sameUrl(http.finalUrl, url)) add('http', 'info', `URL redirects to ${http.finalUrl}.`);

  // --- Document basics ---------------------------------------------------
  if (!seo.lang) add('lang', 'warning', 'Missing <html lang>.');
  else if (!HREFLANG_RE.test(seo.lang) || lower(seo.lang) === 'x-default') add('lang', 'warning', `<html lang="${seo.lang}"> isn't a valid language code.`);
  const viewport = metaValues(metas, 'viewport')[0];
  if (!viewport) add('mobile', 'warning', 'No meta viewport; the page won\'t render well on mobile.');
  else if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport)) add('mobile', 'info', 'Viewport disables zoom, which hurts accessibility.');
  if (seo.charset && lower(seo.charset) !== 'utf-8') add('document', 'info', `Character set is ${seo.charset}; UTF-8 is recommended.`);
  if (metaValues(metas, 'keywords').length) add('document', 'info', 'meta keywords is ignored by Google.');
  if (seo.doctype && lower(seo.doctype) !== 'html') add('document', 'info', `Doctype is "${seo.doctype}".`);
  if (!seo.doctype) add('document', 'warning', 'No <!doctype html>; the page renders in quirks mode.');

  // --- Headings ----------------------------------------------------------
  const headings = (seo.headings || []).map((h, i, all) => ({ ...h, skip: i > 0 && h.level > all[i - 1].level + 1 }));
  const counts = [1, 2, 3, 4, 5, 6].map((l) => headings.filter((h) => h.level === l).length);
  const h1s = headings.filter((h) => h.level === 1);
  if (!h1s.length) add('headings', 'warning', 'No <h1> on the page.');
  else if (h1s.length > 1) add('headings', 'info', `${h1s.length} <h1> elements. That's allowed, but one clear H1 is easier to read.`);
  if (h1s.length && h1s.every((h) => h.hidden)) add('headings', 'warning', 'The <h1> is hidden.');
  const empty = headings.filter((h) => !h.text).length;
  if (empty) add('headings', 'warning', `${empty} empty heading${empty === 1 ? '' : 's'}.`);
  const skips = headings.filter((h) => h.skip);
  if (skips.length) add('headings', 'info', `Heading levels skip ${skips.length} time${skips.length === 1 ? '' : 's'} (e.g. H2 → H4).`);

  // --- Images ------------------------------------------------------------
  const images = (seo.images?.items || []).map((i) => ({ ...i }));
  const imgTotal = seo.images?.total ?? images.length;
  const pixel = (i) => i.width > 0 && i.width <= 2 && i.height <= 2;
  const content = images.filter((i) => !pixel(i));
  const noAlt = content.filter((i) => i.alt === null);
  const emptyAlt = content.filter((i) => i.alt !== null && !i.alt.trim());
  const fileAlt = content.filter((i) => i.alt && /\.(jpe?g|png|gif|webp|avif|svg)$|^(img|dsc|image|photo)[-_ ]?\d+$/i.test(i.alt.trim()));
  const longAlt = content.filter((i) => i.alt && i.alt.length > 150);
  const noDims = content.filter((i) => !i.hasDims && !i.hidden);
  if (noAlt.length) add('images', 'warning', `${noAlt.length} image${noAlt.length === 1 ? ' is' : 's are'} missing an alt attribute.`);
  if (fileAlt.length) add('images', 'warning', `${fileAlt.length} image${fileAlt.length === 1 ? ' has' : 's have'} a filename as alt text.`);
  if (emptyAlt.length) add('images', 'info', `${emptyAlt.length} image${emptyAlt.length === 1 ? ' has' : 's have'} empty alt="" (fine for decorative images).`);
  if (longAlt.length) add('images', 'info', `${longAlt.length} image${longAlt.length === 1 ? ' has' : 's have'} alt text over 150 characters.`);
  if (noDims.length) add('images', 'info', `${noDims.length} visible image${noDims.length === 1 ? ' lacks' : 's lack'} width/height attributes, which can cause layout shift.`);
  for (const i of images) {
    i.flags = [];
    if (pixel(i)) i.flags.push('tracking pixel');
    else {
      if (i.alt === null) i.flags.push('no alt');
      else if (!i.alt.trim()) i.flags.push('empty alt');
      if (fileAlt.includes(i)) i.flags.push('filename alt');
      if (!i.hasDims) i.flags.push('no width/height');
    }
  }

  // --- Links -------------------------------------------------------------
  const linkItems = (seo.anchors?.items || []).map((l) => {
    let parsed = null;
    try {
      parsed = new URL(l.href);
    } catch {
      /* invalid href */
    }
    const kind = !parsed || !/^https?:$/.test(parsed.protocol) ? (lower(l.raw).startsWith('#') ? 'anchor' : parsed?.protocol.replace(':', '') || 'invalid') : sameSite(parsed.host, page.host) ? 'internal' : 'external';
    const rel = l.rel.split(/\s+/).filter(Boolean);
    const accessibleText = l.text || l.imgAlt || l.ariaLabel || '';
    return {
      ...l,
      kind,
      nofollow: rel.includes('nofollow'),
      sponsored: rel.includes('sponsored'),
      ugc: rel.includes('ugc'),
      emptyText: !accessibleText.trim(),
      staging: !!parsed && STAGING_HOST.test(parsed.hostname) && !STAGING_HOST.test(page.hostname),
      insecure: !!parsed && parsed.protocol === 'http:' && page.protocol === 'https:',
    };
  });
  const linkTotal = seo.anchors?.total ?? linkItems.length;
  const web = linkItems.filter((l) => l.kind === 'internal' || l.kind === 'external');
  const linkStats = {
    total: linkTotal,
    unique: new Set(web.map((l) => stripHash(l.href))).size,
    internal: linkItems.filter((l) => l.kind === 'internal').length,
    external: linkItems.filter((l) => l.kind === 'external').length,
    nofollow: linkItems.filter((l) => l.nofollow).length,
    other: linkItems.filter((l) => l.kind !== 'internal' && l.kind !== 'external').length,
  };
  const emptyLinks = web.filter((l) => l.emptyText && !l.hidden);
  if (emptyLinks.length) add('links', 'warning', `${emptyLinks.length} visible link${emptyLinks.length === 1 ? ' has' : 's have'} no anchor text, image alt, or aria-label.`);
  const staging = linkItems.filter((l) => l.staging);
  if (staging.length) add('links', 'warning', `${staging.length} link${staging.length === 1 ? ' points' : 's point'} to a staging/preview host (e.g. ${new URL(staging[0].href).host}).`);
  const insecure = linkItems.filter((l) => l.insecure && l.kind === 'internal');
  if (insecure.length) add('links', 'warning', `${insecure.length} internal link${insecure.length === 1 ? ' uses' : 's use'} http:// on an https site.`);
  const js = linkItems.filter((l) => l.kind === 'javascript');
  if (js.length) add('links', 'info', `${js.length} javascript: link${js.length === 1 ? '' : 's'}; Google can't follow these.`);
  if (linkTotal > linkItems.length) add('links', 'info', `Showing the first ${linkItems.length} of ${linkTotal} links.`);

  // --- Hreflang ----------------------------------------------------------
  const hreflang = links
    .filter((l) => l.rel.split(/\s+/).includes('alternate') && l.hreflang)
    .map((l) => ({ lang: l.hreflang, href: l.absHref, raw: l.href, valid: HREFLANG_RE.test(l.hreflang), self: sameUrl(l.absHref, canonical || url) }));
  if (hreflang.length) {
    const bad = hreflang.filter((h) => !h.valid);
    if (bad.length) add('hreflang', 'error', `Invalid hreflang code${bad.length === 1 ? '' : 's'}: ${bad.map((b) => b.lang).join(', ')}.`);
    if (hreflang.some((h) => h.raw && !/^https?:\/\//i.test(h.raw))) add('hreflang', 'warning', 'hreflang URLs must be absolute.');
    if (!hreflang.some((h) => h.self)) add('hreflang', 'warning', 'No hreflang entry points back to this page (self-reference).');
    if (!hreflang.some((h) => lower(h.lang) === 'x-default')) add('hreflang', 'info', 'No x-default hreflang.');
    const seen = new Map();
    for (const h of hreflang) seen.set(lower(h.lang), (seen.get(lower(h.lang)) || 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([l]) => l);
    if (dupes.length) add('hreflang', 'warning', `Duplicate hreflang codes: ${dupes.join(', ')}.`);
  }

  // --- Social ------------------------------------------------------------
  const og = {};
  const twitter = {};
  for (const m of metas) {
    const n = lower(m.name);
    if (n.startsWith('og:')) (og[n.slice(3)] ||= []).push(m.content);
    else if (n.startsWith('twitter:')) (twitter[n.slice(8)] ||= []).push(m.content);
  }
  const ogFirst = (k) => og[k]?.[0];
  for (const k of ['title', 'description', 'image', 'url', 'type']) {
    if (!ogFirst(k)) add('social', k === 'image' || k === 'title' ? 'warning' : 'info', `Missing og:${k}.`);
  }
  for (const k of ['image', 'url']) {
    const v = ogFirst(k);
    if (v && !isAbsoluteUrl(v)) add('social', 'warning', `og:${k} must be an absolute URL. Got "${v}".`);
  }
  const ogUrl = ogFirst('url');
  if (ogUrl && canonical && isAbsoluteUrl(ogUrl) && !sameUrl(ogUrl, canonical)) add('social', 'info', `og:url (${ogUrl}) differs from the canonical URL.`);
  if (!twitter.card?.[0]) add('social', 'info', 'No twitter:card. X falls back to a small summary card using Open Graph tags.');
  else if (!['summary', 'summary_large_image', 'app', 'player'].includes(twitter.card[0])) add('social', 'warning', `Unknown twitter:card "${twitter.card[0]}".`);
  const misplaced = metas.filter((m) => m.attr === 'name' && lower(m.name).startsWith('og:'));
  if (misplaced.length) add('social', 'info', `${misplaced.length} Open Graph tag${misplaced.length === 1 ? ' uses' : 's use'} name= instead of property=. Most crawlers accept it, but property= is the standard.`);

  // --- Other head links --------------------------------------------------
  const linkRel = (rel) => links.filter((l) => l.rel.split(/\s+/).includes(rel));
  const icons = links.filter((l) => /(^|\s)(icon|apple-touch-icon)(\s|$)/.test(l.rel));
  if (!icons.length) add('document', 'info', 'No favicon link tag (browsers will try /favicon.ico).');

  const summary = {
    url,
    title,
    titleLength: title.length,
    titlePx,
    description,
    descriptionLength: description.length,
    descriptionPx,
    canonical,
    robots: all,
    indexable: !noindex && !(robotsTxt && !robotsTxt.allowed) && !(http?.status >= 400),
    lang: seo.lang,
    charset: seo.charset,
    viewport: viewport ?? null,
    wordCount: seo.wordCount ?? null,
    author: metaValues(metas, 'author')[0] ?? null,
    publisher: metaValues(metas, 'publisher', 'article:publisher')[0] ?? null,
    generator: metaValues(metas, 'generator')[0] ?? null,
    keywords: metaValues(metas, 'keywords')[0] ?? null,
    themeColor: metaValues(metas, 'theme-color')[0] ?? null,
    favicon: icons[0]?.absHref ?? null,
    amp: linkRel('amphtml')[0]?.absHref ?? null,
    prev: linkRel('prev')[0]?.absHref ?? null,
    next: linkRel('next')[0]?.absHref ?? null,
    http: http ?? null,
    robotsTxt: robotsTxt ?? null,
  };

  return {
    summary,
    checks,
    headings: { items: headings, counts },
    images: { items: images, total: imgTotal, missingAlt: noAlt.length, emptyAlt: emptyAlt.length },
    links: { items: linkItems, stats: linkStats },
    hreflang,
    social: { og, twitter, misplacedOg: misplaced.length },
    counts: {
      errors: checks.filter((c) => c.severity === 'error').length,
      warnings: checks.filter((c) => c.severity === 'warning').length,
      infos: checks.filter((c) => c.severity === 'info').length,
    },
  };
}
