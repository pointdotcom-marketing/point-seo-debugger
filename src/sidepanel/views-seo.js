// Overview, Headings, Images, Links, Social and Tools tabs.
import { esc, plural, issueList, bySeverity, chips, meter, sev, hostOf, empty } from './ui.js';
import { TITLE_MAX_PX, DESCRIPTION_MAX_PX } from '../lib/seo.js';

const MAX_ROWS = 500;

function worst(checks, ...areas) {
  const list = checks.filter((c) => areas.includes(c.area)).sort(bySeverity);
  return list[0]?.severity || 'ok';
}

const row = (label, value, status) => `<div class="kv-row"><div class="kv-k">${status ? sev(status) : '<span class="sev blank"></span>'}${esc(label)}</div><div class="kv-v">${value}</div></div>`;
const mono = (s) => `<span class="mono">${esc(s)}</span>`;
const muted = (s) => `<span class="muted">${esc(s)}</span>`;
const link = (href, text = href) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

// ---------------------------------------------------------------------------

export function siteName(state) {
  const fromSchema = state.schema.features.find((f) => f.featureId === 'site-name')?.entityName;
  return fromSchema || state.seo.social.og.site_name?.[0] || hostOf(state.page.url).replace(/^www\./, '');
}

function serpPreview(state) {
  const s = state.seo.summary;
  const u = new URL(state.page.url);
  const crumbs = [u.origin, ...u.pathname.split('/').filter(Boolean)].join(' › ');
  const favicon = s.favicon ? `<img src="${esc(s.favicon)}" alt="">` : '';
  return `<div class="serp-wrap"><div class="serp" id="serp">
    <div class="serp-site"><span class="serp-fav">${favicon}</span><span><span class="serp-name">${esc(siteName(state))}</span><span class="serp-url">${esc(crumbs)}</span></span></div>
    <div class="serp-title">${esc(s.title || '(no title)')}</div>
    <div class="serp-desc">${s.description ? esc(s.description) : '<span class="muted">No meta description; Google will pick text from the page.</span>'}</div>
  </div></div>`;
}

