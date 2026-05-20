// ── STATE ──
let isNight = false;
let hasSuffix = false;
const fieldLang = { issue: 'ko', action: 'ko' };
const STORAGE_KEY = 'budong_records';
const polishSuggestions = { issue: '', action: '' };
let selectedRecordIds = [];
let openManageGroups = [];
let openProcessGroups = [];
let recordsCache = [];
let recordsLoaded = false;
let recordsBackend = 'local';
let authConfig = null;
let appPassword = localStorage.getItem('appPassword') || '';
let userToken = localStorage.getItem('userToken') || '';
let currentUser = null;
let exportAuthorized = sessionStorage.getItem('exportAuthorized') === '1';
let recordsSortMode = 'recent';
let showTrashRecords = false;
let recordsSearchQuery = '';
let recordsProgressFilter = 'all';
let recordsScopeTab = 'all';
let evidencePhotos = [];
const recordUnlockCodes = {};
const EXPORT_CURSOR_KEY = 'ncr_last_excel_export_ms';
const MAJOR_ISSUE_MULTIPLIER = 2;
const MAX_EVIDENCE_IMAGE_BYTES = 1_500_000;
const PHOTO_MAX_DIMENSION = 1280;
const PHOTO_JPEG_QUALITY = 0.8;
const REPORT_TYPE_DEFAULT = 'work';
const PROCESS_STD_MINUTES = {
  enclosurefeeding: 40,
  bpuinsertion: 60,
  packinsertion13: 60,
  packmounting13: 60,
  packinsertion2: 60,
  packmounting2: 60,
  branchpipemounting: 45,
  cabling: 60,
  leaktest: 60,
  coolantinjection: 60,
  eol1: 45,
  eol2: 50,
  oqc: 60,
  linkoutput: 40
};
const PROCESS_STD_ALIASES = {
  bpuinsertion1: 'bpuinsertion',
  packinsertion1: 'packinsertion13',
  packmount1: 'packmounting13',
  packmounting1: 'packmounting13',
  packmount2: 'packmounting2',
  eol1: 'eol1',
  eol2: 'eol2'
};

function updateCurrentUserChip() {
  const chip = document.getElementById('currentUserChip');
  if (!chip) return;
  if (!currentUser) {
    chip.textContent = 'Author: -';
  } else {
    const roleText = currentUser.role === 'admin' ? 'ADMIN' : 'USER';
    chip.textContent = `Author: ${currentUser.name} (${roleText})`;
  }
  updateAdminTabVisibility();
}

function updateAdminTabVisibility() {
  const profileTab = document.getElementById('tab-profile');
  if (profileTab) profileTab.style.display = currentUser ? 'flex' : 'none';
  const adminTab = document.getElementById('tab-admin');
  if (adminTab) adminTab.style.display = currentUser?.role === 'admin' ? 'flex' : 'none';
  const exportBar = document.getElementById('exportBar');
  if (exportBar && currentUser?.role !== 'admin') exportBar.style.display = 'none';
}

function getEditingRecordId() {
  return sessionStorage.getItem('editingRecordId');
}

function setEditingRecordId(id) {
  if (id === null || id === undefined || id === '') {
    sessionStorage.removeItem('editingRecordId');
    return;
  }
  sessionStorage.setItem('editingRecordId', String(id));
}

function toLocalDateInputValue(dateObj) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getOperationalDate(now = new Date()) {
  const basis = new Date(now);
  // Operational date boundary: 08:00 -> next day 07:59 belongs to previous work date.
  if (basis.getHours() < 8) basis.setDate(basis.getDate() - 1);
  return basis;
}

// ── INIT ──
function initDefaults() {
  const now = new Date();
  document.getElementById('dateInput').value = toLocalDateInputValue(getOperationalDate(now));
  const hh = String(now.getHours()).padStart(2,'0');
  const mm = String(now.getMinutes()).padStart(2,'0');
  document.getElementById('timeStart').value = `${hh}:${mm}`;
  document.getElementById('timeEnd').value = '';
  updatePreview();
}

