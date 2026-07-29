const loginPanel = document.getElementById('login-panel');
const adminContent = document.getElementById('admin-content');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const imageUpload = document.getElementById('image-upload');
const uploadStatus = document.getElementById('upload-status');
const form = document.getElementById('artwork-form');
const fields = {
  id: document.getElementById('artwork-id'),
  title: document.getElementById('title'),
  image: document.getElementById('image'),
  medium: document.getElementById('medium'),
  size: document.getElementById('size'),
  availability: document.getElementById('availability'),
  containImage: document.getElementById('contain-image'),
  cardNote: document.getElementById('card-note'),
  description: document.getElementById('description')
};
const preview = {
  title: document.getElementById('preview-title'),
  image: document.getElementById('preview-image'),
  medium: document.getElementById('preview-medium'),
  size: document.getElementById('preview-size'),
  availability: document.getElementById('preview-availability'),
  description: document.getElementById('preview-description')
};
const artworkList = document.getElementById('artwork-list');
const saveStatus = document.getElementById('save-status');

let artworks = [];

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
});

form.addEventListener('input', updatePreview);

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const artwork = readArtworkFromForm();
  const existingIndex = artworks.findIndex((item) => item.id === artwork.id);

  if (existingIndex >= 0) {
    artworks[existingIndex] = artwork;
  } else {
    artworks.push(artwork);
  }

  await saveArtworks();
  renderArtworkList();
  writeArtworkToForm(artwork);
});

imageUpload.addEventListener('change', async () => {
  const file = imageUpload.files[0];
  if (!file) return;

  uploadStatus.textContent = 'Uploading image...';
  const data = new FormData();
  data.append('image', file);

  const response = await fetch('/api/admin/upload', { method: 'POST', body: data });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    uploadStatus.textContent = body.error || 'Image upload failed.';
    return;
  }

  fields.image.value = body.image;
  updatePreview();
  uploadStatus.textContent = 'Image uploaded and selected.';
});

document.getElementById('new-artwork').addEventListener('click', () => {
  form.reset();
  fields.id.value = '';
  updatePreview();
  saveStatus.textContent = '';
});

document.getElementById('reset-form').addEventListener('click', () => {
  form.reset();
  fields.id.value = '';
  updatePreview();
  saveStatus.textContent = '';
});

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
    updatePreview();
  }

  renderArtworkList();
}

async function saveArtworks() {
  saveStatus.textContent = 'Saving to public gallery...';
  const response = await fetch('/api/admin/artworks', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(artworks)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    saveStatus.textContent = body.error || 'Save failed.';
    return;
  }

  artworks = body.artworks;
  saveStatus.textContent = 'Saved. The public gallery is updated.';
}

function readArtworkFromForm() {
  const title = fields.title.value.trim() || 'Untitled painting';

  return {
    id: fields.id.value || slugify(title),
    title,
    image: fields.image.value.trim(),
    medium: fields.medium.value.trim() || 'To be added',
    size: fields.size.value.trim() || 'To be added',
    availability: fields.availability.value.trim() || 'To be added',
    cardNote: fields.cardNote.value.trim() || 'Details to be added',
    description: fields.description.value.trim() || 'Artwork details to be added later.',
    containImage: fields.containImage.checked
  };
}

function writeArtworkToForm(artwork) {
  fields.id.value = artwork.id;
  fields.title.value = artwork.title;
  fields.image.value = artwork.image;
  fields.medium.value = artwork.medium;
  fields.size.value = artwork.size;
  fields.availability.value = artwork.availability;
  fields.cardNote.value = artwork.cardNote;
  fields.description.value = artwork.description;
  fields.containImage.checked = Boolean(artwork.containImage);
  updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updatePreview() {
  const artwork = readArtworkFromForm();
  const imageClass = artwork.containImage ? ' contain' : '';

  preview.title.textContent = artwork.title;
  preview.image.className = `preview-image${imageClass}`;
  preview.image.innerHTML = artwork.image ? `<img src="${escapeAttribute(artwork.image)}" alt="${escapeAttribute(artwork.title)}">` : '';
  preview.medium.textContent = artwork.medium;
  preview.size.textContent = artwork.size;
  preview.availability.textContent = artwork.availability;
  preview.description.textContent = artwork.description;
}

function renderArtworkList() {
  artworkList.innerHTML = '';

  if (!artworks.length) {
    artworkList.innerHTML = '<p class="empty-state">No artwork entries yet.</p>';
    return;
  }

  artworks.forEach((artwork, index) => {
    const card = document.createElement('article');
    card.className = 'draft-card';
    card.innerHTML = `
      <img src="${escapeAttribute(artwork.image)}" alt="${escapeAttribute(artwork.title)}">
      <h3>${escapeHtml(artwork.title)}</h3>
      <p>${escapeHtml(artwork.availability)}</p>
      <button class="button ghost-button" type="button">Edit</button>
      <button class="button danger-button" type="button">Remove</button>
    `;
    const [editButton, removeButton] = card.querySelectorAll('button');
    editButton.addEventListener('click', () => writeArtworkToForm(artwork));
    removeButton.addEventListener('click', async () => removeArtwork(index));
    artworkList.appendChild(card);
  });
}

async function removeArtwork(index) {
  if (!window.confirm(`Remove ${artworks[index].title} from the public gallery?`)) return;

  artworks.splice(index, 1);
  await saveArtworks();
  renderArtworkList();

  if (artworks.length) {
    writeArtworkToForm(artworks[Math.max(0, index - 1)]);
  } else {
    form.reset();
    fields.id.value = '';
    updatePreview();
  }
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `painting-${Date.now()}`;
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

loadArtworks();
