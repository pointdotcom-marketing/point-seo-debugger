// Sitemap bulk scan: reads sitemap(s), loads each URL in a background tab, collects it with the
// content script (same data the side panel uses), and summarizes the results site-wide.
import { parseRobots, robotsAllows } from '../lib/robots.js';
import { crawlSitemaps, defaultSitemaps, selectUrls } from '../lib/sitemap.js';
import { summarizePage, buildSiteReport, ROW_FILTERS, csvRows, statusLabel } from '../lib/site-report.js';
import { esc, csv, plural, issueList, sev } from '../sidepanel/ui.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const MAX_PAGES = 1000;
const MAX_TABS = 8;
const LOAD_TIMEOUT = 30000;
const COLLECT_TIMEOUT = 10000;

const state = {
  phase: 'idle', // idle | discovering | scanning | done
  paused: false,
  stopping: false,
  stopped: false,
  crawl: null,
  matched: 0,
  rows: [], // {url, pending: true} until scanned, then a site-report row
  next: 0,
  report: null,
  filter: 'all',
  search: '',
  sort: { key: 'index', dir: 1 },
  expanded: new Set(),
  error: null,
};

// ---------------------------------------------------------------------------
// Network helpers.

async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store', credentials: 'include' });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemapText(url) {
  let res;
  try {
    res = await fetchWithTimeout(url, {}, 30000);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : 'request failed');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // .xml.gz served without Content-Encoding arrives still compressed.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }
  return new TextDecoder().decode(bytes);
}

const robotsCache = new Map();
function robotsFor(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(
      origin,
      (async () => {
        try {
          const res = await fetchWithTimeout(`${origin}/robots.txt`);
          if (!res.ok || /html/i.test(res.headers.get('content-type') || '')) return null;
          return parseRobots(await res.text());
        } catch {
          return null;
        }
      })(),
    );
  }
  return robotsCache.get(origin);
}

async function checkHttp(url) {
  try {
    const res = await fetchWithTimeout(url);
    res.body?.cancel().catch(() => {});
    return { status: res.status, redirected: res.redirected, finalUrl: res.url, xRobotsTag: res.headers.get('x-robots-tag'), contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : 'request failed' };
  }
}

// ---------------------------------------------------------------------------
// Background tabs.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, message) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(message)))]);

const ownTabs = new Set();
const tabStatus = new Map();
const statusWaiters = new Map();
// Statuses are recorded for every tab: a new tab's first events can arrive before tabs.create resolves.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.status) return;
  tabStatus.set(tabId, info.status);
  statusWaiters.get(tabId)?.();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  ownTabs.delete(tabId);
  if (!statusWaiters.has(tabId)) return tabStatus.delete(tabId);
  tabStatus.set(tabId, 'removed');
  statusWaiters.get(tabId)();
});

/** Resolves true on load complete, false on timeout; rejects if the tab is closed. */
function waitForLoad(tabId, ms) {
  return new Promise((resolve, reject) => {
    const finish = (fn, v) => {
      clearTimeout(timer);
      statusWaiters.delete(tabId);
      fn(v);
    };
    const check = () => {
      const s = tabStatus.get(tabId);
      if (s === 'complete') finish(resolve, true);
      else if (s === 'removed') finish(reject, new Error('Tab was closed'));
    };
    const timer = setTimeout(() => finish(resolve, false), ms);
    statusWaiters.set(tabId, check);
    check();
  });
}

async function openInSlot(slot, url) {
  if (slot.tabId != null && ownTabs.has(slot.tabId)) {
    tabStatus.set(slot.tabId, 'navigating');
    await chrome.tabs.update(slot.tabId, { url });
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    slot.tabId = tab.id;
    ownTabs.add(tab.id);
    if (!tabStatus.has(tab.id)) tabStatus.set(tab.id, 'loading');
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  }
  return waitForLoad(slot.tabId, LOAD_TIMEOUT);
}

