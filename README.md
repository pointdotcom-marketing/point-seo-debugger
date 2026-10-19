# SEO Lens

A Chrome extension for checking a page's SEO setup while you edit it. Click the toolbar icon to open a side panel. The panel stays open as you move between tabs and updates live as the page changes.

| Tab | What it shows |
| --- | --- |
| **Overview** | Indexable or not, a Google search-result preview, title and description length (characters and pixel width against Google's truncation point), canonical, meta robots, `X-Robots-Tag` header, HTTP status, robots.txt verdict for Googlebot, language, viewport, hreflang, and a ranked list of every on-page issue |
| **Changes** | Before/after snapshots of the page, and a staging ↔ live comparison. See [Checking your changes](#checking-your-changes). |
| **Schema** | Every JSON-LD block and Microdata/RDFa item, checked against the schema.org vocabulary and against Google's rich result requirements. Each block shows whether it's *Eligible*, *Not eligible*, *Limited*, or *No longer shown*, with the reason. |
| **Headings** | Counts for H1–H6 and the outline in page order, with skipped levels and empty headings flagged. Click a heading to scroll to it on the page. |
| **Images** | Every image, with filters for missing alt, empty alt, filename-as-alt, and missing width/height. Click an image to find it on the page. Export as CSV. |
| **Links** | Total, unique, internal, external, and nofollow counts. Flags empty anchor text, links to staging hosts (`*.webflow.io`, `*.vercel.app`, `localhost`…), and `http://` links. **Check link status** fetches each link and reports 404s and redirects. Export as CSV. |
| **Social** | Facebook/LinkedIn and X card previews, og:image size check, and every `og:` and `twitter:` tag |
| **Tools** | One-click links to the Rich Results Test, PageSpeed Insights, Schema.org Validator, W3C validators, Facebook and LinkedIn debuggers, robots.txt, sitemaps, and Wayback Machine |

The toolbar badge shows the error count for the current tab (red), or the warning count (amber), or ✓ when clean. Hover the icon for a summary.

## Checking your changes

**Snapshots.** Before you edit a page, open **Changes** and click **Save snapshot**. After you edit and republish, reload the page: the summary row shows *Changed since snapshot (5 min ago)* and the Changes tab lists what's different:

- title, description, canonical, meta robots, language, hreflang, and every `og:`/`twitter:` tag, old → new
- headings added and removed
- link and image counts (total, internal, external, nofollow, missing alt), with the delta
- structured data, per block, as property paths: `@graph[Article].headline` changed, `offers.price` added, `image` removed. Nodes in a `@graph` are matched by `@id` or `@type`, so reordering them doesn't show as a change.
- issues fixed and new issues (errors and warnings)

The last 5 snapshots per URL are kept (pick an older one from the dropdown). Snapshots live in `chrome.storage.local`, capped at about 4 MB in total; the oldest are dropped first. They skip the HTTP status, `X-Robots-Tag`, and robots.txt checks, so they compare only what's on the page.

**Compare with another URL.** Under **Compare with another URL**, enter any URL and click **Compare**. SEO Lens loads it in a background tab, collects it the same way, closes the tab, and shows the same diff. The URL is filled in for you when:

- the page is on `*.webflow.io` and its canonical (or `og:url`) points at another host, or
- you've saved a staging ↔ live host pair (**Edit staging ↔ live hosts**, or the **Remember … as staging ↔ live** link after a compare). Pairs work in both directions.

Live is always shown as *before* and staging as *after*, so "fixed" and "new" issues describe what publishing staging would change. URLs on the staging host are rewritten onto the live host before checking, so the canonical, `@id`s, and internal links don't show up as differences. Password-protected staging works as long as you're signed in, since the background tab uses your browser session.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
3. Pin **SEO Lens** from the puzzle-piece menu, then click it on any page.

To check local HTML files, open the extension's **Details** and turn on **Allow access to file URLs**.

After pulling changes, click the reload icon on the extension's card in `chrome://extensions`.

To share a build, run `npm run package` and send `dist/seo-lens-<version>.zip`. Recipients unzip it and use **Load unpacked**. The same zip can be uploaded as a private Chrome Web Store listing for your organization.

## What the schema checks cover

- **Microdata and RDFa.** Each top-level Microdata item (`itemscope`/`itemtype`/`itemprop`) and RDFa item (`vocab`/`typeof`/`property`) is converted to the equivalent JSON-LD and gets every check below. They're listed as *Microdata item N* / *RDFa item N* next to the JSON-LD blocks, and **Source** shows the converted JSON. Microdata follows the HTML spec: `itemref`, nested `itemscope`, `itemid` as `@id`, and values from `content`, `<meta>`, `<link>`/`<a>` `href`, `<img>` `src`, and `<time datetime>`.
- **JSON syntax.** Reports the line and column of the error. Common CMS mistakes (trailing commas, raw line breaks inside strings, curly quotes, comments) are repaired in memory so the rest of the block can still be checked. The block is still reported as an error, because Google ignores invalid JSON.
- **schema.org vocabulary.** Unknown types and properties, with "did you mean" suggestions (`Organisation` → `Organization`, `DatePublished` → `datePublished`). Also flags superseded properties, properties used on the wrong type, values of the wrong type (dates, URLs, numbers, enumerations like `https://schema.org/InStock`, ISO 8601 durations), nested objects with no `@type`, and unfilled template placeholders (`{{wf …}}`, `${…}`).
- **Google rich results.** 31 feature rules: Article, Breadcrumb, Carousel, Course list, Dataset, Discussion forum, Education Q&A, Employer rating, Event, FAQ, How-to, Image metadata, Job posting, Local business, Math solver, Movie, Organization, Product snippet, Merchant listing, Profile page, Q&A, Recipe, Review snippet, Software app, Speakable, Vacation rental, Video, Site name, plus retired types (Fact check, Special announcement, Estimated salary). Entities linked by `@id` are resolved across `@graph` and across blocks, the way Google merges them.
- **Policy notes that catch people out.**
  - FAQ rich results stopped showing on May 7, 2026.
  - How-to and the sitelinks search box are gone.
  - Ratings on your own Organization or LocalBusiness fall under Google's self-serving reviews policy, so they won't show stars.
  - Events must be at a physical location (since June 2025).
  - Merchant listings need an `Offer` with a price above 0, not an `AggregateOffer`.

## Not covered

- RDFa support is RDFa Lite (`vocab`, `typeof`, `property`, `resource`, `prefix`) plus `about`, `content`, and `href`/`src` values. Full RDFa chaining with `rel`, `rev`, and `datatype` isn't handled.
- Microdata or RDFa text edited in place (without adding or removing elements) isn't picked up live. Click the re-scan button.
- Google also requires markup to match visible page content. That can't be checked automatically.
- The badge comes from on-page checks only. The panel's HTTP status, `X-Robots-Tag`, and robots.txt results come from network fetches, so the panel can show a couple more errors than the badge.
- Online tools (Rich Results Test, PageSpeed) can't reach `localhost` or password-protected staging sites. For those, use **Schema → Source → Copy all as `<script>` tags** and paste the result into the Rich Results Test's **Code** tab. Microdata and RDFa items are included as their JSON-LD conversion.

## Development

```bash
npm install
```

```bash
npm test
```

Runs the unit tests for the validator, SEO checks, robots.txt matching, and snapshot diffs.

```bash
npm run test:e2e
```

Loads the real extension in Playwright's Chromium and checks every feature against the fixture pages in `tests/fixtures/`. Set `SCREENSHOT_DIR=/some/dir` to save screenshots of each tab. Set `CHROMIUM_PATH` if Chromium isn't in the Playwright cache.

```
manifest.json
src/
  background.js          badge + side panel wiring (MV3 service worker)
  content.js             collects meta tags, headings, images, links, JSON-LD, Microdata, RDFa; watches for changes
  lib/markup.js          converts Microdata and RDFa to JSON-LD (classic script shared with the content script)
  lib/validator.js       JSON-LD parsing and schema.org checks (also runs on converted Microdata/RDFa)
  lib/google-rules.js    Google rich result requirements, one entry per feature
  lib/seo.js             on-page SEO checks
  lib/robots.js          robots.txt parsing and matching
  lib/diff.js            snapshots, snapshot diffs, staging ↔ live URL mapping
  lib/vocab-data.js      compiled schema.org vocabulary (generated)
  sidepanel/             the UI
scripts/                 vocab, icon, and zip builders
tests/                   unit tests, e2e test, fixtures
```

### Keeping rules current

Google changes structured data requirements several times a year. The rules in `src/lib/google-rules.js` were last checked against Google's docs on **2026-10-16**. To update them, review the change log at <https://developers.google.com/search/updates>, edit the matching feature entry (`required`, `recommended`, `status`, `statusNote`, `check`), and add a test in `tests/validator.test.js`.

To refresh the schema.org vocabulary:

```bash
npm run build:vocab
```
