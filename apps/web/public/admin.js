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
  const items = artworks.map((artwork, index) => ({ artwork, index })).filter(({ artwork }) => {
    if (!term) return true;
    return (artwork.title || '').toLowerCase().includes(term) || (artwork.catalogNumber || '').toLowerCase().includes(term);
  });

  if (!items.length) {
    artworkList.innerHTML = '<p class="empty-state">No artwork entries match.</p>';
    return;
  }

  items.forEach(({ artwork, index }) => {
    const card = document.createElement('article');
    card.className = 'draft-card';
    if (artwork.id === editingId) card.classList.add('editing');
    card.innerHTML = `
      <img src="${escapeAttribute(artwork.thumbnail || artwork.image)}" alt="${escapeAttribute(artwork.title)}">
      <h3>${escapeHtml(artwork.title)}</h3>
      <p class="card-meta">${escapeHtml(artwork.catalogNumber)} · ${escapeHtml(artwork.availability)} · #${artwork.sortOrder}</p>
      <div class="card-buttons">
        <button class="button ghost-button icon-button" type="button" data-move="up" ${index === 0 ? 'disabled' : ''}>Move up</button>
        <button class="button ghost-button icon-button" type="button" data-move="down" ${index === items.length - 1 ? 'disabled' : ''}>Move down</button>
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

loadArtworks();
