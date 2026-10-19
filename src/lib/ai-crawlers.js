// AI crawler access: which AI bots robots.txt lets fetch this URL, plus the other signals site
// owners use to steer AI use (Content-Signal, aipref Content-Usage, robots meta, llms.txt).
// Bot list verified against each operator's docs on 2026-10-19 unless marked `unverified`.
import { robotsAllows } from './robots.js';

// purpose: 'training' = collects data to train models
//          'search'   = indexes pages to cite in AI answers / AI search
//          'user'     = fetches a page live because a user asked (often ignores robots.txt)
// controlOnly: a robots.txt token with no crawler of its own (the operator's main crawler checks it)
export const AI_BOTS = [
  { operator: 'OpenAI', token: 'GPTBot', purpose: 'training', product: 'Model training', docs: 'https://developers.openai.com/api/docs/bots', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.4; +https://openai.com/gptbot' },
  { operator: 'OpenAI', token: 'OAI-SearchBot', purpose: 'search', product: 'ChatGPT search', docs: 'https://developers.openai.com/api/docs/bots', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot' },
  { operator: 'OpenAI', token: 'ChatGPT-User', purpose: 'user', product: 'ChatGPT browsing, GPTs, Actions', docs: 'https://developers.openai.com/api/docs/bots', mayIgnoreRobots: true, ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },

  { operator: 'Anthropic', token: 'ClaudeBot', purpose: 'training', product: 'Model training', docs: 'https://support.claude.com/en/articles/8896518', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
  { operator: 'Anthropic', token: 'Claude-SearchBot', purpose: 'search', product: 'Claude search results', docs: 'https://support.claude.com/en/articles/8896518' },
  { operator: 'Anthropic', token: 'Claude-User', purpose: 'user', product: 'Claude fetching a page for a user', docs: 'https://support.claude.com/en/articles/8896518' },

  { operator: 'Google', token: 'Google-Extended', purpose: 'training', product: 'Gemini training and grounding (not AI Overviews)', controlOnly: true, docs: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers' },
  { operator: 'Google', token: 'Googlebot', purpose: 'search', product: 'Google Search, AI Overviews, AI Mode', jsRendering: true, docs: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.0.0 Safari/537.36' },
  { operator: 'Google', token: 'Google-CloudVertexBot', purpose: 'search', product: 'Vertex AI Agents (site-owner requested)', docs: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers' },
  { operator: 'Google', token: 'Google-Agent', purpose: 'user', product: 'Google agents acting for users', mayIgnoreRobots: true, docs: 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers' },

  { operator: 'Perplexity', token: 'PerplexityBot', purpose: 'search', product: 'Perplexity answers (not used for training)', docs: 'https://docs.perplexity.ai/guides/bots', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { operator: 'Perplexity', token: 'Perplexity-User', purpose: 'user', product: 'Perplexity fetching a page for a user', mayIgnoreRobots: true, docs: 'https://docs.perplexity.ai/guides/bots', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)' },

  { operator: 'Apple', token: 'Applebot', purpose: 'search', product: 'Siri, Spotlight, Safari suggestions', fallback: 'googlebot', jsRendering: true, docs: 'https://support.apple.com/en-us/119829', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)' },
  { operator: 'Apple', token: 'Applebot-Extended', purpose: 'training', product: 'Apple Intelligence model training', controlOnly: true, docs: 'https://support.apple.com/en-us/119829' },

  { operator: 'Meta', token: 'meta-externalagent', purpose: 'training', product: 'Meta AI model training', docs: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/', ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { operator: 'Meta', token: 'meta-webindexer', purpose: 'search', product: 'Meta AI search and citations', docs: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/' },
  { operator: 'Meta', token: 'meta-externalfetcher', purpose: 'user', product: 'Meta AI fetching a link for a user', mayIgnoreRobots: true, docs: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/' },

  { operator: 'Amazon', token: 'Amazonbot', purpose: 'training', product: 'Amazon models and services', docs: 'https://developer.amazon.com/amazonbot', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1) Chrome/130.0.0.0 Safari/537.36' },
  { operator: 'Amazon', token: 'Amzn-SearchBot', purpose: 'search', product: 'Alexa / Rufus answers (not used for training)', docs: 'https://developer.amazon.com/amazonbot' },
  { operator: 'Amazon', token: 'Amzn-User', purpose: 'user', product: 'Alexa fetching a page for a user', mayIgnoreRobots: true, docs: 'https://developer.amazon.com/amazonbot' },

  { operator: 'Microsoft', token: 'bingbot', purpose: 'search', product: 'Bing and Copilot answers', docs: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0', ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },

  { operator: 'Mistral', token: 'MistralAI-Training', purpose: 'training', product: 'Mistral model training', docs: 'https://docs.mistral.ai/robots' },
  { operator: 'Mistral', token: 'MistralAI-Index', purpose: 'search', product: 'Le Chat search index', docs: 'https://docs.mistral.ai/robots' },
  { operator: 'Mistral', token: 'MistralAI-User', purpose: 'user', product: 'Le Chat fetching a page for a user', docs: 'https://docs.mistral.ai/robots' },

  { operator: 'DuckDuckGo', token: 'DuckAssistBot', purpose: 'search', product: 'DuckAssist answers (not used for training)', docs: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot', ua: 'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)' },
  { operator: 'You.com', token: 'YouBot', purpose: 'search', product: 'You.com answers', docs: 'https://you.com/docs/youbot' },

  { operator: 'Common Crawl', token: 'CCBot', purpose: 'training', product: 'Open web dataset used to train many LLMs', docs: 'https://commoncrawl.org/ccbot', ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
  { operator: 'ByteDance', token: 'Bytespider', purpose: 'training', product: 'Doubao and other ByteDance models', unverified: true, note: 'robots.txt compliance is disputed', ua: 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)' },
];

// Old tokens that still show up in robots.txt files; worth recognizing so they aren't flagged as unknown.
export const LEGACY_TOKENS = {
  'anthropic-ai': 'Old Anthropic token; ClaudeBot is the current training crawler.',
  'claude-web': 'Old Anthropic token; Claude-User / Claude-SearchBot are current.',
  facebookbot: 'Old Meta token; meta-externalagent is the current training crawler.',
  'cohere-ai': 'Cohere documents no active crawlers today.',
  'google-notebooklm': 'Replaced by Google-GeminiNotebook (supported until Aug 2026).',
};

export const PURPOSES = {
  training: { label: 'Model training', short: 'Training', blurb: 'collects pages to train AI models' },
  search: { label: 'AI search & answers', short: 'AI search', blurb: 'indexes pages so AI answers can cite and link them' },
  user: { label: 'User-triggered fetches', short: 'User fetch', blurb: 'loads a page live when someone asks an assistant about it' },
};

// ---------------------------------------------------------------------------

function verdictFor(bot, parsed, url) {
  if (!parsed) return { allowed: true, via: 'none', rule: null };
  const token = bot.token.toLowerCase();
  let r = robotsAllows(parsed, url, token);
  let via = r.group === token ? 'named' : r.group === '*' ? 'wildcard' : 'none';
  // Applebot follows Googlebot's rules when robots.txt has no Applebot group.
  if (via !== 'named' && bot.fallback && parsed.groups.some((g) => g.agents.includes(bot.fallback))) {
    r = robotsAllows(parsed, url, bot.fallback);
    via = 'fallback';
  }
  return { allowed: r.allowed, via, rule: r.rule };
}

/** "search=yes, ai-train=no" -> { search: 'yes', 'ai-train': 'no' } */
export function parseSignals(value) {
  const out = {};
  for (const part of String(value).split(/[,;]/)) {
    const m = part.trim().match(/^([a-z][a-z0-9-]*)\s*=\s*([a-z0-9?]+)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return out;
}

function parseContentUsage(value) {
  // robots.txt form: "Content-Usage: [path] train-ai=n"; header form has no path.
  const m = String(value).trim().match(/^(\/\S*)?\s*(.*)$/);
  return { path: m[1] || '/', prefs: parseSignals(m[2]) };
}

const ROBOTS_META_EFFECTS = {
  noindex: 'Excluded from Google, Bing and AI search indexes.',
  none: 'Same as noindex, nofollow.',
  nosnippet: 'Google keeps this page out of AI Overviews / AI Mode as direct input; Apple keeps it out of Apple Intelligence answers.',
  noarchive: 'Bing/Copilot won\'t show or cite it in chat answers or train on it; Amazon won\'t train on it. (Google ignores noarchive.)',
  nocache: 'Bing/Copilot only use the URL, title and snippet.',
  noai: 'Non-standard; no major AI operator documents honoring it.',
  noimageai: 'Non-standard; no major AI operator documents honoring it.',
};

/**
 * @param {object} input
 * @param {string} input.url
 * @param {{parsed?: object, error?: string, status?: number}|null} input.robots   parsed robots.txt (null = still loading)
 * @param {string[]} [input.robotsDirectives]  meta robots + googlebot + bingbot + X-Robots-Tag directives, lowercased
 * @param {string|null} [input.contentUsageHeader]
 * @param {{status: number, text?: string}|null} [input.llms]
 * @param {number} [input.dataNosnippet]
 */
export function analyzeAiAccess({ url, robots, robotsDirectives = [], contentUsageHeader = null, llms = null, dataNosnippet = 0 }) {
  const parsed = robots?.parsed || null;
  const robotsUnreachable = robots && !parsed && robots.status >= 500;
  const bots = AI_BOTS.map((bot) => {
    const v = robotsUnreachable ? { allowed: false, via: 'unreachable', rule: null } : verdictFor(bot, parsed, url);
    return { ...bot, ...v };
  });

  const byPurpose = {};
  for (const p of Object.keys(PURPOSES)) {
    const list = bots.filter((b) => b.purpose === p);
    byPurpose[p] = { total: list.length, allowed: list.filter((b) => b.allowed).length };
  }

  const operators = [...new Set(bots.map((b) => b.operator))].map((name) => {
    const list = bots.filter((b) => b.operator === name);
    return { name, bots: list, summary: operatorSummary(name, list) };
  });

  const checks = [];
  const add = (severity, message) => checks.push({ area: 'ai', severity, message });
  if (robotsUnreachable) add('error', `robots.txt returned HTTP ${robots.status}. Crawlers treat a 5xx robots.txt as "disallow everything" until it recovers.`);
  const blockedSearch = bots.filter((b) => b.purpose === 'search' && !b.allowed);
  if (blockedSearch.some((b) => b.token === 'Googlebot')) add('error', 'Googlebot is blocked, so this page can\'t appear in Google Search, AI Overviews or AI Mode.');
  const otherSearch = blockedSearch.filter((b) => b.token !== 'Googlebot');
  if (otherSearch.length) add('warning', `Blocked for AI search crawlers: ${otherSearch.map((b) => b.token).join(', ')}. This page can't be cited or linked in those AI answers.`);
  const blockedTraining = bots.filter((b) => b.purpose === 'training' && !b.allowed);
  if (blockedTraining.length) add('info', `Opted out of AI training for: ${blockedTraining.map((b) => b.token).join(', ')}.`);
  const blockedUser = bots.filter((b) => b.purpose === 'user' && !b.allowed);
  if (blockedUser.some((b) => b.mayIgnoreRobots)) add('info', `${blockedUser.filter((b) => b.mayIgnoreRobots).map((b) => b.token).join(', ')} may still fetch this page: user-triggered agents can ignore robots.txt.`);

  // Unknown or legacy agent names in robots.txt.
  const known = new Set([...AI_BOTS.map((b) => b.token.toLowerCase()), '*']);
  const legacy = [];
  for (const g of parsed?.groups || []) {
    for (const a of g.agents) if (LEGACY_TOKENS[a] && !legacy.some((l) => l.token === a)) legacy.push({ token: a, note: LEGACY_TOKENS[a] });
  }
  for (const l of legacy) add('info', `robots.txt names "${l.token}": ${l.note}`);

  // Content-Signal (Cloudflare) and Content-Usage (IETF aipref) preferences.
  const contentSignals = (parsed?.directives || [])
    .filter((d) => d.key === 'content-signal')
    .map((d) => ({ agents: d.agents, prefs: parseSignals(d.value), raw: d.value }));
  const contentUsage = [
    ...(parsed?.directives || []).filter((d) => d.key === 'content-usage').map((d) => ({ source: 'robots.txt', agents: d.agents, ...parseContentUsage(d.value), raw: d.value })),
    ...(contentUsageHeader ? [{ source: 'header', agents: ['*'], ...parseContentUsage(contentUsageHeader), raw: contentUsageHeader }] : []),
  ];

  const metaEffects = robotsDirectives
    .map((d) => d.split(':')[0])
    .filter((d, i, all) => ROBOTS_META_EFFECTS[d] && all.indexOf(d) === i)
    .map((d) => ({ directive: d, effect: ROBOTS_META_EFFECTS[d] }));
  const maxSnippet = robotsDirectives.find((d) => d.startsWith('max-snippet:'));
  if (maxSnippet) metaEffects.push({ directive: maxSnippet, effect: 'Limits how much text Google can quote, including in AI Overviews / AI Mode.' });
  if (dataNosnippet) metaEffects.push({ directive: `data-nosnippet ×${dataNosnippet}`, effect: 'Those sections are kept out of Google snippets; Google doesn\'t say whether this also applies to AI features.' });

  let llmsInfo = null;
  if (llms) {
    if (llms.status === 200 && llms.text != null && !/^\s*</.test(llms.text)) {
      const h1 = llms.text.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
      const links = (llms.text.match(/\]\(([^)]+)\)/g) || []).length;
      llmsInfo = { found: true, title: h1, links, bytes: llms.text.length };
      if (!h1) add('info', 'llms.txt has no "# Title" line; the llms.txt proposal starts with an H1.');
    } else {
      llmsInfo = { found: false, status: llms.status };
    }
  }

  return { bots, byPurpose, operators, contentSignals, contentUsage, metaEffects, llms: llmsInfo, checks, robotsMissing: !!robots && !parsed && !robotsUnreachable };
}

function operatorSummary(name, bots) {
  const get = (p) => bots.filter((b) => b.purpose === p);
  const parts = [];
  const search = get('search');
  const training = get('training');
  if (search.length) parts.push(search.every((b) => b.allowed) ? 'can cite this page in AI answers' : search.some((b) => b.allowed) ? 'partly allowed for AI answers' : 'can\'t cite this page in AI answers');
  if (training.length) parts.push(training.every((b) => b.allowed) ? 'may train on it' : training.some((b) => b.allowed) ? 'partly opted out of training' : 'won\'t train on it');
  const user = get('user');
  if (user.length && user.every((b) => !b.allowed)) parts.push(user.some((b) => b.mayIgnoreRobots) ? 'user fetches blocked (may be ignored)' : 'user fetches blocked');
  return `${name} ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------

/** robots.txt lines for a few common policies, for handing to whoever edits robots.txt. */
export function robotsSnippet(policy) {
  const tokens = (p) => AI_BOTS.filter((b) => b.purpose === p && b.token !== 'Googlebot' && b.token !== 'bingbot' && b.token !== 'Applebot').map((b) => b.token);
  const block = (list, comment) => [`# ${comment}`, ...list.map((t) => `User-agent: ${t}`), 'Disallow: /', ''].join('\n');
  if (policy === 'block-training') return block(tokens('training'), 'Opt out of AI model training; AI search and user fetches stay allowed.');
  if (policy === 'block-all-ai') return block([...tokens('training'), ...tokens('search'), ...tokens('user')], 'Block AI crawlers (training, AI search, and user fetches). Google Search, Bing and Apple search crawlers are not affected.');
  return '# Allow all AI crawlers: no rules needed. Make sure no "User-agent: *  Disallow: /" applies to them.\n';
}

// ---------------------------------------------------------------------------

/** The User-Agent used when probing as this bot: its published UA, else a generic one with its token. */
export function probeUserAgent(bot) {
  return bot.ua || `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${bot.token}/1.0)`;
}

/** Classify a response to a bot-user-agent probe. */
export function classifyProbe({ status, headers = {}, bodyStart = '' }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (h['cf-mitigated'] === 'challenge' || /just a moment|cf-chl|challenge-platform|attention required|captcha|access denied|are you a robot/i.test(bodyStart)) {
    return { outcome: 'challenged', label: status === 200 ? 'Challenge page' : `Challenge (${status})` };
  }
  if (status === 401 || status === 403) return { outcome: 'blocked', label: `Blocked (${status})` };
  if (status === 429) return { outcome: 'blocked', label: 'Rate limited (429)' };
  if (status >= 500) return { outcome: 'error', label: `Server error (${status})` };
  if (status >= 300 && status < 400) return { outcome: 'redirect', label: `Redirect (${status})` };
  if (status >= 400) return { outcome: 'error', label: `HTTP ${status}` };
  return { outcome: 'served', label: `Served (${status})` };
}
