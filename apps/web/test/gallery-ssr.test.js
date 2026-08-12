import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderArtworkCard,
  renderArtworkCards,
  renderArtworkPreviewCard,
  renderArtworkPreviewCards,
  formatPriceDisplay,
  formatDimensionsDisplay,
  escapeHtml,
  escapeAttribute
} from '../src/gallery-ssr.js';
import * as clientDisplay from '../public/gallery-display.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A minimal projected public record (no catalogNumber/sortOrder/provenance).
function publicRecord(overrides = {}) {
  return {
    id: 'mj-001',
    category: 'catalogue',
    title: 'Still Waters',
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg',
    medium: 'Acrylic pouring paint',
    dimensions: { widthCm: 20, heightCm: 20, label: '20x20 cm', orientation: 'Square' },
    sizeCategory: '20x20',
    availability: 'Available',
    price: { amount: 40, currency: 'AUD', note: 'postage extra' },
    cardNote: '$40 (postage extra)',
    description: 'A painting.',
    containImage: false,
    ...overrides
  };
}

// Extract every data-* attribute value from a card fragment.
function dataAttr(card, name) {
  const re = new RegExp(`data-${name}="([^"]*)"`);
  const m = card.match(re);
  return m ? m[1] : undefined;
}

test('renderArtworkCard exposes only public data attributes', () => {
  const card = renderArtworkCard(publicRecord());
  for (const attr of ['title', 'medium', 'size', 'price', 'availability', 'description', 'image', 'size-category', 'category']) {
    assert.ok(card.includes(`data-${attr}="`), `card carries data-${attr}`);
  }
});

test('renderArtworkCard never leaks internal-only fields', () => {
  // Even when the input accidentally carries internal fields, the rendered card
  // must not emit them.
  const leaked = publicRecord({
    catalogNumber: 'MJ-001',
    sortOrder: 7,
    provenance: { source: 'google-drive', sha256: 'a'.repeat(64), driveFileId: 'DRIVE-XYZ' }
  });
  const card = renderArtworkCard(leaked);
  assert.equal(card.includes('catalogNumber'), false);
  assert.equal(card.includes('sortOrder'), false);
  assert.equal(card.includes('provenance'), false);
  assert.equal(card.includes('sha256'), false);
  assert.equal(card.includes('driveFileId'), false);
  assert.equal(card.includes('DRIVE-XYZ'), false);
  assert.equal(card.includes('google-drive'), false);
});

test('renderArtworkCard uses the thumbnail for the card image and full image for the dialog', () => {
  const r = publicRecord({
    image: '/artwork-uploaded/artwork/catalog/mj-001/full.jpg',
    thumbnail: '/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg'
  });
  const card = renderArtworkCard(r);
  // The visible <img> src is the thumbnail...
  assert.ok(card.includes(`<img src="/artwork-uploaded/artwork/catalog/mj-001/thumb.jpg"`));
  // ...and the dialog's data-image is the full derivative.
  assert.equal(dataAttr(card, 'image'), '/artwork-uploaded/artwork/catalog/mj-001/full.jpg');
  // The full path must not also be the card img src.
  assert.equal(card.includes('src="/artwork-uploaded/artwork/catalog/mj-001/full.jpg"'), false);
});

test('renderArtworkCard marks the thumbnail lazy and async-decoded', () => {
  const card = renderArtworkCard(publicRecord());
  assert.ok(card.includes('loading="lazy"'));
  assert.ok(card.includes('decoding="async"'));
});

test('renderArtworkCard escapes attribute and body text safely', () => {
  const r = publicRecord({ title: 'A "B" <C> & D' });
  const card = renderArtworkCard(r);
  // Attributes use full attribute escaping (quotes neutralised).
  const titleAttr = dataAttr(card, 'title');
  assert.equal(titleAttr, 'A &quot;B&quot; &lt;C&gt; &amp; D');
  // Body text uses HTML escaping (& < >) but leaves quotes intact.
  assert.ok(card.includes('<h3>A "B" &lt;C&gt; &amp; D</h3>'));
  // No raw double quote survives inside the title attribute region.
  const titleRegion = card.match(/data-title="[^"]*"/)[0];
  assert.equal(titleRegion.includes('"B"'), false);
  // No raw angle brackets anywhere in the title attribute value.
  assert.equal(titleAttr.includes('<'), false);
  assert.equal(titleAttr.includes('>'), false);
});

