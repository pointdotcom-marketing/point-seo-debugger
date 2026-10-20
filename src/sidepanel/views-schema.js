// Schema tab: Google rich result eligibility, schema.org issues, and the raw JSON-LD (plus Microdata
// and RDFa items, shown as the JSON-LD they were converted to).
import { esc, plural, issueList, chips, empty, provTag } from './ui.js';

const STATUS_LABEL = {
  valid: 'Eligible',
  warnings: 'Eligible · warnings',
  invalid: 'Not eligible',
  deprecated: 'No longer shown',
  restricted: 'Limited',
};
const STATUS_ORDER = { invalid: 0, warnings: 1, valid: 2, restricted: 3, deprecated: 4 };
const FORMAT_LABEL = { jsonld: 'JSON-LD', microdata: 'Microdata', rdfa: 'RDFa' };
const formatTag = (format) => `<span class="format-tag ${esc(format)}">${FORMAT_LABEL[format] || esc(format)}</span>`;
// JSON-LD blocks come first in schema.blocks, in page order, so b.index lines up with the comparison.
const blockProv = (state, b) => (b.format === 'jsonld' ? state.rendering?.blocks[b.index] : null);

export function schemaIssues(result) {
  return [...result.pageIssues, ...result.blocks.flatMap((b) => b.issues), ...result.features.flatMap((f) => f.issues)];
}

export function renderSchema(state) {
  const r = state.schema;
  const issueCount = schemaIssues(r).filter((i) => i.severity !== 'info').length;
  const nav = chips(
    [
      ['google', `Rich results · ${r.features.length}`],
      ['issues', `Issues · ${issueCount}`],
      ['source', `Source · ${r.blocks.length}`],
    ],
    state.schemaView,
    'data-schema-view',
  );
  const body = { google: renderGoogle, issues: renderIssues, source: renderSource }[state.schemaView](state);
  return nav + body;
}

