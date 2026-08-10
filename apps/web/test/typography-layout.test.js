import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const adminCss = readFileSync(join(publicDir, 'admin.css'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

function fontLink() {
  const link = indexHtml.match(/<link[^>]*href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"[^>]*>/i);
  return link ? link[0] : null;
}

// --- Font loading ---

test('public site loads Hanken Grotesk weights 400/500/600 with swap', () => {
  const link = fontLink();
  assert.ok(link, 'a Google Fonts stylesheet link must exist');
  assert.match(link, /family=Hanken\+Grotesk:wght@400;500;600/);
  assert.match(link, /display=swap/);
});

test('public site no longer requests Inter', () => {
  const link = fontLink();
  assert.ok(link);
  assert.doesNotMatch(link, /family=Inter/, 'Inter must be removed from the public font request');
});

test('Cormorant Garamond is retained for brand and headings', () => {
  const link = fontLink();
  assert.ok(link);
  assert.match(link, /family=Cormorant\+Garamond:wght@400;500;600;700/);
  assert.match(stylesCss, /font-family:\s*"Cormorant Garamond",\s*serif/);
});

test('public stylesheet link is cache-busted with a version query', () => {
  assert.match(
    indexHtml,
    /<link[^>]+rel="stylesheet"[^>]+href="\.\/styles\.css\?v=[^"]+"/i,
    'styles.css link must carry a ?v= cache-bust query'
  );
});

// --- Body font role ---

test('public body uses Hanken Grotesk at 1rem/400/1.65 with subtle tracking', () => {
  const body = ruleBody(stylesCss, 'body');
  assert.ok(body, 'body rule must exist');
  assert.match(body, /font-family:\s*"Hanken Grotesk"/);
  assert.match(body, /font-size:\s*1rem/, 'body font-size must be 1rem (16px floor)');
  assert.match(body, /font-weight:\s*400/);
  assert.match(body, /line-height:\s*1\.65/);
  const ls = body.match(/letter-spacing:\s*(-?0\.\d+)em/);
  assert.ok(ls, 'body must declare a subtle letter-spacing');
  assert.ok(
    Math.abs(Number(ls[1])) <= 0.02,
    `letter-spacing must be subtle (|${ls[1]}em| <= 0.02em)`
  );
});

test('public Hanken Grotesk stack carries a sans-serif fallback', () => {
  const body = ruleBody(stylesCss, 'body');
  assert.ok(body, 'body rule must exist');
  assert.match(
    body,
    /font-family:\s*"Hanken Grotesk",\s*sans-serif/,
    'the body font stack must fall back to a generic sans-serif when Hanken Grotesk is unavailable'
  );
});

test('long-form paragraphs inherit the 16px floor (no sub-16px override)', () => {
  for (const sel of ['.hero-text', '.story-copy']) {
    const block = ruleBody(stylesCss, sel);
    if (!block) continue;
    const fs = block.match(/font-size:\s*([\d.]+)(rem|px)/);
    if (!fs) continue; // inherits body 1rem — acceptable
    const rem = fs[2] === 'rem' ? Number(fs[1]) : Number(fs[1]) / 16;
    assert.ok(rem >= 1, `${sel} must not shrink below 1rem/16px`);
  }
});

// --- Hero h1 bounds ---

test('hero h1 uses a tighter responsive clamp with near-unit line-height', () => {
  const h1 = ruleBody(stylesCss, 'h1');
  assert.ok(h1, 'an h1 rule must exist');
  const clamp = h1.match(/font-size:\s*clamp\(\s*([\d.]+)rem\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)rem\s*\)/);
  assert.ok(clamp, 'h1 must use clamp() for font-size');
  const [, minStr, vwStr, maxStr] = clamp;
  const min = Number(minStr);
  const vw = Number(vwStr);
  const max = Number(maxStr);
  assert.ok(min >= 2.6 && min <= 2.8, `clamp min ~2.75rem (got ${min}rem)`);
  assert.ok(vw === 6, `clamp preferred 6vw (got ${vw}vw)`);
  assert.ok(max >= 5.1 && max <= 5.3, `clamp max ~5.2rem (got ${max}rem)`);
  const lh = h1.match(/line-height:\s*([\d.]+)/);
  assert.ok(lh);
  const lhv = Number(lh[1]);
  assert.ok(lhv >= 0.95 && lhv <= 1.0, `line-height ~0.98 (got ${lhv})`);
  const mw = h1.match(/max-width:\s*(\d+)ch/);
  assert.ok(mw);
  const ch = Number(mw[1]);
  assert.ok(ch >= 12 && ch <= 13, `max-width 12-13ch (got ${ch}ch)`);
});

test('small-screen h1 measure is unclamped (max-width: none)', () => {
  const mq = stylesCss.match(/@media\s*\(\s*max-width:\s*640px\s*\)\s*\{([\s\S]*?)\}\s*(?=@media)/);
  assert.ok(mq, 'a 640px media block must exist');
  assert.match(
    mq[1],
    /h1\s*\{[^}]*max-width:\s*none/,
    'at small screens the h1 max-width must be removed (none) so the heading is not artificially clipped'
  );
});

// --- Type role hierarchy ---

test('primary nav links read at 0.95rem/500', () => {
  const nav = ruleBody(stylesCss, '.topbar-links');
  assert.ok(nav);
  assert.match(nav, /font-size:\s*0\.95rem/);
  assert.match(nav, /font-weight:\s*500/);
});

test('card price reads at 0.875rem/500', () => {
  const m = stylesCss.match(/\.painting-card-body\s+p\s*\{([^}]*)\}/);
  assert.ok(m, 'a standalone .painting-card-body p rule must exist');
  assert.match(m[1], /font-size:\s*0\.875rem/);
  assert.match(m[1], /font-weight:\s*500/);
});

