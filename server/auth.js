import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { User } from './models/User.js';

const developmentSecret = crypto.randomBytes(32).toString('hex');

function signingSecret() {
  return process.env.JWT_SECRET || developmentSecret;
}

export function issueToken(user) {
  return jwt.sign({ sub: String(user._id) }, signingSecret(), { expiresIn: '7d' });
}

export function decodeToken(token) {
  return jwt.verify(token, signingSecret());
}

export async function requireAuth(request, response, next) {
  try {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return response.status(401).json({ message: 'Please sign in to access your support queue.' });
    const payload = decodeToken(token);
    const user = await User.findById(payload.sub).lean();
    if (!user) return response.status(401).json({ message: 'Your account is no longer available. Please sign in again.' });
    request.user = user;
    return next();
  } catch (_error) {
    return response.status(401).json({ message: 'Your session has expired. Please sign in again.' });
  }
}

export function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email, role: user.role || 'employee' };
}

export function socketToken(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) throw new Error('Authentication required.');
  return decodeToken(token);
}