test('renderArtworkCard formats price as A$ and dimensions with orientation', () => {
  const r = publicRecord({
    price: { amount: 40, currency: 'AUD', note: 'postage extra' },
    dimensions: { widthCm: 40, heightCm: 30, orientation: 'Horizontal' }
  });
  const card = renderArtworkCard(r);
  assert.equal(dataAttr(card, 'price'), 'A$40 (postage extra)');
  assert.equal(dataAttr(card, 'size'), '40 x 30 cm · Horizontal');
});

test('renderArtworkCard shows price (not cardNote) and status separately on the card body', () => {
  const r = publicRecord({
    price: { amount: 40, currency: 'AUD', note: null },
    cardNote: '$40 (postage extra)',
    availability: 'Sold'
  });
  const card = renderArtworkCard(r);
  // Price is shown as A$ in the body paragraph...
  assert.ok(card.includes('<p>A$40</p>'));
  // ...cardNote is never rendered to avoid a duplicate price...
  assert.equal(card.includes('postage extra'), false);
  // ...and status is a separate span.
  assert.ok(card.includes('<span>Sold</span>'));
});

test('renderArtworkCard falls back to Price on enquiry and safe placeholders', () => {
  const card = renderArtworkCard(publicRecord({ price: null, medium: null, title: '' }));
  assert.equal(dataAttr(card, 'price'), 'Price on enquiry');
  assert.equal(dataAttr(card, 'medium'), 'Not specified');
  assert.equal(dataAttr(card, 'title'), 'Artwork');
});

test('renderArtworkCard applies the contain-image class when requested', () => {
  const normal = renderArtworkCard(publicRecord({ containImage: false }));
  const contained = renderArtworkCard(publicRecord({ containImage: true }));
  assert.ok(normal.includes('class="painting-image"'));
  assert.ok(contained.includes('class="painting-image painting-image-contained"'));
});

test('containImage contract: false/true render distinct classes; CSS never crops (natural ratio)', () => {
  const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  // SSR still emits a distinct class per mode (the public projection carries
  // the artist's containImage flag, preserved verbatim from the catalogue).
  const normal = renderArtworkCard(publicRecord({ containImage: false }));
  const contained = renderArtworkCard(publicRecord({ containImage: true }));
  assert.ok(!normal.includes('painting-image-contained'), 'default card omits the contained class');
  assert.ok(contained.includes('painting-image-contained'), 'containImage card carries the contained class');
  assert.notEqual(normal, contained, 'the two modes must produce different markup');
  // Natural artwork ratios / no crop: the card image keeps its own aspect
  // ratio. SSR still emits intrinsic width/height pixel attrs (derived from
  // the physical cm dimensions) so the box reserves its exact ratio before the
  // lazy thumbnail loads, and CSS renders the image with height:auto (no
  // forced square, no object-fit cover). Nothing in the painting-image rules
  // may crop.
  const imgRule = css.match(/\.painting-image img,\s*\.dialog-image img\s*\{([^}]*)\}/);
  assert.ok(imgRule, 'a shared painting/dialog image rule must exist');
  assert.match(imgRule[1], /height:\s*auto/, 'the card image keeps its natural ratio (height:auto)');
  assert.doesNotMatch(imgRule[1], /object-fit:\s*cover/, 'no crop: never object-fit cover');
  assert.doesNotMatch(imgRule[1], /object-fit:\s*contain/, 'no crop: never object-fit contain either');
  // No painting-image rule of any kind crops.
  assert.doesNotMatch(css, /\.painting-image[^{]*\{[^}]*object-fit:\s*cover/);
  // The reserved box keeps overflow hidden so off-ratio overflow is clipped
  // defensively, but the image itself is never forced into a square.
  const box = css.match(/\.painting-image\s*\{([^}]*)\}/);
  assert.ok(box);
  assert.match(box[1], /overflow:\s*hidden/, 'the media box keeps overflow hidden');
  assert.doesNotMatch(box[1], /aspect-ratio:\s*1\s*\/\s*1/, 'no forced 1/1 square on the media box');
});

test('renderArtworkCard never emits the More works placeholder', () => {
  const cards = renderArtworkCards([publicRecord()]);
  assert.equal(cards.includes('More works'), false);
  assert.equal(cards.includes('painting-card-placeholder'), false);
});

test('renderArtworkCards returns empty string for empty/absent input', () => {
  assert.equal(renderArtworkCards([]), '');
  assert.equal(renderArtworkCards(undefined), '');
  assert.equal(renderArtworkCards(null), '');
});