test('availability badge reads at 0.8rem', () => {
  const m = stylesCss.match(/\.painting-card-body\s+span\s*\{([^}]*)\}/);
  assert.ok(m, '.painting-card-body span rule must exist');
  assert.match(m[1], /font-size:\s*0\.8rem/);
});

test('filter chips use weight 500', () => {
  const chip = ruleBody(stylesCss, '.filter-chip');
  assert.ok(chip);
  assert.match(chip, /font-weight:\s*500/);
});

test('section labels/eyebrows read near 0.72rem', () => {
  const block = stylesCss.match(/\.hero-card-label\s*\{([^}]*)\}/);
  assert.ok(block, 'eyebrow/section-label/hero-card-label block must exist');
  const fs = block[1].match(/font-size:\s*([\d.]+)rem/);
  assert.ok(fs);
  const v = Number(fs[1]);
  assert.ok(v >= 0.7 && v <= 0.75, `section label ~0.72rem (got ${v}rem)`);
});

test('card titles (h3) use Cormorant Garamond at weight 600', () => {
  const h3Blocks = [...stylesCss.matchAll(/(?:^|\n)\s*h3\s*\{([^}]*)\}/g)];
  const sized = h3Blocks.find((b) => /font-size/.test(b[1]));
  assert.ok(sized, 'an h3 rule carrying font-size must exist');
  assert.match(sized[1], /font-weight:\s*600/);
});

// --- Gallery 1/2/3 breakpoints ---

test('gallery keeps 3 columns on desktop by default', () => {
  const grid = ruleBody(stylesCss, '.gallery-grid');
  assert.ok(grid);
  assert.match(grid, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
});

test('gallery adds a 2-column tier at the explicit 1024px tablet breakpoint', () => {
  const mq = stylesCss.match(/@media\s*\(\s*max-width:\s*1024px\s*\)\s*\{([\s\S]*?)\}\s*(?=@media)/);
  assert.ok(mq, '1024px media block must exist');
  assert.match(
    mq[1],
    /\.gallery-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    '1024px block must set the gallery to two columns'
  );
  assert.doesNotMatch(
    mq[1],
    /\.gallery-grid\s*,/,
    'gallery must not be lumped into a 1fr collapse at 1024px'
  );
});

test('gallery drops to a single column at and below 680px', () => {
  const mq = stylesCss.match(/@media\s*\(\s*max-width:\s*680px\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(mq, 'a 680px media block must exist');
  assert.match(
    mq[1],
    /\.gallery-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    '680px block must collapse the gallery to one column'
  );
});

test('gallery breakpoint source order: 1024px precedes 680px (<=680px resolves to one column)', () => {
  const at1024 = stylesCss.search(/@media\s*\(\s*max-width:\s*1024px\s*\)/);
  const at680 = stylesCss.search(/@media\s*\(\s*max-width:\s*680px\s*\)/);
  assert.notStrictEqual(at1024, -1, 'a 1024px media block must exist');
  assert.notStrictEqual(at680, -1, 'a 680px media block must exist');
  assert.ok(
    at1024 < at680,
    'the 1024px media block must precede the 680px block so the cascade collapses the gallery to one column at <=680px'
  );
});

// --- Contact single-column measure ---

test('contact grid is a single centered column (phantom column removed)', () => {
  const grid = ruleBody(stylesCss, '.contact-grid');
  assert.ok(grid, '.contact-grid rule must exist');
  assert.match(grid, /grid-template-columns:\s*1fr/);
  assert.match(grid, /justify-items:\s*center/);
  const baseTwoCol = stylesCss.match(/\.intro-grid,\s*\.story-layout\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.ok(baseTwoCol, 'the base 2-col rule (.intro-grid, .story-layout) must still exist');
  assert.doesNotMatch(
    baseTwoCol[0],
    /contact-grid/,
    'contact-grid must no longer share the 2-column base rule'
  );
});

test('contact form keeps a readable measure of 720-760px', () => {
  const form = ruleBody(stylesCss, '.contact-form');
  assert.ok(form);
  const mw = form.match(/max-width:\s*(\d+)px/);
  assert.ok(mw, 'contact-form must declare a max-width');
  const px = Number(mw[1]);
  assert.ok(px >= 720 && px <= 760, `contact measure 720-760px (got ${px}px)`);
});

// --- Admin isolation guard ---

test('admin typography is untouched: still Inter, never Hanken Grotesk', () => {
  const body = adminCss.match(/body\s*\{([^}]*)\}/);
  assert.ok(body, 'admin body rule must exist');
  assert.match(body[1], /font-family:\s*"Inter"/);
  assert.doesNotMatch(body[1], /Hanken Grotesk/);
});
