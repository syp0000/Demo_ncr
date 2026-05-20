import { getExportCode, requireAppPassword } from '../lib/auth.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password, X-Export-Code');
}

function getSubmittedExportCode(req) {
  const headerCode = req.headers['x-export-code'];
  if (headerCode) return String(headerCode).trim();
  return String(req.body?.code || '').trim();
}

export default function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAppPassword(req, res)) return;

  const expected = getExportCode();
  if (!expected) return res.status(503).json({ error: 'Export code is not configured' });

  const submitted = getSubmittedExportCode(req);
  if (!submitted || submitted !== expected) {
    return res.status(401).json({ error: 'Unauthorized', detail: 'Invalid export code' });
  }

  return res.status(200).json({ ok: true });
}