// ── TAB ──
async function switchTab(name) {
  if (name === 'my-records') recordsScopeTab = 'mine';
  else if (name === 'records') recordsScopeTab = 'all';

  const pageName = name === 'my-records' ? 'records' : name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + pageName).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'records' || name === 'my-records') {
    if (recordsLoaded) renderRecords(); // instant from cache
    await Promise.all([loadRecords(true), loadAdminRequests()]); // parallel refresh
    renderRecords();
  }
  if (pageName === 'admin') {
    await loadAdminRequests();
    renderAdminPage();
  }
  if (pageName === 'profile') {
    await renderProfilePage();
  }
}

// ── NIGHT ──
function toggleNight() {
  isNight = !isNight;
  document.getElementById('nightChip').classList.toggle('active', isNight);
  document.getElementById('nightLabel').textContent = isNight ? 'Night (N)' : 'Day';
  updatePreview();
}

// ── SUFFIX ──
function toggleSuffix() {
  hasSuffix = !hasSuffix;
  document.getElementById('suffixChip').classList.toggle('active', hasSuffix);
  document.getElementById('suffixChipLabel').textContent = hasSuffix ? 'Suffix On' : 'No Suffix';
  document.getElementById('suffixBox').classList.toggle('show', hasSuffix);
  updatePreview();
}

function applySuffixPreset(value) {
  hasSuffix = true;
  document.getElementById('suffixLetter').value = value;
  document.getElementById('suffixChip').classList.add('active');
  document.getElementById('suffixChipLabel').textContent = 'Suffix On';
  document.getElementById('suffixBox').classList.add('show');
  updatePreview();
}

// ── NUM ──
function changeNum(delta) {
  const inp = document.getElementById('manageNum');
  inp.value = Math.max(1, parseInt(inp.value || 1) + delta);
  updatePreview();
}

// ── PROCESS ──
function onProcessChange() {
  const val = document.getElementById('process').value;
  document.getElementById('customProcessField').style.display = val === '__custom__' ? 'block' : 'none';
  updatePreview();
}

function normalizeProcessKeyForPhoto(value) {
  const raw = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return PROCESS_STD_ALIASES[raw] || raw;
}

function getStandardMinutesForPhoto(processName) {
  return PROCESS_STD_MINUTES[normalizeProcessKeyForPhoto(processName)] ?? null;
}

function getDurationMinutesFromText(start, end) {
  const startMin = parseTimeToMinutes(start);
  const endMin = parseTimeToMinutes(end);
  if (startMin === null || endMin === null) return null;
  if (endMin >= startMin) return endMin - startMin;
  return (24 * 60 - startMin) + endMin;
}

function normalizeManageNo(value) {
  return String(value || '').trim();
}

function normalizeProcessName(value) {
  return String(value || '').trim().toLowerCase();
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
  return {
    startAt,
    endAt
  };
}

function getReportType() {
  const selected = document.getElementById('reportTypeDefectBtn')?.classList.contains('active')
    ? 'defect'
    : REPORT_TYPE_DEFAULT;
  return selected;
}

function setReportType(type) {
  const nextType = type === 'defect' ? 'defect' : REPORT_TYPE_DEFAULT;
  document.getElementById('reportTypeWorkBtn')?.classList.toggle('active', nextType === 'work');
  document.getElementById('reportTypeDefectBtn')?.classList.toggle('active', nextType === 'defect');
  updateReportTypeUI(nextType);
  updatePreview();
}

