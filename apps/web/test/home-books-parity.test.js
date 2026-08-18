// Parity contract: the Home books preview cards must carry the exact
// Books-page card treatment — the same elements in the same order, the same
// visible labels and accessible names, and proper /books?book=<code>#books-form
// hrefs (the Books page's same-page ?book=<code>#books-form links resolved
// onto the Books page from Home). The old generic Home "Follow the books" CTA
// is removed because both cards now carry the specific Join the update list
// CTA. The equal-height/bottom-CTA layout is not re-implemented: Home loads
// the same books.css rules via the existing shared classes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const booksHtml = readFileSync(join(publicDir, 'books.html'), 'utf8');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

function panelsOf(html) {
  const panels = html.match(/<article class="books-panel"[\s\S]*?<\/article>/g);
  assert.ok(panels && panels.length === 2, 'exactly two book panels');
  return panels;
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'meta', 'link']);

// Ordered signature of a card's direct children: tag + first class token.
function cardSignature(panel) {
  const body = panel.replace(/^<article[^>]*>/, '').replace(/<\/article>\s*$/, '');
  const sig = [];
  let depth = 0;
  for (const token of body.match(/<\/?[a-zA-Z][^>]*>/g) || []) {
    const tag = token.replace(/^<\/?/, '').split(/[\s>]/)[0].toLowerCase();
    if (token.startsWith('</')) {
      depth -= 1;
      continue;
    }
    if (depth === 0) {
      const cls = (token.match(/\sclass="([^"]*)"/) || [])[1];
      sig.push(cls ? `${tag}.${cls.split(/\s+/)[0]}` : tag);
    }
    if (!token.endsWith('/>') && !VOID_TAGS.has(tag)) {
      depth += 1;
    }
  }
  return sig;
}

const CARD_SIGNATURE = [
  'div.book-cover-frame',
  'p.section-label',
  'h3',
  'p.books-panel-text',
  'p.book-availability',
  'p.books-anticipation',
  'p.books-panel-cta'
];

const EXPECTED = [
  {
    code: 'biography',
    aria: 'Join the update list for Frayed Not Broken'
  },
  {
    code: 'childrens',
    aria: 'Join the update list for MJ and Her Wobbly Days'
  }
];

// ===========================================================================
// 1. Element parity: same elements, same order, on both pages
// ===========================================================================

test('Home and Books cards share the identical element sequence per book', () => {
  const home = panelsOf(indexHtml);
  const books = panelsOf(booksHtml);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(cardSignature(home[i]), CARD_SIGNATURE, `Home card ${i + 1} element order`);
    assert.deepEqual(cardSignature(books[i]), CARD_SIGNATURE, `Books card ${i + 1} element order`);
    assert.deepEqual(cardSignature(home[i]), cardSignature(books[i]), `card ${i + 1} Home/Books parity`);
  }
});

test('each Home card carries the exact Books badge, anticipation message, and CTA treatment', () => {
  const home = panelsOf(indexHtml);
  const books = panelsOf(booksHtml);
  for (let i = 0; i < 2; i++) {
    for (const [page, panel] of [['Home', home[i]], ['Books', books[i]]]) {
      assert.match(panel, /<p class="book-availability">Coming soon<\/p>/, `${page} card ${i + 1} badge`);
      assert.match(
        panel,
        /<p class="books-anticipation">Be among the first to know when it becomes available\.<\/p>/,
        `${page} card ${i + 1} anticipation message`
      );
      assert.match(
        panel,
        /<p class="books-panel-cta">\s*<a class="button button-secondary"[^>]*>Join the update list<\/a>\s*<\/p>/,
        `${page} card ${i + 1} CTA with the shared button treatment`
      );
    }
  }
});

