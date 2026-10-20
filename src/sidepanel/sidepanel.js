import { analyzePage } from '../lib/validator.js';
import { analyzeSeo } from '../lib/seo.js';
import { parseRobots, robotsAllows } from '../lib/robots.js';
import { extractRawHtml, compareRawRendered } from '../lib/raw-html.js';
import { esc, csv, copyText, empty } from './ui.js';
import { renderSchema } from './views-schema.js';
import { analyzeAiAccess, robotsSnippet } from '../lib/ai-crawlers.js';
import { loadAiFiles, probeBots } from './ai.js';
import { renderAi } from './views-ai.js';
import { buildSnapshot, diffSnapshots, addSnapshot, snapshotKey, timeAgo, counterpartUrl, normalizeHost, isWebflowStaging, aliasOrigin } from '../lib/diff.js';
import { renderChanges } from './views-changes.js';
import { renderOverview, renderHeadings, renderImages, renderLinks, renderSocial, renderTools, filteredImages, filteredLinks } from './views-seo.js';

const $ = (id) => document.getElementById(id);

const TABS = [
  ['overview', 'Overview'],
  ['changes', 'Changes'],
  ['schema', 'Schema'],
  ['headings', 'Headings'],
  ['images', 'Images'],
  ['links', 'Links'],
  ['social', 'Social'],
  ['ai', 'AI'],
  ['tools', 'Tools'],
];

const state = {
  tabId: null,
  page: null,
  schema: null,
  seo: null,
  tab: 'overview',
  schemaView: 'google',
  schemaFilters: new Set(['error', 'warning', 'info']),
  imageFilter: 'all',
  linkFilter: 'all',
  http: null,
  httpFor: null,
  httpPending: false,
  rawHtml: null,
  rendering: null,
  robots: null,
  robotsFor: null,
  robotsPending: false,
  ogImage: null,
  linkStatus: new Map(),
  linkCheckRunning: false,
  linkCheckTotal: 0,
  ai: null,
  aiFiles: null,
  aiFilesFor: null,
  aiProbes: null,
  aiProbeRunning: false,
  aiPolicy: 'block-training',
  // Snapshots / compare (Changes tab).
  current: null,
  snapshots: [],
  snapshotsFor: null,
  snapshotIndex: 0,
  snapshotDiff: null,
  hostPairs: [],
  showPairs: false,
  pairDraft: { staging: '', production: '' },
  compare: { input: null, pending: null, error: null, result: null },
  compareSuggestion: null,
  compareDiff: null,
};

// ---------------------------------------------------------------------------
// Measuring text the way Google's SERP renders it.

const canvas = document.createElement('canvas').getContext('2d');
function measure(text, font) {
  canvas.font = font;
  return canvas.measureText(text).width;
}

// ---------------------------------------------------------------------------
// Talking to the page.

// ?tabId=N pins the panel to one tab, so it can be opened as a normal page for debugging/tests.
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function activeTab() {
  if (pinnedTabId) return chrome.tabs.get(pinnedTabId).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function collect(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'seo-lens:collect' });
  } catch {
    // Tab was open before the extension loaded, so the content script isn't there yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/lib/markup.js', 'src/content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'seo-lens:collect' });
  }
}

async function refresh({ force = false } = {}) {
  const btn = $('rescan');
  btn.classList.remove('spinning');
  void btn.offsetWidth;
  btn.classList.add('spinning');
  const tab = await activeTab();
  if (tab?.id !== state.tabId) resetPerPage();
  state.tabId = tab?.id ?? null;
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) {
    showUnavailable(tab, 'Point SEO Debugger only runs on web pages (http, https, or file).');
    return;
  }
  try {
    const page = await collect(tab.id);
    if (!page) throw new Error('No response from page');
    show(page, { force });
  } catch (e) {
    const fileHint = tab.url.startsWith('file:') ? ' For local files, enable "Allow access to file URLs" for Point SEO Debugger in chrome://extensions.' : '';
    showUnavailable(tab, `Couldn't read this page (${e.message}).${fileHint}`);
  }
}

