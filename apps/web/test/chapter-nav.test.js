import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const chapterJs = readFileSync(join(publicDir, 'chapter-nav.js'), 'utf8');
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

// --- Disclosure markup --------------------------------------------------

test('mobile disclosure button exposes correct initial semantics', () => {
  const btn = indexHtml.match(/<button\b[^>]*\bid="chapter-toggle"[^>]*>/i);
  assert.ok(btn, '#chapter-toggle button exists');
  assert.match(btn[0], /\btype="button"/, 'must be type="button"');
  assert.match(btn[0], /aria-expanded="false"/, 'starts collapsed (aria-expanded="false")');
  assert.match(btn[0], /aria-controls="chapter-menu"/, 'controls the menu by id');
  assert.match(btn[0], /class="[^"]*\bbutton\b/, 'reuses the shared .button control styling');
});

test('the toggle visible label is exactly "Explore"', () => {
  const m = indexHtml.match(/<button\b[^>]*\bid="chapter-toggle"[^>]*>([\s\S]*?)<\/button>/i);
  assert.ok(m);
  assert.equal(m[1].trim(), 'Explore');
});

test('menu starts hidden so it is removed from the focus order', () => {
  const menu = indexHtml.match(/<ul\b[^>]*\bid="chapter-menu"[^>]*>/i);
  assert.ok(menu, '#chapter-menu list exists');
  assert.match(menu[0], /\bhidden\b/, 'menu must start with the [hidden] attribute');
});

// --- Desktop rail geometry / breakpoint --------------------------------

test('wide breakpoint is min-width: 1280px (not 980px)', () => {
  assert.ok(/@media\s*\(\s*min-width:\s*1280px\s*\)/.test(stylesCss), 'uses min-width: 1280px');
  assert.doesNotMatch(
    stylesCss,
    /@media\s*\(\s*min-width:\s*980px\s*\)/,
    'must not use the lower 980px breakpoint'
  );
});

test('desktop rail is fixed to the right edge, <=124px wide, opaque and warm', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1280px)');
  assert.ok(wide, 'wide media block must exist');
  const body = ruleBody(wide, '.chapter-rail');
  assert.ok(body, '.chapter-rail rule must exist in the wide block');
  assert.match(body, /position:\s*fixed/, 'rail must be position: fixed');
  assert.match(body, /right:\s*0/, 'rail must anchor to the right edge');
  const w = body.match(/width:\s*var\(--chapter-rail-width\)|width:\s*(\d+)px/);
  assert.ok(w, 'rail must declare a width');
  assert.match(body, /background:\s*var\(--surface-strong\)/, 'rail surface must be opaque warm');
  assert.match(body, /border-left:\s*1px solid var\(--border\)/, 'rail has a subtle 1px divider');
});

test('rail width token is capped at 124px', () => {
  const root = ruleBody(stylesCss, ':root');
  assert.ok(root, ':root must exist');
  const m = root.match(/--chapter-rail-width:\s*(\d+)px/);
  assert.ok(m, '--chapter-rail-width token must exist');
  assert.ok(Number(m[1]) <= 124, `rail width must be <= 124px (got ${m[1]}px)`);
});

test('desktop rail targets are >= 44px', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1280px)');
  const a = ruleBody(wide, '.chapter-rail a');
  assert.ok(a, '.chapter-rail a rule must exist');
  const m = a.match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(m, 'rail link must declare a min-height');
  assert.ok(Number(m[1]) >= 44, `rail link min-height must be >= 44px (got ${m[1]}px)`);
});

test('desktop rail never overlaps content: body reserves a right lane >= rail width', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1280px)');
  const body = ruleBody(wide, 'body');
  assert.ok(body, 'a body rule must exist in the wide block');
  assert.match(
    body,
    /padding-right:\s*calc\(\s*var\(--chapter-rail-width\)/,
    'body must reserve a right lane derived from the rail width'
  );
  const plus = body.match(/--chapter-rail-width\)\s*\+\s*var\(--chapter-rail-gap\)/);
  assert.ok(plus, 'reservation must add a gap so content clears the rail');
});

