import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAiAccess, parseSignals, classifyProbe, robotsSnippet, AI_BOTS } from '../src/lib/ai-crawlers.js';
import { parseRobots } from '../src/lib/robots.js';

const URL_ = 'https://example.com/blog/post';
const run = (txt, extra = {}) => analyzeAiAccess({ url: URL_, robots: txt == null ? { error: 'none', status: 404 } : { parsed: parseRobots(txt) }, ...extra });
const bot = (r, token) => r.bots.find((b) => b.token === token);

test('no robots.txt: everything allowed', () => {
  const r = run(null);
  assert.ok(r.robotsMissing);
  assert.ok(r.bots.every((b) => b.allowed));
  assert.equal(r.checks.length, 0);
});

test('named groups, wildcard fallback, and per-purpose counts', () => {
  const r = run(`User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\n`);
  assert.equal(bot(r, 'GPTBot').allowed, false);
  assert.equal(bot(r, 'GPTBot').via, 'named');
  assert.equal(bot(r, 'OAI-SearchBot').allowed, true);
  assert.equal(bot(r, 'OAI-SearchBot').via, 'wildcard');
  assert.equal(r.byPurpose.training.allowed, r.byPurpose.training.total - 2);
  assert.match(r.checks.map((c) => c.message).join('\n'), /Opted out of AI training for: GPTBot, ClaudeBot/);
  assert.match(r.operators.find((o) => o.name === 'OpenAI').summary, /can cite this page in AI answers, won't train on it/);
});

test('blocking AI search bots is a warning; blocking Googlebot is an error', () => {
  let r = run(`User-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /blog/\n`);
  const warn = r.checks.find((c) => c.severity === 'warning');
  assert.match(warn.message, /OAI-SearchBot, PerplexityBot/);
  r = run(`User-agent: Googlebot\nDisallow: /\n`);
  assert.ok(r.checks.some((c) => c.severity === 'error' && /AI Overviews/.test(c.message)));
});

test('Applebot falls back to Googlebot rules when it has no group', () => {
  const r = run(`User-agent: Googlebot\nDisallow: /blog/\n\nUser-agent: *\nAllow: /\n`);
  assert.equal(bot(r, 'Applebot').allowed, false);
  assert.equal(bot(r, 'Applebot').via, 'fallback');
});

test('user-triggered agents note that robots.txt may be ignored', () => {
  const r = run(`User-agent: ChatGPT-User\nUser-agent: Perplexity-User\nDisallow: /\n`);
  assert.match(r.checks.map((c) => c.message).join('\n'), /ChatGPT-User, Perplexity-User may still fetch/);
});

test('robots.txt 5xx means disallow-all', () => {
  const r = analyzeAiAccess({ url: URL_, robots: { error: 'x', status: 503 } });
  assert.ok(r.bots.every((b) => !b.allowed));
  assert.equal(r.checks[0].severity, 'error');
});

test('Content-Signal, Content-Usage, legacy tokens, meta directives, llms.txt', () => {
  const r = run(
    `User-agent: *\nContent-Signal: search=yes, ai-train=no\nContent-Usage: /blog/ train-ai=n\nAllow: /\n\nUser-agent: anthropic-ai\nDisallow: /\n`,
    { robotsDirectives: ['nosnippet', 'max-snippet:50', 'noarchive'], contentUsageHeader: 'train-ai=n', llms: { status: 200, text: '# Example\n> Summary\n\n## Docs\n- [A](https://example.com/a)\n' }, dataNosnippet: 2 },
  );
  assert.deepEqual(r.contentSignals[0].prefs, { search: 'yes', 'ai-train': 'no' });
  assert.deepEqual(r.contentSignals[0].agents, ['*']);
  assert.equal(r.contentUsage.length, 2);
  assert.equal(r.contentUsage[0].path, '/blog/');
  assert.deepEqual(r.contentUsage[0].prefs, { 'train-ai': 'n' });
  assert.ok(r.checks.some((c) => /"anthropic-ai"/.test(c.message)));
  assert.deepEqual(r.metaEffects.map((m) => m.directive), ['nosnippet', 'noarchive', 'max-snippet:50', 'data-nosnippet ×2']);
  assert.deepEqual(r.llms, { found: true, title: 'Example', links: 1, bytes: r.llms.bytes });
});

test('llms.txt that is really an HTML page counts as missing', () => {
  const r = run('', { llms: { status: 200, text: '<!doctype html><html>' } });
  assert.equal(r.llms.found, false);
});

test('parseSignals and classifyProbe', () => {
  assert.deepEqual(parseSignals('search=yes, ai-input=no'), { search: 'yes', 'ai-input': 'no' });
  assert.equal(classifyProbe({ status: 200, bodyStart: '<html>ok' }).outcome, 'served');
  assert.equal(classifyProbe({ status: 403 }).outcome, 'blocked');
  assert.equal(classifyProbe({ status: 403, headers: { 'cf-mitigated': 'challenge' } }).outcome, 'challenged');
  assert.equal(classifyProbe({ status: 200, bodyStart: '<title>Just a moment...</title>' }).outcome, 'challenged');
  assert.equal(classifyProbe({ status: 429 }).label, 'Rate limited (429)');
});

test('robots.txt snippet never blocks Googlebot, Bingbot or Applebot', () => {
  for (const p of ['block-training', 'block-all-ai']) {
    const s = robotsSnippet(p);
    assert.doesNotMatch(s, /User-agent: (Googlebot|bingbot|Applebot)\n/);
    assert.match(s, /User-agent: GPTBot/);
  }
  assert.doesNotMatch(robotsSnippet('block-training'), /OAI-SearchBot/);
  const r = run(robotsSnippet('block-training'));
  assert.equal(r.byPurpose.training.allowed, 0);
  assert.equal(r.byPurpose.search.allowed, r.byPurpose.search.total);
});

test('every bot has a valid purpose and unique token', () => {
  const tokens = AI_BOTS.map((b) => b.token.toLowerCase());
  assert.equal(new Set(tokens).size, tokens.length);
  assert.ok(AI_BOTS.every((b) => ['training', 'search', 'user'].includes(b.purpose)));
});
