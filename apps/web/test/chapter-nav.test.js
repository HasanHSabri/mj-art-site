import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickActiveSection, reduceScrollSpy, createDisclosureController, isBooksPage, markBooksPageCurrent } from '../public/chapter-nav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const srcDir = join(__dirname, '..', 'src');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const chapterJs = readFileSync(join(publicDir, 'chapter-nav.js'), 'utf8');
const workerJs = readFileSync(join(srcDir, 'worker.js'), 'utf8');
const rootPkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

// Slice a top-level @media block (from its opening to the next @media).
function mediaBlock(css, feature) {
  const start = css.indexOf(`@media ${feature}`);
  if (start === -1) return null;
  const next = css.indexOf('@media', start + 1);
  return css.slice(start, next === -1 ? undefined : next);
}

function hrefsInList(html, id) {
  const m = html.match(new RegExp(`<ul[^>]*id="${id}"[^>]*>([\\s\\S]*?)</ul>`));
  if (!m) return null;
  return (m[1].match(/href="([^"]+)"/g) || []).map((s) => s.slice(6, -1));
}

function intToken(css, name) {
  const root = ruleBody(css, ':root');
  const m = root.match(new RegExp(`${name}:\\s*(\\d+)px`));
  return m ? Number(m[1]) : null;
}

// Resolve a summary min-width/height declaration (literal px OR the token) to a number.
function summaryMinPx(css) {
  const s = ruleBody(css, '.chapter-summary');
  const lit = (s.match(/min-(?:width|height):\s*(\d+)px/) || [])[1];
  if (lit) return Number(lit);
  return intToken(css, '--chapter-summary-min');
}

// --- Landmark, labels, IDs, order --------------------------------------

test('chapter nav is a second, uniquely-labelled navigation landmark', () => {
  const nav = indexHtml.match(/<nav\b[^>]*\bclass="[^"]*chapter-nav[^"]*"[^>]*>/i);
  assert.ok(nav, 'a nav.chapter-nav element must exist');
  assert.match(
    nav[0],
    /aria-label="Chapter navigation"/,
    'chapter nav must carry a unique aria-label distinct from the primary topbar'
  );
});

test('primary topbar label is unchanged', () => {
  const nav = indexHtml.match(/<nav\b[^>]*\bclass="[^"]*topbar[^"]*"[^>]*>/i);
  assert.ok(nav, 'primary nav.topbar still exists');
  assert.match(nav[0], /aria-label="Primary navigation"/, 'topbar keeps its original label');
});

test('testimonials section gains an id anchor', () => {
  assert.ok(
    /<section\b[^>]*\bid="testimonials"/.test(indexHtml),
    'a section with id="testimonials" must exist as a scroll target'
  );
});

test('chapter destinations appear in the required order in both the rail and the menu', () => {
  const expected = ['#gallery', '#story', '#testimonials', '/books', '#contact'];
  for (const id of ['chapter-rail', 'chapter-menu']) {
    const hrefs = hrefsInList(indexHtml, id);
    assert.ok(hrefs, `${id} list must exist`);
    assert.deepEqual(hrefs, expected, `${id} links must be in order: ${expected.join(', ')}`);
  }
});

test('in-page chapter links carry a matching data-target; the books link does not', () => {
  const rail = indexHtml.match(/<ul[^>]*id="chapter-rail"[^>]*>([\s\S]*?)<\/ul>/)[1];
  const links = rail.match(/<a\b[^>]*class="[^"]*chapter-link[^"]*"[^>]*>/g);
  assert.ok(links, 'rail chapter links must exist');
  for (const tag of links) {
    if (/href="\/books"/.test(tag)) {
      assert.doesNotMatch(
        tag,
        /data-target=/,
        'the /books page link must not carry a data-target (never aria-current on home)'
      );
      assert.match(tag, /class="[^"]*chapter-link-page/, 'books link is marked as a page link');
    } else {
      const href = tag.match(/href="#([^"]+)"/)[1];
      assert.match(
        tag,
        new RegExp(`data-target="${href}"`),
        `in-page link #${href} must carry a matching data-target`
      );
    }
  }
});

