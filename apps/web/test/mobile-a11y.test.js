// Mobile accessibility contracts for the public site (regression guards for
// the bounded mobile-a11y pass). These mirror the repo's source-string test
// style: they pin the touch-target, reflow, dialog, and phone-typography
// behaviors without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');
const scriptJs = readFileSync(join(publicDir, 'script.js'), 'utf8');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

// Extract one full @media block by balancing braces (media blocks nest rules,
// so a simple [^}]* capture would stop at the first inner close brace).
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

test('filter chips meet the preferred 48px touch target', () => {
  const chip = ruleBody(stylesCss, '.filter-chip');
  assert.ok(chip, 'base .filter-chip rule exists');
  const m = chip.match(/min-height:\s*(\d+)px/);
  assert.ok(m, 'chip declares a min-height');
  assert.ok(
    Number(m[1]) >= 48,
    `filter chips are primary controls: min-height >= 48px (got ${m[1]}px)`
  );
});

test('dialog close control keeps a >=44px square hit area', () => {
  const close = ruleBody(stylesCss, '.dialog-close');
  assert.ok(close, '.dialog-close rule exists');
  assert.match(close, /min-width:\s*44px/, 'close declares min-width: 44px');
  const h = close.match(/height:\s*(\d+)px/);
  assert.ok(h, 'close declares an explicit height');
  assert.ok(
    Number(h[1]) >= 40 && Number(h[1]) <= 44,
    `close height stays compact 40-44px (got ${h[1]}px)`
  );
});

test('topbar brand track can shrink so 320px/zoom reflows instead of overflowing', () => {
  const topbar = ruleBody(stylesCss, '.topbar');
  assert.ok(topbar, '.topbar rule exists');
  assert.match(
    topbar,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/,
    'brand track must be minmax(0,1fr), not a rigid 1fr'
  );
});

test('brand link reserves a 44px minimum hit area', () => {
  const brand = ruleBody(stylesCss, '.brand');
  assert.ok(brand, '.brand rule exists');
  assert.match(brand, /min-height:\s*44px/);
});

