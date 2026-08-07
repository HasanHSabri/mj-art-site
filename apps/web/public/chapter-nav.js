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
//   2. Scroll-spy: an IntersectionObserver mirrors the current in-page section
//      onto exactly one chapter link as aria-current="location" (an in-page
//      position, never aria-current="page"). When multiple sections intersect
//      the active band, the LATER/nearest-to-marker section is chosen
//      deterministically (see pickActiveSection) so there is no lag during
//      transitions. It is non-intrusive: no history, no focus move, no live
//      region, and it never marks the /books page link.
//
// The pure helpers (pickActiveSection, createDisclosureController) are
// exported so they can be unit-tested with real inputs and a tiny fake-DOM
// harness, without a heavy dependency.

// In-page section ids, in document order. "/books" is intentionally absent:
// it is a route, not an in-page anchor, so it never receives aria-current.
const IN_PAGE_SECTIONS = ['gallery', 'story', 'testimonials', 'contact'];

// --- Pure: deterministic active-section selection ---------------------------
// entries: Array of { id, top } for the currently intersecting sections
//          (top = boundingClientRect.top, document order preserved by caller).
// markerY: px offset of the top of the active band from the viewport top.
//
// The current section is the LATEST section whose top has crossed at/above the
// marker line (so the section the reader is entering wins immediately -- no
// document-first lag). If no visible top has crossed yet (approaching a
// section from below), the nearest one below the marker is chosen. Returns
// null when nothing is visible (e.g. over the hero), so the caller clears the
// marker rather than show a stale current.
export function pickActiveSection(entries, markerY) {
  if (!entries || entries.length === 0) return null;

  let chosen = null;
  for (const entry of entries) {
    if (entry.top <= markerY) chosen = entry.id; // last crossed-above wins
  }
  if (chosen !== null) return chosen;

  // None has crossed the marker yet: pick the nearest below (smallest top).
  let nearest = entries[0];
  for (const entry of entries) {
    if (entry.top < nearest.top) nearest = entry;
  }
  return nearest.id;
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

    if (sections.length === 0 || typeof IntersectionObserver === 'undefined') return;

    // Bias the active zone to a horizontal band near the top of the viewport.
    const rootMargin = '-20% 0px -60% 0px';

    const observer = new IntersectionObserver((entries) => {
      const visible = [];
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visible.push({ id: entry.target.id, top: entry.boundingClientRect.top });
        }
      }
      // The marker line is the top of the active band: 20% down the viewport
      // (matches the rootMargin top inset).
      const markerY = (window.innerHeight || 0) * 0.2;
      const chosen = pickActiveSection(visible, markerY);
      if (chosen) setCurrentSection(chosen);
      else clearCurrentSection();
    }, { rootMargin, threshold: [0, 1] });

    for (const section of sections) observer.observe(section);
  }

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

  setupScrollSpy();
}

// Browser only: in Node (tests importing the pure helpers) `document` is
// undefined, so no DOM side-effects run.
if (typeof document !== 'undefined') {
  initChapterNav();
}
