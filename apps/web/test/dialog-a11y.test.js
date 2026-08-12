import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
// The painting <dialog> lives on the dedicated Gallery page (Home shows only
// a 6-card preview linking to /gallery; it has no dialog).
const galleryHtml = readFileSync(join(publicDir, 'gallery.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');

test('painting dialog is named via aria-labelledby pointing at the title', () => {
  const dialogOpen = galleryHtml.match(/<dialog\b[^>]*\bid="painting-dialog"[^>]*>/i);
  assert.ok(dialogOpen, '#painting-dialog opening tag exists');
  assert.ok(
    /aria-labelledby="dialog-title"/.test(dialogOpen[0]),
    '#painting-dialog must carry aria-labelledby="dialog-title"'
  );
  assert.ok(
    /\bid="dialog-title"/.test(galleryHtml),
    'the referenced #dialog-title element must exist'
  );
});

test('dialog close control keeps an accessible name', () => {
  const close = galleryHtml.match(/<button\b[^>]*\bid="dialog-close"[^>]*>/i);
  assert.ok(close, '#dialog-close button exists');
  assert.ok(
    /aria-label="[^"]+"/.test(close[0]),
    '#dialog-close keeps a non-empty aria-label'
  );
});

test('dialog close button is compact and top-aligned, not stretched to the row', () => {
  const block = stylesCss.match(/\.dialog-close\s*\{([^}]*)\}/);
  assert.ok(block, '.dialog-close rule exists');
  const body = block[1];
  assert.ok(
    /align-self:\s*start/.test(body),
    '.dialog-close must use align-self: start to avoid stretching to the image row height'
  );
  const height = body.match(/height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(height, '.dialog-close must declare an explicit compact height');
  const px = Number(height[1]);
  assert.ok(
    px >= 40 && px <= 44,
    `.dialog-close height must be compact 40-44px (got ${px}px)`
  );
});
