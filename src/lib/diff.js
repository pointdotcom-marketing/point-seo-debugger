// Snapshots and diffs: reduces a page's collected data + analysis to a small, comparable snapshot,
// diffs two snapshots (field changes, headings, counts, JSON-LD property paths, fixed/new issues),
// and handles the storage bookkeeping and staging ↔ live URL mapping. Pure functions; the side
// panel does the storage and tab work.

const SNAPSHOT_VERSION = 1;

const FIELD_LABELS = { title: 'Title', description: 'Description', canonical: 'Canonical', robots: 'Meta robots', lang: 'Language' };

/** Recursively sorts object keys so JSON.stringify output is stable. */
export function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalizeJson(value[k]);
    return out;
  }
  return value;
}

const joinValues = (list) => (list && list.length ? list.join(' | ') : null);

/**
 * Builds a snapshot from a collected page (content.js) and its analyses (analyzePage, analyzeSeo).
 * Only errors and warnings are kept as issues; infos are too noisy to be worth diffing.
 */
export function buildSnapshot(page, schema, seo, takenAt = Date.now()) {
  const s = seo.summary;
  const fields = {
    title: s.title || null,
    description: s.description || null,
    canonical: s.canonical || null,
    robots: s.robots?.length ? s.robots.join(', ') : null,
    lang: s.lang || null,
  };
  for (const h of seo.hreflang || []) fields[`hreflang:${h.lang.toLowerCase()}`] = h.href;
  for (const [k, v] of Object.entries(seo.social?.og || {})) fields[`og:${k}`] = joinValues(v);
  for (const [k, v] of Object.entries(seo.social?.twitter || {})) fields[`twitter:${k}`] = joinValues(v);

  const issues = [
    ...seo.checks.map((c) => ({ severity: c.severity, area: c.area, message: c.message })),
    ...schema.blocks.flatMap((b) => b.issues.map((i) => ({ severity: i.severity, area: b.label, message: i.message }))),
    ...schema.features.flatMap((f) => f.issues.map((i) => ({ severity: i.severity, area: `${f.blockLabel} · ${f.name || f.featureId}`, message: i.message }))),
  ].filter((i) => i.severity === 'error' || i.severity === 'warning');

  const ls = seo.links.stats;
  return {
    v: SNAPSHOT_VERSION,
    url: page.url,
    takenAt,
    fields,
    headings: seo.headings.items.map((h) => ({ level: h.level, text: h.text })),
    metrics: {
      links: ls.total,
      internalLinks: ls.internal,
      externalLinks: ls.external,
      nofollowLinks: ls.nofollow,
      images: seo.images.total,
      missingAlt: seo.images.missingAlt,
      errors: seo.counts.errors + schema.counts.errors,
      warnings: seo.counts.warnings + schema.counts.warnings,
    },
    blocks: schema.blocks.map((b) => ({
      label: b.label,
      format: b.format,
      types: b.types,
      data: b.data == null ? null : normalizeJson(b.data),
      parseError: b.parseError ? b.parseError.message || 'Invalid JSON' : null,
    })),
    issues,
  };
}

const METRIC_LABELS = {
  links: 'Links',
  internalLinks: 'Internal links',
  externalLinks: 'External links',
  nofollowLinks: 'Nofollow links',
  images: 'Images',
  missingAlt: 'Images missing alt',
  errors: 'Errors',
  warnings: 'Warnings',
};

export function fieldLabel(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  if (key.startsWith('hreflang:')) return `hreflang ${key.slice(9)}`;
  return key;
}

// ---------------------------------------------------------------------------
// JSON diff.

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Arrays of typed nodes (an @graph, a list of offers) are matched by @id, then @type, so
// reordering or inserting a node doesn't show every later node as changed. Returns null when any
// element has neither, and the array is compared by index instead.
function nodeKeys(arr) {
  const seen = new Map();
  const keys = [];
  for (const v of arr) {
    const base = isObj(v) ? (v['@id'] ? `@id=${v['@id']}` : v['@type'] ? [].concat(v['@type']).join(',') : null) : null;
    if (!base) return null;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    keys.push(n > 1 ? `${base}#${n}` : base);
  }
  return keys;
}

const join = (path, key) => (path ? `${path}.${key}` : key);

