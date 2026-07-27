import { authenticateUserCredentials, createUserToken, isUserAuthEnabled } from '../lib/user-auth.js';
import { route } from '../lib/http.js';

export default route(
  { name: 'user-login', methods: ['POST'] },
  async (req, res) => {
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

    return res.status(200).json({ ok: true, token, user });
  }
);
