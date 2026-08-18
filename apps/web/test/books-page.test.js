import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildEoiPayload,
  messageForStatus,
  hasNoSelection,
  parseBookQuery,
  BOOK_VALUES,
  MIN_QUANTITY,
  MAX_QUANTITY
} from '../public/books.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const booksHtml = readFileSync(join(publicDir, 'books.html'), 'utf8');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');
const booksJs = readFileSync(join(publicDir, 'books.js'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
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

function panels() {
  const panels = booksHtml.match(/<article class="books-panel"[\s\S]*?<\/article>/g);
  assert.ok(panels && panels.length === 2, 'there must be exactly two book panels');
  return panels;
}

// ===========================================================================
// 1. HTML structure: two book cards, exact visitor titles, real covers
// ===========================================================================

test('there are exactly two book panels titled Frayed Not Broken and MJ and Her Wobbly Days', () => {
  const [bio, kids] = panels();
  assert.match(bio, /<h3>Frayed Not Broken<\/h3>/);
  assert.match(kids, /<h3>MJ and Her Wobbly Days<\/h3>/);
  // The old title (and the old internal-facing labels) are gone everywhere.
  assert.equal(booksHtml.includes('MJ and the Wobbly Days'), false, 'the old title must not survive anywhere');
  assert.equal(/<h3>Biography<\/h3>/.test(booksHtml), false);
  assert.equal(/Children&rsquo;s Book/.test(booksHtml), false);
});

test('each book panel carries its exact approved description', () => {
  const [bio, kids] = panels();
  assert.equal(
    bio.match(/<p class="books-panel-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim(),
    'An honest and personal reflection on life with Multiple Sclerosis&mdash;its fragility, its unexpected strength, and the faith and hope that continue to carry MJ forward.'
  );
  assert.equal(
    kids.match(/<p class="books-panel-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim(),
    'A gentle children&rsquo;s story about meeting uncertain and wobbly days with courage, kindness, and hope.'
  );
});

test('each book card opens with the real cover image in a fixed contain frame', () => {
  const [bio, kids] = panels();
  assert.match(
    bio,
    /<div class="book-cover-frame">\s*<img class="book-cover" src="\/images\/frayed-not-broken-cover\.jpg" width="797" height="1200" loading="lazy" decoding="async" alt="Cover of Frayed Not Broken">\s*<\/div>/
  );
  assert.match(
    kids,
    /<div class="book-cover-frame">\s*<img class="book-cover" src="\/images\/mj-and-her-wobbly-days-cover\.jpg" width="488" height="629" loading="lazy" decoding="async" alt="Cover of MJ and Her Wobbly Days">\s*<\/div>/
  );
  // No placeholder/reserve treatment remains anywhere on the page.
  assert.equal(booksHtml.includes('book-cover-reserve'), false);
});

test('cover frames: consistent fixed outer frame with object-fit contain (complete cover visible)', () => {
  const frame = ruleBody(stylesCss, '.book-cover-frame');
  assert.ok(frame, '.book-cover-frame rule must exist');
  assert.match(frame, /aspect-ratio:\s*3\s*\/\s*4/, 'a consistent portrait frame for both books');
  const img = ruleBody(stylesCss, '.book-cover-frame img');
  assert.ok(img, '.book-cover-frame img rule must exist');
  assert.match(img, /object-fit:\s*contain/, 'the cover is contained, never cropped');
  assert.match(img, /width:\s*100%/);
  assert.match(img, /height:\s*100%/);
  const narrow = mediaBlock(stylesCss, '(max-width: 640px)');
  assert.match(narrow, /\.book-cover-frame\s*\{[^}]*width:\s*min\(100%,\s*180px\)/, 'frames stay modest on small screens');
});

// ===========================================================================
// 1b. Anticipation + anchored CTA (equal-height cards)
// ===========================================================================

test('each card carries the exact Coming soon badge, anticipation message, and Join the update list CTA', () => {
  const [bio, kids] = panels();
  for (const panel of [bio, kids]) {
    assert.match(panel, /<p class="book-availability">Coming soon<\/p>/, 'the exact Coming soon badge');
    assert.match(
      panel,
      /<p class="books-anticipation">Be among the first to know when it becomes available\.<\/p>/,
      'the exact anticipation message'
    );
    assert.match(panel, />Join the update list<\/a>/, 'the exact CTA text');
  }
});

test('CTAs preselect their own book via the ?book=<code>#books-form contract with useful accessible names', () => {
  const [bio, kids] = panels();
  assert.match(bio, /href="\?book=biography#books-form"/);
  assert.match(bio, /aria-label="Join the update list for Frayed Not Broken"/);
  assert.match(kids, /href="\?book=childrens#books-form"/);
  assert.match(kids, /aria-label="Join the update list for MJ and Her Wobbly Days"/);
  assert.match(booksHtml, /<section[^>]*id="books-form"/, 'the #books-form anchor section must exist');
});

test('cards are equal-height on desktop: flex column with the CTA anchored by margin-top auto', () => {
  const panel = ruleBody(booksCss, '.books-panel');
  assert.ok(panel);
  assert.match(panel, /display:\s*flex/);
  assert.match(panel, /flex-direction:\s*column/);
  const cta = ruleBody(booksCss, '.books-panel-cta');
  assert.ok(cta, '.books-panel-cta rule must exist');
  assert.match(cta, /margin:\s*auto\s+0\s+0/, 'CTA anchored to the bottom edge via margin-top auto (no fixed offsets)');
  const grid = ruleBody(booksCss, '.books-grid');
  assert.match(grid, /grid-template-columns:\s*repeat\(2/);
  assert.match(grid, /align-items:\s*stretch/, 'both tracks stretch so the panels share one height');
});

// ===========================================================================
// 2. Public stats are gone from the page (API contract stays server-side)
// ===========================================================================

test('the public interest/copy counters and their status region are fully removed', () => {
  for (const absent of [
    'books-counters',
    'books-counter-value',
    'data-book-interest',
    'data-book-copies',
    'data-book-counters',
    'books-counters-status'
  ]) {
    assert.equal(booksHtml.includes(absent), false, `${absent} must not remain in the markup`);
  }
  assert.equal(booksCss.includes('books-counters'), false, 'counter styles must not remain');
});

test('books.js no longer fetches /api/books/interest (the API itself is retained for ops)', () => {
  assert.equal(booksJs.includes('/api/books/interest'), false, 'no interest fetch remains in the client');
  assert.doesNotMatch(booksJs, /loadCounters|renderCounters|setCounters|announceCounters/, 'no counter code remains');
  assert.match(booksJs, /'\/api\/books\/eoi'/, 'the EOI endpoint is still used');
});

// ===========================================================================
// 3. EOI form: one-or-both checkboxes + per-book estimated copies
// ===========================================================================

test('the form uses two accessible checkboxes with the exact visitor titles and canonical codes', () => {
  const form = booksHtml.match(/<form[^>]*id="books-eoi-form"[\s\S]*?<\/form>/)[0];
  const boxes = form.match(/<input[^>]*type="checkbox"[^>]*name="books"[^>]*>/g);
  assert.ok(boxes);
  const values = boxes.map((b) => b.match(/value="([^"]+)"/)[1]).sort();
  assert.deepEqual(values, [...BOOK_VALUES].sort());
  assert.match(form, /value="biography">\s*<span>Frayed Not Broken<\/span>/);
  assert.match(form, /value="childrens">\s*<span>MJ and Her Wobbly Days<\/span>/);
  // Each checkbox label meets the control target floor via the shared style.
  assert.match(booksCss, /\.books-choice\s*\{[^}]*min-height:\s*48px/, 'the shared choice row keeps its target size');
});

test('the fieldset legend supports choosing one or both books', () => {
  const form = booksHtml.match(/<form[^>]*id="books-eoi-form"[\s\S]*?<\/form>/)[0];
  assert.match(form, /<legend>Which books are you interested in\? Choose one or both\.<\/legend>/);
  // The old radio group and the shared top-level quantity control are gone.
  assert.doesNotMatch(form, /type="radio"/);
  assert.doesNotMatch(form, /name="quantity"/, 'no top-level quantity input remains (per-book controls own it)');
  assert.doesNotMatch(form, /Number of copies/);
});

test('each checkbox owns a labelled per-book quantity control, hidden and disabled while unselected', () => {
  const form = booksHtml.match(/<form[^>]*id="books-eoi-form"[\s\S]*?<\/form>/)[0];
  for (const [code, title] of [['biography', 'Frayed Not Broken'], ['childrens', 'MJ and Her Wobbly Days']]) {
    const container = form.match(new RegExp(`<div class="books-qty" data-qty-for="${code}" hidden>[\\s\\S]*?</div>`));
    assert.ok(container, `${code} quantity container must exist, hidden by default`);
    assert.match(
      container[0],
      new RegExp(`<label for="books-qty-${code}">Estimated copies of ${title}</label>`),
      'the control is clearly labelled with its book'
    );
    const input = container[0].match(/<input[^>]*>/)[0];
    assert.match(input, new RegExp(`id="books-qty-${code}"`));
    assert.match(input, /type="number"/);
    assert.match(input, new RegExp(`name="quantity-${code}"`));
    assert.match(input, /min="1"/);
    assert.match(input, /max="10"/);
    assert.match(input, /step="1"/);
    assert.match(input, /value="1"/, 'default quantity is 1');
    assert.match(input, /\bdisabled\b/, 'disabled while its book is unselected');
  }
});

test('the quantity reveal is a real a11y collapse: display:none beats the grid when hidden', () => {
  const qty = ruleBody(booksCss, '.books-qty');
  assert.ok(qty);
  assert.match(qty, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, '0-minimum track keeps the 320px overflow fix');
  const hidden = ruleBody(booksCss, '.books-qty[hidden]');
  assert.ok(hidden, 'an explicit [hidden] guard must exist (display:grid overrides the UA default)');
  assert.match(hidden, /display:\s*none/);
});

test('honeypot, consent, Turnstile marker, and status region contracts are preserved', () => {
  assert.match(booksHtml, /name="website"/);
  assert.match(booksCss, /\.books-honeypot\s*\{[\s\S]*?position:\s*absolute/);
  const cb = booksHtml.match(/<input[^>]*name="consent"[^>]*>/)[0];
  assert.match(cb, /type="checkbox"/);
  assert.match(cb, /\brequired\b/);
  const box = booksHtml.match(/<div[^>]*id="books-turnstile"[^>]*>/)[0];
  assert.match(box, /data-sitekey="__BOOKS_TURNSTILE_SITE_KEY__"/);
  assert.match(box, /data-action="books-eoi"/);
  assert.equal(/data-sitekey="(0x|1x)[a-f0-9]+/i.test(booksHtml), false);
  assert.match(booksHtml, /id="books-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('no-JS text requires JS + Turnstile and links only to the gallery (no email fallback)', () => {
  const noscript = booksHtml.match(/<noscript>([\s\S]*?)<\/noscript>/)[1];
  assert.match(noscript, /JavaScript/i);
  assert.match(noscript, /href="\/gallery"/);
  assert.equal(noscript.includes('mailto:'), false);
});

// ===========================================================================
// 4. Copy: exact hero + book intro, clarifications intact, no invented claims
// ===========================================================================

test('the hero carries the exact approved eyebrow, heading, and description', () => {
  assert.equal(
    booksHtml.match(/<p class="eyebrow">([\s\S]*?)<\/p>/)[1].trim(),
    'Stories from MJ&rsquo;s journey'
  );
  assert.equal(
    booksHtml.match(/<h1>([\s\S]*?)<\/h1>/)[1].trim(),
    'Stories shaped by courage, faith, and wonderfully wobbly days.'
  );
  assert.equal(
    booksHtml.match(/<p class="hero-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim(),
    'MJ is preparing two deeply personal books: one sharing her honest journey through life with Multiple Sclerosis, and one helping children meet uncertain days with warmth, courage, and hope.'
  );
});

test('the hero primary action is "Follow the books" into the EOI form, and the removed elements stay removed', () => {
  const actions = booksHtml.match(/<div class="hero-actions">([\s\S]*?)<\/div>/)[1];
  assert.match(actions, /class="button button-primary" href="#books-form"/);
  assert.match(actions, />Follow the books</);
  assert.doesNotMatch(booksHtml, /hero-tags/);
  assert.doesNotMatch(booksHtml, /books-hero-card/);
  assert.doesNotMatch(booksHtml, /Back to the gallery/);
});

test('the book intro section and free-update-list clarification are intact exactly once', () => {
  const section = booksHtml.match(/<section class="section books-section" id="books-interest"[\s\S]*?<\/section>/)[0];
  assert.match(section, /<p class="section-label">Meet the books<\/p>/);
  assert.equal(
    section.match(/<h2 id="books-heading">([\s\S]*?)<\/h2>/)[1].trim(),
    'Two stories, written from the heart.'
  );
  const exact =
    'Joining the update list is free and does not reserve a copy or commit you to buying. Your details will only be used to share news about the book or books you choose.';
  const count = (booksHtml.match(new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'g')) || []).length;
  assert.equal(count, 1);
});

test('no invented book data: no prices, release dates, or pre-order claims', () => {
  assert.equal(/(A\$|AUD|\$\d)/i.test(booksHtml), false);
  assert.equal(/\bprice\b/i.test(booksHtml), false);
  assert.equal(/\b(pre-?order|preorder)\b/i.test(booksHtml), false);
  assert.equal(/\bISBN\b/i.test(booksHtml), false);
  assert.equal(/\b(release date|launches on|available \d{4})\b/i.test(booksHtml), false);
});

// ===========================================================================
// 5. Full-width hero surface with an internal readable measure
// ===========================================================================

test('the Books hero surface spans the full content width with an internal copy measure', () => {
  const hero = ruleBody(booksCss, '.books-hero-content');
  assert.ok(hero);
  assert.match(hero, /grid-template-columns:\s*1fr/, 'single full-width track (no companion column)');
  assert.doesNotMatch(hero, /max-width:\s*60ch/, 'the obsolete 60ch outer cap is removed');
  const measure = ruleBody(booksCss, '.books-hero-content .hero-text');
  assert.ok(measure, 'an internal measure rule must exist');
  assert.match(measure, /max-width:\s*6[2-9]ch/, 'the copy keeps a readable 62-70ch measure');
  // The <=960 collapse stays coherent (the shared hero grid drops to one column).
  const narrow = mediaBlock(booksCss, '(max-width: 960px)');
  assert.ok(narrow);
  assert.match(narrow, /\.books-hero-content\s*\{[^}]*grid-template-columns:\s*1fr/);
});

// ===========================================================================
// 6. Navigation + build integration
// ===========================================================================

test('Books is the current page in the shared topbar nav (aria-current="page")', () => {
  const nav = booksHtml.match(/<nav[^>]*class="[^"]*topbar[^"]*"[\s\S]*?<\/nav>/)[0];
  assert.match(nav, /href="\/books"[^>]*aria-current="page"/);
  assert.match(nav, /class="brand" href="\/"/);
  assert.equal(/href="#gallery"/.test(nav), false);
});

test('Books page provides #top as the Back to Top target and loads site-nav + books.js', () => {
  assert.match(booksHtml, /\bid="top"/);
  assert.match(booksHtml, /<button[^>]*id="back-to-top"/);
  assert.match(booksHtml, /<script[^>]*src="\.\/site-nav\.js/);
  assert.match(booksHtml, /<script[^>]*src="\.\/books\.js/);
});

test('books.js and back-to-top.js are syntax-checked by build/lint/type-check', () => {
  for (const file of ['public/books.js', 'public/back-to-top.js']) {
    for (const script of ['build', 'lint', 'type-check']) {
      assert.ok(rootPkg.includes(`node --check ${file}`), `${file} must be in the ${script} check list`);
    }
  }
});

// ===========================================================================
// 7. books.js pure helpers: one-or-both selection payloads
// ===========================================================================

const CONTACT = {
  name: 'Jane Doe',
  email: 'jane@example.com',
  consent: true,
  turnstileToken: 'tok'
};

const SEL_BIO = { book: 'biography', checked: true, quantity: '2' };
const SEL_KIDS = { book: 'childrens', checked: true, quantity: 3 };
const SEL_BIO_OFF = { book: 'biography', checked: false, quantity: '5' };

test('buildEoiPayload sends the exact interests payload for a single checked book', () => {
  const p = buildEoiPayload({ ...CONTACT, selections: [SEL_BIO, SEL_KIDS_OFF()] });
  assert.ok(p);
  assert.deepEqual(p.interests, [{ book: 'biography', quantity: 2 }]);
  assert.equal(p.name, 'Jane Doe');
  assert.equal(p.email, 'jane@example.com');
  assert.equal(p.consent, true);
  assert.deepEqual(Object.keys(p).sort(), ['consent', 'email', 'interests', 'name', 'turnstileToken']);
});

function SEL_KIDS_OFF() {
  return { book: 'childrens', checked: false, quantity: '4' };
}

test('buildEoiPayload supports both books with independent quantities', () => {
  const p = buildEoiPayload({ ...CONTACT, selections: [SEL_BIO, SEL_KIDS] });
  assert.ok(p);
  assert.deepEqual(p.interests, [
    { book: 'biography', quantity: 2 },
    { book: 'childrens', quantity: 3 }
  ]);
});

test('an unselected book (and its quantity) is omitted entirely from the payload', () => {
  const p = buildEoiPayload({ ...CONTACT, selections: [SEL_BIO_OFF, SEL_KIDS] });
  assert.ok(p);
  assert.deepEqual(p.interests, [{ book: 'childrens', quantity: 3 }]);
});

test('buildEoiPayload rejects no selection, bad quantities, and missing guards', () => {
  for (const overrides of [
    { selections: [SEL_BIO_OFF, SEL_KIDS_OFF()] },
    { selections: [] },
    { selections: [{ book: 'novel', checked: true, quantity: 1 }] },
    { selections: [{ ...SEL_BIO, quantity: 0 }] },
    { selections: [{ ...SEL_BIO, quantity: 11 }] },
    { selections: [{ ...SEL_BIO, quantity: 1.5 }] },
    { selections: [{ ...SEL_BIO, quantity: '' }] },
    { selections: [{ ...SEL_BIO, quantity: null }] },
    { name: '' },
    { email: '' },
    { consent: false },
    { consent: 'yes' },
    { turnstileToken: '' },
    {}
  ]) {
    assert.equal(
      buildEoiPayload({ ...CONTACT, ...overrides }),
      null,
      `should reject ${JSON.stringify(overrides)}`
    );
  }
});

test('buildEoiPayload trims contact fields and forwards a non-empty honeypot only', () => {
  const p = buildEoiPayload({
    ...CONTACT,
    name: '  Jane  ',
    email: '  jane@example.com  ',
    selections: [SEL_BIO],
    website: 'spam'
  });
  assert.ok(p);
  assert.equal(p.name, 'Jane');
  assert.equal(p.website, 'spam');
  const q = buildEoiPayload({ ...CONTACT, selections: [SEL_BIO], website: '' });
  assert.ok(q);
  assert.equal('website' in q, false);
});

test('the client payload never carries book/quantity/format top-level keys', () => {
  const p = buildEoiPayload({ ...CONTACT, selections: [SEL_BIO] });
  assert.ok(p);
  for (const absent of ['book', 'quantity', 'format']) {
    assert.equal(absent in p, false, `the new UI never sends top-level ${absent}`);
  }
});

test('hasNoSelection flags a submission with no checked book (for useful validation focus)', () => {
  assert.equal(hasNoSelection({ selections: [SEL_BIO_OFF] }), true);
  assert.equal(hasNoSelection({ selections: [] }), true);
  assert.equal(hasNoSelection({}), true);
  assert.equal(hasNoSelection({ selections: [SEL_BIO_OFF, SEL_KIDS] }), false);
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
  assert.match(messageForStatus(500), /something went wrong/i);
});

// ===========================================================================
// 8. books.js source contract (checkbox wiring, preselection, official Turnstile)
// ===========================================================================

test('books.js syncs each quantity control to its checkbox (hidden + disabled while unselected)', () => {
  assert.match(booksJs, /function syncQuantities/);
  assert.match(booksJs, /container\.hidden\s*=\s*!selected/);
  assert.match(booksJs, /input\.disabled\s*=\s*!selected/);
  assert.match(booksJs, /checkbox\.addEventListener\('change',\s*\(\)\s*=>\s*syncQuantities\(els\)\)/);
  // The sync re-runs after form.reset() because reset() does not restore the
  // disabled property or the hidden attribute.
  assert.match(booksJs, /resetForm\(els\.form\);\s*\n\s*syncQuantities\(els\);/);
});

test('books.js reads selections from the checkbox group with each book\'s own quantity input', () => {
  assert.match(booksJs, /input\[name="books"\]/);
  assert.match(booksJs, /\.books-qty/);
  assert.match(booksJs, /dataset\.qtyFor/);
  assert.match(booksJs, /function readSelections/);
});

test('books.js preselects the checkbox from a validated ?book= param and focuses it on first load', () => {
  assert.match(booksJs, /function applyBookPreselection[\s\S]*?parseBookQuery\(/);
  assert.match(booksJs, /checkbox\.checked\s*=\s*true/);
  assert.match(booksJs, /checkbox\.focus\(/);
  assert.match(booksJs, /preventScroll:\s*true/);
  assert.match(
    booksJs,
    /addEventListener\(\s*['"]popstate['"]\s*,\s*\(\)\s*=>\s*\{[\s\S]*?applyBookPreselection\(\s*form,\s*\{\s*focus:\s*false\s*\}\s*\);[\s\S]*?syncQuantities\(els\);/
  );
});

test('no-selection submit announces a specific message and focuses the checkbox group', () => {
  assert.match(booksJs, /Please choose at least one book to join the update list\./);
  assert.match(booksJs, /els\.checkboxes\[0\]\.focus\(/);
});

test('books.js loads the official Turnstile script, never hardcodes a site key, and prevents duplicate submits', () => {
  assert.match(booksJs, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.match(booksJs, /turnstile\.render\(/);
  assert.doesNotMatch(booksJs, /sitekey:\s*['"](0x|1x)[a-f0-9]+/i);
  assert.match(booksJs, /turnstileToken/);
  assert.match(booksJs, /consent:\s*true/);
  assert.match(booksJs, /if\s*\(\s*submitting\s*\)\s*return/);
  assert.match(booksJs, /resetTurnstile/);
  assert.doesNotMatch(booksJs, /mailto:/, 'no mail fallback');
  assert.doesNotMatch(booksJs, /localStorage\s*\.\s*(get|set|remove)Item/, 'no localStorage usage');
});

test('books.js Back to Top uses the shared module (no duplicated logic)', () => {
  assert.match(booksJs, /import\s*\{\s*initBackToTop\s*\}\s*from\s*['"]\.\/back-to-top\.js['"]/);
  assert.match(booksJs, /initBackToTop\(\)/);
  assert.doesNotMatch(booksJs, /BACK_TO_TOP_THRESHOLD/);
  assert.doesNotMatch(booksJs, /function\s+initBackToTop\s*\(/);
  assert.match(backToTopJs, /getElementById\('back-to-top'\)/);
  assert.match(backToTopJs, /getElementById\('top'\)/);
  assert.match(backToTopJs, /addEventListener\('scroll',\s*sync,\s*\{\s*passive:\s*true\s*\}\)/);
});

// ===========================================================================
// 9. The exact corrected title appears on every public surface of this page
// ===========================================================================

test('MJ and Her Wobbly Days appears in the card, CTA accessible name, and checkbox label', () => {
  const count = (booksHtml.match(/MJ and Her Wobbly Days/g) || []).length;
  assert.ok(count >= 3, `the exact title must label the card, CTA, and checkbox (found ${count})`);
});

test('internal code childrens stays stable while the visitor title is exact', () => {
  assert.match(booksHtml, /value="childrens"/);
  assert.match(booksHtml, /\?book=childrens#books-form/);
  assert.equal(booksHtml.includes('MJ and the Wobbly Days'), false);
});
