let openPhotoRecordIds = [];
let openHistoryRecordIds = [];
let historyCache = {};
let adminRequestsCache = [];
let adminUsersCache = [];
let exportAuditCache = [];
const TRASH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const FIELD_LABELS = {
  date: 'Date',
  date_display: 'Date Display',
  shift: 'Shift',
  time_start: 'Start Time',
  time_end: 'End Time',
  manage_no: 'Management No.',
  process: 'Process',
  report_type: 'Report Type',
  issue: 'Issue',
  action: 'Action',
  defect_disposition: 'Disposition',
  text: 'Text',
  photo: 'Photo',
  shared_edit: 'Shared Edit',
};

async function toggleRecordHistory(event, id) {
  if (event) { event.preventDefault(); event.stopPropagation(); }
  const key = String(id);
  if (openHistoryRecordIds.includes(key)) {
    openHistoryRecordIds = openHistoryRecordIds.filter(i => i !== key);
    renderRecords();
    return;
  }
  if (!historyCache[key]) {
    try {
      const res = await apiFetch(`/api/record-history?id=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      historyCache[key] = data.history || [];
    } catch (e) {
      showToast('History load failed', 'warn');
      return;
    }
  }
  openHistoryRecordIds.push(key);
  renderRecords();
}

function renderRecordHistory(recordId) {
  const entries = historyCache[recordId] || [];
  const record = getRecords().find(r => String(r.id) === recordId);
  if (entries.length === 0) {
    if (record?.recorded_at) {
      const c = new Date(record.recorded_at);
      const cStr = `${String(c.getMonth()+1).padStart(2,'0')}/${String(c.getDate()).padStart(2,'0')} ${String(c.getHours()).padStart(2,'0')}:${String(c.getMinutes()).padStart(2,'0')}`;
      return `<div class="history-entry"><div class="history-meta"><span class="history-action history-action-create">Created</span><span class="history-user">${esc(record.author_name || 'Unknown')}</span><span class="history-date">${cStr}</span></div></div>`;
    }
    return '<div class="history-empty">No changes recorded</div>';
  }

  const groups = [];
  let currentGroup = null;
  for (const entry of entries) {
    const ts = entry.changed_at;
    if (!currentGroup || currentGroup.ts !== ts) {
      currentGroup = { ts, action: entry.action, user: entry.changed_by_name, items: [] };
      groups.push(currentGroup);
    }
    currentGroup.items.push(entry);
  }

  let html = groups.map(g => {
    const d = new Date(g.ts);
    const dateStr = `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const actionLabel = g.action === 'edit' ? 'Edit' : g.action === 'delete' ? 'Delete' : 'Restore';
    const fieldLines = g.items
      .filter(i => i.field_name)
      .map(i => {
        const label = FIELD_LABELS[i.field_name] || i.field_name;
        const oldStr = i.old_value ? esc(i.old_value) : '(none)';
        const newStr = i.new_value ? esc(i.new_value) : '(none)';
        return `<div class="history-field"><span class="history-field-name">${esc(label)}</span> <span class="history-old">${oldStr}</span> → <span class="history-new">${newStr}</span></div>`;
      }).join('');
    return `
      <div class="history-entry">
        <div class="history-meta">
          <span class="history-action history-action-${g.action}">${actionLabel}</span>
          <span class="history-user">${esc(g.user)}</span>
          <span class="history-date">${dateStr}</span>
        </div>
        ${fieldLines}
      </div>`;
  }).join('');

  // Append original creation timestamp at the bottom
  if (record?.recorded_at) {
    const c = new Date(record.recorded_at);
    const cStr = `${String(c.getMonth()+1).padStart(2,'0')}/${String(c.getDate()).padStart(2,'0')} ${String(c.getHours()).padStart(2,'0')}:${String(c.getMinutes()).padStart(2,'0')}`;
    html += `<div class="history-entry"><div class="history-meta"><span class="history-action history-action-create">Created</span><span class="history-user">${esc(record.author_name || 'Unknown')}</span><span class="history-date">${cStr}</span></div></div>`;
  }
  return html;
}

function readLocalRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(records) ? pruneExpiredTrashRecords(records) : [];
  } catch {
    return [];
  }
}

function pruneExpiredTrashRecords(records) {
  const now = Date.now();
  const nextRecords = records.filter(record => {
    if (!record?.deleted_at) return true;
    const deletedAt = new Date(record.deleted_at).getTime();
    if (Number.isNaN(deletedAt)) return true;
    return now - deletedAt < TRASH_RETENTION_MS;
  });
  if (nextRecords.length !== records.length) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextRecords));
  }
  return nextRecords;
}

function filterRecordsForCurrentView(records) {
  return records.filter(record => showTrashRecords ? Boolean(record.deleted_at) : !record.deleted_at);
}