async function collect(tabId) {
  const ask = () => withTimeout(chrome.tabs.sendMessage(tabId, { type: 'seo-lens:collect' }), COLLECT_TIMEOUT, 'Page did not respond');
  try {
    const page = await ask();
    if (page) return page;
  } catch {
    /* content script not there yet (or page navigated); inject it */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/lib/markup.js', 'src/content.js'] });
  return ask();
}

function closeOwnTabs() {
  for (const id of ownTabs) chrome.tabs.remove(id).catch(() => {});
}
window.addEventListener('pagehide', closeOwnTabs);

// ---------------------------------------------------------------------------
// Scanning.

const canvas = document.createElement('canvas').getContext('2d');
function measure(text, font) {
  canvas.font = font;
  return canvas.measureText(text).width;
}

const settings = () => ({
  roots: $('sitemap').value.split(/\s+/).filter(Boolean),
  filter: $('filter').value.trim(),
  max: clamp(+$('max').value || 100, 1, MAX_PAGES),
  concurrency: clamp(+$('concurrency').value || 3, 1, MAX_TABS),
  settle: clamp(+$('settle').value || 0, 0, 10000),
});
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

async function scanOne(slot, url, settle) {
  const robots = await robotsFor(new URL(url).origin);
  const robotsTxt = robots ? robotsAllows(robots, url) : null;
  const http = await checkHttp(url);
  if (http.contentType && !/html|xml/i.test(http.contentType)) {
    return summarizePage({ url, http, robotsTxt, error: `Not an HTML page (${http.contentType.split(';')[0]}).` }, { measure });
  }
  let page = null;
  let error = null;
  try {
    const loaded = await openInSlot(slot, url);
    if (settle) await sleep(settle);
    page = await collect(slot.tabId);
    if (!page) error = `No response from the page${loaded ? '' : ' (load timed out)'}.`;
  } catch (e) {
    error = `Couldn't read the page: ${e.message}.`;
    if (!ownTabs.has(slot.tabId)) slot.tabId = null;
  }
  return summarizePage({ url, page, http, robotsTxt, error }, { measure });
}

let resumeScan = null;
let pauseGate = null;
function setPaused(paused) {
  state.paused = paused;
  if (paused) pauseGate = new Promise((r) => (resumeScan = r));
  else resumeScan?.();
  render();
}

async function worker(settle) {
  const slot = { tabId: null };
  while (!state.stopping) {
    while (state.paused && !state.stopping) await pauseGate;
    if (state.stopping) break;
    const i = state.next++;
    if (i >= state.rows.length) break;
    state.rows[i] = { ...state.rows[i], running: true };
    scheduleRender();
    const row = await scanOne(slot, state.rows[i].url, settle);
    state.rows[i] = { ...row, index: i };
    state.report = buildSiteReport(scanned());
    scheduleRender();
  }
  if (slot.tabId != null) chrome.tabs.remove(slot.tabId).catch(() => {});
}

const scanned = () => state.rows.filter((r) => !r.pending);

async function start() {
  const opts = settings();
  if (!opts.roots.length || opts.roots.some((u) => !/^https?:\/\//i.test(u))) {
    state.error = 'Enter the full sitemap URL, starting with https://.';
    return render();
  }
  Object.assign(state, { phase: 'discovering', paused: false, stopping: false, stopped: false, crawl: null, rows: [], next: 0, report: null, expanded: new Set(), error: null });
  robotsCache.clear();
  render();
  const crawl = await crawlSitemaps(opts.roots, fetchSitemapText, { maxSitemaps: 200 });
  state.crawl = crawl;
  const { matched, selected } = selectUrls(crawl.urls, { filter: opts.filter, max: opts.max });
  state.matched = matched;
  state.rows = selected.map((u, index) => ({ url: u.loc, index, pending: true }));
  if (!state.rows.length) {
    state.phase = 'done';
    state.error = crawl.urls.length ? 'No sitemap URLs match the filter.' : 'No URLs found in the sitemap.';
    return render();
  }
  state.phase = 'scanning';
  state.startedAt = Date.now();
  render();
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, state.rows.length) }, () => worker(opts.settle)));
  state.stopped = state.stopping;
  state.phase = 'done';
  state.report = buildSiteReport(scanned());
  render();
}

