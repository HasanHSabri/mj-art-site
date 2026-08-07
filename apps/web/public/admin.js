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
  reorder
} from './admin-artwork.js';
import {
  STATUS_ORDER,
  formatBookLabel,
  formatFormatLabel,
  formatStatusLabel,
  formatCreatedDate,
  safeMailtoHref,
  buildSummaryTiles,
  filterRows
} from './admin-books.js';

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const FULL_MAX_DIMENSION = 2000;
const THUMB_MAX_DIMENSION = 640;

const loginPanel = document.getElementById('login-panel');
const adminContent = document.getElementById('admin-content');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');

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
const reorderNote = document.getElementById('reorder-note');

let artworks = [];
let editingId = null;

populateSizeCategoryOptions();
updateOrientation();
updateSizeCategoryLock();

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
  await loadArtworks();
});

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  resetBooksSurface();
  adminContent.hidden = true;
  loginPanel.hidden = false;
  loginStatus.textContent = '';
});

form.addEventListener('input', () => {
  updateOrientation();
  updatePreview();
});

fields.category.addEventListener('change', () => {
  updateSizeCategoryLock();
  updatePreview();
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
    artworks = previousArtworks;
    renderArtworkList();
    return;
  }

  renderArtworkList();
  writeArtworkToForm(record);
});

document.getElementById('new-artwork').addEventListener('click', () => resetForm('Ready to add a new painting.'));
document.getElementById('reset-form').addEventListener('click', () => resetForm('Form cleared.'));
artworkSearch.addEventListener('input', renderArtworkList);

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
    loginPanel.hidden = false;
    adminContent.hidden = true;
    return;
  }
  artworks = await response.json();
  loginPanel.hidden = true;
  adminContent.hidden = false;
  if (artworks.length) {
    writeArtworkToForm(artworks[0]);
  } else {
    resetForm('No artwork yet. Add the first painting.');
  }
  renderArtworkList();
  // Load the Books dashboard only now that admin auth is confirmed. A Books
  // failure is contained inside loadBooksDashboard (panel error) and must never
  // break the artwork admin above.
  loadBooksDashboard(false);
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

  provenanceSummaryEl.textContent = provenanceSummary(record.provenance);
  provenanceBlock.hidden = false;

  updateSizeCategoryLock();
  updateOrientation();
  updatePreview();
  clearFormErrors();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm(statusMessage) {
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

  preview.medium.textContent = fields.medium.value.trim() || '—';
  preview.size.textContent = record ? (record.dimensions.label || '—') : (deriveDimensionsLabel(width, height) || '—');
  preview.availability.textContent = fields.availability.value || '—';
  const amount = parseOptionalNumber(fields.priceAmount.value);
  preview.price.textContent = amount ? `$${amount}${fields.priceNote.value.trim() ? ` (${fields.priceNote.value.trim()})` : ''}` : 'Price on enquiry';
  preview.description.textContent = fields.description.value.trim() || 'Artwork description preview.';
}

function parseOptionalNumber(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function renderArtworkList() {
  artworkList.innerHTML = '';
  const term = artworkSearch.value.trim().toLowerCase();
  const isFiltered = !!term;
  const items = artworks.map((artwork, index) => ({ artwork, index })).filter(({ artwork }) => {
    if (!term) return true;
    return (artwork.title || '').toLowerCase().includes(term) || (artwork.catalogNumber || '').toLowerCase().includes(term);
  });

  if (isFiltered) {
    reorderNote.textContent = 'Search is active. Clear the search to reorder items.';
  } else if (!reorderNote.textContent || reorderNote.textContent.includes('Search is active')) {
    reorderNote.textContent = '';
  }

  if (!items.length) {
    artworkList.innerHTML = '<p class="empty-state">No artwork entries match.</p>';
    return;
  }

  items.forEach(({ artwork, index }) => {
    const card = document.createElement('article');
    card.className = 'draft-card';
    if (artwork.id === editingId) card.classList.add('editing');
    const moveUpDisabled = isFiltered || index === 0;
    const moveDownDisabled = isFiltered || index === artworks.length - 1;
    card.innerHTML = `
      <img src="${escapeAttribute(artwork.thumbnail || artwork.image)}" alt="${escapeAttribute(artwork.title)}">
      <h3>${escapeHtml(artwork.title)}</h3>
      <p class="card-meta">${escapeHtml(artwork.catalogNumber)} · ${escapeHtml(artwork.availability)} · #${artwork.sortOrder}</p>
      <div class="card-buttons">
        <button class="button ghost-button icon-button" type="button" data-move="up" ${moveUpDisabled ? 'disabled' : ''}>Move up</button>
        <button class="button ghost-button icon-button" type="button" data-move="down" ${moveDownDisabled ? 'disabled' : ''}>Move down</button>
      </div>
      <div class="card-buttons">
        <button class="button ghost-button" type="button" data-edit>Edit</button>
        <button class="button danger-button" type="button" data-remove>Remove</button>
      </div>
    `;
    card.querySelector('[data-edit]').addEventListener('click', () => writeArtworkToForm(artwork));
    card.querySelector('[data-remove]').addEventListener('click', () => removeArtwork(index));
    card.querySelector('[data-move="up"]').addEventListener('click', () => moveArtwork(index, 'up'));
    card.querySelector('[data-move="down"]').addEventListener('click', () => moveArtwork(index, 'down'));
    artworkList.appendChild(card);
  });
}

async function moveArtwork(index, direction) {
  const moved = reorder(artworks, index, direction);
  if (moved === artworks) return;
  const previousArtworks = artworks.map(cloneRecord);
  artworks = renumber(moved);
  reorderNote.textContent = `Moved ${artworks[index] ? artworks[index].title : 'item'} ${direction}. Saving new order...`;
  renderArtworkList();
  const saved = await saveArtworks(null);
  if (!saved) {
    artworks = previousArtworks;
    renderArtworkList();
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
    renderArtworkList();
    reorderNote.textContent = 'Remove failed.';
    return;
  }
  renderArtworkList();
  if (editingId === target.id) {
    if (artworks.length) {
      writeArtworkToForm(artworks[Math.max(0, index - 1)]);
    } else {
      resetForm('No artwork left. Add a new painting.');
    }
  }
  reorderNote.textContent = '';
}

function populateSizeCategoryOptions() {
  const select = fields.sizeCategory;
  CANONICAL_SIZES.forEach((size) => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    select.appendChild(option);
  });
}

