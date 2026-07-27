import { hashPassword, normalizeUserIdentifier } from '../lib/user-auth.js';
import { query } from '../lib/db.js';
import { route } from '../lib/http.js';

async function listRequestsAndUsers(req, res) {
  const [pending, users] = await Promise.all([
    query(
      `SELECT id, username, name, status, note, requested_at, reviewed_at, reviewed_by
       FROM user_signup_requests
       WHERE status = 'pending'
       ORDER BY requested_at DESC`
    ),
    query(
      `SELECT id, username, name, role, is_active, created_at
       FROM app_users
       ORDER BY created_at DESC`
    )
  ]);
  return res.status(200).json({ requests: pending.rows, users: users.rows });
}

async function deleteUser(req, res, admin) {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (userId === admin.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await query(`DELETE FROM app_users WHERE id = $1`, [userId]);
  return res.status(200).json({ ok: true });
}

async function resetPassword(req, res, admin, userId) {
  const newPassword = String(req.body?.newPassword || '').trim();
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }
  if (userId === admin.id) {
    return res.status(400).json({ error: 'You cannot change your own password from the admin panel.' });
  }
  const updated = await query(
    `UPDATE app_users SET password_hash = $2 WHERE id = $1 RETURNING id, username, name`,
    [userId, hashPassword(newPassword)]
  );
  if (!updated.rows[0]) return res.status(404).json({ error: 'User not found' });
  return res.status(200).json({ ok: true, user: updated.rows[0] });
}

async function changeRole(req, res, admin, userId) {
  const role = String(req.body?.role || '').trim().toLowerCase();
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (userId === admin.id) return res.status(400).json({ error: 'Cannot change your own role' });

  // Demoting the last remaining admin would lock everyone out of this panel.
  if (role === 'user') {
    const admins = await query(`SELECT id FROM app_users WHERE role = 'admin' AND is_active = TRUE`);
    const isTargetAdmin = admins.rows.some((row) => String(row.id) === userId);
    if (isTargetAdmin && admins.rows.length <= 1) {
      return res.status(400).json({ error: 'At least one admin is required' });
    }
  }

  const updated = await query(
    `UPDATE app_users SET role = $2 WHERE id = $1
     RETURNING id, username, name, role, is_active, created_at`,
    [userId, role]
  );
  if (!updated.rows[0]) return res.status(404).json({ error: 'User not found' });
  return res.status(200).json({ ok: true, user: updated.rows[0] });
}

async function reviewSignupRequest(req, res, admin) {
  const requestId = Number(req.body?.requestId);
  const action = String(req.body?.action || '').trim().toLowerCase();
  const note = String(req.body?.note || '').trim();

  if (!Number.isFinite(requestId) || requestId <= 0) {
    return res.status(400).json({ error: 'Invalid requestId' });
  }
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const pending = await query(
    `SELECT id, username, name, password_hash, status FROM user_signup_requests WHERE id = $1`,
    [requestId]
  );
  const request = pending.rows[0];
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Already processed' });

  if (action === 'approve') {
    const uid = normalizeUserIdentifier(request.username);
    const existing = await query(
      `SELECT id FROM app_users WHERE id = $1 OR LOWER(username) = LOWER($2) LIMIT 1`,
      [uid, request.username]
    );
    if (existing.rows[0]) {
      await query(
        `UPDATE user_signup_requests
         SET status = 'rejected', note = $2, reviewed_at = NOW(), reviewed_by = $3
         WHERE id = $1`,
        [requestId, 'Rejected: duplicate username', admin.id]
      );
      return res.status(409).json({ error: 'Duplicate username' });
    }

    await query(
      `INSERT INTO app_users (id, username, password_hash, name, role, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'user', TRUE, $5)`,
      [uid, request.username, request.password_hash, request.name, admin.id]
    );
  }

  await query(
    `UPDATE user_signup_requests
     SET status = $2, note = $3, reviewed_at = NOW(), reviewed_by = $4
     WHERE id = $1`,
    [requestId, action === 'approve' ? 'approved' : 'rejected', note || null, admin.id]
  );

  return res.status(200).json({ ok: true });
}

// PATCH carries three different operations. Which one runs is decided by the body:
// a `userId` targets an account (reset-password or role change), otherwise the
// body is a signup request review keyed by `requestId`.
function patch(req, res, admin) {
  const userId = String(req.body?.userId || '').trim();
  if (!userId) return reviewSignupRequest(req, res, admin);
  if (String(req.body?.action || '').trim() === 'reset-password') {
    return resetPassword(req, res, admin, userId);
  }
  return changeRole(req, res, admin, userId);
}

export default route(
  {
    name: 'admin-user-requests',
    methods: ['GET', 'PATCH', 'DELETE'],
    headers: ['X-User-Token'],
    access: 'admin',
    db: true
  },
  async (req, res, admin) => {
    if (req.method === 'GET') return listRequestsAndUsers(req, res);
    if (req.method === 'DELETE') return deleteUser(req, res, admin);
    return patch(req, res, admin);
  }
);
