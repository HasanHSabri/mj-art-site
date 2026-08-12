import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderArtworkCard } from '../src/gallery-ssr.js';
import { buildInquiryMailto } from '../public/gallery-display.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const galleryHtml = readFileSync(join(publicDir, 'gallery.html'), 'utf8');
const scriptJs = readFileSync(join(publicDir, 'script.js'), 'utf8');

function publicRecord(overrides = {}) {
  return {
    id: 'mj-001',
    category: 'catalogue',
    title: 'Still Waters',
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg',
    medium: 'Acrylic pouring paint',
    dimensions: { widthCm: 40, heightCm: 30, label: '40x30 cm', orientation: 'Horizontal' },
    sizeCategory: '40x30',
    availability: 'Available',
    price: { amount: 90, currency: 'AUD', note: 'framed' },
    description: 'A painting.',
    containImage: false,
    ...overrides
  };
}

// --- The dedicated Gallery page retains the modal (dialog) ---------------

test('gallery page markup carries the full painting dialog with all its hooks', () => {
  for (const id of [
    'painting-dialog',
    'dialog-close',
    'dialog-title',
    'dialog-medium',
    'dialog-size',
    'dialog-price',
    'dialog-availability',
    'dialog-description',
    'dialog-image',
    'dialog-inquire'
  ]) {
    assert.ok(new RegExp(`\\bid="${id}"`).test(galleryHtml), `gallery page must carry #${id}`);
  }
  assert.match(galleryHtml, /<dialog\b[^>]*\baria-labelledby="dialog-title"/);
});

// --- Lazy thumbnail / full-image split is retained -----------------------

test('SSR gallery cards keep the lazy thumbnail in the img and the full image in data-image', () => {
  const card = renderArtworkCard(publicRecord());
  // Visible img is the thumb; lazy + async.
  assert.match(card, /<img src="\/artwork-uploaded\/artwork\/catalog\/mj-001\/thumb\.jpg"/);
  assert.match(card, /loading="lazy"/);
  assert.match(card, /decoding="async"/);
  // Dialog data-image is the full derivative; the full path is never the img src.
  assert.match(card, /data-image="\/artwork-uploaded\/artwork\/catalog\/mj-001\/full\.jpg"/);
  assert.equal(
    card.includes('src="/artwork-uploaded/artwork/catalog/mj-001/full.jpg"'),
    false,
    'the full image is reserved for the dialog, never the card img'
  );
});

// --- Card interaction + dialog open + keyboard retained ------------------

test('gallery script wires card click + Enter/Space to open the dialog', () => {
  assert.match(scriptJs, /card\.addEventListener\(\s*['"]click['"]/);
  assert.match(scriptJs, /card\.addEventListener\(\s*['"]keydown['"]/);
  assert.match(scriptJs, /event\.key === ['"]Enter['"] \|\| event\.key === ['"] ['"]/);
  assert.match(scriptJs, /openPaintingDialog/);
  assert.match(scriptJs, /dialog\.showModal\(\)/);
});

test('gallery script fills the dialog from card data attributes and resets it on close', () => {
  assert.match(scriptJs, /dialogTitle\.textContent\s*=/);
  assert.match(scriptJs, /dialogImageElement\.src\s*=\s*image/);
  assert.match(scriptJs, /dialogClose\.addEventListener\(\s*['"]click['"][\s\S]*?dialog\.close\(\)/);
});

// --- Dedicated-page enquiry uses existing mailto semantics ---------------

test('gallery dialog inquiry builds a mailto with the painting title (existing mailto semantics)', () => {
  // The dedicated page has no contact section: the inquiry is a mailto built
  // from the same shared builder the Home contact form uses, carrying the
  // painting title, sent to the public contact address.
  assert.match(scriptJs, /CONTACT_EMAIL\s*=\s*'mjdonnellan73@gmail\.com'/);
  assert.match(
    scriptJs,
    /dialogInquire\.addEventListener\(\s*['"]click['"][\s\S]*?buildInquiryMailto\(\s*\{[\s\S]*?painting:\s*title/
  );
  // Never scrolls to a local #contact (there is none on the gallery page).
  assert.doesNotMatch(scriptJs, /getElementById\(['"]contact['"]\)/);
});

test('gallery inquiry click assigns the exact encoded mailto URL (no real mail client needed)', () => {
  // The handler assigns the builder's exact return to window.location.href.
  assert.match(
    scriptJs,
    /window\.location\.href\s*=\s*buildInquiryMailto\(\s*\{[\s\S]*?painting:\s*title[\s\S]*?\}\s*\)/,
    'the inquire click must assign the mailto URL to window.location.href'
  );
  // Reproduce the exact builder call the handler makes and assert the fully
  // encoded mailto URL byte-for-byte. This proves the click hands the browser a
  // valid mailto: with the painting title encoded, without a real mail client.
  const url = buildInquiryMailto({
    email: 'mjdonnellan73@gmail.com',
    name: '',
    customerEmail: '',
    painting: 'Still Waters',
    message: ''
  });
  assert.equal(
    url,
    'mailto:mjdonnellan73@gmail.com?subject=Painting%20inquiry%3A%20Still%20Waters&body=Hello%2C%0A%0AMy%20name%20is%20.%0AMy%20email%20is%20.%0A%0AI%20would%20like%20to%20ask%20about%3A%20Still%20Waters%0A%0A',
    'the mailto URL must be the exact, fully-encoded contract'
  );
  // The painting title is never injected raw; everything after the host is encoded.
  assert.doesNotMatch(url.slice(url.indexOf('?')), /Still Waters/, 'the title must be encoded, never raw');
});