test('renderArtworkCards joins multiple cards with blank-line separators', () => {
  const html = renderArtworkCards([
    publicRecord({ id: 'mj-001', title: 'One' }),
    publicRecord({ id: 'mj-002', title: 'Two' })
  ]);
  const articleCount = (html.match(/<article class="painting-card"/g) || []).length;
  assert.equal(articleCount, 2);
  assert.ok(html.includes('One'));
  assert.ok(html.includes('Two'));
});

test('SSR and client display helpers have price/dimension parity', () => {
  // Same inputs must produce identical output on server and client.
  const price = { amount: 99, currency: 'AUD', note: 'framed' };
  const dims = { widthCm: 50, heightCm: 25, orientation: 'Horizontal' };
  assert.equal(formatPriceDisplay(price), clientDisplay.formatPriceDisplay(price));
  assert.equal(formatPriceDisplay(null), clientDisplay.formatPriceDisplay(null));
  assert.equal(formatDimensionsDisplay(dims), clientDisplay.formatDimensionsDisplay(dims));
  assert.equal(formatDimensionsDisplay(null), clientDisplay.formatDimensionsDisplay(null));
});

test('escapeHtml and escapeAttribute neutralise HTML metacharacters', () => {
  assert.equal(escapeHtml('<>&'), '&lt;&gt;&amp;');
  assert.equal(escapeAttribute('"x"'), '&quot;x&quot;');
});

// --- Home preview cards (anchor cards linking to /gallery) -----------------

test('renderArtworkPreviewCard renders an anchor to /gallery, never a dialog button', () => {
  const card = renderArtworkPreviewCard(publicRecord());
  assert.match(card, /<a class="painting-card painting-preview-card" href="\/gallery"/);
  // A preview card opens the gallery, not a dialog: no dialog data attributes,
  // no role="button", no tabindex, no aria-haspopup.
  assert.doesNotMatch(card, /role="button"/);
  assert.doesNotMatch(card, /tabindex=/);
  assert.doesNotMatch(card, /aria-haspopup/);
  for (const attr of ['data-image', 'data-medium', 'data-size', 'data-description']) {
    assert.doesNotMatch(card, new RegExp(attr), `preview card must not carry dialog ${attr}`);
  }
});

test('renderArtworkPreviewCard exposes only public display values (title, price, status, thumb)', () => {
  const r = publicRecord({ title: 'A "B" <C>' });
  const card = renderArtworkPreviewCard(r);
  // Title is escaped into the accessible label and the visible heading.
  assert.match(card, /aria-label="View A &quot;B&quot; &lt;C&gt; in the gallery"/);
  assert.match(card, /<h3>A "B" &lt;C&gt;<\/h3>/);
  // Thumbnail is the lazy-loaded image; no internal fields leak.
  assert.match(card, /<img src="\/artwork-uploaded\/artwork\/catalog\/mj-001\/thumb\.jpg"/);
  assert.match(card, /loading="lazy"/);
  assert.match(card, /decoding="async"/);
  for (const needle of ['catalogNumber', 'sortOrder', 'provenance', 'sha256', 'driveFileId']) {
    assert.equal(card.includes(needle), false, `preview card must not leak ${needle}`);
  }
});

test('renderArtworkPreviewCard reserves the natural aspect ratio via intrinsic width/height attrs', () => {
  const r = publicRecord({
    dimensions: { widthCm: 40, heightCm: 30, orientation: 'Horizontal' }
  });
  const card = renderArtworkPreviewCard(r);
  // Long edge (40cm) -> 600px; 30cm -> 450px. Attrs reserve the natural ratio.
  assert.match(card, /width="600" height="450"/);
});

test('renderArtworkPreviewCards returns empty string for empty/absent input and joins many', () => {
  assert.equal(renderArtworkPreviewCards([]), '');
  assert.equal(renderArtworkPreviewCards(undefined), '');
  assert.equal(renderArtworkPreviewCards(null), '');
  const html = renderArtworkPreviewCards([
    publicRecord({ id: 'mj-001', title: 'One' }),
    publicRecord({ id: 'mj-002', title: 'Two' })
  ]);
  const anchorCount = (html.match(/<a class="painting-card painting-preview-card"/g) || []).length;
  assert.equal(anchorCount, 2);
  assert.ok(html.includes('One'));
  assert.ok(html.includes('Two'));
});
