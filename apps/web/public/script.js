const galleryGrid = document.getElementById('gallery-grid');
const dialog = document.getElementById('painting-dialog');
const dialogClose = document.getElementById('dialog-close');
const dialogTitle = document.getElementById('dialog-title');
const dialogMedium = document.getElementById('dialog-medium');
const dialogSize = document.getElementById('dialog-size');
const dialogAvailability = document.getElementById('dialog-availability');
const dialogDescription = document.getElementById('dialog-description');
const dialogImage = document.getElementById('dialog-image');
const dialogInquire = document.getElementById('dialog-inquire');
const inquiryForm = document.getElementById('inquiry-form');
const paintingNameInput = document.getElementById('painting-name');
const dialogImageElement = document.createElement('img');

const contactEmail = 'mjdonnellan73@gmail.com';
let selectedPainting = '';

dialogImageElement.alt = '';
dialogImage.appendChild(dialogImageElement);

loadArtworks();

async function loadArtworks() {
  try {
    const response = await fetch(`/api/artworks?published=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Artwork data could not be loaded.');
    }

    const artworks = await response.json();
    renderGallery(artworks);
  } catch (error) {
    setupGalleryCards(document.querySelectorAll('.painting-card'));
  }
}

function renderGallery(artworks) {
  galleryGrid.innerHTML = '';

  artworks.forEach((artwork) => {
    const card = document.createElement('article');
    card.className = 'painting-card';
    card.role = 'button';
    card.setAttribute('aria-haspopup', 'dialog');
    card.setAttribute('aria-label', `View details for ${artwork.title}`);
    card.dataset.title = artwork.title;
    card.dataset.medium = artwork.medium;
    card.dataset.size = artwork.size;
    card.dataset.availability = artwork.availability;
    card.dataset.description = artwork.description;
    card.dataset.image = artwork.image;

    const imageClass = artwork.containImage ? 'painting-image painting-image-contained' : 'painting-image';
    card.innerHTML = `
      <div class="${imageClass}"></div>
      <div class="painting-card-body">
        <h3>${escapeHtml(artwork.title)}</h3>
        <p>${escapeHtml(artwork.cardNote)}</p>
        <span>${escapeHtml(artwork.availability)}</span>
      </div>
    `;
    galleryGrid.appendChild(card);
  });

  const placeholder = document.createElement('article');
  placeholder.className = 'painting-card painting-card-placeholder';
  placeholder.setAttribute('aria-label', 'More paintings will be added soon');
  placeholder.innerHTML = `
    <div class="painting-image painting-image-placeholder"></div>
    <div class="painting-card-body">
      <h3>More works soon</h3>
      <p>Additional paintings can be added as the collection grows.</p>
      <span>New uploads welcome</span>
    </div>
  `;
  galleryGrid.appendChild(placeholder);

  setupGalleryCards(galleryGrid.querySelectorAll('.painting-card'));
}

function setupGalleryCards(cards) {
  cards.forEach((card) => {
    const imageContainer = card.querySelector('.painting-image');
    if (!imageContainer || imageContainer.classList.contains('painting-image-placeholder')) return;

    const imageElement = document.createElement('img');
    imageElement.src = card.dataset.image;
    imageElement.alt = card.dataset.title || 'Artwork';
    imageContainer.style.backgroundImage = 'none';
    imageContainer.appendChild(imageElement);
  });

  cards.forEach((card) => {
    if (card.classList.contains('painting-card-placeholder')) return;

    card.addEventListener('click', () => openPaintingDialog(card));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPaintingDialog(card);
      }
    });
    card.tabIndex = 0;
  });
}

function openPaintingDialog(card) {
  const { title, medium, size, availability, description, image } = card.dataset;

  selectedPainting = title;
  dialogTitle.textContent = title;
  dialogMedium.textContent = medium;
  dialogSize.textContent = size;
  dialogAvailability.textContent = availability;
  dialogDescription.textContent = description;
  paintingNameInput.value = title;
  dialogImageElement.src = image;
  dialogImageElement.alt = title;

  dialog.showModal();
}

dialogClose.addEventListener('click', () => dialog.close());

dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  const isOutside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;

  if (isOutside) dialog.close();
});

dialogInquire.addEventListener('click', () => {
  paintingNameInput.value = selectedPainting;
  dialog.close();
  document.getElementById('contact').scrollIntoView({ behavior: 'smooth', block: 'start' });
  paintingNameInput.focus();
});

inquiryForm.addEventListener('submit', (event) => {
  event.preventDefault();

  const name = document.getElementById('customer-name').value.trim();
  const email = document.getElementById('customer-email').value.trim();
  const painting = paintingNameInput.value.trim();
  const message = document.getElementById('message').value.trim();

  const subject = encodeURIComponent(`Painting inquiry: ${painting}`);
  const body = encodeURIComponent(`Hello,\n\nMy name is ${name}.\nMy email is ${email}.\n\nI would like to ask about: ${painting}\n\n${message}`);

  window.location.href = `mailto:${contactEmail}?subject=${subject}&body=${body}`;
});

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