function showFormErrors(errors) {
  formErrors.hidden = false;
  formErrors.innerHTML = errors.map((message) => `<li>${escapeHtml(message)}</li>`).join('');
  saveStatus.textContent = 'Please fix the highlighted fields.';
}

function clearFormErrors() {
  formErrors.hidden = true;
  formErrors.innerHTML = '';
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

// ===========================================================================
// Books EOI dashboard
// ===========================================================================
// SECURITY CONTRACT (enforced here and by the tests in admin-books.test.js):
//   * This dashboard loads ONLY after authenticated admin status is confirmed
//     (loadArtworks has set adminContent.hidden = false). A Books API failure
//     surfaces a panel error and never breaks the artwork admin.
//   * Auth uses the existing HttpOnly session cookie set by the server. No PII
//     is ever written to localStorage/sessionStorage or logged.
//   * Every PII value is rendered with textContent / DOM property assignment.
//     There is NO innerHTML / insertAdjacentHTML anywhere in this section. The
//     mailto link is built from safeMailtoHref() and assigned to <a>.href.
//   * The only mutation is PATCH {status}; there is no DELETE path or button.
//     Status updates await the server (no optimistic UI) so rollback is robust;
//     on failure the row is left unchanged and the error stays visible.
//   * resetBooksSurface() clears all PII from the DOM on logout.

const booksPanel = document.getElementById('books-dashboard');
const booksStatus = document.getElementById('books-status');
const booksError = document.getElementById('books-error');
const booksTiles = document.getElementById('books-tiles');
const booksTbody = document.getElementById('books-tbody');
const booksSearch = document.getElementById('books-search');
const booksFilterBook = document.getElementById('books-filter-book');
const booksFilterStatus = document.getElementById('books-filter-status');
const booksRefresh = document.getElementById('books-refresh');

let bookRows = [];
let booksLoadedAt = null;

booksSearch.addEventListener('input', renderBooksList);
booksFilterBook.addEventListener('change', renderBooksList);
booksFilterStatus.addEventListener('change', renderBooksList);
booksRefresh.addEventListener('click', () => loadBooksDashboard(true));

// Load summary + recent rows. Runs only inside the authenticated admin content.
// `isRefresh` true => a manual refresh; false => first load after sign-in.
// Never throws: a failure is contained to the books panel.
function loadBooksDashboard(isRefresh) {
  booksPanel.hidden = false;
  booksError.hidden = true;
  booksError.textContent = '';
  booksStatus.textContent = isRefresh ? 'Refreshing book interest…' : 'Loading book interest…';
  booksRefresh.disabled = true;

  return Promise.all([
    fetch('/api/admin/books/eoi/summary', { cache: 'no-store' }),
    fetch('/api/admin/books/eoi?limit=100', { cache: 'no-store' })
  ])
    .then(async ([summaryRes, listRes]) => {
      // Session ended mid-session: collapse to the login panel (mirrors the
      // artwork 401 handling) and do not attempt to render PII.
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
      bookRows = Array.isArray(data && data.rows) ? data.rows : [];
      booksLoadedAt = new Date();

      renderBooksTiles(summary);
      renderBooksList();
      booksStatus.textContent = 'Last updated ' + formatCreatedDate(booksLoadedAt) + '.';
    })
    .catch(() => {
      // Contained failure: show a panel error, clear stale PII, leave the
      // artwork admin untouched.
      bookRows = [];
      booksLoadedAt = null;
      renderBooksTiles(null);
      renderBooksList();
      booksStatus.textContent = '';
      booksError.hidden = false;
      booksError.textContent = 'Could not load book interest. The artwork admin is unaffected.';
    })
    .finally(() => {
      booksRefresh.disabled = false;
    });
}

// Best-effort, non-blocking summary refresh used after a status PATCH so the
// tiles reflect the new counts without a full reload. Failures are swallowed so
// a tile refresh glitch never disturbs an in-progress status update.
function refreshBooksSummary() {
  fetch('/api/admin/books/eoi/summary', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((summary) => {
      if (summary) renderBooksTiles(summary);
    })
    .catch(() => {});
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
        sub.textContent = 'all records';
        break;
      default:
        throw new Error('Unknown summary tile kind: ' + tile.kind);
    }
    card.appendChild(value);
    card.appendChild(sub);

    booksTiles.appendChild(card);
  });
}

