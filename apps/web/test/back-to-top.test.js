import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const scriptJs = readFileSync(join(publicDir, 'script.js'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

test('back-to-top is a static, accessible button control in index.html', () => {
  const btn = indexHtml.match(/<button\b[^>]*\bid="back-to-top"[^>]*>([\s\S]*?)<\/button>/i);
  assert.ok(btn, '#back-to-top <button> exists in index.html');
  assert.ok(
    /\btype="button"/.test(btn[0]),
    '#back-to-top must be type="button" (no form submit)'
  );
  assert.ok(
    /\bclass="[^"]*\bbutton\b[^"]*"/.test(btn[0]),
    '#back-to-top reuses the established .button style'
  );
  assert.match(
    btn[1].trim(),
    /^Back to Top$/,
    'visible text must be exactly "Back to Top" (also its accessible name)'
  );
  assert.ok(
    /\bhidden\b/.test(btn[0]),
    '#back-to-top must start hidden (removed from tab order at page top)'
  );
});

test('an element with id="top" exists as the scroll target', () => {
  assert.ok(
    /\bid="top"/.test(indexHtml),
    'index.html must expose #top for the back-to-top click target'
  );
});

test('back-to-top is fixed and pinned to center-bottom with the iOS safe area', () => {
  const body = ruleBody(stylesCss, '.back-to-top');
  assert.ok(body, '.back-to-top rule exists in styles.css');
  assert.match(body, /position:\s*fixed/, '.back-to-top must be position: fixed');
  assert.match(
    body,
    /bottom:\s*calc\(\s*env\(\s*safe-area-inset-bottom/,
    '.back-to-top bottom must include env(safe-area-inset-bottom)'
  );
  assert.match(body, /left:\s*0/, '.back-to-top must anchor left: 0');
  assert.match(body, /right:\s*0/, '.back-to-top must anchor right: 0');
  assert.match(
    body,
    /margin-inline:\s*auto/,
    '.back-to-top must center via margin-inline: auto (transform-free)'
  );
  assert.match(
    body,
    /width:\s*fit-content/,
    '.back-to-top needs a constrained width for auto-margin centering'
  );
  assert.match(
    body,
    /max-width:\s*calc\(100%\s*-\s*\d+px\)/,
    '.back-to-top must cap width to avoid horizontal overflow'
  );
});

test('centering never relies on transform (so .button hover nudge cannot break it)', () => {
  const body = ruleBody(stylesCss, '.back-to-top');
  assert.ok(body);
  assert.doesNotMatch(
    body,
    /transform\s*:/,
    '.back-to-top positioning must not use transform (would clash with .button:hover translateY)'
  );
});

test('hidden attribute fully removes the control (wins over .button display)', () => {
  const body = ruleBody(stylesCss, '.back-to-top[hidden]');
  assert.ok(body, '.back-to-top[hidden] override must exist');
  assert.match(body, /display:\s*none/, '.back-to-top[hidden] must be display: none');
});

test('touch target stays >= 44px via the shared .button min-height', () => {
  const buttonBody = ruleBody(stylesCss, '.button');
  assert.ok(buttonBody, '.button rule exists');
  const m = buttonBody.match(/min-height:\s*(\d+(?:\.\d+)?)px/i);
  assert.ok(m, '.button must declare a min-height');
  assert.ok(
    Number(m[1]) >= 44,
    `.button min-height must be >= 44px for touch targets (got ${m[1]}px)`
  );
});

test('focus-visible styling is present', () => {
  const body = ruleBody(stylesCss, '.back-to-top:focus-visible');
  assert.ok(body, '.back-to-top:focus-visible rule must exist');
  assert.match(body, /outline:/, 'focus-visible must provide an outline');
});

test('global CSS reduced-motion override disables smooth scrolling', () => {
  const mq = stylesCss.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\}\s*\}\s*$/);
  assert.ok(mq, 'a prefers-reduced-motion: reduce media block must exist');
  const block = mq[1];
  assert.match(block, /scroll-behavior:\s*auto/, 'html smooth scroll must become auto under reduced motion');
});

test('JS reveals the control only past the scroll threshold and hides it for the dialog', () => {
  assert.match(scriptJs, /BACK_TO_TOP_THRESHOLD\s*=\s*400/, 'threshold must be ~400px');
  assert.match(
    scriptJs,
    /addEventListener\(\s*['"]scroll['"]\s*,\s*\w+\s*,\s*\{\s*passive:\s*true\s*\}\s*\)/,
    'scroll listener must be passive'
  );
  assert.match(
    scriptJs,
    /\.hidden\s*=\s*[^;]*dialog\.open/,
    'visibility must factor dialog.open (hide while painting dialog is open)'
  );
  assert.match(
    scriptJs,
    /window\.scrollY\s*<\s*BACK_TO_TOP_THRESHOLD/,
    'visibility must factor scrollY vs threshold'
  );
  assert.match(
    scriptJs,
    /dialog\.addEventListener\(\s*['"]toggle['"]/,
    'dialog toggle event must re-sync visibility on open/close'
  );
});

test('JS click respects prefers-reduced-motion and targets #top', () => {
  assert.match(
    scriptJs,
    /matchMedia\(\s*['"]\(prefers-reduced-motion:\s*reduce\)['"]\)/,
    'must query prefers-reduced-motion'
  );
  assert.match(scriptJs, /getElementById\(\s*['"]top['"]\)/, 'click must scroll to #top');
  assert.match(
    scriptJs,
    /behavior\s*=\s*reducedMotion\(\)\s*\?\s*['"]auto['"]\s*:\s*['"]smooth['"]/,
    'behavior must be auto under reduced motion, smooth otherwise'
  );
  assert.match(
    scriptJs,
    /scrollIntoView\(\s*\{\s*behavior\s*,\s*block:\s*['"]start['"]\s*\}\s*\)/,
    'must scrollIntoView #top with the chosen behavior'
  );
});
