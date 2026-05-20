import { hasDatabaseConfig, query } from '../lib/db.js';
import { requireAppPassword } from '../lib/auth.js';
import { canWriteAll, requireUserAuth } from '../lib/user-auth.js';

let schemaEnsured = false;
const TRASH_RETENTION_SQL = `NOW() - INTERVAL '14 days'`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password, X-Unlock-Code, X-User-Token');
}

function normalizeRecord(body = {}) {
  return {
    id: body.id ? String(body.id) : null,
    date: body.date || null,
    date_display: body.date_display || null,
    shift: body.shift || null,
    time_start: body.time_start || null,
    time_end: body.time_end || null,
    manage_no: body.manage_no || null,
    process: body.process || null,
    report_type: body.report_type === 'defect' ? 'defect' : 'work',
    issue: body.issue || '',
    action: body.action || '',
    defect_disposition: body.defect_disposition || '',
    text: body.text || '',
    photo_data: body.photo_data || '',
    photo_name: body.photo_name || '',
    shared_edit: body.shared_edit === true
  };
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeManageNo(value) {
  return String(value || '').trim();
}

function normalizeProcessName(value) {
  return String(value || '').trim().toLowerCase();
}

function parseTimeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hh, mm] = String(value).split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

function buildOperationalDateTimeKey(dateValue, timeValue) {
  if (!dateValue || !timeValue) return null;
  const minutes = parseTimeToMinutes(timeValue);
  if (minutes === null) return null;
  const [year, month, day] = String(dateValue).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  const base = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (minutes < 8 * 60) base.setDate(base.getDate() + 1);
  base.setMinutes(minutes);
  return base.getTime();
}

function buildOperationalReferenceTimeKey(dateValue, timeValue = '') {
  const timed = buildOperationalDateTimeKey(dateValue, timeValue);
  if (timed !== null) return timed;
  const [year, month, day] = String(dateValue || '').slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 8, 0, 0, 0).getTime();
}

function getRecordTimeWindow(record) {
  const startAt = buildOperationalDateTimeKey(record?.date, record?.time_start);
  if (startAt === null) return null;
  const endAt = buildOperationalDateTimeKey(record?.date, record?.time_end);
  return { startAt, endAt };
}

const DUPLICATE_PROCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

async function validateRecordConstraints(record, excludeId = null) {
  const manageNo = normalizeManageNo(record.manage_no);
  const processName = normalizeProcessName(record.process);
  if (!manageNo || !processName) return;

  if (record.time_start && parseTimeToMinutes(record.time_start) === null) {
    throw new Error('Start time must use HH:MM format.');
  }
  if (record.time_end && parseTimeToMinutes(record.time_end) === null) {
    throw new Error('End time must use HH:MM format.');
  }

  const params = [manageNo];
  let excludeClause = '';
  if (excludeId) {
    params.push(String(excludeId));
    excludeClause = ` AND id <> $${params.length}`;
  }

  const existing = await query(`
    SELECT id, date, time_start, time_end, manage_no, process
    FROM records
    WHERE deleted_at IS NULL
      AND TRIM(COALESCE(manage_no, '')) = $1${excludeClause}
  `, params);

  const candidateRefTime = buildOperationalReferenceTimeKey(record.date, record.time_start);
  const duplicateProcess = existing.rows.find(item => {
    if (normalizeProcessName(item.process) !== processName) return false;
    const itemRefTime = buildOperationalReferenceTimeKey(item.date, item.time_start);
    if (candidateRefTime === null || itemRefTime === null) return false;
    return Math.abs(candidateRefTime - itemRefTime) < DUPLICATE_PROCESS_WINDOW_MS;
  });
  if (duplicateProcess) {
    throw new Error(`Management No. #${manageNo} already has "${duplicateProcess.process}" saved within the last 24 hours. The same process cannot be entered twice within one day.`);
  }

  const candidateWindow = getRecordTimeWindow(record);
  if (!record.time_start || !candidateWindow) return;
  const candidateEndAt = candidateWindow.endAt ?? Number.POSITIVE_INFINITY;

  for (const item of existing.rows) {
    const existingWindow = getRecordTimeWindow(item);
    if (!existingWindow) continue;
    if (!item.time_end) continue;
    const existingEndAt = existingWindow.endAt ?? Number.POSITIVE_INFINITY;
    const isOverlapping = candidateWindow.startAt < existingEndAt && existingWindow.startAt < candidateEndAt;
    if (!isOverlapping) continue;

    throw new Error(`Management No. #${manageNo} overlaps with "${item.process}" (${item.time_start}-${item.time_end}). Processes for the same management number cannot overlap.`);
  }
}

