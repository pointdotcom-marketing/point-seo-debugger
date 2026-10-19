// Network side of the AI tab: llms.txt, the Content-Usage header, and live probes that re-fetch
// the page with each AI bot's User-Agent (set via a temporary declarativeNetRequest session rule).
import { AI_BOTS, probeUserAgent, classifyProbe } from '../lib/ai-crawlers.js';

const PROBE_RULE_BASE = 7000;

async function fetchWithTimeout(url, init = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function readStart(res, max = 6000) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (text.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text.slice(0, max);
}

/** llms.txt and the page's Content-Usage response header. */
export async function loadAiFiles(url) {
  const origin = new URL(url).origin;
  const [llms, contentUsage] = await Promise.all([
    (async () => {
      try {
        const res = await fetchWithTimeout(`${origin}/llms.txt`, { credentials: 'omit' });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, text: res.ok && !/html/i.test(type) ? (await res.text()).slice(0, 200000) : null };
      } catch {
        return { status: 0, text: null };
      }
    })(),
    (async () => {
      try {
        const res = await fetchWithTimeout(url, { method: 'HEAD', credentials: 'include' });
        return res.headers.get('content-usage');
      } catch {
        return null;
      }
    })(),
  ]);
  return { llms, contentUsage };
}

async function probeOnce(url, userAgent, ruleId) {
  const marker = `__pseo_probe=${Date.now().toString(36)}${ruleId}`;
  const probeUrl = `${url.split('#')[0]}${url.includes('?') ? '&' : '?'}${marker}`;
  if (userAgent) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'user-agent', operation: 'set', value: userAgent }] },
          condition: { urlFilter: marker, resourceTypes: ['xmlhttprequest', 'other'] },
        },
      ],
    });
  }
  try {
    const res = await fetchWithTimeout(probeUrl, { credentials: 'omit' });
    const headers = Object.fromEntries(['cf-mitigated', 'server', 'x-robots-tag'].map((h) => [h, res.headers.get(h) || '']));
    const bodyStart = await readStart(res);
    return { status: res.status, redirected: res.redirected, headers, ...classifyProbe({ status: res.status, headers, bodyStart }) };
  } catch (e) {
    return { outcome: 'error', label: e.name === 'AbortError' ? 'Timed out' : 'Request failed' };
  } finally {
    if (userAgent) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }
}

/**
 * Fetch the page as a normal browser, then as each AI bot. Calls onResult(token, result) as each
 * finishes; token "browser" is the baseline.
 */
export async function probeBots(url, onResult) {
  onResult('browser', await probeOnce(url, null, PROBE_RULE_BASE));
  const queue = AI_BOTS.filter((b) => !b.controlOnly);
  let n = 0;
  const worker = async () => {
    while (queue.length) {
      const bot = queue.shift();
      const ruleId = PROBE_RULE_BASE + 1 + (n++ % 1000);
      onResult(bot.token, await probeOnce(url, probeUserAgent(bot), ruleId));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}
