import { getPublicAuthConfig } from '../lib/auth.js';
import { route } from '../lib/http.js';

export default route(
  { name: 'auth-config', methods: ['GET'], access: 'open' },
  (req, res) => res.status(200).json(getPublicAuthConfig())
);
