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

// credStamp binds the token to the credential generation that minted it:
// regenerating or revoking credentials changes the stamp and kills old tokens.
function makeToken(departmentId, credStamp = null, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ d: departmentId, c: credStamp, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyTokenFull(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.d || !data.exp || Date.now() > data.exp) return null;
    return { deptId: data.d, credStamp: data.c ?? null };
  } catch { return null; }
}

function verifyToken(token) {
  const full = verifyTokenFull(token);
  return full ? full.deptId : null;
}

// Fixed decoy hash so unknown-username logins do the same scrypt work as
// wrong-password logins, closing the timing side channel.
const DECOY_HASH = hashPassword('decoy-timing-equalizer');
function burnVerify(password) {
  verifyPassword(password, DECOY_HASH);
  return false;
}

module.exports = { generatePassword, hashPassword, verifyPassword, makeToken, verifyToken, verifyTokenFull, burnVerify };
