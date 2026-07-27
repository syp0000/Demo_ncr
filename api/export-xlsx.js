import ExcelJS from 'exceljs';
import { query } from '../lib/db.js';
import { route } from '../lib/http.js';

function normalizeExportType(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['xlsx', 'json', 'text'].includes(text) ? text : 'xlsx';
}

function normalizeExportMode(value) {
  const text = String(value || '').trim().toLowerCase();
  return ['all', 'new'].includes(text) ? text : 'all';
}

const PROCESS_TEMPLATE = [
  { label: 'Enclosure Feeding', minutes: 40 },
  { label: 'BPU Insertion', minutes: 60 },
  { label: 'Pack Insertion 1/3', minutes: 60 },
  { label: 'Pack Mounting 1/3', minutes: 60 },
  { label: 'Pack Insertion 2', minutes: 60 },
  { label: 'Pack Mounting 2', minutes: 60 },
  { label: 'Branch Pipe Mounting', minutes: 45 },
  { label: 'Cabling', minutes: 60 },
  { label: 'Leak Test', minutes: 60 },
  { label: 'Coolant Injection', minutes: 60 },
  { label: 'EOL#1', minutes: 45 },
  { label: 'EOL#2', minutes: 50 },
  { label: 'OQC', minutes: 60 },
  { label: 'LINK Output', minutes: 40 }
];

const PROCESS_KEY_ALIASES = {
  bpuinsertion1: 'bpuinsertion',
  packinsertion1: 'packinsertion13',
  packmount1: 'packmounting13',
  packmounting1: 'packmounting13',
  packmount2: 'packmounting2',
  eol1: 'eol1',
  eol2: 'eol2'
};

const PROCESS_STANDARD_MINUTES = Object.fromEntries(
  PROCESS_TEMPLATE.map((item) => [normalizeProcessKey(item.label), item.minutes])
);

function normalizeProcessKey(value) {
  const raw = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return PROCESS_KEY_ALIASES[raw] || raw;
}

function getStandardMinutes(process) {
  const key = normalizeProcessKey(process);
  const minutes = PROCESS_STANDARD_MINUTES[key];
  return minutes == null ? '' : String(minutes);
}

