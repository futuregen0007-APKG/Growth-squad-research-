import User from '../models/User.js';
import { getJwtSecret, verifyToken } from '../utils/authTokens.js';
import jwt from 'jsonwebtoken';

export const authenticate = async (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;

  if (!token) return res.status(401).json({ success: false, error: 'Authentication required' });

  try {
    const payload = verifyToken(token, 'access');
    const user = await User.findById(payload.userId);
    if (!user || user.accountStatus !== 'active') {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    req.user = user;
    req.userId = String(user._id);
    return next();
  } catch (error) {
    const message = error instanceof jwt.TokenExpiredError ? 'Access token expired' : 'Invalid access token';
    return res.status(401).json({ success: false, error: message });
  }
};

export default authenticate;