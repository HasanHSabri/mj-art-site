// Shared "Back to Top" control. Imported by the home gallery script and the
// Books page so the behaviour lives in exactly one place (no duplicated logic).
//
// Reveals the #back-to-top control once the visitor scrolls past a threshold,
// hides it while an optional <dialog> is open (the home painting dialog), and
// honors prefers-reduced-motion for the scroll action. The Books page passes no
// dialog, so its behaviour is the simpler scroll-only variant.
//
// Pure module: safe to import in Node (unit tests import the pages' modules);
// all DOM access is inside the exported function, which is a no-op when the
// #back-to-top control is absent.

const BACK_TO_TOP_THRESHOLD = 400;

// options.dialog: optional <dialog> element. When supplied, the control is also
// hidden while the dialog is open and re-synced on its 'toggle' event (so the
// home painting dialog keeps the behaviour it always had).
export function initBackToTop(options = {}) {
  const button = document.getElementById('back-to-top');
  if (!button) return;

  const dialog = options.dialog || null;

  const reducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sync = () => {
    button.hidden =
      (dialog && dialog.open) || window.scrollY < BACK_TO_TOP_THRESHOLD;
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
