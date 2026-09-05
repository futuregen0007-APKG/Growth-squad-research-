import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const JWT_ISSUER = 'stock-market-ai';
const JWT_AUDIENCE = 'client';

export const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  return secret;
};

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const signAccessToken = (user) => jwt.sign(
  { userId: String(user._id), email: user.email, role: user.role, type: 'access' },
  getJwtSecret(),
  { expiresIn: '15m', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
);

export const signRefreshToken = (user) => jwt.sign(
  { userId: String(user._id), type: 'refresh', tokenId: crypto.randomUUID() },
  getJwtSecret(),
  { expiresIn: '7d', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
);

export const verifyToken = (token, expectedType) => {
  const payload = jwt.verify(token, getJwtSecret(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  if (payload.type !== expectedType) throw new Error('Invalid token type');
  return payload;
};

export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/api/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

export const setRefreshCookie = (res, token) => {
  res.cookie('refreshToken', token, refreshCookieOptions());
};

export const clearRefreshCookie = (res) => {
  res.clearCookie('refreshToken', { ...refreshCookieOptions(), maxAge: undefined });
};

export const getRefreshToken = (req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookieToken = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('refreshToken='))
    ?.slice('refreshToken='.length);
  return cookieToken ? decodeURIComponent(cookieToken) : req.body?.refreshToken || null;
};