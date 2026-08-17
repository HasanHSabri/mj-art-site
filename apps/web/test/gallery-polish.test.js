import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const galleryHtml = readFileSync(join(publicDir, 'gallery.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const scriptJs = readFileSync(join(publicDir, 'script.js'), 'utf8');
const homeJs = readFileSync(join(publicDir, 'home.js'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

test('skip-to-content link is the first body child and targets the Story section', () => {
  const bodyStart = indexHtml.indexOf('<body>');
  assert.ok(bodyStart > -1, '<body> exists');
  const skipMatch = indexHtml
    .slice(bodyStart)
    .match(/<body>\s*<a\b[^>]*\bclass="[^"]*skip-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  assert.ok(skipMatch, 'a skip-link must be the first element inside <body>');
  assert.match(skipMatch[0], /href="#story"/, 'skip-link must target the first main content section (#story)');
  assert.equal(
    skipMatch[1].trim(),
    'Skip to content',
    'skip-link must read "Skip to content" so keyboard users skip to content'
  );
  assert.ok(/\bid="story"/.test(indexHtml), '#story target must exist');
});

test('Home main sections follow the approved order: story, gallery preview, books preview, testimonials, contact', () => {
  // After the hero the first <main> section is the full Story, then the
  // six-artwork Gallery preview, then books preview, testimonials, and contact.
  const mainMatch = indexHtml.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  assert.ok(mainMatch, '<main> must exist');
  const main = mainMatch[1];
  const ids = ['story', 'gallery', 'books-preview', 'testimonials', 'contact'];
  let last = -1;
  for (const id of ids) {
    const idx = main.indexOf(`id="${id}"`);
    assert.ok(idx > -1, `section #${id} must exist in <main>`);
    assert.ok(idx > last, `section #${id} must appear after the previous approved section`);
    last = idx;
  }
});

test('primary navigation exposes an accessible name', () => {
  const nav = indexHtml.match(/<nav\b[^>]*\bclass="[^"]*topbar[^"]*"[^>]*>/i);
  assert.ok(nav, 'nav.topbar exists');
  assert.match(nav[0], /aria-label="Primary navigation"/, 'nav must be labelled');
});

test('unified focus-visible indicator layers accent + on-accent across controls', () => {
  const block = stylesCss.match(/\.button:focus-visible[\s\S]*?\{([^}]*)\}/);
  assert.ok(block, 'a single unified focus-visible declaration block must exist');
  const body = block[1];
  assert.match(body, /outline:\s*3px solid var\(--accent\)/, 'uses the accent outline');
  assert.match(
    body,
    /box-shadow:\s*0 0 0 2px var\(--on-accent\)/,
    'layers an on-accent halo so the ring stays visible on accent-filled controls'
  );
  for (const sel of [
    '.button:focus-visible',
    '.dialog-close:focus-visible',
    '.filter-chip:focus-visible',
    '.back-to-top:focus-visible',
    '.topbar a:focus-visible',
    'input:focus-visible',
    'textarea:focus-visible'
  ]) {
    assert.ok(stylesCss.includes(sel), `${sel} must be in the unified selector list`);
  }
});

test('mobile nav disclosure control and menu links meet a 44px minimum target height', () => {
  // On narrow screens the inline .topbar-links are hidden and the native
  // <details> disclosure becomes the single mobile menu. The summary and every
  // menu link must each meet the 44px target minimum.
  for (const sel of ['.site-nav-summary', '.site-nav-menu a']) {
    const body = ruleBody(stylesCss, sel);
    assert.ok(body, `${sel} rule must exist`);
    const m = body.match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
    assert.ok(m, `${sel} must declare a min-height`);
    assert.ok(Number(m[1]) >= 44, `${sel} min-height must be >= 44px (got ${m[1]}px)`);
  }
  // The disclosure menu links use flex to centre content, like the inline links.
  const menuLink = ruleBody(stylesCss, '.site-nav-menu a');
  assert.match(menuLink, /display:\s*flex/, 'menu link must use flex to centre content');
});

test('viewport meta enables viewport-fit=cover for iOS safe areas', () => {
  const vp = indexHtml.match(/<meta\s+name="viewport"\s+content="([^"]*)">/i);
  assert.ok(vp, 'viewport meta must exist');
  assert.match(vp[1], /viewport-fit=cover/, 'viewport must include viewport-fit=cover');
});

test('reduced-motion CSS neutralizes hover translate on buttons and cards', () => {
  const mq = stylesCss.match(
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\}\s*\}\s*$/
  );
  assert.ok(mq, 'reduced-motion media block must exist');
  const block = mq[1];
  assert.match(
    block,
    /\.button:hover[\s\S]*?transform:\s*none/,
    'button hover translate must be neutralized under reduced motion'
  );
  assert.match(
    block,
    /\.painting-card:hover[\s\S]*?transform:\s*none/,
    'card hover translate must be neutralized under reduced motion'
  );
});