// Render the recent list applying the current client filters. Newest-first
// order comes from the API; filterRows preserves it.
function renderBooksList() {
  booksTbody.textContent = '';
  const filtered = filterRows(bookRows, {
    term: booksSearch.value,
    book: booksFilterBook.value,
    status: booksFilterStatus.value
  });

  if (!bookRows.length) {
    booksTbody.appendChild(emptyRow('No expressions of interest yet.'));
    return;
  }
  if (!filtered.length) {
    booksTbody.appendChild(emptyRow('No submissions match the current filters.'));
    return;
  }

  const fragment = document.createDocumentFragment();
  filtered.forEach((row) => fragment.appendChild(renderBookRow(row)));
  booksTbody.appendChild(fragment);
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
  tr.appendChild(textCell(row.name || '—', 'Name'));

  // Email: safe mailto link via property assignment, never innerHTML.
  tr.appendChild(emailCell(row.email, 'Email'));

  tr.appendChild(textCell(formatBookLabel(row.book), 'Book'));
  tr.appendChild(textCell(formatFormatLabel(row.format), 'Format'));
  tr.appendChild(textCell(String(row.quantity == null ? '—' : row.quantity), 'Copies'));
  tr.appendChild(statusCell(row.status, 'Status'));
  tr.appendChild(actionsCell(row));

  return tr;
}

function textCell(value, label) {
  const td = document.createElement('td');
  if (label) td.setAttribute('data-label', label);
  td.textContent = value == null ? '—' : String(value);
  return td;
}

function emailCell(email, label) {
  const td = document.createElement('td');
  if (label) td.setAttribute('data-label', label);
  const href = safeMailtoHref(email);
  if (!href) {
    td.textContent = '—';
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
    button.setAttribute('aria-label', verb + ' — ' + who);
    button.dataset.action = status;
    button.addEventListener('click', () => patchBookStatus(row, status, button));
    td.appendChild(button);
  });
  return td;
}

// PATCH {status} only. Awaits the server (no optimistic UI): on failure the row
// is unchanged and the error stays visible. Sets aria-busy + disables the row's
// buttons while in flight. On 401 the session is collapsed to the login panel.
async function patchBookStatus(row, status, button) {
  if (status === 'withdrawn') {
    const who = row.name || 'this interest';
    if (!window.confirm('Mark ' + who + ' as withdrawn? It will stop counting in public totals. You can change it back later.')) {
      return;
    }
  }

  const rowEl = button.closest('tr');
  if (rowEl) rowEl.setAttribute('aria-busy', 'true');
  setRowBusy(rowEl, true);
  booksStatus.textContent = 'Updating status…';
  booksError.hidden = true;
  booksError.textContent = '';

  try {
    const response = await fetch('/api/admin/books/eoi/' + encodeURIComponent(row.id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status })
    });
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
    booksStatus.textContent = '';
    booksError.hidden = false;
    booksError.textContent = 'Could not update status. The row is unchanged.';
  } finally {
    setRowBusy(rowEl, false);
    if (rowEl) rowEl.removeAttribute('aria-busy');
  }
}

function setRowBusy(rowEl, busy) {
  if (!rowEl) return;
  rowEl.querySelectorAll('button').forEach((b) => {
    b.disabled = busy;
  });
}

// Clear all PII from the DOM on logout so nothing persists in the page. Auth is
// cookie-only, so there is nothing to clear from storage.
function resetBooksSurface() {
  bookRows = [];
  booksLoadedAt = null;
  if (booksSearch) booksSearch.value = '';
  if (booksFilterBook) booksFilterBook.value = 'all';
  if (booksFilterStatus) booksFilterStatus.value = 'all';
  if (booksStatus) booksStatus.textContent = '';
  if (booksError) {
    booksError.hidden = true;
    booksError.textContent = '';
  }
  if (booksTiles) booksTiles.textContent = '';
  if (booksTbody) booksTbody.textContent = '';
  if (booksPanel) booksPanel.hidden = true;
}

loadArtworks();