// ---------------------------------------------------------------------------
// Rendering.

let renderTimer = null;
function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(() => ((renderTimer = null), render()), 250);
}

function render() {
  const busy = state.phase === 'discovering' || state.phase === 'scanning';
  $('start').disabled = busy;
  $('pause').hidden = state.phase !== 'scanning';
  $('stop').hidden = !busy;
  $('pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('stop').disabled = state.stopping;
  for (const id of ['sitemap', 'filter', 'max', 'concurrency', 'settle']) $(id).disabled = busy;

  renderProgress();
  const hasRows = state.rows.some((r) => !r.pending);
  $('findings').hidden = !hasRows;
  $('results').hidden = !state.rows.length;
  if (hasRows) $('findings').innerHTML = renderFindings();
  if (state.rows.length) renderTable();
}

function renderProgress() {
  const el = $('progress');
  const parts = [];
  if (state.error) parts.push(`<div class="banner error">${sev('error')}<div>${esc(state.error)}</div></div>`);
  if (state.phase === 'discovering') parts.push(`<div class="card"><div class="card-head"><div class="grow">Reading sitemaps…</div></div></div>`);
  const c = state.crawl;
  if (c) {
    const done = scanned().length;
    const total = state.rows.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const sitemapErrors = c.sitemaps.filter((s) => s.errors.length);
    const what = state.phase === 'done' ? (state.stopped ? 'Stopped' : 'Done') : state.paused ? 'Paused' : 'Scanning';
    const eta = state.phase === 'scanning' && done && !state.paused ? ` · about ${formatDuration(((Date.now() - state.startedAt) / done) * (total - done))} left` : '';
    parts.push(`<div class="card progress-card">
      <div class="card-head"><div class="grow">
        <div class="card-title">${what}: ${done} of ${plural(total, 'page')}${eta}</div>
        <div class="card-sub">${plural(c.urls.length, 'URL')} in ${plural(c.sitemaps.length, 'sitemap')}${state.matched !== c.urls.length ? `, ${state.matched} matching the filter` : ''}${state.matched > total ? `, first ${total} scanned` : ''}${c.truncated ? ' (URL list truncated)' : ''}${c.skippedSitemaps ? `, ${plural(c.skippedSitemaps, 'sitemap')} not read (limit reached)` : ''}</div>
      </div></div>
      ${total ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
      <details class="sitemaps"><summary>${sitemapErrors.length ? `${sev('warning')} ${plural(sitemapErrors.length, 'sitemap')} with problems · ` : ''}Sitemaps read</summary>
        <ul>${c.sitemaps.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener" class="mono">${esc(s.url)}</a> <span class="muted">${s.type === 'sitemapindex' ? `index of ${plural(s.sitemaps, 'sitemap')}` : s.type ? plural(s.urls, 'URL') : ''}</span>${s.errors.map((e) => ` <span class="bad-text">${esc(e)}</span>`).join('')}</li>`).join('')}</ul>
      </details>
    </div>`);
  }
  el.hidden = !parts.length;
  el.innerHTML = parts.join('');
}

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}

const link = (url, text = url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const path = (url) => {
  try {
    const u = new URL(url);
    return u.origin === siteOrigin() ? u.pathname + u.search || '/' : url;
  } catch {
    return url;
  }
};
const siteOrigin = () => {
  try {
    return new URL(state.rows[0]?.url).origin;
  } catch {
    return '';
  }
};

function renderFindings() {
  const r = state.report;
  if (!r) return '';
  const t = r.totals;
  const boxes = [
    [t.pages, 'pages scanned'],
    [t.indexable, 'indexable', t.indexable < t.loaded ? 'warn' : ''],
    [t.withErrors, 'with errors', t.withErrors ? 'bad' : ''],
    [t.withWarnings, 'with warnings', t.withWarnings ? 'warn' : ''],
  ];
  // Re-rendered while the scan runs, so keep whichever findings the user has opened.
  const open = new Set([...document.querySelectorAll('#findings details[open]')].map((d) => d.dataset.finding));
  const detail = (d) => (d.startsWith('→ ') ? `→ ${path(d.slice(2))}` : d);
  const finding = (f) => {
    const head = (s) => `${sev(s)}<span class="grow">${esc(f.label)}</span><span class="finding-count">${f.count}</span>`;
    if (!f.count) return `<div class="finding ok">${head('ok')}</div>`;
    const body = f.groups
      ? f.groups.map((g) => `<li><div class="dup-value">“${esc(g.value)}” <span class="muted">× ${g.urls.length}</span></div>${g.urls.map((u) => `<div class="mono">${link(u, path(u))}</div>`).join('')}</li>`).join('')
      : f.items.map((i) => `<li><span class="mono">${link(i.url, path(i.url))}</span>${i.detail ? ` <span class="muted">${esc(detail(i.detail))}</span>` : ''}</li>`).join('');
    return `<details class="finding ${f.severity}" data-finding="${f.id}"${open.has(f.id) ? ' open' : ''}>
      <summary>${head(f.severity)}</summary>
      <p class="hint">${esc(f.about)}</p><ul class="finding-list">${body}</ul>
    </details>`;
  };
  return `<div class="section-label">Site-wide</div>
    <div class="stat-grid four">${boxes.map(([n, l, cls = '']) => `<div class="stat-box ${cls}"><div class="stat-n">${n}</div><div class="stat-l">${l}</div></div>`).join('')}</div>
    <div class="card findings">${[...r.findings].sort((a, b) => !!b.count - !!a.count).map(finding).join('')}</div>`;
}

const COLUMNS = [
  ['index', '#', (r) => r.index],
  ['url', 'URL', (r) => r.url],
  ['status', 'Status', (r) => r.status ?? -1],
  ['indexable', 'Indexable', (r) => (r.indexable ? 1 : 0)],
  ['title', 'Title', (r) => r.titleLength],
  ['description', 'Desc.', (r) => r.descriptionLength],
  ['canonical', 'Canonical', (r) => r.canonicalKind],
  ['h1', 'H1', (r) => r.h1Count],
  ['alt', 'No alt', (r) => r.imagesMissingAlt],
  ['types', 'Schema types', (r) => r.types.join(' ')],
  ['rich', 'Rich results', (r) => r.rich.invalid * 1e6 + r.rich.warnings * 1e3 + r.rich.valid],
  ['errors', 'Errors', (r) => r.errors],
  ['warnings', 'Warnings', (r) => r.warnings],
];

function visibleRows() {
  const pred = ROW_FILTERS.find(([id]) => id === state.filter)?.[2] || (() => true);
  const q = state.search.toLowerCase();
  const rows = state.rows.filter((r) => (r.pending ? state.filter === 'all' : pred(r)) && (!q || r.url.toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)));
  const col = COLUMNS.find(([k]) => k === state.sort.key) || COLUMNS[0];
  const { dir } = state.sort;
  return rows.sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? 1 : -1;
    if (a.pending) return a.index - b.index;
    const x = col[2](a);
    const y = col[2](b);
    return (x < y ? -1 : x > y ? 1 : a.index - b.index) * dir;
  });
}

function renderTable() {
  const done = scanned();
  $('row-filters').innerHTML = `<div class="filters">${ROW_FILTERS.map(([id, label, pred]) => {
    const n = id === 'all' ? state.rows.length : done.filter(pred).length;
    if (id !== 'all' && id !== state.filter && !n) return '';
    return `<button class="filter" data-row-filter="${id}" aria-pressed="${id === state.filter}">${esc(label)} <span class="muted">${n}</span></button>`;
  }).join('')}</div>`;
  $('export').disabled = !done.length;

  const rows = visibleRows();
  const head = `<thead><tr>${COLUMNS.map(([k, label]) => `<th data-sort="${k}" aria-sort="${state.sort.key === k ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}</th>`).join('')}</tr></thead>`;
  const body = rows.map(renderRow).join('') || `<tr><td colspan="${COLUMNS.length}" class="empty">No pages match.</td></tr>`;
  $('table').innerHTML = `${head}<tbody>${body}</tbody>`;
}

const num = (n, cls = 'bad') => (n ? `<span class="${cls}-text">${n}</span>` : '<span class="muted">0</span>');

function renderRow(r) {
  if (r.pending) {
    return `<tr class="pending"><td>${r.index + 1}</td><td class="url mono">${esc(path(r.url))}</td><td colspan="${COLUMNS.length - 2}" class="muted">${r.running ? '<span class="spinner"></span> scanning…' : 'queued'}</td></tr>`;
  }
  const open = state.expanded.has(r.url);
  const status = r.status != null && r.status !== 200 ? `<span class="bad-text">${esc(statusLabel(r))}</span>` : r.loaded || r.status != null ? esc(statusLabel(r)) : `<span class="bad-text">${esc(statusLabel(r))}</span>`;
  const canon = { self: '<span class="muted">self</span>', missing: '<span class="warn-text">missing</span>', other: `<span class="warn-text" title="${esc(r.canonical)}">other</span>` }[r.canonicalKind];
  const rich = r.rich.valid + r.rich.warnings + r.rich.invalid + r.rich.deprecated
    ? [r.rich.valid && `<span class="chip valid" title="valid">${r.rich.valid}</span>`, r.rich.warnings && `<span class="chip warnings" title="with warnings">${r.rich.warnings}</span>`, r.rich.invalid && `<span class="chip invalid" title="invalid">${r.rich.invalid}</span>`, r.rich.deprecated && `<span class="chip deprecated" title="deprecated">${r.rich.deprecated}</span>`].filter(Boolean).join(' ')
    : '<span class="muted">–</span>';
  const cells = [
    r.index + 1,
    `<span class="mono">${esc(path(r.url))}</span>${r.redirectTo ? `<div class="sub warn-text">→ ${esc(path(r.redirectTo))}</div>` : ''}`,
    status,
    r.indexable ? '<span class="ok-text">yes</span>' : `<span class="bad-text" title="${esc(r.notIndexable.join(', '))}">no</span><div class="sub muted">${esc(r.notIndexable.join(', '))}</div>`,
    r.loaded ? (r.title ? `<div class="clip" title="${esc(r.title)}">${esc(r.title)}</div><div class="sub ${r.titleTooLong ? 'warn-text' : 'muted'}">${r.titleLength} chars${r.titlePx ? ` · ${r.titlePx}px` : ''}</div>` : '<span class="bad-text">missing</span>') : '<span class="muted">–</span>',
    r.loaded ? (r.descriptionLength ? String(r.descriptionLength) : '<span class="warn-text">missing</span>') : '<span class="muted">–</span>',
    r.loaded ? canon : '<span class="muted">–</span>',
    r.loaded ? (r.h1Count === 1 ? '1' : r.h1Count ? `<span class="warn-text">${r.h1Count}</span>` : '<span class="warn-text">0</span>') : '<span class="muted">–</span>',
    r.loaded ? num(r.imagesMissingAlt, 'warn') : '<span class="muted">–</span>',
    r.types.length ? `<div class="types">${r.types.map((t) => `<span class="type-tag">${esc(t)}</span>`).join('')}</div>` : '<span class="muted">–</span>',
    rich,
    num(r.errors),
    num(r.warnings, 'warn'),
  ];
  const row = `<tr class="row${open ? ' open' : ''}" data-url="${esc(r.url)}" tabindex="0" aria-expanded="${open}">${cells.map((c, i) => `<td class="c-${COLUMNS[i][0]}">${c}</td>`).join('')}</tr>`;
  if (!open) return row;
  const kv = [
    ['URL', link(r.url)],
    r.redirectTo && ['Redirects to', link(r.redirectTo)],
    r.loaded && ['Title', r.title ? esc(r.title) : '<span class="bad-text">missing</span>'],
    r.loaded && ['Description', r.description ? esc(r.description) : '<span class="warn-text">missing</span>'],
    r.loaded && ['Canonical', r.canonical ? link(r.canonical) : '<span class="warn-text">missing</span>'],
    r.robotsAllowed === false && ['robots.txt', `<span class="bad-text">blocked by <span class="mono">${esc(r.robotsRule)}</span></span>`],
  ].filter(Boolean);
  return `${row}<tr class="detail"><td colspan="${COLUMNS.length}"><div class="detail-body">
    <div class="kv">${kv.map(([k, v]) => `<div class="kv-row"><div class="kv-k">${k}</div><div class="kv-v">${v}</div></div>`).join('')}</div>
    ${r.issues.length ? issueList(r.issues, { area: true }) : '<p class="muted">No issues.</p>'}
  </div></td></tr>`;
}

function exportCsv() {
  const rows = visibleRows().filter((r) => !r.pending);
  const blob = new Blob([`﻿${csv(csvRows(rows))}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  let host = 'site';
  try {
    host = new URL(rows[0].url).hostname;
  } catch {
    /* keep default */
  }
  a.download = `point-seo-debugger-scan-${host}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------------------
// Events.

$('setup').addEventListener('submit', (e) => {
  e.preventDefault();
  start();
});
$('pause').addEventListener('click', () => setPaused(!state.paused));
$('stop').addEventListener('click', () => {
  state.stopping = true;
  setPaused(false);
});
$('export').addEventListener('click', exportCsv);
$('search').addEventListener('input', (e) => {
  state.search = e.target.value.trim();
  renderTable();
});
$('row-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-row-filter]');
  if (!btn) return;
  state.filter = btn.dataset.rowFilter;
  renderTable();
});
$('table').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : ['errors', 'warnings', 'alt', 'rich'].includes(key) ? -1 : 1 };
    return renderTable();
  }
  if (e.target.closest('a, .detail')) return;
  const tr = e.target.closest('tr[data-url]');
  if (!tr) return;
  const url = tr.dataset.url;
  state.expanded.has(url) ? state.expanded.delete(url) : state.expanded.add(url);
  renderTable();
});
$('table').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-url]')) {
    e.preventDefault();
    e.target.click();
  }
});

// Prefill: ?sitemap=… (repeatable), or ?site=origin to look the sitemap up in robots.txt.
async function prefill() {
  const sitemaps = params.getAll('sitemap').filter(Boolean);
  const site = params.get('site');
  if (params.get('filter')) $('filter').value = params.get('filter');
  if (site) $('site').textContent = new URL(site).host;
  if (sitemaps.length) $('sitemap').value = sitemaps.join(' ');
  else if (site) {
    const origin = new URL(site).origin;
    $('sitemap').placeholder = 'Looking up robots.txt…';
    const robots = await robotsFor(origin);
    if (!$('sitemap').value) $('sitemap').value = defaultSitemaps(origin, robots?.sitemaps || []).join(' ');
    $('sitemap').placeholder = 'https://www.example.com/sitemap.xml';
  }
}
prefill();

// Exposed for the end-to-end test.
globalThis.__seoLensScan = state;
