// Persistent chapter navigation (progressive enhancement over native <details>).
//
// The mobile menu is a native <details>/<summary> disclosure in the static
// HTML. The <summary> IS the disclosure control: the browser maps it to a
// button role and exposes its expanded state from the `open` attribute
// automatically (WAI-ARIA disclosure pattern, native). No manual
// aria-expanded/aria-controls wiring is duplicated, and Enter/Space toggling
// works without any JavaScript.
//
// This script adds two enhancements on top of the native behaviour:
//
//   1. Disclosure UX: activating any link closes the menu, an outside click
//      closes it, Escape closes it and returns focus to the summary, and the
//      whole nav hides while the painting <dialog> is open (restoring on
//      close). The native dialog stays in the top layer above everything.
//
//   2. Scroll-spy: ordered section tops are compared with one fixed viewport
//      offset. This avoids intersection-ratio ambiguity when short adjacent
//      sections are both visible. Document bottom explicitly selects Contact.
//
// The pure helpers (pickActiveSection, correctHashTarget, createDisclosureController,
// isBooksPage, markBooksPageCurrent) are exported so they can be unit-tested
// with real inputs and a tiny fake-DOM / fake-observer harness, without a heavy
// dependency.

// In-page section ids, in document order. "/books" is intentionally absent:
// it is a route, not an in-page anchor, so it never receives aria-current from
// the scroll-spy. The Books page itself is marked aria-current="page" via
// isBooksPage()/markBooksPageCurrent() instead.
const IN_PAGE_SECTIONS = ['gallery', 'story', 'testimonials', 'contact'];
const ACTIVE_SECTION_OFFSET = 96;

// The canonical Books route. The trailing-slash form is treated as the same
// page (the Worker redirects /books/ -> /books with 301).
export function isBooksPage(pathname) {
  const raw = typeof pathname === 'string'
    ? pathname
    : (typeof location !== 'undefined' ? location.pathname : '');
  return raw.replace(/\/+$/, '') === '/books';
}

// Mark the Books page link(s) as the current page (aria-current="page") and
// clear the attribute from every other link. Pure over a list of link handles
// so it is unit-testable without a DOM.
export function markBooksPageCurrent(links) {
  for (const link of links || []) {
    if (link && link.classList && link.classList.contains('chapter-link-page')) {
      link.setAttribute('aria-current', 'page');
    } else if (link) {
      link.removeAttribute('aria-current');
    }
  }
}

// --- Pure: deterministic active-section selection ---------------------------
// entries: Array of { id, top } for every section in document order
//          (top = boundingClientRect.top, document order preserved by caller).
// markerY: px offset from the viewport top.
//
// The current section is the LATEST section whose top has crossed at/above the
// marker line. Before Gallery reaches the marker there is no active chapter.
// At document bottom the last chapter wins even when a short page cannot place
// its top above the marker.
export function pickActiveSection(entries, markerY, atDocumentBottom = false) {
  if (!entries || entries.length === 0) return null;
  if (atDocumentBottom) return entries[entries.length - 1].id;

  let chosen = null;
  for (const entry of entries) {
    if (entry.top <= markerY) chosen = entry.id; // last crossed-above wins
  }
  return chosen;
}

// Schedule one post-navigation correction without intercepting native anchor
// history or focus behaviour. The deterministic gallery media box keeps the
// target stable while lazy images finish loading.
export function correctHashTarget(hash, getTarget, schedule) {
  if (typeof hash !== 'string' || !hash.startsWith('#') || hash.length < 2) return false;
  let id;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const target = getTarget(id);
  if (!target || typeof target.scrollIntoView !== 'function') return false;
  schedule(() => target.scrollIntoView());
  return true;
}

