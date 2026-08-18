// Books Expression of Interest client (progressive enhancement, no framework).
//
// Responsibilities:
//   - explicitly render the Cloudflare Turnstile widget (site key injected into
//     the DOM by the Worker; never hardcoded here) and capture its token
//   - wire the one-or-both book checkboxes to their per-book estimated-copies
//     controls (hidden + disabled while unselected, revealed + enabled when
//     checked; an unselected book's quantity is never submitted)
//   - preselect a book checkbox from a validated ?book=<code> query param
//   - robustly submit the EOI to POST /api/books/eoi as
//     { interests: [{ book, quantity }], name, email, consent, turnstileToken },
//     handling 400/413/429/503 and generic errors WITHOUT leaking server
//     detail and preventing duplicate submits
//   - power the page's "Back to Top" control (shared implementation; targets
//     the Books page top)
//
// The page no longer fetches or renders public interest counters: live counts
// are private admin data. No mail fallback, no localStorage, no R2 fallback.
// The pure helpers below are exported so the mapping/validation logic is
// unit-testable without a DOM.

import { initBackToTop } from './back-to-top.js';

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no network)
// ---------------------------------------------------------------------------

// Canonical quantity window mirrors the backend CHECK (1..10, integer).
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;

// Canonical book values MUST match the backend allowlist. These are the
// non-secret contract values, not operator data. The visitor form sends the
// interests array only: one entry per checked book, no top-level book/quantity.
export const BOOK_VALUES = ['biography', 'childrens'];

// Build the exact JSON payload to POST. `selections` carries one entry per
// checkbox: { book, checked, quantity }. Only checked books are included; an
// invalid quantity on ANY checked book rejects the whole payload. Consent is
// required and sent as the boolean true (matches the server-side strict
// check). A non-empty honeypot is forwarded so the backend can accept it
// silently as a bot trap. Returns null when a client-side guard fails (no
// book checked / bad quantity / missing name, email, consent, or token).
export function buildEoiPayload(values) {
  const v = values || {};
  const selections = Array.isArray(v.selections) ? v.selections : [];

  const interests = [];
  for (const sel of selections) {
    if (!sel || sel.checked !== true) continue;
    if (!BOOK_VALUES.includes(sel.book)) return null;
    const quantity = toInt(sel.quantity);
    if (quantity === null || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) return null;
    interests.push({ book: sel.book, quantity });
  }
  if (interests.length === 0) return null;

  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const email = typeof v.email === 'string' ? v.email.trim() : '';
  const consent = v.consent === true;
  const turnstileToken = typeof v.turnstileToken === 'string' ? v.turnstileToken : '';

  if (name.length === 0) return null;
  if (email.length === 0) return null;
  if (!consent) return null;
  if (turnstileToken.length === 0) return null;

  const payload = {
    interests,
    name,
    email,
    consent: true,
    turnstileToken
  };
  if (typeof v.website === 'string' && v.website.length > 0) payload.website = v.website;
  return payload;
}

// Map an HTTP status to a safe, non-leaking user-facing message. The response
// body is NEVER surfaced: only a generic, actionable message per status.
export function messageForStatus(status) {
  switch (status) {
    case 200:
      return '';
    case 400:
      return 'Please check your details and try again.';
    case 413:
      return 'That submission is too large. Please shorten it and try again.';
    case 429:
      return 'You have sent a few too many. Please try again shortly.';
    case 503:
      return 'This service is not available right now. Please try again later.';
    default:
      return 'Something went wrong. Please try again later.';
  }
}

// True when a selections list has no checked book at all (used to focus the
// checkbox group with a specific, useful validation message).
export function hasNoSelection(values) {
  const selections = values && Array.isArray(values.selections) ? values.selections : [];
  return !selections.some((sel) => sel && sel.checked === true);
}

