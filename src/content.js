// Collects SEO data (meta tags, headings, images, links, JSON-LD, Microdata, RDFa) from the page and
// reports it to the extension. Re-reports when the page changes later (tag managers, CMS embeds,
// client routing). lib/markup.js is injected first and converts Microdata/RDFa to JSON-LD objects.
(() => {
  if (window.__seoLensLoaded) return;
  window.__seoLensLoaded = true;

  const MAX_IMAGES = 1000;
  const MAX_LINKS = 3000;
  const tracked = { heading: [], image: [] };

  const attr = (el, name) => (el ? el.getAttribute(name) : null);
  const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const abs = (href) => {
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return href;
    }
  };
  const isHidden = (el) => {
    if (!el.isConnected) return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || (el.offsetWidth === 0 && el.offsetHeight === 0 && s.position !== 'fixed');
  };

  function collectMeta() {
    const metas = [...document.querySelectorAll('meta')].map((m) => ({
      name: (m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv') || m.getAttribute('itemprop') || '').trim(),
      attr: m.hasAttribute('property') ? 'property' : m.hasAttribute('http-equiv') ? 'http-equiv' : m.hasAttribute('name') ? 'name' : m.hasAttribute('itemprop') ? 'itemprop' : m.hasAttribute('charset') ? 'charset' : '',
      content: m.getAttribute('content') ?? m.getAttribute('charset') ?? '',
      inHead: !!m.closest('head'),
    }));
    const linkTags = [...document.querySelectorAll('link[rel]')].map((l) => ({
      rel: l.getAttribute('rel').toLowerCase().trim(),
      href: l.getAttribute('href') ?? '',
      absHref: l.hasAttribute('href') ? abs(l.getAttribute('href')) : '',
      hreflang: l.getAttribute('hreflang'),
      type: l.getAttribute('type'),
      sizes: l.getAttribute('sizes'),
      media: l.getAttribute('media'),
      inHead: !!l.closest('head'),
    }));
    return {
      titles: [...document.querySelectorAll('title')].filter((t) => !t.closest('svg')).map((t) => ({ text: t.textContent, inHead: !!t.closest('head') })),
      lang: attr(document.documentElement, 'lang'),
      dir: attr(document.documentElement, 'dir'),
      charset: document.characterSet,
      doctype: document.doctype ? document.doctype.name : null,
      metas,
      linkTags,
    };
  }

  function collectHeadings() {
    tracked.heading = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    return tracked.heading.map((h) => ({ level: +h.tagName[1], text: text(h).slice(0, 300), hidden: isHidden(h) }));
  }

  function collectImages() {
    tracked.image = [...document.images].slice(0, MAX_IMAGES);
    return {
      total: document.images.length,
      items: tracked.image.map((img) => ({
        src: img.currentSrc || img.src || attr(img, 'data-src') || '',
        alt: img.getAttribute('alt'),
        title: img.getAttribute('title'),
        width: img.naturalWidth,
        height: img.naturalHeight,
        displayWidth: img.width,
        displayHeight: img.height,
        hasDims: img.hasAttribute('width') && img.hasAttribute('height'),
        loading: img.getAttribute('loading'),
        hidden: isHidden(img),
        inLink: !!img.closest('a[href]'),
      })),
    };
  }

  function collectLinks() {
    const anchors = [...document.querySelectorAll('a[href]')];
    return {
      total: anchors.length,
      items: anchors.slice(0, MAX_LINKS).map((a) => {
        const raw = a.getAttribute('href');
        const img = a.querySelector('img[alt]');
        return {
          href: abs(raw),
          raw,
          text: text(a).slice(0, 200),
          imgAlt: img ? img.getAttribute('alt') : null,
          ariaLabel: a.getAttribute('aria-label') || a.getAttribute('title'),
          rel: (a.getAttribute('rel') || '').toLowerCase(),
          target: a.getAttribute('target'),
          hidden: isHidden(a),
          inNav: !!a.closest('nav, header, [role="navigation"]'),
          inFooter: !!a.closest('footer'),
        };
      }),
    };
  }

  function wordCount() {
    const body = document.body;
    if (!body) return 0;
    const words = (body.innerText || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return words ? words.length : 0;
  }

  function collectMarkup() {
    const lib = globalThis.SeoLensMarkup;
    if (!lib) return [];
    return [...lib.extractMicrodata(document, abs), ...lib.extractRdfa(document, abs)];
  }

  function collect() {
    const scripts = [...document.querySelectorAll('script[type="application/ld+json" i]')];
    const markupItems = collectMarkup();
    return {
      url: location.href,
      title: document.title,
      blocks: scripts.map((s) => ({ text: s.textContent, location: s.closest('head') ? 'head' : 'body' })),
      markupItems,
      microdata: markupItems.filter((i) => i.format === 'microdata').length,
      rdfa: markupItems.filter((i) => i.format === 'rdfa').length,
      seo: {
        ...collectMeta(),
        headings: collectHeadings(),
        images: collectImages(),
        anchors: collectLinks(),
        wordCount: wordCount(),
        dataNosnippet: document.querySelectorAll('[data-nosnippet]').length,
      },
    };
  }

  function highlight(kind, index) {
    const el = tracked[kind]?.[index];
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = { outline: el.style.outline, offset: el.style.outlineOffset, transition: el.style.transition };
    el.style.transition = 'outline-color .3s';
    el.style.outline = '3px solid #e8710a';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.offset;
      el.style.transition = prev.transition;
    }, 1800);
    return true;
  }

  // Only the cheap parts go into the change signature; the full collect runs when they change.
  let lastSignature = '';
  function signature() {
    const ld = [...document.querySelectorAll('script[type="application/ld+json" i]')].map((s) => s.textContent);
    const head = document.head ? document.head.innerHTML.length : 0;
    const counts = ['h1,h2,h3,h4,h5,h6,a[href],img', '[itemscope],[itemprop],[typeof],[property]'].map((q) => document.querySelectorAll(q).length);
    return [location.href, document.title, head, ...counts, ...ld].join('\u0000');
  }
  function report() {
    const sig = signature();
    if (sig === lastSignature) return;
    lastSignature = sig;
    chrome.runtime.sendMessage({ type: 'seo-lens:page', data: collect() }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'seo-lens:collect') sendResponse(collect());
    else if (msg?.type === 'seo-lens:highlight') sendResponse(highlight(msg.kind, msg.index));
  });

  report();

  // Throttled rather than debounced so constantly-animating pages still get re-checked.
  let pending = null;
  new MutationObserver(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      report();
    }, 800);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
