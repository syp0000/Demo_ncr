import {
  findUserIdentityCollision,
  hashPassword,
  isUserAuthEnabled,
  normalizeUserIdentifier
} from '../lib/user-auth.js';
import { hasDatabaseConfig, query } from '../lib/db.js';
import { route } from '../lib/http.js';

export default route(
  { name: 'user-signup-request', methods: ['POST'] },
  async (req, res) => {
    if (!isUserAuthEnabled()) return res.status(503).json({ error: 'User auth is not enabled' });
    if (!hasDatabaseConfig()) return res.status(503).json({ error: 'Database not configured' });

    const username = normalizeUserIdentifier(req.body?.username || '');
    const name = String(req.body?.name || '').trim();
    const password = String(req.body?.password || '').trim();
    if (!username || !name || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password too short' });
    }

    const collision = await findUserIdentityCollision(username);
    if (collision) {
      return res.status(409).json({
        error: collision.source === 'pending' ? 'Already requested' : 'Already exists',
        detail: collision.source === 'pending'
          ? 'Pending request already exists for this User ID'
          : 'User ID already exists'
      });
    }

    await query(
      `INSERT INTO user_signup_requests (username, name, password_hash, status)
       VALUES ($1, $2, $3, 'pending')`,
      [username, name, hashPassword(password)]
    );

    return res.status(200).json({ ok: true });
  }
);