// Validate a ?book=<code> query value against the canonical allowlist. Returns
// the canonical book value when valid, or '' when absent/invalid, so an invalid
// or missing value leaves existing behaviour unchanged.
export function parseBookQuery(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  return BOOK_VALUES.includes(v) ? v : '';
}

function toInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOM bootstrap (browser only)
// ---------------------------------------------------------------------------

const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const EOI_URL = '/api/books/eoi';

function init() {
  const form = document.getElementById('books-eoi-form');
  if (!form) return;

  const els = readElements(form);
  let turnstileToken = '';
  let turnstileWidgetId = null;
  let submitting = false;

  initTurnstile(els, {
    onToken: (token) => {
      turnstileToken = token || '';
    },
    onReset: () => {
      turnstileToken = '';
    },
    register: (id) => {
      turnstileWidgetId = id;
    }
  });
  initBackToTop();

  // Reveal/hide each book's quantity control as its checkbox changes. The
  // initial sync runs after preselection so a ?book= deep link lands with its
  // quantity already visible and enabled.
  for (const checkbox of els.checkboxes) {
    checkbox.addEventListener('change', () => syncQuantities(els));
  }
  applyBookPreselection(form, { focus: true });
  syncQuantities(els);
  window.addEventListener('popstate', () => {
    applyBookPreselection(form, { focus: false });
    syncQuantities(els);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    const raw = {
      selections: readSelections(els),
      name: els.name ? els.name.value : '',
      email: els.email ? els.email.value : '',
      consent: els.consent ? els.consent.checked : false,
      turnstileToken,
      website: els.honeypot ? els.honeypot.value : ''
    };

    if (hasNoSelection(raw)) {
      announce(els.status, 'Please choose at least one book to join the update list.');
      if (els.checkboxes.length > 0) {
        try {
          els.checkboxes[0].focus({ preventScroll: false });
        } catch {
          els.checkboxes[0].focus();
        }
      }
      return;
    }

    const payload = buildEoiPayload(raw);
    if (!payload) {
      announce(els.status, 'Please complete every field, including consent and verification.');
      return;
    }

    submitting = true;
    setSubmitting(els.submit, true);
    announce(els.status, 'Sending your expression of interest...');

    try {
      const res = await fetch(EOI_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        announce(els.status, 'Thank you. Your interest has been recorded. We will be in touch with updates about the book(s) you selected.');
        resetForm(els.form);
        syncQuantities(els);
        resetTurnstile(turnstileWidgetId);
        turnstileToken = '';
      } else {
        announce(els.status, messageForStatus(res.status));
      }
    } catch {
      announce(els.status, messageForStatus(0));
    } finally {
      submitting = false;
      setSubmitting(els.submit, false);
    }
  });
}

function readElements(form) {
  return {
    form,
    checkboxes: [...form.querySelectorAll('input[name="books"]')],
    qtyContainers: [...form.querySelectorAll('.books-qty')],
    name: document.getElementById('books-name'),
    email: document.getElementById('books-email'),
    consent: document.getElementById('books-consent'),
    honeypot: form.querySelector('[name="website"]'),
    submit: document.getElementById('books-submit'),
    status: document.getElementById('books-status'),
    turnstileBox: document.getElementById('books-turnstile')
  };
}

// One selection per checkbox, pairing the checkbox state with its own
// quantity input value (an unselected book's quantity is simply never read).
function readSelections(els) {
  return els.checkboxes.map((checkbox) => ({
    book: checkbox.value,
    checked: checkbox.checked === true,
    quantity: quantityInputFor(els, checkbox.value)?.value ?? ''
  }));
}

function quantityInputFor(els, book) {
  const container = els.qtyContainers.find((c) => c.dataset.qtyFor === book);
  return container ? container.querySelector('input[type="number"]') : null;
}

