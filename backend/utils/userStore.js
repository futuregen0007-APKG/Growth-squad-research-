import User from '../models/User.js';
import bcrypt from 'bcryptjs';

export const sanitizeUser = (user) => {
  if (!user) return null;
  const { password, refreshTokens, ...rest } = user.toObject ? user.toObject() : user;
  return rest;
};

export const findUserByEmail = async (email) => {
  return await User.findOne({ email: email.toLowerCase() });
};

export const findUserByUsername = async (username) => {
  return await User.findOne({ username });
};

export const findUserByEmailWithPassword = async (email) => {
  return await User.findOne({ email: email.toLowerCase() }).select('+password');
};

export const createUser = async (userData) => {
  const user = new User({
    email: userData.email.toLowerCase(),
    username: userData.username,
    password: userData.password,
    role: userData.role || 'user',
    accountStatus: userData.accountStatus || 'active',
    isEmailVerified: userData.isEmailVerified || false
  });

  await user.save();
  return sanitizeUser(user);
};

export const updateLastLogin = async (userId) => {
  const user = await User.findByIdAndUpdate(
    userId,
    { lastLogin: new Date(), updatedAt: new Date() },
    { new: true }
  );
  return sanitizeUser(user);
};

export const comparePassword = async (plainPassword, hashedPassword) => {
  return bcrypt.compare(plainPassword, hashedPassword);
};