test('dedicated-page enquiry uses the existing mailto semantics (no scroll to a missing #contact)', () => {
  // The Gallery page's dialog inquiry builds a mailto via the shared
  // gallery-display.js#buildInquiryMailto (the same address/shape the Home
  // contact form uses) instead of scrolling to a #contact section that does
  // not exist on the dedicated page.
  assert.match(scriptJs, /from '\.\/gallery-display\.js'/, 'gallery script imports the display helpers');
  assert.match(scriptJs, /buildInquiryMailto/, 'gallery script uses the shared mailto builder');
  assert.match(
    scriptJs,
    /dialogInquire\.addEventListener\(\s*['"]click['"][\s\S]*?buildInquiryMailto/,
    'the dialog inquire action calls buildInquiryMailto'
  );
  // No smooth-scroll to a local contact section on the Gallery page.
  assert.doesNotMatch(scriptJs, /scrollIntoView/, 'no scrollIntoView on the dedicated gallery page');
  // Reduced-motion scrolling for Back to Top lives once in the shared module.
  const backToTopJs = readFileSync(join(publicDir, 'back-to-top.js'), 'utf8');
  assert.match(backToTopJs, /prefers-reduced-motion: reduce/);
});

test('dialog keeps Tab focus cycling within its visible enabled controls', () => {
  assert.match(scriptJs, /DIALOG_FOCUSABLE_SELECTOR/, 'a focusable selector constant must exist');
  assert.match(
    scriptJs,
    /a\[href\], button:not\(\[disabled\]\), textarea:not\(\[disabled\]\), input:not\(\[disabled\]\), select:not\(\[disabled\]\), \[tabindex\]:not\(\[tabindex="-1"\]\)/,
    'the focusable selector must cover standard focusable controls'
  );
  assert.match(
    scriptJs,
    /dialog\.addEventListener\(\s*['"]keydown['"]/,
    'a keydown listener must be attached to the dialog'
  );
  assert.match(scriptJs, /event\.key !== ['"]Tab['"]/, 'handler must gate on the Tab key');
  assert.match(scriptJs, /event\.shiftKey/, 'handler must branch on Shift+Tab');
  assert.match(scriptJs, /first\.focus\(\)/, 'handler must move focus to the first control');
  assert.match(scriptJs, /last\.focus\(\)/, 'handler must move focus to the last control');
  assert.match(scriptJs, /event\.preventDefault\(\)/, 'handler must preventDefault when wrapping');
});

test('contact form is labelled by its heading and exposes a polite status region', () => {
  assert.ok(/\bid="contact-heading"/.test(indexHtml), 'contact heading must carry an id');
  const form = indexHtml.match(/<form\b[^>]*\bid="inquiry-form"[^>]*>/i);
  assert.ok(form, 'inquiry form must exist');
  assert.match(
    form[0],
    /aria-labelledby="contact-heading"/,
    'form must be labelled by the contact heading'
  );
  const status = indexHtml.match(/<(?:p|div|span)\b[^>]*\bid="contact-status"[^>]*>/i);
  assert.ok(status, 'a #contact-status region must exist');
  assert.match(
    status[0],
    /aria-live="polite"|role="status"/,
    'status region must be polite'
  );
});

test('submit handler announces the mailto handoff before navigating', () => {
  // The contact form lives on the Home page; home.js wires it.
  assert.match(
    homeJs,
    /contactStatus\.textContent\s*=\s*['"]Opening your email app\.\.\.['"]/,
    'must set the status message before the mailto handoff'
  );
  const statusIdx = homeJs.indexOf('Opening your email app');
  const mailtoIdx = homeJs.indexOf('window.location.href = buildInquiryMailto');
  assert.ok(
    statusIdx > -1 && mailtoIdx > -1 && statusIdx < mailtoIdx,
    'status must be set before the mailto navigation'
  );
});

test('noscript mailto fallback reuses the public contact email and stays unobtrusive', () => {
  const ns = indexHtml.match(/<noscript>([\s\S]*?)<\/noscript>/i);
  assert.ok(ns, 'a noscript fallback must exist');
  assert.match(
    ns[1],
    /mailto:mjdonnellan73@gmail\.com/,
    'noscript must link the existing public contact email'
  );
  assert.match(
    ns[1],
    /contact-noscript/,
    'noscript fallback must use the unobtrusive contact-noscript style'
  );
  assert.ok(
    /contact-noscript\s*\{[^}]*font-size:\s*0\.9rem/.test(stylesCss),
    'contact-noscript must render small/muted'
  );
});

test('--on-accent token is defined and used on accent-filled controls', () => {
  const root = ruleBody(stylesCss, ':root');
  assert.ok(root, ':root rule must exist');
  assert.match(root, /--on-accent:\s*#fff8f4/, '--on-accent must map to the existing #fff8f4');
  const primary = ruleBody(stylesCss, '.button-primary');
  assert.ok(primary);
  assert.match(primary, /color:\s*var\(--on-accent\)/, 'button-primary must use --on-accent');
  const pressed = stylesCss.match(/\.filter-chip\[aria-pressed="true"\]\s*\{([^}]*)\}/);
  assert.ok(pressed);
  assert.match(
    pressed[1],
    /color:\s*var\(--on-accent\)/,
    'active filter chip must use --on-accent'
  );
});

test('theme-color meta matches the page background', () => {
  assert.match(
    indexHtml,
    /<meta\s+name="theme-color"\s+content="#f8f1ea">/i,
    'theme-color meta must be #f8f1ea'
  );
});

test('gallery has explicit 3 -> 2 at 1024 -> 1 column breakpoints', () => {
  const base = ruleBody(stylesCss, '.gallery-grid');
  assert.match(base, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(
    stylesCss,
    /@media\s*\(max-width:\s*1024px\)[\s\S]*?\.gallery-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    '1024px tablet uses exactly two columns'
  );
  assert.match(
    stylesCss,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.gallery-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    'mobile uses one column'
  );
});

test('gallery media reserves deterministic natural-ratio geometry before lazy images load', () => {
  const media = ruleBody(stylesCss, '.painting-image');
  assert.match(media, /overflow:\s*hidden/, 'the media box keeps overflow hidden');
  // Natural artwork ratios: no forced 1/1 square. SSR emits intrinsic
  // width/height pixel attrs (derived from the physical cm dimensions) so the
  // box reserves its exact aspect-ratio before the lazy thumbnail loads.
  assert.doesNotMatch(media, /aspect-ratio:\s*1\s*\/\s*1/, 'no forced square on the media box');
  // The image keeps its natural ratio (height: auto) and is never cropped.
  const imgRule = stylesCss.match(/\.painting-image img,\s*\.dialog-image img\s*\{([^}]*)\}/);
  assert.ok(imgRule, 'a shared painting/dialog image rule must exist');
  assert.match(imgRule[1], /height:\s*auto/, 'the image keeps its natural ratio (height:auto)');
  assert.doesNotMatch(imgRule[1], /object-fit:\s*cover/, 'no crop: never object-fit cover');
});

test('testimonials hold exactly one genuine card (no empty/permission placeholder)', () => {
  assert.doesNotMatch(indexHtml, /Add a short quote|Add another line/i);
  // The single genuine Jenny testimonial remains; the permission empty card
  // was removed with the micro-adjustment.
  assert.doesNotMatch(indexHtml, /testimonials-empty/);
  assert.equal(
    indexHtml.includes('Additional testimonials will be shared here only with permission'),
    false
  );
  const quotes = indexHtml.match(/<blockquote>/g) || [];
  assert.equal(quotes.length, 1, 'exactly one testimonial card');
  assert.match(indexHtml, /<cite>Jenny<\/cite>/);
});

test('public page links the self-hosted SVG favicon and has no inline styles', () => {
  assert.match(indexHtml, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.doesNotMatch(indexHtml, /\sstyle=/, 'strict style CSP needs no inline allowance');
});
