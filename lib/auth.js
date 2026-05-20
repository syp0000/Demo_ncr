export function getAppPassword() {
  return String(process.env.APP_PASSWORD || '');
}

export function getExportCode() {
  return String(process.env.APP_EXPORT_CODE || process.env.APP_PASSWORD || '');
}

export function isAuthConfigured() {
  return Boolean(getAppPassword());
}

export function getPublicAuthConfig() {
  const userAuthEnabled = Boolean(
    String(process.env.APP_USERS_JSON || '').trim() ||
    String(process.env.APP_USER_AUTH || '').trim() === '1'
  );
  return {
    enabled: isAuthConfigured(),
    exportProtected: Boolean(getExportCode()),
    userAuthEnabled
  };
}

function getSubmittedPassword(req) {
  const headerPassword = req.headers['x-app-password'];
  if (headerPassword) return String(headerPassword);
  return String(req.body?.password || '');
}

export function requireAppPassword(req, res) {
  if (!isAuthConfigured()) {
    res.status(503).json({ error: 'App password is not configured' });
    return false;
  }

  const submitted = getSubmittedPassword(req);
  if (!submitted || submitted !== getAppPassword()) {
    res.status(401).json({ error: 'Unauthorized', detail: 'Invalid app password' });
    return false;
  }

  return true;
}