test('covers, labels, titles, and descriptions are identical between Home and Books cards', () => {
  const home = panelsOf(indexHtml);
  const books = panelsOf(booksHtml);
  for (let i = 0; i < 2; i++) {
    assert.equal(
      home[i].match(/<div class="book-cover-frame">[\s\S]*?<\/div>/)[0],
      books[i].match(/<div class="book-cover-frame">[\s\S]*?<\/div>/)[0],
      `card ${i + 1} cover frame byte-identical (cover preserved)`
    );
    assert.equal(
      home[i].match(/<p class="section-label">([\s\S]*?)<\/p>/)[1],
      books[i].match(/<p class="section-label">([\s\S]*?)<\/p>/)[1],
      `card ${i + 1} book label`
    );
    assert.equal(
      home[i].match(/<h3>([\s\S]*?)<\/h3>/)[1],
      books[i].match(/<h3>([\s\S]*?)<\/h3>/)[1],
      `card ${i + 1} title`
    );
    assert.equal(
      home[i].match(/<p class="books-panel-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim(),
      books[i].match(/<p class="books-panel-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim(),
      `card ${i + 1} description`
    );
  }
});

// ===========================================================================
// 2. href + accessible-name parity
// ===========================================================================

test('Home CTA hrefs are the proper /books?book=<code>#books-form links', () => {
  const home = panelsOf(indexHtml);
  const books = panelsOf(booksHtml);
  for (let i = 0; i < 2; i++) {
    const homeHref = home[i].match(/<a class="button button-secondary" href="([^"]+)"/)[1];
    const booksHref = books[i].match(/<a class="button button-secondary" href="([^"]+)"/)[1];
    assert.equal(booksHref, `?book=${EXPECTED[i].code}#books-form`, `Books card ${i + 1} keeps the same-page contract`);
    assert.equal(homeHref, `/books${booksHref}`, `Home card ${i + 1} resolves the same contract onto the Books page`);
    assert.match(homeHref, /^\/books\?book=(biography|childrens)#books-form$/);
  }
});

test('accessible names are identical across pages and distinguish the two same-labelled CTAs', () => {
  const home = panelsOf(indexHtml);
  const books = panelsOf(booksHtml);
  const names = home.map((panel) => panel.match(/aria-label="([^"]+)"/)[1]);
  for (let i = 0; i < 2; i++) {
    assert.equal(names[i], EXPECTED[i].aria);
    assert.equal(
      names[i],
      books[i].match(/aria-label="([^"]+)"/)[1],
      `card ${i + 1} accessible name identical on both pages`
    );
  }
  assert.notEqual(names[0], names[1], 'the two same-visible-label CTAs need distinct accessible names');
});

// ===========================================================================
// 3. The redundant generic overall CTA is gone
// ===========================================================================

test('the redundant generic Home follow-books CTA is gone; the gallery preview keeps its own', () => {
  const section = indexHtml.match(/<section class="section books-preview-section"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(section, /gallery-preview-cta/, 'no generic overall CTA inside the books preview');
  assert.doesNotMatch(section, />Follow the books</);
  assert.equal(indexHtml.includes('Follow the books'), false, 'the old generic CTA label is gone from Home entirely');
  assert.equal(
    (indexHtml.match(/class="gallery-preview-cta"/g) || []).length,
    1,
    'only the gallery preview keeps its own centered CTA'
  );
});

// ===========================================================================
// 4. Equal-height cards with bottom-anchored CTAs via the existing shared
//    classes (Home loads the same books.css; no duplicated rules, no fixed
//    margins)
// ===========================================================================

test('Home loads the shared books.css, giving cards the exact Books layout treatment', () => {
  assert.match(
    indexHtml,
    /<link rel="stylesheet" href="\.\/books\.css\?v=[^"]+">/,
    'Home links the shared books.css'
  );
  assert.match(
    booksHtml,
    /<link rel="stylesheet" href="\.\/books\.css\?v=[^"]+">/,
    'Books links the same shared stylesheet'
  );
  const grid = ruleBody(booksCss, '.books-grid');
  assert.match(grid, /grid-template-columns:\s*repeat\(2/);
  assert.match(grid, /align-items:\s*stretch/, 'both tracks stretch so the panels share one height');
  const panel = ruleBody(booksCss, '.books-panel');
  assert.match(panel, /display:\s*flex/);
  assert.match(panel, /flex-direction:\s*column/);
  const cta = ruleBody(booksCss, '.books-panel-cta');
  assert.match(cta, /margin:\s*auto\s+0\s+0/, 'the CTA anchors to the bottom edge via margin-top auto');
  assert.doesNotMatch(cta, /margin(-top)?:\s*\d+(px|rem|em)\s*;/, 'no fixed margin offsets on the CTA');
});
