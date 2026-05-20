// ── AUTH MODULE ──
async function loadAuthConfig() {
  const res = await fetch('/api/auth-config', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load auth config');
  authConfig = await res.json();
  return authConfig;
}

function setAuthStatus(message, isError = false) {
  const el = document.getElementById('authStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
}

function setAuthButtonBusy(busy) {
  const btn = document.getElementById('authSignInBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? 'Checking...' : 'Sign In';
}

function setAuthButtonEnabled(enabled) {
  const btn = document.getElementById('authSignInBtn');
  if (!btn) return;
  btn.disabled = !enabled;
}

function setCurrentUserState(user, token = userToken) {
  currentUser = user || null;
  userToken = token || '';
  if (currentUser) {
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
  } else {
    localStorage.removeItem('currentUser');
  }
  if (userToken) {
    localStorage.setItem('userToken', userToken);
  } else {
    localStorage.removeItem('userToken');
  }
  updateCurrentUserChip();
}

function clearAuthSession() {
  appPassword = '';
  exportAuthorized = false;
  setCurrentUserState(null, '');
  localStorage.removeItem('appPassword');
  localStorage.removeItem('exportAuthorized');
}

function logout() {
  clearAuthSession();
  // Also clear any sessionStorage leftovers from old versions
  sessionStorage.clear();
  document.body.classList.remove('auth-ready');
  document.body.classList.add('auth-locked');
  showLoginMode();
  document.getElementById('authPasswordInput').value = '';
  document.getElementById('authUserIdInput').value = '';
  document.getElementById('authUserPasswordInput').value = '';
  setAuthStatus('Signed out. Sign in again.');
}

function canCurrentUserEditRecord(record) {
  if (!record) return false;
  if (currentUser?.role === 'admin') return true;
  const me = String(currentUser?.id || '');
  return (
    record.shared_edit === true ||
    String(record.author_id || '') === me ||
    String(record.delegated_editor_id || '') === me
  );
}

function canCurrentUserDelegateRecord(record) {
  if (!record) return false;
  if (currentUser?.role === 'admin') return true;
  return String(record.author_id || '') === String(currentUser?.id || '');
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (appPassword) headers.set('X-App-Password', appPassword);
  if (userToken) headers.set('X-User-Token', userToken);
  return fetch(url, { ...options, headers });
}

async function verifySession() {
  if (!appPassword) return false;
  const res = await apiFetch('/api/user-me', { cache: 'no-store' });
  if (!res.ok) return false;
  const data = await res.json();
  if (data?.user) setCurrentUserState(data.user, userToken);
  return true;
}

async function initializeAuth() {
  await loadAuthConfig();

  if (!authConfig?.enabled) {
    document.body.classList.add('auth-locked');
    document.body.classList.remove('auth-ready');
    setAuthStatus('APP_PASSWORD is not configured yet. Add it before opening the app.', true);
    setAuthButtonEnabled(false);
    return;
  }

  setAuthButtonEnabled(true);
  document.getElementById('authPasswordInput').value = appPassword;
  const userIdInput = document.getElementById('authUserIdInput');
  const userPwInput = document.getElementById('authUserPasswordInput');
  const modeSwitch = document.getElementById('authModeSwitch');
  const needUserAuth = Boolean(authConfig?.userAuthEnabled);
  if (userIdInput) {
    userIdInput.style.display = needUserAuth ? 'block' : 'none';
    userIdInput.value = needUserAuth ? String(localStorage.getItem('lastUserId') || '') : '';
  }
  if (userPwInput) {
    userPwInput.style.display = needUserAuth ? 'block' : 'none';
    userPwInput.value = '';
  }
  if (modeSwitch) modeSwitch.style.display = needUserAuth ? 'block' : 'none';
  const cachedUser = localStorage.getItem('currentUser');
  if (cachedUser) {
    try {
      currentUser = JSON.parse(cachedUser);
    } catch {
      currentUser = null;
    }
  }
  updateCurrentUserChip();

  if (await verifySession()) {
    document.body.classList.remove('auth-locked');
    document.body.classList.add('auth-ready');
    updateExportBarLabel();
    updateAdminTabVisibility();
    setAuthStatus(`Unlocked as ${currentUser?.name || 'user'}`);
    await loadRecords(true);
    await loadAdminRequests();
    renderRecords();
    return;
  }

  clearAuthSession();
  document.body.classList.add('auth-locked');
  document.body.classList.remove('auth-ready');
  setAuthStatus(authConfig?.userAuthEnabled
    ? 'Sign in with the shared access code and your user account.'
    : 'Enter the shared access code.');
}

function showRegisterMode() {
  document.getElementById('loginPanel').style.display = 'none';
  document.getElementById('registerPanel').style.display = 'block';
  document.getElementById('authCardTitle').textContent = 'Request Account';
  document.getElementById('authBadge').textContent = 'REGISTER';
  setRegisterStatus('');
  // Pre-fill access code if already entered on login form
  const loginCode = document.getElementById('authPasswordInput')?.value?.trim();
  if (loginCode) document.getElementById('regAccessCode').value = loginCode;
  document.getElementById('regUsername').focus();
}

function showLoginMode() {
  document.getElementById('registerPanel').style.display = 'none';
  document.getElementById('loginPanel').style.display = 'block';
  document.getElementById('authCardTitle').textContent = 'NCR Assistant';
  document.getElementById('authBadge').textContent = 'SECURE ACCESS';
  ['regAccessCode','regUsername','regName','regPassword','regPasswordConfirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  setRegisterStatus('');
}

function setRegisterStatus(message, isError = false) {
  const el = document.getElementById('registerStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
}

async function submitRegister() {
  const appPass = String(document.getElementById('regAccessCode')?.value || '').trim();
  const username = String(document.getElementById('regUsername')?.value || '').trim().toLowerCase();
  const name = String(document.getElementById('regName')?.value || '').trim();
  const password = String(document.getElementById('regPassword')?.value || '').trim();
  const confirm = String(document.getElementById('regPasswordConfirm')?.value || '').trim();

  if (!appPass) return setRegisterStatus('Enter the access code.', true);
  if (!username) return setRegisterStatus('Enter a user ID.', true);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return setRegisterStatus('Use 3-40 lowercase letters, numbers, dots, underscores, or hyphens.', true);
  if (!name) return setRegisterStatus('Enter a name.', true);
  if (!password) return setRegisterStatus('Enter a password.', true);
  if (password.length < 4) return setRegisterStatus('Password must be at least 4 characters.', true);
  if (password !== confirm) return setRegisterStatus('Passwords do not match.', true);

  const btn = document.getElementById('registerSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  setRegisterStatus('Sending account request...');

  try {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-App-Password': appPass });
    const res = await fetch('/api/user-signup-request', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username, name, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setRegisterStatus(data.detail || data.error || 'Account request failed. Try again.', true);
      return;
    }
    setRegisterStatus('✓ Request sent. You can sign in after admin approval.');
    showToast('Account request sent. Waiting for admin approval.');
    setTimeout(() => showLoginMode(), 2500);
  } catch (e) {
    setRegisterStatus('Network error. Try again.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request Account';
  }
}

// kept for backwards compat — no longer used directly
async function requestSignup() {
  showRegisterMode();
}

async function unlockApp() {
  if (!authConfig?.enabled) return;
  try {
    setAuthButtonBusy(true);
    setAuthStatus('Checking sign-in...');
    const input = document.getElementById('authPasswordInput');
    appPassword = input?.value?.trim() || '';
    localStorage.setItem('appPassword', appPassword);

    if (authConfig?.userAuthEnabled) {
      const userId = String(document.getElementById('authUserIdInput')?.value || '').trim();
      const userPass = String(document.getElementById('authUserPasswordInput')?.value || '').trim();
      if (!userId || !userPass) throw new Error('Enter user ID and password.');

      const loginRes = await apiFetch('/api/user-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: userId, password: userPass })
      });
      const loginData = await loginRes.json().catch(() => ({}));
      if (!loginRes.ok) throw new Error(loginData.detail || 'User sign-in failed');
      setCurrentUserState(loginData.user, loginData.token);
      localStorage.setItem('lastUserId', userId);
    }

    const ok = await verifySession();
    if (!ok) throw new Error('Session verification failed');

    document.body.classList.remove('auth-locked');
    document.body.classList.add('auth-ready');
    updateExportBarLabel();
    setAuthStatus(`Unlocked as ${currentUser?.name || 'user'}`);
    updateAdminTabVisibility();
    await loadRecords(true);
    await loadAdminRequests();
    renderRecords();
  } catch (error) {
    console.error('[auth]', error);
    setAuthStatus(error.message || 'Sign-in failed', true);
    clearAuthSession();
  } finally {
    setAuthButtonBusy(false);
  }
}

function updateExportBarLabel() {
  const label = document.getElementById('exportBarLabel');
  if (!label) return;
  if (!authConfig?.exportProtected) {
    label.textContent = 'Export';
    return;
  }
  label.textContent = exportAuthorized
    ? 'Authorized Export (verified)'
    : 'Authorized Export';
}

async function ensureExportAuthorization() {
  if (!authConfig?.exportProtected) return true;
  if (exportAuthorized) return true;
  const input = prompt('Enter export code');
  if (input === null) return false;
  const code = String(input).trim();
  if (!code) {
    showToast('Enter the export code', 'warn');
    return false;
  }

  const res = await apiFetch('/api/export-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });

  if (!res.ok) {
    showToast('Invalid export code', 'warn');
    return false;
  }

  exportAuthorized = true;
  sessionStorage.setItem('exportAuthorized', '1');
  updateExportBarLabel();
  showToast('Export authorization verified');
  return true;
}