function isLockedRecord(record) {
  return Boolean(
    record &&
    hasValue(record.date) &&
    hasValue(record.date_display) &&
    hasValue(record.time_start) &&
    hasValue(record.time_end) &&
    hasValue(record.manage_no) &&
    hasValue(record.process)
  );
}

const HISTORY_FIELDS = [
  'shift', 'time_start', 'time_end',
  'manage_no', 'process', 'report_type', 'issue', 'action', 'defect_disposition',
  'photo_data', 'photo_name',
  'shared_edit'
];

function canEditRecord(user, record) {
  if (canWriteAll(user)) return true;
  const userId = String(user?.id || '');
  return (
    record?.shared_edit === true ||
    String(record?.author_id || '') === userId ||
    String(record?.delegated_editor_id || '') === userId
  );
}

async function logRecordChanges(recordId, historyAction, changes, user) {
  if (!changes || changes.length === 0) return;
  const values = [];
  const placeholders = [];
  let idx = 1;
  for (const c of changes) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(recordId, historyAction, c.field_name || null, c.old_value || null, c.new_value || null, user.id, user.name);
  }
  await query(
    `INSERT INTO record_history (record_id, action, field_name, old_value, new_value, changed_by_id, changed_by_name)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

function isValidUnlockCode(req) {
  const provided = String(req.headers['x-unlock-code'] || '').trim();
  if (!provided) return false;
  const expected = String(process.env.APP_UNLOCK_CODE || process.env.APP_PASSWORD || '').trim();
  if (!expected) return false;
  return provided === expected;
}

async function ensureSchema() {
  if (schemaEnsured) return;
  await Promise.all([
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS author_id TEXT`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS author_name TEXT`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS editor_id TEXT`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS editor_name TEXT`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS shared_edit BOOLEAN NOT NULL DEFAULT FALSE`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS delegated_editor_id TEXT DEFAULT ''`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS delegated_editor_name TEXT DEFAULT ''`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS photo_data TEXT DEFAULT ''`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS photo_name TEXT DEFAULT ''`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT 'work'`),
    query(`ALTER TABLE records ADD COLUMN IF NOT EXISTS defect_disposition TEXT DEFAULT ''`),
  ]);
  await query(`CREATE TABLE IF NOT EXISTS record_history (
    id BIGSERIAL PRIMARY KEY,
    record_id TEXT NOT NULL,
    action TEXT NOT NULL,
    field_name TEXT,
    old_value TEXT,
    new_value TEXT,
    changed_by_id TEXT NOT NULL,
    changed_by_name TEXT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await Promise.all([
    query(`CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records (deleted_at)`),
    query(`CREATE INDEX IF NOT EXISTS idx_records_author_id ON records (author_id)`),
    query(`CREATE INDEX IF NOT EXISTS idx_records_editor_id ON records (editor_id)`),
    query(`CREATE INDEX IF NOT EXISTS idx_records_delegated_editor_id ON records (delegated_editor_id)`),
    query(`CREATE INDEX IF NOT EXISTS idx_records_recorded_at ON records (recorded_at DESC)`),
    query(`CREATE INDEX IF NOT EXISTS idx_records_date ON records (date) WHERE deleted_at IS NULL`),
    query(`CREATE INDEX IF NOT EXISTS idx_record_history_record_id ON record_history (record_id, changed_at DESC)`),
  ]);
  schemaEnsured = true;
}

async function purgeExpiredTrashRecords() {
  await query(`DELETE FROM records WHERE deleted_at IS NOT NULL AND deleted_at < ${TRASH_RETENTION_SQL}`);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!requireAppPassword(req, res)) return;
  const currentUser = await requireUserAuth(req, res);
  if (!currentUser) return;

  if (!hasDatabaseConfig()) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    await ensureSchema();
    await purgeExpiredTrashRecords();

    if (req.method === 'GET') {
      const trashed = req.query?.trashed === '1';
      const id = req.query?.id ? String(req.query.id) : '';
      const includePhoto = req.query?.photo === '1';
      if (id) {
        const fields = includePhoto
          ? `id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_data, photo_name`
          : `id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_name, CASE WHEN COALESCE(photo_data, '') <> '' THEN TRUE ELSE FALSE END AS has_photo`;
        const single = await query(`
          SELECT ${fields}
          FROM records
          WHERE id = $1
            AND deleted_at IS ${trashed ? 'NOT NULL' : 'NULL'}
          LIMIT 1
        `, [id]);
        if (!single.rows[0]) return res.status(404).json({ error: 'Record not found' });
        return res.status(200).json({ record: single.rows[0] });
      }
      const includePhotos = req.query?.photos === '1';
      const since = req.query?.since ? String(req.query.since).trim() : '';
      const listFields = includePhotos
        ? `id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_data, photo_name, TRUE AS has_photo`
        : `id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_name, CASE WHEN COALESCE(photo_data, '') <> '' THEN TRUE ELSE FALSE END AS has_photo`;
      const params = [];
      let dateFilter = '';
      if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
        params.push(since);
        dateFilter = ` AND date >= $${params.length}`;
      }
      const result = await query(`
        SELECT ${listFields}
        FROM records
        WHERE deleted_at IS ${trashed ? 'NOT NULL' : 'NULL'}${dateFilter}
        ORDER BY recorded_at DESC, id DESC
      `, params);
      return res.status(200).json({ records: result.rows });
    }

    if (req.method === 'POST') {
      const record = normalizeRecord(req.body);
      await validateRecordConstraints(record);
      const result = await query(`
        INSERT INTO records (id, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_data, photo_name, deleted_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL, NULL, $16, $17, $18, NULL)
        RETURNING id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_data, photo_name
      `, [
        record.id,
        record.date,
        record.date_display,
        record.shift,
        record.time_start,
        record.time_end,
        record.manage_no,
        record.process,
        record.report_type,
        record.issue,
        record.action,
        record.defect_disposition,
        record.text,
        currentUser.id,
        currentUser.name,
        record.shared_edit,
        record.photo_data,
        record.photo_name
      ]);
      return res.status(200).json({ record: result.rows[0] });
    }

    if (req.method === 'PATCH') {
      const { id, ids, all } = req.body || {};
      if (all) {
        if (canWriteAll(currentUser)) {
          await query(`UPDATE records SET deleted_at = NULL WHERE deleted_at IS NOT NULL`);
        } else {
          await query(`UPDATE records SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND author_id = $1`, [currentUser.id]);
        }
        return res.status(200).json({ ok: true });
      }
      if (Array.isArray(ids) && ids.length) {
        if (canWriteAll(currentUser)) {
          await query(`UPDATE records SET deleted_at = NULL WHERE id = ANY($1::text[])`, [ids.map(String)]);
        } else {
          await query(`UPDATE records SET deleted_at = NULL WHERE id = ANY($1::text[]) AND author_id = $2`, [ids.map(String), currentUser.id]);
        }
        return res.status(200).json({ ok: true });
      }
      if (id) {
        if (canWriteAll(currentUser)) {
          await query(`UPDATE records SET deleted_at = NULL WHERE id = $1`, [String(id)]);
        } else {
          await query(`UPDATE records SET deleted_at = NULL WHERE id = $1 AND author_id = $2`, [String(id), currentUser.id]);
        }
        await logRecordChanges(String(id), 'restore', [{ field_name: null, old_value: null, new_value: null }], currentUser).catch(e => console.error('[audit]', e));
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Missing restore target' });
    }

    if (req.method === 'PUT') {
      const record = normalizeRecord(req.body);
      if (!record.id) return res.status(400).json({ error: 'Missing id' });

      const existing = await query(`
        SELECT id, author_id, shared_edit, delegated_editor_id, date, date_display, shift, time_start, time_end,
               manage_no, process, report_type, issue, action, defect_disposition, text, photo_data, photo_name,
               delegated_editor_name
        FROM records
        WHERE id = $1
      `, [record.id]);
      if (!existing.rows[0]) return res.status(404).json({ error: 'Record not found' });
      if (!canEditRecord(currentUser, existing.rows[0])) {
        return res.status(403).json({ error: 'Forbidden', detail: 'Only the author can edit this record' });
      }
      if (isLockedRecord(existing.rows[0])) {
        if (!isValidUnlockCode(req)) {
          return res.status(409).json({ error: 'Locked record', detail: 'Unlock code required for completed records' });
        }
      }
      await validateRecordConstraints(record, record.id);

      const result = await query(`
        UPDATE records
        SET date = $2,
            date_display = $3,
            shift = $4,
            time_start = $5,
            time_end = $6,
            manage_no = $7,
            process = $8,
            report_type = $9,
            issue = $10,
            action = $11,
            defect_disposition = $12,
            text = $13,
            photo_data = $14,
            photo_name = $15,
            editor_id = $16,
            editor_name = $17,
            shared_edit = $18,
            deleted_at = NULL,
            recorded_at = NOW()
        WHERE id = $1
        RETURNING id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end, manage_no, process, report_type, issue, action, defect_disposition, text, author_id, author_name, editor_id, editor_name, shared_edit, photo_data, photo_name
      `, [
        record.id,
        record.date,
        record.date_display,
        record.shift,
        record.time_start,
        record.time_end,
        record.manage_no,
        record.process,
        record.report_type,
        record.issue,
        record.action,
        record.defect_disposition,
        record.text,
        record.photo_data,
        record.photo_name,
        currentUser.id,
        currentUser.name,
        record.shared_edit
      ]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });

      // ── Audit Trail: log field changes ──
      const oldRec = existing.rows[0];
      const changes = [];
      const normalize = (v) => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString();
        return String(v).trim();
      };
      for (const field of HISTORY_FIELDS) {
        const oldVal = normalize(oldRec[field]);
        const newVal = normalize(record[field]);
        if (oldVal === newVal) continue;
        if (field === 'photo_data') {
          const hadPhoto = oldVal.length > 0;
          const hasPhoto = newVal.length > 0;
          if (hadPhoto && hasPhoto) changes.push({ field_name: 'photo', old_value: 'Photo before change', new_value: 'Photo after change' });
          else if (!hadPhoto && hasPhoto) changes.push({ field_name: 'photo', old_value: null, new_value: 'Photo added' });
          else if (hadPhoto && !hasPhoto) changes.push({ field_name: 'photo', old_value: 'Photo removed', new_value: null });
          continue;
        }
        if (field === 'photo_name') continue;
        if (field === 'shared_edit') {
          changes.push({
            field_name: 'shared_edit',
            old_value: oldRec.shared_edit ? 'Allowed' : 'Not allowed',
            new_value: record.shared_edit ? 'Allowed' : 'Not allowed'
          });
          continue;
        }
        if (field === 'report_type') {
          changes.push({
            field_name: 'report_type',
            old_value: oldRec.report_type === 'defect' ? 'Defect Report' : 'Work Completion',
            new_value: record.report_type === 'defect' ? 'Defect Report' : 'Work Completion'
          });
          continue;
        }
        changes.push({ field_name: field, old_value: oldVal || null, new_value: newVal || null });
      }
      if (changes.length > 0) {
        await logRecordChanges(record.id, 'edit', changes, currentUser).catch(e => console.error('[audit]', e));
      }

      return res.status(200).json({ record: result.rows[0] });
    }

    if (req.method === 'DELETE') {
      const { id, ids, all, hard = false } = req.body || {};
      if (all) {
        if (canWriteAll(currentUser)) {
          if (hard) {
            await query('DELETE FROM records WHERE deleted_at IS NOT NULL');
          } else {
            await query('UPDATE records SET deleted_at = NOW() WHERE deleted_at IS NULL');
          }
        } else {
          if (hard) {
            await query('DELETE FROM records WHERE deleted_at IS NOT NULL AND author_id = $1', [currentUser.id]);
          } else {
            await query('UPDATE records SET deleted_at = NOW() WHERE deleted_at IS NULL AND author_id = $1', [currentUser.id]);
          }
        }
        return res.status(200).json({ ok: true });
      }
      if (Array.isArray(ids) && ids.length) {
        if (canWriteAll(currentUser)) {
          if (hard) {
            await query('DELETE FROM records WHERE id = ANY($1::text[])', [ids.map(String)]);
          } else {
            await query('UPDATE records SET deleted_at = NOW() WHERE id = ANY($1::text[])', [ids.map(String)]);
          }
        } else {
          if (hard) {
            await query('DELETE FROM records WHERE id = ANY($1::text[]) AND author_id = $2', [ids.map(String), currentUser.id]);
          } else {
            await query('UPDATE records SET deleted_at = NOW() WHERE id = ANY($1::text[]) AND author_id = $2', [ids.map(String), currentUser.id]);
          }
        }
        return res.status(200).json({ ok: true });
      }
      if (id) {
        if (canWriteAll(currentUser)) {
          if (hard) {
            await query('DELETE FROM records WHERE id = $1', [String(id)]);
          } else {
            await query('UPDATE records SET deleted_at = NOW() WHERE id = $1', [String(id)]);
          }
        } else {
          if (hard) {
            await query('DELETE FROM records WHERE id = $1 AND author_id = $2', [String(id), currentUser.id]);
          } else {
            await query('UPDATE records SET deleted_at = NOW() WHERE id = $1 AND author_id = $2', [String(id), currentUser.id]);
          }
        }
        if (!hard) {
          await logRecordChanges(String(id), 'delete', [{ field_name: null, old_value: null, new_value: null }], currentUser).catch(e => console.error('[audit]', e));
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Missing delete target' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[records]', error);
    if (
      error?.message?.includes('same process') ||
      error?.message?.includes('overlap') ||
      error?.message?.includes('not ended') ||
      error?.message?.includes('HH:MM')
    ) {
      return res.status(400).json({ error: 'Validation failed', detail: error.message });
    }
    return res.status(500).json({ error: 'Records API failed', detail: error.message });
  }
}
