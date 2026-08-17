// Shared "Back to Top" control. Imported by every public page (via its page
// script) so the behaviour lives in exactly one place (no duplicated logic).
//
// The control is anchored to the bottom-right safe side (see styles.css) so it
// does not sit over the centered forms, CTAs, or consent text. On top of the
// placement, this module dynamically hides the control whenever an "avoid
// zone" actually enters its placement region -- forms, the site footer, the
// shared .button controls, and anything marked with data-btt-avoid -- so the
// fixed control never covers interactive or consent content. When no safe
// placement exists (the region is obstructed), the control simply hides.
//
// It also reveals the control only once the visitor scrolls past a threshold,
// hides it while an optional <dialog> is open, and honors
// prefers-reduced-motion for the scroll action.
//
// Pure module: safe to import in Node (unit tests import the pure helpers);
// all DOM access is inside initBackToTop, which is a no-op when the
// #back-to-top control is absent.

const BACK_TO_TOP_THRESHOLD = 400;

// Pixels of breathing room around the control's box when testing overlap, so
// the control also keeps a small margin clear of avoid zones.
const BACK_TO_TOP_MARGIN = 8;

// Elements the fixed control must never cover: forms (which contain consent
// text, inputs, and submit buttons), the site footer, the shared .button
// controls, and any element explicitly marked with data-btt-avoid (the simple
// per-section escape hatch for anything else).
const BACK_TO_TOP_AVOID_SELECTOR = 'form, footer, .button, [data-btt-avoid]';

// Pure: do two axis-aligned rectangles overlap (with an optional margin
// buffer)? Touched edges do not count as overlap.
export function rectsOverlap(a, b, margin = 0) {
  if (!a || !b) return false;
  return (
    a.left - margin < b.right &&
    a.right + margin > b.left &&
    a.top - margin < b.bottom &&
    a.bottom + margin > b.top
  );
}

// Pure: the complete visibility decision for the control. Hidden when below
// the scroll threshold, while a dialog is open, or when its placement region
// is obstructed by an avoid zone.
export function computeBackToTopHidden({ dialogOpen, scrollY, threshold, obstructed }) {
  return (
    Boolean(dialogOpen) ||
    Number(scrollY) < Number(threshold) ||
    Boolean(obstructed)
  );
}

// Pure-ish: is the control's current placement obstructed by any avoid
// element? Accepts anything with getBoundingClientRect (a DOM element or a
// test fake); never throws on missing/removed elements.
export function isBackToTopObstructed(button, avoidElements, margin = BACK_TO_TOP_MARGIN) {
  if (!button || typeof button.getBoundingClientRect !== 'function') return false;
  const rect = button.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  for (const el of Array.isArray(avoidElements) ? avoidElements : []) {
    if (!el || el === button || typeof el.getBoundingClientRect !== 'function') continue;
    if (rectsOverlap(rect, el.getBoundingClientRect(), margin)) return true;
  }
  return false;
}

// options.dialog: optional <dialog> element. When supplied, the control is also
// hidden while the dialog is open and re-synced on its 'toggle' event (so the
// home painting dialog keeps the behaviour it always had).
export function initBackToTop(options = {}) {
  const button = document.getElementById('back-to-top');
  if (!button) return;

  const dialog = options.dialog || null;
  const avoidElements = Array.from(
    document.querySelectorAll(BACK_TO_TOP_AVOID_SELECTOR)
  );

  const reducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sync = () => {
    const baseHidden =
      (dialog && dialog.open) || window.scrollY < BACK_TO_TOP_THRESHOLD;
    if (baseHidden) {
      button.hidden = true;
      return;
    }
    // Measure the real placement: a display:none box has no box, so the
    // control is unhidden first, measured, and hidden again in the same
    // synchronous task (nothing is painted in between, so there is no flash).
    if (button.hidden) button.hidden = false;
    button.hidden = computeBackToTopHidden({
      dialogOpen: dialog && dialog.open,
      scrollY: window.scrollY,
      threshold: BACK_TO_TOP_THRESHOLD,
      obstructed: isBackToTopObstructed(button, avoidElements, BACK_TO_TOP_MARGIN)
    });
  };

  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  if (dialog) dialog.addEventListener('toggle', sync);

  button.addEventListener('click', () => {
    const behavior = reducedMotion() ? 'auto' : 'smooth';
    const top = document.getElementById('top');
    if (top) {
      top.scrollIntoView({ behavior, block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior });
    }
  });

  sync();
}
