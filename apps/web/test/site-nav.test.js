import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDisclosureController } from '../public/site-nav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const srcDir = join(__dirname, '..', 'src');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const galleryHtml = readFileSync(join(publicDir, 'gallery.html'), 'utf8');
const booksHtml = readFileSync(join(publicDir, 'books.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const workerJs = readFileSync(join(srcDir, 'worker.js'), 'utf8');
const rootPkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');

// The shared topbar nav: exactly Home | Gallery | Books | Enquire in this order,
// with root-absolute hrefs: /, /gallery, /books, /#contact.
const EXPECTED_HREFS = ['/', '/gallery', '/books', '/#contact'];

function topbarLinksHrefs(html) {
  const m = html.match(/<div class="topbar-links site-nav-links">([\s\S]*?)<\/div>/i);
  assert.ok(m, 'a .topbar-links.site-nav-links container must exist');
  return (m[1].match(/href="([^"]+)"/g) || []).map((s) => s.slice(6, -1));
}

function disclosureLinksHrefs(html) {
  const m = html.match(/<details\b[^>]*\bclass="[^"]*site-nav-disclosure[^"]*"[\s\S]*?<\/details>/i);
  if (!m) return null;
  return (m[0].match(/href="([^"]+)"/g) || []).map((s) => s.slice(6, -1));
}

// --- Shared nav: order, hrefs, current page, on every page ----------------

test('every public page exposes the shared topbar with the four links in order', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    assert.deepEqual(topbarLinksHrefs(html), EXPECTED_HREFS, `${name} topbar link order/hrefs`);
  }
});

test('every public page exposes a matching mobile disclosure with the same four links', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    assert.deepEqual(disclosureLinksHrefs(html), EXPECTED_HREFS, `${name} disclosure link order/hrefs`);
  }
});

test('aria-current="page" marks exactly the right link on each page (topbar + disclosure + footer)', () => {
  // Home: "/" is current. Gallery: "/gallery". Books: "/books".
  const cases = [
    ['home', indexHtml, '/'],
    ['gallery', galleryHtml, '/gallery'],
    ['books', booksHtml, '/books']
  ];
  for (const [name, html, currentHref] of cases) {
    const currents = (html.match(/href="[^"]*"[^>]*aria-current="page"/g) || [])
      .map((s) => s.match(/href="([^"]*)"/)[1]);
    assert.ok(currents.length >= 3, `${name} marks aria-current on topbar, disclosure, and footer`);
    // Every aria-current link points at the page's own canonical href.
    for (const href of currents) {
      assert.equal(href, currentHref, `${name} aria-current link must point at ${currentHref}`);
    }
  }
});

test('the Enquire link is root-absolute /#contact on every page (no bare #contact)', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    assert.match(html, /href="\/#contact"/, `${name} uses root-absolute /#contact for Enquire`);
    // A bare #contact would strand visitors on Gallery/Books (no in-page target).
    const nav = html.match(/<nav[^>]*class="[^"]*topbar[^"]*"[\s\S]*?<\/nav>/)[0];
    assert.equal(/href="#contact"/.test(nav), false, `${name} topbar has no bare #contact`);
  }
});

// --- Primary nav landmark + label -----------------------------------------

test('primary topbar is a uniquely-labelled navigation landmark on every page', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    const nav = html.match(/<nav\b[^>]*\bclass="[^"]*topbar[^"]*"[^>]*>/i);
    assert.ok(nav, `${name} nav.topbar exists`);
    assert.match(nav[0], /aria-label="Primary navigation"/, `${name} topbar label`);
  }
});

// --- Native mobile disclosure markup --------------------------------------

test('mobile menu is a native <details>/<summary> with NO duplicated aria wiring', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    const details = html.match(/<details\b[^>]*\bclass="[^"]*site-nav-disclosure[^"]*"[^>]*>/i);
    assert.ok(details, `${name} has a <details.site-nav-disclosure>`);
    // Native: the browser derives expanded state from `open`. Manually adding
    // aria-expanded/aria-controls here would duplicate the disclosure contract.
    assert.doesNotMatch(details[0], /aria-expanded=/, `${name} must not duplicate aria-expanded`);
    assert.doesNotMatch(details[0], /aria-controls=/, `${name} must not duplicate aria-controls`);

    const summary = html.match(/<summary\b[^>]*\bclass="[^"]*site-nav-summary[^"]*"[^>]*>/i);
    assert.ok(summary, `${name} has a <summary.site-nav-summary> as the native control`);
    assert.doesNotMatch(summary[0], /role=/, `${name} summary must not override the native button role`);
    assert.doesNotMatch(summary[0], /tabindex=/, `${name} summary must not override the native tab order`);
  }
});

test('disclosure menu links meet the 44px target minimum in CSS', () => {
  const m = stylesCss.match(/\.site-nav-menu a\s*\{([^}]*)\}/);
  assert.ok(m, 'a .site-nav-menu a rule must exist');
  const minH = m[1].match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(minH, '.site-nav-menu a must declare a min-height');
  assert.ok(Number(minH[1]) >= 44, `disclosure menu link min-height >= 44px (got ${minH[1]}px)`);
});

