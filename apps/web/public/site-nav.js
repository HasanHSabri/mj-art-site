// Shared primary navigation disclosure (progressive enhancement).
//
// Every public page shares one primary <nav class="topbar"> with the same four
// links in the same order (Home | Gallery | Books | Enquire). On wide screens
// the inline .topbar-links show and the disclosure is hidden; on narrow
// screens the inline links are hidden and a native <details>/<summary>
// disclosure (.site-nav-disclosure) becomes the menu. The current page is
// marked statically in each page's HTML with aria-current="page", so this
// script never computes it.
//
// The <summary> IS the disclosure control: the browser maps it to a button
// role and exposes its expanded state from the `open` attribute automatically
// (WAI-ARIA disclosure pattern, native). No manual aria-expanded/aria-controls
// wiring is duplicated, and Enter/Space toggling works without JavaScript.
//
// This script adds three enhancements on top of the native behaviour:
//
//   1. Activating any menu link closes the disclosure (the anchor then
//      navigates).
//   2. A pointer/click outside the open disclosure closes it.
//   3. Escape closes the open disclosure and returns focus to the summary.
//
// The pure helper createDisclosureController is exported so it can be unit-
// tested with a tiny fake of { open, focus, contains, closest } -- no DOM.

// Pure: disclosure controller over element handles (no global DOM access), so
// it can be exercised in tests with a tiny fake of { open, focus, contains,
// closest }. The native <details> open/close toggle needs no JS; this
// controller only adds the enhancement behaviours and exposes them as small,
// individually testable methods.
export function createDisclosureController({ details, summary, menu } = {}) {
  return {
    isOpen() {
      return Boolean(details && details.open);
    },
    open() {
      if (details) details.open = true;
    },
    close(returnFocus) {
      if (!details) return;
      details.open = false;
      if (returnFocus && summary && typeof summary.focus === 'function') {
        summary.focus();
      }
    },
    // True when the target lives inside the disclosure (summary or menu), so
    // an outside-click handler can decide to close.
    contains(target) {
      if (!target) return false;
      if (details && typeof details.contains === 'function' && details.contains(target)) return true;
      if (summary && typeof summary.contains === 'function' && summary.contains(target)) return true;
      return false;
    },
    // A click anywhere in the menu: if it landed on a link, close afterwards.
    onMenuClick(target) {
      if (!target || !menu) return false;
      const onLink = typeof target.closest === 'function' && Boolean(target.closest('a'));
      if (onLink) this.close(false);
      return onLink;
    },
    // Key handling for the document-level Escape. Returns true if handled.
    onKeydown(key) {
      if (key === 'Escape' && this.isOpen()) {
        this.close(true);
        return true;
      }
      return false;
    }
  };
}

// --- DOM bootstrap (browser only) -----------------------------------------
function initSiteNav() {
  const details = document.querySelector('.site-nav-disclosure');
  if (!details) return;
  const summary = details.querySelector('.site-nav-summary');
  const menu = details.querySelector('.site-nav-menu');
  if (!summary || !menu) return;

  const disclosure = createDisclosureController({ details, summary, menu });

  // Activating any link closes the menu; the anchor then navigates.
  menu.addEventListener('click', (event) => {
    disclosure.onMenuClick(event.target);
  });

  // Escape closes the open menu and returns focus to the summary.
  document.addEventListener('keydown', (event) => {
    if (disclosure.onKeydown(event.key)) event.stopPropagation();
  });

  // A pointer/click outside the open disclosure closes it. Inside clicks
  // (summary toggle, link activation) are left to the native behaviour and the
  // menu listener above.
  document.addEventListener('click', (event) => {
    if (disclosure.isOpen() && !disclosure.contains(event.target)) {
      disclosure.close(false);
    }
  });
}

// Browser only: in Node (tests importing the pure helpers) `document` is
// undefined, so no DOM side-effects run.
if (typeof document !== 'undefined') {
  initSiteNav();
}
