// Persistent chapter navigation (progressive enhancement).
//
// Layered on top of the static HTML chapter nav in index.html. The links are
// real anchors/routes, so every destination works without this script. JS only
// adds two enhancements:
//
//   1. Mobile disclosure: #chapter-toggle opens #chapter-menu upward.
//      aria-expanded/aria-controls are kept in sync, Escape closes and returns
//      focus to the toggle, an outside click closes, and activating any link
//      closes the menu. While closed the menu keeps its [hidden] attribute, so
//      it is fully removed from the tab/focus order (not just visually hidden).
//
//   2. Scroll-spy: an IntersectionObserver mirrors the current in-page section
//      onto exactly one chapter link as aria-current="location" (an in-page
//      position, never aria-current="page"). It is non-intrusive: it does NOT
//      touch history, move focus, or announce to any live region, and it never
//      marks the /books page link.
//
// The whole nav hides while the painting <dialog> is open and restores on
// close. The native dialog stays in the top layer above everything else.

const chapterNav = document.querySelector('.chapter-nav');
const chapterToggle = document.getElementById('chapter-toggle');
const chapterMenu = document.getElementById('chapter-menu');
const paintingDialog = document.getElementById('painting-dialog');

// In-page section ids, in document order. "/books" is intentionally absent:
// it is a route, not an in-page anchor, so it never receives aria-current.
const IN_PAGE_SECTIONS = ['gallery', 'story', 'testimonials', 'contact'];

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

// --- Mobile disclosure ---------------------------------------------------
function isMenuExpanded() {
  return Boolean(chapterToggle && chapterToggle.getAttribute('aria-expanded') === 'true');
}

function openChapterMenu() {
  if (!chapterMenu || !chapterToggle) return;
  chapterMenu.hidden = false;
  chapterToggle.setAttribute('aria-expanded', 'true');
  const first = chapterMenu.querySelector('a, button');
  if (first) first.focus();
}

function closeChapterMenu(returnFocus) {
  if (!chapterMenu || !chapterToggle) return;
  chapterMenu.hidden = true;
  chapterToggle.setAttribute('aria-expanded', 'false');
  if (returnFocus) chapterToggle.focus();
}

if (chapterToggle && chapterMenu) {
  chapterToggle.addEventListener('click', () => {
    if (isMenuExpanded()) closeChapterMenu(true);
    else openChapterMenu();
  });

  // Activating any link closes the menu; the anchor/route then navigates.
  chapterMenu.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeChapterMenu(false);
  });

  // Escape closes the open menu and returns focus to the toggle.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (isMenuExpanded()) {
      event.stopPropagation();
      closeChapterMenu(true);
    }
  });

  // A pointer/click outside the menu and toggle closes the menu.
  document.addEventListener('click', (event) => {
    if (!isMenuExpanded()) return;
    if (chapterMenu.contains(event.target)) return;
    if (chapterToggle.contains(event.target)) return;
    closeChapterMenu(false);
  });
}

// --- Scroll-spy (in-page sections only) ---------------------------------
function setupScrollSpy() {
  const sections = IN_PAGE_SECTIONS
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  if (sections.length === 0 || typeof IntersectionObserver === 'undefined') return;

  const visible = new Map();

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visible.set(entry.target.id, entry.intersectionRatio);
      } else {
        visible.delete(entry.target.id);
      }
    }

    // Choose the topmost visible section (document order) so at most one link
    // is ever current. If the active band is empty (e.g. over the hero),
    // clear the marker rather than show a stale current.
    let chosen = null;
    for (const section of sections) {
      if (visible.has(section.id)) {
        chosen = section.id;
        break;
      }
    }
    if (chosen) setCurrentSection(chosen);
    else clearCurrentSection();
  }, {
    // Bias the active zone to a horizontal band near the top of the viewport.
    rootMargin: '-20% 0px -60% 0px',
    threshold: [0, 1]
  });

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
  if (hidden) closeChapterMenu(false);
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