export function renderOverview(state) {
  const { seo, schema } = state;
  const s = seo.summary;
  const c = seo.checks;

  const blockers = c.filter((x) => ['robots', 'http'].includes(x.area) && x.severity === 'error');
  const canonicalElsewhere = c.some((x) => x.area === 'canonical' && /different URL/.test(x.message));
  const banner = !s.indexable
    ? `<div class="banner bad">${sev('error')}<div><strong>Not indexable</strong><div>${blockers.map((b) => esc(b.message)).join('<br>')}</div></div></div>`
    : canonicalElsewhere
      ? `<div class="banner warn">${sev('warning')}<div><strong>Indexable, but canonicalized</strong><div>Canonical points to ${esc(s.canonical)}, so Google will likely index that URL instead.</div></div></div>`
      : `<div class="banner ok">${sev('ok')}<div><strong>Indexable</strong></div></div>`;

  const titleVal = s.title
    ? `<div>${esc(s.title)}</div><div class="kv-meta">${s.titleLength} chars${s.titlePx != null ? ` · ${s.titlePx}px` : ''}</div>${meter(s.titlePx, TITLE_MAX_PX)}`
    : muted('Missing');
  const descVal = s.description
    ? `<div>${esc(s.description)}</div><div class="kv-meta">${s.descriptionLength} chars${s.descriptionPx != null ? ` · ${s.descriptionPx}px` : ''}</div>${meter(s.descriptionPx, DESCRIPTION_MAX_PX)}`
    : muted('Missing');
  const canonicalVal = s.canonical ? `${link(s.canonical)}${canonicalElsewhere ? '' : ' <span class="tag ok">self</span>'}` : muted('None');
  const robotsVal = s.robots.length ? mono(s.robots.join(', ')) : muted('index, follow (default)');
  const http = s.http;
  const httpVal = state.httpPending ? muted('checking…') : http?.status ? `${mono(String(http.status))}${http.redirected ? ` → ${link(http.finalUrl)}` : ''}` : muted(http?.error || 'unavailable');
  const xrt = http?.xRobotsTag ? mono(http.xRobotsTag) : muted('none');
  const rt = state.robotsPending ? muted('checking…') : s.robotsTxt ? (s.robotsTxt.allowed ? `Allowed${s.robotsTxt.rule ? ` ${muted(`(${s.robotsTxt.rule})`)}` : ''}` : `<strong class="bad-text">Blocked</strong> ${mono(s.robotsTxt.rule)}`) : muted(state.robots?.error || 'not found');
  const h = seo.headings.counts;
  const headingsVal = h.some(Boolean) ? h.map((n, i) => (n ? `H${i + 1}&nbsp;×${n}` : '')).filter(Boolean).join(' · ') : muted('None');
  const imgVal = `${seo.images.total}${seo.images.missingAlt ? ` · <span class="warn-text">${seo.images.missingAlt} missing alt</span>` : ''}`;
  const ls = seo.links.stats;
  const linksVal = `${ls.total} · ${ls.internal} internal · ${ls.external} external${ls.nofollow ? ` · ${ls.nofollow} nofollow` : ''}`;
  const sources = [plural(schema.counts.blocks, 'block'), schema.counts.microdata && `${schema.counts.microdata} Microdata`, schema.counts.rdfa && `${schema.counts.rdfa} RDFa`].filter(Boolean).join(' · ');
  const schemaVal = `${sources} · ${schema.features.length} rich result${schema.features.length === 1 ? '' : 's'}${schema.counts.errors ? ` · <span class="bad-text">${plural(schema.counts.errors, 'error')}</span>` : ''}`;

  const rows = [
    row('Title', titleVal, worst(c, 'title')),
    row('Description', descVal, worst(c, 'description')),
    row('URL', link(state.page.url), null),
    row('Canonical', canonicalVal, worst(c, 'canonical')),
    row('Meta robots', robotsVal, worst(c, 'robots')),
    row('X-Robots-Tag', xrt, null),
    row('HTTP status', httpVal, state.httpPending ? null : worst(c, 'http')),
    row('robots.txt', rt, state.robotsPending ? null : s.robotsTxt && !s.robotsTxt.allowed ? 'error' : 'ok'),
    row('Language', s.lang ? mono(s.lang) : muted('Missing'), worst(c, 'lang')),
    row('Viewport', s.viewport ? mono(s.viewport) : muted('Missing'), worst(c, 'mobile')),
    row('Headings', headingsVal, worst(c, 'headings')),
    row('Images', imgVal, worst(c, 'images')),
    row('Links', linksVal, worst(c, 'links')),
    row('hreflang', seo.hreflang.length ? `${seo.hreflang.length} alternates` : muted('None'), seo.hreflang.length ? worst(c, 'hreflang') : null),
    row('Structured data', schemaVal, schema.counts.errors ? 'error' : schema.counts.warnings ? 'warning' : schema.blocks.length ? 'ok' : null),
    row('Word count', s.wordCount != null ? s.wordCount.toLocaleString() : '—', null),
    s.author && row('Author', esc(s.author), null),
    s.publisher && row('Publisher', esc(s.publisher), null),
    s.generator && row('Generator', esc(s.generator), null),
    s.keywords && row('Keywords', esc(s.keywords), 'info'),
    s.themeColor && row('Theme color', `<span class="swatch" style="background:${esc(s.themeColor)}"></span>${mono(s.themeColor)}`, null),
    s.amp && row('AMP', link(s.amp), null),
    s.prev && row('rel=prev', link(s.prev), null),
    s.next && row('rel=next', link(s.next), null),
  ].filter(Boolean);

  const checks = [...c].sort(bySeverity);
  return `${banner}
    <div class="section-label">Google search preview</div>${serpPreview(state)}
    <div class="card kv">${rows.join('')}</div>
    ${renderHreflang(state)}
    <div class="section-label">Checks · ${plural(seo.counts.errors, 'error')}, ${plural(seo.counts.warnings, 'warning')}</div>
    ${checks.length ? `<div class="card">${issueList(checks, { area: true })}</div>` : empty('<p>No on-page issues found.</p>')}`;
}

// ---------------------------------------------------------------------------

