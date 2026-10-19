// Small rendering helpers shared by the side panel views.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const SEV_ICON = { error: '!', warning: '!', info: 'i', ok: '✓' };
export const sev = (s) => `<span class="sev ${s}" title="${s}">${SEV_ICON[s]}</span>`;

export function issueList(issues, { area = false } = {}) {
  if (!issues.length) return '';
  return `<ul class="issues">${issues
    .map(
      (i) => `<li class="issue">${sev(i.severity)}
        <div><div>${area && i.area ? `<span class="area">${esc(i.area)}</span> ` : ''}${esc(i.message)}</div>${i.path && i.path !== '(root)' ? `<div class="issue-path">${esc(i.path)}</div>` : ''}</div></li>`,
    )
    .join('')}</ul>`;
}

const SEV_ORDER = { error: 0, warning: 1, info: 2, ok: 3 };
export const bySeverity = (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity];

export function chips(items, active, attr = 'data-filter') {
  return `<div class="filters">${items
    .map(([key, label]) => `<button class="filter" ${attr}="${esc(key)}" aria-pressed="${key === active}">${esc(label)}</button>`)
    .join('')}</div>`;
}

/** A labelled meter: value / max, colored by whether it's over. */
export function meter(value, max, unit = 'px') {
  if (value == null) return '';
  const pct = Math.min(100, Math.round((value / max) * 100));
  const cls = value > max ? 'over' : value < max * 0.35 ? 'under' : 'good';
  return `<div class="meter ${cls}" title="${value}${unit} of ~${max}${unit}"><span style="width:${pct}%"></span></div>`;
}

export function csv(rows) {
  return rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

export async function copyText(text, btn) {
  await navigator.clipboard.writeText(text);
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = old), 1200);
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export const empty = (html) => `<div class="empty">${html}</div>`;
