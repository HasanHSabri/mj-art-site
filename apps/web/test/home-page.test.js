import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickActiveSection, sectionIdsFromHrefs, SECTION_NAV_OFFSET } from '../public/home-section-nav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf8');
const homeSectionNavJs = readFileSync(join(publicDir, 'home-section-nav.js'), 'utf8');
const rootPkg = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');

function ruleBody(css, selector) {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

// ===========================================================================
// 1. Exact Home hero copy (approved micro-adjustment)
// ===========================================================================

test('home hero eyebrow is exactly "Art shaped by courage, faith, and hope"', () => {
  const eyebrow = indexHtml.match(/<p class="eyebrow">([\s\S]*?)<\/p>/);
  assert.ok(eyebrow, 'an eyebrow paragraph exists');
  assert.equal(
    eyebrow[1].trim(),
    'Art shaped by courage, faith, and hope',
    'the hero eyebrow copy must be exact'
  );
});

test('home hero heading is exactly "Colour, courage, and a story still unfolding."', () => {
  const h1 = indexHtml.match(/<h1>([\s\S]*?)<\/h1>/);
  assert.ok(h1);
  assert.equal(h1[1].trim(), 'Colour, courage, and a story still unfolding.');
});

test('home hero description is the exact approved copy (Australian spelling)', () => {
  const heroText = indexHtml.match(/<p class="hero-text">([\s\S]*?)<\/p>/);
  assert.ok(heroText);
  const normalized = heroText[1].replace(/\s+/g, ' ').trim();
  assert.equal(
    normalized,
    'Living with Multiple Sclerosis changed the rhythm of MJ&rsquo;s life, but it also opened an unexpected path into art. Guided by faith and a love of colour, she paints through the difficult days, the hopeful ones, and all the beautifully imperfect moments in between.'
  );
  assert.equal(normalized.includes('colour'), true, 'Australian spelling: colour');
  assert.equal(/color\b/.test(normalized), false, 'no US spelling in the hero');
});

test('the removed hero pills are gone', () => {
  assert.doesNotMatch(indexHtml, /hero-tags/, 'the hero pills container must be removed');
  assert.equal(indexHtml.includes('Original works'), false);
  assert.equal(indexHtml.includes('Direct inquiries'), false);
  assert.equal(indexHtml.includes('Two books in progress'), false);
});

test('home hero keeps the Gallery and painting-enquiry actions', () => {
  const actions = indexHtml.match(/<div class="hero-actions">([\s\S]*?)<\/div>/)[1];
  assert.match(actions, /class="button button-primary" href="\/gallery"/);
  assert.match(actions, />Browse the full collection</);
  assert.match(actions, /class="button button-secondary" href="#contact"/);
  assert.match(actions, />Ask about a painting</);
});

// ===========================================================================
// 2. Home secondary section navigator (exact 3 links, sticky rail / wrapped row)
// ===========================================================================

test('home secondary nav carries exactly Story, Testimonials, Enquire in order', () => {
  const nav = indexHtml.match(/<nav class="home-section-nav"[^>]*>([\s\S]*?)<\/nav>/);
  assert.ok(nav, 'the .home-section-nav nav exists');
  assert.match(nav[0], /aria-label="Sections"/, 'the secondary nav has its own label');
  const links = (nav[1].match(/<a href="[^"]+">[^<]*<\/a>/g) || []).map(
    (s) => s.match(/<a href="([^"]+)">([^<]*)<\/a>/).slice(1)
  );
  assert.deepEqual(links, [
    ['#story', 'Story'],
    ['#testimonials', 'Testimonials'],
    ['#contact', 'Enquire']
  ]);
  for (const id of ['story', 'testimonials', 'contact']) {
    assert.ok(new RegExp(`\\bid="${id}"`).test(indexHtml), `#${id} target exists`);
  }
});

test('home secondary nav is NOT the old right rail and adds no second primary nav', () => {
  // The removed chapter rail must stay gone; the new nav is distinct.
  assert.doesNotMatch(indexHtml, /chapter-nav|chapter-rail|chapter-disclosure|chapter-menu|chapter-link/i);
  assert.doesNotMatch(indexHtml, /chapter-nav\.js/);
  // Only one primary navigation landmark; the section nav is labelled Sections.
  const primaryNavs = indexHtml.match(/aria-label="Primary navigation"/g) || [];
  assert.equal(primaryNavs.length, 1);
});