function updateReportTypeUI(reportType = getReportType()) {
  const isDefect = reportType === 'defect';
  const title = document.getElementById('reportTitleMain');
  const subtitle = document.getElementById('reportSubtitle');
  const issueLabel = document.getElementById('issueLabel');
  const actionLabel = document.getElementById('actionLabel');
  const issueInput = document.getElementById('issue');
  const actionInput = document.getElementById('action');
  const defectField = document.getElementById('defectDispositionField');

  if (title) title.innerHTML = isDefect ? 'Defect <span>Report</span>' : 'Work Completion <span>Report</span>';
  if (subtitle) subtitle.textContent = isDefect ? 'Document a defect, then save or copy the formatted report.' : 'Fill out the form, then save or copy the formatted report.';
  if (issueLabel) issueLabel.textContent = isDefect ? 'Symptom' : 'Issue / Remarks';
  if (actionLabel) actionLabel.textContent = isDefect ? 'Action Taken' : 'Follow-up Actions';
  if (issueInput) issueInput.placeholder = isDefect ? 'Example: PTO P cable tie for cable fixation is damaged' : 'Example: DC SPD normal check failed';
  if (actionInput) actionInput.placeholder = isDefect ? 'Example: Replaced cable tie at LSE station' : 'Example: Reconnected and verified normal operation';
  if (defectField) defectField.style.display = isDefect ? 'block' : 'none';
}

function isFreshFormState() {
  return Boolean(
    !getEditingRecordId() &&
    !isNight &&
    !hasSuffix &&
    getReportType() === REPORT_TYPE_DEFAULT &&
    !(document.getElementById('customProcess')?.value || '').trim() &&
    !(document.getElementById('issue')?.value || '').trim() &&
    !(document.getElementById('action')?.value || '').trim() &&
    !(document.getElementById('defectDisposition')?.value || '').trim() &&
    !(document.getElementById('sharedEditCheckbox')?.checked) &&
    evidencePhotos.length === 0
  );
}

function refreshFormDefaultsOnResume() {
  if (!document.body.classList.contains('auth-ready')) return;
  if (!document.getElementById('page-form')?.classList.contains('active')) return;
  if (!isFreshFormState()) return;
  initDefaults();
}

function isMajorIssueCase(formData) {
  const standard = getStandardMinutesForPhoto(formData.process);
  const duration = getDurationMinutesFromText(formData.tStart, formData.tEnd);
  if (standard == null || duration == null) return false;
  return duration > standard * MAJOR_ISSUE_MULTIPLIER;
}

function updatePhotoRecommendation(formData) {
  const el = document.getElementById('photoRecommendationText');
  if (!el) return;
  if (isMajorIssueCase(formData)) {
    el.textContent = 'This exceeds 2x the standard process time. Adding a photo is recommended.';
    el.classList.add('warn');
    return;
  }
  el.textContent = 'Photos are optional. Add one for major issues or visual evidence.';
  el.classList.remove('warn');
}

function formatDurationText(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (minutes === 0) return '0 min';
  const parts = [];
  if (hours) parts.push(`${hours} hr`);
  if (mins) parts.push(`${mins} min`);
  return parts.join(' ');
}

function normalizePhotoEntries(rawData, rawNames = '') {
  if (Array.isArray(rawData)) {
    return rawData
      .map((entry, index) => {
        if (typeof entry === 'string') {
          return entry.startsWith('data:image/')
            ? { dataUrl: entry, name: `photo-${index + 1}.jpg` }
            : null;
        }
        const dataUrl = String(entry?.dataUrl || entry?.url || '').trim();
        if (!dataUrl.startsWith('data:image/')) return null;
        return {
          dataUrl,
          name: String(entry?.name || `photo-${index + 1}.jpg`).trim() || `photo-${index + 1}.jpg`
        };
      })
      .filter(Boolean);
  }

  const dataText = String(rawData || '').trim();
  const nameText = String(rawNames || '').trim();
  if (!dataText) return [];

  if (dataText.startsWith('[')) {
    try {
      return normalizePhotoEntries(JSON.parse(dataText), nameText);
    } catch {}
  }

  if (!dataText.startsWith('data:image/')) return [];
  return [{ dataUrl: dataText, name: nameText || 'photo.jpg' }];
}

function getPhotoEntriesFromRecord(record) {
  return normalizePhotoEntries(record?.photo_data, record?.photo_name);
}

