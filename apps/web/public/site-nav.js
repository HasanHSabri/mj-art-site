// Shared primary navigation (progressive enhancement).
//
// Every public page shares one primary <nav class="topbar"> with the same four
// links in the same order (Home | Gallery | Books | Enquire). On wide screens
// the inline .topbar-links show; on narrow screens (<=760px) the fixed bottom
// bar (.site-nav-bottom) carries the same four destinations as plain anchors.
// The legacy <details>/<summary> disclosure stays as valid markup but is no
// longer displayed at any width. The current page is marked statically in
// each page's HTML with aria-current="page" for Gallery/Books; this script
// additionally keeps the bottom bar's Home and Enquire tabs hash-aware on the
// home page (#contact marks Enquire current instead of Home).
//
// The <summary> IS the disclosure control: the browser maps it to a button
// role and exposes its expanded state from the `open` attribute automatically
// (WAI-ARIA disclosure pattern, native). No manual aria-expanded/aria-controls
// wiring is duplicated, and Enter/Space toggling works without JavaScript.
//
// This script adds these enhancements on top of the native behaviour:
//
//   1. Activating any menu link closes the disclosure (the anchor then
//      navigates).
//   2. A pointer/click outside the open disclosure closes it.
//   3. Escape closes the open disclosure and returns focus to the summary.
//   4. The bottom bar's Home/Enquire aria-current follows the URL hash on the
//      home page: #contact (the enquiry section) marks Enquire current; any
//      other hash, or no hash, marks Home current. hashchange covers anchor
//      clicks and back/forward; pageshow re-syncs after bfcache restores.
//
// The pure helpers createDisclosureController and syncBottomNavCurrent are
// exported so they can be unit-tested with tiny fakes -- no DOM.

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

// Pure: decides which bottom-nav tab is current from the route + hash.
// On the home page, the enquiry hash (#contact) hands "current" from Home to
// Enquire; every other state keeps Home current. Away from the home page the
// static per-page markup already owns the current tab (Gallery/Books), and
// neither Home nor Enquire is marked. Returns 'home' | 'enquire' | null.
export function resolveBottomNavCurrent({ isHome, hash } = {}) {
  if (!isHome) return null;
  return hash === '#contact' ? 'enquire' : 'home';
}

// Pure: applies the resolved current tab to the two link handles (tiny fakes
// with setAttribute/removeAttribute are enough for tests). Never touches the
// Gallery/Books tabs -- their static aria-current stands. Returns the resolved
// current tab ('home' | 'enquire' | null).
export function syncBottomNavCurrent({ isHome, hash, homeLink, enquireLink } = {}) {
  const current = resolveBottomNavCurrent({ isHome, hash });
  if (homeLink) {
    if (current === 'home') homeLink.setAttribute('aria-current', 'page');
    else homeLink.removeAttribute('aria-current');
  }
  if (enquireLink) {
    if (current === 'enquire') enquireLink.setAttribute('aria-current', 'page');
    else enquireLink.removeAttribute('aria-current');
  }
  return current;
}

// True for the public home page routes ('/' and '/index.html'). Pure.
export function isHomePath(path) {
  return path === '/' || path === '/index.html' || path === '';
}

// --- DOM bootstrap (browser only) -----------------------------------------
function initSiteNav() {
  const details = document.querySelector('.site-nav-disclosure');
  if (details) {
    const summary = details.querySelector('.site-nav-summary');
    const menu = details.querySelector('.site-nav-menu');
    if (summary && menu) {
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
      // (summary toggle, link activation) are left to the native behaviour
      // and the menu listener above.
      document.addEventListener('click', (event) => {
        if (disclosure.isOpen() && !disclosure.contains(event.target)) {
          disclosure.close(false);
        }
      });
    }
  }
  initBottomNavCurrent();
}

function initBottomNavCurrent() {
  const nav = document.querySelector('.site-nav-bottom');
  if (!nav) return;
  const homeLink = nav.querySelector('a[href="/"]');
  const enquireLink = nav.querySelector('a[href="/#contact"]');
  if (!homeLink || !enquireLink) return;

  const isHome = isHomePath(window.location.pathname);
  const sync = () => {
    syncBottomNavCurrent({ isHome, hash: window.location.hash, homeLink, enquireLink });
  };

  // Initial state (static markup is already correct without JS; this keeps
  // deep links like /#contact in sync) + anchor clicks and back/forward
  // (hashchange) + bfcache restores (pageshow).
  sync();
  window.addEventListener('hashchange', sync);
  window.addEventListener('pageshow', sync);
}

// Browser only: in Node (tests importing the pure helpers) `document` is
// undefined, so no DOM side-effects run.
if (typeof document !== 'undefined') {
  initSiteNav();
}
