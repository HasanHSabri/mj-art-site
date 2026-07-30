const imageOptions = [
  'WhatsApp Image 2026-03-30 at 4.41.17 PM.jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.17 PM (1).jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.20 PM.jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.21 PM.jpeg',
  '5.jpg',
  'WhatsApp Image 2026-03-30 at 4.41.21 PM (2).jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.21 PM (3).jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.22 PM.jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.22 PM (1).jpeg',
  'WhatsApp Image 2026-03-30 at 4.41.22 PM (2).jpeg',
  'WhatsApp Image 2026-03-30 at 6.48.50 PM.jpeg',
  'unnamed.jpg',
  '1.jpg',
  '2.jpg',
  '3.jpg',
  '4.jpg'
];

const storageKey = 'mj-art-admin-artworks';
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
const generatedJson = document.getElementById('generated-json');
const artworkList = document.getElementById('artwork-list');
const copyStatus = document.getElementById('copy-status');

let artworks = [];

imageOptions.forEach((fileName) => {
  const option = document.createElement('option');
  option.value = `./artwork/${encodePath(fileName)}`;
  document.getElementById('image-options').appendChild(option);
});

loadArtworks();

form.addEventListener('input', updatePreview);

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const artwork = readArtworkFromForm();
  const existingIndex = artworks.findIndex((item) => item.id === artwork.id);

  if (existingIndex >= 0) {
    artworks[existingIndex] = artwork;
  } else {
    artworks.push(artwork);
  }

  saveLocalArtworks();
  renderArtworkList();
  updateGeneratedJson();
  copyStatus.textContent = 'Change saved locally. Copy the JSON when you are ready to publish it.';
});

document.getElementById('new-artwork').addEventListener('click', () => {
  form.reset();
  fields.id.value = '';
  updatePreview();
  copyStatus.textContent = '';
});

document.getElementById('reset-form').addEventListener('click', () => {
  form.reset();
  fields.id.value = '';
  updatePreview();
  copyStatus.textContent = '';
});

document.getElementById('copy-json').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(generatedJson.value);
    copyStatus.textContent = 'Updated artworks.json copied.';
  } catch (error) {
    generatedJson.select();
    document.execCommand('copy');
    copyStatus.textContent = 'Updated artworks.json selected and copied.';
  }
});

document.getElementById('reset-data').addEventListener('click', async () => {
  if (!window.confirm('Reset local admin edits and reload the published artwork data?')) {
    return;
  }

  localStorage.removeItem(storageKey);
  await loadArtworks({ forcePublished: true });
  copyStatus.textContent = 'Local edits reset.';
});

async function loadArtworks(options = {}) {
  if (!options.forcePublished) {
    const localArtworks = loadLocalArtworks();
    if (localArtworks.length) {
      artworks = localArtworks;
      writeArtworkToForm(artworks[0]);
      renderArtworkList();
      updateGeneratedJson();
      return;
    }
  }

  try {
    const response = await fetch('./artworks.json');
    if (!response.ok) {
      throw new Error('Artwork data could not be loaded.');
    }

    artworks = await response.json();
  } catch (error) {
    artworks = [];
    copyStatus.textContent = 'Could not load artworks.json. You can still create new local entries.';
  }

  if (artworks.length) {
    writeArtworkToForm(artworks[0]);
  } else {
    updatePreview();
  }

  renderArtworkList();
  updateGeneratedJson();
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
  preview.image.innerHTML = artwork.image
    ? `<img src="${escapeAttribute(artwork.image)}" alt="${escapeAttribute(artwork.title)}">`
    : '';
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
    removeButton.addEventListener('click', () => removeArtwork(index));
    artworkList.appendChild(card);
  });
}

function removeArtwork(index) {
  if (!window.confirm(`Remove ${artworks[index].title} from the local artwork data?`)) {
    return;
  }

  artworks.splice(index, 1);
  saveLocalArtworks();
  renderArtworkList();
  updateGeneratedJson();

  if (artworks.length) {
    writeArtworkToForm(artworks[Math.max(0, index - 1)]);
  } else {
    form.reset();
    fields.id.value = '';
    updatePreview();
  }
}

function updateGeneratedJson() {
  generatedJson.value = JSON.stringify(artworks, null, 2);
}

function loadLocalArtworks() {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || [];
  } catch (error) {
    return [];
  }
}

function saveLocalArtworks() {
  localStorage.setItem(storageKey, JSON.stringify(artworks));
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `painting-${Date.now()}`;
}

function encodePath(fileName) {
  return fileName.split('/').map(encodeURIComponent).join('/');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}
