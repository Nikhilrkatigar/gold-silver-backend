// Run: npm test  (Node's built-in test runner, no database needed)
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const run = async (token, user) => {
  User.findById = async () => user;
  const req = { header: () => `Bearer ${token}` };
  let status = 200;
  let nextCalled = false;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  await auth(req, res, () => { nextCalled = true; });
  return nextCalled ? 200 : status;
};

const sign = (iatSecondsAgo) => jwt.sign(
  { userId: 'u1', iat: Math.floor(Date.now() / 1000) - iatSecondsAgo },
  process.env.JWT_SECRET
);

test('valid token for active user passes', async () => {
  assert.strictEqual(await run(sign(10), { _id: 'u1', isActive: true }), 200);
});

test('token issued before a password change is rejected', async () => {
  const user = { _id: 'u1', isActive: true, passwordChangedAt: new Date(Date.now() - 5000) };
  assert.strictEqual(await run(sign(60), user), 401);
  assert.strictEqual(await run(sign(0), user), 200);
});

test('deactivated user is blocked', async () => {
  assert.strictEqual(await run(sign(10), { _id: 'u1', isActive: false }), 403);
});

test('forged token is rejected', async () => {
  const forged = jwt.sign({ userId: 'u1' }, 'wrong-secret');
  assert.strictEqual(await run(forged, { _id: 'u1', isActive: true }), 401);
});
