import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminJs = readFileSync(join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const adminHtml = readFileSync(join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const adminCss = readFileSync(join(__dirname, '..', 'public', 'admin.css'), 'utf8');

function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}
const code = stripJsComments(adminJs);

// ===========================================================================
// D2 regression contracts: a confirmed discard fully invalidates the editor
// ===========================================================================

test('discardEditorChanges resets BOTH the baseline and the editor identity', () => {
  const fn = code.match(/function discardEditorChanges\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'discardEditorChanges must exist');
  assert.match(fn[1], /editingId = null/, 'discard clears editingId (the D2 root cause)');
  assert.match(fn[1], /formBaseline = null/);
  assert.match(fn[1], /dirtyStatus\.hidden = true/);
});

test('openEditor reload decisions go through editorNeedsReload (same-record post-discard refills)', () => {
  const fn = code.match(/function openEditor\(state\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'openEditor must exist');
  assert.match(fn[1], /editorNeedsReload\(\{ editingId, formBaseline \}, state\.id\)/, 'edit path uses the reload predicate');
  assert.match(fn[1], /editorNeedsReload\(\{ editingId, formBaseline \}, null\)/, 'add path uses the reload predicate');
  // The refill restores the canonical record and re-arms dirty tracking.
  assert.match(fn[1], /writeArtworkToForm\(record\)/);
  assert.match(fn[1], /resetEditorForm\(/);
});

test('writeArtworkToForm and resetEditorForm always re-arm the dirty baseline', () => {
  const write = code.match(/function writeArtworkToForm\(record\)\s*\{([\s\S]*?)\n\}/);
  const reset = code.match(/function resetEditorForm\(statusMessage\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(write && reset);
  assert.match(write[1], /setFormBaseline\(\)/);
  assert.match(reset[1], /setFormBaseline\(\)/);
});

test('logout with unsaved editor changes asks before discarding', () => {
  const logoutIdx = adminJs.indexOf("'/api/admin/logout'");
  assert.ok(logoutIdx >= 0);
  const before = adminJs.slice(0, logoutIdx);
  const guard = before.lastIndexOf('logoutButton.addEventListener');
  assert.ok(guard >= 0, 'logout listener exists');
  const handler = adminJs.slice(guard, logoutIdx + 300);
  assert.match(handler, /isDirty\(\)/);
  assert.match(handler, /window\.confirm\(/);
  assert.match(adminJs.slice(logoutIdx, logoutIdx + 400), /resetBooksSurface\(\)/);
});

// ===========================================================================
// D3 contracts: validation errors mark and focus the offending fields
// ===========================================================================

test('showFormErrors marks aria-invalid, describes with the error list, and focuses the first field', () => {
  const fn = code.match(/function showFormErrors\(errors\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'showFormErrors must exist');
  assert.match(fn[1], /fieldIdsForErrors\(errors\)/);
  assert.match(fn[1], /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(fn[1], /setAttribute\('aria-describedby', 'form-errors'\)/);
  assert.match(fn[1], /firstField\.focus\(\)/, 'the first offending control receives focus');
  // Copy stays truthful: "highlighted" only when a control is actually marked.
  assert.match(fn[1], /'Please fix the highlighted fields\.' : 'Please fix the errors listed below\.'/);
});

test('clearFormErrors also clears every invalid-field mark', () => {
  const fn = code.match(/function clearFormErrors\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /clearInvalidFieldMarks\(\)/);
});

test('every error field id maps to a real control in admin.html', () => {
  for (const id of ['catalog-number', 'title', 'width-cm', 'height-cm', 'size-category', 'availability', 'price-amount']) {
    assert.ok(adminHtml.includes(`id="${id}"`), `${id} exists in the form`);
  }
  assert.match(adminCss, /\[aria-invalid="true"\]/, 'invalid fields carry a visible highlight style');
});

// ===========================================================================
// D4 contracts: view-heading focus management without keystroke stealing
// ===========================================================================

test('every view heading is a focus target and focus moves only on view transitions', () => {
  for (const id of ['catalogue-heading', 'artwork-heading', 'books-heading']) {
    assert.match(adminHtml, new RegExp(`id="${id}" tabindex="-1"`), `${id} is focusable via tabindex="-1"`);
  }
  const fn = code.match(/function focusViewHeading\(view\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'focusViewHeading must exist');
  assert.match(fn[1], /catalogue-heading/);
  assert.match(fn[1], /artwork-heading/);
  assert.match(fn[1], /books-heading/);
  assert.match(fn[1], /heading\.focus\(\)/);

  // Focus moves only when the VIEW changes: applyViewState guards on
  // view !== previousView, and catalog list-state updates never focus.
  const apply = code.match(/function applyViewState\(next, mode = 'push'\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(apply);
  assert.match(apply[1], /viewState\.view !== previousView\)\s*focusViewHeading/);
  const setCatalogue = code.match(/function setCatalogueState\(partial, resetPage = false\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(setCatalogue);
  assert.doesNotMatch(setCatalogue[1], /focus/, 'filter/search keystrokes never move focus');
  const setCataloguePage = code.match(/function setCataloguePage\(page\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(setCataloguePage);
  assert.doesNotMatch(setCataloguePage[1], /focusViewHeading/);
  // The authenticated reveal (login or reload) focuses the active view once.
  const load = code.match(/async function loadArtworks\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(load);
  assert.match(load[1], /focusViewHeading\(viewState\.view\)/);
});

test('popstate view changes move focus; same-view pops do not', () => {
  const pop = adminJs.match(/window\.addEventListener\('popstate', \(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(pop, 'popstate handler exists');
  assert.match(pop[1], /target\.view !== previousView\)\s*focusViewHeading/);
});

// ===========================================================================
// Mobile accessibility contracts: 320px reflow, touch targets, safe areas,
// focus visibility, and reduced motion
// ===========================================================================

test('viewport supports safe areas and the page offers a keyboard skip link', () => {
  assert.match(adminHtml, /name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover"/);
  assert.match(adminHtml, /<a class="skip-link" href="#main-content">Skip to main content<\/a>/);
  assert.match(adminHtml, /<main class="admin-shell" id="main-content">/);
  assert.match(adminCss, /\.skip-link\s*\{[^}]*transform:\s*translateY/, 'the skip link is visually hidden but still focusable');
  assert.match(adminCss, /\.skip-link:focus\s*\{[^}]*transform:\s*none/, 'the skip link appears on focus');
});

test('catalogue row actions and pagination meet the 44px touch floor', () => {
  assert.match(adminCss.match(/\.cat-actions \.button\s*\{([^}]*)\}/)[1], /min-height:\s*44px/, 'row actions are 44px+');
  assert.match(adminCss.match(/\.pagination-controls \.page-button\s*\{([^}]*)\}/)[1], /min-height:\s*44px/, 'pagination buttons are 44px+');
});

test('mobile editor shows the live preview first and keeps saving in flow', () => {
  assert.match(adminCss, /\.admin-grid > \.preview-panel\s*\{[^}]*order:\s*-1/, 'the preview renders before the form on phones');
  assert.match(adminCss, /\.preview-image,\s*\.preview-image img\s*\{[^}]*height:\s*clamp\(180px,\s*56vw,\s*320px\)/, 'the preview height is viewport-proportional instead of a fixed 320px block');
  assert.match(adminCss, /\.editor-actions\s*\{[^}]*env\(safe-area-inset-bottom/, 'the desktop sticky save bar clears the home indicator');
  const phoneStart = adminCss.indexOf('@media (max-width: 767px)');
  assert.ok(phoneStart >= 0, 'a unified 767px phone layout block exists');
  const phone = adminCss.slice(phoneStart, adminCss.indexOf('@media', phoneStart + 10));
  // Paired desktop fields are un-compressed on phones: one full-width field
  // per row, never a squeezed two-column split at 320px.
  assert.match(phone, /\.field-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'paired fields become full-width single-column fields on phones');
  assert.match(phone, /\.editor-actions\s*\{[^}]*position:\s*static/, 'the phone save actions sit in flow instead of a sticky overlay');
  assert.match(phone, /\.editor-actions \.button\s*\{[^}]*min-height:\s*48px/, 'phone save/back buttons are 48px full-width targets');
});

test('focused view headings and the catalogue list clear the sticky header', () => {
  assert.match(adminCss, /h2\[tabindex="-1"\]\s*\{[^}]*scroll-margin-top:\s*92px/, 'headings scroll clear of the desktop bar');
  assert.match(adminCss, /h2\[tabindex="-1"\]:focus\s*\{[^}]*outline:\s*3px solid/, 'programmatic heading focus stays visible');
  assert.match(adminCss, /\.catalogue-list\s*\{[^}]*scroll-margin-top:\s*128px/, 'pagination scroll targets clear the sticky bar');
});

test('placeholder text is tinted from the palette at body-level contrast', () => {
  // #6f5c52 on the warm input surface measures >=4.5:1; neutral gray is banned.
  assert.match(adminCss, /::placeholder\s*\{[^}]*color:\s*#6f5c52/);
});

test('reduced-motion preferences remove the decorative hover lift and transitions', () => {
  const rm = adminCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(rm, 'a prefers-reduced-motion block exists');
  assert.match(rm[1], /transition:\s*none/);
  assert.match(rm[1], /transform:\s*none/);
});