function renderGoogle(state) {
  const r = state.schema;
  if (!r.features.length) {
    const types = [...new Set(r.blocks.flatMap((b) => b.types))];
    return `${empty(`<p><strong>No Google rich result types found.</strong></p>
      ${types.length ? `<p>Types on this page:</p><div class="types center">${types.map((t) => `<span class="type-tag">${esc(t)}</span>`).join('')}</div>` : `<p>${r.blocks.length ? 'The structured data here has no recognizable types.' : 'This page has no structured data.'}</p>`}`)}${issueList(r.pageIssues)}`;
  }
  const effective = (f) => (f.featureStatus === 'active' || (f.featureStatus === 'restricted' && f.status === 'invalid') ? f.status : f.featureStatus);
  return [...r.features]
    .sort((a, b) => STATUS_ORDER[effective(a)] - STATUS_ORDER[effective(b)])
    .map((f) => {
      const chip = effective(f);
      const source = r.blocks[f.block];
      const sub = [f.entityType, f.entityName && `“${f.entityName}”`, f.blockLabel].filter(Boolean).join(' · ');
      return `<article class="card">
        <div class="card-head">
          <div class="grow"><div class="card-title">${esc(f.name)} ${formatTag(source.format)}${provTag(blockProv(state, source))}</div><div class="card-sub" title="${esc(f.path)}">${esc(sub)}</div></div>
          <span class="chip ${chip}">${STATUS_LABEL[chip]}</span>
        </div>
        ${f.statusNote ? `<div class="card-note">${esc(f.statusNote)}</div>` : ''}
        ${issueList(f.issues)}
        ${f.docs ? `<div class="card-foot"><a href="${esc(f.docs)}" target="_blank" rel="noopener">Google's ${esc(f.name)} docs ↗</a></div>` : ''}
      </article>`;
    })
    .join('');
}

function renderIssues(state) {
  const r = state.schema;
  const filters = state.schemaFilters;
  const counts = { error: 0, warning: 0, info: 0 };
  schemaIssues(r).forEach((i) => counts[i.severity]++);
  const bar = `<div class="filters">${['error', 'warning', 'info']
    .map((s) => `<button class="filter" data-sev-filter="${s}" aria-pressed="${filters.has(s)}">${plural(counts[s], s === 'info' ? 'note' : s)}</button>`)
    .join('')}</div>`;
  const keep = (list) => list.filter((i) => filters.has(i.severity));
  const sections = [];
  if (keep(r.pageIssues).length) sections.push(`<div class="section-label">Page</div><div class="card">${issueList(keep(r.pageIssues))}</div>`);
  for (const b of r.blocks) {
    const items = keep(b.issues);
    if (items.length) sections.push(`<div class="section-label">${esc(b.label)} · ${esc(b.types.join(', ') || 'untyped')} <span class="lc">(in &lt;${esc(b.location || '?')}&gt;)</span></div><div class="card">${issueList(items)}</div>`);
  }
  for (const f of r.features) {
    const items = keep(f.issues);
    if (items.length) sections.push(`<div class="section-label">Google · ${esc(f.name)} (${esc(f.blockLabel)})</div><div class="card">${issueList(items)}</div>`);
  }
  if (!sections.length) sections.push(empty('<p>No issues for the selected filters.</p>'));
  return bar + sections.join('');
}

export function highlightJson(json) {
  return esc(json).replace(
    /(&quot;)((?:\\.|(?!&quot;)[^\\])*)(&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, q, _body, _q2, colon, lit) => {
      if (colon) return `<span class="k">${m.slice(0, -colon.length)}</span>${colon}`;
      if (q) return `<span class="s">${m}</span>`;
      if (lit) return `<span class="l">${m}</span>`;
      return `<span class="n">${m}</span>`;
    },
  );
}

function renderRaw(text, badLine) {
  return text
    .split('\n')
    .map((line, i) => `<span class="line${i + 1 === badLine ? ' bad' : ''}"><span class="ln">${i + 1}</span>${esc(line) || ' '}</span>`)
    .join('');
}

function renderSource(state) {
  const r = state.schema;
  if (!r.blocks.length && !state.rendering?.removedBlocks.length) return empty('<p>This page has no JSON-LD, Microdata or RDFa.</p>');
  return (
    `<div class="row-actions"><button class="link-btn" data-copy-all-ld>Copy all as &lt;script&gt; tags</button></div>` +
    r.blocks
      .map((b) => {
        const errs = b.issues.filter((i) => i.severity === 'error').length;
        const warns = b.issues.filter((i) => i.severity === 'warning').length;
        const body = b.parseError ? renderRaw(b.text, b.parseError.location?.line) : highlightJson(JSON.stringify(b.data, null, 2));
        const prov = blockProv(state, b);
        return `<article class="card">
          <div class="card-head">
            <div class="grow"><div class="card-title">${esc(b.label)} ${formatTag(b.format)}${provTag(prov)}</div>
              <div class="card-sub">${esc(b.types.join(', ') || 'untyped')} · in &lt;${esc(b.location || '?')}&gt; · ${plural(errs, 'error')}, ${plural(warns, 'warning')}</div></div>
            <button class="link-btn" data-copy-block="${b.index}">Copy</button>
          </div>
          ${b.format === 'jsonld' ? '' : `<div class="card-note">Converted from ${FORMAT_LABEL[b.format]} to the equivalent JSON-LD.</div>`}
          <pre class="code">${body}</pre>
          ${prov?.status === 'changed' ? `<details class="card-note server-version"><summary>Server HTML version</summary><pre class="code">${renderRaw(prov.raw.trim())}</pre></details>` : ''}
        </article>`;
      })
      .join('') +
    (state.rendering?.removedBlocks || [])
      .map(
        (b) => `<article class="card">
          <div class="card-head"><div class="grow"><div class="card-title">Server HTML block ${formatTag('jsonld')}${provTag({ status: 'removed' })}</div>
            <div class="card-sub">${esc(b.types.join(', ') || 'untyped')} · not on the rendered page</div></div></div>
          <pre class="code">${renderRaw(b.text.trim())}</pre>
        </article>`,
      )
      .join('')
  );
}