// --- Native disclosure markup ------------------------------------------

test('mobile menu is a native <details>/<summary> with NO duplicated aria wiring', () => {
  const details = indexHtml.match(/<details\b[^>]*\bid="chapter-details"[^>]*>/i);
  assert.ok(details, 'a <details id="chapter-details"> must exist');
  assert.match(details[0], /class="[^"]*chapter-disclosure/, 'carries the .chapter-disclosure class');

  const summary = indexHtml.match(/<summary\b[^>]*\bid="chapter-toggle"[^>]*>/i);
  assert.ok(summary, '<summary id="chapter-toggle"> is the native disclosure control');
  assert.match(summary[0], /class="[^"]*\bchapter-summary\b/, 'summary carries .chapter-summary');
  // Native: the browser derives the expanded state from `open`. Manually adding
  // aria-expanded/aria-controls is the obsolete duplicate path and must be gone.
  assert.doesNotMatch(summary[0], /aria-expanded=/, 'summary must not duplicate native aria-expanded');
  assert.doesNotMatch(summary[0], /aria-controls=/, 'summary must not duplicate native aria-controls');

  // summary must be the first child of the details (it labels the disclosure).
  const block = indexHtml.match(/<details\b[^>]*\bid="chapter-details"[^>]*>([\s\S]*?)<\/details>/i);
  assert.ok(block);
  assert.match(block[1], /^[\s\S]*<summary/, 'summary precedes the menu inside details');
  assert.match(block[1], /<ul\b[^>]*\bid="chapter-menu"/, 'the menu lives inside the details');
});

test('the summary visible label is exactly "Explore"', () => {
  const m = indexHtml.match(/<summary\b[^>]*\bid="chapter-toggle"[^>]*>([\s\S]*?)<\/summary>/i);
  assert.ok(m);
  assert.equal(m[1].trim(), 'Explore');
});

test('a closed disclosure removes the menu from the focus order (enforceable)', () => {
  const body = ruleBody(stylesCss, '.chapter-disclosure:not([open]) .chapter-menu');
  assert.ok(body, '.chapter-disclosure:not([open]) .chapter-menu rule must exist');
  assert.match(body, /display:\s*none/, 'closed details must display:none the menu');
});

// --- Desktop rail geometry / breakpoint --------------------------------

test('wide breakpoint is min-width: 1440px (evidence-based gutter fit)', () => {
  assert.ok(/@media\s*\(\s*min-width:\s*1440px\s*\)/.test(stylesCss), 'uses min-width: 1440px');
  assert.doesNotMatch(
    stylesCss,
    /@media\s*\(\s*min-width:\s*1280px\s*\)/,
    'must not use 1280px (the gutter is too narrow there; the rail would cover content)'
  );
});

test('rail width token is <=120px and fits the >=1440px gutter with a declared gap', () => {
  const width = intToken(stylesCss, '--chapter-rail-width');
  const gap = intToken(stylesCss, '--chapter-rail-gap');
  assert.ok(width, '--chapter-rail-width must exist');
  assert.ok(gap, '--chapter-rail-gap must exist');
  assert.ok(width <= 120, `rail width must be <= 120px (got ${width}px)`);
  // The centred page-shell is max 1180px (margin: 0 auto). At 1440px the
  // unreserved gutter per side is (1440-1180)/2 = 130px. Rail + gap must fit.
  const gutterAtBreakpoint = (1440 - 1180) / 2;
  assert.ok(
    width + gap <= gutterAtBreakpoint,
    `rail (${width}) + gap (${gap}) = ${width + gap} must fit the ${gutterAtBreakpoint}px gutter at 1440px`
  );
});

test('desktop rail is fixed to the right edge, opaque and warm', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1440px)');
  assert.ok(wide, 'wide media block must exist');
  const body = ruleBody(wide, '.chapter-rail');
  assert.ok(body, '.chapter-rail rule must exist in the wide block');
  assert.match(body, /position:\s*fixed/, 'rail must be position: fixed');
  assert.match(body, /right:\s*0/, 'rail must anchor to the right edge');
  assert.match(body, /width:\s*var\(--chapter-rail-width\)/, 'rail width uses the token');
  assert.match(body, /background:\s*var\(--surface-strong\)/, 'rail surface must be opaque warm');
  assert.match(body, /border-left:\s*1px solid var\(--border\)/, 'rail has a subtle 1px divider');
});

