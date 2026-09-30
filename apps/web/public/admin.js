import {
  CANONICAL_SIZES,
  MISC_SIZE_CATEGORY,
  deriveDimensionsLabel,
  deriveOrientation,
  formToRecord,
  isValidCatalogNumber,
  nextSortOrder,
  provenanceSummary,
  recordToForm,
  renumber,
  reorder,
  filterCatalogue,
  paginateList,
  canReorder,
  formValuesEqual,
  editorNeedsReload,
  fieldIdsForErrors
} from './admin-artwork.js';
import {
  STATUS_ORDER,
  formatBookLabel,
  formatFormatLabel,
  formatStatusLabel,
  formatCreatedDate,
  safeMailtoHref,
  buildSummaryTiles,
  BOOKS_PAGE_SIZE,
  filterRowsByName,
  booksRangeLabel
} from './admin-books.js';
import {
  parseAdminView,
  adminViewQuery,
  defaultViewState,
  sameViewState,
  CATALOGUE_PAGE_SIZE
} from './admin-view.js';

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const FULL_MAX_DIMENSION = 2000;
const THUMB_MAX_DIMENSION = 640;
const CATALOGUE_SCROLL_KEY = 'mj-admin-catalogue-scroll';

const loginPanel = document.getElementById('login-panel');
const adminContent = document.getElementById('admin-content');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const topbarNav = document.getElementById('admin-section-nav');
const logoutButton = document.getElementById('logout');
const navLinks = Array.from(document.querySelectorAll('.admin-section-nav .section-anchor'));
const viewPanels = Array.from(document.querySelectorAll('[data-view-panel]'));

const form = document.getElementById('artwork-form');
const fields = {
  id: document.getElementById('artwork-id'),
  sortOrder: document.getElementById('sort-order'),
  category: document.getElementById('category'),
  catalogNumber: document.getElementById('catalog-number'),
  title: document.getElementById('title'),
  imageUpload: document.getElementById('image-upload'),
  uploadButton: document.getElementById('upload-button'),
  uploadStatus: document.getElementById('upload-status'),
  image: document.getElementById('image-path'),
  thumbnail: document.getElementById('thumbnail-path'),
  containImage: document.getElementById('contain-image'),
  widthCm: document.getElementById('width-cm'),
  heightCm: document.getElementById('height-cm'),
  orientation: document.getElementById('orientation'),
  sizeCategory: document.getElementById('size-category'),
  medium: document.getElementById('medium'),
  availability: document.getElementById('availability'),
  priceAmount: document.getElementById('price-amount'),
  priceNote: document.getElementById('price-note'),
  cardNote: document.getElementById('card-note'),
  description: document.getElementById('description')
};
const provenanceBlock = document.getElementById('provenance-block');
const provenanceSummaryEl = document.getElementById('provenance-summary');
const formErrors = document.getElementById('form-errors');
const saveStatus = document.getElementById('save-status');
const dirtyStatus = document.getElementById('dirty-status');
const editorHeading = document.getElementById('artwork-heading');
const backToCatalogueButton = document.getElementById('back-to-catalogue');

const preview = {
  title: document.getElementById('preview-title'),
  image: document.getElementById('preview-image'),
  medium: document.getElementById('preview-medium'),
  size: document.getElementById('preview-size'),
  availability: document.getElementById('preview-availability'),
  price: document.getElementById('preview-price'),
  description: document.getElementById('preview-description')
};

const artworkList = document.getElementById('artwork-list');
const artworkSearch = document.getElementById('artwork-search');
const artworkFilterAvailability = document.getElementById('artwork-filter-availability');
const artworkFilterSize = document.getElementById('artwork-filter-size');
const reorderNote = document.getElementById('reorder-note');
const catalogueCount = document.getElementById('catalogue-count');
const artworkPagination = document.getElementById('artwork-pagination');
const addArtworkButton = document.getElementById('add-artwork');

let artworks = [];
let editingId = null;
let formBaseline = null;
let lastCatalogueState = null;
let viewState = parseAdminView(window.location.search, window.location.hash);

// ===========================================================================
// View routing (URL-addressable focused views)
// ===========================================================================
//
// The admin document has three focused views; the active one is carried in the
// URL (?view=catalogue|artwork|books) so reload, back/forward, and shared
// links land on the exact view. Catalogue list state rides in the same URL,
// and the scroll position is remembered (sessionStorage, no PII) so returning
// from the editor restores exactly what the admin was looking at.

function rememberCatalogueState(fromState) {
  if (fromState.view !== 'catalogue') return;
  lastCatalogueState = {
    q: fromState.q,
    availability: fromState.availability,
    size: fromState.size,
    page: fromState.page
  };
  try {
    window.sessionStorage.setItem(CATALOGUE_SCROLL_KEY, String(window.scrollY));
  } catch {
    // storage unavailable (private mode): scroll restore is simply skipped
  }
}

function restoreCatalogueScroll() {
  let top = 0;
  try {
    const stored = window.sessionStorage.getItem(CATALOGUE_SCROLL_KEY);
    top = stored === null ? 0 : Math.max(0, Number(stored) || 0);
    window.sessionStorage.removeItem(CATALOGUE_SCROLL_KEY);
  } catch {
    top = 0;
  }
  window.scrollTo({ top, behavior: 'auto' });
}

function applyViewState(next, mode = 'push') {
  const previousView = viewState.view;
  rememberCatalogueState(viewState);
  viewState = defaultViewState(next);
  const query = adminViewQuery(viewState);
  const url = query || window.location.pathname;
  if (mode === 'replace') history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  renderView();
  if (viewState.view !== previousView) focusViewHeading(viewState.view);
}

// Move keyboard/screen-reader focus to the incoming view's heading after a
// real view transition (login reveal, in-app navigation, back/forward). Called
// only on view CHANGES: filter keystrokes and re-renders never touch focus.
function focusViewHeading(view) {
  const headings = {
    catalogue: document.getElementById('catalogue-heading'),
    artwork: document.getElementById('artwork-heading'),
    books: document.getElementById('books-heading')
  };
  const heading = headings[view];
  if (heading && typeof heading.focus === 'function') heading.focus();
}

// Internal navigation with the editor dirty-guard. Returns true when the
// navigation happened.
function goToView(target, options = {}) {
  const next = defaultViewState(target);
  if (viewState.view === 'artwork' && isDirty()) {
    const sameEditor = next.view === 'artwork' && next.id === viewState.id;
    if (!sameEditor && !confirmDiscardEditor(describeView(next))) return false;
  }
  applyViewState(next, options.replace ? 'replace' : 'push');
  return true;
}

