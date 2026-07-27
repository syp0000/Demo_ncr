import { query } from '../lib/db.js';
import { canWriteAll } from '../lib/user-auth.js';
import { clientError, route } from '../lib/http.js';
import { findRecordConflict, isLockedRecord } from '../lib/record-rules.js';

const TRASH_RETENTION = `INTERVAL '14 days'`;

const RECORD_COLUMNS = `id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end,
  manage_no, process, report_type, issue, action, defect_disposition, text,
  author_id, author_name, editor_id, editor_name, shared_edit`;

// Photo payloads are large data URLs, so list views get a boolean instead and
// fetch the real thing per-record on demand.
const COLUMNS_WITH_PHOTO = `${RECORD_COLUMNS}, photo_data, photo_name`;
const COLUMNS_WITHOUT_PHOTO = `${RECORD_COLUMNS}, photo_name,
  CASE WHEN COALESCE(photo_data, '') <> '' THEN TRUE ELSE FALSE END AS has_photo`;

// Fields worth writing to the audit trail when they change.
const HISTORY_FIELDS = [
  'shift', 'time_start', 'time_end', 'manage_no', 'process',
  'report_type', 'issue', 'action', 'defect_disposition',
  'photo_data', 'shared_edit'
];

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

async function assertRecordFits(record, excludeId = null) {
  const params = [String(record.manage_no || '').trim()];
  let excludeClause = '';
  if (excludeId) {
    params.push(String(excludeId));
    excludeClause = ` AND id <> $${params.length}`;
  }
  if (!params[0]) return;

  const siblings = await query(`
    SELECT id, date, time_start, time_end, manage_no, process
    FROM records
    WHERE deleted_at IS NULL
      AND TRIM(COALESCE(manage_no, '')) = $1${excludeClause}
  `, params);

  const conflict = findRecordConflict(record, siblings.rows);
  if (conflict) throw clientError(400, 'Validation failed', conflict.message);
}

function canEditRecord(user, record) {
  if (canWriteAll(user)) return true;
  const userId = String(user?.id || '');
  return record?.shared_edit === true || String(record?.author_id || '') === userId;
}

function hasValidUnlockCode(req) {
  const provided = String(req.headers['x-unlock-code'] || '').trim();
  const expected = String(process.env.APP_UNLOCK_CODE || process.env.APP_PASSWORD || '').trim();
  return Boolean(provided && expected && provided === expected);
}

/**
 * Builds the WHERE clause shared by restore and delete. Callers address either
 * every trashed record, a list of ids, or one id; non-admins are additionally
 * confined to records they authored.
 *
 * `allClause` is what "all" means for the operation — restore looks at trashed
 * records, soft-delete at live ones. Returns null when no target was given.
 */
export function buildScopeClause(body = {}, allClause, user) {
  const { id, ids, all } = body;
  const params = [];
  let where;

  if (all) {
    where = allClause;
  } else if (Array.isArray(ids) && ids.length) {
    params.push(ids.map(String));
    where = `id = ANY($${params.length}::text[])`;
  } else if (id) {
    params.push(String(id));
    where = `id = $${params.length}`;
  } else {
    return null;
  }

  if (!canWriteAll(user)) {
    params.push(user.id);
    where += ` AND author_id = $${params.length}`;
  }
  return { where, params, singleId: !all && !(Array.isArray(ids) && ids.length) && id ? String(id) : null };
}