test('rail is vertically centred without transform (no clash with hover nudges)', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1440px)');
  const body = ruleBody(wide, '.chapter-rail');
  assert.ok(body);
  assert.match(body, /align-content:\s*center/, 'centred via grid align-content');
  assert.doesNotMatch(body, /transform\s*:/, 'rail positioning must not rely on transform');
});

test('desktop rail targets are >= 44px', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1440px)');
  const a = ruleBody(wide, '.chapter-rail a');
  assert.ok(a, '.chapter-rail a rule must exist');
  const m = a.match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(m, 'rail link must declare a min-height');
  assert.ok(Number(m[1]) >= 44, `rail link min-height must be >= 44px (got ${m[1]}px)`);
});

test('body is NEVER padded right for the rail (no content/BTT misalignment)', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1440px)');
  assert.ok(wide);
  assert.doesNotMatch(wide, /body\s*\{[^}]*padding-right/, 'wide block must not pad the body');
  assert.doesNotMatch(
    stylesCss,
    /padding-right:\s*calc\(\s*var\(--chapter-rail-width\)/,
    'no rail-derived body padding anywhere in the stylesheet'
  );
});

test('the mobile disclosure is suppressed on wide screens', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1440px)');
  assert.ok(wide);
  const sup = ruleBody(wide, '.chapter-disclosure');
  assert.ok(sup, '.chapter-disclosure rule must exist in the wide block');
  assert.match(sup, /display:\s*none/, 'the disclosure must be display: none on desktop');
});

test('the rail is hidden by default (mobile-first) and only revealed in the wide block', () => {
  const base = ruleBody(stylesCss, '.chapter-rail');
  assert.ok(base, 'base .chapter-rail rule must exist');
  assert.match(base, /display:\s*none/, 'rail must be display: none outside the wide breakpoint');
});

// --- Mobile disclosure CSS / safe area ---------------------------------