test('home main becomes the sticky-rail grid on wide screens; a wrapped row below', () => {
  const mq = stylesCss.match(/@media\s*\(\s*min-width:\s*1100px\s*\)\s*\{([\s\S]*?)\}\s*\}/);
  assert.ok(mq, 'a min-width: 1100px media block exists');
  const block = mq[1];
  assert.match(block, /\.home-main\s*\{[^}]*display:\s*grid/, 'wide screens: .home-main is a grid');
  assert.match(
    block,
    /\.home-main\s*\{[^}]*grid-template-columns:\s*1\d\dpx\s+minmax\(0,\s*1fr\)/,
    'a slim left rail column beside the content column'
  );
  assert.match(block, /\.home-section-nav\s*\{[^}]*position:\s*sticky/, 'the rail is sticky');
  assert.match(block, /\.home-content\s*\{[^}]*grid-column:\s*2/, 'the content wrapper lives in the content column');

  // Base (narrow) form: a compact horizontal wrapped row, not a grid rail.
  const base = ruleBody(stylesCss, '.home-section-nav');
  assert.ok(base);
  assert.match(base, /display:\s*flex/, 'the base nav is a flex row');
  assert.match(base, /flex-wrap:\s*wrap/, 'the base nav wraps');
});

test('home rail keeps natural page flow: no artificial row span or fixed min-height', () => {
  // Regression: `.home-section-nav { grid-row: 1 / span 100 }` made the grid
  // create ~100 implicit rows; the 44px row-gap between them injected
  // thousands of px of blank space between the last section and the footer.
  // The rail must ride one natural row beside a .home-content wrapper.
  const mq = stylesCss.match(/@media\s*\(\s*min-width:\s*1100px\s*\)\s*\{([\s\S]*?)\}\s*\}/);
  assert.ok(mq);
  const block = mq[1];
  assert.doesNotMatch(block, /grid-row:\s*[^;}]*span\s*\d+/i, 'no artificial grid-row span');
  assert.doesNotMatch(stylesCss, /span\s+100/, 'the old span-100 hack is gone');
  assert.doesNotMatch(block, /min-height:\s*[3-9]\d{2,}/, 'no large fixed min-height propping the layout');
  // Exactly one natural grid row: the rail is placed on row 1 only.
  assert.match(block, /\.home-section-nav\s*\{[^}]*grid-row:\s*1\s*;/, 'the rail sits on the single first row');
});

test('home secondary nav active and focus states are shape+weight, not colour alone', () => {
  const active = ruleBody(stylesCss, '.home-section-nav a[aria-current="true"]');
  assert.ok(active, 'an aria-current rule exists');
  assert.match(active, /font-weight:\s*600/, 'active link is heavier');
  assert.match(active, /text-decoration:\s*underline/, 'active link is underlined');
  assert.match(active, /text-decoration-thickness:\s*2px/, 'the underline is a deliberate 2px');
  // Focus is distinct from the active treatment (the unified ring).
  assert.ok(stylesCss.includes('.home-section-nav a:focus-visible'), 'focus-visible ring applies');
});

