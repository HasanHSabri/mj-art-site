// Home secondary section navigator (progressive enhancement).
//
// ES module, pure helpers + a small DOM bootstrap. The Home page carries a
// secondary nav with exactly three links in order -- Story, Testimonials,
// Enquire -- to #story, #testimonials, #contact. On wide screens it is a slim
// sticky vertical rail beside the content (CSS); on narrow screens it is a
// compact wrapped row. This script keeps the active link in sync with the
// visitor's position using a robust scroll calculation (measure on every sync:
// lazy images and responsive reflow keep absolute offsets honest), and works
// for direct hash URLs, refresh, and back/forward navigation because it
// recomputes on scroll, hashchange, and popstate.
//
// The active link carries aria-current="true" and is styled with weight + a
// 2px underline (shape, not colour alone), mirroring the primary nav's
// current-page treatment. Anchor scrolling itself is native: the CSS keeps
// scroll-behavior smooth (auto under prefers-reduced-motion) and every
// section carries scroll-margin-top so the target never parks flush under the
// viewport edge.
//
// Pure module: safe to import in Node (tests exercise the pure helpers); the
// DOM bootstrap runs only when a document exists and the nav is present.

// The "current section" line sits a little below the viewport top: the shared
// scroll-margin-top (24px) plus breathing room, so a section counts as current
// once its heading is comfortably in view rather than the instant its very top
// edge crosses the viewport edge.
export const SECTION_NAV_OFFSET = 96;

// Pure: given sections as [{ id, top }] (absolute document offsets, any
// order), the current scroll line, and whether the very bottom of the page is
// reached, return the id of the active section: the last section whose top is
// at or above the line (the first section before any has been reached, the
// last section at the bottom of the page). Returns '' for empty input.
export function pickActiveSection(sections, scrollLine, pageBottomReached = false) {
  if (!Array.isArray(sections) || sections.length === 0) return '';
  if (pageBottomReached) {
    const last = sections[sections.length - 1];
    return last ? last.id : '';
  }
  let current = sections[0] ? sections[0].id : '';
  for (const section of sections) {
    if (section && Number(section.top) <= scrollLine) current = section.id;
  }
  return current;
}

// Pure: map a list of link hrefs like ['#story', '#testimonials', '#contact']
// to section ids. Anything that is not a bare in-page hash is dropped.
export function sectionIdsFromHrefs(hrefs) {
  if (!Array.isArray(hrefs)) return [];
  return hrefs
    .filter((href) => typeof href === 'string' && /^#[A-Za-z][\w-]*$/.test(href))
    .map((href) => href.slice(1));
}

function initSectionNav() {
  const nav = document.querySelector('.home-section-nav');
  if (!nav) return;

  const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
  if (links.length === 0) return;

  // Resolve each link's target element; links whose target is missing are
  // left alone (they still navigate natively) but never become active.
  const targets = links
    .map((link) => {
      const id = link.getAttribute('href').slice(1);
      const element = document.getElementById(id);
      return element ? { id, link, element } : null;
    })
    .filter(Boolean);
  if (targets.length === 0) return;

  const measure = () =>
    targets.map(({ id, element }) => ({
      id,
      top: element.getBoundingClientRect().top + window.scrollY
    }));

  const pageBottomReached = () =>
    window.scrollY + window.innerHeight >=
    document.documentElement.scrollHeight - 2;

  const sync = () => {
    const active = pickActiveSection(measure(), window.scrollY + SECTION_NAV_OFFSET, pageBottomReached());
    for (const { id, link } of targets) {
      if (id === active) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  };

  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  // Direct hash navigation and back/forward both end with the browser at a new
  // position; recompute immediately (and scroll/resize keep it honest after).
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync);
  } else {
    sync();
  }
}

// Browser only: in Node (tests importing the pure helpers) `document` is
// undefined, so no DOM side-effects run.
if (typeof document !== 'undefined') {
  initSectionNav();
}