function describeView(state) {
  if (state.view === 'catalogue') return 'return to the catalogue';
  if (state.view === 'books') return 'open book enquiries';
  return state.id ? 'open another painting' : 'start a new painting';
}

window.addEventListener('popstate', () => {
  const target = parseAdminView(window.location.search, window.location.hash);
  const previousView = viewState.view;
  const wasEditor = previousView === 'artwork';
  const sameEditor = target.view === 'artwork' && target.id === viewState.id;
  if (wasEditor && isDirty() && !sameEditor) {
    // Stay addressable on the editor URL; only leave on an explicit discard.
    history.pushState(null, '', adminViewQuery(viewState) || window.location.pathname);
    if (!window.confirm('You have unsaved changes to this painting. Discard them and leave the editor?')) {
      return;
    }
    discardEditorChanges();
    viewState = defaultViewState(target);
    renderView();
    history.pushState(null, '', adminViewQuery(target) || window.location.pathname);
    if (target.view === 'catalogue') restoreCatalogueScroll();
    if (target.view !== previousView) focusViewHeading(target.view);
    return;
  }
  viewState = defaultViewState(target);
  renderView();
  if (wasEditor && target.view === 'catalogue') restoreCatalogueScroll();
  if (target.view !== previousView) focusViewHeading(target.view);
});

// Reload / close / external navigation with unsaved editor changes.
window.addEventListener('beforeunload', (event) => {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

navLinks.forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    goToView({ view: link.dataset.view });
  });
});

function renderView() {
  const state = viewState;
  for (const panel of viewPanels) {
    panel.hidden = panel.dataset.viewPanel !== state.view;
  }
  for (const link of navLinks) {
    if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (state.view === 'catalogue') {
    renderCatalogue();
  } else if (state.view === 'artwork') {
    openEditor(state);
  } else if (state.view === 'books') {
    ensureBooksLoaded();
  }
}

// ===========================================================================
// Authentication
// ===========================================================================

function showLoginPanel(message) {
  adminContent.hidden = true;
  loginPanel.hidden = false;
  topbarNav.hidden = true;
  logoutButton.hidden = true;
  loginStatus.textContent = message || '';
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginStatus.textContent = 'Signing in...';
  const response = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('admin-password').value })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    loginStatus.textContent = body.error || 'Could not sign in.';
    return;
  }
  loginStatus.textContent = '';
  await loadArtworks();
});

logoutButton.addEventListener('click', async () => {
  if (viewState.view === 'artwork' && isDirty() && !window.confirm('You have unsaved changes to this painting. Discard them and sign out?')) {
    return;
  }
  await fetch('/api/admin/logout', { method: 'POST' });
  resetBooksSurface();
  resetEditorForm();
  showLoginPanel();
  viewState = defaultViewState();
  history.replaceState(null, '', window.location.pathname);
});

// ===========================================================================
// Artwork catalogue (compact list view)
// ===========================================================================

addArtworkButton.addEventListener('click', () => goToView({ view: 'artwork' }));
artworkSearch.addEventListener('input', () => setCatalogueState({ q: artworkSearch.value }, true));
artworkFilterAvailability.addEventListener('change', () => setCatalogueState({ availability: artworkFilterAvailability.value }, true));
artworkFilterSize.addEventListener('change', () => setCatalogueState({ size: artworkFilterSize.value }, true));

function setCatalogueState(partial, resetPage = false) {
  const next = defaultViewState({
    ...viewState,
    ...partial,
    view: 'catalogue',
    id: '',
    page: resetPage ? 1 : viewState.page
  });
  const changed = !sameViewState(next, viewState);
  viewState = next;
  history.replaceState(null, '', adminViewQuery(viewState) || window.location.pathname);
  if (changed || resetPage) renderCatalogue();
}

function setCataloguePage(page) {
  viewState = defaultViewState({ ...viewState, view: 'catalogue', page });
  history.replaceState(null, '', adminViewQuery(viewState) || window.location.pathname);
  renderCatalogue();
  artworkList.scrollIntoView({ behavior: 'auto', block: 'start' });
}

function renderCatalogue() {
  // Keep the controls in sync with the URL state (e.g. after Back).
  if (artworkSearch.value !== viewState.q) artworkSearch.value = viewState.q;
  if (artworkFilterAvailability.value !== viewState.availability) artworkFilterAvailability.value = viewState.availability;
  if (artworkFilterSize.value !== viewState.size) artworkFilterSize.value = viewState.size;

  const filtered = filterCatalogue(artworks, {
    term: viewState.q,
    availability: viewState.availability,
    size: viewState.size
  });
  const page = paginateList(filtered, viewState.page, CATALOGUE_PAGE_SIZE);
  if (page.page !== viewState.page) {
    // Clamp after removals/filters so the URL never points past the last page.
    viewState = defaultViewState({ ...viewState, page: page.page });
    history.replaceState(null, '', adminViewQuery(viewState) || window.location.pathname);
  }
  const reorderable = canReorder({
    term: viewState.q,
    availability: viewState.availability,
    size: viewState.size
  });

  reorderNote.textContent = reorderable || !artworks.length
    ? ''
    : 'Move up / Move down change the full catalogue order. Clear search and filters to reorder.';

  if (!artworks.length) {
    artworkList.innerHTML = '<p class="empty-state">No artwork yet. Add the first painting.</p>';
    catalogueCount.textContent = '';
    artworkPagination.textContent = '';
    return;
  }
  if (!filtered.length) {
    artworkList.innerHTML = '<p class="empty-state">No artwork matches the current search or filters.</p>';
    catalogueCount.textContent = '0 paintings';
    artworkPagination.textContent = '';
    return;
  }

  catalogueCount.textContent = filtered.length === artworks.length
    ? `Showing ${page.start}\u2013${page.end} of ${filtered.length} ${filtered.length === 1 ? 'painting' : 'paintings'}`
    : `Showing ${page.start}\u2013${page.end} of ${filtered.length} ${filtered.length === 1 ? 'painting' : 'paintings'} (${artworks.length} total)`;

  artworkList.innerHTML = '';
  page.items.forEach((artwork) => {
    artworkList.appendChild(catalogueRow(artwork, reorderable));
  });
  renderCataloguePagination(page);
}

