// Changes tab: before/after snapshots of this page, and a comparison against another URL
// (usually the Webflow staging ↔ live counterpart).
import { esc, plural, sev, hostOf } from './ui.js';
import { timeAgo } from '../lib/diff.js';

const MAX_VALUE = 220;

function fmt(v) {
  if (v === null || v === undefined) return '<span class="muted">(none)</span>';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return esc(s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s);
}

const signed = (n) => (n > 0 ? `+${n}` : `−${-n}`);

/** Renders a diffSnapshots() result. */
export function renderDiff(diff) {
  if (!diff.total) return '<div class="card-note">No differences in title, meta tags, headings, links, images, structured data or issues.</div>';
  const parts = [];
  const counts = diff.metrics.filter((m) => m.key === 'errors' || m.key === 'warnings');
  const fixed = diff.issues.fixed.length;
  const added = diff.issues.introduced.length;
  parts.push(`<div class="diff-summary">${plural(diff.total, 'change')}${fixed ? ` · <span class="ok-text">${fixed} fixed</span>` : ''}${added ? ` · <span class="bad-text">${added} new issue${added === 1 ? '' : 's'}</span>` : ''}${counts.map((m) => ` · ${esc(m.label)} ${m.before} → ${m.after}`).join('')}</div>`);

  if (diff.fields.length) {
    parts.push(`<div class="diff-group">${diff.fields
      .map((f) => `<div class="drow"><div class="dlabel">${esc(f.label)}</div><div class="dvals"><div class="dold">${fmt(f.before)}</div><div class="dnew">${fmt(f.after)}</div></div></div>`)
      .join('')}</div>`);
  }

  const { added: hAdded, removed: hRemoved } = diff.headings;
  if (hAdded.length || hRemoved.length) {
    const line = (h, kind) => `<div class="dline ${kind}"><span class="dmark">${kind === 'add' ? '+' : '−'}</span><span class="htag l${h.level}">H${h.level}</span> ${h.text ? esc(h.text) : '<span class="muted">(empty)</span>'}</div>`;
    parts.push(`<div class="diff-group"><div class="dhead">Headings</div>${hRemoved.map((h) => line(h, 'del')).join('')}${hAdded.map((h) => line(h, 'add')).join('')}</div>`);
  }

  const metrics = diff.metrics.filter((m) => m.key !== 'errors' && m.key !== 'warnings');
  if (metrics.length) {
    parts.push(`<div class="diff-group"><div class="dhead">Counts</div>${metrics
      .map((m) => `<div class="dline"><span class="dmark"></span>${esc(m.label)} ${m.before} → ${m.after} <span class="tag ${m.delta > 0 ? 'ok' : 'warn'}">${signed(m.delta)}</span></div>`)
      .join('')}</div>`);
  }

  for (const b of diff.blocks) {
    const types = b.types?.length ? ` · ${esc(b.types.join(', '))}` : '';
    const head = `<div class="dhead">${esc(b.label)}${types} <span class="tag ${b.status === 'removed' ? 'bad' : b.status === 'added' ? 'ok' : ''}">${b.status}</span></div>`;
    const rows = b.changes.map((c) => {
      const mark = { added: '+', removed: '−', changed: '~' }[c.kind];
      const cls = { added: 'add', removed: 'del', changed: 'chg' }[c.kind];
      const val = c.kind === 'added' ? fmt(c.after) : c.kind === 'removed' ? fmt(c.before) : `<span class="dold">${fmt(c.before)}</span> → <span class="dnew">${fmt(c.after)}</span>`;
      return `<div class="dline ${cls}"><span class="dmark">${mark}</span><div><div class="dpath">${esc(c.path)}</div><div class="dval">${val}</div></div></div>`;
    });
    if (b.parse) rows.push(`<div class="dline chg"><span class="dmark">~</span><div>JSON ${b.parse.after ? `stopped parsing: ${esc(b.parse.after)}` : 'parses again'}</div></div>`);
    parts.push(`<div class="diff-group">${head}${rows.join('')}</div>`);
  }

  const issueRow = (i, fixedRow) => `<li class="issue">${fixedRow ? sev('ok') : sev(i.severity)}<div><span class="area lc">${esc(i.area)}</span> ${esc(i.message)}</div></li>`;
  if (fixed) parts.push(`<div class="diff-group"><div class="dhead">Fixed issues</div><ul class="issues">${diff.issues.fixed.map((i) => issueRow(i, true)).join('')}</ul></div>`);
  if (added) parts.push(`<div class="diff-group"><div class="dhead">New issues</div><ul class="issues">${diff.issues.introduced.map((i) => issueRow(i, false)).join('')}</ul></div>`);
  return `<div class="diff">${parts.join('')}</div>`;
}

