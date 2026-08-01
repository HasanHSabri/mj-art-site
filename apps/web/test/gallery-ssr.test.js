import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderArtworkCard,
  renderArtworkCards,
  formatPriceDisplay,
  formatDimensionsDisplay,
  escapeHtml,
  escapeAttribute
} from '../src/gallery-ssr.js';
import * as clientDisplay from '../public/gallery-display.js';

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
