import { analyzePage } from '../lib/validator.js';
import { analyzeSeo } from '../lib/seo.js';
import { parseRobots, robotsAllows } from '../lib/robots.js';
import { esc, csv, copyText, empty } from './ui.js';
import { renderSchema } from './views-schema.js';
import { analyzeAiAccess, robotsSnippet } from '../lib/ai-crawlers.js';
import { loadAiFiles, probeBots } from './ai.js';
import { renderAi } from './views-ai.js';
import { renderOverview, renderHeadings, renderImages, renderLinks, renderSocial, renderTools, filteredImages, filteredLinks } from './views-seo.js';

const $ = (id) => document.getElementById(id);

const TABS = [
  ['overview', 'Overview'],
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
  }
  analyze();
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
          res.body?.cancel().catch(() => {});
          state.http = { status: res.status, redirected: res.redirected, finalUrl: res.url, xRobotsTag: res.headers.get('x-robots-tag') };
        } catch (e) {
          state.http = { error: e.name === 'AbortError' ? 'timed out' : 'request failed' };
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
// Rendering.

function render() {
  if (!state.page) return;
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
  };
  $('tabs').hidden = false;
  $('tabs').innerHTML = TABS.map(([id, label]) => {
    const b = badge[id];
    return `<button role="tab" data-tab="${id}" aria-selected="${id === state.tab}">${label}${b ? `<span class="count ${b[0]}">${b[1]}</span>` : ''}</button>`;
  }).join('');
  updateTabFade();

  const scroll = document.scrollingElement.scrollTop;
  const sameTab = $('content').dataset.tab === state.tab;
  $('content').dataset.tab = state.tab;
  $('content').innerHTML = {
    overview: renderOverview,
    schema: renderSchema,
    headings: renderHeadings,
    images: renderImages,
    links: renderLinks,
    social: renderSocial,
    ai: renderAi,
    tools: renderTools,
  }[state.tab](state);
  document.scrollingElement.scrollTop = sameTab ? scroll : 0;
  fitSerp();
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

$('content').addEventListener('click', (e) => {
  const t = (sel) => e.target.closest(sel);
  let el;
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

$('rescan').addEventListener('click', () => refresh({ force: true }));

chrome.tabs.onActivated.addListener(() => pinnedTabId || refresh());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.status === 'complete') refresh();
});
// Live updates as the page changes (content script re-reports on DOM changes).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'seo-lens:page' && sender.tab?.id === state.tabId) show(msg.data);
});

refresh();

// Exposed for the end-to-end test.
globalThis.__seoLensState = state;