function resetPerPage() {
  state.linkStatus = new Map();
  state.linkCheckRunning = false;
  state.ogImage = null;
  state.aiProbes = null;
}

function show(page, { force = false } = {}) {
  const urlChanged = state.page?.url !== page.url;
  state.page = page;
  state.schema = analyzePage(page);
  if (urlChanged) {
    state.linkStatus = new Map();
    state.aiProbes = null;
    state.compare = { input: null, pending: null, error: null, result: null };
  }
  analyze();
  state.current = snapshotOf(page, state.schema);
  if (snapshotKey(page.url) !== state.snapshotsFor) loadSnapshots();
  render();
  loadNetworkInfo(force);
  loadOgImage();
  loadAi(force);
}

function analyze() {
  const sameHttp = state.httpFor === state.page.url;
  const robotsResult = state.robots?.parsed && state.robotsFor === new URL(state.page.url).origin ? robotsAllows(state.robots.parsed, state.page.url) : null;
  state.seo = analyzeSeo(state.page.seo, state.page.url, {
    measure,
    http: sameHttp ? state.http : null,
    robotsTxt: robotsResult,
  });
  // Server HTML vs rendered DOM: provenance per item, plus checks for things only JavaScript adds.
  state.rendering = sameHttp && state.rawHtml ? compareRawRendered(state.rawHtml, { ...state.page.seo, blocks: state.page.blocks }) : null;
  if (state.rendering) {
    const seo = state.seo;
    seo.checks.push(...state.rendering.checks);
    if (state.rendering.noindex.raw) seo.summary.indexable = false;
    for (const [k, sev] of [['errors', 'error'], ['warnings', 'warning'], ['infos', 'info']]) seo.counts[k] = seo.checks.filter((c) => c.severity === sev).length;
  }
  analyzeAi();
}

function analyzeAi() {
  const origin = new URL(state.page.url).origin;
  if (state.robotsPending || state.robotsFor !== origin) {
    state.ai = null;
    return;
  }
  const metas = state.page.seo?.metas || [];
  const directives = metas
    .filter((m) => ['robots', 'googlebot', 'bingbot'].includes(String(m.name).toLowerCase()))
    .flatMap((m) => String(m.content).split(','))
    .concat(state.httpFor === state.page.url && state.http?.xRobotsTag ? state.http.xRobotsTag.replace(/^[a-z-]+:\s*(?=[a-z])/i, '').split(',') : [])
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const files = state.aiFilesFor === state.page.url ? state.aiFiles : null;
  state.ai = analyzeAiAccess({
    url: state.page.url,
    robots: state.robots,
    robotsDirectives: directives,
    contentUsageHeader: files?.contentUsage ?? null,
    llms: files?.llms ?? null,
    dataNosnippet: state.page.seo?.dataNosnippet ?? 0,
  });
}

async function loadAi(force) {
  if (!/^https?:/.test(state.page.url)) return;
  const url = state.page.url;
  if (!force && state.aiFilesFor === url) return;
  const files = await loadAiFiles(url);
  if (state.page?.url !== url) return;
  state.aiFiles = files;
  state.aiFilesFor = url;
  analyzeAi();
  if (state.tab === 'ai') render();
}

async function runAiProbe() {
  const url = state.page.url;
  state.aiProbes = new Map();
  state.aiProbeRunning = true;
  render();
  let timer = null;
  await probeBots(url, (token, result) => {
    if (state.page?.url !== url) return;
    state.aiProbes.set(token, result);
    if (!timer) timer = setTimeout(() => ((timer = null), state.tab === 'ai' && render()), 200);
  });
  state.aiProbeRunning = false;
  render();
}

function showUnavailable(tab, message) {
  state.page = null;
  $('page-title').textContent = tab?.title || 'Point SEO Debugger';
  $('page-url').textContent = tab?.url || '';
  $('summary').hidden = true;
  $('tabs').hidden = true;
  $('content').innerHTML = empty(`<p>${esc(message)}</p>`);
}

// ---------------------------------------------------------------------------
// Network checks (HTTP status/headers, robots.txt, link status).

