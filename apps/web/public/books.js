// Books Expression of Interest client (progressive enhancement, no framework).
//
// Responsibilities:
//   - fetch and render live interest/copies counters from GET /api/books/interest
//   - explicitly render the Cloudflare Turnstile widget (site key injected into
//     the DOM by the Worker; never hardcoded here) and capture its token
//   - robustly submit the EOI to POST /api/books/eoi, handling 400/413/429/503
//     and generic errors WITHOUT leaking server detail, preventing duplicate
//     submits, and resetting Turnstile + refreshing counters after success
//   - power the page's "Back to Top" control (shared implementation; targets
//     the Books page top)
//
// No mail fallback, no localStorage, no R2 fallback. The pure helpers below are
// exported so the mapping/validation logic is unit-testable without a DOM.

import { initBackToTop } from './back-to-top.js';

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no network)
// ---------------------------------------------------------------------------

// Canonical quantity window mirrors the backend CHECK (1..10, integer).
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;

// Canonical book/format values MUST match the backend allowlists. These are the
// non-secret contract values, not operator data.
export const BOOK_VALUES = ['biography', 'childrens'];
export const FORMAT_VALUES = ['hardcover', 'paperback', 'ebook', 'unsure'];

// Build the exact JSON payload to POST. Consent is required and sent as the
// boolean true (matches the server-side strict check). A non-empty honeypot is
// forwarded so the backend can accept it silently as a bot trap. Returns null
// when a client-side guard fails (book/format/consent/token missing).
export function buildEoiPayload(values) {
  const v = values || {};
  const book = typeof v.book === 'string' ? v.book : '';
  const format = typeof v.format === 'string' ? v.format : '';
  const quantity = toInt(v.quantity);
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const email = typeof v.email === 'string' ? v.email.trim() : '';
  const consent = v.consent === true;
  const turnstileToken = typeof v.turnstileToken === 'string' ? v.turnstileToken : '';

  if (!BOOK_VALUES.includes(book)) return null;
  if (!FORMAT_VALUES.includes(format)) return null;
  if (quantity === null || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) return null;
  if (name.length === 0) return null;
  if (email.length === 0) return null;
  if (!consent) return null;
  if (turnstileToken.length === 0) return null;

  const payload = {
    book,
    format,
    quantity,
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

// Pluralize a count for a counter label fragment.
export function pluralize(count, singular, plural) {
  return count === 1 ? singular : plural;
}

// Render the counter text for a single book from the /api/books/interest shape.
// Returns "" when there is no data yet (caller leaves the placeholder).
export function counterValue(entry, field) {
  if (!entry || typeof entry[field] !== 'number') return '';
  return String(entry[field]);
}

// Decide the text to render for a counter across the loading / loaded states.
// While loading (no data object yet) it returns the empty sentinel "" so the
// caller leaves the em dash placeholder in the markup untouched -- it NEVER
// renders an apparent 0 before real data arrives. Once data is present, a
// missing entry renders a genuine 0 (the backend always returns both books, so
// a missing entry is a real zero count, not a loading state).
export function counterText(data, book, field) {
  if (!data || typeof data !== 'object') return '';
  const entry = findBookEntry(data, book);
  return counterValue(entry, field) || '0';
}

// Find a book entry inside { books: [...] } safely.
export function findBookEntry(data, book) {
  if (!data || !Array.isArray(data.books)) return null;
  return data.books.find((b) => b && b.book === book) || null;
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
const INTEREST_URL = '/api/books/interest';
const EOI_URL = '/api/books/eoi';

function init() {
  const form = document.getElementById('books-eoi-form');
  if (!form) return;

  const els = readElements(form);
  let turnstileToken = '';
  let turnstileWidgetId = null;
  let submitting = false;

  loadCounters(els);
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

  // Preselect the book radio from a validated ?book=<canonical> param; keep it
  // in sync on back/forward without forcing focus so direct URLs/history work.
  applyBookPreselection(form, { focus: true });
  window.addEventListener('popstate', () => applyBookPreselection(form, { focus: false }));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    const payload = buildEoiPayload({
      book: readRadio(els.form, 'book'),
      format: els.format ? els.format.value : '',
      quantity: els.quantity ? els.quantity.value : '',
      name: els.name ? els.name.value : '',
      email: els.email ? els.email.value : '',
      consent: els.consent ? els.consent.checked : false,
      turnstileToken,
      website: els.honeypot ? els.honeypot.value : ''
    });

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
        resetTurnstile(turnstileWidgetId);
        turnstileToken = '';
        await loadCounters(els);
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
    format: document.getElementById('books-format'),
    quantity: document.getElementById('books-quantity'),
    name: document.getElementById('books-name'),
    email: document.getElementById('books-email'),
    consent: document.getElementById('books-consent'),
    honeypot: form.querySelector('[name="website"]'),
    submit: document.getElementById('books-submit'),
    status: document.getElementById('books-status'),
    countersStatus: document.getElementById('books-counters-status'),
    turnstileBox: document.getElementById('books-turnstile')
  };
}

function readRadio(form, name) {
  const checked = form.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : '';
}

// Preselect the book radio from a validated ?book=<canonical> param. On the
// initial load (opts.focus === true) the selected radio also receives focus so
// keyboard users land on the form; on history navigation focus is left to the
// browser so back/forward are not harmed. An invalid/missing value is a no-op.
function applyBookPreselection(form, opts) {
  const focus = opts && opts.focus === true;
  const params = new URLSearchParams(window.location.search);
  const book = parseBookQuery(params.get('book'));
  if (!book) return false;
  const radio = form.querySelector(`input[name="book"][value="${book}"]`);
  if (!radio) return false;
  if (!radio.checked) radio.checked = true;
  if (focus) {
    try {
      radio.focus({ preventScroll: true });
    } catch {
      radio.focus();
    }
  }
  return true;
}

// Fetch and render the live counters. Loading/empty/error states are surfaced
// accessibly via the counters status region.
async function loadCounters(els) {
  if (els.countersStatus) {
    els.countersStatus.textContent = 'Loading interest counts...';
  }
  setCounters('biography', '');
  setCounters('childrens', '');

  try {
    const res = await fetch(INTEREST_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      announceCounters(els, messageForStatus(res.status));
      return;
    }
    const data = await res.json();
    renderCounters(data);
    announceCounters(els, '');
  } catch {
    announceCounters(els, messageForStatus(0));
  }
}

function renderCounters(data) {
  for (const book of BOOK_VALUES) {
    setCounters(book, data);
  }
}

function setCounters(book, data) {
  // Loading (no data object yet): leave the em dash placeholder in place --
  // never render an apparent 0 before real data arrives.
  if (!data || typeof data !== 'object') return;
  const interestEl = document.querySelector(`[data-book-interest="${book}"]`);
  const copiesEl = document.querySelector(`[data-book-copies="${book}"]`);
  if (interestEl) interestEl.textContent = counterText(data, book, 'interestCount');
  if (copiesEl) copiesEl.textContent = counterText(data, book, 'requestedCopies');
}

function announceCounters(els, message) {
  if (!els.countersStatus) return;
  els.countersStatus.textContent = message;
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