function serializePhotoEntries(entries) {
  const normalized = normalizePhotoEntries(entries);
  if (!normalized.length) return { photo_data: '', photo_name: '' };
  return {
    photo_data: JSON.stringify(normalized),
    photo_name: JSON.stringify(normalized.map((entry) => entry.name))
  };
}

function setEvidencePhotoPreview(entries = []) {
  evidencePhotos = normalizePhotoEntries(entries);
  const box = document.getElementById('photoPreviewBox');
  const grid = document.getElementById('photoPreviewGrid');
  const removeBtn = document.getElementById('removePhotoBtn');
  if (!box || !grid || !removeBtn) return;

  if (!evidencePhotos.length) {
    box.style.display = 'none';
    grid.innerHTML = '';
    removeBtn.style.display = 'none';
    return;
  }

  box.style.display = 'block';
  grid.innerHTML = evidencePhotos.map((entry, index) => `
    <div class="photo-preview-item">
      <img src="${entry.dataUrl}" alt="Evidence preview ${index + 1}">
      <div class="photo-name">${entry.name}</div>
      <button class="btn btn-danger photo-preview-remove" type="button" onclick="removeEvidencePhoto(${index})">Remove Photo</button>
    </div>
  `).join('');
  removeBtn.style.display = 'inline-flex';
}

function clearEvidencePhoto() {
  setEvidencePhotoPreview([]);
  const input = document.getElementById('evidencePhotoInput');
  if (input) input.value = '';
}

function removeEvidencePhoto(index) {
  evidencePhotos = evidencePhotos.filter((_, itemIndex) => itemIndex !== index);
  setEvidencePhotoPreview(evidencePhotos);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Photo read failed'));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Photo decode failed'));
    img.src = dataUrl;
  });
}

function getDataUrlByteSize(dataUrl) {
  const parts = String(dataUrl || '').split(',');
  if (parts.length < 2) return 0;
  const base64 = parts[1];
  const padding = (base64.match(/=+$/) || [''])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function renderImageToJpegDataUrl(image, width, height, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function optimizeEvidenceImage(file) {
  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(originalDataUrl);
  const srcW = image.naturalWidth || image.width || 0;
  const srcH = image.naturalHeight || image.height || 0;
  if (!srcW || !srcH) return { dataUrl: originalDataUrl, name: file.name || 'photo' };

  const longest = Math.max(srcW, srcH);
  const ratio = longest > PHOTO_MAX_DIMENSION ? PHOTO_MAX_DIMENSION / longest : 1;
  let targetW = Math.max(1, Math.round(srcW * ratio));
  let targetH = Math.max(1, Math.round(srcH * ratio));
  let optimized = '';
  const qualitySteps = [PHOTO_JPEG_QUALITY, 0.72, 0.64, 0.56, 0.48, 0.4];

  for (let resizeStep = 0; resizeStep < 4; resizeStep += 1) {
    for (const quality of qualitySteps) {
      const candidate = renderImageToJpegDataUrl(image, targetW, targetH, quality);
      if (!candidate) continue;
      optimized = candidate;
      if (getDataUrlByteSize(candidate) <= MAX_EVIDENCE_IMAGE_BYTES) {
        const baseName = String(file.name || 'photo').replace(/\.[^.]+$/, '');
        return {
          dataUrl: candidate,
          name: `${baseName}.jpg`
        };
      }
    }
    targetW = Math.max(1, Math.round(targetW * 0.85));
    targetH = Math.max(1, Math.round(targetH * 0.85));
  }

  const baseName = String(file.name || 'photo').replace(/\.[^.]+$/, '');
  return {
    dataUrl: optimized || originalDataUrl,
    name: `${baseName}.jpg`
  };
}

async function handleEvidencePhotoChange(event) {
  const files = Array.from(event?.target?.files || []);
  if (!files.length) return;

  const nextEntries = [...evidencePhotos];
  try {
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        showToast('Only image files can be uploaded', 'warn');
        continue;
      }
      const optimized = await optimizeEvidenceImage(file);
      if (getDataUrlByteSize(optimized.dataUrl) > MAX_EVIDENCE_IMAGE_BYTES) {
        showToast('The photo was compressed, but it is still larger than 1.5MB', 'warn');
        continue;
      }
      nextEntries.push(optimized);
    }
    setEvidencePhotoPreview(nextEntries);
  } catch {
    showToast('Photo processing failed', 'warn');
  } finally {
    event.target.value = '';
  }
}

