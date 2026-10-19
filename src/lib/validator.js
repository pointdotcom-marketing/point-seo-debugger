// Parses JSON-LD blocks, checks them (and Microdata/RDFa items already converted to JSON-LD by
// markup.js) against the schema.org vocabulary, and runs Google's rich result rules (google-rules.js). Pure functions only, so it runs in the extension and in Node tests.
import * as vocab from './vocab.js';
import { GOOGLE_FEATURES } from './google-rules.js';
import { DATE_RE, DATETIME_RE, TIME_RE, DURATION_RE, isAbsoluteUrl } from './formats.js';

const KEYWORDS = new Set([
  '@context', '@type', '@id', '@graph', '@value', '@language', '@list', '@set', '@reverse',
  '@base', '@vocab', '@index', '@nest', '@included', '@direction', '@json', '@none',
]);

// Entities reached through these properties can be rich result features in their own right
// (e.g. WebPage.mainEntity -> FAQPage, WebPage.breadcrumb -> BreadcrumbList). Entities under
// other properties (author, publisher, brand...) are treated as supporting data.
const FEATURE_CONTAINERS = new Set(['mainEntity', 'breadcrumb', 'hasPart', 'itemListElement', 'item', 'subjectOf']);

const TEXT_LIKE = new Set(['Text', 'PronounceableText', 'CssSelectorType', 'XPathType']);
const PLACEHOLDER = /\{\{.*?\}\}|\{%|\[\[[^\]]*\]\]|\$\{[^}]*\}|^(todo|tbd|placeholder|lorem ipsum.*|undefined|null|nan|\[object object\])$/i;

/** "https://schema.org/Product" | "schema:Product" | "Product" -> "Product"; other vocabularies -> null. */
export function schemaName(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(?:https?:\/\/schema\.org\/|schema:)(.+)$/i);
  if (m) return m[1];
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.includes('/')) return null;
  return s.trim();
}