function getTemplateProcessForKey(key) {
  return PROCESS_TEMPLATE.find((item) => normalizeProcessKey(item.label) === key) || null;
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

function parseTimeMinutes(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function getDurationMinutes(record) {
  const start = parseTimeMinutes(record?.time_start);
  const end = parseTimeMinutes(record?.time_end);
  if (start == null || end == null) return null;
  if (end >= start) return end - start;
  return (24 * 60 - start) + end;
}

function getShiftCode(shift) {
  return String(shift || '').toLowerCase().startsWith('n') ? 'N' : 'D';
}

function getDifferenceData(record) {
  const standardText = record.standardMinutes != null && record.standardMinutes !== ''
    ? String(record.standardMinutes)
    : getStandardMinutes(record.process);
  const standard = standardText ? Number(standardText) : null;
  const duration = record.durationMinutes != null && record.durationMinutes !== ''
    ? Number(record.durationMinutes)
    : getDurationMinutes(record);
  if (standard == null || duration == null) return { text: '', className: '' };
  const diff = standard - duration;
  const text = `${diff > 0 ? '+' : ''}${diff}`;
  const className = diff > 0 ? 'diff-plus' : diff < 0 ? 'diff-minus' : '';
  return { text, className };
}

function getRecordSortTime(record) {
  const basis = record?.recorded_at || record?.date;
  const parsed = new Date(basis || 0);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function formatExcelDate(value) {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getExcelDateLabel(record) {
  return formatExcelDate(record?.date || record?.recorded_at);
}

function formatExcelLinkNo(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^([^()]+?)(?:\(([^()]*)\))?$/);
  const base = (match?.[1] || text).trim();
  const suffix = (match?.[2] || '').trim();
  return suffix ? `#${base}_${suffix}` : `#${base}`;
}

function buildExcelRows(records) {
  const byManage = new Map();
  for (const record of records) {
    const manageNo = String(record.manage_no || '').trim();
    if (!manageNo) continue;
    if (!byManage.has(manageNo)) byManage.set(manageNo, []);
    byManage.get(manageNo).push(record);
  }

  const manageGroups = [...byManage.entries()].map(([manageNo, items]) => ({
    manageNo,
    items: [...items].sort((a, b) => getRecordSortTime(a) - getRecordSortTime(b) || String(a.id || '').localeCompare(String(b.id || ''))),
    firstTime: Math.min(...items.map(getRecordSortTime))
  })).sort((a, b) =>
    a.firstTime - b.firstTime ||
    a.manageNo.localeCompare(b.manageNo, undefined, { numeric: true })
  );

  const rows = [];
  let rowNo = 1;
  for (const group of manageGroups) {
    const latestByProcess = new Map();
    for (const record of group.items) {
      const key = normalizeProcessKey(record.process);
      const current = latestByProcess.get(key);
      if (!current || getRecordSortTime(record) >= getRecordSortTime(current)) {
        latestByProcess.set(key, record);
      }
    }

    const templateKeys = PROCESS_TEMPLATE.map((item) => normalizeProcessKey(item.label));
    for (const item of PROCESS_TEMPLATE) {
      const key = normalizeProcessKey(item.label);
      const matched = latestByProcess.get(key);
      const dateLabel = matched ? getExcelDateLabel(matched) : '';
      const start = matched ? String(matched.time_start || '').trim() : '';
      const end = matched ? String(matched.time_end || '').trim() : '';
      const duration = matched ? getDurationMinutes(matched) : null;
      const base = {
        no: rowNo++,
        baseDate: dateLabel,
        shift: matched ? getShiftCode(matched.shift) : '',
        linkNo: formatExcelLinkNo(group.manageNo),
        processName: item.label,
        process: item.label,
        standardMinutes: String(item.minutes),
        durationMinutes: duration == null ? '' : String(duration),
        startTime: start ? `${dateLabel} ${start}`.trim() : '',
        endTime: end ? `${dateLabel} ${end}`.trim() : '',
        item: matched ? String(matched.issue || '') : '',
        content: '',
        action: matched ? String(matched.action || '') : '',
        cause: '',
        photoEntries: matched ? normalizePhotoEntries(matched.photo_data, matched.photo_name) : []
      };
      const diff = getDifferenceData(base);
      rows.push({ ...base, diffText: diff.text, diffClass: diff.className });
    }

    const extra = [...latestByProcess.keys()].filter((key) => !templateKeys.includes(key));
    for (const key of extra.sort((a, b) => b.localeCompare(a))) {
      const matched = latestByProcess.get(key);
      const template = getTemplateProcessForKey(key);
      const dateLabel = getExcelDateLabel(matched);
      const start = String(matched.time_start || '').trim();
      const end = String(matched.time_end || '').trim();
      const duration = getDurationMinutes(matched);
      const base = {
        no: rowNo++,
        baseDate: dateLabel,
        shift: getShiftCode(matched.shift),
        linkNo: formatExcelLinkNo(group.manageNo),
        processName: matched.process || (template ? template.label : ''),
        process: matched.process || (template ? template.label : ''),
        standardMinutes: getStandardMinutes(matched.process),
        durationMinutes: duration == null ? '' : String(duration),
        startTime: start ? `${dateLabel} ${start}`.trim() : '',
        endTime: end ? `${dateLabel} ${end}`.trim() : '',
        item: String(matched.issue || ''),
        content: '',
        action: String(matched.action || ''),
        cause: '',
        photoEntries: normalizePhotoEntries(matched.photo_data, matched.photo_name)
      };
      const diff = getDifferenceData(base);
      rows.push({ ...base, diffText: diff.text, diffClass: diff.className });
    }
  }

  return rows;
}

function getImageDimensions(buffer, extension) {
  try {
    if (extension === 'png') {
      // PNG: width/height at bytes 16-23 of IHDR chunk
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (extension === 'jpeg') {
      let offset = 2; // skip SOI
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        // SOF markers (C0-CF) except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segmentLength;
      }
    }
  } catch {}
  return null;
}

function applyExcelHeaderStyle(cell, bgColor) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
  cell.font = { bold: true };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
}

function applyExcelBodyStyle(cell, isFirstCol = false) {
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  cell.border = {
    top: { style: 'thin', color: { argb: isFirstCol ? 'FF000000' : 'FFA6A6A6' } },
    left: { style: 'thin', color: { argb: isFirstCol ? 'FF000000' : 'FFA6A6A6' } },
    bottom: { style: 'thin', color: { argb: isFirstCol ? 'FF000000' : 'FFA6A6A6' } },
    right: { style: 'thin', color: { argb: isFirstCol ? 'FF000000' : 'FFA6A6A6' } }
  };
}

function excelColumnWidthToPixels(width) {
  const numeric = Number(width || 8.43);
  return Math.max(64, Math.round(numeric * 7 + 5));
}

function pointsToPixels(points) {
  return Number(points || 0) * (96 / 72);
}

async function buildWorkbook(records) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('NCR Report');
  const rows = buildExcelRows(records);
  const headers = [
    'Time Difference',
    'No.',
    'Base Date',
    'D/N-Shift',
    'Link No.',
    'Process',
    'Standard Time (min)',
    'Start Time',
    'End Time',
    'Issue',
    'Details',
    'Action Taken',
    'Cause',
    'Photo'
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  const blueCols = new Set([1, 3, 4, 7]);
  headerRow.eachCell((cell, colNum) => {
    applyExcelHeaderStyle(cell, blueCols.has(colNum) ? 'FFCAEDFB' : 'FFC0C0C0');
    applyExcelBodyStyle(cell, colNum === 1);
  });

  sheet.columns = [
    { width: 12 }, { width: 8 }, { width: 16 }, { width: 10 },
    { width: 12 }, { width: 24 }, { width: 14 }, { width: 18 },
    { width: 18 }, { width: 22 }, { width: 26 }, { width: 26 },
    { width: 16 }, { width: 60 }
  ];

  for (const row of rows) {
    const excelRow = sheet.addRow([
      row.diffText || '',
      row.no || '',
      row.baseDate || '',
      row.shift || '',
      row.linkNo || '',
      row.process || '',
      row.standardMinutes || '',
      row.startTime || '',
      row.endTime || '',
      row.item || '',
      row.content || '',
      row.action || '',
      row.cause || '',
      ''
    ]);

    if (row.photoEntries && row.photoEntries.length) {
      try {
        const photoColIndex = 13; // zero-based, 14th column
        const colWidthPx = excelColumnWidthToPixels(sheet.columns[photoColIndex]?.width);
        const paddingPx = 8;
        const gapPx = 10;
        const maxCols = row.photoEntries.length === 1 ? 1 : 2;
        const slotWidthPx = Math.max(
          80,
          Math.floor((colWidthPx - (paddingPx * 2) - (gapPx * (maxCols - 1))) / maxCols)
        );
        const maxSlotHeightPx = 180;
        const placedImages = [];

        for (const [index, photo] of row.photoEntries.entries()) {
          const parts = String(photo.dataUrl || '').split(',');
          const mimeMatch = parts[0]?.match(/:(.*?);/);
          if (!mimeMatch || !parts[1]) continue;

          const mime = mimeMatch[1];
          let extension = mime.split('/')[1];
          if (extension === 'jpg') extension = 'jpeg';
          if (!['jpeg', 'png', 'gif'].includes(extension)) extension = 'png';

          const imageBuffer = Buffer.from(parts[1], 'base64');
          const dims = getImageDimensions(imageBuffer, extension);
          let displayW = slotWidthPx;
          let displayH = Math.round(slotWidthPx * 0.75);
          if (dims && dims.width && dims.height) {
            const scale = Math.min(slotWidthPx / dims.width, maxSlotHeightPx / dims.height, 1);
            displayW = Math.max(1, Math.round(dims.width * scale));
            displayH = Math.max(1, Math.round(dims.height * scale));
          }

          placedImages.push({
            index,
            buffer: imageBuffer,
            extension,
            width: displayW,
            height: displayH
          });
        }

        if (placedImages.length > 0) {
          const rowHeightsPx = [];
          for (const image of placedImages) {
            const rowIndex = Math.floor(image.index / maxCols);
            rowHeightsPx[rowIndex] = Math.max(rowHeightsPx[rowIndex] || 0, image.height);
          }

          const contentHeightPx = rowHeightsPx.reduce((sum, height) => sum + height, 0)
            + Math.max(0, rowHeightsPx.length - 1) * gapPx;
          const totalHeightPx = Math.max(80, contentHeightPx + (paddingPx * 2));
          excelRow.height = Math.round(totalHeightPx * 0.75);

          const rowHeightPx = Math.max(1, pointsToPixels(excelRow.height));
          const yOffsetsPx = [];
          let runningY = paddingPx;
          for (let i = 0; i < rowHeightsPx.length; i += 1) {
            yOffsetsPx[i] = runningY;
            runningY += rowHeightsPx[i] + gapPx;
          }

          for (const image of placedImages) {
            const imageId = workbook.addImage({
              buffer: image.buffer,
              extension: image.extension,
            });
            const gridRow = Math.floor(image.index / maxCols);
            const gridCol = image.index % maxCols;
            const xOffsetPx = paddingPx + gridCol * (slotWidthPx + gapPx) + Math.round((slotWidthPx - image.width) / 2);
            const yOffsetPx = yOffsetsPx[gridRow];

            sheet.addImage(imageId, {
              tl: {
                col: photoColIndex + (xOffsetPx / colWidthPx),
                row: (excelRow.number - 1) + (yOffsetPx / rowHeightPx)
              },
              ext: { width: image.width, height: image.height },
              editAs: 'oneCell'
            });
          }
        } else {
          excelRow.height = 22;
        }
      } catch (e) {
        console.error('[export-xlsx] Image embedding failed:', e);
        excelRow.height = 22;
      }
    } else {
      excelRow.height = 22;
    }

    excelRow.eachCell((cell, colNum) => {
      applyExcelBodyStyle(cell, colNum === 1);
      if (colNum === 1) {
        if (row.diffClass === 'diff-plus') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB3E5A1' } };
          cell.font = { bold: true, color: { argb: 'FF000000' } };
        } else if (row.diffClass === 'diff-minus') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
          cell.font = { bold: true, color: { argb: 'FF9C0006' } };
        }
      }
    });
  }

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };

  return workbook;
}

