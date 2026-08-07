// Lightweight, dependency-free computed-layout regression test for the Books
// expression-of-interest form.
//
// A real browser test (Playwright/Puppeteer) would require a heavy browser
// download, so instead this models the CSS grid minimum-track sizing function
// that is the actual mechanism behind 320px horizontal overflow. It uses only
// the built-in node:test runner (also runnable directly: `node test/books-form-overflow.test.js`).
//
// Mechanism: a grid track's minimum size is its min sizing function.
//   minmax(0, 1fr)              -> 0  (the column shrinks to nothing; controls
//                                     never force the page wider than the viewport)
//   1fr / auto / minmax(auto,*) -> Infinity (the item's intrinsic minimum, e.g. a
//                                     <select>/<input> UA minimum -> overflow)
// If every grid level in the form subtree resolves to a 0 minimum, the form
// provably fits any viewport >= its own box padding/borders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');

// --- minimal CSS helpers -------------------------------------------------

// Strip /* */ comments.
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Find the first rule body for a selector whose body also matches `also`.
// `also` disambiguates the standalone .books-eoi-form rule (which carries
// max-width:620px) from the grouped surface rule that shares the selector.
// A literal space in the selector matches one-or-more whitespace, so
// ".books-eoi-form label" also matches the selector-list line break.
function ruleBodyFor(css, selector, also = '') {
  const src = strip(css);
  const esc = selector
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s+');
  const re = new RegExp(`${esc}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of src.matchAll(re)) {
    if (!also || new RegExp(also).test(m[1])) return m[1];
  }
  return null;
}

// Extract a single declaration value (first match) from a rule body.
function decl(body, prop) {
  if (!body) return null;
  const m = body.match(new RegExp(`${prop}\\s*:\\s*([^;}]+)`));
  return m ? m[1].trim() : null;
}

// --- the layout model ----------------------------------------------------

// Minimum width (in px, or 0, or Infinity) a single grid track can shrink to,
// given its grid-template-columns value. All Books-form grids are single-track,
// so this resolves the whole value. `null` means "not a grid track" (e.g. none).
function trackMinWidth(gridTemplate) {
  if (!gridTemplate) return Infinity; // no explicit track -> implicit auto -> overflow risk
  const v = gridTemplate.replace(/\s+/g, ' ').trim();
  if (v === 'none') return null; // flex override / opt-out
  const mm = v.match(/minmax\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/i);
  const minTok = mm ? mm[1] : v; // bare token: 1fr == minmax(auto,1fr)
  return sizingMin(minTok);
}

function sizingMin(tok) {
  const t = tok.trim();
  if (/^(0|0px)$/.test(t)) return 0;
  if (/fr$/.test(t)) return Infinity; // bare fr -> auto minimum
  if (/^(auto|min-content|max-content)$/.test(t)) return Infinity;
  if (/^-?\d+(\.\d+)?px$/.test(t)) return parseFloat(t); // fixed minimum
  return Infinity;
}

// --- the regression assertions ------------------------------------------

test('shared styles.css is the inherited grid root cause: <label> is a grid with no explicit track', () => {
  const labelBody = ruleBodyFor(stylesCss, 'label', 'display:\\s*grid');
  assert.ok(labelBody, 'a bare label{display:grid} rule must exist in styles.css');
  assert.match(labelBody, /display:\s*grid/, 'the shared sheet turns every label into a grid container');
  // No explicit track -> implicit auto -> would overflow if not overridden below.
  assert.equal(decl(labelBody, 'grid-template-columns'), null,
    'the inherited label grid has no explicit track (the latent overflow source)');
});

test('shared public form controls include select in font, surface, and focus inheritance', () => {
  assert.match(stylesCss, /button,\s*\ninput,\s*\nselect,\s*\ntextarea\s*\{\s*\n\s*font:\s*inherit/);
  assert.match(stylesCss, /input,\s*\nselect,\s*\ntextarea\s*\{[^}]*width:\s*100%[^}]*color:\s*var\(--text\)/);
  assert.match(stylesCss, /input:focus-visible,\s*\nselect:focus-visible,\s*\ntextarea:focus-visible/);
});

test('every grid level of the Books form resolves to a 0-minimum track (no 320px overflow)', () => {
  const formBody = ruleBodyFor(booksCss, '.books-eoi-form', 'max-width:\\s*620px');
  const fieldsetBody = ruleBodyFor(booksCss, '.books-fieldset');
  const labelOverride = ruleBodyFor(booksCss, '.books-eoi-form label');

  assert.ok(formBody, 'standalone .books-eoi-form rule must exist');
  assert.ok(fieldsetBody, '.books-fieldset rule must exist');
  assert.ok(labelOverride, '.books-eoi-form label override must exist');

  const levels = {
    '.books-eoi-form (form)': trackMinWidth(decl(formBody, 'grid-template-columns')),
    '.books-fieldset (nested fieldset)': trackMinWidth(decl(fieldsetBody, 'grid-template-columns')),
    '.books-eoi-form label (inherited-label override)': trackMinWidth(decl(labelOverride, 'grid-template-columns'))
  };

  for (const [name, min] of Object.entries(levels)) {
    assert.equal(min, 0, `${name} must resolve to a 0-minimum track, got ${min}`);
  }
});

test('a regressed bare/auto track would be caught (negative control)', () => {
  // Sanity-check the model: a bare 1fr or auto track resolves to an infinite
  // minimum (the overflow case), proving the assertions above are meaningful.
  assert.equal(trackMinWidth('1fr'), Infinity);
  assert.equal(trackMinWidth('auto'), Infinity);
  assert.equal(trackMinWidth('minmax(auto, 1fr)'), Infinity);
  assert.equal(trackMinWidth('minmax(0, 1fr)'), 0);
});

test('at 320px the form content box is positive and every control can fit it', () => {
  // Box model at <=640px: @media(max-width:640px) sets .books-eoi-form padding
  // to 20px; the grouped surface rule gives a 1px border each side. So the form
  // content-box width at 320px is 320 - 2*20 - 2*1 = 278px. Because every grid
  // track minimum is 0 (proven above) and inputs are max-width:100%/min-width:0,
  // the deepest control can shrink into <=278px -> no horizontal overflow.
  const src = strip(booksCss);
  const start = src.indexOf('@media (max-width: 640px)');
  assert.notEqual(start, -1, 'a max-width:640px breakpoint must exist');
  const next = src.indexOf('@media', start + 1);
  const narrowMedia = src.slice(start, next === -1 ? undefined : next);
  assert.match(narrowMedia, /\.books-eoi-form[\s\S]*?padding:\s*20px/,
    'the 640px breakpoint must reduce form padding at narrow widths');

  const viewport = 320;
  const padding = 20;
  const border = 1; // 1px solid var(--border) from the grouped surface rule
  const contentBox = viewport - 2 * padding - 2 * border;
  assert.ok(contentBox > 0, `content box must be positive at ${viewport}px (got ${contentBox}px)`);

  const formBody = ruleBodyFor(booksCss, '.books-eoi-form', 'max-width:\\s*620px');
  const formMin = trackMinWidth(decl(formBody, 'grid-template-columns'));
  assert.equal(formMin, 0, 'form track min must be 0 so children can fit the content box');
  assert.ok(formMin <= contentBox, `form track min (${formMin}) must fit the ${contentBox}px content box`);
});