// Keep every quantity control in step with its checkbox: hidden + disabled
// while unselected (out of the a11y tree and tab order), revealed + enabled
// when checked. form.reset() restores checkbox state but not the disabled
// property, so this re-runs after every reset.
function syncQuantities(els) {
  for (const container of els.qtyContainers) {
    const book = container.dataset.qtyFor;
    const checkbox = els.checkboxes.find((c) => c.value === book);
    const input = container.querySelector('input[type="number"]');
    if (!checkbox || !input) continue;
    const selected = checkbox.checked === true;
    container.hidden = !selected;
    input.disabled = !selected;
  }
}

// Preselect the book checkbox from a validated ?book=<canonical> param. On the
// initial load (opts.focus === true) the selected checkbox also receives focus
// so keyboard users land on the form; on history navigation focus is left to
// the browser so back/forward are not harmed. An invalid/missing value is a
// no-op; the other checkbox always remains available.
function applyBookPreselection(form, opts) {
  const focus = opts && opts.focus === true;
  const params = new URLSearchParams(window.location.search);
  const book = parseBookQuery(params.get('book'));
  if (!book) return false;
  const checkbox = form.querySelector(`input[name="books"][value="${book}"]`);
  if (!checkbox) return false;
  if (!checkbox.checked) checkbox.checked = true;
  if (focus) {
    try {
      checkbox.focus({ preventScroll: true });
    } catch {
      checkbox.focus();
    }
  }
  return true;
}

// Explicitly load + render the Turnstile widget. The site key is read from the
// Worker-injected data-sitekey attribute on the container; it is never
// hardcoded here. The script is appended once, then turnstile.render is called
// with the captured action and token/error/expired callbacks.
function initTurnstile(els, handlers) {
  if (!els.turnstileBox) return;
  const sitekey = els.turnstileBox.dataset.sitekey;
  if (!sitekey) {
    announce(els.status, 'Verification could not be loaded. Please try again later.');
    return;
  }
  const action = els.turnstileBox.dataset.action || 'books-eoi';

  loadTurnstileScript()
    .then(() => {
      const turnstile = window.turnstile;
      if (!turnstile || typeof turnstile.render !== 'function') {
        announce(els.status, 'Verification could not be loaded. Please try again later.');
        return;
      }
      const id = turnstile.render(els.turnstileBox, {
        sitekey,
        action,
        theme: 'light',
        callback: (token) => handlers.onToken(token),
        'error-callback': () => handlers.onReset(),
        'expired-callback': () => handlers.onReset()
      });
      handlers.register(id);
    })
    .catch(() => {
      announce(els.status, 'Verification could not be loaded. Please try again later.');
    });
}

function loadTurnstileScript() {
  return new Promise((resolve, reject) => {
    if (window.turnstile && typeof window.turnstile.render === 'function') {
      resolve();
      return;
    }
    const existing = document.head.querySelector(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('turnstile load error')));
      return;
    }
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('turnstile load error'));
    document.head.appendChild(script);
  });
}

function resetTurnstile(widgetId) {
  const turnstile = window.turnstile;
  if (turnstile && typeof turnstile.reset === 'function' && widgetId != null) {
    try {
      turnstile.reset(widgetId);
    } catch {
      // A reset failure is non-fatal: the token is cleared locally regardless.
    }
  }
}

function resetForm(form) {
  form.reset();
}

function setSubmitting(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

function announce(statusEl, message) {
  if (!statusEl) return;
  statusEl.textContent = message;
  // Move focus to the live region so screen-reader users are alerted promptly.
  if (message && typeof statusEl.focus === 'function') {
    try {
      statusEl.focus({ preventScroll: true });
    } catch {
      /* some user agents ignore focus on non-input elements */
    }
  }
}

// Page-local Back to Top is powered by the shared ./back-to-top.js module
// (imported above). The Books page passes no dialog, so the control only reacts
// to scroll position and prefers-reduced-motion, targeting the page #top.

// Browser only: in Node (tests importing the pure helpers) `document` is
// undefined, so no DOM side-effects run.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
