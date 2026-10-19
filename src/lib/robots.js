// robots.txt parsing and matching, following Google's documented rules:
// https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt
// - The most specific user-agent group wins (exact token match, else "*"); matching groups merge.
// - Within a group the longest matching rule wins; on a tie, allow wins.
// - "*" matches any sequence, "$" anchors the end.

export function parseRobots(txt) {
  const groups = [];
  const sitemaps = [];
  // Non-standard lines (Content-Signal, Content-Usage, Crawl-delay…) with the group they appear in.
  const directives = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(txt).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') sitemaps.push(value);
    else if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ allow: key === 'allow', path: value });
    else directives.push({ key, value, agents: current ? [...current.agents] : [] });
  }
  return { groups, sitemaps, directives };
}

function ruleMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/** @returns {{allowed: boolean, rule: string|null, group: string}} */
export function robotsAllows(txt, url, userAgent = 'googlebot') {
  const { groups } = typeof txt === 'string' ? parseRobots(txt) : txt;
  const ua = userAgent.toLowerCase();
  let matched = groups.filter((g) => g.agents.includes(ua));
  let groupName = ua;
  if (!matched.length) {
    matched = groups.filter((g) => g.agents.includes('*'));
    groupName = '*';
  }
  const u = new URL(url);
  const path = decodeURIComponentSafe(u.pathname) + u.search;
  let best = null;
  for (const rule of matched.flatMap((g) => g.rules)) {
    if (!ruleMatches(rule.path, path) && !ruleMatches(rule.path, u.pathname + u.search)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return {
    allowed: !best || best.allow,
    rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null,
    group: matched.length ? groupName : null,
  };
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