test('home-section-nav.js syncs active state via scroll + history/hash events', () => {
  assert.match(homeSectionNavJs, /addEventListener\(\s*['"]scroll['"]\s*,\s*sync\s*,\s*\{\s*passive:\s*true\s*\}\s*\)/);
  assert.match(homeSectionNavJs, /addEventListener\(\s*['"]hashchange['"]\s*,\s*sync\s*\)/);
  assert.match(homeSectionNavJs, /addEventListener\(\s*['"]popstate['"]\s*,\s*sync\s*\)/);
  assert.match(homeSectionNavJs, /aria-current/, 'the active link carries aria-current');
  // Sticky-header/scroll-margin offset is accounted for in the scroll line.
  assert.ok(Number.isInteger(SECTION_NAV_OFFSET) && SECTION_NAV_OFFSET >= 24);
});

test('home-section-nav.js is syntax-checked by build/lint/type-check', () => {
  for (const script of ['build', 'lint', 'type-check']) {
    assert.ok(
      rootPkg.includes('node --check public/home-section-nav.js'),
      `public/home-section-nav.js must be in the ${script} check list`
    );
  }
  assert.match(indexHtml, /src="\.\/home-section-nav\.js/, 'home loads the module');
});

test('home markup wraps all sections in one .home-content flow beside the rail', () => {
  const main = indexHtml.match(/<main class="home-main">([\s\S]*?)<\/main>/);
  assert.ok(main, 'the .home-main element exists');
  const inner = main[1];
  const wrapperAt = inner.indexOf('<div class="home-content">');
  assert.ok(wrapperAt !== -1, 'a .home-content wrapper exists inside main');
  assert.equal(
    (inner.match(/<div class="home-content">/g) || []).length,
    1,
    'exactly one content wrapper'
  );
  const beforeWrapper = inner.slice(0, wrapperAt);
  assert.match(beforeWrapper, /<nav class="home-section-nav"/, 'the rail nav precedes the wrapper');
  assert.doesNotMatch(beforeWrapper, /<section/, 'no section is a direct grid child of main');
  // All five Home sections (story, gallery preview, books preview,
  // testimonials, contact) flow inside the wrapper, and the wrapper closes
  // just before </main>: the page ends where the content ends.
  assert.equal((inner.match(/<section/g) || []).length, 5, 'all five sections live inside the wrapper');
  assert.match(inner, /<\/section>\s*<\/div>\s*$/, 'the wrapper closes after the last section, at the end of main');
});

// --- pure helpers -----------------------------------------------------------

test('pickActiveSection: last section at/above the line wins; first before any; last at page bottom', () => {
  const sections = [
    { id: 'story', top: 800 },
    { id: 'testimonials', top: 4200 },
    { id: 'contact', top: 5600 }
  ];
  assert.equal(pickActiveSection(sections, 100), 'story', 'above everything -> first section');
  assert.equal(pickActiveSection(sections, 800), 'story', 'exactly at the story top -> story');
  assert.equal(pickActiveSection(sections, 900), 'story');
  assert.equal(pickActiveSection(sections, 4300), 'testimonials');
  assert.equal(pickActiveSection(sections, 99999), 'contact');
  // Bottom-of-page clamp: the final section is active even if its top is
  // still below the scroll line (short viewport at the page end).
  assert.equal(pickActiveSection(sections, 5000, true), 'contact');
  assert.equal(pickActiveSection([], 500), '', 'no sections -> empty');
  assert.equal(pickActiveSection(undefined, 500), '');
});

test('sectionIdsFromHrefs keeps bare in-page hashes only', () => {
  assert.deepEqual(sectionIdsFromHrefs(['#story', '#testimonials', '#contact']), ['story', 'testimonials', 'contact']);
  assert.deepEqual(sectionIdsFromHrefs(['/gallery', '#contact', 'mailto:x@y.z', '', null]), ['contact']);
  assert.deepEqual(sectionIdsFromHrefs(null), []);
});

// ===========================================================================
// 3. Story section: exact eyebrow/heading, preserved prose, portrait reserve
// ===========================================================================

test('story eyebrow and heading are the exact approved copy', () => {
  const story = indexHtml.match(/<section class="section story-layout" id="story">([\s\S]*?)<div class="story-copy/)[1];
  assert.match(story, /<p class="section-label">MJ&rsquo;s story<\/p>/);
  assert.equal(
    story.match(/<h2>([\s\S]*?)<\/h2>/)[1].trim(),
    'When life changed, creativity opened a new way forward.'
  );
});

test('story prose is preserved apart from Australian spelling corrections', () => {
  const copy = indexHtml.match(/<div class="story-copy artist-story">([\s\S]*?)<\/div>/)[1];
  // The genuine first-person story stays, with colours (not colors).
  assert.match(copy, /On 29th May 2020, my world shifted/);
  assert.match(copy, /watching colours collide/);
  assert.doesNotMatch(copy, /\bcolors\b/, 'US spelling corrected');
  assert.match(copy, /From my heart to yours, love, courage, and gratitude/);
});

test('the story-left area integrates the real portrait with its full natural ratio', () => {
  const intro = indexHtml.match(/<div class="story-intro">([\s\S]*?)<\/div>/);
  assert.ok(intro, 'the story intro column exists');
  assert.match(
    intro[0],
    /<img class="artist-portrait" src="\/images\/mj-portrait\.jpg" width="901" height="1200" loading="lazy" decoding="async" alt="Portrait of MJ">/
  );
  // The portrait keeps its full natural ratio inside a responsive frame: no
  // aggressive crop, no leftover reserve styling or crop marks.
  const portraitRule = ruleBody(stylesCss, '.artist-portrait');
  assert.ok(portraitRule, 'the portrait is framed');
  assert.match(portraitRule, /object-fit:\s*contain/, 'contain, never a crop');
  assert.match(portraitRule, /width:\s*min\(100%,\s*320px\)/, 'responsive size capped like the composition it replaced');
  assert.match(portraitRule, /height:\s*auto/, 'the height follows the natural ratio');
  assert.equal(ruleBody(stylesCss, '.portrait-reserve'), null, 'the obsolete reserve styling is removed');
  assert.doesNotMatch(stylesCss, /\.portrait-reserve::(before|after)/, 'no crop-mark pseudo elements remain');
  assert.equal(indexHtml.includes('portrait-reserve'), false, 'no reserve markup remains');
});

// ===========================================================================
// 4. Testimonials: exactly one genuine card (Jenny), no permission note
// ===========================================================================

test('testimonials show only the genuine Jenny quote, with no empty/permission card', () => {
  const section = indexHtml.match(/<section class="section testimonials-section"[^>]*>([\s\S]*?)<\/section>/)[1];
  const quotes = section.match(/<blockquote>/g) || [];
  assert.equal(quotes.length, 1, 'exactly one testimonial card');
  assert.match(section, /MJ's artwork are all one of a kind/);
  assert.match(section, /<cite>Jenny<\/cite>/);
  assert.doesNotMatch(indexHtml, /testimonials-empty/, 'the empty-state card is removed');
  assert.equal(
    indexHtml.includes('Additional testimonials will be shared here only with permission'),
    false,
    'the permission note is removed'
  );
  // Elegant single measure, extensible stacking. (Several rules mention the
  // selector; scan every standalone .testimonials-grid rule for the column
  // definition and the centered, measure-bounded quote.)
  const gridRules = [...stylesCss.matchAll(/\.testimonials-grid\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(
    gridRules.some((body) => /grid-template-columns:\s*1fr/.test(body)),
    'single column'
  );
  assert.ok(
    gridRules.some((body) => /justify-items:\s*center/.test(body)),
    'centered'
  );
  const quoteRules = [...stylesCss.matchAll(/\.testimonials-grid blockquote\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(quoteRules.some((body) => /max-width:\s*62ch/.test(body)), 'readable measure for one quote');
});

// ===========================================================================
// 5. Shared header/footer wordmark
// ===========================================================================

test('home header and footer wordmark read MJ Arts (no logo/icon)', () => {
  assert.match(indexHtml, /<a class="brand" href="\/" aria-label="MJ Arts home">MJ Arts<\/a>/);
  assert.match(indexHtml, /&copy; MJ Arts\. Original paintings by MJ\./);
  assert.doesNotMatch(indexHtml, /<img[^>]*class="[^"]*brand/, 'no logo added');
});

// ===========================================================================
// 6. Books preview on Home: visitor titles/descriptions + cover reserves
// ===========================================================================

test('home books preview uses the visitor titles, exact descriptions, and the real covers', () => {
  const section = indexHtml.match(/<section class="section books-preview-section"[\s\S]*?<\/section>/)[0];
  assert.equal(
    section.match(/<h2 id="books-preview-heading">([\s\S]*?)<\/h2>/)[1],
    'Two books.. almost ready for launch!',
    'the exact requested books preview heading'
  );
  assert.match(section, /<h3>Frayed Not Broken<\/h3>/);
  assert.equal(section.includes('Biography'), false, 'the old visitor Biography label is gone');
  assert.match(section, /<h3>MJ and Her Wobbly Days<\/h3>/, 'the exact corrected title');
  assert.equal(section.includes('MJ and the Wobbly Days'), false, 'the old title is gone');
  assert.doesNotMatch(section, /Children&rsquo;s Book/, 'the old visitor Children\'s Book label is gone');
  const bio = section.match(/<p class="books-panel-text">([\s\S]*?)<\/p>/)[1].replace(/\s+/g, ' ').trim();
  assert.equal(
    bio,
    'An honest and personal reflection on life with Multiple Sclerosis&mdash;its fragility, its unexpected strength, and the faith and hope that continue to carry MJ forward.'
  );
  const kids = (section.match(/<p class="books-panel-text">([\s\S]*?)<\/p>/g)[1]).replace(/\s+/g, ' ').trim();
  assert.equal(
    kids,
    '<p class="books-panel-text">A gentle children&rsquo;s story about meeting uncertain and wobbly days with courage, kindness, and hope.</p>'.replace(/\s+/g, ' ')
  );
  // Each card opens with the real cover in the shared contain frame (the same
  // public URLs as the Books page, no reserve treatment).
  assert.match(
    section,
    /<img class="book-cover" src="\/images\/frayed-not-broken-cover\.jpg" width="797" height="1200" loading="lazy" decoding="async" alt="Cover of Frayed Not Broken">/
  );
  assert.match(
    section,
    /<img class="book-cover" src="\/images\/mj-and-her-wobbly-days-cover\.jpg" width="488" height="629" loading="lazy" decoding="async" alt="Cover of MJ and Her Wobbly Days">/
  );
  assert.equal((section.match(/class="book-cover-frame"/g) || []).length, 2);
  assert.equal(section.includes('book-cover-reserve'), false, 'no reserve markup remains on Home');
  // No repeated old disclaimer language on Home.
  assert.equal(section.includes('not a payment'), false);
  assert.equal(section.includes('not a commitment to buy'), false);
});

// ===========================================================================
// 7. Book cover reserves (shared shape)
// ===========================================================================

test('book cover frames are portrait-oriented, spine-treated, and responsively capped', () => {
  const rule = ruleBody(stylesCss, '.book-cover-frame');
  assert.ok(rule);
  assert.match(rule, /aspect-ratio:\s*3\s*\/\s*4/, 'portrait orientation');
  assert.match(
    rule,
    /linear-gradient\(90deg,\s*rgba\(154,\s*92,\s*75,\s*0\.1\d\),\s*rgba\(154,\s*92,\s*75,\s*0\)\s*16%\)/,
    'a soft tonal falloff toward the spine edge (no hard side stripe)'
  );
  assert.doesNotMatch(rule, /inset 3px/, 'no hard side-tab stripe');
  // The complete cover is always visible: contain, never a crop.
  const imgRule = ruleBody(stylesCss, '.book-cover-frame img');
  assert.match(imgRule, /object-fit:\s*contain/);
  // Mobile height stays modest via a narrower cap under 640px.
  const mq = stylesCss.match(/@media\s*\(\s*max-width:\s*640px\s*\)\s*\{([\s\S]*?)\}\s*(?=@media)/);
  assert.ok(mq);
  assert.match(mq[1], /\.book-cover-frame\s*\{[^}]*width:\s*min\(100%,\s*1\d\dpx\)/);
});

// ===========================================================================
// 8. Australian visitor spelling on Home
// ===========================================================================

test('home visitor-facing copy uses enquiry, never inquiry', () => {
  // Visitor-visible text (button labels, notes, headings) uses enquiry. The
  // form's id="inquiry-form" is an internal identifier shared with home.js,
  // deliberately not renamed.
  const visibleText = indexHtml.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visibleText, /inquir/i, 'no visitor-visible inquiry spelling on Home');
  assert.match(visibleText, /enquir/i, 'enquiry spelling present');
  assert.match(indexHtml, />Create email enquiry</);
});