/** Property-level diff of two JSON values: [{ path, kind: 'added'|'removed'|'changed', before, after }]. */
export function diffJson(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => {
      const p = join(path, k);
      if (!(k in a)) return [{ path: p, kind: 'added', after: b[k] }];
      if (!(k in b)) return [{ path: p, kind: 'removed', before: a[k] }];
      return diffJson(a[k], b[k], p);
    });
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    let keysA = nodeKeys(a);
    let keysB = nodeKeys(b);
    if (!keysA || !keysB) {
      keysA = a.map((_, i) => String(i));
      keysB = b.map((_, i) => String(i));
    }
    const mapA = new Map(keysA.map((k, i) => [k, a[i]]));
    const mapB = new Map(keysB.map((k, i) => [k, b[i]]));
    const order = [...keysA, ...keysB.filter((k) => !mapA.has(k))];
    return order.flatMap((k) => {
      const p = `${path}[${k}]`;
      if (!mapA.has(k)) return [{ path: p, kind: 'added', after: mapB.get(k) }];
      if (!mapB.has(k)) return [{ path: p, kind: 'removed', before: mapA.get(k) }];
      return diffJson(mapA.get(k), mapB.get(k), p);
    });
  }
  return [{ path: path || '(root)', kind: 'changed', before: a, after: b }];
}

// ---------------------------------------------------------------------------
// Snapshot diff.

const blockKey = (b) => `${b.format}:${b.types?.length ? b.types.join('+') : 'untyped'}`;

/** Pairs structured data blocks: same format + root types first, then leftovers in page order. */
function pairBlocks(before, after) {
  const pairs = [];
  const usedB = new Set();
  const usedA = new Set();
  before.forEach((a, i) => {
    const j = after.findIndex((b, j) => !usedB.has(j) && blockKey(b) === blockKey(a));
    if (j !== -1) {
      usedA.add(i);
      usedB.add(j);
      pairs.push([a, after[j]]);
    }
  });
  const restA = before.filter((_, i) => !usedA.has(i));
  const restB = after.filter((_, j) => !usedB.has(j));
  restA.forEach((a) => {
    const j = restB.findIndex((b) => b && b.format === a.format);
    if (j !== -1) {
      pairs.push([a, restB[j]]);
      restB[j] = null;
    } else pairs.push([a, null]);
  });
  restB.filter(Boolean).forEach((b) => pairs.push([null, b]));
  return pairs;
}

const issueKey = (i) => `${i.severity}|${i.area}|${i.message}`;
const headingKey = (h) => `${h.level}|${h.text}`;

function multisetDiff(a, b, key) {
  const counts = new Map();
  for (const x of a) counts.set(key(x), (counts.get(key(x)) || 0) + 1);
  const added = [];
  for (const x of b) {
    const k = key(x);
    if (counts.get(k)) counts.set(k, counts.get(k) - 1);
    else added.push(x);
  }
  const left = new Map(counts);
  const removed = a.filter((x) => {
    const k = key(x);
    if (!left.get(k)) return false;
    left.set(k, left.get(k) - 1);
    return true;
  });
  return { added, removed };
}

/**
 * Diffs two snapshots. `before` is the snapshot (or the other URL), `after` is the current page.
 * Returns { fields, headings, metrics, blocks, issues, total }.
 */
export function diffSnapshots(before, after) {
  const keys = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])];
  const fields = keys
    .filter((k) => (before.fields[k] ?? null) !== (after.fields[k] ?? null))
    .map((k) => ({ key: k, label: fieldLabel(k), before: before.fields[k] ?? null, after: after.fields[k] ?? null }));

  const headings = multisetDiff(before.headings, after.headings, headingKey);

  const metrics = Object.keys(METRIC_LABELS)
    .filter((k) => (before.metrics[k] ?? 0) !== (after.metrics[k] ?? 0))
    .map((k) => ({ key: k, label: METRIC_LABELS[k], before: before.metrics[k] ?? 0, after: after.metrics[k] ?? 0, delta: (after.metrics[k] ?? 0) - (before.metrics[k] ?? 0) }));

  const blocks = pairBlocks(before.blocks, after.blocks)
    .map(([a, b]) => {
      if (!a) return { label: b.label, types: b.types, status: 'added', changes: [] };
      if (!b) return { label: a.label, types: a.types, status: 'removed', changes: [] };
      const changes = diffJson(a.data, b.data);
      const parse = a.parseError !== b.parseError ? { before: a.parseError, after: b.parseError } : null;
      if (!changes.length && !parse) return null;
      return { label: b.label, beforeLabel: a.label, types: b.types, status: 'changed', changes, parse };
    })
    .filter(Boolean);

  const iss = multisetDiff(before.issues, after.issues, issueKey);
  const issues = { fixed: iss.removed, introduced: iss.added };

  const total =
    fields.length +
    headings.added.length +
    headings.removed.length +
    metrics.filter((m) => m.key !== 'errors' && m.key !== 'warnings').length +
    blocks.reduce((n, b) => n + (b.status === 'changed' ? b.changes.length + (b.parse ? 1 : 0) : 1), 0) +
    issues.fixed.length +
    issues.introduced.length;

  return { fields, headings, metrics, blocks, issues, total };
}

