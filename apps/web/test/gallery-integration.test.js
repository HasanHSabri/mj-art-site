import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { validateArtworkList, toPublicList } from '../src/artwork-schema.js';
import { renderArtworkCards, SSR_FEATURED_COUNT } from '../src/gallery-ssr.js';
import { countBySize, cardSizeKey } from '../public/gallery-display.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(here, '../../../catalog/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const scriptSrc = readFileSync(resolve(here, '../public/script.js'), 'utf8');
const indexSrc = readFileSync(resolve(here, '../public/index.html'), 'utf8');

// Extract individual SSR card fragments from a rendered gallery string.
function extractCards(html) {
  const re = /<article class="painting-card"[\s\S]*?<\/article>/g;
  return html.match(re) || [];
}

function dataAttr(card, name) {
  const m = card.match(new RegExp(`data-${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

test('the real catalogue validates under the canonical schema', () => {
  const result = validateArtworkList(catalog);
  assert.equal(result.ok, true, `catalogue must validate: ${result.error || ''}`);
});

test('the real catalogue has exactly 86 records (75 catalogue + 11 miscellaneous)', () => {
  assert.equal(catalog.length, 86);
  const byCat = catalog.reduce((a, r) => { a[r.category] = (a[r.category] || 0) + 1; return a; }, {});
  assert.deepEqual(byCat, { catalogue: 75, miscellaneous: 11 });
});

test('SSR renders exactly 86 cards from the projected real catalogue', () => {
  const html = renderArtworkCards(toPublicList(catalog));
  const cards = extractCards(html);
  assert.equal(cards.length, 86);
});

test('SSR with the featured window renders all 86 cards, only the first 10 un-hidden', () => {
  // The Worker renders /gallery with SSR_FEATURED_COUNT so the default
  // Featured view paints with no flash: every card stays in the HTML (no-JS
  // and indexing), cards beyond the window carry `hidden`.
  const html = renderArtworkCards(toPublicList(catalog), SSR_FEATURED_COUNT);
  const cards = extractCards(html);
  assert.equal(cards.length, 86);
  assert.equal((html.match(/\shidden>/g) || []).length, 86 - SSR_FEATURED_COUNT);
  for (let i = 0; i < cards.length; i++) {
    assert.equal(/\shidden>/.test(cards[i]), i >= SSR_FEATURED_COUNT, `card ${i}`);
  }
});

test('SSR per-size filter counts match the real catalogue', () => {
  const html = renderArtworkCards(toPublicList(catalog));
  const cards = extractCards(html);
  const descriptors = cards.map((c) => ({
    category: dataAttr(c, 'category'),
    sizeCategory: dataAttr(c, 'size-category')
  }));
  const counts = countBySize(descriptors);
  assert.equal(counts.all, 86);
  assert.equal(counts['20x20'], 37);
  assert.equal(counts['20x25'], 11);
  assert.equal(counts['25x25'], 4);
  assert.equal(counts['30x23'], 1);
  assert.equal(counts['30x30'], 6);
  assert.equal(counts['35x28'], 2);
  assert.equal(counts['40x30'], 10);
  assert.equal(counts['47x57'], 1);
  assert.equal(counts['50x25'], 1);
  assert.equal(counts['55x30'], 1);
  assert.equal(counts['58x73'], 1);
  assert.equal(counts.miscellaneous, 11);
});

test('every SSR card derives its filter key from public category/size-category attrs', () => {
  const html = renderArtworkCards(toPublicList(catalog));
  for (const card of extractCards(html)) {
    const key = cardSizeKey({
      category: dataAttr(card, 'category'),
      sizeCategory: dataAttr(card, 'size-category')
    });
    assert.ok(typeof key === 'string' && key.length > 0);
  }
});

test('no SSR card leaks internal-only fields or local paths', () => {
  const html = renderArtworkCards(toPublicList(catalog));
  const forbidden = ['catalogNumber', 'sortOrder', 'provenance', 'sha256', 'driveFileId', 'driveFolder', '/tmp/', '/workspace/', '/home/'];
  for (const needle of forbidden) {
    assert.equal(html.includes(needle), false, `SSR output must not contain "${needle}"`);
  }
});

test('every SSR card uses a thumbnail img and a full-size data-image under mj|misc paths', () => {
  const html = renderArtworkCards(toPublicList(catalog));
  for (const card of extractCards(html)) {
    const imgMatch = card.match(/<img src="([^"]*)"/);
    assert.ok(imgMatch, 'card has an img');
    assert.match(imgMatch[1], /^\/artwork-uploaded\/artwork\/catalog\/(mj|misc)-\d{3}\/thumb\.jpg$/);
    assert.match(dataAttr(card, 'image'), /^\/artwork-uploaded\/artwork\/catalog\/(mj|misc)-\d{3}\/full\.jpg$/);
    assert.ok(card.includes('loading="lazy"'));
    assert.ok(card.includes('decoding="async"'));
  }
});

test('the public client never fetches /api/artworks or rebuilds the grid', () => {
  // No network fetch of the artworks API, no innerHTML wipes, no legacy rebuild.
  assert.match(scriptSrc, /NEVER fetches/);
  assert.equal(/\bfetch\s*\(/.test(scriptSrc), false);
  assert.equal(scriptSrc.includes('innerHTML'), false);
  assert.equal(scriptSrc.includes('renderGallery'), false);
  assert.equal(scriptSrc.includes('renderEmptyGallery'), false);
  assert.equal(scriptSrc.includes('loadArtworks'), false);
  // It must enhance SSR cards in place via the pure display module.
  assert.match(scriptSrc, /from '\.\/gallery-display\.js'/);
});

test('the static index has no hardcoded cards and no More works placeholder', () => {
  const between = indexSrc.match(/artwork-gallery:start -->([\s\S]*)<!-- artwork-gallery:end/)[1];
  assert.equal(between.includes('<article'), false);
  assert.equal(between.includes('painting-card'), false);
  assert.equal(indexSrc.includes('More works'), false);
});
