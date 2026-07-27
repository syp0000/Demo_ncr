// Scheduling rules for records, kept free of database and HTTP concerns so they
// can be exercised directly. See test/record-rules.test.js.
//
// The shop floor runs on an "operational day" that starts at 08:00: a record
// stamped 02:00 belongs to the shift that began the previous calendar morning.

const OPERATIONAL_DAY_START_MINUTES = 8 * 60;
const DUPLICATE_PROCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

export function normalizeManageNo(value) {
  return String(value || '').trim();
}

export function normalizeProcessName(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseTimeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hours, minutes] = String(value).split(':').map(Number);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Absolute timestamp for a date + HH:MM, rolling past-midnight times onto the next day. */
export function buildOperationalDateTimeKey(dateValue, timeValue) {
  if (!dateValue || !timeValue) return null;
  const minutes = parseTimeToMinutes(timeValue);
  if (minutes === null) return null;
  const [year, month, day] = String(dateValue).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  const base = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (minutes < OPERATIONAL_DAY_START_MINUTES) base.setDate(base.getDate() + 1);
  base.setMinutes(minutes);
  return base.getTime();
}

/** Same as above, but falls back to the 08:00 shift start when no time is given. */
export function buildOperationalReferenceTimeKey(dateValue, timeValue = '') {
  const timed = buildOperationalDateTimeKey(dateValue, timeValue);
  if (timed !== null) return timed;
  const [year, month, day] = String(dateValue || '').slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 8, 0, 0, 0).getTime();
}

export function getRecordTimeWindow(record) {
  const startAt = buildOperationalDateTimeKey(record?.date, record?.time_start);
  if (startAt === null) return null;
  return { startAt, endAt: buildOperationalDateTimeKey(record?.date, record?.time_end) };
}

/**
 * A record is "locked" once it describes a finished job — every scheduling field
 * filled in. Editing one then requires the unlock code.
 */
export function isLockedRecord(record) {
  const filled = (value) => value !== null && value !== undefined && String(value).trim() !== '';
  return Boolean(
    record &&
    filled(record.date) &&
    filled(record.date_display) &&
    filled(record.time_start) &&
    filled(record.time_end) &&
    filled(record.manage_no) &&
    filled(record.process)
  );
}

/**
 * Checks a candidate record against the records already saved under the same
 * management number. Returns a human-readable reason, or null if it is allowed.
 *
 * `separator` lets the caller pick how multi-line messages are joined — the
 * browser shows them stacked, the API sends them as one line.
 */
export function findRecordConflict(candidate, siblings, { separator = ' ' } = {}) {
  const manageNo = normalizeManageNo(candidate.manage_no);
  const processName = normalizeProcessName(candidate.process);
  if (!manageNo || !processName) return null;

  if (candidate.time_start && parseTimeToMinutes(candidate.time_start) === null) {
    return { type: 'invalid-start', message: 'Start time must use HH:MM format.' };
  }
  if (candidate.time_end && parseTimeToMinutes(candidate.time_end) === null) {
    return { type: 'invalid-end', message: 'End time must use HH:MM format.' };
  }

  const candidateRefTime = buildOperationalReferenceTimeKey(candidate.date, candidate.time_start);
  const duplicate = siblings.find((record) => {
    if (normalizeProcessName(record.process) !== processName) return false;
    const recordRefTime = buildOperationalReferenceTimeKey(record.date, record.time_start);
    if (candidateRefTime === null || recordRefTime === null) return false;
    return Math.abs(candidateRefTime - recordRefTime) < DUPLICATE_PROCESS_WINDOW_MS;
  });
  if (duplicate) {
    return {
      type: 'duplicate-process',
      message: [
        `Management No. #${manageNo} already has "${duplicate.process}" saved within the last 24 hours.`,
        'The same process cannot be entered twice within one day.'
      ].join(separator)
    };
  }

  const candidateWindow = getRecordTimeWindow(candidate);
  if (!candidate.time_start || !candidateWindow) return null;
  const candidateEndAt = candidateWindow.endAt ?? Number.POSITIVE_INFINITY;

  for (const record of siblings) {
    if (!record.time_end) continue;
    const window = getRecordTimeWindow(record);
    if (!window) continue;
    const recordEndAt = window.endAt ?? Number.POSITIVE_INFINITY;
    if (candidateWindow.startAt >= recordEndAt || window.startAt >= candidateEndAt) continue;

    return {
      type: 'time-overlap',
      message: [
        `Management No. #${manageNo} overlaps with "${record.process}" (${record.time_start}-${record.time_end}).`,
        'Processes for the same management number cannot overlap.'
      ].join(separator)
    };
  }

  return null;
}