/** GET — the export audit log. Restricted to admins pinned via APP_USERS_JSON. */
async function readAuditLog(req, res, user) {
  if (!user.isEnvAdmin) {
    return res.status(403).json({ error: 'Forbidden', detail: 'Only environment-configured admins can view export audit history.' });
  }
  const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 50, 1), 200);
  const result = await query(`
    SELECT id, export_type, export_mode, record_count, actor_id, actor_name, actor_role, actor_is_env_admin, created_at
    FROM export_audit
    ORDER BY created_at DESC, id DESC
    LIMIT $1
  `, [limit]);
  return res.status(200).json({ audits: result.rows });
}

/** POST ?action=audit — records that an export happened, including the CSV and JSON ones. */
async function writeAuditEntry(req, res, user) {
  const result = await query(`
    INSERT INTO export_audit (export_type, export_mode, record_count, actor_id, actor_name, actor_role, actor_is_env_admin)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, export_type, export_mode, record_count, actor_id, actor_name, actor_role, actor_is_env_admin, created_at
  `, [
    normalizeExportType(req.body?.exportType),
    normalizeExportMode(req.body?.exportMode),
    Math.max(0, Number.parseInt(req.body?.recordCount, 10) || 0),
    String(user.id || ''),
    String(user.name || ''),
    String(user.role || 'user'),
    user.isEnvAdmin === true
  ]);
  return res.status(200).json({ ok: true, audit: result.rows[0] });
}

/** POST — streams the workbook for the requested record ids, in the order given. */
async function streamWorkbook(req, res) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No records selected for export' });

  const result = await query(`
    SELECT id, recorded_at, deleted_at, date, date_display, shift, time_start, time_end,
           manage_no, process, issue, action, text, author_id, author_name,
           editor_id, editor_name, photo_data, photo_name
    FROM records
    WHERE id = ANY($1::text[]) AND deleted_at IS NULL
  `, [ids]);

  const byId = new Map(result.rows.map((row) => [String(row.id), row]));
  const workbook = await buildWorkbook(ids.map((id) => byId.get(id)).filter(Boolean));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="ncr-export.xlsx"');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  await workbook.xlsx.write(res);
  return res.end();
}

export default route(
  { name: 'export-xlsx', methods: ['GET', 'POST'], headers: ['X-User-Token'], access: 'user', db: true },
  (req, res, user) => {
    if (req.method === 'GET') return readAuditLog(req, res, user);
    if (String(req.query?.action || '').trim().toLowerCase() === 'audit') return writeAuditEntry(req, res, user);
    return streamWorkbook(req, res);
  }
);