function contextIsSchemaOrg(ctx) {
  const ok = (s) => typeof s === 'string' && /^https?:\/\/(www\.)?schema\.org\/?$/i.test(s.trim());
  if (Array.isArray(ctx)) return ctx.some(contextIsSchemaOrg);
  if (ctx && typeof ctx === 'object') return ok(ctx['@vocab']);
  return ok(ctx);
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReference = (v) => isObject(v) && typeof v['@id'] === 'string' && Object.keys(v).every((k) => k === '@id');

export function typesOf(node) {
  return asArray(node?.['@type']).map(schemaName).filter(Boolean);
}

// ---------------------------------------------------------------------------
// JSON parsing with error location and a best-effort repair so the rest of the
// block can still be checked.

function locateError(message, text) {
  const lc = message.match(/line (\d+) column (\d+)/);
  if (lc) return { line: +lc[1], column: +lc[2] };
  const pos = message.match(/position (\d+)/);
  if (!pos) return null;
  const before = text.slice(0, +pos[1]);
  return { line: before.split('\n').length, column: +pos[1] - before.lastIndexOf('\n') };
}

export function repairJson(src) {
  const fixes = new Set();
  let text = src.trim();
  const wrapped = text.match(/^(?:<!--|<!\[CDATA\[)([\s\S]*?)(?:-->|\]\]>)$/);
  if (wrapped) {
    text = wrapped[1];
    fixes.add('removed an HTML comment / CDATA wrapper');
  }
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i++;
      } else if (c === '"') {
        inStr = false;
        out += c;
      } else if (c < ' ') {
        out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '';
        fixes.add('escaped raw line breaks/tabs inside strings');
      } else {
        out += c;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '“' || c === '”') {
      out += '"';
      inStr = true;
      // Find the matching closing curly quote and copy through it.
      const end = text.slice(i + 1).search(/[“”"]/);
      if (end >= 0) {
        out += text.slice(i + 1, i + 1 + end) + '"';
        i += end + 1;
        inStr = false;
      }
      fixes.add('replaced curly quotes (“ ”) with straight quotes');
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl - 1;
      fixes.add('removed // comments');
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      fixes.add('removed /* */ comments');
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      fixes.add('removed trailing commas');
    } else {
      out += c;
    }
  }
  return { text: out, fixes: [...fixes] };
}

export function parseBlock(text) {
  try {
    return { data: JSON.parse(text), error: null };
  } catch (e) {
    const error = { message: e.message.replace(/^JSON\.parse: /, ''), location: locateError(e.message, text), fixes: [] };
    const repaired = repairJson(text);
    try {
      const data = JSON.parse(repaired.text);
      error.fixes = repaired.fixes;
      return { data, error };
    } catch {
      return { data: null, error };
    }
  }
}

// ---------------------------------------------------------------------------
// Value checks against schema.org ranges.

function rangeLabel(ranges) {
  return ranges.length > 3 ? `${ranges.slice(0, 3).join(', ')}…` : ranges.join(' or ');
}

function checkString(prop, value, ranges, ctx, path) {
  const v = value.trim();
  if (!v) return ctx.issue('warning', 'empty-value', `"${prop}" is an empty string.`, path);
  if (PLACEHOLDER.test(v)) {
    ctx.issue('warning', 'placeholder', `"${prop}" looks like an unfilled template value: "${v.slice(0, 60)}".`, path);
  }
  if (ranges.some((r) => TEXT_LIKE.has(r))) return;

  const tests = [];
  if (ranges.includes('URL')) tests.push(() => isAbsoluteUrl(v));
  if (ranges.includes('DateTime')) tests.push(() => DATETIME_RE.test(v));
  if (ranges.includes('Date')) tests.push(() => DATE_RE.test(v) || DATETIME_RE.test(v));
  if (ranges.includes('Time')) tests.push(() => TIME_RE.test(v));
  if (ranges.some((r) => ['Number', 'Float', 'Integer'].includes(r))) tests.push(() => /^-?\d+(\.\d+)?$/.test(v));
  if (ranges.includes('Boolean')) tests.push(() => /^(true|false)$/i.test(v) || ['True', 'False'].includes(schemaName(v)));
  if (ranges.includes('Duration')) tests.push(() => DURATION_RE.test(v));
  const enums = ranges.filter(vocab.isEnumeration);
  if (enums.length) {
    tests.push(() => {
      const t = vocab.enumTypeOf(schemaName(v));
      return !!t && enums.some((e) => vocab.isSubtypeOf(t, e));
    });
  }
  // Only class-typed ranges (e.g. author: Person | Organization). A string is legal schema.org;
  // Google-specific rules decide whether it's good enough.
  if (!tests.length) return;
  if (tests.some((t) => t())) return;

  if (ranges.includes('URL') && !/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    return ctx.issue('warning', 'relative-url', `"${prop}" is a relative URL ("${v}"). Use an absolute URL.`, path);
  }
  if (enums.length) {
    const examples = vocab.enumMembersOf(enums[0]).slice(0, 4).map((m) => `https://schema.org/${m}`);
    return ctx.issue('warning', 'invalid-enum', `"${prop}" should be a ${enums[0]} value, e.g. ${examples.join(', ')}. Got "${v}".`, path);
  }
  if (ranges.includes('Duration')) {
    return ctx.issue('warning', 'invalid-duration', `"${prop}" should be an ISO 8601 duration like "PT1H30M". Got "${v}".`, path);
  }
  if (ranges.includes('Date') || ranges.includes('DateTime')) {
    return ctx.issue('warning', 'invalid-date', `"${prop}" should be an ISO 8601 date (e.g. "2026-03-14" or "2026-03-14T09:00:00-07:00"). Got "${v}".`, path);
  }
  ctx.issue('warning', 'invalid-value', `"${prop}" expects ${rangeLabel(ranges)}. Got "${v.slice(0, 60)}".`, path);
}

function checkValue(prop, value, ctx, path) {
  const ranges = vocab.propertyRanges(prop);
  if (value === null) return ctx.issue('warning', 'null-value', `"${prop}" is null.`, path);
  if (typeof value === 'string') return checkString(prop, value, ranges, ctx, path);
  if (typeof value === 'number') {
    if (!ranges.some((r) => ['Number', 'Integer', 'Float', 'Text', 'Quantity'].includes(r) || vocab.isSubtypeOf(r, 'Quantity'))) {
      ctx.issue('warning', 'invalid-value', `"${prop}" expects ${rangeLabel(ranges)}, got the number ${value}.`, path);
    } else if (ranges.length === 1 && ranges[0] === 'Integer' && !Number.isInteger(value)) {
      ctx.issue('warning', 'invalid-value', `"${prop}" expects a whole number, got ${value}.`, path);
    }
    return;
  }
  if (typeof value === 'boolean') {
    if (!ranges.includes('Boolean') && !ranges.includes('Text')) {
      ctx.issue('warning', 'invalid-value', `"${prop}" expects ${rangeLabel(ranges)}, got ${value}.`, path);
    }
    return;
  }
  if (Array.isArray(value)) return ctx.issue('warning', 'nested-array', `"${prop}" contains a nested array.`, path);
  if (!isObject(value) || '@value' in value || '@list' in value) return;

  const target = isReference(value) ? ctx.index.get(value['@id']) : value;
  if (!target) return; // Unresolved @id references to other pages are fine.
  const types = typesOf(target).filter(vocab.isKnownType);
  if (!types.length) {
    if (!isReference(value) && !('@type' in value)) {
      const hint = ranges.find((r) => !vocab.isDataType(r));
      ctx.issue('warning', 'missing-nested-type', `"${prop}" is an object without @type${hint ? ` (expected ${rangeLabel(ranges.filter((r) => !vocab.isDataType(r)))})` : ''}.`, path);
    }
    return;
  }
  const fits = types.some((t) => vocab.isSubtypeOf(t, 'Role') || ranges.some((r) => vocab.isSubtypeOf(t, r)));
  if (!fits && ranges.length) {
    ctx.issue('warning', 'type-mismatch', `"${prop}" expects ${rangeLabel(ranges)}, but got ${types.join('/')}.`, path);
  }
}

// ---------------------------------------------------------------------------
// Walking entities.

function joinPath(base, key, i) {
  const k = base ? `${base}.${key}` : key;
  return i === undefined ? k : `${k}[${i}]`;
}

function walkEntity(node, ctx, info) {
  const { path, parentProp, topLevel, parent } = info;
  if ('@value' in node || isReference(node)) return;

  const rawTypes = asArray(node['@type']);
  const types = [];
  for (const raw of rawTypes) {
    const name = schemaName(raw);
    if (typeof raw !== 'string') {
      ctx.issue('error', 'invalid-type', `@type must be a string, got ${JSON.stringify(raw)}.`, path);
    } else if (!name) {
      ctx.issue('info', 'external-type', `@type "${raw}" isn't a schema.org type; Google ignores it.`, path);
    } else if (!vocab.isKnownType(name)) {
      const s = vocab.suggestType(name);
      ctx.issue('error', 'unknown-type', `"${name}" is not a schema.org type.${s ? ` Did you mean "${s}"?` : ''}`, path);
    } else if (vocab.isDataType(name) || vocab.isEnumeration(name)) {
      ctx.issue('warning', 'datatype-as-type', `"${name}" is a data type / enumeration, not an entity type.`, path);
    } else {
      types.push(name);
    }
  }
  if (topLevel && !rawTypes.length) {
    const what = { microdata: 'itemscope has no itemtype', rdfa: 'typeof is empty' }[ctx.format] || 'Top-level item has no @type';
    ctx.issue('error', 'missing-type', `${what}, so Google can't tell what it describes.`, path);
  }

  const entity = { types, node, path: path || '(root)', block: ctx.block, blockLabel: ctx.label, parentProp, parent, topLevel };
  ctx.entities.push(entity);

  for (const [key, val] of Object.entries(node)) {
    if (key.startsWith('@')) {
      if (!KEYWORDS.has(key)) ctx.issue('warning', 'unknown-keyword', `"${key}" is not a JSON-LD keyword.`, joinPath(path, key));
      continue;
    }
    const prop = schemaName(key);
    const keyPath = joinPath(path, key);
    if (!prop) {
      ctx.issue('info', 'external-property', `"${key}" isn't a schema.org property; Google ignores it.`, keyPath);
      continue;
    }
    if (!vocab.isKnownProperty(prop)) {
      const s = vocab.suggestProperty(prop);
      ctx.issue('error', 'unknown-property', `"${prop}" is not a schema.org property.${s ? ` Did you mean "${s}"?` : ''}`, keyPath);
      continue;
    }
    const replacement = vocab.supersededBy(prop);
    if (replacement) ctx.issue('warning', 'superseded', `"${prop}" is superseded; use "${replacement}" instead.`, keyPath);
    if (types.length && !vocab.propertyAppliesTo(prop, types)) {
      ctx.issue('warning', 'property-domain', `"${prop}" is not a property of ${types.join('/')} in schema.org.`, keyPath);
    }
    const values = asArray(val);
    values.forEach((v, i) => {
      const p = Array.isArray(val) ? joinPath(path, key, i) : keyPath;
      checkValue(prop, v, ctx, p);
      if (isObject(v)) walkEntity(v, ctx, { path: p, parentProp: prop, topLevel: false, parent: entity });
    });
  }
}

function collectIds(value, index) {
  if (Array.isArray(value)) return value.forEach((v) => collectIds(v, index));
  if (!isObject(value)) return;
  if (typeof value['@id'] === 'string' && !isReference(value)) {
    // Merge repeated definitions the way Google does: later properties add to earlier ones.
    index.set(value['@id'], { ...(index.get(value['@id']) || {}), ...value });
  }
  Object.values(value).forEach((v) => collectIds(v, index));
}

function topLevelNodes(data, ctx) {
  const roots = Array.isArray(data) ? data : [data];
  const out = [];
  roots.forEach((root, i) => {
    const base = Array.isArray(data) ? `[${i}]` : '';
    if (!isObject(root)) {
      ctx.issue('error', 'not-an-object', 'JSON-LD must be an object (or an array of objects).', base || '(root)');
      return;
    }
    const hasContext = '@context' in root;
    if (!hasContext) {
      ctx.issue('error', 'missing-context', 'Missing "@context": "https://schema.org". Without it the types and properties have no meaning.', base || '(root)');
    } else if (!contextIsSchemaOrg(root['@context'])) {
      ctx.issue('warning', 'non-schema-context', `@context is ${JSON.stringify(root['@context']).slice(0, 80)}; Google expects "https://schema.org".`, joinPath(base, '@context'));
    }
    if (Array.isArray(root['@graph'])) {
      root['@graph'].forEach((n, j) => {
        if (isObject(n)) out.push({ node: n, path: joinPath(base, '@graph', j) });
      });
      const extra = Object.keys(root).filter((k) => k !== '@context' && k !== '@graph');
      if (extra.length) out.push({ node: Object.fromEntries(extra.map((k) => [k, root[k]])), path: base, partial: true });
    } else {
      out.push({ node: root, path: base });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Google rule evaluation.

/** Resolve a dotted path to a flat list of values, following @id references. */
export function getValues(node, path, index) {
  let current = [node];
  for (const seg of path.split('.')) {
    const next = [];
    for (const n of current) {
      const target = isReference(n) ? index.get(n['@id']) || n : n;
      if (!isObject(target)) continue;
      const key = Object.keys(target).find((k) => k === seg || schemaName(k) === seg);
      if (key === undefined) continue;
      for (const v of asArray(target[key])) {
        next.push(isReference(v) ? index.get(v['@id']) || v : v);
      }
    }
    current = next;
  }
  return current.filter((v) => v !== null && v !== undefined && !(typeof v === 'string' && !v.trim()));
}

function describeRequirement(req) {
  return Array.isArray(req) ? req.map((r) => `"${r}"`).join(' or ') : `"${req}"`;
}

/** Each segment of a path must exist; nested segments are checked on every parent value. */
function requirementMet(node, req, index) {
  if (Array.isArray(req)) return req.some((r) => requirementMet(node, r, index));
  const segs = req.split('.');
  if (segs.length === 1) return getValues(node, req, index).length > 0;
  const parents = getValues(node, segs[0], index);
  if (!parents.length) return false;
  return parents.every((p) => typeof p !== 'object' || requirementMet(p, segs.slice(1).join('.'), index));
}

function featureCandidate(entity) {
  for (let e = entity; e; e = e.parent) {
    if (e.topLevel) return true;
    if (!FEATURE_CONTAINERS.has(e.parentProp)) return false;
  }
  return false;
}

function matchesRule(entity, rule) {
  const isMatch = (t) => rule.types.some((rt) => vocab.isSubtypeOf(t, rt));
  if (!entity.types.some(isMatch)) return false;
  if (rule.excludeTypes && entity.types.some((t) => rule.excludeTypes.some((x) => vocab.isSubtypeOf(t, x)))) return false;
  if (rule.match && !rule.match(entity)) return false;
  return rule.scope === 'any' || featureCandidate(entity);
}

function evaluateRule(rule, entity, page) {
  const issues = [];
  const issue = (severity, message, path = '') => issues.push({ severity, message, path: path ? joinPath(entity.path === '(root)' ? '' : entity.path, path) : entity.path });
  for (const req of rule.required || []) {
    if (!requirementMet(entity.node, req, page.index)) issue('error', `Missing required ${describeRequirement(req)}.`);
  }
  for (const rec of rule.recommended || []) {
    if (!requirementMet(entity.node, rec, page.index)) issue('warning', `Missing recommended ${describeRequirement(rec)}.`);
  }
  if (rule.check) {
    const helpers = {
      node: entity.node,
      entity,
      page,
      issue,
      get: (path, node = entity.node) => getValues(node, path, page.index),
      first: (path, node = entity.node) => getValues(node, path, page.index)[0],
      typesOf: (n) => typesOf(isReference(n) ? page.index.get(n['@id']) || n : n),
      isType: (n, type) => typesOf(isReference(n) ? page.index.get(n['@id']) || n : n).some((t) => vocab.isKnownType(t) && vocab.isSubtypeOf(t, type)),
    };
    rule.check(helpers);
  }
  const rank = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  let status = errors ? 'invalid' : warnings ? 'warnings' : 'valid';
  if (rule.status === 'deprecated') status = 'deprecated';
  return {
    featureId: rule.id,
    name: rule.name,
    docs: rule.docs,
    featureStatus: rule.status || 'active',
    statusNote: rule.statusNote,
    entityType: entity.types.join('/'),
    entityName: firstText(entity.node.name ?? entity.node.headline),
    block: entity.block,
    blockLabel: entity.blockLabel,
    path: entity.path,
    status,
    issues,
  };
}

function firstText(v) {
  const s = asArray(v).find((x) => typeof x === 'string');
  return s ? s.slice(0, 80) : '';
}

// ---------------------------------------------------------------------------

const SOURCE_LABEL = { jsonld: 'Block', microdata: 'Microdata item', rdfa: 'RDFa item' };

/**
 * JSON-LD blocks come first (so their indexes match the page's <script> tags), then Microdata
 * items, then RDFa items. Every entry of the returned `blocks` has a `format` and a `label`.
 * @param {{url?: string, blocks: {text: string, location?: string}[],
 *   markupItems?: {format: 'microdata'|'rdfa', data: object, location?: string, notes?: object[]}[]}} input
 */
export function analyzePage({ url = '', blocks = [], markupItems = [] }) {
  const index = new Map();
  const sources = [
    ...blocks.map((b) => ({ format: 'jsonld', location: b.location, text: b.text ?? '', notes: [], ...parseBlock(b.text ?? '') })),
    ...markupItems.map((m) => ({ format: m.format, location: m.location, text: JSON.stringify(m.data, null, 2), notes: m.notes || [], data: m.data, error: null })),
  ];
  const seq = { jsonld: 0, microdata: 0, rdfa: 0 };
  const parsed = sources.map((b, i) => {
    if (b.data) collectIds(b.data, index);
    return { ...b, index: i, label: `${SOURCE_LABEL[b.format]} ${++seq[b.format]}` };
  });

  const page = { url, index, entities: [] };
  const outBlocks = parsed.map((b) => {
    const issues = [];
    const ctx = {
      block: b.index,
      label: b.label,
      format: b.format,
      index,
      entities: page.entities,
      issue: (severity, code, message, path = '') => issues.push({ severity, code, message, path: path || '(root)' }),
    };
    const entityStart = page.entities.length;
    if (b.format === 'jsonld') {
      if (!b.text.trim()) {
        ctx.issue('warning', 'empty-block', 'Empty <script type="application/ld+json"> tag.');
      } else if (b.error) {
        const where = b.error.location ? ` (line ${b.error.location.line}, column ${b.error.location.column})` : '';
        const fixed = b.error.fixes.length ? ` Checked the rest using a repaired copy: ${b.error.fixes.join('; ')}.` : '';
        ctx.issue('error', 'invalid-json', `Invalid JSON${where}: ${b.error.message}. Google will ignore this block until it parses.${fixed}`);
      }
      if (b.data !== null) {
        for (const { node, path, partial } of topLevelNodes(b.data, ctx)) {
          walkEntity(node, ctx, { path, parentProp: null, topLevel: !partial, parent: null });
        }
      }
    } else {
      // Microdata/RDFa have no @context of their own, so only the vocabulary and Google checks apply.
      for (const n of b.notes) ctx.issue(n.severity, n.code, n.message, n.path);
      walkEntity(b.data, ctx, { path: '', parentProp: null, topLevel: true, parent: null });
    }
    const rootTypes = page.entities.slice(entityStart).filter((e) => e.topLevel).flatMap((e) => e.types);
    return {
      index: b.index,
      format: b.format,
      label: b.label,
      location: b.location,
      text: b.text,
      data: b.data,
      parseError: b.error,
      types: [...new Set(rootTypes)],
      issues,
    };
  });

  const seen = new Set();
  const features = [];
  for (const entity of page.entities) {
    // An entity defined once and referenced elsewhere by @id is only evaluated at its definition.
    if (seen.has(entity.node)) continue;
    seen.add(entity.node);
    for (const rule of GOOGLE_FEATURES) {
      if (matchesRule(entity, rule)) features.push(evaluateRule(rule, entity, page));
    }
  }

  const pageIssues = [];
  if (!sources.length) {
    pageIssues.push({ severity: 'info', code: 'no-structured-data', message: 'No structured data (JSON-LD, Microdata or RDFa) found on this page.', path: '' });
  }

  const all = [...outBlocks.flatMap((b) => b.issues), ...features.flatMap((f) => f.issues), ...pageIssues];
  return {
    url,
    blocks: outBlocks,
    features,
    pageIssues,
    counts: {
      blocks: blocks.length,
      microdata: seq.microdata,
      rdfa: seq.rdfa,
      errors: all.filter((i) => i.severity === 'error').length,
      warnings: all.filter((i) => i.severity === 'warning').length,
      infos: all.filter((i) => i.severity === 'info').length,
    },
  };
}
