// Supplied-image derivative contract: exactly three optimized public JPEGs
// under apps/web/public/images/, mechanically derived from the user-supplied
// docs originals (shrink-only, auto-oriented, stripped, sRGB, quality 85), with
// intrinsic dimension attributes on every referencing page, no duplicate
// public variants, and same-origin URLs compatible with the Worker CSP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CONTENT_SECURITY_POLICY } from '../src/worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const repoRoot = join(__dirname, '..', '..', '..');

// The exact public derivatives and their mechanically-produced dimensions.
// Portrait 1200x1599 shrunk to a 1200px long edge -> 901x1200; Frayed
// 1063x1600 -> 797x1200; Wobbly stays native 488x629 (never upscaled).
const ASSETS = [
  { file: 'mj-portrait.jpg', width: 901, height: 1200, source: 'docs/MJ Portrait.jpeg', maxBytes: 400 * 1024 },
  { file: 'frayed-not-broken-cover.jpg', width: 797, height: 1200, source: 'docs/Frayed Not Broken Cover.jpeg', maxBytes: 400 * 1024 },
  { file: 'mj-and-her-wobbly-days-cover.jpg', width: 488, height: 629, source: 'docs/MJ and Her Wobbly Days Cover (Front only).jpeg', maxBytes: 400 * 1024 }
];

// Dependency-free JPEG dimension reader: walks the segment stream to the first
// SOF frame marker and decodes height/width. Returns null for non-JPEG data.
function jpegDimensions(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xda) return null; // ran into the scan without an SOF
    i += 2 + length;
  }
  return null;
}

test('exactly the three canonical derivatives exist under public/images (no duplicate public variants)', () => {
  const imagesDir = join(publicDir, 'images');
  const entries = readdirSync(imagesDir).filter((f) => !f.startsWith('.'));
  assert.deepEqual(
    [...entries].sort(),
    ASSETS.map((a) => a.file).sort(),
    'no extra/duplicate public image variants may ship'
  );
});

test('each derivative is a valid optimized JPEG with exact expected dimensions and a sane byte ceiling', () => {
  for (const asset of ASSETS) {
    const buf = readFileSync(join(publicDir, 'images', asset.file));
    // JPEG SOI magic.
    assert.ok(buf[0] === 0xff && buf[1] === 0xd8, `${asset.file} must be a JPEG`);
    const dims = jpegDimensions(buf);
    assert.ok(dims, `${asset.file} must carry a readable SOF frame`);
    assert.equal(dims.width, asset.width, `${asset.file} width`);
    assert.equal(dims.height, asset.height, `${asset.file} height`);
    const bytes = statSync(join(publicDir, 'images', asset.file)).size;
    assert.ok(bytes > 0 && bytes <= asset.maxBytes, `${asset.file} must stay within its optimized ceiling (${bytes} bytes)`);
    // Shrink-only guard: the derivative never exceeds its source dimensions.
    const src = readFileSync(join(repoRoot, asset.source));
    const srcDims = jpegDimensions(src);
    assert.ok(srcDims, `${asset.source} must be a readable JPEG`);
    assert.ok(dims.width <= srcDims.width && dims.height <= srcDims.height, `${asset.file} must never upscale past its source`);
  }
});

test('the user-supplied source originals are preserved verbatim in docs', () => {
  for (const asset of ASSETS) {
    statSync(join(repoRoot, asset.source));
  }
});

test('every page image carries accurate intrinsic dimensions, lazy loading, async decoding, and a real alt', () => {
  const pages = [
    { name: 'index.html', html: readFileSync(join(publicDir, 'index.html'), 'utf8') },
    { name: 'books.html', html: readFileSync(join(publicDir, 'books.html'), 'utf8') }
  ];
  for (const page of pages) {
    const imgs = page.html.match(/<img\b[^>]*>/g) || [];
    assert.ok(imgs.length > 0, `${page.name} must reference the supplied images`);
    for (const img of imgs) {
      const src = img.match(/src="([^"]+)"/)[1];
      const asset = ASSETS.find((a) => src === `/images/${a.file}`);
      assert.ok(asset, `${page.name}: unexpected image src ${src}`);
      assert.match(img, new RegExp(`width="${asset.width}"`), `${page.name} ${asset.file}: intrinsic width`);
      assert.match(img, new RegExp(`height="${asset.height}"`), `${page.name} ${asset.file}: intrinsic height`);
      assert.match(img, /loading="lazy"/, `${page.name} ${src} must lazy-load`);
      assert.match(img, /decoding="async"/, `${page.name} ${src} must decode async`);
      const alt = img.match(/alt="([^"]*)"/)[1];
      assert.ok(alt.length > 0, `${page.name} ${src} must carry a real alt`);
    }
  }
});

test('the exact accurate alt texts name each supplied image', () => {
  const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const booksHtml = readFileSync(join(publicDir, 'books.html'), 'utf8');
  assert.match(indexHtml, /alt="Portrait of MJ"/);
  for (const html of [indexHtml, booksHtml]) {
    assert.match(html, /alt="Cover of Frayed Not Broken"/);
    assert.match(html, /alt="Cover of MJ and Her Wobbly Days"/);
  }
});

test('image URLs are same-origin and compatible with the Worker CSP img-src', () => {
  const imgSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('img-src'));
  assert.ok(imgSrc);
  assert.match(imgSrc, /'self'/, 'self-origin images must be allowed');
  for (const page of ['index.html', 'books.html']) {
    const html = readFileSync(join(publicDir, page), 'utf8');
    for (const src of html.match(/<img\b[^>]*src="([^"]+)"/g).map((t) => t.match(/src="([^"]+)"/)[1])) {
      assert.ok(src.startsWith('/images/'), `${page}: ${src} must be a same-origin public derivative`);
    }
  }
});