async function fetchWithTimeout(url, init = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function loadNetworkInfo(force) {
  if (!/^https?:/.test(state.page.url)) return;
  const url = state.page.url;
  const origin = new URL(url).origin;
  const jobs = [];
  if (force || state.httpFor !== url) {
    state.httpPending = true;
    jobs.push(
      (async () => {
        try {
          const res = await fetchWithTimeout(url, { credentials: 'include' });
          state.http = { status: res.status, redirected: res.redirected, finalUrl: res.url, xRobotsTag: res.headers.get('x-robots-tag') };
          // The response body is the server HTML, before any JavaScript ran.
          state.rawHtml = null;
          if (res.ok && /html/i.test(res.headers.get('content-type') || '')) {
            const html = await res.text().catch(() => null);
            if (html != null) state.rawHtml = extractRawHtml(new DOMParser().parseFromString(html, 'text/html'), res.url || url);
          } else res.body?.cancel().catch(() => {});
        } catch (e) {
          state.http = { error: e.name === 'AbortError' ? 'timed out' : 'request failed' };
          state.rawHtml = null;
        }
        state.httpFor = url;
        state.httpPending = false;
      })(),
    );
  }
  if (force || state.robotsFor !== origin) {
    state.robotsPending = true;
    jobs.push(
      (async () => {
        try {
          const res = await fetchWithTimeout(`${origin}/robots.txt`, { credentials: 'include' });
          const type = res.headers.get('content-type') || '';
          if (!res.ok) state.robots = { error: `No robots.txt (HTTP ${res.status})`, status: res.status };
          else if (/html/i.test(type)) state.robots = { error: 'robots.txt returned an HTML page' };
          else {
            const text = await res.text();
            const parsed = parseRobots(text);
            state.robots = { text, parsed, groups: parsed.groups.length, sitemaps: parsed.sitemaps };
          }
        } catch {
          state.robots = { error: 'robots.txt request failed' };
        }
        state.robotsFor = origin;
        state.robotsPending = false;
      })(),
    );
  }
  if (!jobs.length) return;
  render();
  await Promise.all(jobs);
  if (state.page?.url !== url) return;
  analyze();
  render();
}

function loadOgImage() {
  const og = state.seo.social.og;
  const src = og.image?.[0] || og['image:url']?.[0];
  if (!src || !/^https?:\/\//i.test(src) || state.ogImage?.src === src) return;
  state.ogImage = { src, pending: true };
  const img = new Image();
  img.onload = () => {
    state.ogImage = { src, w: img.naturalWidth, h: img.naturalHeight };
    if (state.tab === 'social') render();
  };
  img.onerror = () => {
    state.ogImage = { src, error: true };
    if (state.tab === 'social') render();
  };
  img.src = src;
}

async function checkLinks() {
  const pageHost = new URL(state.page.url).host;
  const urls = [...new Set(state.seo.links.items.filter((l) => l.kind === 'internal' || l.kind === 'external').map((l) => l.href.split('#')[0]))].slice(0, 400);
  state.linkStatus = new Map();
  state.linkCheckRunning = true;
  state.linkCheckTotal = urls.length;
  const byBase = new Map();
  for (const l of state.seo.links.items) {
    const base = l.href.split('#')[0];
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(l.href);
  }
  const set = (base, value) => (byBase.get(base) || [base]).forEach((h) => state.linkStatus.set(h, value));
  urls.forEach((u) => set(u, { pending: true }));
  render();

  let timer = null;
  const scheduleRender = () => {
    if (!timer) timer = setTimeout(() => ((timer = null), state.tab === 'links' && render()), 250);
  };
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      const credentials = new URL(u).host === pageHost ? 'include' : 'omit';
      try {
        let res = await fetchWithTimeout(u, { method: 'HEAD', credentials });
        if ([403, 405, 501].includes(res.status)) {
          res = await fetchWithTimeout(u, { method: 'GET', credentials });
          res.body?.cancel().catch(() => {});
        }
        set(u, { status: res.status, redirected: res.redirected, finalUrl: res.url });
      } catch (e) {
        set(u, { error: e.name === 'AbortError' ? 'timed out' : 'request failed (network/CORS-blocked or DNS)' });
      }
      scheduleRender();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  state.linkCheckRunning = false;
  render();
}

// ---------------------------------------------------------------------------
// Snapshots and staging ↔ live compare.

// Snapshots leave out the HTTP/robots.txt checks so they compare the page itself, whether or not
// the network checks had finished when each side was taken.
function snapshotOf(page, schema = analyzePage(page)) {
  return buildSnapshot(page, schema, analyzeSeo(page.seo, page.url, { measure }));
}

async function loadSnapshots() {
  const key = snapshotKey(state.page.url);
  state.snapshotsFor = key;
  const { snapshots = {} } = await chrome.storage.local.get('snapshots');
  if (state.snapshotsFor !== key) return;
  state.snapshots = snapshots[key] || [];
  state.snapshotIndex = 0;
  render();
}

async function saveSnapshot() {
  const snap = snapshotOf(state.page, state.schema);
  const { snapshots = {} } = await chrome.storage.local.get('snapshots');
  const store = addSnapshot(snapshots, snap);
  await chrome.storage.local.set({ snapshots: store });
  state.snapshots = store[snapshotKey(snap.url)] || [];
  state.snapshotIndex = 0;
  render();
}

async function deleteSnapshots() {
  const key = snapshotKey(state.page.url);
  const { snapshots = {} } = await chrome.storage.local.get('snapshots');
  delete snapshots[key];
  await chrome.storage.local.set({ snapshots });
  state.snapshots = [];
  render();
}

async function loadHostPairs() {
  const { hostPairs = [] } = await chrome.storage.local.get('hostPairs');
  state.hostPairs = hostPairs;
  if (state.page) render();
}

async function saveHostPairs(pairs) {
  state.hostPairs = pairs;
  await chrome.storage.local.set({ hostPairs: pairs });
  render();
}

function waitForLoad(tabId, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(value);
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done(resolve);
    const timer = setTimeout(() => done(reject, new Error('timed out loading the page')), ms);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Loads a URL in a background tab, collects it with the content script, and closes the tab. */
async function collectInBackground(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id, 30000);
    // Give scripts that inject JSON-LD after load a moment, as the live view would.
    await new Promise((r) => setTimeout(r, 600));
    const page = await collect(tab.id);
    if (!page) throw new Error('no response from the page');
    return page;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const isStagingHost = (host) => isWebflowStaging(host) || state.hostPairs.some((p) => p.staging === host);

async function compareWith(input) {
  let url;
  try {
    url = new URL(input).href;
  } catch {
    state.compare = { ...state.compare, error: 'Enter a full URL, starting with https://', result: null };
    return render();
  }
  const forUrl = state.page.url;
  state.compare = { input, pending: url, error: null, result: null };
  render();
  try {
    const page = await collectInBackground(url);
    if (state.page?.url !== forUrl) return;
    const otherOrigin = new URL(page.url).origin;
    const thisOrigin = new URL(forUrl).origin;
    const otherHost = new URL(page.url).host;
    const thisHost = new URL(forUrl).host;
    // Live is "before", staging is "after", so fixed/new issues read as what publishing would change.
    const otherIsStaging = isStagingHost(otherHost) && !isStagingHost(thisHost);
    // The staging side is analyzed as if it were on the live origin, so host names (canonical,
    // @id, internal links) don't show up as changes or as canonical warnings.
    const other = snapshotOf(otherIsStaging ? aliasOrigin(page, otherOrigin, thisOrigin) : page);
    const hasPair = state.hostPairs.some((p) => [p.staging, p.production].includes(thisHost) && [p.staging, p.production].includes(otherHost));
    const webflow = [thisHost, otherHost].filter(isWebflowStaging);
    state.compare = {
      input,
      pending: null,
      error: null,
      result: {
        other,
        otherIsStaging,
        otherOrigin,
        thisOrigin,
        requestedUrl: url,
        loadedUrl: page.url,
        beforeLabel: otherIsStaging ? `${thisHost} (this tab)` : otherHost,
        afterLabel: otherIsStaging ? otherHost : `${thisHost} (this tab)`,
        aliased: otherOrigin !== thisOrigin ? new URL(otherIsStaging ? forUrl : page.url).host : null,
        offerPair: !hasPair && webflow.length === 1 && thisHost !== otherHost ? { staging: webflow[0], production: webflow[0] === thisHost ? otherHost : thisHost } : null,
      },
    };
  } catch (e) {
    if (state.page?.url !== forUrl) return;
    state.compare = { input, pending: null, error: `Couldn't load ${url}: ${e.message}`, result: null };
  }
  render();
}

// Diffs are recomputed on every render, so they follow live edits on this tab.
function computeDiffs() {
  const snap = state.snapshots[state.snapshotIndex];
  state.snapshotDiff = snap && state.current ? diffSnapshots(snap, state.current) : null;
  const r = state.compare.result;
  if (r && state.current) {
    if (r.otherIsStaging) state.compareDiff = diffSnapshots(state.current, r.other);
    else {
      if (r.aliasedPage !== state.page) {
        r.aliasedPage = state.page;
        r.aliasedCurrent = snapshotOf(aliasOrigin(state.page, r.thisOrigin, r.otherOrigin));
      }
      state.compareDiff = diffSnapshots(r.other, r.aliasedCurrent);
    }
  } else state.compareDiff = null;
  const og = state.seo?.social.og;
  state.compareSuggestion = state.page ? counterpartUrl(state.page.url, state.hostPairs, { canonical: state.seo?.summary.canonical, ogUrl: og?.url?.[0] }) : null;
}

// ---------------------------------------------------------------------------
// Rendering.

function render() {
  if (!state.page) return;
  computeDiffs();
  const { page, schema, seo } = state;
  $('page-title').textContent = page.title || page.url;
  $('page-url').textContent = page.url;
  $('page-url').title = page.url;

  const errors = seo.counts.errors + schema.counts.errors;
  const warnings = seo.counts.warnings + schema.counts.warnings;
  $('summary').hidden = false;
  $('summary').innerHTML = [
    `<span class="stat ${seo.summary.indexable ? 'ok' : 'error'}"><strong>${seo.summary.indexable ? 'Indexable' : 'Not indexable'}</strong></span>`,
    `<span class="stat ${errors ? 'error' : 'ok'}"><strong>${errors}</strong> error${errors === 1 ? '' : 's'}</span>`,
    `<span class="stat ${warnings ? 'warning' : 'ok'}"><strong>${warnings}</strong> warning${warnings === 1 ? '' : 's'}</span>`,
    `<span class="stat"><strong>${schema.counts.blocks}</strong> JSON-LD</span>`,
    schema.counts.microdata ? `<span class="stat"><strong>${schema.counts.microdata}</strong> Microdata</span>` : '',
    schema.counts.rdfa ? `<span class="stat"><strong>${schema.counts.rdfa}</strong> RDFa</span>` : '',
    snapshotChip(),
  ].join('');

  // Tab badges only appear when there's something to fix, to keep the tab bar narrow.
  const areaErrors = (...areas) => seo.checks.filter((c) => c.severity === 'error' && areas.includes(c.area)).length;
  const areaWarnings = (...areas) => seo.checks.filter((c) => c.severity === 'warning' && areas.includes(c.area)).length;
  const pick = (e, w) => (e ? ['err', e] : w ? ['warn', w] : null);
  const badge = {
    overview: pick(areaErrors('title', 'description', 'canonical', 'robots', 'http', 'lang', 'mobile', 'document', 'hreflang'), 0),
    schema: pick(schema.counts.errors, 0),
    headings: pick(areaErrors('headings'), areaWarnings('headings')),
    images: pick(areaErrors('images'), seo.images.missingAlt),
    links: pick(areaErrors('links'), areaWarnings('links')),
    social: pick(areaErrors('social'), areaWarnings('social')),
    ai: state.ai ? pick(state.ai.checks.filter((c) => c.severity === 'error').length, state.ai.checks.filter((c) => c.severity === 'warning').length) : null,
    changes: state.snapshotDiff?.total ? ['', state.snapshotDiff.total] : null,
  };
  $('tabs').hidden = false;
  $('tabs').innerHTML = TABS.map(([id, label]) => {
    const b = badge[id];
    return `<button role="tab" data-tab="${id}" aria-selected="${id === state.tab}">${label}${b ? `<span class="count ${b[0]}">${b[1]}</span>` : ''}</button>`;
  }).join('');
  updateTabFade();

  const scroll = document.scrollingElement.scrollTop;
  const sameTab = $('content').dataset.tab === state.tab;
  // Live updates re-render while someone may be typing in a Changes tab field.
  const active = document.activeElement;
  const focus = active?.id && $('content').contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  $('content').dataset.tab = state.tab;
  $('content').innerHTML = {
    overview: renderOverview,
    changes: renderChanges,
    schema: renderSchema,
    headings: renderHeadings,
    images: renderImages,
    links: renderLinks,
    social: renderSocial,
    ai: renderAi,
    tools: renderTools,
  }[state.tab](state);
  document.scrollingElement.scrollTop = sameTab ? scroll : 0;
  if (focus && $(focus.id)) {
    $(focus.id).focus();
    if (focus.start != null) $(focus.id).setSelectionRange(focus.start, focus.end);
  }
  fitSerp();
}

function snapshotChip() {
  const snap = state.snapshots[state.snapshotIndex];
  if (!snap || !state.snapshotDiff) return '';
  const changed = state.snapshotDiff.total > 0;
  return `<button class="stat ${changed ? 'changed' : ''}" data-goto="changes" title="Open the Changes tab">${changed ? 'Changed since snapshot' : 'Matches snapshot'} (${esc(timeAgo(snap.takenAt))})</button>`;
}

function updateTabFade() {
  const t = $('tabs');
  t.classList.toggle('fade-right', t.scrollLeft + t.clientWidth < t.scrollWidth - 2);
  t.classList.toggle('fade-left', t.scrollLeft > 2);
}
$('tabs').addEventListener('scroll', updateTabFade);
window.addEventListener('resize', updateTabFade);

function fitSerp() {
  const serp = $('serp');
  if (!serp) return;
  const available = serp.parentElement.clientWidth - 2;
  serp.style.zoom = String(Math.min(1, available / 600));
}
new ResizeObserver(fitSerp).observe(document.body);

// ---------------------------------------------------------------------------
// Events.

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn || !state.page) return;
  state.tab = btn.dataset.tab;
  render();
  $('tabs').querySelector(`[data-tab="${state.tab}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

$('summary').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-goto]');
  if (!btn || !state.page) return;
  state.tab = btn.dataset.goto;
  render();
});

$('content').addEventListener('click', (e) => {
  const t = (sel) => e.target.closest(sel);
  let el;
  if ((el = t('[data-save-snapshot]'))) return saveSnapshot();
  if ((el = t('[data-delete-snapshots]'))) return deleteSnapshots();
  if ((el = t('[data-toggle-pairs]'))) {
    state.showPairs = !state.showPairs;
    return render();
  }
  if ((el = t('[data-remove-pair]'))) return saveHostPairs(state.hostPairs.filter((_, i) => i !== +el.dataset.removePair));
  if ((el = t('[data-save-pair]'))) {
    const [staging, production] = el.dataset.savePair.split('|');
    return saveHostPairs([...state.hostPairs.filter((p) => p.staging !== staging), { staging, production }]);
  }
  if ((el = t('[data-schema-view]'))) {
    state.schemaView = el.dataset.schemaView;
    return render();
  }
  if ((el = t('[data-sev-filter]'))) {
    const f = el.dataset.sevFilter;
    state.schemaFilters.has(f) ? state.schemaFilters.delete(f) : state.schemaFilters.add(f);
    return render();
  }
  if ((el = t('[data-image-filter]'))) {
    state.imageFilter = el.dataset.imageFilter;
    return render();
  }
  if ((el = t('[data-link-filter]'))) {
    state.linkFilter = el.dataset.linkFilter;
    return render();
  }
  if ((el = t('[data-check-links]'))) return checkLinks();
  if ((el = t('[data-ai-probe]'))) return runAiProbe();
  if ((el = t('[data-ai-policy]'))) {
    state.aiPolicy = el.dataset.aiPolicy;
    return render();
  }
  if ((el = t('[data-hl]'))) {
    chrome.tabs.sendMessage(state.tabId, { type: 'seo-lens:highlight', kind: el.dataset.hl, index: +el.dataset.index }).catch(() => {});
    return;
  }
  if ((el = t('[data-copy-block]'))) {
    const b = state.schema.blocks[+el.dataset.copyBlock];
    return copyText(b.data && !b.parseError ? JSON.stringify(b.data, null, 2) : b.text, el);
  }
  if ((el = t('[data-copy-all-ld]'))) {
    // Microdata/RDFa go in as their JSON-LD conversion, so the Rich Results Test checks them too.
    const tags = state.schema.blocks.map((b) => `${b.format === 'jsonld' ? '' : `<!-- ${b.label}, converted to JSON-LD -->\n`}<script type="application/ld+json">\n${b.text.trim()}\n</script>`);
    return copyText(tags.join('\n'), el);
  }
  if ((el = t('[data-copy]'))) {
    const kind = el.dataset.copy;
    if (kind === 'ai-robots') return copyText(robotsSnippet(state.aiPolicy), el);
    if (kind === 'headings') {
      return copyText(state.seo.headings.items.map((h) => `${'  '.repeat(h.level - 1)}H${h.level}: ${h.text}`).join('\n'), el);
    }
    if (kind === 'images') {
      return copyText(csv([['src', 'alt', 'width', 'height', 'flags'], ...filteredImages(state).map((i) => [i.src, i.alt ?? '(none)', i.width, i.height, i.flags.join('; ')])]), el);
    }
    if (kind === 'links') {
      return copyText(
        csv([
          ['url', 'anchor text', 'type', 'rel', 'status'],
          ...filteredLinks(state).map((l) => {
            const st = state.linkStatus.get(l.href);
            return [l.href, l.text || l.imgAlt || '', l.kind, l.rel, st?.status ?? st?.error ?? ''];
          }),
        ]),
        el,
      );
    }
  }
});

$('content').addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.matches('[data-compare-form]')) return compareWith($('compare-url').value.trim());
  if (e.target.matches('[data-pair-form]')) {
    const staging = normalizeHost(state.pairDraft.staging);
    const production = normalizeHost(state.pairDraft.production);
    if (!staging || !production || staging === production) return;
    state.pairDraft = { staging: '', production: '' };
    return saveHostPairs([...state.hostPairs.filter((p) => p.staging !== staging), { staging, production }]);
  }
});

$('content').addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'compare-url') state.compare.input = e.target.value;
  else if (id === 'pair-staging') state.pairDraft.staging = e.target.value;
  else if (id === 'pair-production') state.pairDraft.production = e.target.value;
});

$('content').addEventListener('change', (e) => {
  if (!e.target.matches('[data-snapshot-select]')) return;
  state.snapshotIndex = +e.target.value;
  render();
});

// Other panels (other windows) may save snapshots or host pairs.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.hostPairs) loadHostPairs();
  if (changes.snapshots && state.page) {
    state.snapshots = changes.snapshots.newValue?.[snapshotKey(state.page.url)] || [];
    state.snapshotIndex = Math.min(state.snapshotIndex, Math.max(0, state.snapshots.length - 1));
    render();
  }
});

// Keeps "(5 min ago)" current.
setInterval(() => state.snapshots.length && render(), 60000);

$('rescan').addEventListener('click', () => refresh({ force: true }));

chrome.tabs.onActivated.addListener(() => pinnedTabId || refresh());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === 'complete') refresh();
});
// Live updates as the page changes (content script re-reports on DOM changes).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'seo-lens:page' && sender.tab?.id === state.tabId) show(msg.data);
});

loadHostPairs();
refresh();

// Exposed for the end-to-end test.
globalThis.__seoLensState = state;
