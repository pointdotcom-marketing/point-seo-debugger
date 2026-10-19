// AI tab: which AI crawlers may use this page, other AI-use signals, live UA probes, and a robots.txt snippet.
import { PURPOSES, robotsSnippet } from '../lib/ai-crawlers.js';
import { esc, issueList, chips, empty, plural } from './ui.js';

const VIA = {
  named: 'its own robots.txt group',
  wildcard: 'the User-agent: * group',
  fallback: 'Googlebot\'s rules (Applebot falls back to them)',
  none: 'no matching rules',
  unreachable: 'robots.txt is erroring',
};

function probeTag(result, baseline) {
  if (!result) return '';
  if (result.pending) return '<span class="tag">testing…</span>';
  const cls = result.outcome === 'served' ? 'ok' : result.outcome === 'redirect' ? 'warn' : 'bad';
  const differs = baseline && baseline.outcome === 'served' && result.outcome !== 'served';
  return `<span class="tag ${cls}" title="${differs ? 'The same URL was served normally to a regular browser request.' : ''}">${esc(result.label)}</span>`;
}

function botRow(bot, state) {
  const probe = state.aiProbes?.get(bot.token);
  const notes = [
    bot.controlOnly && 'robots.txt token only; checked by the operator\'s main crawler',
    bot.mayIgnoreRobots && 'user-triggered; may ignore robots.txt',
    bot.jsRendering && 'renders JavaScript',
    bot.unverified && 'no official docs',
    bot.note,
  ].filter(Boolean);
  return `<div class="bot-row">
    <div class="bot-main">
      <span class="mono bot-token">${esc(bot.token)}</span>
      <span class="tag purpose-${bot.purpose}">${PURPOSES[bot.purpose].short}</span>
      <span class="grow"></span>
      <span class="tag ${bot.allowed ? 'ok' : 'bad'}">${bot.allowed ? 'Allowed' : 'Blocked'}</span>
      ${probeTag(probe, state.aiProbes?.get('browser'))}
    </div>
    <div class="bot-sub">${esc(bot.product)} · via ${esc(VIA[bot.via])}${bot.rule ? ` <span class="mono">${esc(bot.rule)}</span>` : ''}${notes.length ? ` · ${esc(notes.join(' · '))}` : ''}${bot.docs ? ` · <a href="${esc(bot.docs)}" target="_blank" rel="noopener">docs</a>` : ''}</div>
  </div>`;
}

function signalsSection(ai) {
  const rows = [];
  for (const s of ai.contentSignals) {
    const prefs = Object.entries(s.prefs).map(([k, v]) => `<span class="tag ${v === 'no' ? 'bad' : 'ok'}">${esc(k)}=${esc(v)}</span>`).join(' ');
    rows.push(`<div class="kv-row"><div class="kv-k">Content-Signal</div><div class="kv-v">${prefs || `<span class="mono">${esc(s.raw)}</span>`}<div class="kv-meta">robots.txt, for ${esc(s.agents.join(', ') || 'all agents')}. Cloudflare's preference format; omitted signals mean "no preference". Not enforced by itself.</div></div></div>`);
  }
  for (const u of ai.contentUsage) {
    const prefs = Object.entries(u.prefs).map(([k, v]) => `<span class="tag ${v === 'n' ? 'bad' : 'ok'}">${esc(k)}=${esc(v)}</span>`).join(' ');
    rows.push(`<div class="kv-row"><div class="kv-k">Content-Usage</div><div class="kv-v">${prefs || `<span class="mono">${esc(u.raw)}</span>`}<div class="kv-meta">${u.source === 'header' ? 'HTTP header' : `robots.txt (${esc(u.path)})`}. IETF aipref draft; not yet a standard.</div></div></div>`);
  }
  for (const m of ai.metaEffects) {
    rows.push(`<div class="kv-row"><div class="kv-k mono">${esc(m.directive)}</div><div class="kv-v">${esc(m.effect)}</div></div>`);
  }
  if (ai.llms) {
    rows.push(
      `<div class="kv-row"><div class="kv-k">llms.txt</div><div class="kv-v">${
        ai.llms.found
          ? `Found${ai.llms.title ? `: “${esc(ai.llms.title)}”` : ''} · ${plural(ai.llms.links, 'link')}`
          : `<span class="muted">Not found${ai.llms.status ? ` (HTTP ${ai.llms.status})` : ''}</span>`
      }<div class="kv-meta">A community proposal. Google says Search ignores it, and no major AI operator documents reading it.</div></div></div>`,
    );
  }
  if (!rows.length) return '';
  return `<div class="section-label">Other AI-use signals</div><div class="card kv">${rows.join('')}</div>`;
}

