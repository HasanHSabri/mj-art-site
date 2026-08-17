import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  rectsOverlap,
  computeBackToTopHidden,
  isBackToTopObstructed
} from '../public/back-to-top.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const galleryHtml = readFileSync(join(publicDir, 'gallery.html'), 'utf8');
const booksHtml = readFileSync(join(publicDir, 'books.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const scriptJs = readFileSync(join(publicDir, 'script.js'), 'utf8');
const booksJs = readFileSync(join(publicDir, 'books.js'), 'utf8');
const homeJs = readFileSync(join(publicDir, 'home.js'), 'utf8');
const backToTopJs = readFileSync(join(publicDir, 'back-to-top.js'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

// A tiny fake element: only getBoundingClientRect is needed.
function fakeEl(rect) {
  return { getBoundingClientRect: () => rect };
}

test('back-to-top is a static, accessible button control on every public page', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    const btn = html.match(/<button\b[^>]*\bid="back-to-top"[^>]*>([\s\S]*?)<\/button>/i);
    assert.ok(btn, `#back-to-top <button> exists on ${name}`);
    assert.ok(/\btype="button"/.test(btn[0]), `${name}: must be type="button" (no form submit)`);
    assert.ok(
      /\bclass="[^"]*\bbutton\b[^"]*"/.test(btn[0]),
      `${name}: reuses the established .button style`
    );
    assert.equal(
      btn[1].trim(),
      'Back to Top',
      `${name}: visible text must be exactly "Back to Top" (also its accessible name)`
    );
    assert.ok(/\bhidden\b/.test(btn[0]), `${name}: starts hidden (out of the tab order at top)`);
  }
});

test('every public page exposes #top as the scroll target', () => {
  for (const [name, html] of [['home', indexHtml], ['gallery', galleryHtml], ['books', booksHtml]]) {
    assert.ok(/\bid="top"/.test(html), `${name} exposes #top for the back-to-top click target`);
  }
});

test('back-to-top is fixed and anchored to the bottom-right safe side (clear of centered forms/CTAs)', () => {
  const body = ruleBody(stylesCss, '.back-to-top');
  assert.ok(body, '.back-to-top rule exists in styles.css');
  assert.match(body, /position:\s*fixed/, '.back-to-top must be position: fixed');
  assert.match(
    body,
    /bottom:\s*calc\(\s*env\(\s*safe-area-inset-bottom/,
    '.back-to-top bottom must include env(safe-area-inset-bottom)'
  );
  // Anchored to the right side (the safe side away from centered forms,
  // consent text, and CTAs), with the iOS right safe area accounted for.
  assert.match(
    body,
    /right:\s*max\(\s*\d+px\s*,\s*env\(\s*safe-area-inset-right\s*,\s*0px\s*\)\s*\)/,
    '.back-to-top must anchor right with a safe-area-aware inset'
  );
  assert.match(body, /left:\s*auto/, '.back-to-top must not anchor left (side placement)');
  assert.doesNotMatch(
    body,
    /margin-inline:\s*auto/,
    'centering is removed: the control lives on the safe side, not mid-content'
  );
  assert.match(
    body,
    /width:\s*fit-content/,
    '.back-to-top needs a constrained width'
  );
  assert.match(
    body,
    /max-width:\s*calc\(100%\s*-\s*\d+px\)/,
    '.back-to-top must cap width to avoid horizontal overflow'
  );
});

test('placement never relies on transform (so .button hover nudge cannot break it)', () => {
  const body = ruleBody(stylesCss, '.back-to-top');
  assert.ok(body);
  assert.doesNotMatch(
    body,
    /transform\s*:/,
    '.back-to-top positioning must not use transform (would clash with .button:hover translateY)'
  );
});

test('hidden attribute fully removes the control (wins over .button display)', () => {
  const body = ruleBody(stylesCss, '.back-to-top[hidden]');
  assert.ok(body, '.back-to-top[hidden] override must exist');
  assert.match(body, /display:\s*none/, '.back-to-top[hidden] must be display: none');
});

test('touch target stays >= 44px via the shared .button min-height', () => {
  const buttonBody = ruleBody(stylesCss, '.button');
  assert.ok(buttonBody, '.button rule exists');
  const m = buttonBody.match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(m, '.button must declare a min-height');
  assert.ok(
    Number(m[1]) >= 44,
    `.button min-height must be >= 44px for touch targets (got ${m[1]}px)`
  );
});

test('focus-visible styling is present', () => {
  const body = ruleBody(stylesCss, '.back-to-top:focus-visible');
  assert.ok(body, '.back-to-top:focus-visible rule must exist');
  assert.match(body, /outline:/, 'focus-visible must provide an outline');
});

test('global CSS reduced-motion override disables smooth scrolling', () => {
  const mq = stylesCss.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\}\s*\}\s*$/);
  assert.ok(mq, 'a prefers-reduced-motion: reduce media block must exist');
  const block = mq[1];
  assert.match(block, /scroll-behavior:\s*auto/, 'html smooth scroll must become auto under reduced motion');
});

test('shared module keeps the threshold, dialog, and passive-scroll behaviour', () => {
  // The behaviour lives once in back-to-top.js. It reveals past the threshold,
  // hides while the optional dialog is open, and re-syncs on dialog toggle.
  assert.match(backToTopJs, /BACK_TO_TOP_THRESHOLD\s*=\s*400/, 'threshold must be ~400px');
  assert.match(
    backToTopJs,
    /addEventListener\(\s*['"]scroll['"]\s*,\s*sync\s*,\s*\{\s*passive:\s*true\s*\}\s*\)/,
    'scroll listener must be passive'
  );
  assert.match(
    backToTopJs,
    /\(\s*dialog\s*&&\s*dialog\.open\s*\)\s*\|\|\s*window\.scrollY\s*<\s*BACK_TO_TOP_THRESHOLD/,
    'visibility must factor dialog.open AND scrollY vs threshold'
  );
  assert.match(
    backToTopJs,
    /dialog\.addEventListener\(\s*['"]toggle['"]/,
    'dialog toggle event must re-sync visibility on open/close'
  );
});

test('shared module hides the control when an avoid zone enters its placement region', () => {
  // Avoid zones: forms (which contain consent text, inputs, and submit
  // buttons), the footer, shared .button controls, and data-btt-avoid.
  assert.match(
    backToTopJs,
    /BACK_TO_TOP_AVOID_SELECTOR\s*=\s*'form,\s*footer,\s*\.button,\s*\[data-btt-avoid\]'/,
    'the avoid selector must cover forms, footer, buttons, and the data attribute'
  );
  assert.match(
    backToTopJs,
    /isBackToTopObstructed\(/,
    'sync must consult the obstruction check'
  );
});

test('rectsOverlap: axis-aligned intersection with margin, edges excluded', () => {
  const a = { left: 0, top: 0, right: 100, bottom: 50 };
  assert.equal(rectsOverlap(a, { left: 50, top: 0, right: 150, bottom: 50 }), true);
  assert.equal(rectsOverlap(a, { left: 100, top: 0, right: 200, bottom: 50 }), false, 'touching edge is not overlap');
  assert.equal(rectsOverlap(a, { left: 0, top: 50, right: 100, bottom: 80 }), false, 'touching top edge is not overlap');
  assert.equal(rectsOverlap(a, { left: 120, top: 0, right: 200, bottom: 50 }), false);
  assert.equal(rectsOverlap(a, { left: 101, top: 0, right: 200, bottom: 50 }), false, 'a 1px gap is no overlap');
  assert.equal(rectsOverlap(a, { left: 99, top: 0, right: 200, bottom: 50 }), true, 'a 1px intrusion is overlap');
  assert.equal(rectsOverlap(null, a), false);
  assert.equal(rectsOverlap(a, null), false);
  // The margin widens the control's keep-out region.
  assert.equal(rectsOverlap(a, { left: 105, top: 0, right: 200, bottom: 50 }, 8), true);
  assert.equal(rectsOverlap(a, { left: 105, top: 0, right: 200, bottom: 50 }, 0), false);
});

test('computeBackToTopHidden: threshold, dialog, and obstruction all hide the control', () => {
  assert.equal(computeBackToTopHidden({ dialogOpen: false, scrollY: 500, threshold: 400, obstructed: false }), false);
  assert.equal(computeBackToTopHidden({ dialogOpen: false, scrollY: 399, threshold: 400, obstructed: false }), true);
  assert.equal(computeBackToTopHidden({ dialogOpen: true, scrollY: 500, threshold: 400, obstructed: false }), true);
  assert.equal(computeBackToTopHidden({ dialogOpen: false, scrollY: 500, threshold: 400, obstructed: true }), true);
  assert.equal(computeBackToTopHidden({ dialogOpen: null, scrollY: '600', threshold: 400, obstructed: 0 }), false);
});

test('isBackToTopObstructed: overlap with any avoid element hides; self and blanks are ignored', () => {
  const button = fakeEl({ left: 340, top: 700, right: 460, bottom: 748 });
  const formBelow = fakeEl({ left: 0, top: 720, right: 320, bottom: 1200 });
  const formTouching = fakeEl({ left: 0, top: 720, right: 470, bottom: 1200 });
  const footer = fakeEl({ left: 0, top: 740, right: 390, bottom: 900 });
  assert.equal(isBackToTopObstructed(button, [formBelow]), false, 'form clear of the corner region');
  assert.equal(isBackToTopObstructed(button, [formTouching]), true, 'form entering the region obstructs');
  assert.equal(isBackToTopObstructed(button, [footer]), true, 'footer entering the region obstructs');
  // The control itself is never its own avoid element.
  assert.equal(isBackToTopObstructed(button, [button]), false);
  // Missing/zero-box elements are ignored; a display:none box cannot obstruct.
  assert.equal(isBackToTopObstructed(button, [null, undefined]), false);
  assert.equal(isBackToTopObstructed(fakeEl({ left: 0, top: 0, right: 0, bottom: 0 }), [formTouching]), false);
  assert.equal(isBackToTopObstructed(null, [formTouching]), false);
  assert.equal(isBackToTopObstructed(button, formTouching), false, 'non-list input is ignored');
});

test('shared module click respects prefers-reduced-motion and targets #top', () => {
  assert.match(
    backToTopJs,
    /matchMedia\(\s*['"]\(prefers-reduced-motion:\s*reduce\)['"]\)/,
    'must query prefers-reduced-motion'
  );
  assert.match(backToTopJs, /getElementById\(\s*['"]top['"]\)/, 'click must scroll to #top');
  assert.match(
    backToTopJs,
    /behavior\s*=\s*reducedMotion\(\)\s*\?\s*['"]auto['"]\s*:\s*['"]smooth['"]/,
    'behavior must be auto under reduced motion, smooth otherwise'
  );
  assert.match(
    backToTopJs,
    /scrollIntoView\(\s*\{\s*behavior\s*,\s*block:\s*['"]start['"]\s*\}\s*\)/,
    'must scrollIntoView #top with the chosen behavior'
  );
});

test('gallery script.js imports the shared module and passes its painting dialog', () => {
  assert.match(
    scriptJs,
    /import\s*\{\s*initBackToTop\s*\}\s*from\s*['"]\.\/back-to-top\.js['"]/,
    'script.js must import initBackToTop from the shared module'
  );
  assert.match(
    scriptJs,
    /initBackToTop\(\s*\{\s*dialog\s*\}\s*\)/,
    'script.js must pass its dialog so the control hides while it is open'
  );
  assert.doesNotMatch(scriptJs, /BACK_TO_TOP_THRESHOLD/, 'script.js must not redefine the threshold');
});

test('home.js and books.js import the shared module (no dialog variant)', () => {
  assert.match(homeJs, /import\s*\{\s*initBackToTop\s*\}\s*from\s*['"]\.\/back-to-top\.js['"]/);
  assert.match(homeJs, /initBackToTop\(\)/, 'home.js calls initBackToTop with no dialog');
  assert.match(
    booksJs,
    /import\s*\{\s*initBackToTop\s*\}\s*from\s*['"]\.\/back-to-top\.js['"]/,
    'books.js must import initBackToTop from the shared module'
  );
  assert.match(booksJs, /initBackToTop\(\)/, 'books.js must call initBackToTop with no dialog');
});
