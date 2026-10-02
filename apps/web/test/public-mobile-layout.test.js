// Mobile single-column reading layout contracts (release: mobile-layout-v2).
// Source-string guards, in the repo's established style: they pin the
// single-column phone layout (<=760px), the stacked full-width actions and
// forms, the one mobile navigation, the cascade ordering that makes the
// appended blocks authoritative over the earlier 1024/960/680/640 blocks and
// the later page sheets (gallery.css / books.css), and the consistent
// cache-bust label. Desktop (>=761px) stays untouched by construction: every
// new declaration lives inside a max-width media query.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const galleryCss = readFileSync(join(publicDir, 'gallery.css'), 'utf8');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');
const pages = {
  home: readFileSync(join(publicDir, 'index.html'), 'utf8'),
  gallery: readFileSync(join(publicDir, 'gallery.html'), 'utf8'),
  books: readFileSync(join(publicDir, 'books.html'), 'utf8'),
};

// Extract one full @media block by balancing braces (media blocks nest
// rules, so a [^}]* capture would stop at the first inner close brace).
function mediaBlock(css, feature) {
  const opener = new RegExp(`@media\\s*\\(\\s*${feature}\\s*\\)\\s*\\{`);
  const start = css.match(opener);
  if (!start) return null;
  const openIndex = start.index + start[0].length;
  let depth = 1;
  let i = openIndex;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? css.slice(openIndex, i - 1) : null;
}