test('painting dialog scrolls inside a viewport-bounded box', () => {
  // .painting-dialog appears in a shared surface group earlier in the sheet;
  // the layout rule is the block that declares the max-height cap.
  const blocks = [...stylesCss.matchAll(/\.painting-dialog\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const dlg = blocks.find((body) => /max-height/.test(body));
  assert.ok(dlg, 'a .painting-dialog rule declares a max-height');
  assert.match(dlg, /max-height:\s*calc\(100dvh\s*-\s*24px\)/, 'dialog caps at viewport height');
  assert.match(dlg, /overflow-y:\s*auto/, 'dialog content scrolls when taller than the cap');
});

test('page scroll locks behind the open modal dialog', () => {
  const lock = ruleBody(stylesCss, 'html.dialog-open');
  assert.ok(lock, 'html.dialog-open rule exists');
  assert.match(lock, /overflow:\s*hidden/);
});

test('script.js adds the scroll lock on open and removes it on close', () => {
  assert.match(scriptJs, /classList\.add\(\s*['"]dialog-open['"]\s*\)/);
  assert.match(scriptJs, /dialog\.addEventListener\(\s*['"]close['"]\s*,/);
  assert.match(scriptJs, /classList\.remove\(\s*['"]dialog-open['"]\s*\)/);
});

test('dialog close returns focus to the opening card without scrolling', () => {
  assert.match(
    scriptJs,
    /dialogOpener\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/
  );
  assert.match(scriptJs, /document\.contains\(dialogOpener\)/);
});

test('one-column dialog caps the artwork against the viewport height', () => {
  const block = mediaBlock(stylesCss, 'max-width:\\s*960px');
  assert.ok(block, 'max-width 960px media block exists');
  const img = block.match(/\.dialog-image img\s*\{([^}]*)\}/);
  assert.ok(img, '.dialog-image img override exists in the 960px block');
  assert.match(img[1], /width:\s*auto/);
  assert.match(img[1], /max-width:\s*100%/);
  assert.match(img[1], /max-height:\s*52dvh/, 'image height is viewport-capped');
});

test('phone-width card and status text read at a full 16px', () => {
  const block = mediaBlock(stylesCss, 'max-width:\\s*640px');
  assert.ok(block, 'max-width 640px media block exists');
  assert.match(block, /\.painting-card-body\s+p,/);
  assert.match(block, /\.gallery-results,/);
  assert.match(block, /\.contact-status,/);
  assert.match(block, /font-size:\s*1rem/);
});

test('phone-width labels and footer copy gain size', () => {
  const block = mediaBlock(stylesCss, 'max-width:\\s*640px');
  assert.ok(block);
  assert.match(block, /\.hero-card-label\s*\{[\s\S]*?font-size:\s*0\.78rem/);
  assert.match(block, /\.site-footer-copy\s*\{[\s\S]*?font-size:\s*0\.95rem/);
});

test('coarse-pointer inline nav and footer links get 44px targets', () => {
  const block = mediaBlock(stylesCss, 'pointer:\\s*coarse');
  assert.ok(block, 'pointer: coarse media block exists');
  assert.match(block, /\.topbar-links a,/);
  assert.match(block, /\.site-footer-nav a\s*\{[\s\S]*?min-height:\s*44px/);
});

test('touch pressed-state feedback is gated to hover-incapable pointers', () => {
  const block = mediaBlock(stylesCss, 'hover:\\s*none');
  assert.ok(block, 'hover: none media block exists');
  assert.match(block, /\.filter-chip:active/);
  assert.doesNotMatch(
    stylesCss.replace(block, ''),
    /\.filter-chip:active\s*\{/,
    'ungated :active rules must not change fine-pointer desktop interaction'
  );
});

test('footer links share the visible focus treatment', () => {
  assert.match(stylesCss, /\.site-footer-nav a:focus-visible/);
});

test('desktop base type contracts are unchanged by the mobile pass', () => {
  const span = ruleBody(stylesCss, '.painting-card-body span');
  assert.ok(span);
  assert.match(span, /font-size:\s*0\.8rem/, 'availability badge base size is pinned');
  const p = ruleBody(stylesCss, '.painting-card-body p');
  assert.ok(p);
  assert.match(p, /font-size:\s*0\.875rem/, 'card price base size is pinned');
});

test('contact form declares autocomplete tokens and a visible required hint', () => {
  const formStart = indexHtml.indexOf('id="inquiry-form"');
  assert.ok(formStart > -1, 'contact form exists');
  const form = indexHtml.slice(formStart, indexHtml.indexOf('</form>', formStart));
  assert.match(form, /autocomplete="name"/);
  assert.match(form, /autocomplete="email"/);
  const painting = form.match(/id="painting-name"[^>]*/);
  assert.ok(painting, 'painting field exists');
  assert.match(painting[0], /autocomplete="off"/);
  assert.match(
    form,
    /class="form-hint"[^>]*>All fields are required\./,
    'visible required-fields hint is present'
  );
});

test('books availability badge reads at 0.75rem', () => {
  const badge = ruleBody(booksCss, '.book-availability');
  assert.ok(badge, '.book-availability rule exists');
  assert.match(badge, /font-size:\s*0\.75rem/);
});

test('phone-width books status and quantity labels read at 16px', () => {
  const block = mediaBlock(booksCss, 'max-width:\\s*640px');
  assert.ok(block, 'books.css 640px block exists');
  assert.match(block, /\.books-status,/);
  assert.match(block, /\.books-qty label,/);
  assert.match(block, /font-size:\s*1rem/);
});

test('the Turnstile container cannot drag the page sideways at 320px', () => {
  // The widget iframe is a fixed 300px wide; below 360px books.js renders the
  // compact variant and the container clamps to the form column.
  const box = ruleBody(booksCss, '.books-turnstile');
  assert.ok(box, '.books-turnstile rule exists');
  assert.match(box, /max-width:\s*100%/);
  const booksJs = readFileSync(join(publicDir, 'books.js'), 'utf8');
  assert.match(
    booksJs,
    /max-width:\s*359px[\s\S]{0,120}'compact'/,
    'narrow viewports select the compact widget'
  );
});