/**
 * Rewrites every string in a value (a collected page or a snapshot) from one origin to another, so
 * a staging page and its live counterpart compare on content rather than on host names.
 */
export function aliasOrigin(value, from, to) {
  if (!from || !to || from === to) return value;
  const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const walk = (v) => (typeof v === 'string' ? v.replace(re, to) : Array.isArray(v) ? v.map(walk) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

// ---------------------------------------------------------------------------
// Storage bookkeeping. The store is { [url]: [snapshot, ...newest first] }.

export const SNAPSHOTS_PER_URL = 5;
export const SNAPSHOT_STORE_MAX_BYTES = 4_000_000;

/** Snapshots are per URL, ignoring the #fragment. */
export function snapshotKey(url) {
  return String(url).split('#')[0];
}

const storeSize = (store) => JSON.stringify(store).length;

/**
 * Adds a snapshot, keeping `perUrl` per URL and evicting the oldest snapshots of any URL once the
 * store exceeds `maxBytes`. The new snapshot itself is never evicted. Returns a new store.
 */
export function addSnapshot(store, snap, { perUrl = SNAPSHOTS_PER_URL, maxBytes = SNAPSHOT_STORE_MAX_BYTES } = {}) {
  const key = snapshotKey(snap.url);
  const next = { ...store, [key]: [snap, ...(store[key] || [])].slice(0, perUrl) };
  while (storeSize(next) > maxBytes) {
    let oldest = null;
    for (const [url, list] of Object.entries(next)) {
      list.forEach((s, i) => {
        if (s === snap) return;
        if (!oldest || s.takenAt < oldest.s.takenAt) oldest = { url, i, s };
      });
    }
    if (!oldest) break;
    const list = next[oldest.url].filter((_, i) => i !== oldest.i);
    if (list.length) next[oldest.url] = list;
    else delete next[oldest.url];
  }
  return next;
}

export function timeAgo(then, now = Date.now()) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// Staging ↔ live.

/** Accepts "foo.webflow.io", "https://foo.webflow.io/path" or "foo.com:8080"; returns the host. */
export function normalizeHost(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).host;
  } catch {
    return '';
  }
}

export const isWebflowStaging = (host) => /\.webflow\.io$/i.test(host.split(':')[0]);

/**
 * Suggests the counterpart of a URL: a configured staging ↔ production host pair wins; otherwise a
 * *.webflow.io page whose canonical (or og:url) points at another host maps to that host.
 * Returns { url, reason } or null.
 */
export function counterpartUrl(url, pairs = [], { canonical, ogUrl } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const swap = (host) => {
    const v = new URL(u.href);
    v.host = host;
    v.hash = '';
    return v.href;
  };
  for (const p of pairs) {
    if (p.staging && u.host === p.staging && p.production) return { url: swap(p.production), reason: 'mapping', role: 'staging' };
    if (p.production && u.host === p.production && p.staging) return { url: swap(p.staging), reason: 'mapping', role: 'production' };
  }
  if (isWebflowStaging(u.host)) {
    for (const hint of [canonical, ogUrl]) {
      try {
        const h = new URL(hint);
        if (/^https?:$/.test(h.protocol) && h.host !== u.host && !isWebflowStaging(h.host)) {
          const v = new URL(u.href);
          v.protocol = h.protocol;
          v.host = h.host;
          v.hash = '';
          return { url: v.href, reason: 'canonical', role: 'staging' };
        }
      } catch {
        // not a URL
      }
    }
  }
  return null;
}
