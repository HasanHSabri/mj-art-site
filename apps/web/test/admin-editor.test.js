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