// ── LANG ──
function setFieldLang(field, lang) {
  fieldLang[field] = lang;
  ['ko','en'].forEach(l => {
    const btn = document.getElementById(`lang-${field}-${l}`);
    if (btn) btn.classList.toggle('active', l === lang);
  });
  discardPolish(field);

  // If there is already input, switching the language should refresh the suggestion immediately.
  const raw = document.getElementById(field)?.value?.trim();
  if (raw) polishField(field);
}

// ── AI POLISH ──
async function polishField(field) {
  const textarea = document.getElementById(field);
  const raw = textarea.value.trim();
  if (!raw) { showToast('Enter content first', 'warn'); return; }

  const btn = document.getElementById(field === 'issue' ? 'polishIssueBtn' : 'polishActionBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = '✨ Polishing...';

  try {
    const lang = fieldLang[field];
    const endpoint = lang === 'en' ? '/api/polish-en' : '/api/polish-ko';
    const res = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: raw, field, lang })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || 'Server error');
    const polished = data.polished?.trim();
    if (!polished) throw new Error('empty response');

    polishSuggestions[field] = polished;

    const langLabels = { ko: 'Korean', en: 'English' };
    document.getElementById(field + 'SugText').textContent = polished;
    document.getElementById(field + 'SugLang').textContent = data.demo ? `${langLabels[lang]} demo` : langLabels[lang];
    document.getElementById(field + 'Suggestion').classList.add('show');
    if (data.demo) showToast('Demo polish used. Add ANTHROPIC_API_KEY for live AI.', 'warn');

  } catch (e) {
    console.error('[polish]', e.message, e);
    showToast(`Polish failed: ${e.message}`, 'warn');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '✨ Polish / Translate';
  }
}

function applyPolish(field) {
  const suggestion = polishSuggestions[field];
  if (!suggestion) return;
  document.getElementById(field).value = suggestion;
  discardPolish(field);
  updatePreview();
  showToast('✓ Applied');
}

function discardPolish(field) {
  document.getElementById(field + 'Suggestion').classList.remove('show');
  polishSuggestions[field] = '';
}

// ── FORM DATA ──
function getFormData() {
  const dateVal = document.getElementById('dateInput').value;
  const [y, m, d] = dateVal ? dateVal.split('-') : ['','',''];
  const dateDisplay = dateVal ? `${m}/${d}/${String(y).slice(2)}` : '';
  const tStart = document.getElementById('timeStart').value || '';
  const tEnd   = document.getElementById('timeEnd').value || '';
  const numRaw = document.getElementById('manageNum').value || '';
  const suffix = hasSuffix ? (document.getElementById('suffixLetter').value.trim() || 'R') : null;
  const manageNo = suffix ? `${numRaw}(${suffix})` : numRaw;
  const procVal = document.getElementById('process').value;
  const process = procVal === '__custom__'
    ? (document.getElementById('customProcess').value.trim() || '(Process)')
    : procVal;
  const issue  = document.getElementById('issue').value.trim();
  const action = document.getElementById('action').value.trim();
  const reportType = getReportType();
  const defectDisposition = document.getElementById('defectDisposition')?.value.trim() || '';
  return {
    dateVal,
    dateDisplay,
    tStart,
    tEnd,
    manageNo,
    process,
    reportType,
    issue,
    action,
    defectDisposition,
    shift: isNight ? 'Night' : 'Day',
    photoEntries: [...evidencePhotos],
    sharedEdit: document.getElementById('sharedEditCheckbox')?.checked === true
  };
}

