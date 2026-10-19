// Google Search rich result requirements, per feature.
// Source: https://developers.google.com/search/docs/appearance/structured-data/search-gallery
// Last reviewed against Google's docs: see README ("Keeping rules current").
//
// Rule shape:
//   id, name, docs        identity and documentation link
//   types                 schema.org types this applies to (subtypes match too)
//   excludeTypes          subtypes handled by a different rule
//   scope                 'feature' (default): top-level or under mainEntity/breadcrumb/hasPart/itemListElement
//                         'any': wherever the type appears (e.g. nested reviews)
//   match(entity)         optional extra predicate
//   status                'active' | 'restricted' | 'deprecated'; statusNote explains
//   required/recommended  dotted paths; an array means "one of"
//   check(h)              custom checks; h.issue(severity, message, relativePath)
import { DATE_RE, DATETIME_RE, DURATION_RE, isAbsoluteUrl } from './formats.js';
import { isKnownType, isSubtypeOf } from './vocab.js';

const DOCS = 'https://developers.google.com/search/docs/appearance/structured-data/';

const ISO_CURRENCIES = new Set(
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG ZWL'.split(' '),
);

// Types Google lets carry review snippets (as the reviewed item).
const REVIEWABLE = [
  'Book', 'Course', 'CreativeWorkSeason', 'CreativeWorkSeries', 'Episode', 'Event', 'Game', 'HowTo',
  'LocalBusiness', 'MediaObject', 'Movie', 'MusicPlaylist', 'MusicRecording', 'Organization',
  'Product', 'Recipe', 'SoftwareApplication',
];

// ---------------------------------------------------------------------------
// Shared value checks.

function checkDate(h, path, { needTime = false, label = path } = {}) {
  for (const v of h.get(path)) {
    if (typeof v !== 'string') continue;
    if (!DATE_RE.test(v) && !DATETIME_RE.test(v)) {
      h.issue('error', `"${label}" must be ISO 8601 (e.g. 2026-03-14T09:00:00-07:00). Got "${v}".`, path);
    } else if (needTime && !/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      h.issue('warning', `"${label}" has no time or timezone; Google recommends a full datetime with timezone offset.`, path);
    }
  }
}

function checkImages(h, path = 'image') {
  for (const v of h.get(path)) {
    const url = typeof v === 'string' ? v : v?.url || v?.contentUrl;
    if (typeof url !== 'string') {
      if (typeof v === 'object') h.issue('warning', `"${path}" ImageObject has no "url" or "contentUrl".`, path);
      continue;
    }
    if (url.startsWith('data:')) h.issue('error', `"${path}" is a data: URL; Google needs a crawlable image URL.`, path);
    else if (!isAbsoluteUrl(url)) h.issue('warning', `"${path}" should be an absolute, crawlable URL. Got "${url.slice(0, 80)}".`, path);
  }
}

function checkPersonOrOrg(h, path, { required = false } = {}) {
  for (const v of h.get(path)) {
    if (typeof v === 'string') {
      h.issue('warning', `"${path}" is a plain string; use a Person or Organization object with a "name".`, path);
      continue;
    }
    if (!h.isType(v, 'Person') && !h.isType(v, 'Organization')) {
      h.issue(required ? 'error' : 'warning', `"${path}" should be a Person or Organization (got ${h.typesOf(v).join('/') || 'no @type'}).`, path);
    }
    const name = h.first('name', v);
    if (!name) h.issue(required ? 'error' : 'warning', `"${path}" is missing "name".`, path);
    else if (typeof name === 'string' && name.length > 100) h.issue('warning', `"${path}.name" is over 100 characters.`, `${path}.name`);
    else if (typeof name === 'string' && /^(by|posted by|written by)\b/i.test(name)) h.issue('warning', `"${path}.name" should be just the name, without "${name.split(' ')[0]}…".`, `${path}.name`);
  }
}

function checkRating(h, rating, path) {
  const num = (x) => (x === undefined ? undefined : Number(String(x).replace(',', '.')));
  const value = num(h.first('ratingValue', rating));
  const best = num(h.first('bestRating', rating)) ?? 5;
  const worst = num(h.first('worstRating', rating)) ?? 1;
  const raw = h.first('ratingValue', rating);
  if (raw === undefined) return;
  // Google also accepts fractions ("6 / 10") and percentages ("60%"); only range-check plain numbers.
  if (typeof raw === 'string' && /^\s*\d+([.,]\d+)?\s*(%|\/\s*\d+([.,]\d+)?)\s*$/.test(raw)) return;
  if (typeof raw === 'string' && /\d,\d/.test(raw)) h.issue('warning', `"${path}.ratingValue" uses a comma; Google expects a dot as the decimal separator.`, `${path}.ratingValue`);
  if (Number.isNaN(value)) {
    h.issue('error', `"${path}.ratingValue" must be a number. Got "${raw}".`, `${path}.ratingValue`);
  } else if (value < worst || value > best) {
    h.issue('error', `"${path}.ratingValue" (${value}) is outside the ${worst}–${best} scale. Set bestRating/worstRating if you use a different scale.`, `${path}.ratingValue`);
  }
}

