async function logExportAudit({ exportType, exportMode = 'all', recordCount = 0 }) {
  try {
    await apiFetch('/api/export-xlsx?action=audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportType, exportMode, recordCount })
    });
  } catch (error) {
    console.error('[export-audit]', error);
  }
}

async function exportAllJson() {
  if (!await ensureExportAuthorization()) return;
  await loadRecords();
  const payload = getScopedRecordsSource(getRecords()).map(({ text, ...record }) => record);
  const json = JSON.stringify(payload, null, 2);
  downloadTextFile(`ncr-records-${getNowStamp()}.json`, json, 'application/json;charset=utf-8');
  await logExportAudit({ exportType: 'json', exportMode: 'all', recordCount: payload.length });
  showToast(`✓ JSON file saved (${payload.length} records)`);
}

function getNowStamp() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}`;
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportRecordsAsCsv(records, mode = 'all') {
  const headers = [
    'Date',
    'Shift',
    'Start',
    'End',
    'Management No.',
    'Process',
    'Report Type',
    'Issue',
    'Action',
    'Disposition',
    'Author'
  ];
  const rows = records.map((record) => [
    record.date || record.date_display || '',
    record.shift || '',
    record.time_start || '',
    record.time_end || '',
    record.manage_no || '',
    record.process || '',
    record.report_type === 'defect' ? 'Defect' : 'Work',
    record.issue || '',
    record.action || '',
    record.defect_disposition || '',
    record.author_name || ''
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n');
  const suffix = mode === 'new' ? 'new' : 'all';
  downloadTextFile(`ncr-report-${suffix}-${getNowStamp()}.csv`, csv, 'text/csv;charset=utf-8');
}

function getLastExportCursorMs() {
  const raw = localStorage.getItem(EXPORT_CURSOR_KEY);
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function setLastExportCursorMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  localStorage.setItem(EXPORT_CURSOR_KEY, String(ms));
}

function getMaxRecordTimeMs(records) {
  if (!records.length) return null;
  return records.reduce((max, record) => Math.max(max, getRecordSortTime(record)), 0);
}

function filterRecordsSinceCursor(records, cursorMs) {
  return records.filter((record) => getRecordSortTime(record) > cursorMs);
}

async function loadAllRecordsForExport() {
  try {
    const res = await apiFetch('/api/records', { cache: 'no-store' });
    if (!res.ok) throw new Error(`records ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return getRecords();
  }
}

async function exportExcelCsv(mode = 'all') {
  if (!await ensureExportAuthorization()) return;
  const allRecords = await loadAllRecordsForExport();
  const records = getScopedRecordsSource(allRecords);
  const cursorMs = getLastExportCursorMs();
  const targetRecords = mode === 'new' && cursorMs
    ? filterRecordsSinceCursor(records, cursorMs)
    : [...records];

  if (!targetRecords.length) {
    showToast(mode === 'new' ? 'No new records to export' : 'No records to export', 'warn');
    return;
  }

  try {
    const res = await apiFetch('/api/export-xlsx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: targetRecords.map((record) => String(record.id)) })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || data.error || 'Excel export failed');
    }

    const blob = await res.blob();
    const suffix = mode === 'new' ? 'new' : 'all';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ncr-report-${suffix}-${getNowStamp()}.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('[excel-export]', error);
    const canUseDemoCsv = recordsBackend === 'local' || String(error?.message || '').includes('Database not configured');
    if (!canUseDemoCsv) {
      showToast(error.message || 'Excel export failed', 'warn');
      return;
    }
    exportRecordsAsCsv(targetRecords, mode);
    const maxMs = getMaxRecordTimeMs(targetRecords);
    if (maxMs) setLastExportCursorMs(maxMs);
    await logExportAudit({ exportType: 'xlsx', exportMode: mode, recordCount: targetRecords.length });
    showToast(`CSV export saved for demo mode (${targetRecords.length} records)`, 'warn');
    return;
  }

  const maxMs = getMaxRecordTimeMs(targetRecords);
  if (maxMs) setLastExportCursorMs(maxMs);
  await logExportAudit({ exportType: 'xlsx', exportMode: mode, recordCount: targetRecords.length });

  const cursorLabel = mode === 'new' ? 'New' : 'Full';
  showToast(`✓ ${cursorLabel} Excel saved (${targetRecords.length} records)`);
}

async function clearAll() {
  const scopedRecords = getScopedRecordsSource(getRecords());
  const visibleIds = sortRecords(applyRecordsFilters(getVisibleRecords(scopedRecords))).map((record) => String(record.id));
  if (!confirm(showTrashRecords ? 'Empty trash permanently?' : 'Move all visible records to trash?')) return;

  try {
    await loadRecords();
    if (showTrashRecords) {
      await deleteRecordsInStore({ all: true, hard: true });
    } else if (visibleIds.length === scopedRecords.length) {
      await deleteRecordsInStore({ all: true, hard: false });
    } else {
      await deleteRecordsInStore({ ids: visibleIds, hard: false });
    }
    selectedRecordIds = [];
    await loadRecords(true);
    renderRecords();
    showToast(showTrashRecords ? 'Trash emptied' : 'All records moved to trash', 'warn');
  } catch {
    showToast('Clear all failed', 'warn');
  }
}