function buildText(d) {
  if (d.reportType === 'defect') {
    return `#${d.manageNo}\n1. Symptom: ${d.issue}\n2. Action Taken: ${d.action}\n3. Disposition: ${d.defectDisposition}`;
  }
  const dateStr = d.dateDisplay + (d.shift === 'Night' ? '(N)' : '');
  const duration = getDurationMinutesFromText(d.tStart, d.tEnd);
  const durationText = d.tEnd && duration !== null ? ` (${formatDurationText(duration)})` : '';
  const timeStr = d.tEnd ? `${d.tStart}-${d.tEnd}${durationText}` : `${d.tStart}-`;
  return `@Work Completion\n1. Date : ${dateStr}\n2. Time : ${timeStr}\n3. Management No. : #${d.manageNo}\n4. Process : ${d.process}\n5. Issue / Remarks :  ${d.issue}\n6. Action Taken : ${d.action}`;
}

function buildJson(d) {
  const photos = serializePhotoEntries(d.photoEntries || []);
  return {
    recorded_at: new Date().toISOString(),
    date: d.dateVal, date_display: d.dateDisplay, shift: d.shift,
    time_start: d.tStart, time_end: d.tEnd, manage_no: d.manageNo,
    process: d.process, report_type: d.reportType, issue: d.issue, action: d.action, defect_disposition: d.defectDisposition,
    shared_edit: d.sharedEdit === true,
    photo_data: photos.photo_data,
    photo_name: photos.photo_name
  };
}

// ── PREVIEW ──
function updatePreview() {
  const d = getFormData();
  const html = buildText(d)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/(@Work Completion)/g, '<span class="t">$1</span>')
    .replace(/(#[\w()]+)/g, '<span class="n">$1</span>')
    .replace(/(\(N\))/g, '<span class="y">$1</span>');
  document.getElementById('preview').innerHTML = html;
  updateTimeDuration(d.tStart, d.tEnd);
  updatePhotoRecommendation(d);
  if (typeof updateFormValidationNote === 'function') updateFormValidationNote(d);
}

// ── COPY ──
async function copyText() {
  await doClipboard(buildText(getFormData()));
  flashBtn('copyBtn', '✓ Copied', 'btn-primary success');
  showToast('✓ Copied to clipboard');
}

// ── RECORDS ──
// ── RESET ──
function resetForm() {
  isNight = false; hasSuffix = false;
  setEditingRecordId(null);
  fieldLang.issue = 'ko';
  fieldLang.action = 'ko';
  document.getElementById('nightChip').classList.remove('active');
  document.getElementById('nightLabel').textContent = 'Day';
  document.getElementById('suffixChip').classList.remove('active');
  document.getElementById('suffixChipLabel').textContent = 'No Suffix';
  document.getElementById('suffixBox').classList.remove('show');
  document.getElementById('suffixLetter').value = 'R';
  document.getElementById('process').value = 'EOL#2';
  document.getElementById('customProcessField').style.display = 'none';
  document.getElementById('customProcess').value = '';
  setReportType(REPORT_TYPE_DEFAULT);
  document.getElementById('issue').value = '';
  document.getElementById('action').value = '';
  const defectDisposition = document.getElementById('defectDisposition');
  if (defectDisposition) defectDisposition.value = '';
  const sharedEditCheckbox = document.getElementById('sharedEditCheckbox');
  if (sharedEditCheckbox) sharedEditCheckbox.checked = false;
  clearEvidencePhoto();
  ['issue', 'action'].forEach(field => {
    ['ko', 'en'].forEach(lang => {
      const btn = document.getElementById(`lang-${field}-${lang}`);
      if (btn) btn.classList.toggle('active', lang === 'ko');
    });
  });
  ['issue','action'].forEach(f => discardPolish(f));
  syncSaveButton();
  initDefaults();
}

function formatTimeInput(input) {
  const digits = input.value.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) {
    input.value = digits;
  } else {
    input.value = `${digits.slice(0, 2)}:${digits.slice(2)}`;
  }
  updatePreview();
}

