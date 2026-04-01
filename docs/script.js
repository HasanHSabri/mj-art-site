const galleryCards = document.querySelectorAll('.painting-card');
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

const contactEmail = 'mjdonnellan73@gmail.com';
let selectedPainting = '';

function openPaintingDialog(card) {
  const { title, medium, size, availability, description, image, imageFit } = card.dataset;

  selectedPainting = title;
  dialogTitle.textContent = title;
  dialogMedium.textContent = medium;
  dialogSize.textContent = size;
  dialogAvailability.textContent = availability;
  dialogDescription.textContent = description;
  paintingNameInput.value = title;
  dialogImage.style.backgroundImage = `url("${image}")`;
  dialogImage.classList.toggle('dialog-image-contained', imageFit === 'contain');

  dialog.showModal();
}

galleryCards.forEach((card) => {
  card.addEventListener('click', () => openPaintingDialog(card));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPaintingDialog(card);
    }
  });
  card.tabIndex = 0;
});

dialogClose.addEventListener('click', () => dialog.close());

dialog.addEventListener('click', (event) => {
  const rect = dialog.getBoundingClientRect();
  const isOutside =
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom;

  if (isOutside) {
    dialog.close();
  }
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
  const body = encodeURIComponent(
    `Hello,\n\n` +
    `My name is ${name}.\n` +
    `My email is ${email}.\n\n` +
    `I would like to ask about: ${painting}\n\n` +
    `${message}`
  );

  window.location.href = `mailto:${contactEmail}?subject=${subject}&body=${body}`;
});
