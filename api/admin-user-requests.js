import { requireAppPassword } from '../lib/auth.js';
import {
  canWriteAll,
  ensureUserAuthSchema,
  hashPassword,
  requireUserAuth
} from '../lib/user-auth.js';
import { hasDatabaseConfig, query } from '../lib/db.js';

function normalizeUserId(value) {
  return String(value || '').trim().toLowerCase();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password, X-User-Token');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAppPassword(req, res)) return;
  const user = await requireUserAuth(req, res);
  if (!user) return;
  if (!canWriteAll(user)) {
    return res.status(403).json({ error: 'Forbidden', detail: 'Admin only' });
  }
  if (!hasDatabaseConfig()) return res.status(503).json({ error: 'Database not configured' });

  try {
    await ensureUserAuthSchema();

    if (req.method === 'GET') {
      const [pendingResult, usersResult] = await Promise.all([
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
      return res.status(200).json({ requests: pendingResult.rows, users: usersResult.rows });
    }

    if (req.method === 'DELETE') {
      const userId = String(req.body?.userId || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId is required' });
      if (userId === user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
      await query(`DELETE FROM app_users WHERE id = $1`, [userId]);
      return res.status(200).json({ ok: true });
    }

    const targetUserId = String(req.body?.userId || '').trim();
    const patchAction = String(req.body?.action || '').trim();

    // ── PASSWORD RESET ──
    if (targetUserId && patchAction === 'reset-password') {
      const newPassword = String(req.body?.newPassword || '').trim();
      if (newPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters.' });
      }
      if (targetUserId === user.id) {
        return res.status(400).json({ error: 'You cannot change your own password from the admin panel.' });
      }
      const newHash = hashPassword(newPassword);
      const updated = await query(
        `UPDATE app_users SET password_hash = $2 WHERE id = $1 RETURNING id, username, name`,
        [targetUserId, newHash]
      );
      if (!updated.rows[0]) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ ok: true, user: updated.rows[0] });
    }

    const targetRole = String(req.body?.role || '').trim().toLowerCase();
    if (targetUserId) {
      if (!['admin', 'user'].includes(targetRole)) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      if (targetUserId === user.id) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }

      if (targetRole === 'user') {
        const admins = await query(
          `SELECT id FROM app_users WHERE role = 'admin' AND is_active = TRUE`
        );
        const isTargetAdmin = admins.rows.some((row) => String(row.id) === targetUserId);
        if (isTargetAdmin && admins.rows.length <= 1) {
          return res.status(400).json({ error: 'At least one admin is required' });
        }
      }

      const updated = await query(
        `UPDATE app_users
         SET role = $2
         WHERE id = $1
         RETURNING id, username, name, role, is_active, created_at`,
        [targetUserId, targetRole]
      );
      if (!updated.rows[0]) return res.status(404).json({ error: 'User not found' });
      return res.status(200).json({ ok: true, user: updated.rows[0] });
    }

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
      `SELECT id, username, name, password_hash, status
       FROM user_signup_requests
       WHERE id = $1`,
      [requestId]
    );
    const reqRow = pending.rows[0];
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    if (reqRow.status !== 'pending') {
      return res.status(409).json({ error: 'Already processed' });
    }

    if (action === 'approve') {
      const uid = normalizeUserId(reqRow.username);
      const existing = await query(
        `SELECT id FROM app_users WHERE id = $1 OR LOWER(username) = LOWER($2) LIMIT 1`,
        [uid, reqRow.username]
      );
      if (existing.rows[0]) {
        await query(
          `UPDATE user_signup_requests
           SET status = 'rejected', note = $2, reviewed_at = NOW(), reviewed_by = $3
           WHERE id = $1`,
          [requestId, 'Rejected: duplicate username', user.id]
        );
        return res.status(409).json({ error: 'Duplicate username' });
      }

      await query(
        `INSERT INTO app_users (id, username, password_hash, name, role, is_active, created_by)
         VALUES ($1, $2, $3, $4, 'user', TRUE, $5)`,
        [uid, reqRow.username, reqRow.password_hash, reqRow.name, user.id]
      );
    }

    await query(
      `UPDATE user_signup_requests
       SET status = $2, note = $3, reviewed_at = NOW(), reviewed_by = $4
       WHERE id = $1`,
      [requestId, action === 'approve' ? 'approved' : 'rejected', note || null, user.id]
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[admin-user-requests]', error);
    return res.status(500).json({ error: 'Admin request handling failed', detail: error.message });
  }
}
