import { hasDatabaseConfig, query } from '../lib/db.js';
import { requireAppPassword } from '../lib/auth.js';
import { requireUserAuth } from '../lib/user-auth.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password, X-User-Token');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAppPassword(req, res)) return;
  const currentUser = await requireUserAuth(req, res);
  if (!currentUser) return;

  if (!hasDatabaseConfig()) return res.status(503).json({ error: 'Database not configured' });

  const recordId = String(req.query?.id || '').trim();
  if (!recordId) return res.status(400).json({ error: 'Missing record id' });

  try {
    const result = await query(
      `SELECT id, record_id, action, field_name, old_value, new_value,
              changed_by_id, changed_by_name, changed_at
       FROM record_history
       WHERE record_id = $1
       ORDER BY changed_at DESC, id DESC
       LIMIT 100`,
      [recordId]
    );
    return res.status(200).json({ history: result.rows });
  } catch (error) {
    console.error('[record-history]', error);
    return res.status(500).json({ error: 'History fetch failed', detail: error.message });
  }
}
