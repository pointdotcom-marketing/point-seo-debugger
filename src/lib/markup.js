// Converts Microdata (itemscope/itemtype/itemprop) and RDFa Lite (vocab/typeof/property) into
// JSON-LD-shaped objects so the validator can check them like JSON-LD blocks.
// Loaded as a classic content script (before content.js) and imported for its side effect in Node
// tests, so it can't use import/export; it publishes globalThis.SeoLensMarkup instead. It only uses
// tagName, getAttribute, hasAttribute, children, parentElement, textContent and getElementById.
(() => {
  const SCHEMA_RE = /^https?:\/\/schema\.org\//i;
  const CONTEXT = 'https://schema.org';
  const tokens = (s) => (s || '').trim().split(/\s+/).filter(Boolean);
  const tag = (el) => el.tagName.toLowerCase();
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const isSchemaOrg = (iri) => SCHEMA_RE.test(iri);
  // JSON-LD with "@context": "https://schema.org" uses short names, so shorten schema.org IRIs.
  const short = (iri) => (isSchemaOrg(iri) ? iri.replace(SCHEMA_RE, '') : iri);

  function addValue(item, name, value) {
    if (!(name in item)) item[name] = value;
    else if (Array.isArray(item[name])) item[name].push(value);
    else item[name] = [item[name], value];
  }

  function newItem(types, topLevel) {
    const item = topLevel && types.some(isSchemaOrg) ? { '@context': CONTEXT } : {};
    if (types.length) item['@type'] = types.length === 1 ? short(types[0]) : types.map(short);
    return item;
  }

  function locationOf(el) {
    for (let e = el; e; e = e.parentElement) if (tag(e) === 'head') return 'head';
    return 'body';
  }

  // ---------------------------------------------------------------------------
  // Microdata, per https://html.spec.whatwg.org/multipage/microdata.html

  const SRC_TAGS = new Set(['audio', 'embed', 'iframe', 'img', 'source', 'track', 'video']);
  const HREF_TAGS = new Set(['a', 'area', 'link']);

  function microdataValue(el, resolve) {
    const t = tag(el);
    if (t === 'meta') return el.getAttribute('content') ?? '';
    // Not in the HTML spec, but Google reads `content` on any element (<span itemprop="price" content="10.00">).
    if (el.hasAttribute('content')) return el.getAttribute('content');
    if (SRC_TAGS.has(t)) return el.hasAttribute('src') ? resolve(el.getAttribute('src')) : '';
    if (HREF_TAGS.has(t)) return el.hasAttribute('href') ? resolve(el.getAttribute('href')) : '';
    if (t === 'object') return el.hasAttribute('data') ? resolve(el.getAttribute('data')) : '';
    if (t === 'data' || t === 'meter') return el.getAttribute('value') ?? '';
    if (t === 'time' && el.hasAttribute('datetime')) return el.getAttribute('datetime');
    return text(el);
  }

  function microdataItem(root, env, topLevel) {
    env.building.add(root);
    const types = tokens(root.getAttribute('itemtype'));
    const item = newItem(types, topLevel);
    if (root.hasAttribute('itemid')) item['@id'] = env.resolve(root.getAttribute('itemid'));
    const schemaVocab = types.some(isSchemaOrg);

    // The spec's property crawl: the item's subtree plus itemref'd elements, without entering nested items.
    const seen = new Set([root]);
    const crawl = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (el.hasAttribute('itemprop')) {
        let value;
        if (!el.hasAttribute('itemscope')) value = microdataValue(el, env.resolve);
        else if (env.building.has(el)) {
          value = { '@id': el.getAttribute('itemid') || '' };
          env.notes.push({ severity: 'error', code: 'itemref-cycle', message: 'An itemref loop makes an item contain itself.' });
        } else value = microdataItem(el, env, false);
        for (const name of tokens(el.getAttribute('itemprop'))) addValue(item, schemaVocab ? short(name) : name, value);
      }
      if (!el.hasAttribute('itemscope')) for (const child of el.children) crawl(child);
    };
    for (const child of root.children) crawl(child);
    for (const id of tokens(root.getAttribute('itemref'))) {
      const ref = env.doc.getElementById(id);
      if (ref) crawl(ref);
      else env.notes.push({ severity: 'warning', code: 'itemref-missing', message: `itemref points to id="${id}", but no element has that id.` });
    }
    env.building.delete(root);
    return item;
  }

  /** Top-level Microdata items: elements with itemscope that aren't themselves a property. */
  function extractMicrodata(doc, resolve = (u) => u) {
    const out = [];
    const visit = (el) => {
      if (el.hasAttribute('itemscope') && !el.hasAttribute('itemprop')) {
        const env = { doc, resolve, notes: [], building: new Set() };
        out.push({ format: 'microdata', data: microdataItem(el, env, true), location: locationOf(el), notes: env.notes });
      }
      for (const child of el.children) visit(child);
    };
    visit(doc.documentElement);
    return out;
  }

  // ---------------------------------------------------------------------------
  // RDFa Lite 1.1 (vocab, typeof, property, resource, prefix), plus `about`, `content`,
  // `href`/`src` values and `datetime`. Full RDFa chaining (rel/rev/datatype) isn't handled.

  // Prefixes from the RDFa 1.1 initial context that show up in SEO markup.
  const INITIAL_PREFIXES = {
    schema: 'https://schema.org/',
    og: 'http://ogp.me/ns#',
    dc: 'http://purl.org/dc/terms/',
    dcterms: 'http://purl.org/dc/terms/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
  };

  function expand(token, ctx, notes) {
    const colon = token.indexOf(':');
    if (colon > 0) {
      const prefix = token.slice(0, colon).toLowerCase();
      // Absolute IRIs and unknown prefixes stay as written and fail the vocabulary check later.
      return prefix in ctx.prefixes ? ctx.prefixes[prefix] + token.slice(colon + 1) : token;
    }
    if (ctx.vocab) return ctx.vocab + token;
    notes.push({ severity: 'error', code: 'rdfa-no-vocab', message: `"${token}" is used without a vocab attribute (vocab="https://schema.org/"), so it has no meaning.` });
    return token;
  }

  function rdfaValue(el, resolve) {
    if (el.hasAttribute('content')) return el.getAttribute('content');
    for (const a of ['resource', 'href', 'src']) if (el.hasAttribute(a)) return resolve(el.getAttribute(a));
    if (tag(el) === 'time' && el.hasAttribute('datetime')) return el.getAttribute('datetime');
    return text(el);
  }

  function extractRdfa(doc, resolve = (u) => u) {
    const out = [];
    const visit = (el, ctx) => {
      if (el.hasAttribute('vocab')) ctx = { ...ctx, vocab: el.getAttribute('vocab').trim() || null };
      if (el.hasAttribute('prefix')) {
        const prefixes = { ...ctx.prefixes };
        const parts = tokens(el.getAttribute('prefix'));
        for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i].endsWith(':')) prefixes[parts[i].slice(0, -1).toLowerCase()] = parts[i + 1];
        ctx = { ...ctx, prefixes };
      }
      // `property` outside any typeof (e.g. <meta property="og:title">) describes the document; skip it.
      const props = ctx.subject ? tokens(el.getAttribute('property')) : [];
      let { subject, top } = ctx;
      if (el.hasAttribute('typeof')) {
        const isTop = !props.length;
        const notes = isTop ? [] : top.notes;
        const item = newItem(tokens(el.getAttribute('typeof')).map((t) => expand(t, ctx, notes)), isTop);
        // The typed resource's IRI, which is also where Google reads a breadcrumb's `item` URL.
        const id = ['about', 'resource', 'href', 'src'].find((a) => el.hasAttribute(a));
        if (id) item['@id'] = resolve(el.getAttribute(id));
        if (isTop) {
          top = { format: 'rdfa', data: item, location: locationOf(el), notes };
          out.push(top);
        } else {
          for (const p of props) addValue(subject, short(expand(p, ctx, notes)), item);
        }
        subject = item;
      } else if (props.length) {
        const value = rdfaValue(el, resolve);
        for (const p of props) addValue(subject, short(expand(p, ctx, top.notes)), value);
      }
      for (const child of el.children) visit(child, { ...ctx, subject, top });
    };
    visit(doc.documentElement, { vocab: null, prefixes: INITIAL_PREFIXES, subject: null, top: null });
    return out;
  }

  globalThis.SeoLensMarkup = { extractMicrodata, extractRdfa };
})();
