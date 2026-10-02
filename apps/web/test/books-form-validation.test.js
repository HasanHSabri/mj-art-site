// Client-side Books EOI validation contracts: firstInvalidEoiField names the
// exact failing field (in announcement order) and invalidFieldMessage maps it
// to a specific, actionable message. These pure helpers power the submit
// handler's per-field messaging, aria-invalid flagging, and focus behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEoiPayload,
  firstInvalidEoiField,
  invalidFieldMessage,
  hasNoSelection
} from '../public/books.js';

const VALID = {
  selections: [
    { book: 'biography', checked: true, quantity: '2' },
    { book: 'childrens', checked: false, quantity: '1' }
  ],
  name: 'Jane Smith',
  email: 'jane@example.com',
  consent: true,
  turnstileToken: 'token'
};

test('a complete valid form passes the client checks and builds a payload', () => {
  assert.equal(firstInvalidEoiField(VALID), '');
  assert.ok(buildEoiPayload(VALID), 'valid values must still produce a payload');
});

test('no checked book is reported as the selections field', () => {
  const values = { ...VALID, selections: VALID.selections.map((s) => ({ ...s, checked: false })) };
  assert.equal(firstInvalidEoiField(values), 'selections');
  assert.ok(hasNoSelection(values));
});

test('an unknown book value is reported as selections', () => {
  const values = {
    ...VALID,
    selections: [{ book: 'unreleased', checked: true, quantity: '1' }]
  };
  assert.equal(firstInvalidEoiField(values), 'selections');
});

test('a bad quantity on any checked book is reported as quantity', () => {
  for (const quantity of ['', '0', '11', 'two']) {
    const values = {
      ...VALID,
      selections: [{ book: 'biography', checked: true, quantity }]
    };
    assert.equal(firstInvalidEoiField(values), 'quantity', `quantity "${quantity}"`);
  }
});

test('a missing name is reported as name', () => {
  assert.equal(firstInvalidEoiField({ ...VALID, name: '   ' }), 'name');
});

test('an empty or malformed email is reported as email', () => {
  assert.equal(firstInvalidEoiField({ ...VALID, email: '' }), 'email');
  assert.equal(firstInvalidEoiField({ ...VALID, email: 'jane at example' }), 'email');
  assert.equal(firstInvalidEoiField({ ...VALID, email: 'jane@example' }), 'email');
});

test('server-rejected email shapes are caught client-side too (parity)', () => {
  // The API's normalizeEmail also rejects consecutive dots and >320 chars;
  // the client helper mirrors those so the visitor gets the field-level
  // message instead of a generic server failure after the round-trip.
  assert.equal(firstInvalidEoiField({ ...VALID, email: 'jane..doe@example.com' }), 'email');
  assert.equal(
    firstInvalidEoiField({ ...VALID, email: 'a'.repeat(314) + '@example.com' }),
    'email'
  );
  // Exactly 320 characters stays within the server's cap.
  assert.equal(
    firstInvalidEoiField({ ...VALID, email: 'a'.repeat(308) + '@example.com' }),
    ''
  );
});

test('an over-long name is reported as name (server parity)', () => {
  // canonicalizeName caps the collapsed name at 100 characters.
  const longName = Array.from({ length: 101 }, () => 'x').join('');
  assert.equal(firstInvalidEoiField({ ...VALID, name: longName }), 'name');
  assert.equal(firstInvalidEoiField({ ...VALID, name: 'x'.repeat(60) + '   ' + 'y'.repeat(60) }), 'name');
  assert.equal(firstInvalidEoiField({ ...VALID, name: 'x'.repeat(100) }), '');
});

test('unticked consent is reported as consent', () => {
  assert.equal(firstInvalidEoiField({ ...VALID, consent: false }), 'consent');
});

test('a missing Turnstile token is reported as verification', () => {
  assert.equal(firstInvalidEoiField({ ...VALID, turnstileToken: '' }), 'verification');
});

test('fields are checked in announcement order: selections, quantity, name, email, consent, verification', () => {
  const everything = {
    selections: [{ book: 'biography', checked: true, quantity: '99' }],
    name: '',
    email: '',
    consent: false,
    turnstileToken: ''
  };
  assert.equal(firstInvalidEoiField(everything), 'quantity');
  delete everything.selections[0].quantity;
  everything.selections[0].quantity = '1';
  assert.equal(firstInvalidEoiField(everything), 'name');
  everything.name = 'Jane';
  assert.equal(firstInvalidEoiField(everything), 'email');
  everything.email = 'jane@example.com';
  assert.equal(firstInvalidEoiField(everything), 'consent');
  everything.consent = true;
  assert.equal(firstInvalidEoiField(everything), 'verification');
});

test('every known field key maps to a distinct, specific message', () => {
  const keys = ['selections', 'quantity', 'name', 'email', 'consent', 'verification'];
  const messages = keys.map(invalidFieldMessage);
  for (const message of messages) {
    assert.ok(typeof message === 'string' && message.length > 0);
  }
  assert.equal(new Set(messages).size, keys.length, 'messages are field-specific');
});

test("the selections message matches the form's established no-selection wording", () => {
  assert.equal(
    invalidFieldMessage('selections'),
    'Please choose at least one book to join the update list.'
  );
});

test('an unknown field key falls back to the generic completion message', () => {
  assert.match(invalidFieldMessage('unexpected'), /complete every field/i);
});

test('helper verdicts stay consistent with buildEoiPayload guards', () => {
  // Every case the helper flags (other than email format) must also be
  // rejected by buildEoiPayload, so the two never disagree on submission.
  const cases = [
    { ...VALID, selections: [] },
    { ...VALID, selections: [{ book: 'biography', checked: true, quantity: '0' }] },
    { ...VALID, name: '' },
    { ...VALID, consent: false },
    { ...VALID, turnstileToken: '' }
  ];
  for (const values of cases) {
    assert.equal(buildEoiPayload(values), null);
    assert.notEqual(firstInvalidEoiField(values), '');
  }
  // Deliberate exception: the client checks email FORMAT more strictly than
  // the payload builder so a malformed address is caught pre-submission.
  const malformed = { ...VALID, email: 'not-an-email' };
  assert.equal(firstInvalidEoiField(malformed), 'email');
  assert.ok(buildEoiPayload(malformed));
});
