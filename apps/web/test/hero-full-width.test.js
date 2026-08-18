// Full-width hero contract for the Gallery and Books pages: the outer hero
// surface spans the full content width (the obsolete 60ch cap and the grid
// companion gap are gone), while the copy keeps a readable internal measure
// (~62-70ch). The shared <=960px single-column collapse stays coherent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const galleryCss = readFileSync(join(publicDir, 'gallery.css'), 'utf8');
const booksCss = readFileSync(join(publicDir, 'books.css'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

for (const [page, css, selector] of [
  ['Gallery', galleryCss, '.gallery-hero-content'],
  ['Books', booksCss, '.books-hero-content']
]) {
  test(`${page}: the outer hero surface spans the full content width (no 60ch cap, single track)`, () => {
    const rule = ruleBody(css, `${selector}\\s*\\{(?![^}]*max-width)`) || ruleBody(css, selector);
    assert.ok(rule, `${selector} rule must exist`);
    const body = ruleBody(css, selector);
    assert.match(body, /grid-template-columns:\s*1fr/, 'one full-width track: no companion column or gap');
    assert.doesNotMatch(body, /max-width:\s*60ch/, 'the obsolete 60ch outer cap must be gone');
    assert.doesNotMatch(body, /max-width:\s*\d+ch/, 'no outer ch cap at all');
  });

  test(`${page}: the hero copy keeps a readable internal measure of 62-70ch`, () => {
    const measure = ruleBody(css, `${selector} .hero-text`);
    assert.ok(measure, 'an internal measure rule must exist');
    assert.match(measure, /max-width:\s*6[2-9]ch/, 'the internal copy measure stays in the 62-70ch band');
  });
}

test('both heroes keep the shared <=960px single-column collapse coherent', () => {
  // The shared sheet already collapses .hero-content to one column at 960px;
  // the page-local sheets keep their own 1fr collapse in the same breakpoint.
  const books = booksCss.indexOf('@media (max-width: 960px)');
  assert.notEqual(books, -1, 'Books keeps a 960px breakpoint');
  const booksBlock = booksCss.slice(books, booksCss.indexOf('@media', books + 1));
  assert.match(booksBlock, /\.books-hero-content\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(stylesCss, /@media \(max-width: 960px\)[\s\S]*?\.hero-content[\s\S]*?grid-template-columns:\s*1fr/);
});