test('mobile disclosure is fixed, safe-area aware, and the summary is >= 44px', () => {
  const body = ruleBody(stylesCss, '.chapter-disclosure');
  assert.ok(body, '.chapter-disclosure rule must exist');
  assert.match(body, /position:\s*fixed/, 'must be fixed');
  assert.match(
    body,
    /right:\s*calc\(\s*env\(\s*safe-area-inset-right/,
    'right must include env(safe-area-inset-right)'
  );
  assert.match(
    body,
    /bottom:\s*calc\(\s*env\(\s*safe-area-inset-bottom/,
    'bottom must include env(safe-area-inset-bottom)'
  );
  const min = summaryMinPx(stylesCss);
  assert.ok(min && min >= 44, `summary min size must be >= 44px (got ${min}px)`);
});

test('menu opens upward (above the summary) and caps width to the viewport', () => {
  const body = ruleBody(stylesCss, '.chapter-menu');
  assert.ok(body, '.chapter-menu rule must exist');
  assert.match(body, /position:\s*absolute/, 'absolute, relative to the fixed disclosure');
  assert.match(
    body,
    /bottom:\s*calc\(100%\s*\+\s*\d+px\)/,
    'bottom anchored above the summary (opens upward)'
  );
  assert.match(
    body,
    /max-width:\s*calc\(100(?:vw|%)\s*-\s*32px\)/,
    'menu must cap width so it never causes horizontal overflow at 320/393px'
  );
});

test('the native disclosure triangle is removed (pill is self-evident)', () => {
  assert.match(stylesCss, /\.chapter-summary::-webkit-details-marker\s*\{[^}]*display:\s*none/, 'legacy Safari marker hidden');
  assert.match(stylesCss, /\.chapter-summary::marker\s*\{[^}]*content:\s*''/, 'spec marker removed');
});

// --- Narrow-width collision contract (replaces the misleading static claim) ---

test('enforceable narrow contract: centred Back to Top lifts above the disclosure at <=380px with a measured gap', () => {
  const narrow = mediaBlock(stylesCss, '(max-width: 380px)');
  assert.ok(narrow, 'a max-width: 380px band must exist to fix the 320-360px collision');
  const btt = ruleBody(narrow, '.back-to-top');
  assert.ok(btt);
  // The lift must stack: disclosure inset + summary height + a measured gap.
  // Uses [\s\S]*? so the multi-line calc() with nested env(...) parens matches.
  assert.match(
    btt,
    /bottom:\s*calc\([\s\S]*?var\(--chapter-disclosure-inset\)[\s\S]*?var\(--chapter-summary-min\)[\s\S]*?var\(--btt-narrow-lift-gap\)/,
    'BTT bottom must be inset + summary-min + measured gap'
  );
  const gap = intToken(stylesCss, '--btt-narrow-lift-gap');
  assert.ok(gap && gap >= 12, `measured vertical gap must be >= 12px (got ${gap}px)`);
  // Centering + safe area are preserved in the narrow band.
  assert.match(btt, /env\(\s*safe-area-inset-bottom/);
  const base = ruleBody(stylesCss, '.back-to-top');
  assert.match(base, /left:\s*0/);
  assert.match(base, /right:\s*0/);
  assert.match(base, /margin-inline:\s*auto/);
});

test('Back to Top remains centred and unchanged in its base rule', () => {
  const body = ruleBody(stylesCss, '.back-to-top');
  assert.ok(body);
  assert.match(body, /left:\s*0/);
  assert.match(body, /right:\s*0/);
  assert.match(body, /margin-inline:\s*auto/);
  assert.match(body, /bottom:\s*calc\(\s*env\(\s*safe-area-inset-bottom/);
});

// --- Active state: not colour alone + scroll margin --------------------

test('current location is conveyed with shape/weight, not colour alone', () => {
  const body = ruleBody(stylesCss, '.chapter-link[aria-current="location"]');
  assert.ok(body, 'aria-current="location" style must exist');
  assert.match(body, /font-weight:\s*600/, 'heavier type');
  assert.match(
    body,
    /box-shadow:\s*inset/,
    'a non-colour marker (inset accent bar) so it is not colour-only (WCAG 1.4.1)'
  );
});

test('current Books page is conveyed with visible shape/weight, not colour alone', () => {
  const body = ruleBody(stylesCss, '.chapter-link[aria-current="page"]');
  assert.ok(body, 'aria-current="page" style must exist');
  assert.match(body, /font-weight:\s*600/, 'heavier type');
  assert.match(body, /box-shadow:\s*inset/, 'a non-colour inset marker');
});

test('anchor targets carry scroll-margin so fixed UI cannot obscure focused content', () => {
  assert.match(
    stylesCss,
    /#top,[\s\S]*?\.section\[id\]\s*\{[\s\S]*?scroll-margin-top:/,
    'a scroll-margin-top rule covering #top and section[id] targets must exist'
  );
});

test('chapter controls are covered by the unified focus-visible ring', () => {
  assert.ok(stylesCss.includes('.chapter-link:focus-visible'));
  assert.ok(stylesCss.includes('.chapter-summary:focus-visible'));
});

// --- JS: pure active-section selection (behavioral) --------------------

test('pickActiveSection: nothing visible returns null (e.g. over the hero)', () => {
  assert.equal(pickActiveSection([], 200), null);
  assert.equal(pickActiveSection(null, 200), null);
});

test('pickActiveSection: a single visible section is chosen', () => {
  assert.equal(pickActiveSection([{ id: 'story', top: 150 }], 200), 'story');
});

test('pickActiveSection: when multiple intersect, the LATER section wins (no document-first lag)', () => {
  // Scrolling down: story still in the band while testimonials has crossed the
  // marker. The later section (testimonials) must win immediately.
  const entries = [
    { id: 'story', top: 80 },
    { id: 'testimonials', top: 190 }
  ];
  assert.equal(pickActiveSection(entries, 200), 'testimonials');
});

test('pickActiveSection: when no top has crossed the marker, the nearest below is chosen', () => {
  const entries = [
    { id: 'story', top: 260 },
    { id: 'testimonials', top: 300 }
  ];
  assert.equal(pickActiveSection(entries, 200), 'story');
});

test('pickActiveSection: three visible, the latest crossed-above wins', () => {
  const entries = [
    { id: 'gallery', top: -400 },
    { id: 'story', top: 60 },
    { id: 'testimonials', top: 195 }
  ];
  assert.equal(pickActiveSection(entries, 200), 'testimonials');
});

// --- JS: incremental scroll-spy state (partial-entry robustness) ---------
// A minimal fake-observer harness: it feeds normalized { id, isIntersecting,
// top } batches through reduceScrollSpy, threading the persistent state map
// between callbacks exactly as the real IntersectionObserver callback does.
// Each batch contains ONLY the entries whose state changed (the real API
// contract), so these tests exercise the multi-callback guarantee that a
// partial batch must never drop a still-active section.
function fakeObserver(markerY = 200) {
  let state = new Map();
  return {
    // Emit one change batch (only changed entries, like the real API).
    emit(batch) {
      const result = reduceScrollSpy(state, batch, markerY);
      state = result.state;
      return result.current;
    },
    snapshot() {
      return new Map(state);
    }
  };
}

test('reduceScrollSpy: empty batch with no prior state clears (hero-none)', () => {
  assert.equal(reduceScrollSpy(null, [], 200).current, null);
  assert.equal(reduceScrollSpy(new Map(), [], 200).current, null);
});

test('reduceScrollSpy: a single entering section becomes current', () => {
  const r = reduceScrollSpy(null, [{ id: 'story', isIntersecting: true, top: 150 }], 200);
  assert.equal(r.current, 'story');
  assert.equal(r.state.size, 1);
});

test('partial-entry: an unrelated exit batch keeps the still-active section current', () => {
  // Story is active. A LATER callback fires for an UNRELATED section (gallery)
  // leaving the band; Story is NOT in this batch because its state did not
  // change. The complete state must still know Story is the active section.
  const spy = fakeObserver(200);
  assert.equal(spy.emit([{ id: 'story', isIntersecting: true, top: 80 }]), 'story');
  // gallery exits (partial/unrelated batch). Story must remain current.
  assert.equal(
    spy.emit([{ id: 'gallery', isIntersecting: false, top: -500 }]),
    'story',
    'an unrelated exit batch must not clear the still-active Story'
  );
});

test('partial-entry: a section entering while another stays keeps the later active', () => {
  // Story active; Testimonials partially enters but has not crossed the marker
  // (its top is below the marker line). The complete state now has both, so
  // the latest crossed-above (Story) stays current until Testimonials crosses.
  const spy = fakeObserver(200);
  spy.emit([{ id: 'story', isIntersecting: true, top: 60 }]);
  assert.equal(
    spy.emit([{ id: 'testimonials', isIntersecting: true, top: 260 }]),
    'story',
    'Story stays current while Testimonials has not yet crossed the marker'
  );
});

test('transition Story->Testimonials is deterministic across partial batches', () => {
  // Full real-world transition driven by several small, partial callback
  // batches (each batch reports only the section whose state changed):
  const spy = fakeObserver(200);
  assert.equal(spy.emit([{ id: 'gallery', isIntersecting: true, top: -400 }]), 'gallery');
  assert.equal(spy.emit([{ id: 'story', isIntersecting: true, top: 60 }]), 'story');
  // Testimonials crosses the marker in its own batch -> it must win immediately.
  assert.equal(
    spy.emit([{ id: 'testimonials', isIntersecting: true, top: 190 }]),
    'testimonials',
    'the later section wins the moment it crosses the marker (no document-first lag)'
  );
  // Story later fully leaves; Testimonials is NOT in this batch, so a naive
  // single-batch reducer would have cleared it. The complete state keeps it.
  assert.equal(
    spy.emit([{ id: 'story', isIntersecting: false, top: -300 }]),
    'testimonials',
    'Testimonials stays current after Story leaves (no flicker during transition)'
  );
});

test('all observed sections leaving clears the current marker', () => {
  const spy = fakeObserver(200);
  spy.emit([{ id: 'story', isIntersecting: true, top: 80 }]);
  spy.emit([{ id: 'testimonials', isIntersecting: true, top: 190 }]);
  // Every observed section leaves (could arrive as one combined batch or two):
  assert.equal(
    spy.emit([
      { id: 'story', isIntersecting: false, top: -300 },
      { id: 'testimonials', isIntersecting: false, top: -400 }
    ]),
    null,
    'once every observed section has left, current must be null (hero-none)'
  );
  assert.equal(spy.snapshot().size, 0, 'the complete state is empty after all leave');
});

test('reduceScrollSpy: a re-entry batch refreshes a stored position without losing others', () => {
  // A later change batch for an already-active section reports a new top; it
  // must update the stored position while keeping the other section known.
  let { state, current } = reduceScrollSpy(null, [{ id: 'story', isIntersecting: true, top: 60 }], 200);
  ({ state, current } = reduceScrollSpy(state, [{ id: 'testimonials', isIntersecting: true, top: 190 }], 200));
  assert.equal(current, 'testimonials');
  ({ state, current } = reduceScrollSpy(state, [{ id: 'story', isIntersecting: true, top: 100 }], 200));
  assert.equal(state.size, 2, 'both sections remain in the complete state');
  assert.equal(current, 'testimonials', 'current is unaffected by a non-crossing re-entry');
});

test('reduceScrollSpy: books is never a key (books exclusion is upheld upstream)', () => {
  // The observer only observes IN_PAGE_SECTIONS (which excludes /books), so a
  // books-like id can never appear in a batch. This guard documents that the
  // reducer itself stays generic but the caller's exclusion is what matters.
  const spy = fakeObserver(200);
  spy.emit([{ id: 'story', isIntersecting: true, top: 80 }]);
  assert.equal(spy.snapshot().has('books'), false);
  assert.equal(spy.snapshot().has('/books'), false);
});

// --- JS: pure disclosure controller (fake-DOM harness, no heavy dep) ---

function harness({ open = false } = {}) {
  const calls = { focus: 0 };
  const link = { closest: (sel) => (sel === 'a' ? link : null) };
  const nonLink = { closest: () => null };
  const summary = {
    focus() { calls.focus += 1; },
    contains: (t) => t === summary
  };
  const details = {
    open,
    contains: (t) => t === link || t === nonLink || t === summary
  };
  const menu = { contains: (t) => t === link || t === nonLink };
  return { calls, link, nonLink, summary, details, menu };
}

test('controller: Escape closes the open menu and returns focus to the summary', () => {
  const h = harness({ open: true });
  const c = createDisclosureController({ details: h.details, summary: h.summary, menu: h.menu });
  assert.equal(c.isOpen(), true);
  assert.equal(c.onKeydown('Enter'), false, 'non-Escape keys are ignored');
  assert.equal(c.onKeydown('Escape'), true);
  assert.equal(h.details.open, false, 'native open cleared');
  assert.equal(h.calls.focus, 1, 'focus returned to the summary');
});

test('controller: Escape does nothing when already closed', () => {
  const h = harness({ open: false });
  const c = createDisclosureController({ details: h.details, summary: h.summary, menu: h.menu });
  assert.equal(c.onKeydown('Escape'), false);
  assert.equal(h.calls.focus, 0);
});

test('controller: activating a link closes the menu WITHOUT moving focus', () => {
  const h = harness({ open: true });
  const c = createDisclosureController({ details: h.details, summary: h.summary, menu: h.menu });
  assert.equal(c.onMenuClick(h.link), true, 'link click detected via closest("a")');
  assert.equal(h.details.open, false);
  assert.equal(h.calls.focus, 0, 'no focus steal on link activation (the anchor navigates)');
});

test('controller: a non-link menu click does not close', () => {
  const h = harness({ open: true });
  const c = createDisclosureController({ details: h.details, summary: h.summary, menu: h.menu });
  assert.equal(c.onMenuClick(h.nonLink), false);
  assert.equal(h.details.open, true);
});

test('controller: outside click closes, inside click does not', () => {
  const h = harness({ open: true });
  const c = createDisclosureController({ details: h.details, summary: h.summary, menu: h.menu });
  const outside = {};
  assert.equal(c.contains(outside), false, 'outside point is not contained');
  assert.equal(c.contains(h.link), true, 'an in-menu link is contained');
  // emulate the document-level handler
  if (c.isOpen() && !c.contains(outside)) c.close(false);
  assert.equal(h.details.open, false);
});

// --- JS: disclosure behaviour (source contract) ------------------------

test('disclosure is driven by the native details open state (no aria-expanded duplication)', () => {
  assert.doesNotMatch(
    chapterJs,
    /setAttribute\(\s*['"]aria-expanded['"]/,
    'must not manually set aria-expanded (the native details owns it)'
  );
  assert.match(chapterJs, /details\.open\s*=\s*false/, 'closes by clearing the native open state');
  assert.match(chapterJs, /createDisclosureController/, 'uses the extracted, testable controller');
  assert.match(chapterJs, /summary\.focus/, 'focus returns to the summary on close');
});

test('outside click and link activation close the menu', () => {
  assert.match(chapterJs, /addEventListener\(\s*['"]click['"][\s\S]*!disclosure\.contains/, 'outside-click guard uses contains()');
  assert.match(chapterJs, /target\.closest\(['"]a['"]\)/, 'link activation detected via closest("a")');
});

// --- JS: scroll-spy / aria-current -------------------------------------

test('scroll-spy uses IntersectionObserver and delegates to pickActiveSection', () => {
  assert.match(chapterJs, /new IntersectionObserver/, 'must construct an IntersectionObserver');
  assert.match(chapterJs, /rootMargin\s*[:=]\s*['"]-20%/, 'uses a top-biased rootMargin band');
  assert.match(chapterJs, /observer\.observe\(/, 'must observe the section targets');
  assert.match(chapterJs, /pickActiveSection\(visible/, 'selection is delegated to the pure helper');
});

test('in-page scroll-spy uses the "location" value (an in-page position)', () => {
  assert.match(
    chapterJs,
    /setAttribute\(\s*['"]aria-current['"]\s*,\s*['"]location['"]\)/,
    'scroll-spy must set aria-current="location" for the current in-page section'
  );
});

test('the Books page is marked aria-current="page" via a dedicated page-current path', () => {
  // Scroll-spy still owns "location" for in-page sections. The Books PAGE link
  // (a route, not an in-page anchor) is marked "page" by a separate, explicit
  // code path that only runs when isBooksPage() is true.
  assert.match(
    chapterJs,
    /setAttribute\(\s*['"]aria-current['"]\s*,\s*['"]page['"]\)/,
    'must set aria-current="page" for the Books page link on the /books page'
  );
  assert.match(chapterJs, /isBooksPage/, 'must expose an isBooksPage detection');
  assert.match(chapterJs, /markBooksPageCurrent/, 'must mark the books page link current');
  // The scroll-spy is skipped on the books page (its home targets are absent).
  assert.match(
    chapterJs,
    /if\s*\(\s*isBooksPage\(\)\s*\)\s*\{[\s\S]*?markBooksPageCurrent[\s\S]*?\}\s*else\s*\{[\s\S]*?setupScrollSpy/,
    'books page marks current page; otherwise scroll-spy runs'
  );
});

test('isBooksPage: recognizes /books and /books/ (canonical), rejects home and others', () => {
  assert.equal(isBooksPage('/books'), true);
  assert.equal(isBooksPage('/books/'), true);
  assert.equal(isBooksPage('/books//'), true);
  assert.equal(isBooksPage('/'), false);
  assert.equal(isBooksPage('/index.html'), false);
  assert.equal(isBooksPage('/#gallery'), false);
});

test('markBooksPageCurrent: sets "page" only on chapter-link-page links, clears others', () => {
  const pageSet = { value: null };
  const sectionCleared = { count: 0 };
  const pageLink = {
    classList: { contains: (c) => c === 'chapter-link-page' },
    setAttribute: (_k, v) => { pageSet.value = v; },
    removeAttribute() {}
  };
  const sectionLink = {
    classList: { contains: () => false },
    setAttribute() {},
    removeAttribute: () => { sectionCleared.count += 1; }
  };
  markBooksPageCurrent([pageLink, sectionLink]);
  assert.equal(pageSet.value, 'page');
  assert.equal(sectionCleared.count, 1);
});

test('only links with a data-target can become current; books is never observed', () => {
  assert.match(chapterJs, /removeAttribute\(\s*['"]aria-current['"]\)/, 'must clear aria-current from non-current links');
  assert.match(
    chapterJs,
    /if\s*\(\s*link\.dataset\.target\s*&&\s*link\.dataset\.target\s*===\s*id\)/,
    'only links WITH a data-target can become current (books has none)'
  );
  const sectionsArray = chapterJs.match(/IN_PAGE_SECTIONS\s*=\s*\[[\s\S]*?\]/)[0];
  assert.match(sectionsArray, /'testimonials'/, 'testimonials is observed');
  assert.doesNotMatch(sectionsArray, /'\/books'/, 'the /books route is never in the observed list');
});

test('scroll-spy is non-intrusive: no history spam, no focus stealing, no live region', () => {
  assert.doesNotMatch(chapterJs, /history\.(pushState|replaceState)/, 'must not touch browser history');
  assert.doesNotMatch(chapterJs, /aria-live/, 'must not announce to any live region');
});

// --- JS: dialog coexistence --------------------------------------------

test('chapter nav hides while the painting dialog is open and restores on close', () => {
  assert.match(chapterJs, /getElementById\(\s*['"]painting-dialog['"]\)/, 'must reference the painting dialog');
  assert.match(chapterJs, /paintingDialog\.open/, 'must read dialog.open state');
  assert.match(
    chapterJs,
    /chapterNav\.hidden\s*=/,
    'nav visibility must be driven by the dialog open state'
  );
  assert.match(
    chapterJs,
    /paintingDialog\.addEventListener\(\s*['"]close['"]/,
    'must restore on the native dialog close event'
  );
  assert.match(
    chapterJs,
    /new MutationObserver\([\s\S]*?observe\(\s*paintingDialog,[\s\S]*?attributeFilter:\s*\[\s*['"]open['"]\s*\]/,
    'must observe the dialog open attribute to hide immediately on showModal()'
  );
});

test('chapter-nav.js keeps the native dialog as the top layer (no manual stacking)', () => {
  assert.doesNotMatch(
    chapterJs,
    /paintingDialog\.showModal\(\)|paintingDialog\.close\(\)/,
    'must not open/close the dialog itself (delegates to gallery script)'
  );
});

// --- /books dependency -------------------------------------------------

test('/books link is retained and the route is now implemented and served by the Worker', () => {
  // The link stays in the home nav as a route (not an in-page anchor).
  assert.match(indexHtml, /href="\/books"/, 'the /books link is retained');
  // The worker owns every Books URL (canonical /books plus its aliases) through
  // the isBooksPage route contract, and serves GET /books from there.
  assert.match(
    workerJs,
    /export function isBooksPage/,
    'the worker must define the isBooksPage route contract'
  );
  assert.match(
    workerJs,
    /isBooksPage\(url\.pathname\)/,
    'the worker must route Books URLs through isBooksPage'
  );
  assert.match(
    workerJs,
    /return serveBooksPage\(request, env\)/,
    'GET /books must serve the Books page'
  );
});

// --- Build integration --------------------------------------------------

test('chapter-nav.js is syntax-checked by build/lint/type-check and loaded by the page', () => {
  for (const script of ['build', 'lint', 'type-check']) {
    assert.ok(
      rootPkg.includes(`node --check public/chapter-nav.js`),
      `chapter-nav.js must be in the ${script} check list`
    );
  }
  assert.match(
    indexHtml,
    /<script\s+type="module"\s+src="\.\/chapter-nav\.js\?v=chapter-nav-disclosure">/,
    'index.html must load chapter-nav.js as a module'
  );
});
