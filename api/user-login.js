import { requireAppPassword } from '../lib/auth.js';
import { authenticateUserCredentials, createUserToken, isUserAuthEnabled } from '../lib/user-auth.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!requireAppPassword(req, res)) return;

  if (!isUserAuthEnabled()) {
    return res.status(503).json({ error: 'User auth is not configured', detail: 'Set APP_USERS_JSON first' });
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '').trim();
  const user = await authenticateUserCredentials(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized', detail: 'Invalid user credentials' });
  }

  const token = await createUserToken(user);
  if (!token) return res.status(500).json({ error: 'Token generation failed' });

  return res.status(200).json({
    ok: true,
    token,
    user
  });
}