function checkPrice(h, offer, path) {
  const spec = h.first('priceSpecification', offer);
  const price = h.first('price', offer) ?? h.first('lowPrice', offer) ?? (spec && h.first('price', spec));
  const currency = h.first('priceCurrency', offer) ?? (spec && h.first('priceCurrency', spec));
  if (price === undefined) return false;
  if (typeof price === 'string' && !/^\d+(\.\d+)?$/.test(price.trim())) {
    h.issue('error', `"${path}.price" must be a plain number like "1234.50" (no currency symbols or thousands separators). Got "${price}".`, `${path}.price`);
  } else if (typeof price === 'number' && price < 0) {
    h.issue('error', `"${path}.price" is negative.`, `${path}.price`);
  }
  if (currency !== undefined && !ISO_CURRENCIES.has(String(currency))) {
    h.issue('error', `"${path}.priceCurrency" must be a 3-letter ISO 4217 code like "USD". Got "${currency}".`, `${path}.priceCurrency`);
  }
  return { price: Number(price), currency };
}

function eachOffer(h, fn) {
  h.get('offers').forEach((offer, i, all) => {
    const path = all.length > 1 ? `offers[${i}]` : 'offers';
    if (typeof offer !== 'object') return h.issue('error', `"${path}" should be an Offer object.`, path);
    fn(offer, path);
  });
}

function datesInOrder(h, earlier, later) {
  const a = h.first(earlier);
  const b = h.first(later);
  if (typeof a === 'string' && typeof b === 'string' && Date.parse(b) < Date.parse(a)) {
    h.issue('warning', `"${later}" (${b}) is before "${earlier}" (${a}).`, later);
  }
}

function futureDate(h, path) {
  const v = h.first(path);
  if (typeof v === 'string' && Date.parse(v) > Date.now() + 86400000) {
    h.issue('warning', `"${path}" (${v}) is in the future.`, path);
  }
}

// ---------------------------------------------------------------------------

