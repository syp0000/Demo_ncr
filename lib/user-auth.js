import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { hasDatabaseConfig, query } from './db.js';

function getAuthSecret() {
  return String(process.env.APP_AUTH_SECRET || process.env.APP_PASSWORD || '');
}

function getSecretKey() {
  const secret = getAuthSecret();
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

function normalizeRole(role) {
  return String(role || '').toLowerCase() === 'admin' ? 'admin' : 'user';
}

export function normalizeUserIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function getEnvUserById(id) {
  const normalizedId = normalizeUserIdentifier(id);
  if (!normalizedId) return null;
  const users = getConfiguredUsers();
  return users.find((item) => item.id === normalizedId) || null;
}

let usersCache = null;
export function getConfiguredUsers() {
  if (usersCache) return usersCache;
  const raw = String(process.env.APP_USERS_JSON || '').trim();
  if (!raw) {
    usersCache = [];
    return usersCache;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      usersCache = [];
      return usersCache;
    }
    usersCache = parsed
      .map((item) => ({
        id: normalizeUserIdentifier(item.id || item.username || ''),
        username: String(item.username || item.id || '').trim(),
        password: String(item.password || '').trim(),
        name: String(item.name || item.displayName || item.username || item.id || '').trim(),
        role: normalizeRole(item.role)
      }))
      .filter((item) => item.id && item.password && item.name);
    return usersCache;
  } catch {
    usersCache = [];
    return usersCache;
  }
}

export function isUserAuthEnabled() {
  const hasEnvUsers = getConfiguredUsers().length > 0;
  const forceEnabled = String(process.env.APP_USER_AUTH || '').trim() === '1';
  return hasEnvUsers || forceEnabled;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, storedHash] = String(passwordHash || '').split(':');
  if (!salt || !storedHash) return false;
  const derivedHash = scryptSync(String(password), salt, 64).toString('hex');
  try {
    return timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(derivedHash, 'hex'));
  } catch {
    return false;
  }
}

async function getDbUserByUsername(username) {
  if (!hasDatabaseConfig()) return null;
  const result = await query(
    `SELECT id, username, password_hash, name, role, is_active
     FROM app_users
     WHERE LOWER(username) = LOWER($1)
     LIMIT 1`,
    [username]
  );
  return result.rows[0] || null;
}

async function getDbUserById(id) {
  if (!hasDatabaseConfig()) return null;
  const result = await query(
    `SELECT id, username, name, role, is_active
     FROM app_users
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function findUserIdentityCollision(username, options = {}) {
  const normalized = normalizeUserIdentifier(username);
  const { includePending = true, excludePendingRequestId = null } = options;
  if (!normalized) return null;

  const envUser = getConfiguredUsers().find((item) => (
    item.id === normalized || normalizeUserIdentifier(item.username) === normalized
  ));
  if (envUser) {
    return {
      source: 'env',
      field: envUser.id === normalized ? 'id' : 'username',
      value: normalized
    };
  }

  if (!hasDatabaseConfig()) return null;

  const existingUser = await query(
    `SELECT id, username
     FROM app_users
     WHERE id = $1 OR LOWER(username) = LOWER($1)
     LIMIT 1`,
    [normalized]
  );
  if (existingUser.rows[0]) {
    const row = existingUser.rows[0];
    return {
      source: 'db',
      field: normalizeUserIdentifier(row.id) === normalized ? 'id' : 'username',
      value: normalized
    };
  }

  if (!includePending) return null;

  const pendingRequest = await query(
    `SELECT id
     FROM user_signup_requests
     WHERE LOWER(username) = LOWER($1)
       AND status = 'pending'
       AND ($2::BIGINT IS NULL OR id <> $2)
     LIMIT 1`,
    [normalized, excludePendingRequestId]
  );
  if (pendingRequest.rows[0]) {
    return {
      source: 'pending',
      field: 'username',
      value: normalized
    };
  }

  return null;
}

export async function authenticateUserCredentials(username, password) {
  const normalizedId = normalizeUserIdentifier(username);
  const pass = String(password || '').trim();
  if (!normalizedId || !pass) return null;

  // Prefer explicit env credentials first (important for pinned admin accounts).
  const envUsers = getConfiguredUsers();
  const envUser = envUsers.find((item) => item.id === normalizedId || item.username.toLowerCase() === normalizedId);
  if (envUser && envUser.password === pass) {
    return {
      id: envUser.id,
      name: envUser.name,
      role: normalizeRole(envUser.role),
      isEnvAdmin: normalizeRole(envUser.role) === 'admin'
    };
  }

  const dbUser = await getDbUserByUsername(normalizedId);
  if (dbUser && dbUser.is_active && verifyPassword(pass, dbUser.password_hash)) {
    const linkedEnvUser = getEnvUserById(dbUser.id);
    const elevatedRole = linkedEnvUser && normalizeRole(linkedEnvUser.role) === 'admin'
      ? 'admin'
      : normalizeRole(dbUser.role);
    return {
      id: dbUser.id,
      name: linkedEnvUser?.name || dbUser.name,
      role: elevatedRole,
      isEnvAdmin: normalizeRole(linkedEnvUser?.role) === 'admin'
    };
  }

  const user = envUsers.find((item) => item.id === normalizedId || item.username.toLowerCase() === normalizedId);
  if (!user) return null;
  if (user.password !== pass) return null;
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    isEnvAdmin: normalizeRole(user.role) === 'admin'
  };
}

export async function createUserToken(user) {
  const key = getSecretKey();
  if (!key) return null;
  return new SignJWT({ name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key);
}


function getSubmittedToken(req) {
  const headerToken = req.headers['x-user-token'];
  if (headerToken) return String(headerToken).trim();
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export async function verifyUserToken(token) {
  const key = getSecretKey();
  if (!key || !token) return null;
  try {
    const verified = await jwtVerify(token, key);
    const id = normalizeUserIdentifier(verified.payload.sub || '');
    const name = String(verified.payload.name || '').trim();
    const role = normalizeRole(verified.payload.role);
    if (!id || !name) return null;
    if (isUserAuthEnabled()) {
      const dbUser = await getDbUserById(id);
      if (dbUser && dbUser.is_active) {
        const linkedEnvUser = getEnvUserById(dbUser.id);
        const elevatedRole = linkedEnvUser && normalizeRole(linkedEnvUser.role) === 'admin'
          ? 'admin'
          : normalizeRole(dbUser.role);
        return {
          id: dbUser.id,
          name: linkedEnvUser?.name || dbUser.name,
          role: elevatedRole,
          isEnvAdmin: normalizeRole(linkedEnvUser?.role) === 'admin'
        };
      }
      const users = getConfiguredUsers();
      const allowed = users.find((item) => item.id === id);
      if (!allowed) return null;
      return {
        id: allowed.id,
        name: allowed.name,
        role: allowed.role,
        isEnvAdmin: normalizeRole(allowed.role) === 'admin'
      };
    }
    return { id, name, role, isEnvAdmin: false };
  } catch {
    return null;
  }
}

export async function getRequestUser(req) {
  if (!isUserAuthEnabled()) {
    return { id: 'shared', name: 'Shared User', role: 'admin' };
  }
  const token = getSubmittedToken(req);
  return verifyUserToken(token);
}

export async function requireUserAuth(req, res) {
  const user = await getRequestUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized', detail: 'User login required' });
    return null;
  }
  return user;
}

export function canWriteAll(user) {
  return String(user?.role || '') === 'admin';
}
