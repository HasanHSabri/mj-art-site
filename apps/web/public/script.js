// Public Gallery page client (progressive enhancement).
//
// ES module. Reads the server-rendered cards once and enhances them in place:
// builds the accessible filter bar (Featured + All + sizes with real counts),
// manages the batched reveal (first 12 matching, then +12 per Load more; no
// infinite scroll), wires card/dialog interaction, manages the
// ?size=<key>&shown=<n> query state with pushState/popstate, and powers the
// artwork enquiry mailto. It NEVER fetches /api/artworks, wipes the grid, or
// rebuilds cards. Empty SSR state (no cards) renders an accessible empty
// message.
//
// SSR already renders only the first FEATURED_COUNT cards un-hidden (the rest
// carry `hidden`), so the default Featured view paints with no flash even
// before this module runs and stays complete for no-JS visitors and indexing.
//
// The dedicated Gallery page has no contact form of its own: the dialog's
// "Enquire about this painting" action uses the existing mailto semantics
// (gallery-display.js#buildInquiryMailto, the same address and shape the Home
// contact form uses) rather than scrolling to a #contact section that does not
// exist on this page.

import {
  SIZE_FILTERS,
  MISC_KEY,
  ALL_KEY,
  FEATURED_KEY,
  PAGE_SIZE,
  countBySize,
  countMatching,
  filterLabel,
  selectCardVisibility,
  parseGalleryQuery,
  galleryQuery,
  clampShown,
  resultSummary,
  loadMoreLabel,
  buildInquiryMailto
} from './gallery-display.js';
import { initBackToTop } from './back-to-top.js';

const CONTACT_EMAIL = 'mjdonnellan73@gmail.com';

const galleryGrid = document.getElementById('gallery-grid');
const filterBar = document.getElementById('gallery-filters');
const resultsStatus = document.getElementById('gallery-results');
const loadMoreButton = document.getElementById('gallery-load-more');

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
const cardDescriptors = cards.map((card) => ({
  category: card.dataset.category,
  sizeCategory: card.dataset.sizeCategory
}));

// Current filter state: { filter: featured|all|<size>|miscellaneous, shown }.
// Featured always shows the deterministic first-10 selection (shown === 10).
let activeState = { filter: FEATURED_KEY, shown: 10 };

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

  // Keyboard/card activation + dialog wiring on every SSR card (including
  // currently hidden ones: revealing them never needs re-wiring).
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
  loadMoreButton.addEventListener('click', () => {
    const total = countMatching(cardDescriptors, activeState.filter);
    applyState(
      { filter: activeState.filter, shown: clampShown(activeState.shown + PAGE_SIZE, total) },
      { updateUrl: true }
    );
  });

  applyState(readStateFromUrl(), { updateUrl: false });

  // Back/Forward: reapply whatever the URL says, without rewriting it.
  window.addEventListener('popstate', () => {
    applyState(readStateFromUrl(), { updateUrl: false });
  });
}

function renderEmptyState() {
  if (resultsStatus) {
    resultsStatus.textContent = 'No artworks are available yet.';
  }
  if (filterBar) filterBar.hidden = true;
  if (loadMoreButton) loadMoreButton.hidden = true;
}

// Build the accessible filter bar (Featured + All + 11 sizes + Miscellaneous)
// with real counts from the SSR card data attrs. Featured is the curated
// selection (its count is the live status line's job, not the chip's).
function buildFilterBar() {
  if (!filterBar) return;
  filterBar.replaceChildren();

  const counts = countBySize(cardDescriptors);

  const keys = [FEATURED_KEY, ALL_KEY, ...SIZE_FILTERS, MISC_KEY];
  for (const key of keys) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-chip';
    button.dataset.size = key;
    button.setAttribute('aria-pressed', String(key === activeState.filter));
    if (key === FEATURED_KEY) {
      button.textContent = filterLabel(key);
    } else {
      const count = counts[key] || 0;
      button.textContent = `${filterLabel(key)} (${count})`;
    }
    button.addEventListener('click', () => {
      const total = countMatching(cardDescriptors, key);
      const shown = key === FEATURED_KEY ? total : clampShown(PAGE_SIZE, total);
      applyState({ filter: key, shown }, { updateUrl: true });
    });
    filterBar.appendChild(button);
  }
}

// Read the canonical filter state from the current URL, clamping `shown`
// against the real matching count for the parsed filter.
function readStateFromUrl() {
  const parsed = parseGalleryQuery(window.location.search);
  if (parsed.filter === FEATURED_KEY) {
    return { filter: FEATURED_KEY, shown: countMatching(cardDescriptors, FEATURED_KEY) };
  }
  const total = countMatching(cardDescriptors, parsed.filter);
  return { filter: parsed.filter, shown: clampShown(parsed.shown, total) };
}

// Apply a filter state: toggle the `hidden` attribute on each card (hidden
// cards leave the accessibility tree and focus order), update aria-pressed on
// chips, refresh the live status and the Load more control, and push the URL
// for user actions (popstate reapplies without rewriting).
function applyState(next, opts) {
  const key = next.filter;
  const total = countMatching(cardDescriptors, key);
  const shown =
    key === FEATURED_KEY ? total : clampShown(next.shown, total);
  activeState = { filter: key, shown };

  const visibility = selectCardVisibility(cardDescriptors, key, shown);
  cards.forEach((card, index) => {
    card.hidden = !visibility[index];
  });

  if (filterBar) {
    for (const button of filterBar.querySelectorAll('.filter-chip')) {
      button.setAttribute('aria-pressed', String(button.dataset.size === key));
    }
  }

  if (resultsStatus) {
    resultsStatus.textContent = resultSummary(Math.min(shown, total), total);
  }

  if (loadMoreButton) {
    const label = loadMoreLabel(shown, total);
    if (label === null) {
      loadMoreButton.hidden = true;
    } else {
      loadMoreButton.hidden = false;
      loadMoreButton.textContent = label;
    }
  }

  if (opts && opts.updateUrl) {
    const url = `${window.location.pathname}${galleryQuery(key, shown, total)}${window.location.hash}`;
    window.history.pushState(null, '', url);
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
