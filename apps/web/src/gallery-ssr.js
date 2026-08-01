// Pure server-side gallery card rendering.
//
// Dependency-free, no DOM, no network. Operates only on already-projected
// public records (no catalogNumber, sortOrder, or provenance). Imported by the
// Worker for SSR; imported by node:test directly. The client never calls this.
//
// A card carries data attributes for every value the dialog needs (title,
// medium, dimensions display, formatted price, availability, description, and
// the FULL image for the dialog). The card <img> itself uses the thumbnail. No
// internal-only field is ever emitted.

const PRICE_ENQUIRY = 'Price on enquiry';
const DIMS_TBC = 'Dimensions to be confirmed';
const MEDIUM_UNSPECIFIED = 'Not specified';
const UNKNOWN_TITLE = 'Artwork';

// Format a public price object. Always AUD, prefixed A$ to disambiguate
// currency. null -> "Price on enquiry". A note is appended in parentheses.
export function formatPriceDisplay(price) {
  if (!price) return PRICE_ENQUIRY;
  const amount = `A$${price.amount}`;
  return price.note ? `${amount} (${price.note})` : amount;
}

// Format a public dimensions object as "W x H cm · Orientation", preserving the
// stored width/height order (orientation already reflects it; no rotation).
// Unknown/absent dimensions -> "Dimensions to be confirmed".
export function formatDimensionsDisplay(dimensions) {
  if (!dimensions) return DIMS_TBC;
  const { widthCm, heightCm, orientation } = dimensions;
  if (widthCm == null || heightCm == null) return DIMS_TBC;
  return `${widthCm} x ${heightCm} cm · ${orientation}`;
}

// Intrinsic width/height attributes (pixels) derived from the physical cm pair,
// scaled so the long edge is 600px. Used to reserve aspect-ratio box space and
// reduce layout shift before the lazy thumbnail loads. Returns nulls when the
// physical dimensions are unknown.
function intrinsicSize(dimensions) {
  if (!dimensions) return { width: null, height: null };
  const { widthCm, heightCm } = dimensions;
  if (widthCm == null || heightCm == null) return { width: null, height: null };
  const base = 600;
  const long = Math.max(widthCm, heightCm) || base;
  return {
    width: Math.round((widthCm / long) * base),
    height: Math.round((heightCm / long) * base)
  };
}

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

// Render a single SSR artwork card from a projected public record.
export function renderArtworkCard(artwork) {
  const title = artwork.title || UNKNOWN_TITLE;
  const medium = artwork.medium ? artwork.medium : MEDIUM_UNSPECIFIED;
  const dimensionsDisplay = formatDimensionsDisplay(artwork.dimensions);
  const priceDisplay = formatPriceDisplay(artwork.price);
  const availability = artwork.availability || '';
  const description = artwork.description || '';
  const thumbnail = artwork.thumbnail || artwork.image || '';
  const fullImage = artwork.image || artwork.thumbnail || '';
  const sizeCategory = artwork.sizeCategory || '';
  const category = artwork.category || '';

  const imageClass = artwork.containImage
    ? 'painting-image painting-image-contained'
    : 'painting-image';
  const { width, height } = intrinsicSize(artwork.dimensions);
  const sizeAttrs = width != null ? ` width="${width}" height="${height}"` : '';

  return `          <article class="painting-card" role="button" tabindex="0" aria-haspopup="dialog" aria-label="View details for ${escapeAttribute(title)}" data-title="${escapeAttribute(title)}" data-medium="${escapeAttribute(medium)}" data-size="${escapeAttribute(dimensionsDisplay)}" data-price="${escapeAttribute(priceDisplay)}" data-availability="${escapeAttribute(availability)}" data-description="${escapeAttribute(description)}" data-image="${escapeAttribute(fullImage)}" data-size-category="${escapeAttribute(sizeCategory)}" data-category="${escapeAttribute(category)}">
            <div class="${imageClass}"><img src="${escapeAttribute(thumbnail)}" alt="${escapeAttribute(title)}" loading="lazy" decoding="async"${sizeAttrs}></div>
            <div class="painting-card-body">
              <h3>${escapeHtml(title)}</h3>
              <p>${escapeHtml(priceDisplay)}</p>
              <span>${escapeHtml(availability)}</span>
            </div>
          </article>`;
}

// Render the full SSR gallery fragment (cards joined by blank lines). Empty
// input yields an empty string; the Worker renders an accessible empty state.
export function renderArtworkCards(artworks) {
  if (!Array.isArray(artworks) || artworks.length === 0) return '';
  return artworks.map(renderArtworkCard).join('\n\n');
}
