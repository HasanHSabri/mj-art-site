// Home page client (progressive enhancement).
//
// ES module. Home renders exactly the first 6 public artworks as SSR anchor
// cards that link to /gallery (no dialog, no filters, no client catalogue
// fetch). This script powers only the Home contact form's mailto inquiry and
// the shared Back to Top control. It NEVER fetches /api/artworks.

import { buildInquiryMailto } from './gallery-display.js';
import { initBackToTop } from './back-to-top.js';

const CONTACT_EMAIL = 'mjdonnellan73@gmail.com';

const inquiryForm = document.getElementById('inquiry-form');
const paintingNameInput = document.getElementById('painting-name');
const contactStatus = document.getElementById('contact-status');

init();

function init() {
  initBackToTop();
  if (!inquiryForm) return;

  inquiryForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const name = document.getElementById('customer-name').value.trim();
    const customerEmail = document.getElementById('customer-email').value.trim();
    const painting = paintingNameInput ? paintingNameInput.value.trim() : '';
    const message = document.getElementById('message').value.trim();

    if (contactStatus) {
      contactStatus.textContent = 'Opening your email app...';
    }

    window.location.href = buildInquiryMailto({
      email: CONTACT_EMAIL,
      name,
      customerEmail,
      painting,
      message
    });
  });
}