function snapshotSection(state) {
  const list = state.snapshots;
  const snap = list[state.snapshotIndex];
  const diff = state.snapshotDiff;
  const saveBtn = '<button class="btn" data-save-snapshot>Save snapshot</button>';
  if (!snap) {
    return `<div class="card"><div class="card-head"><div class="grow">
      <div class="card-title">No snapshot of this page</div>
      <div class="hint flush">Save one before you edit. After you publish, this tab shows what changed.</div>
    </div>${saveBtn}</div></div>`;
  }
  const picker =
    list.length > 1
      ? `<select class="snap-select" data-snapshot-select aria-label="Compare against snapshot">${list
          .map((s, i) => `<option value="${i}" ${i === state.snapshotIndex ? 'selected' : ''}>${esc(timeAgo(s.takenAt))} · ${esc(new Date(s.takenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</option>`)
          .join('')}</select>`
      : `<span>Saved ${esc(timeAgo(snap.takenAt))}</span>`;
  return `<div class="card" id="snapshot-card"><div class="card-head"><div class="grow">
      <div class="card-title">${diff.total ? `Changed since snapshot (${esc(timeAgo(snap.takenAt))})` : 'No changes since snapshot'}</div>
      <div class="card-sub">${picker}</div>
    </div>${saveBtn}</div>
    ${renderDiff(diff)}
    <div class="card-foot"><button class="link-btn" data-delete-snapshots>Delete ${list.length === 1 ? 'snapshot' : `${list.length} snapshots`} of this page</button></div>
  </div>`;
}

function compareSection(state) {
  const c = state.compare;
  const suggestion = state.compareSuggestion;
  const value = c.input ?? suggestion?.url ?? '';
  const hint = suggestion
    ? suggestion.reason === 'mapping'
      ? `Suggested from your ${suggestion.role === 'staging' ? 'staging → live' : 'live → staging'} host pair.`
      : 'Suggested from this staging page\'s canonical URL.'
    : 'Paste a URL, e.g. the same path on staging (*.webflow.io) or live. Add a host pair below to fill this in automatically.';
  let result = '';
  if (c.pending) result = `<div class="card-note">Loading ${esc(c.pending)} in a background tab…</div>`;
  else if (c.error) result = `<div class="card-note bad-note">${esc(c.error)}</div>`;
  else if (c.result) {
    const r = c.result;
    const redirected = r.loadedUrl && r.loadedUrl !== r.requestedUrl ? `<div class="hint flush">Loaded ${esc(r.loadedUrl)} (redirected).</div>` : '';
    const offer = r.offerPair ? `<div class="card-foot"><button class="link-btn" data-save-pair="${esc(r.offerPair.staging)}|${esc(r.offerPair.production)}">Remember ${esc(r.offerPair.staging)} ↔ ${esc(r.offerPair.production)} as staging ↔ live</button></div>` : '';
    result = `<div class="compare-head"><span class="mono">${esc(r.beforeLabel)}</span> → <span class="mono">${esc(r.afterLabel)}</span>${redirected}${r.aliased ? `<div class="hint flush">Staging URLs are shown on ${esc(r.aliased)} so only content differences appear.</div>` : ''}</div>
      ${renderDiff(state.compareDiff)}${offer}`;
  }
  return `<div class="card" id="compare-card">
    <form class="compare-form" data-compare-form>
      <input type="url" id="compare-url" required placeholder="https://…" value="${esc(value)}" aria-label="URL to compare with">
      <button class="btn" type="submit" ${c.pending ? 'disabled' : ''}>Compare</button>
    </form>
    <div class="hint pad">${hint}</div>
    ${result}
  </div>`;
}

function pairsSection(state) {
  const pairs = state.hostPairs;
  const toggle = `<button class="link-btn" data-toggle-pairs>${state.showPairs ? 'Hide' : 'Edit'} staging ↔ live hosts${pairs.length ? ` (${pairs.length})` : ''}</button>`;
  if (!state.showPairs) return `<div class="row-actions">${toggle}</div>`;
  const rows = pairs
    .map((p, i) => `<div class="pair-row"><span class="mono">${esc(p.staging)}</span><span class="muted">↔</span><span class="mono">${esc(p.production)}</span><button class="link-btn" data-remove-pair="${i}" aria-label="Remove pair">Remove</button></div>`)
    .join('');
  const d = state.pairDraft;
  return `<div class="row-actions">${toggle}</div>
    <div class="card">
      ${rows ? `<div class="list">${rows}</div>` : '<div class="hint pad">No host pairs yet.</div>'}
      <form class="pair-form" data-pair-form>
        <input id="pair-staging" placeholder="yoursite.webflow.io" value="${esc(d.staging)}" aria-label="Staging host">
        <span class="muted">↔</span>
        <input id="pair-production" placeholder="www.yoursite.com" value="${esc(d.production)}" aria-label="Live host">
        <button class="btn" type="submit">Add</button>
      </form>
    </div>`;
}

export function renderChanges(state) {
  const host = hostOf(state.page.url);
  return `<div class="section-label">Snapshot · ${esc(host)}${esc(new URL(state.page.url).pathname)}</div>
    ${snapshotSection(state)}
    <div class="section-label">Compare with another URL</div>
    ${compareSection(state)}
    ${pairsSection(state)}`;
}