export function renderHeadings(state) {
  const { items, counts } = state.seo.headings;
  const stats = `<div class="stat-grid">${counts.map((n, i) => `<div class="stat-box${i === 0 && n !== 1 ? ' warn' : ''}"><div class="stat-n">${n}</div><div class="stat-l">H${i + 1}</div></div>`).join('')}</div>`;
  if (!items.length) return stats + empty('<p>No headings on this page.</p>');
  const checks = state.seo.checks.filter((c) => c.area === 'headings');
  const list = items
    .map((h, i) => {
      const flags = [!h.text && '<span class="tag bad">empty</span>', h.hidden && '<span class="tag">hidden</span>', h.skip && '<span class="tag warn">skipped level</span>'].filter(Boolean).join(' ');
      return `<button class="hrow" data-hl="heading" data-index="${i}" style="padding-left:${8 + (h.level - 1) * 14}px" title="Scroll to this heading on the page">
        <span class="htag l${h.level}">H${h.level}</span><span class="htext">${h.text ? esc(h.text) : '<span class="muted">(empty)</span>'}</span>${flags}</button>`;
    })
    .join('');
  return `${stats}${checks.length ? `<div class="card">${issueList(checks)}</div>` : ''}
    <div class="row-actions"><span class="muted">Click a heading to find it on the page.</span><button class="link-btn" data-copy="headings">Copy outline</button></div>
    <div class="card list">${list}</div>`;
}

// ---------------------------------------------------------------------------

const IMAGE_FILTERS = {
  all: () => true,
  noalt: (i) => i.flags.includes('no alt'),
  emptyalt: (i) => i.flags.includes('empty alt'),
  filealt: (i) => i.flags.includes('filename alt'),
  nodims: (i) => i.flags.includes('no width/height'),
};

export function filteredImages(state) {
  return state.seo.images.items.filter(IMAGE_FILTERS[state.imageFilter]);
}

export function renderImages(state) {
  const imgs = state.seo.images;
  const n = (f) => imgs.items.filter(IMAGE_FILTERS[f]).length;
  const filterBar = chips(
    [
      ['all', `All · ${imgs.items.length}`],
      ['noalt', `No alt · ${n('noalt')}`],
      ['emptyalt', `Empty alt · ${n('emptyalt')}`],
      ['filealt', `Filename alt · ${n('filealt')}`],
      ['nodims', `No size attrs · ${n('nodims')}`],
    ],
    state.imageFilter,
    'data-image-filter',
  );
  const checks = state.seo.checks.filter((c) => c.area === 'images');
  const list = filteredImages(state);
  if (!imgs.items.length) return empty('<p>No images on this page.</p>');
  const rows = list
    .slice(0, MAX_ROWS)
    .map((img) => {
      const i = imgs.items.indexOf(img);
      const file = img.src.startsWith('data:') ? 'data: URI' : img.src.split('?')[0].split('/').pop() || img.src;
      const alt = img.alt === null ? '<span class="bad-text">no alt attribute</span>' : img.alt.trim() ? esc(img.alt) : '<span class="muted">alt=""</span>';
      const dims = img.width ? `${img.width}×${img.height}${img.displayWidth && img.displayWidth !== img.width ? ` (shown ${img.displayWidth}×${img.displayHeight})` : ''}` : 'not loaded';
      const flags = img.flags.filter((f) => f !== 'no alt' && f !== 'empty alt').map((f) => `<span class="tag ${f === 'filename alt' ? 'warn' : ''}">${esc(f)}</span>`);
      if (img.hidden) flags.push('<span class="tag">hidden</span>');
      if (img.loading === 'lazy') flags.push('<span class="tag">lazy</span>');
      return `<button class="irow" data-hl="image" data-index="${i}" title="Scroll to this image on the page">
        <span class="thumb">${img.src ? `<img src="${esc(img.src)}" alt="" loading="lazy">` : ''}</span>
        <span class="imeta"><span class="ialt">${alt}</span><span class="isub" title="${esc(img.src)}">${esc(file)} · ${esc(dims)}</span>${flags.length ? `<span class="tags">${flags.join(' ')}</span>` : ''}</span>
      </button>`;
    })
    .join('');
  const more = list.length > MAX_ROWS ? `<p class="hint">Showing ${MAX_ROWS} of ${list.length}.</p>` : '';
  const capped = imgs.total > imgs.items.length ? `<p class="hint">The page has ${imgs.total} images; the first ${imgs.items.length} were collected.</p>` : '';
  return `${checks.length ? `<div class="card">${issueList(checks)}</div>` : ''}${filterBar}
    <div class="row-actions"><span class="muted">Click an image to find it on the page.</span><button class="link-btn" data-copy="images">Copy CSV</button></div>
    ${list.length ? `<div class="card list">${rows}</div>` : empty('<p>No images match this filter.</p>')}${more}${capped}`;
}

