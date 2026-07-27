import { query } from '../lib/db.js';
import { route } from '../lib/http.js';

export default route(
  { name: 'record-history', methods: ['GET'], headers: ['X-User-Token'], access: 'user', db: true },
  async (req, res) => {
    const recordId = String(req.query?.id || '').trim();
    if (!recordId) return res.status(400).json({ error: 'Missing record id' });

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
  }
);
