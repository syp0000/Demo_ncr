// ── BOOTSTRAP ──
syncSaveButton();
initDefaults();
initializeAuth().then(() => {
  if (authConfig?.enabled && appPassword) loadRecords();
}).catch(error => {
  console.error('[auth:init]', error);
  setAuthStatus('Authentication setup failed', true);
});