// ---------------------------------------------------------------------------

const LINK_FILTERS = {
  all: () => true,
  internal: (l) => l.kind === 'internal',
  external: (l) => l.kind === 'external',
  nofollow: (l) => l.nofollow || l.sponsored || l.ugc,
  issues: (l, s) => l.emptyText || l.staging || l.insecure || (s.get(l.href)?.status ?? 200) >= 400 || s.get(l.href)?.error,
  other: (l) => l.kind !== 'internal' && l.kind !== 'external',
};

export function filteredLinks(state) {
  return state.seo.links.items.filter((l) => LINK_FILTERS[state.linkFilter](l, state.linkStatus));
}

function statusTag(st) {
  if (!st) return '';
  if (st.pending) return '<span class="tag">…</span>';
  if (st.error) return `<span class="tag bad" title="${esc(st.error)}">failed</span>`;
  const cls = st.status >= 400 ? 'bad' : st.status >= 300 || st.redirected ? 'warn' : 'ok';
  return `<span class="tag ${cls}" title="${st.redirected ? `redirects to ${esc(st.finalUrl)}` : ''}">${st.status}${st.redirected ? ' →' : ''}</span>`;
}

export function renderLinks(state) {
  const { items, stats } = state.seo.links;
  if (!items.length) return empty('<p>No links on this page.</p>');
  const n = (f) => items.filter((l) => LINK_FILTERS[f](l, state.linkStatus)).length;
  const statBoxes = `<div class="stat-grid five">${[
    ['Total', stats.total],
    ['Unique', stats.unique],
    ['Internal', stats.internal],
    ['External', stats.external],
    ['Nofollow', stats.nofollow],
  ]
    .map(([l, v]) => `<div class="stat-box"><div class="stat-n">${v}</div><div class="stat-l">${l}</div></div>`)
    .join('')}</div>`;
  const filterBar = chips(
    [
      ['all', `All · ${items.length}`],
      ['internal', `Internal · ${n('internal')}`],
      ['external', `External · ${n('external')}`],
      ['nofollow', `Nofollow/sponsored · ${n('nofollow')}`],
      ['issues', `Issues · ${n('issues')}`],
      ['other', `Other · ${n('other')}`],
    ],
    state.linkFilter,
    'data-link-filter',
  );
  const checks = state.seo.checks.filter((c) => c.area === 'links');
  const list = filteredLinks(state);
  const checked = [...state.linkStatus.values()].filter((s) => !s.pending);
  const broken = checked.filter((s) => s.error || s.status >= 400).length;
  const checkLabel = state.linkCheckRunning ? `Checking… ${checked.length}/${state.linkCheckTotal}` : checked.length ? `Re-check status (${broken} broken)` : 'Check link status';
  const rows = list
    .slice(0, MAX_ROWS)
    .map((l) => {
      const label = l.text || (l.imgAlt ? `[img] ${l.imgAlt}` : '') || (l.ariaLabel ? `[aria] ${l.ariaLabel}` : '');
      const tags = [
        l.kind !== 'internal' && `<span class="tag">${esc(l.kind)}</span>`,
        l.nofollow && '<span class="tag warn">nofollow</span>',
        l.sponsored && '<span class="tag">sponsored</span>',
        l.ugc && '<span class="tag">ugc</span>',
        l.emptyText && '<span class="tag bad">no text</span>',
        l.staging && '<span class="tag bad">staging host</span>',
        l.insecure && '<span class="tag warn">http</span>',
        l.target === '_blank' && '<span class="tag">new tab</span>',
        l.hidden && '<span class="tag">hidden</span>',
        statusTag(state.linkStatus.get(l.href)),
      ].filter(Boolean);
      return `<div class="lrow"><div class="ltext">${label ? esc(label) : '<span class="muted">(no anchor text)</span>'}</div>
        <a class="lhref" href="${esc(l.href)}" target="_blank" rel="noopener" title="${esc(l.href)}">${esc(l.href)}</a>
        ${tags.length ? `<div class="tags">${tags.join(' ')}</div>` : ''}</div>`;
    })
    .join('');
  const more = list.length > MAX_ROWS ? `<p class="hint">Showing ${MAX_ROWS} of ${list.length}. Copy CSV for the full list.</p>` : '';
  return `${statBoxes}${checks.length ? `<div class="card">${issueList(checks)}</div>` : ''}${filterBar}
    <div class="row-actions"><button class="link-btn" data-check-links ${state.linkCheckRunning ? 'disabled' : ''}>${checkLabel}</button><button class="link-btn" data-copy="links">Copy CSV</button></div>
    ${list.length ? `<div class="card list">${rows}</div>` : empty('<p>No links match this filter.</p>')}${more}`;
}