function writeLocalRecords(records) {
  recordsCache = filterRecordsForCurrentView(records);
  recordsLoaded = true;
  recordsBackend = 'local';
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function getServerSinceDate() {
  // 2-day operational window: 8:00 operational boundary, include buffer from 3 days ago
  const now = new Date();
  const operational = getOperationalDate(now);
  operational.setDate(operational.getDate() - 2);
  const y = operational.getFullYear();
  const m = String(operational.getMonth() + 1).padStart(2, '0');
  const d = String(operational.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function loadRecords(force = false) {
  if (recordsLoaded && !force) return recordsCache;
  try {
    const since = showTrashRecords ? '' : `&since=${getServerSinceDate()}`;
    const endpoint = showTrashRecords ? '/api/records?trashed=1' : `/api/records?_=1${since}`;
    const res = await apiFetch(endpoint, { cache: 'no-store' });
    if (!res.ok) throw new Error(`records ${res.status}`);
    const data = await res.json();
    recordsCache = Array.isArray(data.records) ? data.records : [];
    recordsLoaded = true;
    recordsBackend = 'remote';
    return recordsCache;
  } catch (error) {
    recordsCache = filterRecordsForCurrentView(readLocalRecords());
    recordsLoaded = true;
    recordsBackend = 'local';
    return recordsCache;
  }
}

function getRecords() {
  return recordsCache;
}

function getRecordLocalDate(record) {
  const rawDate = String(record?.date || '').slice(0, 10);
  if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    const [year, month, day] = rawDate.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  const basis = record?.recorded_at;
  if (!basis) return null;
  const parsed = new Date(basis);
  if (Number.isNaN(parsed.getTime())) return null;
  const operational = getOperationalDate(parsed);
  return new Date(operational.getFullYear(), operational.getMonth(), operational.getDate());
}

function getRecordSortTime(record) {
  const basis = record?.recorded_at || record?.date;
  const parsed = new Date(basis || 0);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function getVisibleRecords(records) {
  if (showTrashRecords) return records;
  const cutoff = getOperationalDate(new Date());
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 1);

  return records.filter(record => {
    const value = getRecordLocalDate(record);
    return value && value >= cutoff;
  });
}

function sortRecords(records) {
  const sorted = [...records];
  const compareDateDesc = (a, b) => getRecordSortTime(b) - getRecordSortTime(a);
  const compareDateAsc = (a, b) => getRecordSortTime(a) - getRecordSortTime(b);

  switch (recordsSortMode) {
    case 'oldest':
      sorted.sort(compareDateAsc);
      break;
    case 'manage':
      sorted.sort((a, b) => String(a.manage_no || '').localeCompare(String(b.manage_no || ''), undefined, { numeric: true }) || compareDateDesc(a, b));
      break;
    case 'process':
      sorted.sort((a, b) => String(a.process || '').localeCompare(String(b.process || '')) || compareDateDesc(a, b));
      break;
    case 'recent':
    default:
      sorted.sort(compareDateDesc);
      break;
  }

  return sorted;
}

// Callers pass records already narrowed by getScopedRecordsSource(), so the
// My/All tab selection is not re-applied here.
function applyRecordsFilters(records) {
  const query = recordsSearchQuery.trim().toLowerCase();
  return records.filter(record => {
    if (recordsProgressFilter === 'progress' && record.time_end) return false;
    if (recordsProgressFilter === 'done' && !record.time_end) return false;
    if (!query) return true;
    const haystack = [
      record.manage_no,
      record.process,
      record.issue,
      record.action,
      record.text,
      record.date_display,
      record.date,
      record.author_name,
      record.editor_name
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function updateRecordsTools(records, totalCount) {
  const visibleCount = records.length;
  const scopeLabel = recordsScopeTab === 'mine' ? 'My Records' : 'All Records';
  const titleEl = document.querySelector('#page-records .records-title');
  if (titleEl) titleEl.textContent = recordsScopeTab === 'mine' ? 'My Records' : 'All Records';
  document.getElementById('recordsCount').textContent = `${visibleCount} records / ${scopeLabel} ${totalCount} records`;
  document.getElementById('recordsTrashBtn').textContent = showTrashRecords ? 'Records' : 'Trash';
  updateExportBarLabel();
  document.getElementById('recordsRangeNote').textContent = showTrashRecords
    ? 'Showing trash items'
    : 'Showing the last 2 operational days';
  document.getElementById('recordsSort').value = recordsSortMode;
  document.getElementById('recordsSearch').value = recordsSearchQuery;
  document.getElementById('progressFilterAll').classList.toggle('active', recordsProgressFilter === 'all');
  document.getElementById('progressFilterProgress').classList.toggle('active', recordsProgressFilter === 'progress');
  document.getElementById('progressFilterDone').classList.toggle('active', recordsProgressFilter === 'done');
  document.getElementById('restoreSelectedBtn').style.display = showTrashRecords ? 'inline-flex' : 'none';
  document.getElementById('deleteSelectedBtn').textContent = showTrashRecords ? 'Delete Permanently' : 'Delete Selected';
  document.getElementById('clearAllBtn').textContent = showTrashRecords ? '🗑 Empty Trash' : '🗑 Clear All';
}

function getScopedRecordsSource(records = getRecords()) {
  if (recordsScopeTab === 'mine' && currentUser) {
    const me = String(currentUser.id || '');
    return records.filter(record =>
      String(record.author_id || '') === me ||
      String(record.editor_id || '') === me
    );
  }
  return records;
}

function buildValidationTargetFromFormData(formData, editingRecordId = null) {
  return {
    id: editingRecordId ? String(editingRecordId) : null,
    date: formData.dateVal,
    time_start: formData.tStart,
    time_end: formData.tEnd,
    manage_no: formData.manageNo,
    process: formData.process
  };
}

const DUPLICATE_PROCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

function findRecordConflict(candidate, records = getRecords(), { editingRecordId = null } = {}) {
  const manageNo = normalizeManageNo(candidate.manage_no);
  const processName = normalizeProcessName(candidate.process);
  if (!manageNo || !processName) return null;

  const comparableRecords = records.filter(record => {
    if (record.deleted_at) return false;
    if (editingRecordId && String(record.id) === String(editingRecordId)) return false;
    return normalizeManageNo(record.manage_no) === manageNo;
  });

  const candidateRefTime = buildOperationalReferenceTimeKey(candidate.date, candidate.time_start);
  const duplicateProcess = comparableRecords.find(record => {
    if (normalizeProcessName(record.process) !== processName) return false;
    const recordRefTime = buildOperationalReferenceTimeKey(record.date, record.time_start);
    if (candidateRefTime === null || recordRefTime === null) return false;
    return Math.abs(candidateRefTime - recordRefTime) < DUPLICATE_PROCESS_WINDOW_MS;
  });
  if (duplicateProcess) {
    return {
      type: 'duplicate-process',
      message: `Management No. #${manageNo} already has "${duplicateProcess.process}" saved within the last 24 hours.\nThe same process cannot be entered twice within one day.`
    };
  }

  const candidateStart = parseTimeToMinutes(candidate.time_start);
  if (candidate.time_start && candidateStart === null) {
    return { type: 'invalid-start', message: 'Start time must use HH:MM format.' };
  }

  const candidateEnd = parseTimeToMinutes(candidate.time_end);
  if (candidate.time_end && candidateEnd === null) {
    return { type: 'invalid-end', message: 'End time must use HH:MM format.' };
  }

  const candidateWindow = getRecordTimeWindow(candidate);
  if (!candidate.time_start || !candidateWindow) return null;

  const candidateEndAt = candidateWindow.endAt ?? Number.POSITIVE_INFINITY;
  for (const record of comparableRecords) {
    const recordWindow = getRecordTimeWindow(record);
    if (!recordWindow) continue;
    if (!record.time_end) continue;
    const recordEndAt = recordWindow.endAt ?? Number.POSITIVE_INFINITY;
    const isOverlapping = candidateWindow.startAt < recordEndAt && recordWindow.startAt < candidateEndAt;
    if (!isOverlapping) continue;

    return {
      type: 'time-overlap',
      message: `Management No. #${manageNo} overlaps with "${record.process}" (${record.time_start}-${record.time_end}).\nProcesses for the same management number cannot overlap.`
    };
  }

  return null;
}

function updateFormValidationNote(formData = getFormData()) {
  const note = document.getElementById('formValidationNote');
  if (!note) return;
  const conflict = findRecordConflict(
    buildValidationTargetFromFormData(formData, getEditingRecordId()),
    getRecords(),
    { editingRecordId: getEditingRecordId() }
  );
  note.textContent = conflict ? conflict.message : '';
  note.style.display = conflict ? 'block' : 'none';
}

function isRecordSelected(id) {
  return selectedRecordIds.some(item => String(item) === String(id));
}

function isRecordLocked(record) {
  return Boolean(
    record &&
    record.date &&
    record.date_display &&
    record.time_start &&
    record.time_end &&
    record.manage_no &&
    record.process
  );
}

function normalizeRecordDateForInput(record) {
  const rawDate = String(record?.date || '').trim();
  if (rawDate) return rawDate.slice(0, 10);

  const display = String(record?.date_display || '').trim();
  const match = display.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  if (!match) return '';
  const month = match[1];
  const day = match[2];
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function renderRecordActionButtons(record) {
  if (showTrashRecords) {
    if (!canCurrentUserEditRecord(record)) {
      return `
        <button class="btn btn-secondary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="showRecordJson('${esc(record.id)}')">JSON / JSON</button>
      `;
    }
    return `
      <button class="btn btn-primary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="restoreRecord('${esc(record.id)}')">Restore</button>
      <button class="btn btn-danger" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="deleteRecord(event, '${esc(record.id)}')">Delete Permanently</button>
      <button class="btn btn-secondary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="showRecordJson('${esc(record.id)}')">JSON / JSON</button>
    `;
  }

  if (isRecordLocked(record)) {
    if (!canCurrentUserEditRecord(record)) {
      return `
        <button class="btn btn-secondary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="showRecordJson('${esc(record.id)}')">JSON / JSON</button>
        <button class="btn btn-json" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="copyRecordText('${esc(record.id)}')">Copy</button>
      `;
    }
    return `
      <button class="btn btn-primary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="unlockRecordForEdit('${esc(record.id)}')">Unlock</button>
      <button class="btn btn-secondary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="showRecordJson('${esc(record.id)}')">JSON / JSON</button>
      <button class="btn btn-json" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="copyRecordText('${esc(record.id)}')">Copy</button>
    `;
  }

  if (!canCurrentUserEditRecord(record)) {
    return `
      <button class="btn btn-secondary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="showRecordJson('${esc(record.id)}')">JSON / JSON</button>
      <button class="btn btn-json" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="copyRecordText('${esc(record.id)}')">Copy</button>
    `;
  }

  return `
    <button class="btn btn-primary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="loadRecordForEdit('${esc(record.id)}')">Edit</button>
    <button class="btn btn-secondary" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="showRecordJson('${esc(record.id)}')">JSON / JSON</button>
    <button class="btn btn-json" type="button" style="font-size:11px;padding:5px 10px;border-radius:8px" onclick="copyRecordText('${esc(record.id)}')">Copy</button>
  `;
}

function renderRecordCard(record, { extraStyle = '' } = {}) {
  const photoEntries = getPhotoEntriesFromRecord(record);
  const hasPhoto = Boolean(record.has_photo || photoEntries.length);
  const isPhotoOpen = openPhotoRecordIds.includes(String(record.id));
  const isHistoryOpen = openHistoryRecordIds.includes(String(record.id));
  const canWriteRecord = canCurrentUserEditRecord(record);
  const authorName = String(record.author_name || 'Unknown').trim() || 'Unknown';
  const editorName = String(record.editor_name || '').trim();
  const hasDifferentEditor = editorName && String(record.editor_id || '') !== String(record.author_id || '');
  const isDefectReport = String(record.report_type || 'work') === 'defect';
  return `
    <div class="record-item ${record.shift==='Night'?'night':''} ${isRecordSelected(record.id) ? 'selected' : ''}"${extraStyle ? ` style="${extraStyle}"` : ''}>
      <input class="record-check" type="checkbox" ${isRecordSelected(record.id) ? 'checked' : ''} ${canWriteRecord ? '' : 'disabled title="Read-only record"'} onchange="toggleRecordSelection('${esc(record.id)}', this.checked)">
      <div class="record-top">
        <span class="record-process">${esc(record.process)}</span>
        <span class="record-date">${esc(record.date_display)}${record.shift==='Night'?'<span class="record-shift">N</span>':''}</span>
      </div>
      ${isDefectReport ? `<div class="record-mgmt">Defect Report</div>` : ''}
      <div class="record-mgmt">#${esc(record.manage_no)} &nbsp;${esc(record.time_start)}${record.time_end?'–'+esc(record.time_end):'-'}</div>
      <div class="record-mgmt">Author: ${esc(authorName)}</div>
      ${record.shared_edit ? `<div class="record-mgmt">Shared Edit Enabled</div>` : ''}
      ${hasDifferentEditor ? `<div class="record-mgmt">Edited by: ${esc(editorName)}</div>` : ''}
      <div class="record-issue">${esc(record.issue)||'—'}</div>
      ${isDefectReport ? `<div class="record-mgmt">Disposition: ${esc(record.defect_disposition) || '—'}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        ${renderRecordActionButtons(record)}
        ${hasPhoto ? `<button class="btn btn-secondary record-photo-toggle" type="button" onclick="toggleRecordPhoto(event, '${esc(record.id)}')">${isPhotoOpen ? 'Hide Photo' : 'Photo'}</button>` : ''}
        <button class="btn btn-secondary" type="button" onclick="toggleRecordHistory(event, '${esc(record.id)}')" style="font-size:11px;padding:5px 10px;border-radius:8px">${isHistoryOpen ? 'Hide History' : '🕐 History'}</button>
        ${!showTrashRecords && canWriteRecord ? `<button class="btn btn-danger" type="button" onclick="deleteRecord(event, '${esc(record.id)}')" style="font-size:11px;padding:5px 10px;border-radius:8px">Delete</button>` : ''}
      </div>
      ${hasPhoto && isPhotoOpen ? `
      <div class="record-photo-wrap">
        <div class="record-photo-grid">
          ${photoEntries.map((entry, index) => `
            <div class="record-photo-item">
              <img src="${esc(entry.dataUrl)}" alt="record evidence photo ${index + 1}">
            </div>
          `).join('')}
        </div>
      </div>` : ''}
      ${isHistoryOpen ? `
      <div class="record-history-wrap">
        <div class="history-title">Change History</div>
        ${renderRecordHistory(String(record.id))}
      </div>` : ''}
    </div>
  `;
}

async function ensureRecordPhotoLoaded(id) {
  const key = String(id);
  const record = getRecords().find(item => String(item.id) === key);
  if (!record || record.photo_data || !record.has_photo || recordsBackend !== 'remote') return true;
  const endpoint = `/api/records?id=${encodeURIComponent(key)}&photo=1${showTrashRecords ? '&trashed=1' : ''}`;
  const res = await apiFetch(endpoint, { cache: 'no-store' });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  if (!data.record) return false;
  recordsCache = recordsCache.map(item => String(item.id) === key ? { ...item, ...data.record } : item);
  return true;
}

async function toggleRecordPhoto(event, id) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const key = String(id);
  const opening = !openPhotoRecordIds.includes(key);
  if (opening) {
    const loaded = await ensureRecordPhotoLoaded(key);
    if (!loaded) {
      showToast('Photo load failed', 'warn');
      return;
    }
  }
  openPhotoRecordIds = openPhotoRecordIds.includes(key)
    ? openPhotoRecordIds.filter(item => item !== key)
    : [...openPhotoRecordIds, key];
  renderRecords();
}

async function createRecordInStore(record) {
  if (recordsBackend === 'remote') {
    const res = await apiFetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'create failed');
    const data = await res.json();
    recordsCache = [data.record, ...recordsCache];
    return data.record;
  }
  const nextRecords = [record, ...readLocalRecords()];
  writeLocalRecords(nextRecords);
  return record;
}

async function updateRecordInStore(record) {
  const existingRecord = getRecords().find(item => String(item.id) === String(record.id));
  const unlockCode = recordUnlockCodes[String(record.id)] || '';
  if (isRecordLocked(existingRecord)) {
    if (!unlockCode) throw new Error('Unlock code is required.');
  }

  if (recordsBackend === 'remote') {
    const res = await apiFetch('/api/records', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(unlockCode ? { 'X-Unlock-Code': unlockCode } : {}) },
      body: JSON.stringify(record)
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'update failed');
    const data = await res.json();
    delete recordUnlockCodes[String(record.id)];
    recordsCache = [data.record, ...recordsCache.filter(item => String(item.id) !== String(record.id))];
    return data.record;
  }
  const nextRecords = readLocalRecords().map(item => String(item.id) === String(record.id) ? { ...item, ...record, deleted_at: null } : item);
  delete recordUnlockCodes[String(record.id)];
  writeLocalRecords(nextRecords);
  return record;
}

async function restoreRecordsInStore({ id = null, ids = null, all = false } = {}) {
  if (recordsBackend === 'remote') {
    const res = await apiFetch('/api/records', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ids, all })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'restore failed');
    recordsCache = recordsCache.map(record => {
      if (all) return { ...record, deleted_at: null };
      if (Array.isArray(ids) && ids.length && ids.some(item => String(item) === String(record.id))) return { ...record, deleted_at: null };
      if (id && String(record.id) === String(id)) return { ...record, deleted_at: null };
      return record;
    });
    return;
  }

  const localRecords = readLocalRecords();
  const nextRecords = localRecords.map(record => {
    if (all) return { ...record, deleted_at: null };
    if (Array.isArray(ids) && ids.length && ids.some(item => String(item) === String(record.id))) return { ...record, deleted_at: null };
    if (id && String(record.id) === String(id)) return { ...record, deleted_at: null };
    return record;
  });
  writeLocalRecords(nextRecords);
}

async function deleteRecordsInStore({ id = null, ids = null, all = false, hard = false } = {}) {
  if (recordsBackend === 'remote') {
    const res = await apiFetch('/api/records', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ids, all, hard })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'delete failed');
    await loadRecords(true);
    return;
  }

  const sourceRecords = recordsBackend === 'remote' ? [...getRecords()] : readLocalRecords();
  if (all) {
    const nextRecords = hard
      ? sourceRecords.filter(record => !record.deleted_at)
      : sourceRecords.map(record => record.deleted_at ? record : { ...record, deleted_at: new Date().toISOString() });
    if (recordsBackend === 'local') writeLocalRecords(nextRecords);
    else recordsCache = filterRecordsForCurrentView(nextRecords);
    return;
  }

  let nextRecords = sourceRecords;
  if (Array.isArray(ids) && ids.length) {
    nextRecords = hard
      ? sourceRecords.filter(record => !ids.some(item => String(item) === String(record.id)))
      : sourceRecords.map(record => ids.some(item => String(item) === String(record.id)) ? { ...record, deleted_at: new Date().toISOString() } : record);
  } else if (id) {
    nextRecords = hard
      ? sourceRecords.filter(record => String(record.id) !== String(id))
      : sourceRecords.map(record => String(record.id) === String(id) ? { ...record, deleted_at: new Date().toISOString() } : record);
  }

  if (recordsBackend === 'local') writeLocalRecords(nextRecords);
  else recordsCache = filterRecordsForCurrentView(nextRecords);
}
async function saveRecord(showFeedback = false) {
  try {
    await loadRecords();
    const d = getFormData();
    const editingRecordId = getEditingRecordId();
    const conflict = findRecordConflict(
      buildValidationTargetFromFormData(d, editingRecordId),
      getRecords(),
      { editingRecordId }
    );
    if (conflict) throw new Error(conflict.message);
    const existingRecord = editingRecordId
      ? getRecords().find(item => String(item.id) === String(editingRecordId))
      : null;
    const baseAuthorId = existingRecord?.author_id || currentUser?.id || 'unknown';
    const baseAuthorName = existingRecord?.author_name || currentUser?.name || 'Unknown';
    const rec = {
      id: editingRecordId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...buildJson(d),
      text: buildText(d),
      author_id: baseAuthorId,
      author_name: baseAuthorName,
      shared_edit: d.sharedEdit,
      editor_id: editingRecordId ? (currentUser?.id || '') : '',
      editor_name: editingRecordId ? (currentUser?.name || '') : ''
    };
    const savedRecord = editingRecordId
      ? await updateRecordInStore(rec)
      : await createRecordInStore(rec);
    if (showFeedback) {
      showToast(editingRecordId ? '✏️ Record updated' : `✅ Record saved (${getRecords().length} records)`);
      flashBtn('saveRecordBtn', editingRecordId ? '✏️ Updated' : '✅ Saved', 'btn-primary success');
    }
    if (editingRecordId) {
      setEditingRecordId(null);
      syncSaveButton();
    }
    updatePreview();
    if (document.getElementById('page-records').classList.contains('active')) renderRecords();
    return savedRecord;
  } catch (error) {
    console.error('[saveRecord]', error);
    showToast(error?.message || 'Record save failed', 'warn');
    throw error;
  }
}

async function saveAndShowJson() {
  const rec = await saveRecord(false);
  openJsonModal(JSON.stringify(rec, null, 2));
  showToast('💾 Saved + JSON ready');
}

let currentJsonStr = '';
function openJsonModal(str) {
  currentJsonStr = str;
  document.getElementById('jsonOutput').textContent = str;
  document.getElementById('jsonModal').classList.add('open');
}
function closeJsonModal() { document.getElementById('jsonModal').classList.remove('open'); }
function closeModal(e) { if (e.target === document.getElementById('jsonModal')) closeJsonModal(); }
async function copyJson() { await doClipboard(currentJsonStr); showToast('✓ JSON copied'); }

function renderRecords() {
  const allRecords = getRecords();
  const scopeRecords = getScopedRecordsSource(allRecords);
  const visibleRecords = sortRecords(applyRecordsFilters(getVisibleRecords(scopeRecords)));
  selectedRecordIds = selectedRecordIds.filter(id => visibleRecords.some(record => String(record.id) === String(id)));
  openPhotoRecordIds = openPhotoRecordIds.filter(id => visibleRecords.some(record => String(record.id) === String(id)));
  openHistoryRecordIds = openHistoryRecordIds.filter(id => visibleRecords.some(record => String(record.id) === String(id)));
  updateRecordsTools(visibleRecords, scopeRecords.length);
  const exportBar = document.getElementById('exportBar');
  if (exportBar) {
    exportBar.style.display = currentUser?.role === 'admin' && !showTrashRecords ? 'block' : 'none';
  }
  document.getElementById('recordsBulkBar').style.display = visibleRecords.length ? 'flex' : 'none';
  updateSelectedCount();
  const list = document.getElementById('recordsList');
  if (!visibleRecords.length) {
    const hasActiveFilter = recordsSearchQuery.trim() || recordsProgressFilter !== 'all';
    const emptyMessage = hasActiveFilter
      ? 'No records match the filters.<br>Try a different search or status filter.'
      : showTrashRecords
      ? 'Trash is empty.<br>Deleted records will appear here.'
      : scopeRecords.length
      ? 'No records in the last 2 operational days.<br>Older records are still available in exports.'
      : 'No saved records yet.<br>Create one from the Input tab.';
    list.innerHTML = `<div class="empty-state"><div class="big">📭</div><p>${emptyMessage}</p></div>`;
    return;
  }

  if (recordsSortMode === 'recent' || recordsSortMode === 'oldest') {
    list.innerHTML = `<div class="record-groups">` + visibleRecords.map(r => renderRecordCard(r, { extraStyle: 'margin-bottom:14px' })).join('') + `</div>`;
    return;
  }

  if (recordsSortMode === 'process') {
    const groupedByProcess = groupRecordsTwoLevel(visibleRecords, byProcess, byManageNo);
    openManageGroups = openManageGroups.filter(key => groupedByProcess.some(group => group.key === key));
    if (!openManageGroups.length) openManageGroups = groupedByProcess.map(group => group.key);
    const availableManageKeys = groupedByProcess.flatMap(group => group.children.map(manageGroup => manageGroup.key));
    openProcessGroups = openProcessGroups.filter(key => availableManageKeys.includes(key));
    if (!openProcessGroups.length) openProcessGroups = availableManageKeys;

    list.innerHTML = `<div class="record-groups">` + groupedByProcess.map(group => `
      <div class="record-group">
        <button class="record-group-header ${openManageGroups.includes(group.key) ? 'open' : ''}" type="button" onclick="toggleManageGroup('${esc(group.key)}')">
          <div class="record-group-main">
            <span class="record-group-title">${esc(group.label)}</span>
            <span class="record-group-sub">${group.children.length} management numbers · Latest time: ${esc(group.latest.date_display)} ${esc(group.latest.time_start || '')}</span>
          </div>
          <div class="record-group-meta">
            <span class="record-group-chip">${group.records.length} records</span>
            <span class="record-group-chip">Latest #${esc(group.latest.manage_no)}</span>
            <span class="record-group-arrow">${openManageGroups.includes(group.key) ? '▲' : '▼'}</span>
          </div>
        </button>
        <div class="record-group-items ${openManageGroups.includes(group.key) ? 'open' : ''}">
          ${group.children.map(manageGroup => `
          <div class="process-group">
            <button class="process-group-header ${openProcessGroups.includes(manageGroup.key) ? 'open' : ''}" type="button" onclick="toggleProcessGroup(event, '${esc(manageGroup.key)}')">
              <div class="process-group-main">
                <span class="process-group-title">#${esc(manageGroup.label)}</span>
                <span class="process-group-sub">Latest time: ${esc(manageGroup.latest.date_display)} ${esc(manageGroup.latest.time_start || '')}</span>
              </div>
              <div class="process-group-meta">
                <button class="btn btn-primary" type="button" style="padding:6px 10px;font-size:11px;border-radius:8px" onclick="startNewRecordFromManage(event, '${esc(manageGroup.label)}')">Use No.</button>
                <span class="record-group-chip">${manageGroup.records.length} records</span>
                <span class="record-group-arrow">${openProcessGroups.includes(manageGroup.key) ? '▲' : '▼'}</span>
              </div>
            </button>
            <div class="process-group-items ${openProcessGroups.includes(manageGroup.key) ? 'open' : ''}">
              ${manageGroup.records.map(r => renderRecordCard(r)).join('')}
            </div>
          </div>`).join('')}
        </div>
      </div>`).join('') + `</div>`;
    return;
  }

  const grouped = groupRecordsTwoLevel(visibleRecords, byManageNo, byProcess);
  openManageGroups = openManageGroups.filter(key => grouped.some(group => group.key === key));
  if (!openManageGroups.length) openManageGroups = grouped.map(group => group.key);
  const availableProcessKeys = grouped.flatMap(group => group.children.map(processGroup => processGroup.key));
  openProcessGroups = openProcessGroups.filter(key => availableProcessKeys.includes(key));
  if (!openProcessGroups.length) openProcessGroups = availableProcessKeys;

  list.innerHTML = `<div class="record-groups">` + grouped.map(group => `
    <div class="record-group">
      <button class="record-group-header ${openManageGroups.includes(group.key) ? 'open' : ''}" type="button" onclick="toggleManageGroup('${esc(group.key)}')">
        <div class="record-group-main">
          <span class="record-group-title">#${esc(group.label)}</span>
          <span class="record-group-sub">Latest process: ${esc(group.latest.process)} · Latest time: ${esc(group.latest.date_display)} ${esc(group.latest.time_start || '')}</span>
        </div>
        <div class="record-group-meta">
          <div class="record-group-actions">
            <button class="btn btn-primary" type="button" style="padding:6px 10px;font-size:11px;border-radius:8px" onclick="startNewRecordFromManage(event, '${esc(group.label)}')">Use No.</button>
          </div>
          <span class="record-group-chip">${group.records.length} process records</span>
          <span class="record-group-chip">Current ${esc(group.latest.process)}</span>
          <span class="record-group-arrow">${openManageGroups.includes(group.key) ? '▲' : '▼'}</span>
        </div>
      </button>
      <div class="record-group-items ${openManageGroups.includes(group.key) ? 'open' : ''}">
        ${group.children.map(processGroup => `
        <div class="process-group">
          <button class="process-group-header ${openProcessGroups.includes(processGroup.key) ? 'open' : ''}" type="button" onclick="toggleProcessGroup(event, '${esc(processGroup.key)}')">
            <div class="process-group-main">
              <span class="process-group-title">${esc(processGroup.label)}</span>
              <span class="process-group-sub">Latest time: ${esc(processGroup.latest.date_display)} ${esc(processGroup.latest.time_start || '')}</span>
            </div>
            <div class="process-group-meta">
              <span class="record-group-chip">${processGroup.records.length} records</span>
              <span class="record-group-arrow">${openProcessGroups.includes(processGroup.key) ? '▲' : '▼'}</span>
            </div>
          </button>
          <div class="process-group-items ${openProcessGroups.includes(processGroup.key) ? 'open' : ''}">
        ${processGroup.records.map(r => renderRecordCard(r)).join('')}
          </div>
        </div>`).join('')}
      </div>
    </div>`).join('') + `</div>`;
}

async function loadAdminRequests() {
  if (currentUser?.role !== 'admin') return [];
  try {
    const res = await apiFetch('/api/admin-user-requests', { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error('[loadAdminRequests]', res.status, data);
      showToast(data.detail || data.error || 'Failed to load approval requests', 'warn');
      return adminRequestsCache;
    }
    const data = await res.json().catch(() => ({}));
    adminRequestsCache = Array.isArray(data.requests) ? data.requests : [];
    adminUsersCache = Array.isArray(data.users) ? data.users : [];
    if (currentUser?.isEnvAdmin) {
      const auditRes = await apiFetch('/api/export-xlsx?limit=50', { cache: 'no-store' });
      if (auditRes.ok) {
        const auditData = await auditRes.json().catch(() => ({}));
        exportAuditCache = Array.isArray(auditData.audits) ? auditData.audits : [];
      } else {
        exportAuditCache = [];
      }
    } else {
      exportAuditCache = [];
    }
    return adminRequestsCache;
  } catch (e) {
    console.error('[loadAdminRequests]', e);
    return adminRequestsCache;
  }
}

function renderAdminPage() {
  const container = document.getElementById('adminPageRequestsList');
  if (!container || currentUser?.role !== 'admin') return;

  const pendingHtml = adminRequestsCache.length
    ? adminRequestsCache.map((req) => `
        <div class="admin-request-item">
          <div class="admin-request-head">
            ${esc(req.name)} <span style="color:var(--text3);font-size:11px">(${esc(req.username)})</span>
          </div>
          <div class="admin-request-sub">Requested: ${esc(new Date(req.requested_at).toLocaleString())}</div>
          <div class="admin-request-actions">
            <button class="btn btn-primary" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="reviewSignupRequestFromAdminPage(${Number(req.id)}, 'approve')">✓ Approve</button>
            <button class="btn btn-danger" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="reviewSignupRequestFromAdminPage(${Number(req.id)}, 'reject')">✕ Reject</button>
          </div>
        </div>`).join('')
    : `<div style="color:var(--text3);font-size:13px;padding:8px 0">No pending account requests.</div>`;

  const usersHtml = adminUsersCache.length
    ? adminUsersCache.map((u) => {
        const isSelf = String(u.id) === String(currentUser?.id);
        const canRenameUser = Boolean(currentUser?.isEnvAdmin) && !isSelf;
        const roleLabel = u.role === 'admin' ? '<span style="color:var(--accent);font-size:10px;font-family:monospace">ADMIN</span>' : '<span style="color:var(--text3);font-size:10px;font-family:monospace">USER</span>';
        const activeLabel = u.is_active ? '' : ' <span style="color:var(--red);font-size:10px">(inactive)</span>';
        const roleBtn = u.role === 'admin'
          ? `<button class="btn btn-secondary" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="changeUserRole('${esc(u.id)}', 'user', '${esc(u.name)}')">Change to USER</button>`
          : `<button class="btn btn-primary" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="changeUserRole('${esc(u.id)}', 'admin', '${esc(u.name)}')">Promote to ADMIN</button>`;
        return `
        <div class="admin-request-item">
          <div class="admin-request-head" style="display:flex;align-items:center;gap:6px">
            ${esc(u.name)} <span style="color:var(--text3);font-size:11px">(${esc(u.username)})</span>
            ${roleLabel}${activeLabel}
          </div>
          <div class="admin-request-sub">Joined: ${esc(new Date(u.created_at).toLocaleDateString())}</div>
          <div class="admin-request-actions">
            ${canRenameUser ? `<button class="btn btn-secondary" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="changeUserNameFromAdmin('${esc(u.id)}', '${esc(u.name)}')">Rename</button>` : ''}
            ${isSelf ? '<span style="color:var(--text3);font-size:11px">Current account</span>' : roleBtn}
            ${isSelf ? '' : `<button class="btn btn-secondary" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="resetUserPassword('${esc(u.id)}', '${esc(u.name)}')">🔑 Reset Password</button>`}
            ${isSelf ? '' : `<button class="btn btn-danger" type="button" style="padding:6px 12px;font-size:12px;border-radius:8px" onclick="deleteAdminUser('${esc(u.id)}', '${esc(u.name)}')">🗑 Delete</button>`}
          </div>
        </div>`;
      }).join('')
    : `<div style="color:var(--text3);font-size:13px;padding:8px 0">No approved accounts.</div>`;

  const exportAuditHtml = currentUser?.isEnvAdmin
    ? (exportAuditCache.length
      ? exportAuditCache.map((entry) => {
          const createdAt = entry.created_at ? new Date(entry.created_at).toLocaleString() : '-';
          const exportLabel = String(entry.export_type || '').toUpperCase();
          const modeLabel = String(entry.export_mode || 'all').toUpperCase();
          const roleLabel = String(entry.actor_role || 'user').toUpperCase();
          return `
          <div class="admin-request-item">
            <div class="admin-request-head" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${esc(entry.actor_name || '-')}
              <span style="color:var(--text3);font-size:11px">(${esc(entry.actor_id || '-')})</span>
              <span class="admin-badge">${esc(exportLabel)}</span>
              <span class="admin-badge">${esc(modeLabel)}</span>
              <span style="color:var(--text3);font-size:10px;font-family:monospace">${esc(roleLabel)}</span>
            </div>
            <div class="admin-request-sub">Record count: ${Number(entry.record_count || 0)} records</div>
            <div class="admin-request-sub">Exported at: ${esc(createdAt)}</div>
          </div>`;
        }).join('')
      : `<div style="color:var(--text3);font-size:13px;padding:8px 0">No export audit records yet.</div>`)
    : '';

  container.innerHTML = `
    <div class="admin-section-label">⏳ Approval Requests <span class="admin-badge">${adminRequestsCache.length}</span></div>
    ${pendingHtml}
    <div class="admin-section-label" style="margin-top:18px">✅ Approved Accounts <span class="admin-badge">${adminUsersCache.length}</span></div>
    ${usersHtml}
    ${currentUser?.isEnvAdmin ? `<div class="admin-section-label" style="margin-top:18px">📤 Export Audit <span class="admin-badge">${exportAuditCache.length}</span></div>${exportAuditHtml}` : ''}
  `;
}

async function reviewSignupRequestFromAdminPage(requestId, action) {
  if (currentUser?.role !== 'admin') return;
  const note = action === 'reject' ? (prompt('Rejection note (optional)') || '') : '';
  const res = await apiFetch('/api/admin-user-requests', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, action, note })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.detail || data.error || 'Request failed', 'warn'); return; }
  showToast(action === 'approve' ? '✓ Account request approved' : 'Account request rejected');
  await loadAdminRequests();
  renderAdminPage();
}

async function deleteAdminUser(userId, name) {
  if (currentUser?.role !== 'admin') return;
  if (!confirm(`Delete "${name}" account?\nThis user will no longer be able to sign in.`)) return;
  const res = await apiFetch('/api/admin-user-requests', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.detail || data.error || 'Delete failed', 'warn'); return; }
  showToast(`"${name}" account deleted.`);
  await loadAdminRequests();
  renderAdminPage();
}

async function resetUserPassword(userId, name) {
  const newPassword = String(prompt(`Enter a new temporary password for "${name}" (4+ chars)`) || '').trim();
  if (!newPassword) return;
  if (newPassword.length < 4) { showToast('Password must be at least 4 characters.', 'warn'); return; }
  const res = await apiFetch('/api/admin-user-requests', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, action: 'reset-password', newPassword })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showToast(data.detail || data.error || 'Reset failed', 'warn'); return; }
  showToast(`✓ "${name}" password reset.`);
}

async function changeUserRole(userId, role, name) {
  if (currentUser?.role !== 'admin') return;
  const roleLabel = role === 'admin' ? 'ADMIN' : 'USER';
  if (!confirm(`"${name}" account to ${roleLabel}?`)) return;
  const res = await apiFetch('/api/admin-user-requests', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, role })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.detail || data.error || 'Role change failed', 'warn');
    return;
  }
  showToast(`"${name}" role changed to ${roleLabel}.`);
  await loadAdminRequests();
  renderAdminPage();
}

async function changeUserNameFromAdmin(userId, currentName) {
  if (!currentUser?.isEnvAdmin) return;
  const nextName = String(prompt(`Enter a new name for "${currentName}"`, currentName) || '').trim();
  if (!nextName || nextName === currentName) return;
  const res = await apiFetch('/api/user-me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, name: nextName })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.detail || data.error || 'Rename failed', 'warn');
    return;
  }
  showToast(`"${currentName}" name changed.`);
  await loadAdminRequests();
  renderAdminPage();
}

const byManageNo = (record) => String(record.manage_no || '').trim() || 'unknown';
const byProcess = (record) => String(record.process || '').trim() || '(Process)';

/** Groups records under a key, keeping first-seen order so the caller's sort survives. */
function groupBy(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.entries()].map(([key, items]) => ({ key, label: key, latest: items[0], records: items }));
}

/**
 * Two-level grouping for the records list — management number over process, or
 * the other way round. Child keys carry the parent key as a prefix so the two
 * levels can be expanded and collapsed independently.
 */
function groupRecordsTwoLevel(records, outerOf, innerOf) {
  return groupBy(records, outerOf).map((outer) => ({
    ...outer,
    children: groupBy(outer.records, innerOf).map((inner) => ({ ...inner, key: `${outer.key}__${inner.key}` }))
  }));
}
function toggleManageGroup(key) {
  openManageGroups = openManageGroups.includes(key)
    ? openManageGroups.filter(item => item !== key)
    : [...openManageGroups, key];
  renderRecords();
}
function handleRecordsSortChange() {
  recordsSortMode = document.getElementById('recordsSort').value;
  renderRecords();
}
function handleRecordsSearchInput(value) {
  recordsSearchQuery = String(value || '');
  selectedRecordIds = [];
  renderRecords();
}
function setProgressFilter(mode) {
  recordsProgressFilter = mode;
  selectedRecordIds = [];
  renderRecords();
}
async function toggleTrashView() {
  showTrashRecords = !showTrashRecords;
  selectedRecordIds = [];
  await loadRecords(true);
  renderRecords();
}
function toggleProcessGroup(event, key) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  openProcessGroups = openProcessGroups.includes(key)
    ? openProcessGroups.filter(item => item !== key)
    : [...openProcessGroups, key];
  renderRecords();
}
function startNewRecordFromManage(event, manageNo) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  resetForm();
  const match = String(manageNo || '').match(/^([^()]+?)(?:\(([^()]*)\))?$/);
  const manageBase = match?.[1]?.trim() || '';
  const suffix = match?.[2]?.trim() || '';
  hasSuffix = Boolean(suffix);
  document.getElementById('manageNum').value = manageBase;
  document.getElementById('suffixLetter').value = suffix || 'R';
  document.getElementById('suffixChip').classList.toggle('active', hasSuffix);
  document.getElementById('suffixChipLabel').textContent = hasSuffix ? 'Suffix On' : 'No Suffix';
  document.getElementById('suffixBox').classList.toggle('show', hasSuffix);
  switchTab('form');
  updatePreview();
  showToast('Starting a new entry with the same management number');
}
function updateSelectedCount() {
  const count = selectedRecordIds.length;
  const total = sortRecords(applyRecordsFilters(getVisibleRecords(getScopedRecordsSource()))).length;
  document.getElementById('selectedCountLabel').textContent = `${count} selected`;
  document.getElementById('deleteSelectedBtn').disabled = count === 0;
  document.getElementById('restoreSelectedBtn').disabled = count === 0;
  document.getElementById('selectAllBtn').textContent = total > 0 && count === total ? 'Clear Selection' : 'Select All';
}
function toggleRecordSelection(id, checked) {
  selectedRecordIds = checked
    ? [...new Set([...selectedRecordIds, id])]
    : selectedRecordIds.filter(item => item !== id);
  renderRecords();
}
function toggleSelectAllRecords() {
  const records = sortRecords(applyRecordsFilters(getVisibleRecords(getScopedRecordsSource()))).filter(record => canCurrentUserEditRecord(record));
  if (!records.length) return;
  const allSelected = selectedRecordIds.length === records.length;
  selectedRecordIds = allSelected ? [] : records.map(record => String(record.id));
  updateSelectedCount();
  renderRecords();
}
async function restoreRecord(id) {
  try {
    await restoreRecordsInStore({ id });
    selectedRecordIds = selectedRecordIds.filter(item => String(item) !== String(id));
    renderRecords();
    showToast('Record restored');
  } catch (error) {
    showToast('Restore failed', 'warn');
  }
}
async function deleteRecord(event, id) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  try {
    await deleteRecordsInStore({ id, hard: showTrashRecords });
    selectedRecordIds = selectedRecordIds.filter(item => String(item) !== String(id));
    if (String(getEditingRecordId()) === String(id)) {
      setEditingRecordId(null);
      syncSaveButton();
    }
    renderRecords();
    showToast(showTrashRecords ? 'Deleted permanently' : 'Moved to trash');
  } catch (error) {
    showToast('Delete failed', 'warn');
  }
}
async function restoreSelectedRecords() {
  if (!selectedRecordIds.length) return;
  try {
    await restoreRecordsInStore({ ids: selectedRecordIds });
    selectedRecordIds = [];
    renderRecords();
    showToast('Selected records restored');
  } catch (error) {
    showToast('Restore failed', 'warn');
  }
}
async function deleteSelectedRecords() {
  if (!selectedRecordIds.length) return;
  if (!confirm(showTrashRecords
    ? `Permanently delete ${selectedRecordIds.length} selected records?`
    : `Move ${selectedRecordIds.length} selected records to trash?`)) return;
  try {
    await deleteRecordsInStore({ ids: selectedRecordIds, hard: showTrashRecords });
    if (getEditingRecordId() && selectedRecordIds.some(id => String(id) === String(getEditingRecordId()))) {
      setEditingRecordId(null);
      syncSaveButton();
    }
    selectedRecordIds = [];
    renderRecords();
    showToast(showTrashRecords ? 'Selected records permanently deleted' : 'Selected records moved to trash');
  } catch (error) {
    showToast('Bulk delete failed', 'warn');
  }
}
function showRecordJson(id) { const r=getRecords().find(r => String(r.id) === String(id)); if(r){const{text,...rest}=r;openJsonModal(JSON.stringify(rest,null,2));} }
async function copyRecordText(id) { const r=getRecords().find(r => String(r.id) === String(id)); if(r){await doClipboard(r.text);showToast('✓ Text copied');} }
async function loadRecordForEdit(id) {
  let record = getRecords().find(r => String(r.id) === String(id));
  if (!record) return;
  if (!canCurrentUserEditRecord(record)) {
    showToast('Only the author can edit this record', 'warn');
    return;
  }
  if (record.has_photo && !record.photo_data) {
    const loaded = await ensureRecordPhotoLoaded(id);
    if (!loaded) {
      showToast('Photo load failed', 'warn');
      return;
    }
    record = getRecords().find(r => String(r.id) === String(id));
    if (!record) return;
  }
  const hasUnlockCode = Boolean(recordUnlockCodes[String(id)]);
  if (isRecordLocked(record) && !hasUnlockCode) {
    showToast('Unlock before editing', 'warn');
    return;
  }

  setEditingRecordId(id);

  isNight = record.shift === 'Night';
  document.getElementById('nightChip').classList.toggle('active', isNight);
  document.getElementById('nightLabel').textContent = isNight ? 'Night (N)' : 'Day';

  document.getElementById('dateInput').value = normalizeRecordDateForInput(record);
  document.getElementById('timeStart').value = record.time_start || '';
  document.getElementById('timeEnd').value = record.time_end || '';

  const match = String(record.manage_no || '').match(/^([^()]+?)(?:\(([^()]*)\))?$/);
  const manageBase = match?.[1]?.trim() || '';
  const suffix = match?.[2]?.trim() || '';
  hasSuffix = Boolean(suffix);
  document.getElementById('manageNum').value = manageBase;
  document.getElementById('suffixLetter').value = suffix || 'R';
  document.getElementById('suffixChip').classList.toggle('active', hasSuffix);
  document.getElementById('suffixChipLabel').textContent = hasSuffix ? 'Suffix On' : 'No Suffix';
  document.getElementById('suffixBox').classList.toggle('show', hasSuffix);

  const processSelect = document.getElementById('process');
  const hasMatchingOption = [...processSelect.options].some(option => option.value === record.process);
  processSelect.value = hasMatchingOption ? record.process : '__custom__';
  document.getElementById('customProcessField').style.display = hasMatchingOption ? 'none' : 'block';
  document.getElementById('customProcess').value = hasMatchingOption ? '' : (record.process || '');

  setReportType(record.report_type === 'defect' ? 'defect' : 'work');
  document.getElementById('issue').value = record.issue || '';
  document.getElementById('action').value = record.action || '';
  const defectDisposition = document.getElementById('defectDisposition');
  if (defectDisposition) defectDisposition.value = record.defect_disposition || '';
  const sharedEditCheckbox = document.getElementById('sharedEditCheckbox');
  if (sharedEditCheckbox) sharedEditCheckbox.checked = record.shared_edit === true;
  setEvidencePhotoPreview(getPhotoEntriesFromRecord(record));
  ['issue', 'action'].forEach(discardPolish);

  syncSaveButton();
  switchTab('form');
  updatePreview();
  showToast('Record loaded for editing');
}

function unlockRecordForEdit(id) {
  const record = getRecords().find(item => String(item.id) === String(id));
  if (!record) return;
  if (!isRecordLocked(record)) {
    loadRecordForEdit(id);
    return;
  }
  const input = prompt('Enter unlock code');
  if (input === null) return;
  const code = String(input).trim();
  if (!code) {
    showToast('Enter a code', 'warn');
    return;
  }
  recordUnlockCodes[String(id)] = code;
  showToast('Unlocked. Edit now, then save.');
  loadRecordForEdit(id);
}
function syncSaveButton() {
  const saveBtn = document.getElementById('saveRecordBtn');
  if (!saveBtn) return;
  saveBtn.textContent = getEditingRecordId() ? '✏️ Update Record' : '✅ Save Record';
}
