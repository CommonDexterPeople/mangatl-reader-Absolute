// ═══════════════════════════════════════════════════════════════
// mangadex-auth.js
// MangaDex OAuth2 login/logout/token-refresh + the login-status UI.
// ═══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════
// ══════════════════════════════════════════════
// MANGADEX AUTH
// ══════════════════════════════════════════════

let _mdAccessToken  = null;
let _mdRefreshToken = null;
let _mdTokenExpiry  = 0;       // ms timestamp
let _mdClientId     = '';
let _mdClientSecret = '';
let _mdUsername     = '';

function toggleMdLogin() {
  document.getElementById('md-login-wrap').classList.toggle('open');
}

function _setMdStatus(loggedIn, username = '') {
  document.getElementById('md-status-dot').className =
    'md-status-dot' + (loggedIn ? ' online' : '');
  document.getElementById('md-status-text').textContent =
    loggedIn ? `Logged in as ${username}` : 'Guest';
  const btn = document.getElementById('md-login-btn');
  btn.textContent = loggedIn ? 'Logout' : 'Login';
  btn.onclick     = loggedIn ? logoutMangaDex : loginMangaDex;
}

function _saveMdTokens(accessToken, refreshToken, expiresIn, username) {
  _mdAccessToken  = accessToken;
  _mdRefreshToken = refreshToken;
  _mdTokenExpiry  = Date.now() + expiresIn * 1000;
  _mdUsername     = username;
  localStorage.setItem('mtl_md_access',   accessToken);
  localStorage.setItem('mtl_md_refresh',  refreshToken);
  localStorage.setItem('mtl_md_expiry',   String(_mdTokenExpiry));
  localStorage.setItem('mtl_md_username', username);
}

function _clearMdTokens() {
  _mdAccessToken = _mdRefreshToken = null;
  _mdTokenExpiry = 0; _mdUsername = '';
  ['mtl_md_access','mtl_md_refresh','mtl_md_expiry','mtl_md_username'].forEach(k =>
    localStorage.removeItem(k));
}

// Returns a valid access token, refreshing first if needed. Returns null if not logged in.
async function getMdToken() {
  if (!_mdAccessToken) return null;
  if (Date.now() < _mdTokenExpiry - 60_000) return _mdAccessToken;  // still valid
  // Try to refresh
  try {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: _mdRefreshToken,
        client_id:     _mdClientId,
        client_secret: _mdClientSecret,
      }),
    });
    if (!res.ok) { _clearMdTokens(); _setMdStatus(false); return null; }
    const d = await res.json();
    _saveMdTokens(d.access_token, d.refresh_token, d.expires_in, _mdUsername);
    return _mdAccessToken;
  } catch {
    return _mdAccessToken;  // network hiccup — try with old token
  }
}

// Returns headers object with Authorization if logged in, otherwise just User-Agent.
async function getMdHeaders() {
  const token = await getMdToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function loginMangaDex() {
  const clientId     = document.getElementById('md-client-id').value.trim();
  const clientSecret = document.getElementById('md-client-secret').value.trim();
  const username     = document.getElementById('md-username').value.trim();
  const password     = document.getElementById('md-password').value.trim();
  if (!clientId || !clientSecret || !username || !password) {
    toast('Fill in all four MangaDex fields.'); return;
  }
  const btn = document.getElementById('md-login-btn');
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error_description || err?.error || `Login failed (${res.status})`);
    }
    const d = await res.json();
    _mdClientId     = clientId;
    _mdClientSecret = clientSecret;
    _saveMdTokens(d.access_token, d.refresh_token, d.expires_in, username);
    localStorage.setItem('mtl_md_client_id',     clientId);
    localStorage.setItem('mtl_md_client_secret', clientSecret);
    _setMdStatus(true, username);
    // Clear password field — don't persist it
    document.getElementById('md-password').value = '';
    toast('MangaDex login successful ✓');
  } catch (e) {
    toast(`Login failed: ${e.message}`);
    btn.disabled = false; btn.textContent = 'Login';
  }
}

function logoutMangaDex() {
  _clearMdTokens();
  _setMdStatus(false);
  toast('Logged out of MangaDex.');
}

