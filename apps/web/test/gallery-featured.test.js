import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { toPublicList } from '../src/artwork-schema.js';
import { renderArtworkCards, SSR_FEATURED_COUNT } from '../src/gallery-ssr.js';
import { FEATURED_COUNT, PAGE_SIZE } from '../public/gallery-display.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const galleryHtml = readFileSync(resolve(publicDir, 'gallery.html'), 'utf8');
const scriptJs = readFileSync(resolve(publicDir, 'script.js'), 'utf8');
const catalog = JSON.parse(readFileSync(resolve(here, '../../../catalog/catalog.json'), 'utf8'));

function extractCards(html) {
  return html.match(/<article class="painting-card"[\s\S]*?<\/article>/g) || [];
}

// ===========================================================================
// 1. SSR: all 86 cards present for no-JS/indexing; only the Featured window
//    renders un-hidden (no flash under strict CSP, no inline script)
// ===========================================================================

test('SSR keeps the complete 86-card catalogue in the HTML', () => {
  const html = renderArtworkCards(toPublicList(catalog), SSR_FEATURED_COUNT);
  assert.equal(extractCards(html).length, 86);
});

test('SSR renders exactly the first 10 artist-ordered cards un-hidden', () => {
  const html = renderArtworkCards(toPublicList(catalog), SSR_FEATURED_COUNT);
  const cards = extractCards(html);
  assert.equal(cards.length, 86);
  for (let i = 0; i < cards.length; i++) {
    const hidden = /\shidden>/.test(cards[i]);
    assert.equal(hidden, i >= SSR_FEATURED_COUNT, `card ${i} hidden state`);
  }
  // SSR featured window matches the client's deterministic featured count.
  assert.equal(SSR_FEATURED_COUNT, FEATURED_COUNT);
});

test('renderArtworkCards hides nothing without an explicit count (default)', () => {
  const html = renderArtworkCards(toPublicList(catalog));
  assert.equal((html.match(/\shidden>/g) || []).length, 0);
  const few = renderArtworkCards(toPublicList(catalog).slice(0, 5), 10);
  assert.equal((few.match(/\shidden>/g) || []).length, 0, 'fewer cards than the window: none hidden');
});

test('the gallery page declares the featured intro, filters, live status, and load-more row in source order', () => {
  const featuredNote = galleryHtml.indexOf('gallery-featured-note');
  const filters = galleryHtml.indexOf('id="gallery-filters"');
  const results = galleryHtml.indexOf('id="gallery-results"');
  const grid = galleryHtml.indexOf('id="gallery-grid"');
  const loadMore = galleryHtml.indexOf('id="gallery-load-more"');
  for (const idx of [featuredNote, filters, results, grid, loadMore]) {
    assert.ok(idx > -1);
  }
  assert.ok(featuredNote < filters, 'the compact featured intro precedes the filters');
  assert.ok(filters < grid, 'filters sit before the result grid');
  assert.ok(grid < loadMore, 'the load-more control follows the grid');
  assert.match(
    galleryHtml,
    /<p class="gallery-results" id="gallery-results" role="status" aria-live="polite"><\/p>/,
    'the live region is an explicit polite status'
  );
  const btn = galleryHtml.match(/<button[^>]*id="gallery-load-more"[^>]*>/)[0];
  assert.match(btn, /type="button"/);
  assert.match(btn, /class="button button-secondary"/);
  assert.match(/\bhidden\b/.test(btn + galleryHtml.match(/id="gallery-load-more"[^>]*>/)[0]).toString(), /./);
});

// ===========================================================================
// 2. Client contract: featured default, batched reveal, no duplicates
// ===========================================================================

test('script.js keeps a single SSR card set (no duplicated featured + full grids)', () => {
  // Exactly one gallery grid container; featured reuses the same cards.
  assert.equal((galleryHtml.match(/id="gallery-grid"/g) || []).length, 1);
  assert.doesNotMatch(galleryHtml, /gallery-featured-grid/, 'no separate featured grid markup');
});

test('script.js builds the Featured-first filter bar with All (86) and existing sizes', () => {
  assert.match(scriptJs, /\[FEATURED_KEY, ALL_KEY, ...SIZE_FILTERS, MISC_KEY\]/, 'chip order: Featured, All, sizes, misc');
  assert.match(scriptJs, /button\.textContent = filterLabel\(key\);/, 'the Featured chip carries no count');
  assert.match(
    scriptJs,
    /button\.textContent = `\$\{filterLabel\(key\)\} \(\$\{count\}\)`;/,
    'other chips carry their counts'
  );
});