function updateTimeDuration(start, end) {
  const el = document.getElementById('timeDuration');
  if (!el) return;
  const diff = getDurationMinutesFromText(start, end);
  if (diff === null) {
    el.textContent = '';
    return;
  }

  el.textContent = `Duration: ${formatDurationText(diff)}`;
}

function parseTimeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return null;
  const [hh, mm] = value.split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

let lastResumeRefreshAt = 0;

function handleAppResumeRefresh() {
  const now = Date.now();
  if (now - lastResumeRefreshAt < 1200) return;
  lastResumeRefreshAt = now;
  refreshFormDefaultsOnResume();
  if (document.body.classList.contains('auth-ready')) {
    loadRecords(true)
      .then(() => {
        if (document.getElementById('page-records')?.classList.contains('active')) renderRecords();
      })
      .catch(() => {});
  }
}

window.addEventListener('focus', handleAppResumeRefresh);
window.addEventListener('pageshow', handleAppResumeRefresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') handleAppResumeRefresh();
});

// ── UTILS ──
async function doClipboard(text) {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
}

let toastTimer;
function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast'+(type?' '+type:'')+' show';
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 2400);
}

function flashBtn(id, label, cls) {
  const btn = document.getElementById(id);
  const orig = btn.innerHTML; const origCls = btn.className;
  btn.textContent = label; btn.className = 'btn '+cls;
  setTimeout(()=>{ btn.innerHTML=orig; btn.className=origCls; }, 2000);
}

function togglePasswordVisibility(inputId, button) {
  const input = document.getElementById(inputId);
  if (!input || !button) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  button.classList.toggle('is-visible', !showing);
  button.setAttribute('aria-pressed', showing ? 'false' : 'true');
  button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
}

// ── PROFILE PAGE ──
async function renderProfilePage() {
  const content = document.getElementById('profileContent');
  if (!content) return;
  if (!currentUser) {
    content.innerHTML = '<p style="color:var(--text3)">Sign in required.</p>';
    return;
  }

  const roleLabel = currentUser.role === 'admin'
    ? '<span class="profile-role-badge admin">ADMIN</span>'
    : '<span class="profile-role-badge user">USER</span>';

  content.innerHTML = `
    <div class="profile-field">
      <span class="profile-label">User ID</span>
      <span class="profile-value mono">${escHtml(currentUser.id)}</span>
    </div>
    <div class="profile-field">
      <span class="profile-label">Role</span>
      <span class="profile-value">${roleLabel}</span>
    </div>
    <hr class="profile-divider">
    <div class="profile-field">
      <label class="profile-label" for="profileName">Name</label>
      <input class="profile-input" id="profileName" type="text" value="${escHtml(currentUser.name)}" placeholder="Enter name">
    </div>
    <div id="profileStatus" class="profile-status"></div>
    <button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="submitProfileUpdate()">Save</button>
    <hr class="profile-divider">
    <button class="logout-btn" style="width:100%;justify-content:center;border-radius:12px;padding:10px" type="button" onclick="logout()">↩ Logout</button>
  `;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function submitProfileUpdate() {
  const name = document.getElementById('profileName')?.value?.trim();
  const statusEl = document.getElementById('profileStatus');

  if (!name) {
    if (statusEl) { statusEl.textContent = 'Enter a name.'; statusEl.className = 'profile-status error'; }
    return;
  }

  if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.className = 'profile-status'; }

  try {
    const res = await apiFetch('/api/user-me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (statusEl) { statusEl.textContent = data.detail || data.error || 'Save failed'; statusEl.className = 'profile-status error'; }
      return;
    }
    // Update local user state
    setCurrentUserState({ ...currentUser, name }, userToken);
    if (statusEl) { statusEl.textContent = '✓ Saved'; statusEl.className = 'profile-status success'; }
    showToast('Profile saved');
  } catch {
    if (statusEl) { statusEl.textContent = 'Network error.'; statusEl.className = 'profile-status error'; }
  }
}

// ── PWA ──
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
