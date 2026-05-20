import { requireAppPassword } from '../lib/auth.js';
import { normalizeUserIdentifier, requireUserAuth } from '../lib/user-auth.js';
import { hasDatabaseConfig, query } from '../lib/db.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password, X-User-Token');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAppPassword(req, res)) return;
  const user = await requireUserAuth(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, user });
  }

  // PATCH: update name
  if (!hasDatabaseConfig()) {
    return res.status(503).json({ error: 'Database not configured', detail: 'Environment-configured accounts cannot be edited in the app.' });
  }

  const name = req.body?.name !== undefined ? String(req.body.name || '').trim() : undefined;
  const targetUserId = req.body?.userId !== undefined ? normalizeUserIdentifier(req.body.userId) : '';
  if (name !== undefined && !name) return res.status(400).json({ error: 'Name cannot be empty' });
  if (name === undefined) return res.status(400).json({ error: 'Nothing to update' });

  const effectiveUserId = targetUserId || user.id;
  if (targetUserId && !user.isEnvAdmin) {
    return res.status(403).json({ error: 'Forbidden', detail: 'Only environment-configured admins can rename other users.' });
  }

  const existing = await query(`SELECT id FROM app_users WHERE id = $1`, [effectiveUserId]).catch(() => ({ rows: [] }));
  if (!existing.rows[0]) {
    return res.status(403).json({ error: 'Cannot edit', detail: 'Environment-configured accounts cannot be edited in the app.' });
  }

  await query(`UPDATE app_users SET name = $1 WHERE id = $2`, [name, effectiveUserId]);
  return res.status(200).json({ ok: true });
}
