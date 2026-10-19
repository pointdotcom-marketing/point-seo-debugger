// Keeps the toolbar badge in sync with each tab's on-page SEO + structured data, and opens the
// side panel on click.
import { analyzePage } from './lib/validator.js';
import { analyzeSeo } from './lib/seo.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'seo-lens:page' || !sender.tab?.id) return;
  const schema = analyzePage(msg.data);
  const seo = msg.data.seo ? analyzeSeo(msg.data.seo, msg.data.url) : null;
  updateBadge(sender.tab.id, schema, seo);
});

function updateBadge(tabId, schema, seo) {
  const errors = schema.counts.errors + (seo?.counts.errors ?? 0);
  const warnings = schema.counts.warnings + (seo?.counts.warnings ?? 0);
  let text = '✓';
  let color = '#188038';
  if (errors) {
    text = errors > 99 ? '99+' : String(errors);
    color = '#d93025';
  } else if (warnings) {
    text = warnings > 99 ? '99+' : String(warnings);
    color = '#b06000';
  }
  const lines = [
    'Point SEO Debugger',
    seo && !seo.summary.indexable ? 'NOT INDEXABLE' : null,
    `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} (on-page checks)`,
    `${schema.counts.blocks} JSON-LD block${schema.counts.blocks === 1 ? '' : 's'}, ${schema.features.length} rich result item${schema.features.length === 1 ? '' : 's'}`,
    schema.counts.microdata ? `${schema.counts.microdata} Microdata item${schema.counts.microdata === 1 ? '' : 's'}` : null,
    schema.counts.rdfa ? `${schema.counts.rdfa} RDFa item${schema.counts.rdfa === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: lines.join('\n') }).catch(() => {});
}