// --- Pure: disclosure controller ------------------------------------------
// Operates on element handles (no global DOM access), so it can be exercised
// in tests with a tiny fake of { open, focus, contains, closest }. The native
// <details> open/close toggle needs no JS; this controller only adds the
// enhancement behaviours and exposes them as small, individually testable
// methods.
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
function initChapterNav() {
  const chapterNav = document.querySelector('.chapter-nav');
  const chapterDetails = document.getElementById('chapter-details');
  const chapterSummary = document.getElementById('chapter-toggle');
  const chapterMenu = document.getElementById('chapter-menu');
  const paintingDialog = document.getElementById('painting-dialog');

  function chapterLinks() {
    return Array.from(document.querySelectorAll('.chapter-link'));
  }

  // Mark exactly one section's links (rail + menu) as the current location and
  // clear the attribute from every other link. Links without a data-target
  // (the /books page link) are never touched.
  function setCurrentSection(id) {
    for (const link of chapterLinks()) {
      if (link.dataset.target && link.dataset.target === id) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  }

  function clearCurrentSection() {
    for (const link of chapterLinks()) link.removeAttribute('aria-current');
  }

  // --- Disclosure enhancement ---------------------------------------------
  const disclosure = createDisclosureController({
    details: chapterDetails,
    summary: chapterSummary,
    menu: chapterMenu
  });

  if (chapterDetails) {
    // Activating any link closes the menu; the anchor/route then navigates.
    chapterMenu.addEventListener('click', (event) => {
      disclosure.onMenuClick(event.target);
    });

    // Escape closes the open menu and returns focus to the summary.
    document.addEventListener('keydown', (event) => {
      if (disclosure.onKeydown(event.key)) event.stopPropagation();
    });

    // A pointer/click outside the disclosure closes the menu.
    document.addEventListener('click', (event) => {
      if (disclosure.isOpen() && !disclosure.contains(event.target)) {
        disclosure.close(false);
      }
    });
  }

  // --- Scroll-spy (in-page sections only) ---------------------------------
  function setupScrollSpy() {
    const sections = IN_PAGE_SECTIONS
      .map((id) => document.getElementById(id))
      .filter(Boolean);

    if (sections.length === 0) return;

    let frame = 0;
    function update() {
      frame = 0;
      const entries = sections.map((section) => ({
        id: section.id,
        top: section.getBoundingClientRect().top
      }));
      const documentHeight = document.documentElement.scrollHeight;
      const atDocumentBottom = window.scrollY + window.innerHeight >= documentHeight - 1;
      const current = pickActiveSection(entries, ACTIVE_SECTION_OFFSET, atDocumentBottom);
      if (current) setCurrentSection(current);
      else clearCurrentSection();
    }

    function scheduleUpdate() {
      if (!frame) frame = window.requestAnimationFrame(update);
    }

    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('hashchange', scheduleUpdate);
    update();
  }

  function scheduleAnchorCorrection(hash) {
    correctHashTarget(
      hash,
      (id) => document.getElementById(id),
      (callback) => window.requestAnimationFrame(callback)
    );
  }

  document.addEventListener('click', (event) => {
    const link = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('a[href*="#"]')
      : null;
    if (!link) return;
    const targetUrl = new URL(link.href, window.location.href);
    if (targetUrl.pathname === window.location.pathname) scheduleAnchorCorrection(targetUrl.hash);
  });

  // On hashchange (link activation, programmatic hash changes, and back/forward
  // history navigation) schedule a post-layout anchor correction for the current
  // hash so the target stays put while lazy images settle. The deterministic
  // scroll-spy update on hashchange is wired separately in setupScrollSpy.
  window.addEventListener('hashchange', () => {
    scheduleAnchorCorrection(window.location.hash);
  });
  if (window.location.hash) scheduleAnchorCorrection(window.location.hash);

  // --- Dialog coexistence -------------------------------------------------
  // The painting <dialog> uses showModal()/close(); showModal toggles its `open`
  // attribute, which a MutationObserver catches to hide the nav immediately on
  // open. The native 'close' event restores it on dismiss. The dialog itself
  // always remains in the top layer.
  function syncChapterNavVisibility() {
    if (!chapterNav || !paintingDialog) return;
    const hidden = paintingDialog.open;
    chapterNav.hidden = hidden;
    if (hidden) disclosure.close(false);
  }

  if (chapterNav && paintingDialog) {
    paintingDialog.addEventListener('close', syncChapterNavVisibility);
    const dialogObserver = new MutationObserver(syncChapterNavVisibility);
    dialogObserver.observe(paintingDialog, {
      attributes: true,
      attributeFilter: ['open']
    });
    syncChapterNavVisibility();
  }

  // On the Books page there are no in-page home sections to observe, so the
  // scroll-spy is skipped entirely (its targets are absent) and the Books page
  // link is marked aria-current="page" instead. On the home page the scroll-spy
  // runs as usual and never touches the Books link.
  if (isBooksPage()) {
    markBooksPageCurrent(chapterLinks());
  } else {
    setupScrollSpy();
  }
}

// Browser only: in Node (tests importing the pure helpers) `document` is
// undefined, so no DOM side-effects run.
if (typeof document !== 'undefined') {
  initChapterNav();
}