export const GOOGLE_FEATURES = [
  {
    id: 'article',
    name: 'Article',
    docs: `${DOCS}article`,
    types: ['Article'],
    recommended: ['author', 'datePublished', 'dateModified', 'headline', 'image'],
    check(h) {
      checkPersonOrOrg(h, 'author');
      for (const a of h.get('author')) {
        if (typeof a === 'object' && !h.first('url', a) && !h.first('sameAs', a)) {
          h.issue('warning', 'Add "author.url" (or sameAs) linking to a page that identifies the author.', 'author');
        }
      }
      checkDate(h, 'datePublished', { needTime: true });
      checkDate(h, 'dateModified', { needTime: true });
      datesInOrder(h, 'datePublished', 'dateModified');
      futureDate(h, 'datePublished');
      checkImages(h);
      for (const img of h.get('image')) {
        const url = typeof img === 'string' ? img : img?.url || img?.contentUrl || '';
        if (/logo/i.test(url)) h.issue('warning', '"image" looks like a logo; Google wants an image representing the article, not a logo.', 'image');
      }
      checkPaywall(h);
    },
  },
  {
    id: 'breadcrumb',
    name: 'Breadcrumb',
    docs: `${DOCS}breadcrumb`,
    types: ['BreadcrumbList'],
    required: ['itemListElement'],
    check(h) {
      const items = h.get('itemListElement');
      if (items.length === 1) h.issue('error', 'Breadcrumbs need at least two ListItems.', 'itemListElement');
      const positions = [];
      items.forEach((item, i) => {
        const p = `itemListElement[${i}]`;
        if (typeof item !== 'object') return h.issue('error', `"${p}" should be a ListItem.`, p);
        if (!h.isType(item, 'ListItem')) h.issue('warning', `"${p}" should have @type ListItem.`, p);
        const pos = h.first('position', item);
        if (pos === undefined) h.issue('error', `Missing required "position" on ${p}.`, p);
        else positions.push(Number(pos));
        const target = h.first('item', item);
        if (pos !== undefined && !Number.isInteger(Number(pos))) h.issue('error', `${p}.position must be an integer. Got "${pos}".`, `${p}.position`);
        const name = h.first('name', item) ?? (typeof target === 'object' ? h.first('name', target) : undefined);
        if (!name) h.issue('error', `Missing required "name" on ${p}.`, p);
        const isLast = i === items.length - 1;
        if (!target && !isLast) h.issue('error', `Missing required "item" (URL) on ${p}. Only the last crumb may omit it.`, p);
        const url = typeof target === 'string' ? target : target?.['@id'] || target?.url;
        if (typeof url === 'string' && !isAbsoluteUrl(url)) h.issue('warning', `${p}.item should be an absolute URL. Got "${url}".`, `${p}.item`);
      });
      const sorted = [...positions].sort((a, b) => a - b);
      if (positions.length && (sorted[0] !== 1 || sorted.some((p, i) => p !== i + 1))) {
        h.issue('warning', `Breadcrumb positions should be 1, 2, 3…; got ${positions.join(', ')}.`, 'itemListElement');
      }
    },
  },
  {
    id: 'carousel',
    name: 'Carousel (ItemList)',
    docs: `${DOCS}carousel`,
    types: ['ItemList'],
    excludeTypes: ['BreadcrumbList'],
    match: (e) => JSON.stringify(e.node.itemListElement ?? '').match(/"(Course|Movie|Recipe|Restaurant)"/),
    statusNote: 'Carousels only work for lists of Course, Movie, Recipe or Restaurant items, all of the same type, and the list must be complete.',
    required: ['itemListElement', 'itemListElement.position'],
    check(h) {
      if (h.get('itemListElement').length < 2) h.issue('error', 'A carousel ItemList needs at least two items.', 'itemListElement');
      h.get('itemListElement').forEach((item, i) => {
        if (typeof item === 'object' && !h.first('url', item) && !h.first('item', item)) {
          h.issue('error', `itemListElement[${i}] needs "url" (summary page pattern) or a full "item" (all-in-one pattern).`, `itemListElement[${i}]`);
        }
      });
    },
  },
  {
    id: 'course',
    name: 'Course list',
    docs: `${DOCS}course`,
    types: ['Course'],
    status: 'restricted',
    required: ['name', 'description'],
    recommended: ['provider', 'provider.name'],
    statusNote: 'Course info rich results were retired in Sept 2025. Course markup now only feeds the course list carousel, which needs an ItemList of at least 3 courses on a summary page.',
    check(h) {
      const d = h.first('description');
      if (typeof d === 'string' && d.length > 60) h.issue('info', `"description" is ${d.length} characters; Google displays about 60.`, 'description');
    },
  },
  {
    id: 'dataset',
    name: 'Dataset',
    docs: `${DOCS}dataset`,
    types: ['Dataset'],
    status: 'restricted',
    statusNote: 'Since Nov 2025, Dataset markup is used only by Google Dataset Search, not shown as a rich result in Google Search.',
    required: ['name', 'description'],
    recommended: ['url', 'sameAs', 'license', 'creator', 'distribution', 'temporalCoverage', 'spatialCoverage', 'keywords'],
    check(h) {
      const d = h.first('description');
      if (typeof d === 'string' && (d.length < 50 || d.length > 5000)) {
        h.issue('warning', `"description" should be 50–5000 characters (is ${d.length}).`, 'description');
      }
    },
  },
  {
    id: 'discussion-forum',
    name: 'Discussion forum',
    docs: `${DOCS}discussion-forum`,
    types: ['DiscussionForumPosting', 'SocialMediaPosting'],
    // schema.org makes BlogPosting a SocialMediaPosting, but Google's feature is for forums/social posts only.
    excludeTypes: ['BlogPosting'],
    required: ['author', 'author.name', 'datePublished', ['text', 'image', 'video', 'url']],
    recommended: ['author.url', 'dateModified', 'headline', 'url', 'interactionStatistic', 'comment'],
    check(h) {
      checkPersonOrOrg(h, 'author', { required: true });
      checkDate(h, 'datePublished', { needTime: true });
    },
  },
  {
    id: 'employer-rating',
    name: 'Employer aggregate rating',
    docs: `${DOCS}employer-rating`,
    types: ['EmployerAggregateRating'],
    scope: 'any',
    required: ['itemReviewed', 'itemReviewed.name', 'ratingValue', ['ratingCount', 'reviewCount']],
    recommended: ['bestRating', 'worstRating'],
    check(h) {
      checkRating(h, h.node, '');
    },
  },
  {
    id: 'event',
    name: 'Event',
    docs: `${DOCS}event`,
    types: ['Event'],
    required: ['name', 'startDate', 'location', 'location.address'],
    recommended: ['description', 'endDate', 'eventStatus', 'image', 'location.name', 'offers', 'organizer', 'organizer.url', 'performer'],
    check(h) {
      checkDate(h, 'startDate', { needTime: true });
      checkDate(h, 'endDate', { needTime: true });
      datesInOrder(h, 'startDate', 'endDate');
      checkImages(h);
      if (h.first('eventAttendanceMode')) h.issue('info', 'Google no longer documents "eventAttendanceMode"; it is ignored.', 'eventAttendanceMode');
      if (h.first('previousStartDate') && !/EventRescheduled/.test(String(h.first('eventStatus')))) {
        h.issue('warning', '"previousStartDate" should only be used with eventStatus EventRescheduled.', 'previousStartDate');
      }
      h.get('location').forEach((loc) => {
        const p = `location`;
        if (typeof loc === 'string') return h.issue('error', `"location" must be a Place (with address) or VirtualLocation (with url), not a string.`, p);
        if (h.isType(loc, 'VirtualLocation')) {
          h.issue('error', 'Online-only events (VirtualLocation) are no longer supported; since June 2025 Google requires a physical Place with an address.', p);
        }
      });
      eachOffer(h, (offer, p) => {
        checkPrice(h, offer, p);
        for (const r of ['availability', 'price', 'priceCurrency', 'url', 'validFrom']) {
          if (h.first(r, offer) === undefined && !(r.startsWith('price') && h.first('priceSpecification', offer))) {
            h.issue('warning', `Missing recommended "${p}.${r}".`, p);
          }
        }
      });
      checkPersonOrOrg(h, 'organizer');
    },
  },
  {
    id: 'faq',
    name: 'FAQ',
    docs: 'https://developers.google.com/search/updates',
    types: ['FAQPage'],
    status: 'deprecated',
    statusNote: 'Google stopped showing FAQ rich results on May 7, 2026 and removed the docs in June 2026. The markup is harmless but has no Search effect.',
  },
  {
    id: 'howto',
    name: 'How-to',
    docs: 'https://developers.google.com/search/blog/2023/08/howto-faq-changes',
    types: ['HowTo'],
    status: 'deprecated',
    statusNote: 'Google stopped showing How-to rich results in Sept 2023. This markup has no effect on Search.',
  },
  {
    id: 'image-metadata',
    name: 'Image metadata',
    docs: `${DOCS}image-license-metadata`,
    types: ['ImageObject'],
    match: (e) => e.topLevel,
    required: ['contentUrl', ['creator', 'creditText', 'copyrightNotice', 'license']],
    recommended: ['acquireLicensePage', 'creator', 'creditText', 'copyrightNotice', 'license'],
    check(h) {
      checkImages(h, 'contentUrl');
    },
  },
  {
    id: 'job-posting',
    name: 'Job posting',
    docs: `${DOCS}job-posting`,
    types: ['JobPosting'],
    required: ['title', 'description', 'datePosted', 'hiringOrganization', 'hiringOrganization.name', ['jobLocation', 'applicantLocationRequirements']],
    recommended: ['baseSalary', 'employmentType', 'identifier', 'validThrough', 'directApply'],
    check(h) {
      checkDate(h, 'datePosted');
      checkDate(h, 'validThrough');
      const vt = h.first('validThrough');
      if (typeof vt === 'string' && Date.parse(vt) < Date.now()) h.issue('warning', `"validThrough" (${vt}) is in the past; expired jobs should be removed.`, 'validThrough');
      for (const loc of h.get('jobLocation')) {
        if (typeof loc === 'object' && !h.first('address', loc)) h.issue('error', '"jobLocation" Place is missing "address".', 'jobLocation');
      }
      if (h.first('jobLocationType') === 'TELECOMMUTE' && !h.first('applicantLocationRequirements')) {
        h.issue('error', 'Remote jobs (jobLocationType TELECOMMUTE) need "applicantLocationRequirements".', 'applicantLocationRequirements');
      }
      const desc = h.first('description');
      if (typeof desc === 'string' && desc.length < 50) h.issue('warning', '"description" is very short; Google expects the full job description (HTML allowed).', 'description');
    },
  },
  {
    id: 'local-business',
    name: 'Local business',
    docs: `${DOCS}local-business`,
    types: ['LocalBusiness'],
    required: ['name', 'address'],
    recommended: ['url', 'telephone', 'geo', 'openingHoursSpecification', 'priceRange', 'image'],
    check(h) {
      for (const a of h.get('address')) {
        if (typeof a === 'string') {
          h.issue('warning', '"address" is a string; use a PostalAddress with streetAddress, addressLocality, addressRegion, postalCode, addressCountry.', 'address');
          continue;
        }
        for (const f of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']) {
          if (!h.first(f, a)) h.issue('warning', `"address" is missing recommended "${f}".`, 'address');
        }
      }
      for (const g of h.get('geo')) {
        const rawLat = h.first('latitude', g);
        const rawLng = h.first('longitude', g);
        const lat = Number(rawLat);
        const lng = Number(rawLng);
        if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          h.issue('error', '"geo" needs numeric latitude (-90..90) and longitude (-180..180).', 'geo');
        } else if ([rawLat, rawLng].some((v) => (String(v).split('.')[1] || '').length < 5)) {
          h.issue('warning', '"geo" latitude/longitude should have at least 5 decimal places.', 'geo');
        }
      }
      const pr = h.first('priceRange');
      if (typeof pr === 'string' && pr.length >= 100) h.issue('warning', '"priceRange" must be under 100 characters.', 'priceRange');
      const tel = h.first('telephone');
      if (typeof tel === 'string' && !tel.trim().startsWith('+')) h.issue('info', '"telephone" should include the country code (e.g. +1-415-555-0100).', 'telephone');
      if (h.first('aggregateRating') || h.first('review')) {
        h.issue('warning', 'Ratings on your own business are not eligible for stars (self-serving reviews policy). LocalBusiness reviews are only for sites that review other businesses.', 'aggregateRating');
      }
      checkImages(h);
    },
  },
  {
    id: 'math-solver',
    name: 'Math solver',
    docs: `${DOCS}math-solvers`,
    types: ['MathSolver'],
    required: ['potentialAction', 'url', 'usageInfo'],
    recommended: ['inLanguage', 'assesses'],
  },
  {
    id: 'movie',
    name: 'Movie carousel',
    docs: `${DOCS}movie`,
    types: ['Movie'],
    status: 'restricted',
    statusNote: 'Movie rich results appear only as a carousel (mobile), so they also need Carousel (ItemList) markup.',
    required: ['name', 'image'],
    recommended: ['aggregateRating', 'dateCreated', 'director', 'review'],
    check: (h) => checkImages(h),
  },
  {
    id: 'organization',
    name: 'Organization',
    docs: `${DOCS}organization`,
    types: ['Organization'],
    excludeTypes: ['LocalBusiness'],
    recommended: ['name', 'url', 'logo'],
    check(h) {
      checkImages(h, 'logo');
      for (const s of h.get('sameAs')) {
        if (typeof s === 'string' && !isAbsoluteUrl(s)) h.issue('warning', `"sameAs" entries should be absolute URLs. Got "${s}".`, 'sameAs');
      }
      if (h.node.naicsCode !== undefined) h.issue('warning', 'Use "naics", not "naicsCode".', 'naicsCode');
      const iso = h.first('iso6523Code');
      if (typeof iso === 'string' && !/^\d{4}:.+/.test(iso)) h.issue('warning', `"iso6523Code" should look like "0060:123456789" (ICD:identifier). Got "${iso}".`, 'iso6523Code');
      for (const cp of h.get('contactPoint')) {
        if (typeof cp === 'object' && !h.first('telephone', cp) && !h.first('email', cp)) {
          h.issue('warning', '"contactPoint" should include a telephone or email.', 'contactPoint');
        }
      }
    },
  },
  {
    id: 'product-snippet',
    name: 'Product snippet',
    docs: `${DOCS}product-snippet`,
    types: ['Product'],
    required: ['name', ['review', 'aggregateRating', 'offers']],
    recommended: ['aggregateRating', 'review'],
    check(h) {
      for (const r of h.get('review')) {
        if (typeof r === 'object' && !h.first('author', r)) h.issue('error', 'Each "review" needs an "author".', 'review');
      }
      let notes = 0;
      for (const field of ['positiveNotes', 'negativeNotes']) {
        for (const n of h.get(field)) {
          if (typeof n === 'object' && !h.isType(n, 'ItemList')) h.issue('warning', `"${field}" should be an ItemList of ListItem names.`, field);
          notes += h.get('itemListElement', n).length;
        }
      }
      if (notes === 1) h.issue('error', 'Pros and cons need at least two statements across positiveNotes/negativeNotes.', 'positiveNotes');
    },
  },
  {
    id: 'merchant-listing',
    name: 'Merchant listing',
    docs: `${DOCS}merchant-listing`,
    types: ['Product'],
    match: (e) => e.node.offers !== undefined,
    required: ['name', 'image', 'offers'],
    recommended: ['description', 'brand', ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn', 'sku'], 'offers.availability', 'offers.shippingDetails', 'offers.hasMerchantReturnPolicy'],
    check(h) {
      checkImages(h);
      eachOffer(h, (offer, p) => {
        if (h.isType(offer, 'AggregateOffer')) h.issue('error', `Merchant listings need an Offer, not an AggregateOffer ("${p}"). AggregateOffer only qualifies for product snippets.`, p);
        const priced = checkPrice(h, offer, p);
        if (!priced) h.issue('error', `Missing required "${p}.price" (or priceSpecification.price).`, p);
        else if (priced.price === 0) h.issue('error', `"${p}.price" must be greater than 0 for merchant listings.`, `${p}.price`);
        const spec = h.first('priceSpecification', offer);
        if (h.first('priceCurrency', offer) === undefined && !(spec && h.first('priceCurrency', spec))) {
          h.issue('error', `Missing required "${p}.priceCurrency".`, p);
        }
        const vt = h.first('priceValidUntil', offer);
        if (typeof vt === 'string' && Date.parse(vt) < Date.now()) h.issue('warning', `"${p}.priceValidUntil" (${vt}) is in the past.`, `${p}.priceValidUntil`);
      });
      for (const b of h.get('brand')) {
        if (typeof b === 'string') h.issue('warning', '"brand" should be a Brand or Organization object with "name".', 'brand');
      }
    },
  },
  {
    id: 'profile-page',
    name: 'Profile page',
    docs: `${DOCS}profile-page`,
    types: ['ProfilePage'],
    required: ['mainEntity', ['mainEntity.name', 'mainEntity.alternateName']],
    recommended: ['dateCreated', 'dateModified', 'mainEntity.image', 'mainEntity.sameAs', 'mainEntity.description'],
    check(h) {
      for (const m of h.get('mainEntity')) {
        if (!h.isType(m, 'Person') && !h.isType(m, 'Organization')) h.issue('error', '"mainEntity" must be a Person or Organization.', 'mainEntity');
      }
    },
  },
  {
    id: 'qa',
    name: 'Q&A',
    docs: `${DOCS}qapage`,
    types: ['QAPage'],
    required: ['mainEntity', 'mainEntity.name', 'mainEntity.answerCount', ['mainEntity.acceptedAnswer', 'mainEntity.suggestedAnswer']],
    recommended: ['mainEntity.text', 'mainEntity.author', 'mainEntity.datePublished'],
    check(h) {
      if (h.get('mainEntity').length > 1) h.issue('error', 'QAPage must have exactly one Question as mainEntity. Pages with several Q&As aren\'t eligible.', 'mainEntity');
      for (const q of h.get('mainEntity')) {
        for (const a of [...h.get('acceptedAnswer', q), ...h.get('suggestedAnswer', q)]) {
          if (typeof a === 'object' && !h.first('text', a)) h.issue('error', 'Each Answer needs "text".', 'mainEntity');
        }
      }
    },
  },
  {
    id: 'recipe',
    name: 'Recipe',
    docs: `${DOCS}recipe`,
    types: ['Recipe'],
    required: ['name', 'image'],
    recommended: ['author', 'datePublished', 'description', 'recipeIngredient', 'recipeInstructions', 'recipeYield', 'totalTime', 'prepTime', 'cookTime', 'nutrition.calories', 'aggregateRating', 'keywords', 'recipeCategory', 'recipeCuisine', 'video'],
    check(h) {
      checkImages(h);
      for (const t of ['prepTime', 'cookTime', 'totalTime']) {
        const v = h.first(t);
        if (typeof v === 'string' && !DURATION_RE.test(v)) h.issue('error', `"${t}" must be an ISO 8601 duration like "PT45M". Got "${v}".`, t);
      }
      if (h.first('nutrition.calories') && !h.first('recipeYield')) h.issue('error', '"recipeYield" is required when "nutrition.calories" is set.', 'recipeYield');
      if (h.first('prepTime') && !h.first('cookTime') && !h.first('totalTime')) h.issue('warning', 'Use "prepTime" together with "cookTime" (or use "totalTime").', 'prepTime');
    },
  },
  {
    id: 'review-snippet',
    name: 'Review snippet',
    docs: `${DOCS}review-snippet`,
    types: ['Review', 'AggregateRating'],
    excludeTypes: ['EmployerAggregateRating'],
    scope: 'any',
    // Reviews nested inside a Product/Recipe/etc. are checked here too, since Google evaluates them as review snippets.
    check(h) {
      const isAggregate = h.isType(h.node, 'AggregateRating');
      const parent = h.entity.parent;
      const reviewed = h.first('itemReviewed') ?? (parent ? parent.node : undefined);
      if (parent && h.first('itemReviewed')) {
        h.issue('warning', 'This is nested inside the reviewed item and also sets "itemReviewed"; Google asks you to indicate the item one way only.', 'itemReviewed');
      }
      if (!reviewed) {
        h.issue('error', 'Missing required "itemReviewed" (or nest this inside the item being reviewed).');
      } else if (typeof reviewed === 'object') {
        const types = h.typesOf(reviewed).filter(isKnownType);
        if (types.length && !types.some((t) => REVIEWABLE.some((r) => isSubtypeOf(t, r)))) {
          h.issue('warning', `Google doesn't show review snippets for ${types.join('/')}. Supported: ${REVIEWABLE.slice(0, 8).join(', ')}…`);
        }
        if (h.first('itemReviewed') && !h.first('name', reviewed)) h.issue('error', 'Missing required "itemReviewed.name".', 'itemReviewed');
        if (types.some((t) => isSubtypeOf(t, 'Organization'))) {
          h.issue('warning', 'Likely not eligible: Google\'s self-serving reviews policy hides stars when an Organization/LocalBusiness marks up reviews of itself on its own site (including reviews from embedded third-party widgets).');
        }
      }
      if (isAggregate) {
        if (h.first('ratingValue') === undefined) h.issue('error', 'Missing required "ratingValue".', 'ratingValue');
        if (h.first('ratingCount') === undefined && h.first('reviewCount') === undefined) h.issue('error', 'Missing required "ratingCount" or "reviewCount".');
        for (const c of ['ratingCount', 'reviewCount']) {
          const v = h.first(c);
          if (v !== undefined && !(Number(v) > 0)) h.issue('error', `"${c}" must be a positive number. Got "${v}".`, c);
        }
        checkRating(h, h.node, '(rating)');
      } else {
        if (!h.first('author')) h.issue('error', 'Missing required "author".', 'author');
        else checkPersonOrOrg(h, 'author', { required: true });
        const rating = h.first('reviewRating');
        if (!rating && !(h.first('author') && h.first('datePublished'))) h.issue('error', 'Missing required "reviewRating" (it may only be omitted when the review has both an author and datePublished).', 'reviewRating');
        else if (!rating) h.issue('warning', 'Missing recommended "reviewRating".', 'reviewRating');
        else if (typeof rating !== 'object' || h.first('ratingValue', rating) === undefined) h.issue('error', 'Missing required "reviewRating.ratingValue".', 'reviewRating');
        else checkRating(h, rating, 'reviewRating');
        checkDate(h, 'datePublished');
      }
    },
  },
  {
    id: 'software-app',
    name: 'Software app',
    docs: `${DOCS}software-app`,
    types: ['SoftwareApplication'],
    required: ['name', 'offers.price', ['aggregateRating', 'review']],
    recommended: ['applicationCategory', 'operatingSystem'],
    check(h) {
      eachOffer(h, (offer, p) => {
        const priced = checkPrice(h, offer, p);
        if (priced && priced.price > 0 && priced.currency === undefined) h.issue('error', `"${p}.priceCurrency" is required for paid apps.`, p);
      });
    },
  },
  {
    id: 'vacation-rental',
    name: 'Vacation rental',
    docs: `${DOCS}vacation-rental`,
    types: ['VacationRental'],
    status: 'restricted',
    statusNote: 'Vacation rental rich results are limited to Hotel Center partners working with a Google Technical Account Manager.',
    required: ['name', 'identifier', 'image', 'latitude', 'longitude', 'containsPlace', 'containsPlace.occupancy', 'containsPlace.occupancy.value'],
    recommended: ['address', 'aggregateRating', 'brand', 'checkinTime', 'checkoutTime', 'description', 'knowsLanguage', 'review', 'containsPlace.amenityFeature', 'containsPlace.numberOfBedrooms', 'containsPlace.numberOfBathroomsTotal'],
    check(h) {
      const n = h.get('image').length;
      if (h.get('containsPlace').length > 1) h.issue('error', '"containsPlace" must be exactly one Accommodation.', 'containsPlace');
      if (n && n < 8) h.issue('warning', `Google requires at least 8 images for vacation rentals (found ${n}).`, 'image');
      checkImages(h);
    },
  },
  {
    id: 'video',
    name: 'Video',
    docs: `${DOCS}video`,
    types: ['VideoObject'],
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['description', ['contentUrl', 'embedUrl'], 'duration', ['creator', 'author']],
    check(h) {
      checkDate(h, 'uploadDate', { needTime: true });
      checkImages(h, 'thumbnailUrl');
      const page = h.page.url;
      for (const f of ['contentUrl', 'embedUrl']) {
        const v = h.first(f);
        if (typeof v === 'string' && page && v.split('#')[0] === page.split('#')[0]) h.issue('warning', `"${f}" is the page URL; it should point to the ${f === 'contentUrl' ? 'video file' : 'player'}.`, f);
      }
      const d = h.first('duration');
      if (typeof d === 'string' && !DURATION_RE.test(d)) h.issue('error', `"duration" must be ISO 8601 like "PT1M54S". Got "${d}".`, 'duration');
      for (const clip of h.get('hasPart')) {
        if (typeof clip !== 'object' || !h.isType(clip, 'Clip')) continue;
        for (const f of ['name', 'startOffset', 'url']) {
          if (h.first(f, clip) === undefined) h.issue('error', `Clip is missing required "${f}".`, 'hasPart');
        }
      }
      const pub = h.first('publication');
      if (pub && typeof pub === 'object') {
        for (const f of ['isLiveBroadcast', 'startDate']) {
          if (h.first(f, pub) === undefined) h.issue('error', `BroadcastEvent "publication" is missing required "${f}".`, 'publication');
        }
      }
      const exp = h.first('expires');
      if (typeof exp === 'string' && Date.parse(exp) < Date.now()) h.issue('warning', `"expires" (${exp}) is in the past; Google won't show this video.`, 'expires');
    },
  },
  {
    id: 'education-qa',
    name: 'Education Q&A (flashcards)',
    docs: `${DOCS}education-qa`,
    types: ['Quiz'],
    required: ['hasPart'],
    recommended: ['about', 'educationalAlignment'],
    check(h) {
      h.get('hasPart').forEach((q, i) => {
        const p = `hasPart[${i}]`;
        if (typeof q !== 'object' || !h.isType(q, 'Question')) return h.issue('error', `${p} should be a Question.`, p);
        if (h.first('eduQuestionType', q) !== 'Flashcard') h.issue('error', `${p}.eduQuestionType must be "Flashcard"; other question types make the page ineligible.`, p);
        if (!h.first('text', q)) h.issue('error', `Missing required "text" on ${p}.`, p);
        const answers = h.get('acceptedAnswer', q);
        if (answers.length !== 1) h.issue('error', `${p} needs exactly one acceptedAnswer (found ${answers.length}).`, p);
      });
    },
  },
  {
    id: 'speakable',
    name: 'Speakable (beta)',
    docs: `${DOCS}speakable`,
    types: ['Article', 'WebPage'],
    match: (e) => e.node.speakable !== undefined,
    status: 'restricted',
    statusNote: 'Beta: US English news content for Google Assistant only.',
    check(h) {
      for (const sp of h.get('speakable')) {
        if (typeof sp !== 'object') continue;
        const n = ['cssSelector', 'xpath', 'xPath'].filter((k) => sp[k] !== undefined).length;
        if (n !== 1) h.issue('error', 'SpeakableSpecification needs exactly one of "cssSelector" or "xPath".', 'speakable');
      }
    },
  },
  {
    id: 'fact-check',
    name: 'Fact check',
    docs: `${DOCS}factcheck`,
    types: ['ClaimReview'],
    status: 'deprecated',
    statusNote: 'Google is phasing out ClaimReview in Search (announced June 2025). It is still used by Fact Check Explorer.',
  },
  {
    id: 'special-announcement',
    name: 'Special announcement',
    docs: 'https://developers.google.com/search/updates',
    types: ['SpecialAnnouncement'],
    status: 'deprecated',
    statusNote: 'Retired July 31, 2025. No Search effect.',
  },
  {
    id: 'estimated-salary',
    name: 'Estimated salary',
    docs: 'https://developers.google.com/search/blog/2025/06/simplifying-search-results',
    types: ['Occupation'],
    status: 'deprecated',
    statusNote: 'Retired Sept 2025. No Search effect.',
  },
  {
    id: 'site-name',
    name: 'Site name',
    docs: `${DOCS}site-names`,
    types: ['WebSite'],
    required: ['name', 'url'],
    check(h) {
      const url = h.first('url');
      if (typeof url === 'string' && isAbsoluteUrl(url)) {
        const path = new URL(url).pathname;
        if (path !== '/' && path !== '') h.issue('warning', `WebSite "url" should be the site's home page (domain root). Got "${url}".`, 'url');
      }
      for (const a of h.get('potentialAction')) {
        if (h.isType(a, 'SearchAction')) {
          h.issue('info', 'Google retired the sitelinks search box in Nov 2024; the SearchAction here has no effect (it\'s harmless to keep).', 'potentialAction');
        }
      }
    },
  },
];

// ---------------------------------------------------------------------------

function checkPaywall(h) {
  const free = h.first('isAccessibleForFree');
  if (free === undefined || !/^(false|https?:\/\/schema\.org\/False)$/i.test(String(free))) return;
  const parts = h.get('hasPart').filter((p) => typeof p === 'object');
  if (!parts.length) {
    h.issue('warning', 'Paywalled content (isAccessibleForFree: false) should use "hasPart" WebPageElement(s) with "cssSelector" marking the paywalled sections.', 'hasPart');
  }
  for (const p of parts) {
    if (!h.first('cssSelector', p)) h.issue('warning', '"hasPart" paywall element is missing "cssSelector".', 'hasPart');
  }
}