// ---------------------------------------------------------------------------

export function renderSocial(state) {
  const { og, twitter } = state.seo.social;
  const s = state.seo.summary;
  const first = (obj, k) => obj[k]?.[0];
  const title = first(og, 'title') || s.title;
  const desc = first(og, 'description') || s.description;
  const image = first(og, 'image') || first(og, 'image:url') || first(og, 'image:secure_url');
  const domain = hostOf(first(og, 'url') || state.page.url).replace(/^www\./, '');
  const tw = {
    card: first(twitter, 'card') || 'summary',
    title: first(twitter, 'title') || title,
    desc: first(twitter, 'description') || desc,
    image: first(twitter, 'image') || first(twitter, 'image:src') || image,
  };
  const img = state.ogImage;
  const relative = image && !/^https?:\/\//i.test(image);
  const imgOk = image && !relative && !img?.error;
  const imgNote = !image
    ? '<span class="bad-text">No og:image; shares will have no picture.</span>'
    : relative
      ? `<span class="bad-text">og:image is relative ("${esc(image)}"); social platforms can't load it.</span>`
      : img?.pending
      ? 'Loading image…'
      : img?.error
        ? `<span class="bad-text">og:image failed to load.</span>`
        : img
          ? `${img.w}×${img.h}px${img.w < 1200 || img.h < 630 ? ' · <span class="warn-text">below the recommended 1200×630</span>' : ' · good size'}${Math.abs(img.w / img.h - 1.91) > 0.15 ? ' · <span class="warn-text">not ~1.91:1, may be cropped</span>' : ''}`
          : '';

  const fb = `<div class="share-card">
      ${imgOk ? `<div class="share-img"><img src="${esc(image)}" alt=""></div>` : `<div class="share-img none">${image ? 'Image can\'t be loaded' : 'No image'}</div>`}
      <div class="share-body"><div class="share-domain">${esc(domain.toUpperCase())}</div><div class="share-title">${esc(title || '(no title)')}</div><div class="share-desc">${esc(desc || '')}</div></div>
    </div><p class="hint">${imgNote}</p>`;

  const large = tw.card === 'summary_large_image';
  const x = `<div class="x-card ${large ? 'large' : 'small'}">
      ${tw.image && /^https?:\/\//i.test(tw.image) && !(tw.image === image && img?.error) ? `<div class="x-img"><img src="${esc(tw.image)}" alt=""></div>` : '<div class="x-img none"></div>'}
      <div class="x-body"><div class="x-domain">${esc(domain)}</div><div class="x-title">${esc(tw.title || '')}</div>${large ? '' : `<div class="x-desc">${esc(tw.desc || '')}</div>`}</div>
    </div><p class="hint">twitter:card = ${mono(first(twitter, 'card') || '(none, defaults to summary)')}</p>`;

  const table = (prefix, obj) => {
    const keys = Object.keys(obj);
    if (!keys.length) return empty(`<p>No ${esc(prefix)} tags.</p>`);
    return `<div class="card kv">${keys
      .flatMap((k) => obj[k].map((v) => row(`${prefix}${k}`, /^https?:\/\//.test(v) ? link(v) : esc(v), null)))
      .join('')}</div>`;
  };
  const checks = state.seo.checks.filter((c) => c.area === 'social');
  return `${checks.length ? `<div class="card">${issueList(checks)}</div>` : ''}
    <div class="section-label">Facebook / LinkedIn / Slack</div>${fb}
    <div class="section-label">X (Twitter)</div>${x}
    <div class="section-label">Open Graph tags</div>${table('og:', og)}
    <div class="section-label">Twitter tags</div>${table('twitter:', twitter)}`;
}

