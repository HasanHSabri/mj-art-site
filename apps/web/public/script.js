// Public Gallery page client (progressive enhancement).
//
// ES module. Reads the server-rendered cards once and enhances them in place:
// builds the accessible size filter bar (with real counts), wires card/dialog
// interaction, manages the ?size=<key> query state, and powers the artwork
// inquiry mailto. It NEVER fetches /api/artworks, wipes the grid, or rebuilds
// cards. Empty SSR state (no cards) renders an accessible empty message.
//
// The dedicated Gallery page has no contact form of its own: the dialog's
// "Inquire about this painting" action uses the existing mailto semantics
// (gallery-display.js#buildInquiryMailto, the same address and shape the Home
// contact form uses) rather than scrolling to a #contact section that does not
// exist on this page.

import {
  SIZE_FILTERS,
  MISC_KEY,
  ALL_KEY,
  ALLOWED_SIZE_QUERY_VALUES,
  cardSizeKey,
  countBySize,
  filterLabel,
  isVisible,
  parseSizeQuery,
  sizeQuery,
  resultSummary,
  buildInquiryMailto
} from './gallery-display.js';
import { initBackToTop } from './back-to-top.js';

const CONTACT_EMAIL = 'mjdonnellan73@gmail.com';

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const galleryGrid = document.getElementById('gallery-grid');
const filterBar = document.getElementById('gallery-filters');
const resultsStatus = document.getElementById('gallery-results');

const dialog = document.getElementById('painting-dialog');
const dialogClose = document.getElementById('dialog-close');
const dialogTitle = document.getElementById('dialog-title');
const dialogMedium = document.getElementById('dialog-medium');
const dialogSize = document.getElementById('dialog-size');
const dialogPrice = document.getElementById('dialog-price');
const dialogAvailability = document.getElementById('dialog-availability');
const dialogDescription = document.getElementById('dialog-description');
const dialogImage = document.getElementById('dialog-image');
const dialogInquire = document.getElementById('dialog-inquire');

const dialogImageElement = document.createElement('img');
dialogImageElement.alt = '';
dialogImage.appendChild(dialogImageElement);

const cards = Array.from(galleryGrid.querySelectorAll('.painting-card'));
let activeFilter = ALL_KEY;

init();

function init() {
  // Always power Back to Top on the Gallery page.
  initBackToTop({ dialog });

  // Empty SSR state: surface an accessible empty message and stop. There is no
  // legacy/fallback data path.
  if (cards.length === 0) {
    renderEmptyState();
    return;
  }

  // Keyboard/card activation + dialog wiring on every SSR card.
  for (const card of cards) {
    card.addEventListener('click', () => openPaintingDialog(card));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPaintingDialog(card);
      }
    });
  }

  buildFilterBar();
  activeFilter = parseSizeQuery(new URLSearchParams(window.location.search).get('size'));
  applyFilter(activeFilter, false);
}

function renderEmptyState() {
  if (resultsStatus) {
    resultsStatus.textContent = 'No artworks are available yet.';
  }
  if (filterBar) filterBar.hidden = true;
}

// Build the accessible filter bar (All + 11 sizes + Miscellaneous) with real
// counts from the SSR card data attrs.
function buildFilterBar() {
  if (!filterBar) return;
  filterBar.replaceChildren();

  const cardDescriptors = cards.map((card) => ({
    category: card.dataset.category,
    sizeCategory: card.dataset.sizeCategory
  }));
  const counts = countBySize(cardDescriptors);

  const keys = [ALL_KEY, ...SIZE_FILTERS, MISC_KEY];
  for (const key of keys) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-chip';
    button.dataset.size = key;
    button.setAttribute('aria-pressed', String(key === activeFilter));
    const count = counts[key] || 0;
    button.textContent = `${filterLabel(key)} (${count})`;
    button.addEventListener('click', () => applyFilter(key, true));
    filterBar.appendChild(button);
  }
}

// Apply a size filter: toggle the `hidden` attribute on each card (no DOM
// removal/reorder), update aria-pressed on chips, refresh the live status, and
// sync the URL query via replaceState (no navigation).
function applyFilter(key, updateUrl) {
  if (!ALLOWED_SIZE_QUERY_VALUES.has(key)) key = ALL_KEY;
  activeFilter = key;
  let visible = 0;

  for (const card of cards) {
    const sizeKey = cardSizeKey({
      category: card.dataset.category,
      sizeCategory: card.dataset.sizeCategory
    });
    const show = isVisible(key, sizeKey);
    card.hidden = !show;
    if (show) visible += 1;
  }

  if (filterBar) {
    for (const button of filterBar.querySelectorAll('.filter-chip')) {
      button.setAttribute('aria-pressed', String(button.dataset.size === key));
    }
  }

  if (resultsStatus) {
    resultsStatus.textContent = resultSummary(visible);
  }

  if (updateUrl) {
    const query = sizeQuery(key);
    const url = `${window.location.pathname}${query}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  }
}

function openPaintingDialog(card) {
  const { title, medium, size, price, availability, description, image } = card.dataset;

  dialogTitle.textContent = title || '';
  dialogMedium.textContent = medium || 'Not specified';
  dialogSize.textContent = size || 'Dimensions to be confirmed';
  dialogPrice.textContent = price || 'Price on enquiry';
  dialogAvailability.textContent = availability || '';
  dialogDescription.textContent = description || '';

  dialogImageElement.src = image || '';
  dialogImageElement.alt = title || 'Artwork';

  dialog.showModal();
}

dialogClose.addEventListener('click', () => dialog.close());

dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  const isOutside =
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom;
  if (isOutside) dialog.close();
});

const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function dialogFocusable() {
  return Array.from(dialog.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hidden && !el.disabled && el.offsetParent !== null
  );
}

dialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !dialog.open) return;
  const focusable = dialogFocusable();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !dialog.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  }
});

// Dedicated-page enquiry: use the existing mailto semantics (the same address
// and builder the Home contact form uses), with the painting title in the
// subject. The Gallery page has no local contact section to scroll to.
dialogInquire.addEventListener('click', () => {
  const title = dialogTitle.textContent || '';
  window.location.href = buildInquiryMailto({
    email: CONTACT_EMAIL,
    name: '',
    customerEmail: '',
    painting: title,
    message: ''
  });
});