export function renderAi(state) {
  const ai = state.ai;
  if (!ai) return empty('<p>Loading robots.txt…</p>');
  const stat = (p) => {
    const { allowed, total } = ai.byPurpose[p];
    const cls = allowed === total ? 'ok' : allowed === 0 ? 'bad' : 'warn';
    return `<div class="stat-box ai-${cls}"><div class="stat-n">${allowed}/${total}</div><div class="stat-l">${PURPOSES[p].short} allowed</div></div>`;
  };
  const robotsNote = state.robotsPending
    ? '<p class="hint">Checking robots.txt…</p>'
    : ai.robotsMissing
      ? '<p class="hint">No robots.txt on this site, so every crawler is allowed by default.</p>'
      : '';

  const operators = ai.operators
    .map((op) => `<article class="card"><div class="card-head"><div class="grow"><div class="card-title">${esc(op.name)}</div><div class="card-sub wrap">${esc(op.summary)}</div></div></div><div class="list">${op.bots.map((b) => botRow(b, state)).join('')}</div></article>`)
    .join('');

  const probes = state.aiProbes;
  const baseline = probes?.get('browser');
  const probedBots = probes ? [...probes.entries()].filter(([k, v]) => k !== 'browser' && !v.pending) : [];
  const blockedProbes = probedBots.filter(([, v]) => v.outcome === 'blocked' || v.outcome === 'challenged');
  const probeSummary = !probes
    ? ''
    : state.aiProbeRunning
      ? `<p class="hint">Testing… ${probedBots.length} done.</p>`
      : `<p class="hint">Regular browser request: ${esc(baseline?.label || '—')}. ${blockedProbes.length ? `<strong class="bad-text">${blockedProbes.length} bot user agent${blockedProbes.length === 1 ? ' was' : 's were'} blocked or challenged</strong>: ${esc(blockedProbes.map(([k]) => k).join(', '))}.` : 'Every bot user agent was served the page.'}</p>`;

  return `<div class="stat-grid three">${['search', 'training', 'user'].map(stat).join('')}</div>
    ${robotsNote}
    ${ai.checks.length ? `<div class="card">${issueList(ai.checks)}</div>` : ''}
    <div class="card-note rounded">Most AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot, meta-externalagent…) don't run JavaScript. Anything added by scripts (text, links, JSON-LD, meta tags) is invisible to them. Googlebot and Applebot do render JavaScript.</div>

    <div class="section-label">Test with bot user agents</div>
    <div class="card"><div class="card-head"><div class="grow">
      <div>Re-fetch this URL with each bot's User-Agent to catch CDN/firewall blocks (e.g. Cloudflare's AI bot blocking) that robots.txt doesn't show.</div>
      <div class="card-sub wrap">Requests come from your network, not the bot's, so sites that verify bot IPs may treat them as impostors. A block here is a strong hint, not proof.</div>
      ${probeSummary}
    </div><button class="link-btn" data-ai-probe ${state.aiProbeRunning ? 'disabled' : ''}>${probes ? 'Re-test' : 'Run test'}</button></div></div>

    <div class="section-label">Who can use this page</div>
    ${operators}
    ${signalsSection(ai)}

    <div class="section-label">robots.txt rules</div>
    ${chips(
      [
        ['block-training', 'Block training only'],
        ['block-all-ai', 'Block all AI bots'],
        ['allow-all', 'Allow all'],
      ],
      state.aiPolicy,
      'data-ai-policy',
    )}
    <article class="card"><div class="card-head"><div class="grow card-sub wrap">Paste into robots.txt. Rules for Googlebot, Bingbot and Applebot aren't touched.</div><button class="link-btn" data-copy="ai-robots">Copy</button></div>
    <pre class="code">${esc(robotsSnippet(state.aiPolicy))}</pre></article>`;
}