async function logRecordChanges(recordId, action, changes, user) {
  if (!changes.length) return;
  const values = [];
  const placeholders = changes.map((change) => {
    const base = values.length;
    values.push(recordId, action, change.field_name || null, change.old_value || null, change.new_value || null, user.id, user.name);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  await query(
    `INSERT INTO record_history (record_id, action, field_name, old_value, new_value, changed_by_id, changed_by_name)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

/** Renders a before/after pair for the audit trail, or null if nothing changed. */
function describeChange(field, before, after) {
  const text = (value) => {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value).trim();
  };
  const oldValue = text(before);
  const newValue = text(after);
  if (oldValue === newValue) return null;

  if (field === 'photo_data') {
    if (oldValue && newValue) return { field_name: 'photo', old_value: 'Photo before change', new_value: 'Photo after change' };
    if (newValue) return { field_name: 'photo', old_value: null, new_value: 'Photo added' };
    return { field_name: 'photo', old_value: 'Photo removed', new_value: null };
  }
  if (field === 'shared_edit') {
    const label = (value) => (value === true || value === 'true' ? 'Allowed' : 'Not allowed');
    return { field_name: 'shared_edit', old_value: label(before), new_value: label(after) };
  }
  if (field === 'report_type') {
    const label = (value) => (value === 'defect' ? 'Defect Report' : 'Work Completion');
    return { field_name: 'report_type', old_value: label(before), new_value: label(after) };
  }
  return { field_name: field, old_value: oldValue || null, new_value: newValue || null };
}

async function listRecords(req, res) {
  const trashed = req.query?.trashed === '1';
  const deletedAt = trashed ? 'NOT NULL' : 'NULL';
  const id = req.query?.id ? String(req.query.id) : '';

  if (id) {
    const columns = req.query?.photo === '1' ? COLUMNS_WITH_PHOTO : COLUMNS_WITHOUT_PHOTO;
    const single = await query(
      `SELECT ${columns} FROM records WHERE id = $1 AND deleted_at IS ${deletedAt} LIMIT 1`,
      [id]
    );
    if (!single.rows[0]) return res.status(404).json({ error: 'Record not found' });
    return res.status(200).json({ record: single.rows[0] });
  }

  const params = [];
  let dateFilter = '';
  const since = String(req.query?.since || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    params.push(since);
    dateFilter = ` AND date >= $${params.length}`;
  }

  const result = await query(`
    SELECT ${COLUMNS_WITHOUT_PHOTO}
    FROM records
    WHERE deleted_at IS ${deletedAt}${dateFilter}
    ORDER BY recorded_at DESC, id DESC
  `, params);
  return res.status(200).json({ records: result.rows });
}

async function createRecord(req, res, user) {
  const record = normalizeRecord(req.body);
  await assertRecordFits(record);

  const result = await query(`
    INSERT INTO records (id, date, date_display, shift, time_start, time_end, manage_no, process,
      report_type, issue, action, defect_disposition, text, author_id, author_name,
      editor_id, editor_name, shared_edit, photo_data, photo_name, deleted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL, NULL, $16, $17, $18, NULL)
    RETURNING ${COLUMNS_WITH_PHOTO}
  `, [
    record.id, record.date, record.date_display, record.shift, record.time_start, record.time_end,
    record.manage_no, record.process, record.report_type, record.issue, record.action,
    record.defect_disposition, record.text, user.id, user.name,
    record.shared_edit, record.photo_data, record.photo_name
  ]);
  return res.status(200).json({ record: result.rows[0] });
}

async function updateRecord(req, res, user) {
  const record = normalizeRecord(req.body);
  if (!record.id) return res.status(400).json({ error: 'Missing id' });

  const existing = await query(
    `SELECT ${COLUMNS_WITH_PHOTO} FROM records WHERE id = $1`,
    [record.id]
  );
  const before = existing.rows[0];
  if (!before) return res.status(404).json({ error: 'Record not found' });
  if (!canEditRecord(user, before)) {
    return res.status(403).json({ error: 'Forbidden', detail: 'Only the author can edit this record' });
  }
  if (isLockedRecord(before) && !hasValidUnlockCode(req)) {
    return res.status(409).json({ error: 'Locked record', detail: 'Unlock code required for completed records' });
  }
  await assertRecordFits(record, record.id);

  const result = await query(`
    UPDATE records SET
      date = $2, date_display = $3, shift = $4, time_start = $5, time_end = $6,
      manage_no = $7, process = $8, report_type = $9, issue = $10, action = $11,
      defect_disposition = $12, text = $13, photo_data = $14, photo_name = $15,
      editor_id = $16, editor_name = $17, shared_edit = $18,
      deleted_at = NULL, recorded_at = NOW()
    WHERE id = $1
    RETURNING ${COLUMNS_WITH_PHOTO}
  `, [
    record.id, record.date, record.date_display, record.shift, record.time_start, record.time_end,
    record.manage_no, record.process, record.report_type, record.issue, record.action,
    record.defect_disposition, record.text, record.photo_data, record.photo_name,
    user.id, user.name, record.shared_edit
  ]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });

  const changes = HISTORY_FIELDS
    .map((field) => describeChange(field, before[field], record[field]))
    .filter(Boolean);
  await logRecordChanges(record.id, 'edit', changes, user).catch((e) => console.error('[audit]', e));

  return res.status(200).json({ record: result.rows[0] });
}

async function restoreRecords(req, res, user) {
  const scope = buildScopeClause(req.body, 'deleted_at IS NOT NULL', user);
  if (!scope) return res.status(400).json({ error: 'Missing restore target' });

  await query(`UPDATE records SET deleted_at = NULL WHERE ${scope.where}`, scope.params);
  if (scope.singleId) {
    await logRecordChanges(scope.singleId, 'restore', [{}], user).catch((e) => console.error('[audit]', e));
  }
  return res.status(200).json({ ok: true });
}

async function deleteRecords(req, res, user) {
  const hard = req.body?.hard === true;
  const scope = buildScopeClause(req.body, hard ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL', user);
  if (!scope) return res.status(400).json({ error: 'Missing delete target' });

  await query(
    hard
      ? `DELETE FROM records WHERE ${scope.where}`
      : `UPDATE records SET deleted_at = NOW() WHERE ${scope.where}`,
    scope.params
  );
  if (!hard && scope.singleId) {
    await logRecordChanges(scope.singleId, 'delete', [{}], user).catch((e) => console.error('[audit]', e));
  }
  return res.status(200).json({ ok: true });
}

const BY_METHOD = {
  GET: listRecords,
  POST: createRecord,
  PUT: updateRecord,
  PATCH: restoreRecords,
  DELETE: deleteRecords
};

export default route(
  {
    name: 'records',
    methods: Object.keys(BY_METHOD),
    headers: ['X-Unlock-Code', 'X-User-Token'],
    access: 'user',
    db: true
  },
  async (req, res, user) => {
    await query(`DELETE FROM records WHERE deleted_at < NOW() - ${TRASH_RETENTION}`);
    return BY_METHOD[req.method](req, res, user);
  }
);
