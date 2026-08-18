// portal-auth.js: HOD credential hashing and signed portal session tokens.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generatePassword(len = 12) {
  let out = '';
  while (out.length < len) {
    const b = crypto.randomBytes(1)[0];
    if (b < 256 - (256 % ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 32).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

function secret() {
  return process.env.SESSION_SECRET
    || crypto.createHash('sha256').update('clio-portal:' + (process.env.ADMIN_PASSWORD || 'dev')).digest('hex');
}

function makeToken(departmentId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ d: departmentId, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.d || !data.exp || Date.now() > data.exp) return null;
    return data.d;
  } catch { return null; }
}

module.exports = { generatePassword, hashPassword, verifyPassword, makeToken, verifyToken };
