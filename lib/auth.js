'use strict';

/**
 * Accounts, guests and sessions.
 * Passwords are hashed with scrypt (N=16384) and compared in constant time.
 */

const crypto = require('node:crypto');

const USERNAME_PATTERN = /^[a-z0-9_.]{3,24}$/;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE_NAME = 'roomly_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  return `s1:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [version, saltHex, hashHex] = String(stored || '').split(':');
    if (version !== 's1' || !saltHex || !hashHex) {
      return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function normalizeDisplayName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

class Auth {
  constructor(store) {
    this.store = store;
  }

  register({ username, password, displayName }) {
    username = normalizeUsername(username);
    displayName = normalizeDisplayName(displayName) || username;

    if (!USERNAME_PATTERN.test(username)) {
      return { error: 'Usernames are 3-24 characters: letters, numbers, dots and underscores.' };
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return { error: 'Passwords must be at least 8 characters.' };
    }
    if (this.store.getUserByUsername(username)) {
      return { error: 'That username is taken.' };
    }

    const firstAccount = !Object.values(this.store.state.users).some((existing) => !existing.guest);
    const user = this.store.createUser({
      username,
      displayName,
      passHash: hashPassword(password),
      guest: false
    });
    if (firstAccount) {
      user.platformAdmin = true; // the instance owner
      this.store.markDirty();
    }
    const session = this.store.createSession(user.id, false);
    return { user, session };
  }

  login({ username, password }) {
    username = normalizeUsername(username);
    const user = this.store.getUserByUsername(username);
    const stored = user && !user.guest ? user.pass : 'invalid';
    const passwordOk = verifyPassword(String(password || ''), stored);

    if (!user || user.guest || !passwordOk) {
      return { error: 'Wrong username or password.' };
    }
    if (user.disabled) {
      return { error: 'This account has been disabled by an administrator.' };
    }
    const session = this.store.createSession(user.id, false);
    return { user, session };
  }

  guest({ displayName }) {
    displayName = normalizeDisplayName(displayName);
    if (displayName.length < 2) {
      return { error: 'Enter a name with at least 2 characters.' };
    }
    const user = this.store.createUser({ username: null, displayName, passHash: null, guest: true });
    const session = this.store.createSession(user.id, true);
    return { user, session };
  }

  logout(token) {
    this.store.deleteSession(token);
  }

  /** Resolves a session token to a live user, or null. */
  resolve(token) {
    if (!token || typeof token !== 'string' || token.length > 128) {
      return null;
    }
    const session = this.store.getSession(token);
    if (!session) {
      return null;
    }
    const user = this.store.getUser(session.userId);
    if (!user || user.disabled) {
      return null;
    }
    return { user, session };
  }

  static readCookie(request) {
    const header = request.headers.cookie;
    if (!header) {
      return null;
    }
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) {
        continue;
      }
      if (part.slice(0, eq).trim() === COOKIE_NAME) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
    return null;
  }

  static sessionCookie(token, maxAgeMs, secure) {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`
    ];
    if (secure) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  static clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}

module.exports = { Auth, COOKIE_NAME };
