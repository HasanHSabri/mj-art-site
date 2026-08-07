import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildEoiPayload,
  messageForStatus,
  findBookEntry,
  counterValue,
  counterText,
  pluralize,
  BOOK_VALUES,
  FORMAT_VALUES,
  MIN_QUANTITY,
  MAX_QUANTITY
} from '../public/books.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const booksHtml = readFileSync(join(publicDir, 'books.html'), 'utf8');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');
const booksJs = readFileSync(join(publicDir, 'books.js'), 'utf8');
const backToTopJs = readFileSync(join(publicDir, 'back-to-top.js'), 'utf8');
const rootPkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

function mediaBlock(css, feature) {
  const start = css.indexOf(`@media ${feature}`);
  if (start === -1) return null;
  const next = css.indexOf('@media', start + 1);
  return css.slice(start, next === -1 ? undefined : next);
}

// ===========================================================================
// 1. HTML structure: two typographic book panels + live counters
// ===========================================================================

test('there are exactly two book panels labelled Biography and Children\'s Book', () => {
  const panels = booksHtml.match(/<article class="books-panel"[\s\S]*?<\/article>/g);
  assert.ok(panels, 'books-panel articles must exist');
  assert.equal(panels.length, 2);
  assert.ok(booksHtml.includes('Biography'), 'a Biography panel exists');
  assert.ok(/Children&rsquo;s Book|Children's Book/.test(booksHtml), "a Children's Book panel exists");
});

test('each book panel exposes interest and copies counter hooks', () => {
  for (const book of ['biography', 'childrens']) {
    assert.ok(
      new RegExp(`data-book-counters="${book}"`).test(booksHtml),
      `${book} counters container must exist`
    );
    assert.ok(
      new RegExp(`data-book-interest="${book}"`).test(booksHtml),
      `${book} interest value hook must exist`
    );
    assert.ok(
      new RegExp(`data-book-copies="${book}"`).test(booksHtml),
      `${book} copies value hook must exist`
    );
  }
});

test('counters start with a non-numeric placeholder (no fake counts)', () => {
  // Both the interest and copies hooks start as an em dash entity, never a
  // fabricated number (and never an apparent 0 while data loads).
  for (const book of ['biography', 'childrens']) {
    const interest = booksHtml.match(new RegExp(`data-book-interest="${book}"[^>]*>([^<]*)<`));
    assert.ok(interest, `${book} interest hook must exist`);
    assert.equal(interest[1].trim(), '&mdash;', `${book} interest placeholder must be an em dash, not a number`);
    const copies = booksHtml.match(new RegExp(`data-book-copies="${book}"[^>]*>([^<]*)<`));
    assert.ok(copies, `${book} copies hook must exist`);
    assert.equal(copies[1].trim(), '&mdash;', `${book} copies placeholder must be an em dash, not a number`);
  }
});

// ===========================================================================
// 2. EOI form: canonical fields, honeypot, required consent, Turnstile marker
// ===========================================================================

test('the EOI form uses canonical book radio values matching the backend allowlist', () => {
  const form = booksHtml.match(/<form[^>]*id="books-eoi-form"[\s\S]*?<\/form>/)[0];
  const radios = form.match(/<input[^>]*type="radio"[^>]*name="book"[^>]*>/g);
  assert.ok(radios);
  const values = radios.map((r) => r.match(/value="([^"]+)"/)[1]).sort();
  assert.deepEqual(values, [...BOOK_VALUES].sort());
});

test('the EOI form uses canonical format option values matching the backend allowlist', () => {
  const form = booksHtml.match(/<form[^>]*id="books-eoi-form"[\s\S]*?<\/form>/)[0];
  const opts = form.match(/<option value="[^"]+"/g) || [];
  const values = opts.map((o) => o.match(/value="([^"]+)"/)[1]).sort();
  assert.deepEqual(values, [...FORMAT_VALUES].sort());
});

test('quantity input enforces the backend 1..10 integer window', () => {
  const input = booksHtml.match(/<input[^>]*name="quantity"[^>]*>/)[0];
  assert.equal(input.match(/min="(\d+)"/)[1], String(MIN_QUANTITY));
  assert.equal(input.match(/max="(\d+)"/)[1], String(MAX_QUANTITY));
  assert.match(input, /step="1"/);
});

test('a hidden honeypot field (website) is present and visually hidden', () => {
  assert.match(booksHtml, /name="website"/, 'honeypot named website must exist');
  assert.match(booksHtml, /books-honeypot/, 'a honeypot container class must exist');
  assert.match(booksCss, /\.books-honeypot\s*\{[\s\S]*?position:\s*absolute/, 'honeypot is positioned off-screen');
});

test('consent is an explicit, required checkbox', () => {
  const cb = booksHtml.match(/<input[^>]*name="consent"[^>]*>/)[0];
  assert.match(cb, /type="checkbox"/);
  assert.match(cb, /\brequired\b/);
  // The consent copy states updates-only usage.
  assert.match(booksHtml, /updates[\s\S]*?book/i);
});

test('the Turnstile container carries the unique site-key marker and the books-eoi action', () => {
  const box = booksHtml.match(/<div[^>]*id="books-turnstile"[^>]*>/)[0];
  assert.match(box, /data-sitekey="__BOOKS_TURNSTILE_SITE_KEY__"/, 'site key is a marker, never a literal key');
  assert.match(box, /data-action="books-eoi"/);
});

test('no literal/hardcoded Turnstile site key is present in the HTML', () => {
  // A real site key looks like 1x...; the page must only ever carry the marker.
  assert.equal(/data-sitekey="(0x|1x)[a-f0-9]+/i.test(booksHtml), false);
  assert.equal(booksHtml.includes('1x00000000000000000000AA'), false);
});

test('a live status region and a counters status region exist for assistive feedback', () => {
  assert.match(booksHtml, /id="books-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(booksHtml, /id="books-counters-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('no-JS text requires JS + Turnstile and links only to the gallery (no email fallback)', () => {
  const noscript = booksHtml.match(/<noscript>([\s\S]*?)<\/noscript>/)[1];
  assert.match(noscript, /JavaScript/i);
  assert.match(noscript, /gallery/i);
  assert.match(noscript, /href="\/#gallery"/);
  assert.equal(noscript.includes('mailto:'), false, 'no email fallback in the books noscript');
});

// ===========================================================================
// 3. Copy honesty: EOI (not payment/purchase), updates-only usage
// ===========================================================================

test('copy states this is an expression of interest, not a payment or purchase', () => {
  assert.match(booksHtml, /expression of interest/i);
  assert.match(booksHtml, /not a payment/i);
  assert.match(booksHtml, /not a commitment to buy/i);
});

test('copy states details are used only for selected-book updates', () => {
  assert.match(booksHtml, /used only to share updates about the book/i);
});

test('no invented book data: no covers, prices, release dates, or pre-order claims', () => {
  // No cover imagery at all.
  assert.equal(/<img[^>]*(books-cover|book-cover)/i.test(booksHtml), false);
  // No currency/price tokens.
  assert.equal(/(A\$|AUD|\$\d)/i.test(booksHtml), false);
  assert.equal(/\bprice\b/i.test(booksHtml), false);
  assert.equal(/\b(pre-?order|preorder)\b/i.test(booksHtml), false, 'must not promise a pre-order');
  assert.equal(/\bISBN\b/i.test(booksHtml), false);
  assert.equal(/\b(release date|launches on|available \d{4})\b/i.test(booksHtml), false);
  assert.equal(/\b(best-?seller|bestseller)\b/i.test(booksHtml), false);
});

test('copy is honest that online buying is undecided', () => {
  assert.match(
    booksHtml,
    /how and where these books can be bought online is\s+still to be decided/i
  );
});

// ===========================================================================
// 4. Navigation: Books is current page; section links are root-absolute
// ===========================================================================

test('Books chapter-nav links carry aria-current="page" in the static markup', () => {
  const matches = booksHtml.match(/href="\/books"[^>]*aria-current="page"/g);
  assert.ok(matches && matches.length >= 2, 'both rail and menu Books links are marked current page');
});

test('chapter-nav section links point to root-absolute home anchors', () => {
  const nav = booksHtml.match(/<nav[^>]*class="[^"]*chapter-nav[^"]*"[\s\S]*?<\/nav>/)[0];
  assert.match(nav, /href="\/#gallery"/);
  assert.match(nav, /href="\/#story"/);
  assert.match(nav, /href="\/#testimonials"/);
  assert.match(nav, /href="\/#contact"/);
  // No bare in-page anchors (those would strand a Books visitor).
  assert.equal(/href="#gallery"/.test(nav), false);
});

test('the topbar brand links home and section links are root-absolute', () => {
  const topbar = booksHtml.match(/<nav[^>]*class="[^"]*topbar[^"]*"[\s\S]*?<\/nav>/)[0];
  assert.match(topbar, /class="brand" href="\/"/);
  assert.match(topbar, /href="\/#gallery"/);
  assert.match(topbar, /href="\/#story"/);
  assert.match(topbar, /href="\/#contact"/);
});

test('Books page provides #top as the Back to Top target and loads chapter-nav + books.js', () => {
  assert.match(booksHtml, /\bid="top"/);
  assert.match(booksHtml, /<button[^>]*id="back-to-top"/);
  assert.match(booksHtml, /<script[^>]*src="\.\/chapter-nav\.js/);
  assert.match(booksHtml, /<script[^>]*src="\.\/books\.js/);
});

// ===========================================================================
// 5. CSS: responsive 2->1 grid, centered readable form, no overflow
// ===========================================================================

test('book grid is two columns by default and collapses to one', () => {
  const grid = ruleBody(booksCss, '.books-grid');
  assert.ok(grid, '.books-grid rule must exist');
  assert.match(grid, /grid-template-columns:\s*repeat\(2/);
  const narrow = mediaBlock(booksCss, '(max-width: 960px)');
  assert.ok(narrow, 'a max-width: 960px breakpoint must exist');
  assert.match(narrow, /\.books-grid\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test('EOI form is centered with a bounded readable measure', () => {
  // Both tokens are unique to the standalone Books form/section rules (the
  // grouped surface rules do not carry them), so a direct text check is robust.
  assert.match(booksCss, /max-width:\s*620px/, 'the form must have a bounded readable measure');
  assert.match(booksCss, /justify-items:\s*center/, 'the form section must center the form');
});

test('counters collapse to one column on very narrow viewports (no 320px overflow)', () => {
  const very = mediaBlock(booksCss, '(max-width: 420px)');
  assert.ok(very, 'a max-width: 420px breakpoint must exist for the counters');
  assert.match(very, /\.books-counters\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test('EOI form and its grid children/controls can shrink (min-width:0) to avoid 320px overflow', () => {
  // The form is a grid item (of .books-form-section) and itself a grid
  // container; without min-width:0 the form and its fields default to
  // min-width:auto and force horizontal overflow at 320px. The standalone form
  // rule (uniquely identified by max-width:620px, which the grouped surface
  // rule does not carry) must set min-width:0; fieldset/label children carry
  // min-width:0; inputs/selects are capped to their cell.
  assert.match(
    booksCss,
    /\.books-eoi-form\s*\{[^}]*max-width:\s*620px[^}]*min-width:\s*0/,
    'the standalone .books-eoi-form rule must set min-width:0'
  );
  assert.match(booksCss, /\.books-eoi-form\s+fieldset[\s\S]*?min-width:\s*0/, 'fieldset children must set min-width:0');
  assert.match(booksCss, /\.books-eoi-form\s+label[\s\S]*?min-width:\s*0/, 'label children must set min-width:0');
  assert.match(booksCss, /\.books-eoi-form\s+input[\s\S]*?max-width:\s*100%/, 'inputs must be capped to their cell');
});

test('EOI form and nested label/fieldset grids pin an explicit minmax(0,1fr) track (root-cause 320px fix)', () => {
  // Root cause: styles.css makes every <label> a display:grid container, and
  // .books-eoi-form + .books-fieldset are grids too. Their implicit auto tracks
  // (minmax(auto,auto)) will not shrink below intrinsic control widths, forcing
  // horizontal overflow at 320px. Each grid level must declare an explicit
  // minmax(0,1fr) single track. The standalone form rule is uniquely identified
  // by max-width:620px (the grouped surface rule lacks it); the two lookaheads
  // are order-independent within that one rule body.
  assert.match(
    booksCss,
    /\.books-eoi-form\s*\{(?=[^}]*max-width:\s*620px)(?=[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\))/,
    'the standalone .books-eoi-form grid must declare a minmax(0,1fr) track'
  );
  assert.match(
    booksCss,
    /\.books-fieldset\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    '.books-fieldset grid must declare a minmax(0,1fr) track'
  );
  assert.match(
    booksCss,
    /\.books-eoi-form\s+label\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    'form labels must override the inherited <label>{display:grid} with a minmax(0,1fr) track'
  );
  // Negative guard: no grid container in the form subtree may regress to a
  // bare/implicit track (auto min) that would reintroduce overflow.
  assert.doesNotMatch(
    booksCss,
    /\.books-(eoi-form|fieldset)\s*\{[^}]*grid-template-columns:\s*(1fr|2fr|auto|repeat\([^)]*\))/,
    'form grids must not regress to bare fr/auto tracks'
  );
});

test('the honeypot is fully removed from layout (off-screen + 1px)', () => {
  const hp = ruleBody(booksCss, '.books-honeypot');
  assert.ok(hp);
  assert.match(hp, /position:\s*absolute/);
  assert.match(hp, /left:\s*-10000px/);
  assert.match(hp, /(width:\s*1px|height:\s*1px|overflow:\s*hidden)/);
});

// ===========================================================================
// 6. books.js pure helpers (no DOM/network)
// ===========================================================================

const GOOD = {
  book: 'biography',
  format: 'hardcover',
  quantity: 2,
  name: 'Jane Doe',
  email: 'jane@example.com',
  consent: true,
  turnstileToken: 'tok'
};

test('buildEoiPayload accepts a well-formed payload and canonicalizes consent to boolean true', () => {
  const p = buildEoiPayload(GOOD);
  assert.ok(p);
  assert.equal(p.book, 'biography');
  assert.equal(p.consent, true);
  assert.deepEqual(Object.keys(p).sort(), ['book', 'consent', 'email', 'format', 'name', 'quantity', 'turnstileToken']);
});

test('buildEoiPayload returns null when any required field or consent or token is missing/invalid', () => {
  for (const overrides of [
    { book: 'novel' },
    { format: 'audiobook' },
    { quantity: 0 },
    { quantity: 11 },
    { quantity: 1.5 },
    { name: '' },
    { email: '' },
    { consent: false },
    { consent: 'yes' },
    { turnstileToken: '' }
  ]) {
    assert.equal(buildEoiPayload({ ...GOOD, ...overrides }), null, `should reject ${JSON.stringify(overrides)}`);
  }
});

test('buildEoiPayload trims name/email and parses numeric quantity from a string', () => {
  const p = buildEoiPayload({ ...GOOD, name: '  Jane  ', email: '  jane@example.com  ', quantity: '3' });
  assert.ok(p);
  assert.equal(p.name, 'Jane');
  assert.equal(p.email, 'jane@example.com');
  assert.equal(p.quantity, 3);
});

test('buildEoiPayload forwards a non-empty honeypot (so the backend can trap bots)', () => {
  const p = buildEoiPayload({ ...GOOD, website: 'spam' });
  assert.ok(p);
  assert.equal(p.website, 'spam');
});

test('buildEoiPayload omits an empty honeypot entirely', () => {
  const p = buildEoiPayload({ ...GOOD, website: '' });
  assert.ok(p);
  assert.equal('website' in p, false);
});

test('messageForStatus maps each handled status to a safe, non-leaking message', () => {
  assert.equal(messageForStatus(200), '');
  for (const [status, needle] of [
    [400, 'check your details'],
    [413, 'too large'],
    [429, 'too many'],
    [503, 'not available']
  ]) {
    assert.ok(messageForStatus(status).toLowerCase().includes(needle));
  }
  // Generic fallback for unexpected statuses.
  assert.match(messageForStatus(500), /something went wrong/i);
  assert.match(messageForStatus(404), /something went wrong/i);
});

test('findBookEntry and counterValue read the /api/books/interest shape safely', () => {
  const data = { books: [{ book: 'biography', interestCount: 3, requestedCopies: 7 }] };
  assert.equal(findBookEntry(data, 'biography').interestCount, 3);
  assert.equal(findBookEntry(data, 'childrens'), null);
  assert.equal(findBookEntry(null, 'biography'), null);
  assert.equal(counterValue(findBookEntry(data, 'biography'), 'interestCount'), '3');
  assert.equal(counterValue(null, 'interestCount'), '');
});

test('counterText keeps the em dash sentinel while loading (never an apparent 0)', () => {
  // While loading (no data object yet) the placeholder must be retained: the
  // helper returns the empty sentinel so the caller leaves the em dash alone.
  assert.equal(counterText(null, 'biography', 'interestCount'), '', 'null data -> empty sentinel');
  assert.equal(counterText(undefined, 'biography', 'interestCount'), '', 'undefined data -> empty sentinel');
  assert.equal(counterText('', 'biography', 'interestCount'), '', 'string data (loading call) -> empty sentinel');
  assert.equal(counterText('loading', 'biography', 'interestCount'), '', 'non-object data -> empty sentinel');
  // Once data is present, a missing entry is a genuine 0 (backend returns both).
  assert.equal(counterText({ books: [] }, 'biography', 'interestCount'), '0', 'data present, missing entry -> real 0');
  assert.equal(counterText({ books: [] }, 'biography', 'requestedCopies'), '0', 'data present, missing entry -> real 0');
  // Real data renders the actual number.
  const data = { books: [{ book: 'biography', interestCount: 3, requestedCopies: 7 }] };
  assert.equal(counterText(data, 'biography', 'interestCount'), '3');
  assert.equal(counterText(data, 'biography', 'requestedCopies'), '7');
  assert.equal(counterText(data, 'childrens', 'interestCount'), '0', 'other book missing -> real 0');
});

test('pluralize picks singular vs plural by count', () => {
  assert.equal(pluralize(1, 'person', 'people'), 'person');
  assert.equal(pluralize(0, 'person', 'people'), 'people');
  assert.equal(pluralize(3, 'person', 'people'), 'people');
});

// ===========================================================================
// 7. books.js source contract (no fallback paths; official Turnstile; token field)
// ===========================================================================

test('books.js posts to /api/books/eoi and reads /api/books/interest (no fallback)', () => {
  assert.match(booksJs, /'\/api\/books\/eoi'/);
  assert.match(booksJs, /'\/api\/books\/interest'/);
  // No actual mail/localStorage/R2 USAGE paths (the explanatory header comment
  // legitimately mentions these by name, so we assert against real member access).
  assert.doesNotMatch(booksJs, /mailto:/, 'no mail fallback');
  assert.doesNotMatch(booksJs, /localStorage\s*\.\s*(get|set|remove)Item/, 'no localStorage usage');
  assert.doesNotMatch(booksJs, /ARTWORK_IMAGES|env\.R2|R2_BUCKET/, 'no R2 usage');
});

test('books.js loads the official Turnstile script and never hardcodes a site key', () => {
  assert.match(
    booksJs,
    /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/,
    'must load the official explicit-render Turnstile script'
  );
  assert.match(booksJs, /turnstile\.render\(/, 'must render the widget explicitly');
  // The site key is read from the DOM marker, never a literal.
  assert.doesNotMatch(booksJs, /sitekey:\s*['"](0x|1x)[a-f0-9]+/i);
});

test('books.js sends the token as turnstileToken (matches backend field) and requires consent', () => {
  assert.match(booksJs, /turnstileToken/);
  assert.match(booksJs, /consent:\s*true/);
});

test('books.js prevents duplicate submits, resets Turnstile, and refreshes counters after success', () => {
  assert.match(booksJs, /if\s*\(\s*submitting\s*\)\s*return/);
  assert.match(booksJs, /resetTurnstile/);
  assert.match(booksJs, /await loadCounters/);
});

test('books.js never overwrites the placeholder during loading (no apparent 0)', () => {
  // setCounters must early-return while there is no data object so the em dash
  // placeholder in the markup is preserved, then route through counterText.
  assert.match(
    booksJs,
    /function setCounters[\s\S]*?if\s*\(\s*!data\s*\|\|\s*typeof data\s*!==\s*'object'\s*\)\s*return/,
    'setCounters must skip writing until a data object is present'
  );
  assert.match(booksJs, /counterText\(data,\s*book,\s*'interestCount'\)/);
  assert.match(booksJs, /counterText\(data,\s*book,\s*'requestedCopies'\)/);
  // The old loading bug (counterValue(...) || '0' inside setCounters) is gone.
  assert.doesNotMatch(
    booksJs,
    /function setCounters[\s\S]*?\}\s*function[\s\S]*?counterValue\([^)]*\)\s*\|\|\s*'0'/,
    'setCounters must not fall back to a literal 0 from counterValue'
  );
});

test('books.js Back to Top uses the shared module (no duplicated logic)', () => {
  // The behaviour lives once in ./back-to-top.js; books.js imports and calls it
  // (with no dialog -> the simpler scroll-only variant).
  assert.match(booksJs, /import\s*\{\s*initBackToTop\s*\}\s*from\s*['"]\.\/back-to-top\.js['"]/);
  assert.match(booksJs, /initBackToTop\(\)/, 'books.js must call initBackToTop with no dialog');
  // The page-local scroll/threshold logic must NOT be duplicated in books.js.
  assert.doesNotMatch(booksJs, /BACK_TO_TOP_THRESHOLD/, 'books.js must not redefine the threshold');
  assert.doesNotMatch(booksJs, /function\s+initBackToTop\s*\(/, 'books.js must not redefine initBackToTop');
  // The shared module owns the behaviour and targets the page #top.
  assert.match(backToTopJs, /getElementById\('back-to-top'\)/);
  assert.match(backToTopJs, /getElementById\('top'\)/);
  assert.match(backToTopJs, /addEventListener\('scroll',\s*sync,\s*\{\s*passive:\s*true\s*\}\)/);
});

// ===========================================================================
// 8. Build integration
// ===========================================================================

test('books.js and back-to-top.js are syntax-checked by build/lint/type-check', () => {
  for (const file of ['public/books.js', 'public/back-to-top.js']) {
    for (const script of ['build', 'lint', 'type-check']) {
      assert.ok(
        rootPkg.includes(`node --check ${file}`),
        `${file} must be in the ${script} check list`
      );
    }
  }
});
