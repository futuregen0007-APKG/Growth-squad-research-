import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { hashToken, signAccessToken, signRefreshToken, verifyToken } from '../utils/authTokens.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-with-at-least-32-characters';

const user = { _id: '507f1f77bcf86cd799439011', email: 'test@example.com', role: 'user' };

test('access and refresh tokens carry distinct token types', () => {
  assert.equal(verifyToken(signAccessToken(user), 'access').type, 'access');
  assert.equal(verifyToken(signRefreshToken(user), 'refresh').type, 'refresh');
});

test('refresh tokens are one-way hashed for persistence', () => {
  const token = signRefreshToken(user);
  assert.notEqual(hashToken(token), token);
  assert.equal(hashToken(token), hashToken(token));
});

test('expired access tokens are rejected', () => {
  const token = jwt.sign({ userId: user._id, type: 'access' }, process.env.JWT_SECRET, {
    expiresIn: -1,
    issuer: 'stock-market-ai',
    audience: 'client',
  });
  assert.throws(() => verifyToken(token, 'access'), jwt.TokenExpiredError);
});