// test/portal-auth.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  hashPassword,
  verifyPassword,
  generatePassword,
  makeToken,
  verifyToken,
  verifyTokenFull
} = require('../portal-auth');

test('hashPassword/verifyPassword: roundtrip succeeds and wrong password is rejected', () => {
  const stored = hashPassword('correct-horse-battery');
  assert.strictEqual(verifyPassword('correct-horse-battery', stored), true);
  assert.strictEqual(verifyPassword('wrong-password', stored), false);
});

test('generatePassword: returns 12 chars from an unambiguous alphabet and differs across calls', () => {
  const banned = /[0O1lI]/;
  const p1 = generatePassword();
  const p2 = generatePassword();
  assert.strictEqual(p1.length, 12);
  assert.strictEqual(p2.length, 12);
  assert.strictEqual(banned.test(p1), false);
  assert.strictEqual(banned.test(p2), false);
  assert.notStrictEqual(p1, p2);
});

test('makeToken/verifyToken: roundtrip returns the department id', () => {
  const token = makeToken(42);
  assert.strictEqual(verifyToken(token), 42);
});

test('verifyToken: rejects a tampered token', () => {
  const token = makeToken(42);
  const [payload, sig] = token.split('.');
  const tampered = `${payload}x.${sig}`;
  assert.strictEqual(verifyToken(tampered), null);
});

test('verifyToken: rejects an expired token', () => {
  const token = makeToken(42, null, -1000);
  assert.strictEqual(verifyToken(token), null);
});

test('verifyTokenFull: carries the credential stamp for server-side matching', () => {
  const token = makeToken(7, '2026-08-18 15:00:00');
  const full = verifyTokenFull(token);
  assert.strictEqual(full.deptId, 7);
  assert.strictEqual(full.credStamp, '2026-08-18 15:00:00');
  const legacy = makeToken(7);
  assert.strictEqual(verifyTokenFull(legacy).credStamp, null);
});
