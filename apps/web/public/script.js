// Public gallery client (progressive enhancement).
//
// ES module. Reads the server-rendered cards once and enhances them in place:
// builds the accessible size filter bar (with real counts), wires card/dialog
// interaction, manages the ?size=<key> query state, and powers the inquiry
// mailto. It NEVER fetches /api/artworks, wipes the grid, or rebuilds cards.
// Empty SSR state (no cards) renders an accessible empty message.

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

const CONTACT_EMAIL = 'mjdonnellan73@gmail.com';

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

const inquiryForm = document.getElementById('inquiry-form');
const paintingNameInput = document.getElementById('painting-name');

const dialogImageElement = document.createElement('img');
dialogImageElement.alt = '';
dialogImage.appendChild(dialogImageElement);

const cards = Array.from(galleryGrid.querySelectorAll('.painting-card'));
let activeFilter = ALL_KEY;

init();

function init() {
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

  paintingNameInput.value = title || '';
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

dialogInquire.addEventListener('click', () => {
  paintingNameInput.value = paintingNameInput.value || selectedDialogTitle();
  dialog.close();
  document.getElementById('contact').scrollIntoView({ behavior: 'smooth', block: 'start' });
  paintingNameInput.focus();
});

function selectedDialogTitle() {
  return dialogTitle.textContent || '';
}

inquiryForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = document.getElementById('customer-name').value.trim();
  const customerEmail = document.getElementById('customer-email').value.trim();
  const painting = paintingNameInput.value.trim();
  const message = document.getElementById('message').value.trim();

  window.location.href = buildInquiryMailto({
    email: CONTACT_EMAIL,
    name,
    customerEmail,
    painting,
    message
  });
});

// Fixed "Back to Top" control. Independent of gallery data/render: it only
// reads scroll position and the painting dialog state. It is removed from the
// tab order ([hidden]) at the top of the page and while the painting dialog is
// open, and honors prefers-reduced-motion for the scroll action.
const backToTopButton = document.getElementById('back-to-top');
const BACK_TO_TOP_THRESHOLD = 400;

if (backToTopButton) {
  const reducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const syncBackToTop = () => {
    backToTopButton.hidden =
      dialog.open || window.scrollY < BACK_TO_TOP_THRESHOLD;
  };

  window.addEventListener('scroll', syncBackToTop, { passive: true });
  window.addEventListener('resize', syncBackToTop, { passive: true });
  dialog.addEventListener('toggle', syncBackToTop);

  backToTopButton.addEventListener('click', () => {
    const top = document.getElementById('top');
    const behavior = reducedMotion() ? 'auto' : 'smooth';
    if (top) {
      top.scrollIntoView({ behavior, block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior });
    }
  });

  syncBackToTop();
}