function catalogueRow(artwork, reorderable) {
  const index = artworks.indexOf(artwork);
  const sizeLabel = artwork.category === 'miscellaneous' ? 'Miscellaneous' : (artwork.sizeCategory || '\u2014');
  const priceLabel = artwork.price && artwork.price.amount ? ` \u00b7 $${artwork.price.amount}` : '';
  const imageSrc = artwork.thumbnail || artwork.image;
  const card = document.createElement('article');
  card.className = 'cat-row';
  if (artwork.id === editingId) card.classList.add('editing');
  const moveUpDisabled = !reorderable || index === 0;
  const moveDownDisabled = !reorderable || index === artworks.length - 1;
  card.innerHTML = `
    ${imageSrc ? `<img src="${escapeAttribute(imageSrc)}" alt="">` : '<span class="cat-thumb-missing" aria-hidden="true"></span>'}
    <div class="cat-info">
      <h3>${escapeHtml(artwork.title)}</h3>
      <p class="card-meta">${escapeHtml(artwork.catalogNumber)} \u00b7 ${escapeHtml(sizeLabel)}${priceLabel} \u00b7 #${artwork.sortOrder}</p>
    </div>
    <p class="cat-availability ${artwork.availability === 'Sold' ? 'cat-sold' : 'cat-available'}">${escapeHtml(artwork.availability)}</p>
    <div class="cat-actions">
      <button class="button ghost-button" type="button" data-edit>Edit</button>
      <button class="button danger-button" type="button" data-remove>Remove</button>
      <button class="button ghost-button icon-button" type="button" data-move="up" ${moveUpDisabled ? 'disabled' : ''}>Move up</button>
      <button class="button ghost-button icon-button" type="button" data-move="down" ${moveDownDisabled ? 'disabled' : ''}>Move down</button>
    </div>
  `;
  card.querySelector('[data-edit]').addEventListener('click', () => {
    rememberCatalogueState(viewState);
    goToView({ view: 'artwork', id: artwork.id });
  });
  card.querySelector('[data-remove]').addEventListener('click', () => removeArtwork(index));
  card.querySelector('[data-move="up"]').addEventListener('click', () => moveArtwork(index, 'up'));
  card.querySelector('[data-move="down"]').addEventListener('click', () => moveArtwork(index, 'down'));
  return card;
}

function renderCataloguePagination(page) {
  artworkPagination.textContent = '';
  if (page.pageCount <= 1) return;

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'button ghost-button page-button';
  prev.textContent = 'Previous';
  prev.disabled = page.page <= 1;
  prev.addEventListener('click', () => setCataloguePage(page.page - 1));

  const label = document.createElement('span');
  label.className = 'page-label';
  label.textContent = `Page ${page.page} of ${page.pageCount}`;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'button ghost-button page-button';
  next.textContent = 'Next';
  next.disabled = page.page >= page.pageCount;
  next.addEventListener('click', () => setCataloguePage(page.page + 1));

  artworkPagination.append(prev, label, next);
}

async function moveArtwork(index, direction) {
  const moved = reorder(artworks, index, direction);
  if (moved === artworks) return;
  const previousArtworks = artworks.map(cloneRecord);
  artworks = renumber(moved);
  reorderNote.textContent = `Moved ${artworks[index] ? artworks[index].title : 'item'} ${direction}. Saving new order...`;
  renderCatalogue();
  const saved = await saveArtworks(null);
  if (!saved) {
    artworks = previousArtworks;
    renderCatalogue();
    reorderNote.textContent = 'Reorder failed. Order restored.';
    return;
  }
  reorderNote.textContent = `Order updated (${artworks.length} items).`;
}

async function removeArtwork(index) {
  const target = artworks[index];
  if (!target || !window.confirm(`Remove ${target.title} from the public gallery?`)) return;
  const previousArtworks = artworks.map(cloneRecord);
  artworks.splice(index, 1);
  artworks = renumber(artworks);
  reorderNote.textContent = 'Removing and saving...';
  const saved = await saveArtworks(null);
  if (!saved) {
    artworks = previousArtworks;
    renderCatalogue();
    reorderNote.textContent = 'Remove failed.';
    return;
  }
  if (editingId === target.id) {
    resetEditorForm();
    if (viewState.view === 'artwork') {
      viewState = defaultViewState({ view: 'artwork' });
      history.replaceState(null, '', adminViewQuery(viewState));
    }
  }
  renderCatalogue();
  reorderNote.textContent = '';
}

// ===========================================================================
// Focused artwork editor (add / edit)
// ===========================================================================
//
// The editor is its own view reached from the catalogue. There are no
// side-effecting Clear/New controls here: the form keeps its content across
// validation errors and failed saves, and unsaved changes (including uploaded
// image paths and a selected source file) are guarded on every exit path.

function openEditor(state) {
  editorHeading.textContent = 'Add a painting';
  saveStatus.textContent = '';
  if (state.id) {
    const record = artworks.find((item) => item.id === state.id);
    if (record) {
      editorHeading.textContent = 'Edit painting';
      if (editorNeedsReload({ editingId, formBaseline }, state.id)) {
        writeArtworkToForm(record);
      }
    } else {
      resetEditorForm('That painting is no longer in the catalogue.');
    }
  } else if (editorNeedsReload({ editingId, formBaseline }, null)) {
    resetEditorForm();
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

backToCatalogueButton.addEventListener('click', () => {
  if (viewState.view === 'artwork' && isDirty() && !confirmDiscardEditor('return to the catalogue')) return;
  returnToCatalogue();
});

function returnToCatalogue() {
  discardEditorChanges();
  const remembered = lastCatalogueState || { q: '', availability: 'all', size: 'all', page: 1 };
  applyViewState({ ...remembered, view: 'catalogue' });
  restoreCatalogueScroll();
}

function confirmDiscardEditor(actionLabel) {
  if (viewState.view !== 'artwork' || !isDirty()) return true;
  const ok = window.confirm(`You have unsaved changes to this painting. Discard them and ${actionLabel}?`);
  if (ok) discardEditorChanges();
  return ok;
}

// A confirmed discard invalidates BOTH the baseline and the editor identity.
// Without clearing editingId, re-entering the same artwork saw "same id" and
// skipped the refill, leaving discarded values in the form with no baseline
// (so dirty tracking stayed permanently off). After a discard, every editor
// entry refills from the canonical record (or resets to the blank add form).
function discardEditorChanges() {
  editingId = null;
  formBaseline = null;
  dirtyStatus.hidden = true;
}

function currentFormSnapshot() {
  const file = fields.imageUpload.files && fields.imageUpload.files[0];
  return { ...readFormValues(), imageFileName: file ? file.name : '' };
}

function setFormBaseline() {
  formBaseline = currentFormSnapshot();
  dirtyStatus.hidden = true;
}

function isDirty() {
  if (viewState.view !== 'artwork' || formBaseline === null) return false;
  return !formValuesEqual(currentFormSnapshot(), formBaseline);
}

function updateDirtyStatus() {
  const dirty = isDirty();
  dirtyStatus.hidden = !dirty;
}

form.addEventListener('input', () => {
  updateOrientation();
  updatePreview();
  updateDirtyStatus();
});
fields.imageUpload.addEventListener('change', updateDirtyStatus);

fields.category.addEventListener('change', () => {
  updateSizeCategoryLock();
  updatePreview();
  updateDirtyStatus();
});

fields.uploadButton.addEventListener('click', uploadDerivatives);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormErrors();
  const result = formToRecord(readFormValues());

  if (!result.ok) {
    showFormErrors(result.errors);
    return;
  }

  const record = result.record;
  record.provenance = provenanceForId(record.id);

  const previousArtworks = artworks.map(cloneRecord);
  const existingIndex = artworks.findIndex((item) => item.id === record.id);
  if (existingIndex >= 0) {
    record.sortOrder = artworks[existingIndex].sortOrder;
    artworks[existingIndex] = record;
  } else {
    record.sortOrder = nextSortOrder(artworks);
    artworks.push(record);
  }

  const saved = await saveArtworks(record);
  if (!saved) {
    // Keep the form exactly as entered; the catalogue array is restored.
    artworks = previousArtworks;
    return;
  }

  // Verified success: reset the dirty baseline to the persisted record, then
  // return to the catalogue exactly where the admin left it.
  writeArtworkToForm(record);
  returnToCatalogue();
});

