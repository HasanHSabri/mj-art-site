import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import {
  ALL_KEY,
  FEATURED_KEY,
  PAGE_SIZE,
  countMatching,
  clampShown,
  selectCardVisibility,
  parseGalleryQuery,
  galleryQuery,
  resultSummary,
  loadMoreLabel
} from '../public/gallery-display.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptJs = readFileSync(join(__dirname, '..', 'public', 'script.js'), 'utf8');

// Real 86-work catalogue descriptor counts (37 x 20x20 first, matching the
// SSR artist order used across the gallery test suite).
function realCatalogueDescriptors() {
  const counts = {
    '20x20': 37,
    '20x25': 11,
    '25x25': 4,
    '30x23': 1,
    '30x30': 6,
    '35x28': 2,
    '40x30': 10,
    '47x57': 1,
    '50x25': 1,
    '55x30': 1,
    '58x73': 1,
    miscellaneous: 11
  };
  const cards = [];
  for (const [size, n] of Object.entries(counts)) {
    const category = size === 'miscellaneous' ? 'miscellaneous' : 'catalogue';
    for (let i = 0; i < n; i++) cards.push({ category, sizeCategory: size });
  }
  return cards;
}

// Run the REAL readStateFromUrl + applyState from script.js inside a minimal
// fake-DOM context (the same vm idiom as admin-books.test.js). applyState only
// touches card.hidden, the status textContent, and the Load more control, so
// plain objects suffice; the pure helpers are the real gallery-display exports.
function createGalleryVm(descriptors, search) {
  const cards = descriptors.map(() => ({ hidden: true }));
  const state = {
    filterBar: { querySelectorAll: () => [] },
    resultsStatus: { textContent: '' },
    loadMoreButton: { hidden: false, textContent: '' },
    pushedUrls: [],
    window: {
      location: { search, pathname: '/gallery.html', hash: '' },
      history: {
        pushState: (_s, _t, url) => state.window.location.searchFromPush = url
      },
      addEventListener() {}
    }
  };
  const context = {
    window: state.window,
    cards,
    cardDescriptors: descriptors,
    filterBar: state.filterBar,
    resultsStatus: state.resultsStatus,
    loadMoreButton: state.loadMoreButton,
    activeState: { filter: FEATURED_KEY, shown: 10 },
    FEATURED_KEY,
    PAGE_SIZE,
    countMatching,
    clampShown,
    selectCardVisibility,
    parseGalleryQuery,
    galleryQuery,
    resultSummary,
    loadMoreLabel
  };
  const start = scriptJs.indexOf('// Read the canonical filter state');
  const end = scriptJs.indexOf('function openPaintingDialog');
  assert.ok(start > -1 && end > start, 'script.js must expose the state section to slice');
  runInNewContext(
    scriptJs.slice(start, end) + '\nglobalThis.__galleryStateApi = { applyState, readStateFromUrl };',
    context
  );
  return {
    ...state,
    cards,
    context,
    applyState: context.__galleryStateApi.applyState,
    readStateFromUrl: context.__galleryStateApi.readStateFromUrl,
    // The exact production Load more handler math (source-asserted by
    // gallery-featured.test.js): clampShown(activeState.shown + PAGE_SIZE, total)
    // fed straight back through applyState.
    clickLoadMore() {
      const total = countMatching(descriptors, context.activeState.filter);
      this.applyState(
        { filter: context.activeState.filter, shown: clampShown(context.activeState.shown + PAGE_SIZE, total) },
        { updateUrl: true }
      );
      const url = context.window.location.searchFromPush;
      state.pushedUrls.push(url);
      return url;
    },
    visibleCount() {
      return cards.filter((card) => !card.hidden).length;
    }
  };
}

test('lifecycle: All starts at 12 and seven live Load more activations reach exactly 86', () => {
  const vm = createGalleryVm(realCatalogueDescriptors(), '?size=all');
  vm.applyState(vm.readStateFromUrl(), { updateUrl: false });

  assert.equal(vm.visibleCount(), 12, 'All initially shows the 12-work first batch');
  assert.equal(vm.resultsStatus.textContent, 'Showing 12 of 86 paintings');
  assert.equal(vm.loadMoreButton.hidden, false);
  assert.equal(vm.loadMoreButton.textContent, 'Show 12 more (74 remaining)');

  const expected = [24, 36, 48, 60, 72, 84, 86];
  for (let i = 0; i < expected.length; i++) {
    vm.clickLoadMore();
    assert.equal(vm.visibleCount(), expected[i], `activation ${i + 1} shows ${expected[i]}`);
    assert.equal(vm.loadMoreButton.hidden, expected[i] === 86, 'button hides only once complete');
  }

  assert.equal(vm.resultsStatus.textContent, 'Showing 86 of 86 paintings');
  assert.equal(vm.loadMoreButton.hidden, true, 'Load more hides at the full 86');
  const lastUrl = vm.pushedUrls.at(-1);
  assert.ok(lastUrl.includes('shown=86'), `the pushed URL keeps the partial batch (got ${lastUrl})`);

  // Reload / back-forward round trip through the pushed URL: still 86.
  const query = '?' + lastUrl.split('?')[1];
  vm.window.location.search = query;
  vm.applyState(vm.readStateFromUrl(), { updateUrl: false });
  assert.equal(vm.visibleCount(), 86, 'reloading the shown=86 URL restores all 86, not 84');
  assert.equal(vm.loadMoreButton.hidden, true);
});

test('lifecycle: 20x20 (37 works) walks 12 -> 24 -> 36 -> 37 and hides Load more', () => {
  const vm = createGalleryVm(realCatalogueDescriptors(), '?size=20x20');
  vm.applyState(vm.readStateFromUrl(), { updateUrl: false });

  assert.equal(vm.visibleCount(), 12);
  assert.equal(vm.resultsStatus.textContent, 'Showing 12 of 37 paintings');

  const expected = [24, 36, 37];
  for (let i = 0; i < expected.length; i++) {
    vm.clickLoadMore();
    assert.equal(vm.visibleCount(), expected[i], `activation ${i + 1} shows ${expected[i]}`);
  }

  assert.equal(vm.resultsStatus.textContent, 'Showing 37 of 37 paintings');
  assert.equal(vm.loadMoreButton.hidden, true, 'Load more hides at the full 37');
  const lastUrl = vm.pushedUrls.at(-1);
  assert.ok(lastUrl.includes('shown=37'), `the pushed URL keeps the partial batch (got ${lastUrl})`);

  vm.window.location.search = '?' + lastUrl.split('?')[1];
  vm.applyState(vm.readStateFromUrl(), { updateUrl: false });
  assert.equal(vm.visibleCount(), 37, 'reloading the shown=37 URL restores all 37, not 36');
});

test('lifecycle: Featured deep link to All&shown=86 lands complete in one hop', () => {
  const vm = createGalleryVm(realCatalogueDescriptors(), '?size=all&shown=86');
  vm.applyState(vm.readStateFromUrl(), { updateUrl: false });
  assert.equal(vm.visibleCount(), 86, 'a direct shown=86 URL shows all 86 immediately');
  assert.equal(vm.loadMoreButton.hidden, true);
  assert.equal(vm.resultsStatus.textContent, 'Showing 86 of 86 paintings');
});