test('rail is vertically centred without transform (no clash with hover nudges)', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1280px)');
  const body = ruleBody(wide, '.chapter-rail');
  assert.ok(body);
  assert.match(body, /align-content:\s*center/, 'centred via grid align-content');
  assert.doesNotMatch(body, /transform\s*:/, 'rail positioning must not rely on transform');
});

test('the mobile disclosure + menu are suppressed on wide screens', () => {
  const wide = mediaBlock(stylesCss, '(min-width: 1280px)');
  assert.ok(wide);
  const sup = wide.match(/\.chapter-toggle,[\s\S]*?\.chapter-menu\s*\{([^}]*)\}/);
  assert.ok(sup, 'a combined .chapter-toggle, .chapter-menu rule must exist in the wide block');
  assert.match(sup[1], /display:\s*none/, 'both mobile controls must be display: none on desktop');
});

test('the rail is hidden by default (mobile-first) and only revealed in the wide block', () => {
  const base = ruleBody(stylesCss, '.chapter-rail');
  assert.ok(base, 'base .chapter-rail rule must exist');
  assert.match(base, /display:\s*none/, 'rail must be display: none outside the wide breakpoint');
});

// --- Mobile disclosure CSS / safe area / no BTT overlap ----------------

test('mobile disclosure is fixed, safe-area aware, and >= 44px', () => {
  const body = ruleBody(stylesCss, '.chapter-toggle');
  assert.ok(body, '.chapter-toggle rule must exist');
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
  const w = body.match(/min-width:\s*(\d+)px/);
  const h = body.match(/min-height:\s*(\d+)px/);
  assert.ok(w && Number(w[1]) >= 44, 'min-width >= 44px');
  assert.ok(h && Number(h[1]) >= 44, 'min-height >= 44px');
});

test('mobile disclosure is anchored right only (cannot overlap the centred Back to Top)', () => {
  const body = ruleBody(stylesCss, '.chapter-toggle');
  assert.ok(body);
  assert.match(body, /right:\s*calc/, 'anchored from the right');
  assert.doesNotMatch(body, /left:\s*0/, 'must not also anchor left:0');
  assert.doesNotMatch(
    body,
    /left:\s*0[\s\S]*right:\s*0|right:\s*0[\s\S]*left:\s*0/,
    'must not be a left:0/right:0 full-width bar (would collide with centred BTT)'
  );
});