function readFormValues() {
  return {
    catalogNumber: fields.catalogNumber.value,
    category: fields.category.value,
    title: fields.title.value,
    image: fields.image.value,
    thumbnail: fields.thumbnail.value,
    medium: fields.medium.value,
    widthCm: fields.widthCm.value,
    heightCm: fields.heightCm.value,
    sizeCategory: fields.sizeCategory.value,
    availability: fields.availability.value,
    priceAmount: fields.priceAmount.value,
    priceNote: fields.priceNote.value,
    cardNote: fields.cardNote.value,
    description: fields.description.value,
    containImage: fields.containImage.checked,
    sortOrder: fields.sortOrder.value ? parseInt(fields.sortOrder.value, 10) : nextSortOrder(artworks)
  };
}

function provenanceForId(id) {
  const existing = artworks.find((item) => item.id === id);
  return existing ? cloneRecord(existing.provenance) : { source: 'admin' };
}

async function uploadDerivatives() {
  const file = fields.imageUpload.files[0];
  const catalogNumber = fields.catalogNumber.value.trim().toUpperCase();
  fields.uploadStatus.textContent = '';

  if (!isValidCatalogNumber(catalogNumber, fields.category.value)) {
    fields.uploadStatus.textContent = 'Enter a valid catalog number before uploading.';
    return;
  }
  if (!file) {
    fields.uploadStatus.textContent = 'Choose a source image first.';
    return;
  }
  if (file.size > MAX_SOURCE_BYTES) {
    fields.uploadStatus.textContent = 'Source image is too large.';
    return;
  }

  fields.uploadButton.disabled = true;
  fields.uploadStatus.textContent = 'Generating derivatives and uploading...';

  let derivatives;
  try {
    derivatives = await createDerivatives(file);
  } catch (error) {
    fields.uploadButton.disabled = false;
    fields.uploadStatus.textContent = error.message || 'Could not process that image.';
    return;
  }

  const data = new FormData();
  data.append('catalogNumber', catalogNumber);
  data.append('image', derivatives.full, 'full.jpg');
  data.append('thumbnail', derivatives.thumb, 'thumb.jpg');

  let response;
  try {
    response = await fetch('/api/admin/upload', { method: 'POST', body: data });
  } catch (error) {
    fields.uploadButton.disabled = false;
    fields.uploadStatus.textContent = 'Upload failed. Check your connection.';
    return;
  }
  const body = await response.json().catch(() => ({}));
  fields.uploadButton.disabled = false;

  if (!response.ok) {
    fields.uploadStatus.textContent = body.error || 'Image upload failed.';
    return;
  }

  fields.image.value = body.image;
  fields.thumbnail.value = body.thumbnail;
  updatePreview();
  updateDirtyStatus();
  fields.uploadStatus.textContent = 'Derivatives uploaded and selected. Save to publish.';
}

// Build two in-memory JPEG derivatives from the selected source (full ~2000px,
// thumb ~640px), preserving aspect ratio and EXIF orientation. The source file
// is never modified or uploaded.
async function createDerivatives(file) {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot process images. Use a modern browser.');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new Error('Could not decode that image. Use a JPEG or PNG.');
  }
  try {
    const full = await scaleToJpeg(bitmap, FULL_MAX_DIMENSION, 0.9);
    const thumb = await scaleToJpeg(bitmap, THUMB_MAX_DIMENSION, 0.85);
    return { full, thumb };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

function scaleToJpeg(bitmap, maxDimension, quality) {
  const longest = Math.max(bitmap.width, bitmap.height) || 1;
  const scale = Math.min(1, maxDimension / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode JPEG derivative.'));
    }, 'image/jpeg', quality);
  });
}

async function loadArtworks() {
  const response = await fetch('/api/admin/artworks');
  if (response.status === 401) {
    showLoginPanel();
    return;
  }
  artworks = await response.json();
  loginPanel.hidden = true;
  adminContent.hidden = false;
  topbarNav.hidden = false;
  logoutButton.hidden = false;
  renderView();
  // Land keyboard/screen-reader focus on the revealed view's heading (fresh
  // sign-in or a page reload with a valid session). Filter keystrokes never
  // route through here, so typing is never interrupted.
  focusViewHeading(viewState.view);
  // The Books view loads lazily (only when shown) now that admin auth is
  // confirmed; a Books failure is contained inside loadBooksDashboard (panel
  // error) and must never break the artwork admin above.
}

async function saveArtworks(savedArtwork) {
  saveStatus.textContent = 'Saving to public gallery...';
  const response = await fetch('/api/admin/artworks', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(artworks)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    saveStatus.textContent = body.error || 'Save failed.';
    return false;
  }

  artworks = body.artworks;
  if (!savedArtwork) {
    saveStatus.textContent = 'Saved. The public gallery is updated.';
    return true;
  }

  const isPublic = await verifyPublicArtwork(savedArtwork.id);
  saveStatus.textContent = isPublic
    ? 'Saved. The public gallery is updated.'
    : 'Saved, but the public gallery did not confirm the update yet. Refresh in a moment.';
  return true;
}

