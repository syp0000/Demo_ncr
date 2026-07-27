import { getExportCode } from '../lib/auth.js';
import { route } from '../lib/http.js';

function getSubmittedExportCode(req) {
  const headerCode = req.headers['x-export-code'];
  if (headerCode) return String(headerCode).trim();
  return String(req.body?.code || '').trim();
}

export default route(
  { name: 'export-auth', methods: ['POST'], headers: ['X-Export-Code', 'X-User-Token'] },
  (req, res) => {
    const expected = getExportCode();
    if (!expected) return res.status(503).json({ error: 'Export code is not configured' });

    const submitted = getSubmittedExportCode(req);
    if (!submitted || submitted !== expected) {
      return res.status(401).json({ error: 'Unauthorized', detail: 'Invalid export code' });
    }

    return res.status(200).json({ ok: true });
  }
);