test('disclosure summary meets the 44px target minimum in CSS', () => {
  const m = stylesCss.match(/\.site-nav-summary\s*\{([^}]*)\}/);
  assert.ok(m, 'a .site-nav-summary rule must exist');
  const minH = m[1].match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(minH, '.site-nav-summary must declare a min-height');
  assert.ok(Number(minH[1]) >= 44, `summary min-height >= 44px (got ${minH[1]}px)`);
});

test('a closed disclosure hides its menu from rendering and focus order', () => {
  assert.match(
    stylesCss,
    /\.site-nav-disclosure:not\(\[open\]\)\s+\.site-nav-menu\s*\{[^}]*display:\s*none/,
    'a closed disclosure must explicitly hide its menu'
  );
});

// --- No obsolete chapter rail / scroll-spy --------------------------------

test('no page emits the obsolete chapter rail/disclosure markup', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    assert.doesNotMatch(html, /chapter-nav|chapter-rail|chapter-disclosure|chapter-menu|chapter-link/i,
      `${name} must not carry obsolete chapter-nav markup`);
  }
});

test('no page loads the removed chapter-nav.js script', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    assert.doesNotMatch(html, /chapter-nav\.js/, `${name} must not load chapter-nav.js`);
    assert.match(html, /site-nav\.js/, `${name} loads the shared site-nav.js`);
  }
});

test('chapter-nav.js is removed and site-nav.js is syntax-checked by build/lint/type-check', () => {
  assert.doesNotMatch(rootPkg, /chapter-nav\.js/, 'chapter-nav.js must be gone from the check lists');
  for (const file of ['public/site-nav.js', 'public/home.js']) {
    assert.ok(rootPkg.includes(`node --check ${file}`), `${file} must be in the check lists`);
  }
});

// --- Worker owns the canonical gallery route (deeper coverage lives in
//     worker-protocol/gallery-route tests; this guards the route existing) --

test('the Worker owns the /gallery canonical route and its aliases', () => {
  assert.match(workerJs, /isGalleryPage/);
  assert.match(workerJs, /serveGalleryPage/);
});

// --- Disclosure controller (pure, no DOM) ---------------------------------

test('createDisclosureController reads open state and toggles it', () => {
  const details = { open: false };
  const summary = { focus() {} };
  const c = createDisclosureController({ details, summary, menu: {} });
  assert.equal(c.isOpen(), false);
  c.open();
  assert.equal(details.open, true);
  assert.equal(c.isOpen(), true);
  c.close(false);
  assert.equal(details.open, false);
});

test('close(true) returns focus to the summary', () => {
  let focused = false;
  const details = { open: true };
  const summary = { focus() { focused = true; } };
  const c = createDisclosureController({ details, summary, menu: {} });
  c.close(true);
  assert.equal(details.open, false);
  assert.equal(focused, true);
});

test('Escape closes an open disclosure and returns focus; other keys are ignored', () => {
  const details = { open: true };
  let focused = false;
  const summary = { focus() { focused = true; } };
  const c = createDisclosureController({ details, summary, menu: {} });
  assert.equal(c.onKeydown('Escape'), true);
  assert.equal(details.open, false);
  assert.equal(focused, true);
  // A closed disclosure does not act on Escape.
  assert.equal(c.onKeydown('Escape'), false);
  // Other keys never act.
  details.open = true;
  assert.equal(c.onKeydown('Enter'), false);
  assert.equal(details.open, true);
});

test('contains() detects targets inside the disclosure (summary or menu)', () => {
  // In the real DOM the <summary> and the menu both descend from <details>, so
  // details.contains() covers both. The fake mirrors that nesting.
  const inMenu = {};
  const inSummary = {};
  const outside = {};
  const summary = { contains(t) { return t === inSummary; } };
  const menu = { contains(t) { return t === inMenu; } };
  const details = {
    open: true,
    contains(t) { return t === inMenu || t === inSummary; }
  };
  const c = createDisclosureController({ details, summary, menu });
  assert.equal(c.contains(inMenu), true);
  assert.equal(c.contains(inSummary), true);
  assert.equal(c.contains(outside), false);
  assert.equal(c.contains(null), false);
});

test('onMenuClick closes when a link is activated, and leaves non-link clicks alone', () => {
  const details = { open: true };
  const summary = { focus() {} };
  const link = { closest() { return 'a'; } };
  const text = { closest() { return null; } };
  const menu = {};
  const c = createDisclosureController({ details, summary, menu });
  assert.equal(c.onMenuClick(link), true);
  assert.equal(details.open, false, 'activating a link closes the menu');
  details.open = true;
  assert.equal(c.onMenuClick(text), false);
  assert.equal(details.open, true, 'a non-link click leaves the menu open');
});
