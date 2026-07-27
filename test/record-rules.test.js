import test from 'node:test';
import assert from 'node:assert/strict';

import { findRecordConflict, isLockedRecord, parseTimeToMinutes } from '../lib/record-rules.js';
import { buildScopeClause } from '../api/records.js';

const admin = { id: 'boss', role: 'admin' };
const operator = { id: 'kim', role: 'user' };

const record = (over = {}) => ({
  date: '2026-07-20',
  time_start: '09:00',
  time_end: '10:00',
  manage_no: '1482',
  process: 'EOL#2',
  ...over
});

test('parseTimeToMinutes accepts HH:MM and rejects anything else', () => {
  assert.equal(parseTimeToMinutes('00:00'), 0);
  assert.equal(parseTimeToMinutes('09:30'), 570);
  assert.equal(parseTimeToMinutes('23:59'), 1439);
  for (const bad of ['24:00', '09:60', '9:30', '0930', '', null, undefined]) {
    assert.equal(parseTimeToMinutes(bad), null, `expected ${bad} to be rejected`);
  }
});

test('a record is locked once every scheduling field is filled in', () => {
  const complete = { ...record(), date_display: '07/20/26' };
  assert.equal(isLockedRecord(complete), true);
  assert.equal(isLockedRecord({ ...complete, time_end: '' }), false);
  assert.equal(isLockedRecord({ ...complete, date_display: '   ' }), false);
  assert.equal(isLockedRecord(null), false);
});

test('the same process cannot be logged twice for one management number in a day', () => {
  const conflict = findRecordConflict(record({ time_start: '14:00', time_end: '15:00' }), [record()]);
  assert.equal(conflict?.type, 'duplicate-process');
});

test('the same process is allowed again once the 24h window has passed', () => {
  const later = record({ date: '2026-07-22', time_start: '14:00', time_end: '15:00' });
  assert.equal(findRecordConflict(later, [record()]), null);
});

test('two processes on one management number cannot overlap in time', () => {
  const overlapping = record({ process: 'OQC', time_start: '09:30', time_end: '10:30' });
  const conflict = findRecordConflict(overlapping, [record()]);
  assert.equal(conflict?.type, 'time-overlap');
  assert.match(conflict.message, /overlaps with "EOL#2"/);
});

test('back-to-back processes do not count as overlapping', () => {
  const adjacent = record({ process: 'OQC', time_start: '10:00', time_end: '11:00' });
  assert.equal(findRecordConflict(adjacent, [record()]), null);
});

test('an open-ended record blocks everything after it starts', () => {
  const openEnded = record({ process: 'OQC', time_start: '09:30', time_end: '' });
  assert.equal(findRecordConflict(openEnded, [record()])?.type, 'time-overlap');
});

test('times after midnight belong to the shift that began the previous morning', () => {
  // 01:00 rolls onto the next calendar day, so it must not collide with 09:00.
  const nightShift = record({ process: 'OQC', time_start: '01:00', time_end: '02:00' });
  assert.equal(findRecordConflict(nightShift, [record()]), null);
});

test('malformed times are reported before anything else is checked', () => {
  assert.equal(findRecordConflict(record({ time_start: '9am' }), [])?.type, 'invalid-start');
  assert.equal(findRecordConflict(record({ time_end: '25:00' }), [])?.type, 'invalid-end');
});

test('records with no management number or process are never in conflict', () => {
  assert.equal(findRecordConflict(record({ manage_no: '' }), [record()]), null);
  assert.equal(findRecordConflict(record({ process: '  ' }), [record()]), null);
});

test('admins address every record; operators are confined to their own', () => {
  assert.deepEqual(
    buildScopeClause({ all: true }, 'deleted_at IS NOT NULL', admin),
    { where: 'deleted_at IS NOT NULL', params: [], singleId: null }
  );
  assert.deepEqual(
    buildScopeClause({ all: true }, 'deleted_at IS NOT NULL', operator),
    { where: 'deleted_at IS NOT NULL AND author_id = $1', params: ['kim'], singleId: null }
  );
});

test('scope clause numbers its placeholders in order for id lists', () => {
  assert.deepEqual(
    buildScopeClause({ ids: ['a', 'b'] }, 'unused', operator),
    { where: 'id = ANY($1::text[]) AND author_id = $2', params: [['a', 'b'], 'kim'], singleId: null }
  );
});

test('only a single-id target is written to the audit trail', () => {
  assert.equal(buildScopeClause({ id: 'r1' }, 'unused', admin).singleId, 'r1');
  assert.equal(buildScopeClause({ ids: ['r1'] }, 'unused', admin).singleId, null);
  assert.equal(buildScopeClause({ all: true }, 'unused', admin).singleId, null);
});

test('a request with no target is rejected rather than matching everything', () => {
  assert.equal(buildScopeClause({}, 'deleted_at IS NOT NULL', admin), null);
  assert.equal(buildScopeClause({ ids: [] }, 'deleted_at IS NOT NULL', admin), null);
});
