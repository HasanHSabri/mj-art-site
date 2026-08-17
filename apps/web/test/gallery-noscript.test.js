import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { toPublicList } from '../src/artwork-schema.js';
import { renderArtworkCards, SSR_FEATURED_COUNT } from '../src/gallery-ssr.js';
import { FEATURED_COUNT } from '../public/gallery-display.js';
import { CONTENT_SECURITY_POLICY } from '../src/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const galleryHtml = readFileSync(resolve(publicDir, 'gallery.html'), 'utf8');
const scriptJs = readFileSync(resolve(publicDir, 'script.js'), 'utf8');
const noscriptCssPath = resolve(publicDir, 'gallery-noscript.css');
const catalog = JSON.parse(readFileSync(resolve(here, '../../../catalog/catalog.json'), 'utf8'));

function extractCards(html) {
  return html.match(/<article class="painting-card"[\s\S]*?<\/article>/g) || [];
}

// ===========================================================================
// 1. The no-JS stylesheet is external, self-hosted, and narrowly scoped
// ===========================================================================

test('gallery.html loads the no-JS restore stylesheet from a self-hosted <noscript> link', () => {
  const ns = galleryHtml.match(/<noscript>([\s\S]*?)<\/noscript>/);
  assert.ok(ns, 'gallery.html carries a <noscript> block');
  // The ONLY content is the external stylesheet link: no visitor note/copy,
  // no inline style, no script (strict CSP keeps style-src/script-src clean).
  assert.match(
    ns[1],
    /<link rel="stylesheet" href="\/gallery-noscript\.css\?v=[\w-]+">/,
    'the noscript loads /gallery-noscript.css with a cache-busting query'
  );
  const stripped = ns[1].replace(/<link rel="stylesheet"[^>]*>/, '').trim();
  assert.equal(stripped, '', 'the noscript contains nothing but the stylesheet link');
  assert.doesNotMatch(ns[1], /style\s*=|<style|<script/i, 'no inline style/script in noscript');
  // Self-hosted: root-relative same-origin href, never an external origin.
  const href = ns[1].match(/href="([^"]+)"/)[1];
  assert.match(href, /^\//, 'the noscript href is same-origin (CSP style-src \'self\')');
});

test('the noscript stylesheet exists as a Wrangler-served public asset', () => {
  assert.equal(existsSync(noscriptCssPath), true, 'public/gallery-noscript.css exists (assets.directory serves it at /gallery-noscript.css)');
});

test('the noscript CSS restores exactly the hidden SSR cards and nothing else', () => {
  const css = readFileSync(noscriptCssPath, 'utf8');
  const rule = css.match(/#gallery-grid \.painting-card\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(rule, 'a rule scoped to #gallery-grid .painting-card[hidden] exists');
  // Author !important beats the shared .painting-card[hidden] { display:none }
  // author rule in styles.css; block is the natural grid-child display.
  assert.match(rule[1], /display:\s*block\s*!important/, 'display:block !important override');
  // No layout surgery beyond the one scoped rule: strip comments, then the
  // file must contain exactly the single override and nothing else.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.equal(code, '#gallery-grid .painting-card[hidden] {\n  display: block !important;\n}');
  assert.doesNotMatch(code, /grid-template|aspect-ratio|@media/i, 'no grid/ratio/media rules');
});

// ===========================================================================
// 2. Strict CSP is untouched: no inline style anywhere on the page
// ===========================================================================

test('gallery.html uses no inline style attribute or <style> element (strict CSP holds)', () => {
  assert.doesNotMatch(galleryHtml, /style\s*=\s*["']/, 'no style="" attribute');
  assert.doesNotMatch(galleryHtml, /<style[\s>]/, 'no <style> element');
  assert.doesNotMatch(galleryHtml, /<script[^>]*>(?!\s*<\/)/, 'every script tag is external, none carries a body');
});

test('the CSP is unchanged and still forbids inline styles', () => {
  assert.match(CONTENT_SECURITY_POLICY, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval|\*/);
});

// ===========================================================================
// 3. Complete SSR no-JS restoration: every card 11-86 re-displayed
// ===========================================================================

test('the noscript selector covers every SSR-hidden card (complete no-JS catalogue)', () => {
  const html = renderArtworkCards(toPublicList(catalog), SSR_FEATURED_COUNT);
  const cards = extractCards(html);
  assert.equal(cards.length, 86, 'the full catalogue is server-rendered');
  const hiddenCards = cards.filter((c) => /\shidden>/.test(c));
  assert.equal(hiddenCards.length, 86 - SSR_FEATURED_COUNT, 'cards 11-86 (indexes 10-85) are hidden');
  // Every hidden card is exactly a .painting-card inside the SSR grid marker,
  // i.e. in scope of `#gallery-grid .painting-card[hidden]` -> all restored.
  for (const card of hiddenCards) {
    assert.match(card, /class="painting-card"/);
    assert.match(card, /\shidden>/);
  }
  // The first 10 (Featured window) are un-hidden and therefore unaffected.
  for (let i = 0; i < SSR_FEATURED_COUNT; i++) {
    assert.doesNotMatch(cards[i], /\shidden>/, `featured card ${i} renders un-hidden`);
  }
  // The SSR fragment is injected inside <div id="gallery-grid">, so the
  // selector's #gallery-grid ancestor holds for the composed page.
  const gridOpen = galleryHtml.match(/<div class="gallery-grid" id="gallery-grid">/);
  assert.ok(gridOpen, 'the SSR marker lives inside #gallery-grid');
});

// ===========================================================================
// 4. JS-enabled behaviour unchanged: Featured no-flash + client hidden toggle
// ===========================================================================

test('the noscript stylesheet is never applied to JS visitors', () => {
  // Referenced only inside <noscript>; JS-enabled browsers skip noscript content.
  const outside = galleryHtml.replace(/<noscript>[\s\S]*?<\/noscript>/, '');
  assert.doesNotMatch(outside, /gallery-noscript/, 'no reference outside <noscript>');
  // The JS reveal contract is intact: the client still toggles card.hidden.
  assert.match(scriptJs, /card\.hidden = !visibility\[index\];/);
  // SSR/client featured parity keeps the no-flash first paint exact.
  assert.equal(SSR_FEATURED_COUNT, FEATURED_COUNT);
  assert.equal(SSR_FEATURED_COUNT, 10);
});