async function verifyPublicArtwork(artworkId) {
  const response = await fetch(`/api/artworks?published=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return false;
  const publicArtworks = await response.json().catch(() => []);
  return publicArtworks.some((artwork) => artwork.id === artworkId);
}

function writeArtworkToForm(record) {
  const values = recordToForm(record);
  editingId = record.id;
  fields.id.value = record.id;
  fields.sortOrder.value = record.sortOrder == null ? '' : String(record.sortOrder);
  fields.category.value = values.category;
  fields.catalogNumber.value = values.catalogNumber;
  fields.catalogNumber.disabled = true;
  fields.title.value = values.title;
  fields.image.value = values.image;
  fields.thumbnail.value = values.thumbnail;
  fields.containImage.checked = values.containImage;
  fields.widthCm.value = values.widthCm;
  fields.heightCm.value = values.heightCm;
  fields.sizeCategory.value = values.sizeCategory;
  fields.medium.value = values.medium;
  fields.availability.value = values.availability;
  fields.priceAmount.value = values.priceAmount;
  fields.priceNote.value = values.priceNote;
  fields.cardNote.value = values.cardNote;
  fields.description.value = values.description;
  fields.imageUpload.value = '';

  provenanceSummaryEl.textContent = provenanceSummary(record.provenance);
  provenanceBlock.hidden = false;

  updateSizeCategoryLock();
  updateOrientation();
  updatePreview();
  clearFormErrors();
  setFormBaseline();
}

// Reset the editor to a blank add form. Only called for an explicit, guarded
// transition (never a silent side-effecting button inside a filled editor).
function resetEditorForm(statusMessage) {
  form.reset();
  editingId = null;
  fields.id.value = '';
  fields.sortOrder.value = '';
  fields.catalogNumber.disabled = false;
  fields.availability.value = 'Available';
  fields.category.value = 'catalogue';
  provenanceBlock.hidden = true;
  provenanceSummaryEl.textContent = 'None';
  updateSizeCategoryLock();
  updateOrientation();
  updatePreview();
  clearFormErrors();
  setFormBaseline();
  if (statusMessage) saveStatus.textContent = statusMessage;
}

function updateOrientation() {
  const width = parseOptionalNumber(fields.widthCm.value);
  const height = parseOptionalNumber(fields.heightCm.value);
  fields.orientation.value = deriveOrientation(width, height);
}

function updateSizeCategoryLock() {
  const isMisc = fields.category.value === 'miscellaneous';
  fields.sizeCategory.disabled = isMisc;
  if (isMisc) {
    fields.sizeCategory.value = MISC_SIZE_CATEGORY;
  } else if (fields.sizeCategory.value === MISC_SIZE_CATEGORY) {
    fields.sizeCategory.value = '';
  }
}

function updatePreview() {
  const values = readFormValues();
  const result = formToRecord(values);
  const record = result.ok ? result.record : null;
  const width = parseOptionalNumber(fields.widthCm.value);
  const height = parseOptionalNumber(fields.heightCm.value);

  const title = fields.title.value.trim() || 'Untitled painting';
  preview.title.textContent = title;
  const imageSrc = fields.thumbnail.value || fields.image.value;
  const imageClass = fields.containImage.checked ? ' contain' : '';
  preview.image.className = `preview-image${imageClass}`;
  preview.image.innerHTML = imageSrc ? `<img src="${escapeAttribute(imageSrc)}" alt="${escapeAttribute(title)}">` : '';

  preview.medium.textContent = fields.medium.value.trim() || '\u2014';
  preview.size.textContent = record ? (record.dimensions.label || '\u2014') : (deriveDimensionsLabel(width, height) || '\u2014');
  preview.availability.textContent = fields.availability.value || '\u2014';
  const amount = parseOptionalNumber(fields.priceAmount.value);
  preview.price.textContent = amount ? `$${amount}${fields.priceNote.value.trim() ? ` (${fields.priceNote.value.trim()})` : ''}` : 'Price on enquiry';
  preview.description.textContent = fields.description.value.trim() || 'Artwork description preview.';
}

function parseOptionalNumber(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function populateSizeCategoryOptions() {
  const select = fields.sizeCategory;
  CANONICAL_SIZES.forEach((size) => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    select.appendChild(option);
  });
  const filter = artworkFilterSize;
  CANONICAL_SIZES.forEach((size) => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    filter.appendChild(option);
  });
  const misc = document.createElement('option');
  misc.value = MISC_SIZE_CATEGORY;
  misc.textContent = 'Miscellaneous';
  filter.appendChild(misc);
}

// Control-id -> element map for validation-error field association.
const ERROR_FIELD_ELEMENTS = {
  'catalog-number': fields.catalogNumber,
  title: fields.title,
  'width-cm': fields.widthCm,
  'height-cm': fields.heightCm,
  'size-category': fields.sizeCategory,
  availability: fields.availability,
  'price-amount': fields.priceAmount
};

// Render validation errors AND mark the offending controls: each gets
// aria-invalid="true" and aria-describedby pointing at the error list, and the
// first offending control receives focus so keyboard users land on the fix.
function showFormErrors(errors) {
  formErrors.hidden = false;
  formErrors.innerHTML = errors.map((message) => `<li>${escapeHtml(message)}</li>`).join('');
  clearInvalidFieldMarks();

  let firstField = null;
  for (const fieldId of fieldIdsForErrors(errors)) {
    const element = ERROR_FIELD_ELEMENTS[fieldId];
    if (!element) continue;
    element.setAttribute('aria-invalid', 'true');
    element.setAttribute('aria-describedby', 'form-errors');
    if (!firstField) firstField = element;
  }
  saveStatus.textContent = firstField ? 'Please fix the highlighted fields.' : 'Please fix the errors listed below.';
  if (firstField && typeof firstField.focus === 'function') firstField.focus();
}

function clearInvalidFieldMarks() {
  for (const element of Object.values(ERROR_FIELD_ELEMENTS)) {
    if (!element) continue;
    if (element.getAttribute && element.getAttribute('aria-invalid')) element.removeAttribute('aria-invalid');
    if (element.getAttribute && element.getAttribute('aria-describedby') === 'form-errors') {
      element.removeAttribute('aria-describedby');
    }
  }
}

function clearFormErrors() {
  formErrors.hidden = true;
  formErrors.innerHTML = '';
  clearInvalidFieldMarks();
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

// Bootstrap: initial control wiring, then the auth probe that decides which
// surface renders (login panel or the URL's focused view). The Books section
// below declares its state and loaders; its functions are hoisted, and the
// books data only loads lazily once the Books view is shown.
populateSizeCategoryOptions();
updateOrientation();
updateSizeCategoryLock();
setFormBaseline();
loadArtworks();

// ===========================================================================
// Books EOI dashboard
// ===========================================================================
// SECURITY CONTRACT (enforced here and by the tests in admin-books.test.js):
//   * This dashboard loads ONLY after authenticated admin status is confirmed
//     (loadArtworks has set adminContent.hidden = false; the Books view then
//     loads lazily via ensureBooksLoaded). A Books API failure surfaces a
//     panel error and never breaks the artwork admin.
//   * Auth uses the existing HttpOnly session cookie set by the server. No PII
//     is ever written to localStorage/sessionStorage or logged.
//   * Every PII value is rendered with textContent / DOM property assignment.
//     There is NO innerHTML / insertAdjacentHTML anywhere in this section. The
//     mailto link is built from safeMailtoHref() and assigned to <a>.href.
//   * The email control is an EXACT server search across all records: the
//     address is sent in the POST body (never a URL) and matched through the
//     existing keyed email hash. Names are encrypted at rest, so the name
//     control filters only the LOADED page and is labelled as such -- it never
//     pretends to be a whole-history search.
//   * The list is server-paginated (50 rows/page with a truthful total), so
//     history older than the first 100 records is reachable without ever
//     decrypting more than one page per request.
//   * The only mutation is PATCH {status}; there is no DELETE path or button.
//     Status updates await the server (no optimistic UI) so rollback is robust;
//     on failure the row is left unchanged and the error stays visible.
//   * resetBooksSurface() clears all PII from the DOM on logout.

const booksPanel = document.getElementById('books-dashboard');
const booksStatus = document.getElementById('books-status');
const booksError = document.getElementById('books-error');
const booksTiles = document.getElementById('books-tiles');
const booksTbody = document.getElementById('books-tbody');
const booksFilterBook = document.getElementById('books-filter-book');
const booksFilterStatus = document.getElementById('books-filter-status');
const booksRefresh = document.getElementById('books-refresh');
const booksEmail = document.getElementById('books-email');
const booksEmailFind = document.getElementById('books-email-find');
const booksNameFilter = document.getElementById('books-name-filter');
const booksScopeNote = document.getElementById('books-scope-note');
const booksCount = document.getElementById('books-count');
const booksPagination = document.getElementById('books-pagination');

let bookRows = [];
let booksTotal = 0;
let booksLoadedAt = null;
let booksLoadedOnce = false;
const booksListState = { book: 'all', status: 'all', page: 1, email: '', emailActive: false };

// Request invalidation. Every load captures the current load generation and
// session epoch; a newer load, a logout, or a session-expiry collapse bumps
// them, so a late response (slow filter, stale page click, in-flight search)
// is dropped before it can render, touch status text, or re-enable controls.
let booksLoadGeneration = 0;
let booksSummaryGeneration = 0;
let booksSessionEpoch = 0;
let booksAbortController = null;
let booksNameFilterTimer = 0;

// VM/test environments may not provide AbortController; the generation guard
// remains the hard correctness boundary, the controller just cancels wasted
// network work (and any decrypt it would cause) in real browsers.
function createBooksAbortController() {
  return typeof AbortController === 'function' ? new AbortController() : null;
}

const booksDebounce = typeof setTimeout === 'function' ? { set: setTimeout, clear: clearTimeout } : null;

function isStaleBooksRequest(generation, epoch) {
  return generation !== booksLoadGeneration || epoch !== booksSessionEpoch;
}

function isStaleBooksSummary(generation, epoch) {
  return generation !== booksSummaryGeneration || epoch !== booksSessionEpoch;
}

booksFilterBook.addEventListener('change', () => {
  booksListState.book = booksFilterBook.value;
  booksListState.page = 1;
  triggerBooksReload();
});
booksFilterStatus.addEventListener('change', () => {
  booksListState.status = booksFilterStatus.value;
  booksListState.page = 1;
  triggerBooksReload();
});
booksEmailFind.addEventListener('click', () => {
  const term = booksEmail.value.trim();
  booksListState.email = term;
  booksListState.emailActive = term !== '';
  booksListState.page = 1;
  triggerBooksReload();
});
booksEmail.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    booksEmailFind.click();
  }
});
// The name filter only re-renders the loaded page; debounce so fast typing
// does not rebuild the table per keystroke.
booksNameFilter.addEventListener('input', () => {
  if (!booksDebounce) {
    renderBooksList();
    return;
  }
  if (booksNameFilterTimer) booksDebounce.clear(booksNameFilterTimer);
  booksNameFilterTimer = booksDebounce.set(() => {
    booksNameFilterTimer = 0;
    renderBooksList();
  }, 150);
});
booksRefresh.addEventListener('click', () => loadBooksDashboard(true));

function triggerBooksReload() {
  loadBooksDashboard(true);
}

// Lazy first load, invoked when the Books view becomes visible.
function ensureBooksLoaded() {
  if (!booksLoadedOnce) loadBooksDashboard(false);
}

// The current page of rows, via GET (filters/pagination in the query string)
// or the POST exact-email search (address in the body, matched by its keyed
// hash server-side). Both return { rows, total }. The optional AbortSignal
// cancels the request when a newer load or a logout supersedes it.
function fetchBooksRows(signal) {
  const offset = (booksListState.page - 1) * BOOKS_PAGE_SIZE;
  const book = booksListState.book === 'all' ? '' : booksListState.book;
  const status = booksListState.status === 'all' ? '' : booksListState.status;
  if (booksListState.emailActive) {
    return fetch('/api/admin/books/eoi/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: booksListState.email, book, status, limit: BOOKS_PAGE_SIZE, offset }),
      ...(signal ? { signal } : {})
    });
  }
  const params = new URLSearchParams({ limit: String(BOOKS_PAGE_SIZE), offset: String(offset) });
  if (book) params.set('book', book);
  if (status) params.set('status', status);
  return fetch('/api/admin/books/eoi?' + params.toString(), signal ? { cache: 'no-store', signal } : { cache: 'no-store' });
}

// Load summary + the current page of rows. Runs only inside the authenticated
// admin content. `isRefresh` true => a filter/page/refresh action; false =>
// first load when the view is shown. Never throws: failures are contained to
// the books panel, and superseded requests never render anything.
function loadBooksDashboard(isRefresh) {
  const generation = ++booksLoadGeneration;
  booksSummaryGeneration += 1;
  const epoch = booksSessionEpoch;
  if (booksAbortController) booksAbortController.abort();
  booksAbortController = createBooksAbortController();
  const signal = booksAbortController ? booksAbortController.signal : undefined;

  booksError.hidden = true;
  booksError.textContent = '';
  booksStatus.textContent = isRefresh ? 'Loading book interest\u2026' : 'Loading book interest\u2026';
  booksRefresh.disabled = true;

  return Promise.all([
    fetch('/api/admin/books/eoi/summary', signal ? { cache: 'no-store', signal } : { cache: 'no-store' }),
    fetchBooksRows(signal)
  ])
    .then(async ([summaryRes, listRes]) => {
      if (isStaleBooksRequest(generation, epoch)) return;
      // Session ended mid-session: invalidate every pending request and
      // collapse to the login panel (mirrors the artwork 401 handling); do
      // not attempt to render PII.
      if (summaryRes.status === 401 || listRes.status === 401) {
        resetBooksSurface();
        adminContent.hidden = true;
        loginPanel.hidden = false;
        loginStatus.textContent = 'Session ended. Sign in again.';
        return;
      }
      if (!summaryRes.ok || !listRes.ok) throw new Error('Book interest request failed.');

      const summary = await summaryRes.json();
      const data = await listRes.json();
      if (isStaleBooksRequest(generation, epoch)) return;
      bookRows = Array.isArray(data && data.rows) ? data.rows : [];
      const total = Number(data && data.total);
      booksTotal = Number.isFinite(total) && total >= 0 ? total : bookRows.length;
      booksLoadedAt = new Date();
      booksLoadedOnce = true;

      renderBooksTiles(summary);
      renderBooksList();
      renderBooksPagination();
      booksStatus.textContent = 'Last updated ' + formatCreatedDate(booksLoadedAt) + '.';
    })
    .catch(() => {
      if (isStaleBooksRequest(generation, epoch)) return;
      showBooksDashboardError();
    })
    .finally(() => {
      if (isStaleBooksRequest(generation, epoch)) return;
      booksRefresh.disabled = false;
    });
}

// Non-blocking summary refresh used after a status PATCH so the tiles reflect
// the new counts without a full reload. Guarded by its own generation and the
// session epoch: a newer load or a logout renders nothing.
function refreshBooksSummary() {
  const generation = ++booksSummaryGeneration;
  const epoch = booksSessionEpoch;
  return fetch('/api/admin/books/eoi/summary', { cache: 'no-store' })
    .then((res) => {
      if (isStaleBooksSummary(generation, epoch)) return null;
      if (!res.ok) throw new Error('Book interest summary request failed.');
      return res.json();
    })
    .then((summary) => {
      if (isStaleBooksSummary(generation, epoch)) return;
      renderBooksTiles(summary);
    })
    .catch(() => {
      if (isStaleBooksSummary(generation, epoch)) return;
      showBooksDashboardError();
    });
}

function showBooksDashboardError() {
  // Clear row state before rendering so a summary invariant/render failure can
  // never leave decrypted contact details or stale update metadata in the DOM.
  bookRows = [];
  booksTotal = 0;
  booksLoadedAt = null;
  renderBooksList();
  renderBooksPagination();
  booksStatus.textContent = '';
  booksError.hidden = false;
  booksError.textContent = 'Could not load book interest. The artwork admin is unaffected.';
  renderBooksTiles(null);
}

// Render the summary tiles. Built entirely with DOM APIs (no innerHTML).
function renderBooksTiles(summary) {
  booksTiles.textContent = '';
  const tiles = buildSummaryTiles(summary);
  tiles.forEach((tile) => {
    const card = document.createElement('div');
    card.className = 'tile tile-' + tile.kind + ' tile-' + tile.key;

    const label = document.createElement('p');
    label.className = 'tile-label';
    label.textContent = tile.label;
    card.appendChild(label);

    const value = document.createElement('p');
    value.className = 'tile-value';
    const sub = document.createElement('p');
    sub.className = 'tile-sub';
    switch (tile.kind) {
      case 'book':
        value.textContent = String(tile.value) + ' interested';
        sub.textContent = String(tile.secondary) + ' copies requested';
        break;
      case 'window':
        value.textContent = String(tile.value) + ' submissions';
        sub.textContent = String(tile.secondary) + ' copies requested';
        break;
      case 'status':
        value.textContent = String(tile.value);
        sub.textContent = 'records';
        break;
      case 'total':
        value.textContent = String(tile.value);
        sub.textContent = 'one row per book interest';
        break;
      case 'distinct':
        value.textContent = String(tile.value);
        sub.textContent = 'people, counted once across both books';
        break;
      default:
        throw new Error('Unknown summary tile kind: ' + tile.kind);
    }
    card.appendChild(value);
    card.appendChild(sub);

    booksTiles.appendChild(card);
  });
}

// Render the loaded page applying the client-side name filter. Newest-first
// order comes from the API; filterRowsByName preserves it.
function renderBooksList() {
  booksTbody.textContent = '';
  const nameTerm = booksNameFilter.value;
  const filtered = filterRowsByName(bookRows, nameTerm);

  const offset = (booksListState.page - 1) * BOOKS_PAGE_SIZE;
  booksCount.textContent = booksRangeLabel(offset, bookRows.length, booksTotal);

  if (nameTerm.trim() !== '') {
    booksScopeNote.textContent = filtered.length === bookRows.length
      ? 'Name filter: all ' + filtered.length + ' loaded records match.'
      : 'Name filter: ' + filtered.length + ' of ' + bookRows.length + ' loaded records match.';
  } else {
    booksScopeNote.textContent = '';
  }

  if (!bookRows.length) {
    booksTbody.appendChild(emptyRow(booksListState.emailActive
      ? 'No records match that exact email address.'
      : 'No expressions of interest yet.'));
    return;
  }
  if (!filtered.length) {
    booksTbody.appendChild(emptyRow('No names on this loaded page match the filter.'));
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((row) => fragment.appendChild(renderBookRow(row)));
  booksTbody.appendChild(fragment);
}

// Server pagination: Previous / Page X of Y / Next, built with DOM APIs.
function renderBooksPagination() {
  booksPagination.textContent = '';
  const pageCount = Math.max(1, Math.ceil(booksTotal / BOOKS_PAGE_SIZE));
  if (pageCount <= 1) return;

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'button ghost-button page-button';
  prev.textContent = 'Previous';
  prev.disabled = booksListState.page <= 1;
  prev.addEventListener('click', () => {
    booksListState.page = Math.max(1, booksListState.page - 1);
    triggerBooksReload();
  });

  const label = document.createElement('span');
  label.className = 'page-label';
  label.textContent = 'Page ' + booksListState.page + ' of ' + pageCount;

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'button ghost-button page-button';
  next.textContent = 'Next';
  next.disabled = booksListState.page >= pageCount;
  next.addEventListener('click', () => {
    booksListState.page = Math.min(pageCount, booksListState.page + 1);
    triggerBooksReload();
  });

  booksPagination.append(prev, label, next);
}

function emptyRow(message) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 8;
  td.className = 'books-empty';
  td.textContent = message;
  tr.appendChild(td);
  return tr;
}

// Build one table row with ONLY textContent / property assignment. Each cell
// carries a data-label so the responsive CSS can rebuild it as a stacked card on
// narrow screens (320px / 393px / 200% zoom) without horizontal scroll.
function renderBookRow(row) {
  const tr = document.createElement('tr');
  tr.className = 'book-row book-row-' + (row.status || 'new');
  if (row.id) tr.dataset.id = row.id;

  tr.appendChild(textCell(formatCreatedDate(row.createdAt), 'Submitted'));
  tr.appendChild(textCell(row.name || '\u2014', 'Name'));

  // Email: safe mailto link via property assignment, never innerHTML.
  tr.appendChild(emailCell(row.email, 'Email'));

  tr.appendChild(textCell(formatBookLabel(row.book), 'Book'));
  tr.appendChild(textCell(formatFormatLabel(row.format), 'Format'));
  tr.appendChild(textCell(String(row.quantity == null ? '\u2014' : row.quantity), 'Copies'));
  tr.appendChild(statusCell(row.status, 'Status'));
  tr.appendChild(actionsCell(row));

  return tr;
}

function textCell(value, label) {
  const td = document.createElement('td');
  if (label) td.setAttribute('data-label', label);
  td.textContent = value == null ? '\u2014' : String(value);
  return td;
}

function emailCell(email, label) {
  const td = document.createElement('td');
  if (label) td.setAttribute('data-label', label);
  const href = safeMailtoHref(email);
  if (!href) {
    td.textContent = '\u2014';
    return td;
  }
  const anchor = document.createElement('a');
  anchor.href = href; // property assignment; encodeURIComponent neutralizes injection
  anchor.textContent = email; // safe: never interpreted as HTML
  td.appendChild(anchor);
  return td;
}

function statusCell(status, label) {
  const td = document.createElement('td');
  if (label) td.setAttribute('data-label', label);
  const badge = document.createElement('span');
  badge.className = 'status-badge status-badge-' + (status || 'new');
  badge.textContent = formatStatusLabel(status);
  td.appendChild(badge);
  return td;
}

// One button per status that is NOT the current status. Each button carries a
// descriptive accessible name including the person's name. Withdrawn asks for
// confirmation (it hides the interest from public counts). No DELETE control.
function actionsCell(row) {
  const td = document.createElement('td');
  td.className = 'books-actions';
  td.setAttribute('data-label', 'Actions');

  STATUS_ORDER.forEach((status) => {
    if (status === row.status) return;
    const who = row.name || 'this interest';
    const verb = status === 'new' ? 'Mark new' : status === 'contacted' ? 'Mark contacted' : 'Mark withdrawn';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ghost-button book-action' + (status === 'withdrawn' ? ' danger-button' : '');
    button.textContent = verb;
    button.setAttribute('aria-label', verb + ' \u2014 ' + who);
    button.dataset.action = status;
    button.addEventListener('click', () => patchBookStatus(row, status, button));
    td.appendChild(button);
  });
  return td;
}

// PATCH {status} only. Awaits the server (no optimistic UI): on failure the row
// is unchanged and the error stays visible. Sets aria-busy + disables the row's
// buttons while in flight. A response that lands after a newer load or after
// logout/session expiry is stale and renders NOTHING (no repopulation). On 401
// the session is collapsed to the login panel.
async function patchBookStatus(row, status, button) {
  if (status === 'withdrawn') {
    const who = row.name || 'this interest';
    if (!window.confirm('Mark ' + who + ' as withdrawn? It will stop counting in public totals. You can change it back later.')) {
      return;
    }
  }

  const generation = booksLoadGeneration;
  const epoch = booksSessionEpoch;
  const stale = () => isStaleBooksRequest(generation, epoch);

  const rowEl = button.closest('tr');
  if (rowEl) rowEl.setAttribute('aria-busy', 'true');
  setRowBusy(rowEl, true);
  booksStatus.textContent = 'Updating status\u2026';
  booksError.hidden = true;
  booksError.textContent = '';

  try {
    const response = await fetch('/api/admin/books/eoi/' + encodeURIComponent(row.id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (stale()) return;
    if (response.status === 401) {
      resetBooksSurface();
      adminContent.hidden = true;
      loginPanel.hidden = false;
      loginStatus.textContent = 'Session ended. Sign in again.';
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Status update failed.');
    }
    // Server confirmed: update the local row and re-render this view, then
    // refresh the tiles in the background.
    row.status = status;
    booksStatus.textContent = 'Status updated.';
    renderBooksList();
    refreshBooksSummary();
  } catch {
    if (stale()) return;
    booksStatus.textContent = '';
    booksError.hidden = false;
    booksError.textContent = 'Could not update status. The row is unchanged.';
  } finally {
    if (!stale()) {
      setRowBusy(rowEl, false);
      if (rowEl) rowEl.removeAttribute('aria-busy');
    }
  }
}

function setRowBusy(rowEl, busy) {
  if (!rowEl) return;
  rowEl.querySelectorAll('button').forEach((b) => {
    b.disabled = busy;
  });
}

// Clear all PII from the DOM on logout so nothing persists in the page. Auth is
// cookie-only, so there is nothing to clear from storage. This ALSO invalidates
// every in-flight or debounced Books request (load generation + session epoch +
// abort + pending debounce), so nothing that resolves later can repopulate the
// surface with decrypted PII or overwrite the login state.
function resetBooksSurface() {
  booksSessionEpoch += 1;
  booksLoadGeneration += 1;
  booksSummaryGeneration += 1;
  if (booksAbortController) {
    booksAbortController.abort();
    booksAbortController = null;
  }
  if (booksNameFilterTimer && booksDebounce) {
    booksDebounce.clear(booksNameFilterTimer);
    booksNameFilterTimer = 0;
  }
  bookRows = [];
  booksTotal = 0;
  booksLoadedAt = null;
  booksLoadedOnce = false;
  booksListState.book = 'all';
  booksListState.status = 'all';
  booksListState.page = 1;
  booksListState.email = '';
  booksListState.emailActive = false;
  if (booksEmail) booksEmail.value = '';
  if (booksNameFilter) booksNameFilter.value = '';
  if (booksFilterBook) booksFilterBook.value = 'all';
  if (booksFilterStatus) booksFilterStatus.value = 'all';
  if (booksScopeNote) booksScopeNote.textContent = '';
  if (booksCount) booksCount.textContent = '';
  if (booksPagination) booksPagination.textContent = '';
  if (booksStatus) booksStatus.textContent = '';
  if (booksError) {
    booksError.hidden = true;
    booksError.textContent = '';
  }
  if (booksTiles) booksTiles.textContent = '';
  if (booksTbody) booksTbody.textContent = '';
  if (booksPanel) booksPanel.hidden = true;
}