test('script.js: Featured shows the deterministic first-10 with no load more', () => {
  // Selecting featured sets shown to the matching total (capped at 10) and
  // the load-more control hides when loadMoreLabel returns null.
  assert.match(scriptJs, /const shown = key === FEATURED_KEY \? total : clampShown\(PAGE_SIZE, total\);/);
  assert.match(scriptJs, /if \(label === null\) \{\s*loadMoreButton\.hidden = true;/);
});

test('script.js: All/size reveal the first 12, then +12 per Load more (no infinite scroll)', () => {
  assert.match(scriptJs, /clampShown\(PAGE_SIZE, total\)/, 'initial batch is PAGE_SIZE');
  assert.match(
    scriptJs,
    /clampShown\(activeState\.shown \+ PAGE_SIZE, total\)/,
    'load more adds exactly one batch'
  );
  assert.doesNotMatch(scriptJs, /IntersectionObserver/, 'no infinite scroll');
  // Hidden cards leave the a11y tree and focus order via the hidden attribute.
  assert.match(scriptJs, /card\.hidden = !visibility\[index\];/);
});

test('script.js announces "Showing X of Y paintings" and accessible load-more semantics', () => {
  assert.match(scriptJs, /resultSummary\(Math\.min\(shown, total\), total\)/);
  assert.match(scriptJs, /loadMoreButton\.textContent = label;/, 'the button label carries next/remaining counts');
});

test('script.js URL state: pushState for user actions, popstate reapplies, hash preserved', () => {
  assert.match(scriptJs, /window\.history\.pushState\(null, '', url\)/, 'user actions push history');
  assert.match(
    scriptJs,
    /window\.addEventListener\('popstate', \(\) => \{\s*applyState\(readStateFromUrl\(\), \{ updateUrl: false \}\);/,
    'popstate reapplies the URL state without rewriting'
  );
  assert.match(scriptJs, /window\.location\.hash/, 'the hash is preserved in pushed URLs');
  // Direct load reads the URL once without rewriting it.
  assert.match(scriptJs, /applyState\(readStateFromUrl\(\), \{ updateUrl: false \}\);/);
  assert.doesNotMatch(scriptJs, /replaceState/, 'no replaceState: Back/Forward must work');
});

test('script.js never fetches the catalogue or rebuilds the grid', () => {
  assert.equal(/\bfetch\s*\(/.test(scriptJs), false);
  assert.equal(scriptJs.includes('innerHTML'), false);
  assert.equal(scriptJs.includes('renderGallery'), false);
  assert.equal(scriptJs.includes('loadArtworks'), false);
  assert.match(scriptJs, /from '\.\/gallery-display\.js'/);
});

test('the client enhances SSR cards in place including hidden ones (dialog wiring is unconditional)', () => {
  assert.match(scriptJs, /for \(const card of cards\) \{[\s\S]*?openPaintingDialog\(card\)/);
});

// ===========================================================================
// 3. Selected filter is obvious beyond colour (shape/weight/border)
// ===========================================================================

test('the selected filter chip is conveyed by weight and border, not colour alone', () => {
  const stylesCss = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
  const pressed = stylesCss.match(/\.filter-chip\[aria-pressed="true"\]\s*\{([^}]*)\}/);
  assert.ok(pressed);
  assert.match(pressed[1], /font-weight:\s*600/, 'heavier weight');
  assert.match(pressed[1], /border:\s*2px solid var\(--accent-deep\)/, 'a deliberate 2px border');
  assert.match(pressed[1], /color:\s*var\(--on-accent\)/, 'accent fill retained on top of shape+weight');
});

test('gallery page copy keeps the enquiry spelling and exact hero', () => {
  assert.match(galleryHtml, /<p class="eyebrow">MJ&rsquo;s gallery<\/p>/);
  assert.equal(
    galleryHtml.match(/<h1>([\s\S]*?)<\/h1>/)[1].trim(),
    'Every painting carries a piece of the journey.'
  );
  const heroText = galleryHtml.match(/<p class="hero-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim();
  assert.equal(
    heroText,
    'Explore colour, texture, faith, frustration, joy, and the unexpected beauty MJ has discovered while learning to live differently. Each work is original, personal, and created one expressive layer at a time.'
  );
  const visibleText = galleryHtml.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visibleText, /inquir/i, 'no visitor-visible inquiry spelling on Gallery');
  assert.match(galleryHtml, />Enquire about this painting</, 'the dialog action uses enquiry');
  assert.equal(PAGE_SIZE, 12);
});