function ruleIn(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow the selector to sit anywhere in a selector list (e.g. first of a
  // grouped rule) as long as only other selectors/commas separate it from
  // the declaration block.
  const m = block.match(new RegExp(`${escaped}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

const mobileBlock = mediaBlock(stylesCss, 'max-width:\\s*760px');

test('every public page cache-busts the changed sheets with one release label', () => {
  const expected = {
    home: ['./styles.css?v=mobile-bottom-nav-v1', './books.css?v=mobile-layout-v2'],
    gallery: ['./styles.css?v=mobile-bottom-nav-v1', './gallery.css?v=mobile-layout-v2'],
    books: ['./styles.css?v=mobile-bottom-nav-v1', './books.css?v=mobile-layout-v2'],
  };
  for (const [page, hrefs] of Object.entries(expected)) {
    for (const href of hrefs) {
      assert.ok(
        pages[page].includes(`href="${href}"`),
        `${page} must link ${href}`
      );
    }
    // No stale CSS version labels survive anywhere on the page.
    assert.doesNotMatch(
      pages[page].replace(/\.js\?v=[a-z0-9-]+/g, ''),
      /\.css\?v=(?!mobile-bottom-nav-v1|mobile-layout-v2|nojs-gallery-restore)[a-z0-9-]+/,
      `${page} must not mix old CSS cache-bust labels`
    );
  }
});

test('a <=760px mobile layout block exists in the shared sheet', () => {
  assert.ok(mobileBlock, 'styles.css declares @media (max-width: 760px)');
});

test('the artwork grid is a single column across the whole phone band', () => {
  const grid = ruleIn(mobileBlock, '.gallery-grid');
  assert.ok(grid, '.gallery-grid rule in the 760px block');
  assert.match(grid, /grid-template-columns:\s*1fr/, 'one column, including 681-760px');
  // The shared-sheet block must come after the earlier 2-column breakpoints
  // so it is the final word at phone widths.
  assert.ok(
    stylesCss.lastIndexOf('@media (max-width: 760px)') >
      stylesCss.lastIndexOf('@media (max-width: 1024px)'),
    'the 760px block follows the 1024px block'
  );
  // The page sheet loads later: its own guard must re-assert the column.
  const galleryMobile = mediaBlock(galleryCss, 'max-width:\\s*760px');
  assert.ok(galleryMobile, 'gallery.css declares its own <=760px guard');
  assert.match(
    ruleIn(galleryMobile, '.gallery-grid') || '',
    /grid-template-columns:\s*1fr/,
    'gallery.css re-asserts the single column after its shared import'
  );
});

test('hero actions stack full-width and the hero opens into an editorial column', () => {
  assert.match(
    ruleIn(mobileBlock, '.hero-actions') || '',
    /flex-direction:\s*column/,
    'actions stack'
  );
  assert.match(
    ruleIn(mobileBlock, '.hero-actions .button') || '',
    /width:\s*100%/,
    'stacked actions run the full column width'
  );
  const copy = ruleIn(mobileBlock, '.hero-copy');
  assert.ok(copy, '.hero-copy rule in the 760px block');
  assert.match(copy, /background:\s*none/, 'the boxed hero card chrome is removed');
  assert.match(copy, /padding:\s*0/, 'copy sits on the page ground, not in a box');
});

test('one simple mobile navigation across the phone band (fixed bottom bar)', () => {
  assert.match(
    ruleIn(mobileBlock, '.site-nav-links') || '',
    /display:\s*none/,
    'the inline link row is hidden'
  );
  // The bottom bar is the one phone navigation: displayed in the 760px block...
  assert.match(
    ruleIn(mobileBlock, '.site-nav-bottom') || '',
    /display:\s*grid/,
    'the fixed bottom bar carries navigation'
  );
  assert.match(
    ruleIn(mobileBlock, '.site-nav-bottom') || '',
    /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    'four equal tabs'
  );
  // ...and the legacy Menu disclosure is never re-displayed (base rule keeps
  // display:none), so phones never see two primary navigations.
  assert.equal(
    ruleIn(mobileBlock, '.site-nav-disclosure'),
    null,
    'the 760px block no longer displays the legacy Menu disclosure'
  );
  assert.match(
    ruleIn(mobileBlock, '.site-footer') || '',
    /padding-bottom:\s*calc\(var\(--site-nav-bottom-space/,
    'the footer clears the fixed bar (+ safe area)'
  );
  assert.match(
    ruleIn(mobileBlock, 'html') || '',
    /scroll-padding-block-end:/,
    'focused/scrolled elements clear the bar'
  );
  assert.match(
    ruleIn(mobileBlock, '.back-to-top') || '',
    /bottom:\s*calc\(var\(--site-nav-bottom-space/,
    'Back to Top is raised above the bar (z-index 40 stays above the bar\'s 30)'
  );
});

test('sections gain hairline sequencing and comfortable gutters', () => {
  assert.match(
    ruleIn(mobileBlock, '.section') || '',
    /border-top:\s*1px solid var\(--border\)/,
    'each section opens with a rule'
  );
  assert.match(
    ruleIn(mobileBlock, '.page-shell') || '',
    /width:\s*min\(100% - 40px,\s*1180px\)/,
    '20px lateral padding on phones'
  );
});

test('primary CTAs and forms are full-width and stacked', () => {
  for (const sel of [
    '.gallery-load-more-row .button',
    '.gallery-preview-cta .button',
    '.contact-form .button',
  ]) {
    assert.match(ruleIn(mobileBlock, sel) || '', /width:\s*100%/, `${sel} is full-width`);
  }
  assert.match(
    ruleIn(mobileBlock, '.gallery-filters') || '',
    /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    'filters lay out as a two-across grid of large targets'
  );

  const booksMobile = mediaBlock(booksCss, 'max-width:\\s*760px');
  assert.ok(booksMobile, 'books.css declares its own <=760px block');
  assert.match(
    ruleIn(booksMobile, '.books-panel-cta .button') || '',
    /width:\s*100%/,
    'book card CTAs are full-width'
  );
  assert.match(
    ruleIn(booksMobile, '#books-submit') || '',
    /width:\s*100%/,
    'the EOI submit is full-width'
  );
});

test('the books 320px box-model contract still resolves under the new block', () => {
  // books-form-overflow.test.js computes the 320px content box from the 640px
  // block's 20px form padding; the appended 760px block must keep that value
  // so the two breakpoints agree at <=640px.
  const booksMobile = mediaBlock(booksCss, 'max-width:\\s*760px');
  assert.match(
    ruleIn(booksMobile, '.books-eoi-form') || '',
    /padding:\s*20px/,
    'the 760px block keeps the 20px form padding'
  );
  assert.ok(
    booksCss.lastIndexOf('@media (max-width: 760px)') >
      booksCss.lastIndexOf('@media (max-width: 640px)'),
    'the books 760px block follows its 640px block'
  );
});

test('every appended mobile declaration stays scoped (desktop composition untouched)', () => {
  for (const [name, css] of [['styles.css', stylesCss], ['gallery.css', galleryCss], ['books.css', booksCss]]) {
    // From the appended 760px block to EOF: strip comments first, then remove
    // every balanced @media block; whatever remains would be an unscoped
    // (desktop-leaking) declaration.
    const decommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const from = decommented.lastIndexOf('@media (max-width: 760px)');
    assert.ok(from !== -1, `${name}: appended 760px block present`);
    const tail = decommented.slice(from);
    let rest = '';
    let i = 0;
    while (i < tail.length) {
      if (tail.startsWith('@media', i)) {
        const open = tail.indexOf('{', i);
        let depth = 1;
        let j = open + 1;
        while (j < tail.length && depth > 0) {
          if (tail[j] === '{') depth += 1;
          if (tail[j] === '}') depth -= 1;
          j += 1;
        }
        i = j;
      } else {
        rest += tail[i];
        i += 1;
      }
    }
    assert.equal(
      rest.trim(),
      '',
      `${name}: appended mobile styles are entirely inside @media blocks`
    );
  }
});