test('menu opens upward, stays within the viewport, and is removed from focus order when closed', () => {
  const body = ruleBody(stylesCss, '.chapter-menu');
  assert.ok(body, '.chapter-menu rule must exist');
  assert.match(body, /position:\s*fixed/, 'must be fixed');
  assert.match(body, /right:\s*calc\(\s*env\(\s*safe-area-inset-right/, 'right-anchored + safe area');
  const bottom = body.match(/bottom:\s*calc\(\s*env\(\s*safe-area-inset-bottom[^)]*\)\s*\+\s*(\d+)px/);
  assert.ok(bottom, 'menu bottom must be a safe-area calc');
  const toggleBottom = ruleBody(stylesCss, '.chapter-toggle').match(
    /bottom:\s*calc\(\s*env\(\s*safe-area-inset-bottom[^)]*\)\s*\+\s*(\d+)px/
  );
  assert.ok(
    Number(bottom[1]) > Number(toggleBottom[1]),
    'menu must sit higher than the toggle (opens upward)'
  );
  assert.match(
    body,
    /max-width:\s*calc\(100(?:vw|%)\s*-\s*32px\)/,
    'menu must cap width so it never causes horizontal overflow at 320/393px'
  );
  const hidden = ruleBody(stylesCss, '.chapter-menu[hidden]');
  assert.ok(hidden, '.chapter-menu[hidden] override must exist');
  assert.match(hidden, /display:\s*none/, 'closed menu must be display: none (out of focus order)');
});

test('Back to Top remains centred and unchanged', () => {
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

test('anchor targets carry scroll-margin so fixed UI cannot obscure focused content', () => {
  assert.match(
    stylesCss,
    /#top,[\s\S]*?\.section\[id\]\s*\{[\s\S]*?scroll-margin-top:/,
    'a scroll-margin-top rule covering #top and section[id] targets must exist'
  );
});

test('chapter controls are covered by the unified focus-visible ring', () => {
  assert.ok(stylesCss.includes('.chapter-link:focus-visible'));
  assert.ok(stylesCss.includes('.chapter-toggle:focus-visible'));
});

// --- JS: disclosure behaviour ------------------------------------------

test('disclosure wiring toggles aria-expanded and the hidden menu', () => {
  assert.match(chapterJs, /isMenuExpanded/, 'an expanded-state helper must exist');
  assert.match(chapterJs, /setAttribute\(\s*['"]aria-expanded['"]\s*,\s*['"]true['"]\)/, 'sets expanded true on open');
  assert.match(chapterJs, /setAttribute\(\s*['"]aria-expanded['"]\s*,\s*['"]false['"]\)/, 'sets expanded false on close');
  assert.match(chapterJs, /chapterMenu\.hidden\s*=\s*false/, 'reveals menu on open');
  assert.match(chapterJs, /chapterMenu\.hidden\s*=\s*true/, 'hides menu on close');
  assert.match(chapterJs, /first\.focus\(\)/, 'moves focus into the menu on open');
});

test('Escape closes the menu and returns focus to the toggle', () => {
  assert.match(
    chapterJs,
    /addEventListener\(\s*['"]keydown['"][\s\S]*?event\.key !== ['"]Escape['"]/,
    'a keydown handler must gate on Escape'
  );
  assert.match(chapterJs, /closeChapterMenu\(\s*true\s*\)/, 'Escape/outside-toggle path returns focus');
  assert.match(chapterJs, /chapterToggle\.focus\(\)/, 'focus is returned to the toggle');
});

test('outside click and link activation close the menu', () => {
  assert.match(chapterJs, /addEventListener\(\s*['"]click['"][\s\S]*contains\(event\.target\)/, 'outside-click guard uses contains()');
  assert.match(chapterJs, /event\.target\.closest\(['"]a['"]\)/, 'link activation detected via closest("a")');
});

// --- JS: scroll-spy / aria-current -------------------------------------

test('scroll-spy uses IntersectionObserver and marks exactly one in-page section', () => {
  assert.match(chapterJs, /new IntersectionObserver/, 'must construct an IntersectionObserver');
  assert.match(chapterJs, /rootMargin:\s*['"]-20%/, 'uses a top-biased rootMargin band');
  assert.match(chapterJs, /observer\.observe\(/, 'must observe the section targets');
});

test('aria-current uses the "location" value (in-page position), never "page"', () => {
  assert.match(
    chapterJs,
    /setAttribute\(\s*['"]aria-current['"]\s*,\s*['"]location['"]\)/,
    'must set aria-current="location" for the current in-page section'
  );
  assert.doesNotMatch(
    chapterJs,
    /aria-current['"]\s*,\s*['"]page['"]/,
    'must never use aria-current="page" for in-page scroll-spy'
  );
});

test('only one link is current at a time and books is never marked', () => {
  assert.match(chapterJs, /removeAttribute\(\s*['"]aria-current['"]\)/, 'must clear aria-current from non-current links');
  assert.match(
    chapterJs,
    /if\s*\(\s*link\.dataset\.target\s*&&\s*link\.dataset\.target\s*===\s*id\)/,
    'only links WITH a data-target can become current (books has none)'
  );
  assert.ok(
    /IN_PAGE_SECTIONS\s*=\s*\[[\s\S]*?'testimonials'/.test(chapterJs) &&
      !/'\/books'/.test(chapterJs.match(/IN_PAGE_SECTIONS\s*=\s*\[[\s\S]*?\]/)[0]),
    'the observed section list includes testimonials but never /books'
  );
});

test('scroll-spy is non-intrusive: no history spam, no focus stealing, no live region', () => {
  assert.doesNotMatch(chapterJs, /history\.(pushState|replaceState)/, 'must not touch browser history');
  assert.doesNotMatch(chapterJs, /aria-live/, 'must not announce to any live region');
  // Focus is only ever moved to the toggle or the first menu item, never to a section.
  const focusMoves = chapterJs.match(/\.focus\(\)/g) || [];
  assert.ok(
    focusMoves.length <= 2,
    'focus is only moved into the menu and back to the toggle (never to a section)'
  );
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
    /<script\s+type="module"\s+src="\.\/chapter-nav\.js\?v=chapter-nav-phase2">/,
    'index.html must load chapter-nav.js as a module'
  );
});
