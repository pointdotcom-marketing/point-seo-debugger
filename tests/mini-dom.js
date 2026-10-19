// Just enough of an HTML parser and DOM for the markup.js unit tests: elements, attributes, text,
// void and raw-text elements, comments. Expects well-formed markup (no implied end tags).
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m));

class Element {
  constructor(tagName, attrs, parentElement) {
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
    this.parentElement = parentElement;
    this.childNodes = [];
  }
  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }
  get textContent() {
    return this.childNodes.map((n) => (typeof n === 'string' ? n : n.textContent)).join('');
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
}

export function parseHtml(html) {
  const root = new Element('#root', new Map(), null);
  let current = root;
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</gi;
  let m;
  while ((m = re.exec(html))) {
    const [token, endTag, startTag, attrText, selfClose] = m;
    if (endTag) {
      for (let e = current; e !== root; e = e.parentElement) {
        if (e.tagName === endTag.toUpperCase()) {
          current = e.parentElement;
          break;
        }
      }
    } else if (startTag) {
      const attrs = new Map();
      for (const a of attrText.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      const el = new Element(startTag, attrs, current);
      current.childNodes.push(el);
      const tag = startTag.toLowerCase();
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        el.childNodes.push(html.slice(re.lastIndex, end < 0 ? html.length : end));
        re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
      } else if (!VOID.has(tag) && !selfClose) {
        current = el;
      }
    } else if (!token.startsWith('<!')) {
      current.childNodes.push(decode(token));
    }
  }
  let documentElement = root.children.find((e) => e.tagName === 'HTML');
  if (!documentElement) {
    documentElement = new Element('html', new Map(), null);
    documentElement.childNodes = root.childNodes;
  }
  documentElement.parentElement = null;
  for (const e of documentElement.children) e.parentElement = documentElement;
  const all = [];
  const walk = (e) => {
    all.push(e);
    e.children.forEach(walk);
  };
  walk(documentElement);
  return {
    documentElement,
    getElementById: (id) => all.find((e) => e.getAttribute('id') === id) ?? null,
  };
}
