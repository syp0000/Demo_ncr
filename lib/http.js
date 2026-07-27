import { requireAppPassword } from './auth.js';
import { canWriteAll, requireUserAuth } from './user-auth.js';
import { hasDatabaseConfig } from './db.js';

const BASE_ALLOWED_HEADERS = ['Content-Type', 'X-App-Password'];

// Access levels, weakest first. Each one implies the ones before it.
//   'open'  - no credentials (public config only)
//   'app'   - shared access code
//   'user'  - access code + signed-in user
//   'admin' - access code + user with the admin role
const ACCESS_LEVELS = ['open', 'app', 'user', 'admin'];

/**
 * Wraps a Vercel handler with the preamble every endpoint here needs:
 * CORS, preflight, method allow-list, auth, and database availability.
 *
 * The wrapped handler receives (req, res, user) and may throw; anything that
 * escapes becomes a 500 tagged with `name`.
 */
export function route({ name, methods, headers = [], access = 'app', db = false }, handler) {
  if (!ACCESS_LEVELS.includes(access)) throw new Error(`route(${name}): unknown access "${access}"`);
  const allowMethods = [...methods, 'OPTIONS'].join(', ');
  const allowHeaders = [...BASE_ALLOWED_HEADERS, ...headers].join(', ');

  return async function wrappedHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', allowMethods);
    res.setHeader('Access-Control-Allow-Headers', allowHeaders);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!methods.includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

    if (access !== 'open' && !requireAppPassword(req, res)) return;

    let user = null;
    if (access === 'user' || access === 'admin') {
      user = await requireUserAuth(req, res);
      if (!user) return;
      if (access === 'admin' && !canWriteAll(user)) {
        return res.status(403).json({ error: 'Forbidden', detail: 'Admin only' });
      }
    }

    if (db && !hasDatabaseConfig()) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    try {
      return await handler(req, res, user);
    } catch (error) {
      if (res.headersSent) return;
      if (error.status) {
        return res.status(error.status).json({ error: error.publicError, detail: error.message });
      }
      console.error(`[${name}]`, error);
      return res.status(500).json({ error: `${name} failed`, detail: error.message });
    }
  };
}

/** An error the wrapper reports verbatim to the client instead of masking as a 500. */
export function clientError(status, publicError, detail) {
  return Object.assign(new Error(detail), { status, publicError });
}