// ---------------------------------------------------------------------------

export function renderHreflang(state) {
  const list = state.seo.hreflang;
  if (!list.length) return '';
  const checks = state.seo.checks.filter((c) => c.area === 'hreflang');
  return `<div class="section-label">hreflang · ${list.length}</div>${checks.length ? `<div class="card">${issueList(checks)}</div>` : ''}
    <div class="card kv">${list.map((h) => row(h.lang, `${link(h.href)}${h.self ? ' <span class="tag ok">this page</span>' : ''}`, h.valid ? null : 'error')).join('')}</div>`;
}

export function renderTools(state) {
  const url = state.page.url;
  const u = new URL(url);
  const e = encodeURIComponent(url);
  const robots = state.robots;
  const sitemaps = robots?.sitemaps?.length ? robots.sitemaps : [`${u.origin}/sitemap.xml`];
  const groups = [
    ['Google', [
      ['Rich Results Test', `https://search.google.com/test/rich-results?url=${e}`],
      ['PageSpeed Insights', `https://pagespeed.web.dev/analysis?url=${e}`],
      ['Indexed? (site: search)', `https://www.google.com/search?q=${encodeURIComponent(`site:${url.split('#')[0]}`)}`],
      ['Search Console', 'https://search.google.com/search-console'],
    ]],
    ['Validators', [
      ['Schema.org Validator', `https://validator.schema.org/#url=${e}`],
      ['W3C HTML validator', `https://validator.w3.org/nu/?doc=${e}`],
      ['W3C CSS validator', `https://jigsaw.w3.org/css-validator/validator?uri=${e}`],
      ['Security headers', `https://securityheaders.com/?q=${e}&followRedirects=on`],
    ]],
    ['Social', [
      ['Facebook Sharing Debugger', `https://developers.facebook.com/tools/debug/?q=${e}`],
      ['LinkedIn Post Inspector', `https://www.linkedin.com/post-inspector/inspect/${e}`],
    ]],
    ['Site files', [
      ['robots.txt', `${u.origin}/robots.txt`],
      ...sitemaps.map((s) => [`Sitemap: ${s.replace(u.origin, '') || s}`, s]),
      ['llms.txt', `${u.origin}/llms.txt`],
      ['Wayback Machine', `https://web.archive.org/web/*/${url}`],
    ]],
  ];
  const robotsInfo = state.robotsPending
    ? muted('checking robots.txt…')
    : robots?.text != null
      ? `robots.txt found (${plural(robots.groups, 'group')}, ${plural(robots.sitemaps.length, 'sitemap')}). Googlebot ${state.seo.summary.robotsTxt?.allowed === false ? `<strong class="bad-text">blocked</strong> by ${mono(state.seo.summary.robotsTxt.rule)}` : 'allowed'} for this URL.`
      : muted(robots?.error || 'No robots.txt found.');
  const scanQuery = new URLSearchParams([['site', u.origin], ...(robots?.sitemaps || []).map((s) => ['sitemap', s])]);
  const scanCard = `<div class="card tools"><a class="tool" data-scan-sitemap href="../scan/scan.html?${esc(scanQuery)}" target="_blank" rel="noopener">Scan sitemap: check every page on this site<span>→</span></a></div>`;
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|\[::1\])|\.(local|test|localhost)$/.test(u.hostname);
  return `${isLocal ? '<p class="hint">This is a local/private host that online tools can\'t reach. For structured data, copy the JSON-LD from Schema → Source and paste it into the Rich Results Test\'s Code tab.</p>' : ''}
    <div class="card"><div class="card-head"><div class="grow">${robotsInfo}</div></div></div>
    ${scanCard}
    ${groups.map(([name, items]) => `<div class="section-label">${esc(name)}</div><div class="card tools">${items.map(([label, href]) => `<a class="tool" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}<span>↗</span></a>`).join('')}</div>`).join('')}`;
}
