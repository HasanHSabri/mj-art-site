// Pure, workerd-safe contract values for the MJ-ART Worker.
//
// The Worker MAIN module (src/worker.js) exports ONLY the default
// ExportedHandler: workerd rejects non-handler named exports from a main
// module ("Incorrect type map entry expected function/ExportedHandler"), which
// blocked `wrangler dev` startup and therefore real deploys. Everything tests
// need to import lives HERE instead (an ordinary bundled module, where named
// exports are fine) and is imported by the main module.

// Exact, source-central Content-Security-Policy applied by finalizeResponse to
// every response (pages, APIs, static/R2 assets, redirects, and errors).
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' mailto:",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com"
].join('; ');

// The Worker owns every Books page URL. The canonical page is /books; the raw
// .html alias and any trailing-slash variant (single or repeated) all
// canonicalize to /books. Anything that is NOT one of these is left alone
// (e.g. /api/books/*, /bookstore). Pure + exported so the route contract is
// unit-tested directly.
export function isBooksPage(pathname) {
  return (
    pathname === '/books' ||
    pathname === '/books.html' ||
    /^\/books\/+$/.test(pathname)
  );
}

// The Worker owns every Gallery page URL the same way it owns Books. The
// canonical page is /gallery; the raw /gallery.html asset and any
// trailing-slash variant (single or repeated) permanently redirect to /gallery
// so the canonical SSR page is the only URL served and direct refresh/HEAD on
// /gallery always hit the Worker. Anything else (e.g. /api/...) is left alone.
// Pure + exported so the route contract is unit-tested directly.
export function isGalleryPage(pathname) {
  return (
    pathname === '/gallery' ||
    pathname === '/gallery.html' ||
    /^\/gallery\/+$/.test(pathname)
  );
}
