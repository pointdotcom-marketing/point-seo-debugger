// Lookups over the compiled schema.org vocabulary (see scripts/build-vocab.mjs).
import data from './vocab-data.js';

const { classes, props, enumMembers, superseded } = data;
const has = Object.hasOwn;

export const vocabBuiltAt = data.builtAt;

const DATATYPES = new Set([
  'DataType', 'Text', 'URL', 'CssSelectorType', 'XPathType', 'PronounceableText',
  'Number', 'Integer', 'Float', 'Boolean', 'Date', 'DateTime', 'Time',
]);

const ancestorCache = new Map();

/** All supertypes of `type`, including itself. */
export function ancestors(type) {
  if (ancestorCache.has(type)) return ancestorCache.get(type);
  const seen = new Set();
  const queue = [type];
  while (queue.length) {
    const t = queue.shift();
    if (seen.has(t)) continue;
    seen.add(t);
    if (has(classes, t)) queue.push(...classes[t]);
  }
  ancestorCache.set(type, seen);
  return seen;
}

export const isKnownType = (t) => has(classes, t);
export const isKnownProperty = (p) => has(props, p);
export const isSubtypeOf = (t, parent) => ancestors(t).has(parent);
export const isDataType = (t) => DATATYPES.has(t);
export const isEnumeration = (t) => t !== 'Enumeration' && ancestors(t).has('Enumeration');
export const supersededBy = (p) => (has(superseded, p) ? superseded[p] : null);

export function propertyRanges(p) {
  return has(props, p) ? props[p][1] : [];
}

/** True when `p` is defined for at least one of `types` (or one of their supertypes). */
export function propertyAppliesTo(p, types) {
  if (!has(props, p)) return false;
  const domains = props[p][0];
  return types.some((t) => domains.some((d) => isSubtypeOf(t, d)));
}

/** The enumeration a member belongs to, e.g. "InStock" -> "ItemAvailability". */
export function enumTypeOf(member) {
  return has(enumMembers, member) ? enumMembers[member] : null;
}

export function enumMembersOf(enumType) {
  return Object.keys(enumMembers).filter((m) => isSubtypeOf(enumMembers[m], enumType));
}

const lowerTypes = new Map(Object.keys(classes).map((k) => [k.toLowerCase(), k]));
const lowerProps = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function suggest(name, lowerMap) {
  const lower = name.toLowerCase();
  if (lowerMap.has(lower)) return lowerMap.get(lower);
  let best = null;
  let bestScore = 3;
  for (const [k, v] of lowerMap) {
    const d = editDistance(lower, k);
    if (d < bestScore) {
      best = v;
      bestScore = d;
    }
  }
  return best;
}

export const suggestType = (name) => suggest(name, lowerTypes);
export const suggestProperty = (name) => suggest(name, lowerProps);
