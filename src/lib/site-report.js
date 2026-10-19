// Sitemap scan results: one summary row per scanned URL (built from the same analyzers the side
// panel uses) and site-wide findings across rows. Pure functions, shared by the scan page and tests.
import { analyzePage } from './validator.js';
import { analyzeSeo, TITLE_MAX_PX } from './seo.js';

const SEV_ORDER = { error: 0, warning: 1, info: 2 };

/** Comparable form of a URL: lowercase host, no hash, no trailing slash. */
export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/$/, '') || '/'}${x.search}`;
  } catch {
    return String(u ?? '').split('#')[0];
  }
}

/** "self" when the canonical is the page's own URL (any of the given forms), else "other"/"missing". */
export function canonicalKind(canonical, ...selfUrls) {
  if (!canonical) return 'missing';
  const c = normalizeUrl(canonical);
  return selfUrls.filter(Boolean).some((u) => normalizeUrl(u) === c) ? 'self' : 'other';
}

/**
 * @param {object} input
 * @param {string} input.url               the sitemap URL that was scanned
 * @param {object|null} input.page         content.js collect() result from the loaded tab
 * @param {object|null} [input.http]       {status, redirected, finalUrl, xRobotsTag} or {error}
 * @param {{allowed: boolean, rule: string|null}|null} [input.robotsTxt]  robots.txt verdict for url
 * @param {string|null} [input.error]      why the page couldn't be loaded/collected
 * @param {object} [opts]
 * @param {(text: string, font: string) => number} [opts.measure]
 */
export function summarizePage({ url, page = null, http = null, robotsTxt = null, error = null }, { measure } = {}) {
  const httpOk = http && !http.error ? http : null;
  const finalUrl = page?.url || httpOk?.finalUrl || url;
  const redirectTo = normalizeUrl(finalUrl) !== normalizeUrl(url) ? finalUrl : null;
  const row = {
    url,
    finalUrl,
    status: httpOk?.status ?? null,
    httpError: http?.error ?? null,
    redirectTo,
    robotsAllowed: robotsTxt ? robotsTxt.allowed : null,
    robotsRule: robotsTxt?.rule ?? null,
    loaded: !!page,
    error: error || (!page ? 'Page could not be loaded.' : null),
    noindex: false,
    indexable: false,
    notIndexable: [],
    title: '',
    titleLength: 0,
    titlePx: null,
    titleTooLong: false,
    description: '',
    descriptionLength: 0,
    canonical: null,
    canonicalKind: 'missing',
    h1Count: 0,
    imagesMissingAlt: 0,
    types: [],
    rich: { valid: 0, warnings: 0, invalid: 0, deprecated: 0 },
    errors: 0,
    warnings: 0,
    issues: [],
  };

  if (page) {
    const schema = analyzePage(page);
    const seo = analyzeSeo(page.seo || {}, page.url || url, { measure, http: httpOk, robotsTxt });
    const s = seo.summary;
    Object.assign(row, {
      noindex: s.robots.includes('noindex') || s.robots.includes('none'),
      title: s.title,
      titleLength: s.titleLength,
      titlePx: s.titlePx,
      titleTooLong: s.titlePx != null ? s.titlePx > TITLE_MAX_PX : s.titleLength > 60,
      description: s.description,
      descriptionLength: s.descriptionLength,
      canonical: s.canonical,
      canonicalKind: canonicalKind(s.canonical, page.url, url),
      h1Count: seo.headings.counts[0],
      imagesMissingAlt: seo.images.missingAlt,
      types: [...new Set(schema.blocks.flatMap((b) => b.types))],
      errors: seo.counts.errors + schema.counts.errors,
      warnings: seo.counts.warnings + schema.counts.warnings,
      issues: [
        ...seo.checks,
        ...schema.blocks.flatMap((b) => b.issues.map((i) => ({ area: 'schema', severity: i.severity, message: `${b.label}: ${i.message}` }))),
        ...schema.features.flatMap((f) => f.issues.map((i) => ({ area: 'rich results', severity: i.severity, message: `${f.name}: ${i.message}` }))),
        ...schema.pageIssues.map((i) => ({ area: 'schema', severity: i.severity, message: i.message })),
      ],
    });
    for (const f of schema.features) {
      const key = { valid: 'valid', warnings: 'warnings', invalid: 'invalid', deprecated: 'deprecated' }[f.status];
      if (key) row.rich[key]++;
    }
    if (!s.indexable) {
      if (row.noindex) row.notIndexable.push('noindex');
      if (robotsTxt && !robotsTxt.allowed) row.notIndexable.push('blocked by robots.txt');
      if (row.status >= 400) row.notIndexable.push(`HTTP ${row.status}`);
    }
  } else {
    row.errors = 1;
    row.issues.push({ area: 'http', severity: 'error', message: row.error });
    row.notIndexable.push('not loaded');
  }
  if (http?.error) {
    row.issues.push({ area: 'http', severity: 'warning', message: `Status check failed: ${http.error}.` });
    row.warnings++;
  }
  if (redirectTo) {
    row.notIndexable.push('redirects');
    row.issues.push({ area: 'sitemap', severity: 'warning', message: `Sitemap URL redirects to ${redirectTo}. List the final URL instead.` });
    row.warnings++;
  }
  if (row.loaded && row.canonicalKind === 'other' && !redirectTo) {
    row.issues.push({ area: 'sitemap', severity: 'warning', message: `Sitemap lists a URL that canonicalizes to ${row.canonical}. Sitemaps should list canonical URLs only.` });
    row.warnings++;
  }
  if (row.loaded && row.robotsAllowed === false) row.issues.push({ area: 'sitemap', severity: 'info', message: 'This sitemap URL is blocked by robots.txt.' });
  if (row.robotsAllowed === false && !row.notIndexable.includes('blocked by robots.txt')) row.notIndexable.push('blocked by robots.txt');
  row.indexable = row.notIndexable.length === 0;
  row.issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  return row;
}

// ---------------------------------------------------------------------------

const ok200 = (r) => r.loaded && r.status != null && r.status >= 200 && r.status < 300 && !r.redirectTo;

function duplicates(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const v = String(r[key] ?? '').replace(/\s+/g, ' ').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!groups.has(k)) groups.set(k, { value: v, urls: [] });
    groups.get(k).urls.push(r.url);
  }
  return [...groups.values()].filter((g) => g.urls.length > 1).sort((a, b) => b.urls.length - a.urls.length);
}

/**
 * Site-wide findings over scanned rows. Each finding has either `groups` (duplicates) or `items`
 * ({url, detail}); `count` is the number of entries, so a finding with count 0 means "all clear".
 */
export function buildSiteReport(rows) {
  const unique = rows.filter(ok200);
  const item = (r, detail = '') => ({ url: r.url, detail });
  const findings = [
    {
      id: 'non-200',
      severity: 'error',
      label: 'Non-200 responses',
      about: 'Sitemap URLs should return 200. Errors waste crawl budget and drop pages from the index.',
      items: rows.filter((r) => !r.loaded || r.httpError || (r.status != null && r.status !== 200)).map((r) => item(r, r.status != null ? `HTTP ${r.status}` : r.httpError || r.error)),
    },
    {
      id: 'noindex',
      severity: 'error',
      label: 'Sitemap URLs that are noindex',
      about: 'A sitemap asks Google to index these URLs, but the page says noindex.',
      items: rows.filter((r) => r.noindex).map((r) => item(r)),
    },
    {
      id: 'robots-blocked',
      severity: 'error',
      label: 'Sitemap URLs blocked by robots.txt',
      about: "Googlebot can't crawl these, so it can't see their content, noindex or canonical.",
      items: rows.filter((r) => r.robotsAllowed === false).map((r) => item(r, r.robotsRule || '')),
    },
    {
      id: 'redirects',
      severity: 'warning',
      label: 'Sitemap URLs that redirect',
      about: 'List the final URL in the sitemap instead of one that redirects.',
      items: rows.filter((r) => r.redirectTo).map((r) => item(r, `→ ${r.redirectTo}`)),
    },
    {
      id: 'canonical-elsewhere',
      severity: 'warning',
      label: 'Pages canonicalizing elsewhere',
      about: 'These pages point their canonical at another URL. Sitemaps should list canonical URLs only.',
      items: rows.filter((r) => r.loaded && r.canonicalKind === 'other' && !r.redirectTo).map((r) => item(r, `→ ${r.canonical}`)),
    },
    {
      id: 'duplicate-titles',
      severity: 'warning',
      label: 'Duplicate titles',
      about: 'Pages sharing a title compete with each other and look identical in results.',
      groups: duplicates(unique, 'title'),
    },
    {
      id: 'duplicate-descriptions',
      severity: 'warning',
      label: 'Duplicate descriptions',
      about: 'Reused meta descriptions make Google more likely to write its own snippet.',
      groups: duplicates(unique, 'description'),
    },
    {
      id: 'missing-titles',
      severity: 'error',
      label: 'Missing titles',
      about: 'Every indexable page needs a <title>.',
      items: unique.filter((r) => !r.title).map((r) => item(r)),
    },
    {
      id: 'missing-descriptions',
      severity: 'warning',
      label: 'Missing descriptions',
      about: 'Without a meta description Google picks a snippet from the page text.',
      items: unique.filter((r) => !r.description).map((r) => item(r)),
    },
  ];
  for (const f of findings) f.count = (f.groups || f.items).length;
  return {
    totals: {
      pages: rows.length,
      loaded: rows.filter((r) => r.loaded).length,
      indexable: rows.filter((r) => r.indexable).length,
      withErrors: rows.filter((r) => r.errors).length,
      withWarnings: rows.filter((r) => r.warnings).length,
      errors: rows.reduce((n, r) => n + r.errors, 0),
      warnings: rows.reduce((n, r) => n + r.warnings, 0),
    },
    findings,
  };
}

/** Table filters: [id, label, predicate]. */
export const ROW_FILTERS = [
  ['all', 'All', () => true],
  ['errors', 'Has errors', (r) => r.errors > 0],
  ['warnings', 'Has warnings', (r) => r.warnings > 0],
  ['not-indexable', 'Not indexable', (r) => !r.indexable],
  ['non-200', 'Non-200', (r) => !r.loaded || r.status !== 200],
  ['redirects', 'Redirects', (r) => !!r.redirectTo],
  ['missing-title', 'Missing title', (r) => r.loaded && !r.title],
  ['missing-description', 'Missing description', (r) => r.loaded && !r.description],
  ['canonical-other', 'Canonical elsewhere', (r) => r.canonicalKind === 'other'],
  ['no-h1', 'No H1', (r) => r.loaded && r.h1Count === 0],
  ['missing-alt', 'Images missing alt', (r) => r.imagesMissingAlt > 0],
  ['invalid-rich', 'Invalid rich results', (r) => r.rich.invalid > 0],
];

export const statusLabel = (r) => (r.status != null ? String(r.status) : r.httpError ? 'failed' : r.loaded ? '?' : 'error');

/** CSV rows (header first) for export. */
export function csvRows(rows) {
  return [
    ['url', 'final url', 'status', 'indexable', 'not indexable because', 'robots.txt', 'title', 'title length', 'title px', 'description length', 'canonical', 'canonical type', 'h1 count', 'images missing alt', 'schema types', 'rich results valid', 'rich results with warnings', 'rich results invalid', 'errors', 'warnings', 'issues'],
    ...rows.map((r) => [
      r.url,
      r.finalUrl,
      statusLabel(r),
      r.indexable ? 'yes' : 'no',
      r.notIndexable.join('; '),
      r.robotsAllowed == null ? '' : r.robotsAllowed ? 'allowed' : `blocked (${r.robotsRule})`,
      r.title,
      r.titleLength,
      r.titlePx ?? '',
      r.descriptionLength,
      r.canonical ?? '',
      r.canonicalKind,
      r.h1Count,
      r.imagesMissingAlt,
      r.types.join(' '),
      r.rich.valid,
      r.rich.warnings,
      r.rich.invalid,
      r.errors,
      r.warnings,
      r.issues.filter((i) => i.severity !== 'info').map((i) => `[${i.severity}] ${i.message}`).join(' | '),
    ]),
  ];
}
