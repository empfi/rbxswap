let accounts = [], launchAcc = null, editAcc = null, toastTimer;
let packages = [], editingPackageId = null;
// ─── Topbar RDD download status bar ────────────────────────────────────────
let _tbDlHideTimer = null;
function tbDlShow(label, percent, cls) {
  const box = document.getElementById('tb-dl');
  if (!box) return;
  if (_tbDlHideTimer) { clearTimeout(_tbDlHideTimer); _tbDlHideTimer = null; }
  box.style.display = 'flex';
  box.className = 'tb-dl' + (cls ? ' ' + cls : '');
  const lbl = document.getElementById('tb-dl-label');
  const pct = document.getElementById('tb-dl-pct');
  const bar = document.getElementById('tb-dl-bar');
  if (lbl && label != null) lbl.textContent = label;
  if (pct && percent != null) pct.textContent = percent + '%';
  if (bar && percent != null) bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
}
window.tbDlShow = tbDlShow;
window.tbDlHideSoon = tbDlHideSoon;

function tbDlHideSoon(ms = 4000) {
  const box = document.getElementById('tb-dl');
 if (!box) return;
  if (_tbDlHideTimer) clearTimeout(_tbDlHideTimer);
  _tbDlHideTimer = setTimeout(() => {
    box.style.display = 'none';
    box.className = 'tb-dl';
    const bar = document.getElementById('tb-dl-bar');
    if (bar) bar.style.width = '0%';
    _tbDlHideTimer = null;
  }, ms);
}
if (typeof api.onRddDownloadProgress === 'function') {
  api.onRddDownloadProgress(data => {
    if (!data) return;
    if (data.status === 'downloading') {
      tbDlShow(data.label || 'Downloading Roblox version…', typeof data.percent === 'number' ? data.percent : 0, '');
      // Mirror main-process installer progress into the launch modal while an
      // RDD pull runs there (modal-driven installs update it directly).
      if (document.getElementById('m-launch')?.classList.contains('open') && !_installStatusOwnedByModal) {
        setStatus('launch-status', 'load', `<div class="spin"></div> ${esc(data.label || 'Downloading version…')} (${data.percent || 0}%)`);
      }
    } else if (data.status === 'done') {
      tbDlShow(data.label || 'Version installed', 100, 'done');
      tbDlHideSoon();
    } else if (data.status === 'error') {
      tbDlShow(data.label || 'Download failed', 100, 'err');
      tbDlHideSoon(6000);
    }
  });
}

// ─── Outdated-version detection for launches ────────────────────────────────
// Non-null when a required executor build is about to be downloaded because
// what is installed locally is older (or nothing usable is installed):
//   { currentHash } — the version currently installed (null when none).
// Called at the start of installRequiredVersion, while _launchRequiredVersionHash
// still holds the WEAO-required hash that is missing locally.
function outdatedVersionInfo() {
  try {
    const requiredHash = normalizeVersionHash(_launchRequiredVersionHash);
    if (!requiredHash) return null;
    const current = _installedVersionsList.find(v => v.complete !== false);
    const currentHash = current ? normalizeVersionHash(current.hash) : null;
    if (currentHash && currentHash === requiredHash) return null; // already up to date
    return { currentHash, requiredHash };
  } catch { return null; }
}

function notifyOutdatedVersionBeforeLaunch(accName) {
  const info = outdatedVersionInfo();
  if (!info) return null;
  const executorName = _defaultExecutor || 'the selected executor';
  const msg = info.currentHash
    ? `${accName}: installed Roblox ${truncate(info.currentHash, 16)} is not supported by ${executorName} — the latest supported version is fetched automatically.`
    : `${accName}: no usable Roblox version installed — the latest supported version for ${executorName} is fetched automatically.`;
  // Session log entry only — no popup: the inline notice in the Launch Game
  // picker and the topbar download bar carry the visible status.
  logEntry('warn', 'launch', msg);
  return info;
}

const _launchedIds = new Set();
const _everLaunchedAt = {}; // id -> epoch ms of the most recent launch
const _presenceResolved = {}; // id -> true once Roblox's presence API returned a state
const _presencePollTimers = new Map(); // id -> post-launch API polling timer
let _tempSessions = []; // [{ pid, startedAt }] external Roblox sessions not tied to an added account
let _tempSig = '';      // signature (sorted pid list) of the last-known temp session set

const _logs = [];
const MAX_LOGS = 2000;
const LOG_CATS = { launch: 'launch', crash: 'crash', kill: 'kill', cookie: 'cookie', gen: 'gen', afk: 'afk', enc: 'enc', system: 'system', close: 'close' };

function logEntry(level, category, message, meta) {
  const entry = { ts: Date.now(), level, category, message, meta: meta || {} };
  _logs.push(entry);
  if (_logs.length > MAX_LOGS) _logs.shift(); // keep the most-recent tail
  if (document.getElementById('page-logs')?.classList.contains('active')) renderLogs();
}

function _logLine(e) {
  const t = new Date(e.ts);
  const ts = t.toLocaleTimeString('en-GB', { hour12:false }) + '.' + String(t.getMilliseconds()).padStart(3,'0');
  const cat = String(e.category || '').toUpperCase().padEnd(7);
  const keys = Object.keys(e.meta || {}).filter(k => e.meta[k] !== null && e.meta[k] !== undefined);
  const meta = keys.length ? '  ' + keys.map(k => `${k}=${e.meta[k]}`).join(' ') : '';
  const line = `<span class="lg-ts">${esc(ts)}</span>  <span class="lg-${esc(e.level)}">${esc(cat)}</span> ${esc(e.message + meta)}`;
  return settings.streamerMode
    ? `<span class="streamer-mask streamer-log-line" title="Hover to reveal">${line}</span>`
    : line;
}

function renderLogs() {
  const el = document.getElementById('logs-list');
  if (!el) return;
  if (!_logs.length) { el.textContent = 'No log entries yet.'; return; }
  // Tail behaviour: only auto-scroll to the newest line if already near the end.
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = _logs.map(_logLine).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// Native-style find (Ctrl+F) over the rendered log text. Uses window.find so
// selection, scroll-to-match and Ctrl+A/Ctrl+C all behave like a normal viewer.
function openLogFind() {
  const bar = document.getElementById('log-find');
  const inp = document.getElementById('log-find-input');
  if (!bar || !inp) return;
  bar.style.display = 'flex';
  inp.focus(); inp.select();
}
function closeLogFind() {
  const bar = document.getElementById('log-find');
  if (bar) bar.style.display = 'none';
  const sel = window.getSelection && window.getSelection();
  if (sel) sel.removeAllRanges();
  const c = document.getElementById('log-find-count');
  if (c) c.textContent = '';
}
function logFind(backwards) {
  const inp = document.getElementById('log-find-input');
  const c = document.getElementById('log-find-count');
  if (!inp) return;
  const q = inp.value;
  if (!q) { if (c) c.textContent = ''; return; }
  const found = window.find(q, false, !!backwards, true, false, false, false);
  if (c) c.textContent = found ? '' : 'No matches';
}
const _avatarCache = {};
let settings = {};

function streamerMaskClass() {
  return settings.streamerMode ? ' streamer-mask' : '';
}

function setStreamerText(id, value) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  el.textContent = value == null ? '' : String(value);
  el.classList.toggle('streamer-mask', !!settings.streamerMode);
  el.title = settings.streamerMode ? 'Hover to reveal' : '';
}

function toggleStreamerMode() {
  const input = document.getElementById('setting-streamer-mode');
  const enabled = !!(input && input.checked);
  settings.streamerMode = enabled;
  document.body.classList.toggle('streamer-mode', enabled);
  api.saveSettings({ streamerMode: enabled });
  render();
  toast(enabled ? 'Streamer Mode enabled' : 'Streamer Mode disabled', 'ok');
}

const ENC_OPTIONS = {
  'aes-256-gcm': { label: 'AES-256-GCM', badge: 'Best', badgeClass: 'green' },
  'aes-256-cbc': { label: 'AES-256-CBC', badge: 'Standard', badgeClass: 'muted' },
};
let selectedEnc = 'aes-256-gcm';

let _encMode = null;
function showEncModal(mode) {
  _encMode = mode;
  const title = document.getElementById('enc-title');
  const desc = document.getElementById('enc-desc');
  const action = document.getElementById('enc-action');
  const skip = document.getElementById('enc-skip');
  const err = document.getElementById('enc-err');
  const inp = document.getElementById('enc-input');
  if (err) err.style.display = 'none';
  if (inp) inp.value = '';
  if (action) action.disabled = false;
  if (mode === 'setup') {
    title.textContent = 'Create an encryption key';
    desc.textContent = 'Set an encryption key to protect your saved accounts. You will be asked for it every time you open the app.';
    action.textContent = 'Set key';
    if (skip) if (skip) skip.style.display = 'none';
  } else {
    title.textContent = 'Enter your encryption key';
    desc.textContent = 'Enter the key you set to unlock your saved accounts.';
    action.textContent = 'Unlock';
    if (skip) skip.style.display = 'none';
  }
  openModal('m-enc');
  setTimeout(() => inp && inp.focus(), 60);
}
function _encErr(m) { const e = document.getElementById('enc-err'); if (e) { e.textContent = m; e.style.display = 'block'; } }
async function submitEnc() {
  const inp = document.getElementById('enc-input');
  const action = document.getElementById('enc-action');
  const val = inp ? inp.value : '';
  if (action) action.disabled = true;
  try {
    if (_encMode === 'setup') {
      if (!val) { _encErr('Please enter an encryption key.'); action.disabled = false; return; }
      const r = await api.encSetKey(val);
      if (!r || !r.ok) { _encErr('Could not set encryption key. Please try again.'); action.disabled = false; return; }
    } else {
      if (!val) { _encErr('Please enter your encryption key.'); action.disabled = false; return; }
      const r = await api.encUnlock(val);
      if (!r || !r.ok) { _encErr('Wrong key. Please try again.'); logEntry('warn', 'enc', 'Failed encryption unlock attempt (wrong key)'); action.disabled = false; inp.value = ''; inp.focus(); return; }
      logEntry('ok', 'enc', 'Encryption key accepted - accounts unlocked');
    }
    closeModal('m-enc');
    await continueInit();
  } catch (e) { _encErr('Something went wrong. Please try again.'); if (action) action.disabled = false; }
}
async function skipEnc() {
  const skip = document.getElementById('enc-skip');
  if (skip) skip.disabled = true;
  try { await api.encSetKey(''); } catch {}
  closeModal('m-enc');
  await continueInit();
}

// Apple-style boot loader: fade it out once the UI is ready (or when the
// encryption prompt takes over). Safety timeout guarantees it never sticks.
function hideBoot() {
  const b = document.getElementById('boot-loader');
  if (b) { b.classList.add('hide'); setTimeout(() => { try { b.remove(); } catch {} }, 450); }
}
setTimeout(hideBoot, 3500);

async function init() {
  try {
    const st = await api.encStatus();
    if (st && st.mode === 'locked') { hideBoot(); showEncModal('locked'); return; }
    if (st && st.mode === 'setup') { hideBoot(); showEncModal('setup'); return; }
  } catch {}
  await continueInit();
}

async function continueInit() {
  try { initTheme(); } catch {}
  try {
    const [accRes, setRes, pkgRes] = await Promise.allSettled([
      api.loadAccounts(),
      api.loadSettings(),
      api.loadPackages()
    ]);
    accounts = (accRes.status === 'fulfilled' && Array.isArray(accRes.value)) ? accRes.value : [];
    settings = (setRes.status === 'fulfilled' && setRes.value) ? setRes.value : {};
    packages = (pkgRes.status === 'fulfilled' && Array.isArray(pkgRes.value)) ? pkgRes.value : [];
    await syncFpsControls();

    logEntry('info', 'system', `Loaded ${accounts.length} account${accounts.length === 1 ? '' : 's'} from storage`);
    try { recheckAllCookies(true); } catch {}
    try { render(); } catch {}
    try {
      const vtGrid = document.getElementById('vt-grid');
      if (vtGrid) vtGrid.classList.toggle('active', _acctView === 'grid');
      const vtList = document.getElementById('vt-list');
      if (vtList) vtList.classList.toggle('active', _acctView === 'list');
      document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === _acctFilter));
      const filterBtn = document.getElementById('filter-btn');
      if (filterBtn) filterBtn.classList.toggle('on', _acctFilter !== 'all');
    } catch {}
    try { renderPackages(); } catch {}
    try { applySettings(); if (settings.streamerMode) render(); } catch {}
    try { initTheme(); } catch {} // re-sync controls now that DOM is ready
  } catch (e) {
    console.error('Error during continueInit:', e);
  } finally {
    hideBoot();
  }

  try { refreshMultiStatus(); } catch {}
  try { maybeAutoTutorial(); } catch {}
  try { detectRobloxVersion(); } catch {}
  try { startRunningPoll(); } catch {}
  try { refreshPresence(true); } catch {}
  setInterval(() => { try { refreshPresence(true); } catch {} }, 15000);
  try { loadWeaoForLaunch(); } catch {}
  logEntry('info', 'system', 'rbxSWAP started', { version: 'v1', accounts: accounts.length, platform: navigator.platform });
  try { const afkStat = await api.antiAfkStatus(); if (afkStat && afkStat.enabled) logEntry('info', 'afk', `Anti-AFK is enabled on startup (active: ${afkStat.active})`, { enabled: afkStat.enabled, active: afkStat.active }); } catch {}

  if (window.api && typeof api.onLogEntry === 'function') {
    api.onLogEntry(data => logEntry(data.level, data.category, data.message, data.meta));
  }
  if (window.api && typeof api.onRobloxCount === 'function') {
    api.onRobloxCount(n => { _lastCountPushAt = Date.now(); _mixRunning = n; });
  }

  // External Roblox sessions (browser protocol launches, Roblox started outside
  // the app) are pushed by main whenever it polls while accounts are watched.
  if (window.api && typeof api.onTempSessions === 'function') {
    api.onTempSessions(list => { applyTempSessions(list); loadTempAvatars(); });
  }

  if (typeof api.onLaunchVerifyFail === 'function') {
    api.onLaunchVerifyFail((data) => {
      if (!data || !data.accountId || data.reason !== 'quick-crash') return;
      toast('Roblox closed right after launch — check the account cookie (re-login if expired) and that the installed version is complete (RDD tab).', 'err');
      logEntry('err', 'launch', `Roblox exited immediately after launch${data.username ? ' for ' + data.username : ''} — check the account cookie and that the installed version is complete.`, data);
    });
  }

  api.onRobloxClosed(id => {
    _presenceGeneration++;
    _launchedIds.delete(id);
    delete _everLaunchedAt[id];
    delete _presenceResolved[id];
    delete _presenceUnavailable[id];
    delete _presence[id];
    const presenceTimer = _presencePollTimers.get(id);
    if (presenceTimer) clearTimeout(presenceTimer);
    _presencePollTimers.delete(id);
    const closedAcct = accounts.find(a => a.id === id);
    logEntry('info', 'close', `Roblox closed for ${closedAcct ? closedAcct.username : id}`, { accountId: id, username: closedAcct?.username || null, userId: closedAcct?.userId || null });
    if (document.getElementById('page-accounts')?.classList.contains('active')) render();
    else {
      const card = document.querySelector(`.card[data-id="${id}"]`);
      if (card) card.classList.remove('is-live');
      const dot = document.querySelector(`.card[data-id="${id}"] .card-dot`);
      if (dot) { dot.classList.remove('launched'); dot.title = 'Not launched'; }
      applyPresence();
    }
    refreshPkgAvatarStatus();
    pollRunningCount();
  });

  api.onAllRobloxClosed(() => {
    logEntry('warn', 'close', 'All Roblox instances closed');
    _presenceGeneration++;
    _launchedIds.clear();
    _tempSessions = [];
    _tempSig = '';
    Object.keys(_presenceResolved).forEach(id => delete _presenceResolved[id]);
    Object.keys(_presenceUnavailable).forEach(id => delete _presenceUnavailable[id]);
    Object.keys(_presence).forEach(id => delete _presence[id]);
    for (const timer of _presencePollTimers.values()) clearTimeout(timer);
    _presencePollTimers.clear();
    if (document.getElementById('page-accounts')?.classList.contains('active')) render();
    else {
      document.querySelectorAll('.card.is-live').forEach(c => c.classList.remove('is-live'));
      document.querySelectorAll('.card-dot.launched').forEach(d => { d.classList.remove('launched'); d.title = 'Not launched'; });
    }
    refreshPkgAvatarStatus();
    pollRunningCount();
    if (document.getElementById('page-mixer')?.classList.contains('active')) mixRefreshRunning();
  });

  // Chrome download progress
  api.onChromeProgress(data => {
    const dlDiv = document.getElementById('login-dl');
    const waitDiv = document.getElementById('login-waiting');
    if (!dlDiv || !waitDiv) return;
    if (data.status === 'downloading') {
      dlDiv.style.display = '';
      waitDiv.style.display = 'none';
      if (data.percent !== undefined) {
        document.getElementById('dl-bar').style.width = data.percent + '%';
        document.getElementById('dl-pct').textContent = data.percent + '%';
      }
    } else if (data.status === 'done') {
      dlDiv.style.display = 'none';
      waitDiv.style.display = '';
    }
  });
}
init();

(function () {
  const p = (window.api && api.platform) || 'win32';
  const cls = p === 'win32' ? 'platform-win' : p === 'darwin' ? 'platform-mac' : 'platform-other';
  document.body.classList.add(cls);
  const osName = p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : 'Linux';
  const osEl = document.getElementById('platform-note-os');
  if (osEl) osEl.textContent = osName;
  // Safety net: if the app ever opens on a now-hidden Windows-only tab, fall back.
  if (p !== 'win32') {
    const active = document.querySelector('.page.active');
    if (active && active.classList.contains('win-only')) { try { goTo('accounts'); } catch {} }
  }
})();

// Legacy ui-theme system removed — superseded by the Appearance & Themes
// engine (initTheme/applyTheme) at the bottom of this file. initTheme() is
// called at the start of continueInit() before any page renders.


async function detectRobloxVersion() {
  try {
    const ver = await api.getRobloxVersion();
    if (ver) {
      // Show the full hash in the titlebar badge.
      document.getElementById('tb-roblox-ver').textContent = ver;
    } else {
      document.getElementById('tb-roblox-ver').textContent = '-';
    }
  } catch {
    document.getElementById('tb-roblox-ver').textContent = '-';
  }
}

function applySettings() {
  if (settings.encryptionType) {
    selectedEnc = settings.encryptionType;
    updateCddDisplay('enc', selectedEnc);
    document.querySelectorAll('#cdd-enc-menu .cdd-option').forEach(o =>
      o.classList.toggle('selected', o.dataset.value === selectedEnc));
  }
  const keyIn = document.getElementById('custom-key');
  if (keyIn) { keyIn.value = ''; keyIn.placeholder = settings.keySet ? 'Key is set, type to update it' : 'e.g. SecureKey1234@A#'; }
  const afk = document.getElementById('set-antiafk');
  if (afk) afk.checked = !!settings.antiAfk;
  const afkSb = document.getElementById('sb-antiafk');
  if (afkSb) afkSb.checked = !!settings.antiAfk;
  const streamer = document.getElementById('setting-streamer-mode');
  if (streamer) streamer.checked = !!settings.streamerMode;
  document.body.classList.toggle('streamer-mode', !!settings.streamerMode);
}

let _acctQuery = '', _acctFilter = (() => { try { const f = localStorage.getItem('mr-acct-filter'); return (f && f !== 'running' && f !== 'idle') ? f : 'all'; } catch { return 'all'; } })(), _acctView = (() => { try { return localStorage.getItem('mr-acct-view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
function visibleAccounts() {
  let list = [...accounts];
  if (_acctQuery) {
    const q = _acctQuery;
    list = list.filter(a => (a.nickname || a.username || '').toLowerCase().includes(q) || String(a.userId || '').includes(q));
  }
  if (_acctFilter === 'running') list = list.filter(a => _launchedIds.has(a.id));
  else if (_acctFilter === 'idle') list = list.filter(a => !_launchedIds.has(a.id));
  else if (_acctFilter === 'valid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 1 : 0;
    return s(a.id) - s(b.id);
  });
  else if (_acctFilter === 'invalid-first') list.sort((a, b) => {
    const s = id => _cookieStatus[id] === 'dead' ? 0 : 1;
    return s(a.id) - s(b.id);
  });
  return list;
}
let _searchTimer;
function onAcctSearch(v) {
  _acctQuery = (v || '').trim().toLowerCase();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(render, 120); // debounce so a long list isn't rebuilt on every keystroke
}
function toggleFilterMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('filter-menu');
  const btn = document.getElementById('filter-btn');
  const open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  if (btn) btn.setAttribute('aria-expanded', String(open));
}
function setAcctFilter(f) {
  _acctFilter = f;
  try { localStorage.setItem('mr-acct-filter', (f === 'running' || f === 'idle') ? 'all' : f); } catch {}
  document.querySelectorAll('#filter-menu button').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  document.getElementById('filter-menu').classList.remove('open');
  const filterBtn = document.getElementById('filter-btn');
  if (filterBtn) { filterBtn.classList.toggle('on', f !== 'all'); filterBtn.setAttribute('aria-expanded', 'false'); }
  render();
}
function setAcctView(v) {
  _acctView = v;
  try { localStorage.setItem('mr-acct-view', v); } catch {}
  document.getElementById('vt-grid').classList.toggle('active', v === 'grid');
  document.getElementById('vt-list').classList.toggle('active', v === 'list');
  render();
}
document.addEventListener('click', e => {
  const fm = document.getElementById('filter-menu');
  if (fm && fm.classList.contains('open') && !e.target.closest('.filter-wrap')) {
    fm.classList.remove('open');
    document.getElementById('filter-btn')?.setAttribute('aria-expanded', 'false');
  }
});

function toggleAntiAfk(src) {
  const el = document.getElementById(src === 'sb' ? 'sb-antiafk' : 'set-antiafk');
  const on = el.checked;
  settings.antiAfk = on;
  api.saveSettings({ antiAfk: on });
  const a = document.getElementById('set-antiafk'); if (a) a.checked = on;
  const b = document.getElementById('sb-antiafk'); if (b) b.checked = on;
  toast(on ? 'Anti-AFK on, accounts stay connected' : 'Anti-AFK off', on ? 'ok' : 'err');
}

function toggleCdd(name) {
  const trigger = document.getElementById('cdd-' + name + '-trigger');
  const menu = document.getElementById('cdd-' + name + '-menu');
  const open = menu.classList.contains('open');
  closeAllCdd();
  if (!open) { trigger.classList.add('open'); menu.classList.add('open'); }
}
function closeAllCdd() {
  document.querySelectorAll('.cdd-trigger.open').forEach(t => t.classList.remove('open'));
  document.querySelectorAll('.cdd-menu.open').forEach(m => m.classList.remove('open'));
}
function selectCdd(name, value) {
  selectedEnc = value;
  document.querySelectorAll('#cdd-' + name + '-menu .cdd-option').forEach(o =>
    o.classList.toggle('selected', o.dataset.value === value));
  updateCddDisplay(name, value);
  closeAllCdd();
}
function updateCddDisplay(name, value) {
  const meta = ENC_OPTIONS[value] || { label: value, badge: '', badgeClass: '' };
  const lbl = document.getElementById('cdd-' + name + '-label');
  const bdg = document.getElementById('cdd-' + name + '-badge');
  if (lbl) lbl.textContent = meta.label;
  if (bdg) { bdg.textContent = meta.badge; bdg.className = 'cdd-badge' + (meta.badgeClass ? ' ' + meta.badgeClass : ''); }
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cdd')) closeAllCdd();
  if (e.target.classList.contains('overlay') && e.target.getAttribute('data-backdrop-close') === 'true') {
    closeModal(e.target.id);
  }
});

function settingsTab(tab) {
  if (tab === 'sounds') typeof soundRenderPage === 'function' && soundRenderPage();
}

function goTo(p) {
  if (p === 'sounds' || p === 'themes') { goTo('settings'); return; }
  const pageEl = document.getElementById('page-' + p);
  const navEl = document.getElementById('nav-' + p);
  if (!pageEl || !navEl) return;
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  pageEl.classList.add('active');
  navEl.classList.add('active');
  if (p === 'settings') {
    refreshMultiStatus();
    refreshProtocolStatus();
    const bloxgenInput = document.getElementById('setting-bloxgen-api-key');
    if (bloxgenInput) bloxgenInput.value = localStorage.getItem('rblx_bloxgen_api_key') || '';
    if (typeof window.renderExecutorSettings === 'function') window.renderExecutorSettings();
  }
  if (p === 'executor') {
    if (typeof window.renderExecutorSettings === 'function') window.renderExecutorSettings();
    if (typeof window.executorsInit === 'function') window.executorsInit();
  }
  if (p === 'accounts') { refreshPresence(true); render(); }
  if (p === 'charts' && !chartsLoaded) loadCharts();
  if (p === 'packages') renderPackages();
  if (p === 'mixer') mixInit();
  if (p === 'swap') swapInit();
  if (p === 'rdd') rddInit();
}

function markLaunched(id) {
  _presenceGeneration++;
  _launchedIds.add(id);
  _everLaunchedAt[id] = Date.now();
  _presenceResolved[id] = false;
  delete _presenceUnavailable[id];
  delete _presence[id];
  render();
  refreshPkgAvatarStatus();
  watchPresenceAfterLaunch(id);
}

function watchPresenceAfterLaunch(id) {
  const oldTimer = _presencePollTimers.get(id);
  if (oldTimer) clearTimeout(oldTimer);
  const deadline = Date.now() + 60_000;
  const poll = async () => {
    if (!_launchedIds.has(id)) return;
    await refreshPresence(true);
    if (Date.now() >= deadline) {
      // No response is not the same thing as Offline. Keep the last confirmed
      // API state if one exists; otherwise show an explicit unavailable state.
      if (!_presence[id]) _presenceUnavailable[id] = true;
      _presenceResolved[id] = true;
    }
    if (_presenceResolved[id] === true) {
      _presencePollTimers.delete(id);
      applyPresence();
      return;
    }
    const timer = setTimeout(poll, 2500);
    _presencePollTimers.set(id, timer);
  };
  poll();
}

async function killOne(id) {
  const a = accounts.find(x => x.id === id);
  logEntry('warn', 'kill', `Killing Roblox instance for ${a ? a.username : id}...`, { accountId: id, username: a?.username, userId: a?.userId });
  _launchedIds.delete(id);
  delete _presence[id];
  delete _presenceResolved[id];
  applyPresence();
  const res = await api.killOneRoblox(id);
  if (!res || !res.ok) toast(res?.error || 'Could not kill that instance', 'err');
  else logEntry('ok', 'kill', `Killed instance for ${a ? a.username : id}`, { accountId: id });
}

let _ctxMenuId = null;
function showCardMenu(id, x, y) {
  closeCardMenu();
  _ctxMenuId = id;
  const a = accounts.find(x => x.id === id);
  const isLive = _launchedIds.has(id) || (a && (presenceClass(a) === 'ingame' || presenceClass(a) === 'menu' || presenceClass(a) === 'online' || presenceClass(a) === 'studio'));
  const menu = document.createElement('div');
  menu.id = 'card-ctx-menu';
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-header${settings.streamerMode ? ' streamer-mask' : ''}" title="${settings.streamerMode ? 'Hover to reveal' : ''}">${esc(a ? (a.nickname || a.username || 'Unknown') : id)}</div>
    <button class="ctx-item" onclick="openAccountInfoModal('${id}')"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>Account info</button>
    ${isLive ? `<button class="ctx-item ctx-danger" onclick="ctxKill('${id}')"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>Kill instance</button>` : ''}
    <button class="ctx-item" onclick="ctxLaunch('${id}')"><svg class="launch-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polygon points="10,8 16,12 10,16 10,8" fill="currentColor" stroke="none"/></svg>${isLive ? 'Relaunch' : 'Launch'}</button>
    <button class="ctx-item" onclick="ctxLaunchGame('${id}')"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><path d="M6 8h12a4 4 0 0 1 3.86 5l-1.5 6A2 2 0 0 1 18.42 20H17a2 2 0 0 1-1.79-1.11L14.5 17h-5l-.71 1.89A2 2 0 0 1 7 20H5.58a2 2 0 0 1-1.94-1.52l-1.5-6A4 4 0 0 1 6 8Z"/></svg>Launch Game</button>
    <button class="ctx-item" onclick="ctxEdit('${id}')"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>Edit account</button>
    <div class="ctx-sep"></div>
    <button class="ctx-item" onclick="ctxCopyId('${id}')"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>Copy user ID</button>
    <button class="ctx-item" onclick="ctxCopyUser('${id}')"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Copy username</button>
  `;
  document.body.appendChild(menu);
  // Position: keep on screen
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 200) + 'px';
  menu.style.top = Math.min(y, vh - menu.offsetHeight - 10) + 'px';
  setTimeout(() => document.addEventListener('click', closeCardMenu, { once: true }), 0);
}
function closeCardMenu() { const m = document.getElementById('card-ctx-menu'); if (m) m.remove(); _ctxMenuId = null; }
async function ctxKill(id) { closeCardMenu(); await killOne(id); }
function ctxLaunch(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a) openLaunch(a.id); }
// "Launch Game" — pick a game in a modal, cache the pick globally (shared by
// every account until changed) and launch this account into it immediately.
function ctxLaunchGame(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a) { launchAcc = a; openGamePicker(); } }
function ctxEdit(id) { closeCardMenu(); openEdit(id); }
function ctxCopyId(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.userId) navigator.clipboard.writeText(a.userId).then(() => toast('User ID copied', 'ok')); else toast('No user ID', 'err'); }
function ctxCopyUser(id) { closeCardMenu(); const a = accounts.find(x => x.id === id); if (a?.username) navigator.clipboard.writeText(a.username).then(() => toast('Username copied', 'ok')); else toast('No username', 'err'); }

function refreshPkgAvatarStatus() {
  document.querySelectorAll('.pkg-avatar[data-acc-id]').forEach(av => {
    const accId = av.dataset.accId;
    const a = accounts.find(x => x.id === accId);
    if (!a) return;
    const state = presenceClass(a);
    av.classList.remove('presence-starting', 'presence-ingame', 'presence-online', 'presence-menu', 'presence-studio', 'presence-offline', 'presence-unknown', 'online');
    av.classList.add('presence-' + state);
  });
}

let _accountRamStats = {};
function ramUsageMb(stat) {
  const value = stat && typeof stat === 'object' ? stat.usageMb : stat;
  const mb = Number(value);
  return Number.isFinite(mb) ? Math.max(0, Math.round(mb)) : 0;
}
function ramStatText(stat) {
  const usage = ramUsageMb(stat);
  const limit = stat && typeof stat === 'object' && Number.isInteger(stat.limitMb) ? stat.limitMb : null;
  return limit ? usage + ' / ' + limit + ' MB' : usage + ' MB';
}
function ramStatTitle(stat) {
  const limit = stat && typeof stat === 'object' && Number.isInteger(stat.limitMb) ? stat.limitMb : null;
  return limit
    ? 'Live working-set usage / configured cap: ' + ramStatText(stat)
    : 'Live Roblox working-set usage';
}
if (window.api && typeof api.onRamStats === 'function') {
  api.onRamStats((stats) => {
    _accountRamStats = stats || {};
    Object.entries(_accountRamStats).forEach(([id, ramStat]) => {
      const badge = document.getElementById('ram-badge-' + id);
      if (badge) {
        const value = badge.querySelector('span');
        if (value) value.textContent = ramStatText(ramStat);
        badge.title = ramStatTitle(ramStat);
      }
    });
  });
}

function render() {
  const grid = document.getElementById('grid'), empty = document.getElementById('empty'), sub = document.getElementById('acct-sub');
  const tempCount = _tempSessions.length;
  if (accounts.length) {
    sub.textContent = accounts.length + ' account' + (accounts.length !== 1 ? 's' : '') + ' saved'
      + (tempCount ? ' · ' + tempCount + ' temp session' + (tempCount !== 1 ? 's' : '') : '');
  } else {
    sub.textContent = tempCount
      ? tempCount + ' temp session' + (tempCount !== 1 ? 's' : '') + ' running'
      : 'No accounts saved';
  }
  const list = visibleAccounts();
  const temps = visibleTempSessions();
  grid.classList.toggle('list-view', _acctView === 'list');
  if (!list.length && !temps.length) {
    if (!accounts.length && !tempCount) { grid.innerHTML = ''; empty.style.display = 'flex'; return; }
    empty.style.display = 'none';
    grid.classList.remove('list-view');
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12.5px;padding:40px 0">No accounts match your search or filter.</div>';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = list.map((a, i) => `
    <div class="card presence-${presenceClass(a)}${presenceOnline(a) ? ' is-live' : ''}${_cookieStatus[a.id] === 'dead' ? ' cookie-dead' : ''}" data-id="${a.id}">
      <div class="card-dot${_launchedIds.has(a.id) ? ' launched' : ''}" title="${_launchedIds.has(a.id) ? 'Launched' : 'Not launched'}"></div>
      <svg class="drag-handle" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
      <div class="card-av presence-${presenceClass(a)}" id="av-${a.id}" title="${presenceClass(a) === 'starting' ? 'Checking Roblox presence…' : 'Roblox presence: ' + presenceClass(a)}">${(a.username || '?')[0].toUpperCase()}</div>
      <div class="card-id">
        <div class="card-name-row" style="display:flex;align-items:center;justify-content:space-between;gap:6px">
          <div class="card-name${streamerMaskClass()}" title="${settings.streamerMode ? 'Hover to reveal' : esc(a.nickname || a.username || 'Unknown')}">${esc(a.nickname || a.username || 'Unknown')}</div>
          ${_launchedIds.has(a.id) && ramUsageMb(_accountRamStats[a.id]) > 0 ? `<span class="badge ram-badge" id="ram-badge-${a.id}" title="${ramStatTitle(_accountRamStats[a.id])}"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10v6H7z"/><path d="M7 3v2M11 3v2M15 3v2M19 3v2M7 19v2M11 19v2M15 19v2M19 19v2"/></svg><span>${ramStatText(_accountRamStats[a.id])}</span></span>` : ''}
          <span class="card-expired" title="This account's cookie is expired. It refreshes automatically while a Roblox session is running; otherwise re-add the account."><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Expired</span>
        </div>
        <div class="card-uid${streamerMaskClass()}" title="${settings.streamerMode ? 'Hover to reveal' : esc(a.userId ? 'ID ' + a.userId : 'No ID')}">${a.userId ? 'ID ' + a.userId : 'No ID'}</div>
      </div>
      <div class="card-game ${a.gameTarget ? 'visible' : ''}" id="gt-${a.id}" title="${esc(a.gameTarget || '')}">
        ${a.gameTarget ? esc(truncate(_gameNameCache[a.id] || extractTargetLabel(a.gameTarget), 22)) : ''}
      </div>
      <div class="card-row">
        <button class="btn btn-launch" onclick="openLaunch('${a.id}')">
          Start
        </button>
        <button class="btn btn-edit" onclick="openAccountInfoModal('${a.id}')" title="Account info">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        </button>
        <button class="btn btn-edit" onclick="openEdit('${a.id}')" title="Edit">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
        <button class="btn btn-del" onclick="removeAcc('${a.id}')" title="Remove">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
        </button>
      </div>
    </div>`).join('') + temps.map(tempCardHtml).join('') + `<div class="card-add" role="button" tabindex="0" onclick="openLogin()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openLogin()}"><svg class="card-add-icon" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span class="card-add-label">Add account</span></div>`;
  loadAvatarsBatch(list);
  loadTempAvatars();
  list.forEach(a => { if (a.gameTarget && !_gameNameCache[a.id]) fetchGameName(a.id, a.gameTarget); });
  checkCookieHealth(list);
  refreshPresence(false);
  // Bind right-click context menus to cards (temp/external session cards have
  // their own Kill button and no account actions, so they are skipped).
  document.querySelectorAll('.card[data-id]:not([data-temp])').forEach(card => {
    card.addEventListener('contextmenu', e => { e.preventDefault(); showCardMenu(card.dataset.id, e.clientX, e.clientY); });
  });
  initDrag();
}

function visibleTempSessions() {
  if (_acctFilter === 'idle') return [];
  const q = _acctQuery;
  if (q && !_tempSessions.some(t =>
    (t.username || '').toLowerCase().includes(q) ||
    String(t.userId || '').includes(q) ||
    String(t.pid).includes(q))) return [];
  return _tempSessions;
}

function tempCardHtml(t) {
  const id = 'temp-' + t.pid;
  const tempAcc = { id, userId: t.userId };
  const state = presenceClass(tempAcc);
  const name = t.username || 'External session';
  const sub = t.userId
    ? 'ID ' + t.userId
    : 'PID ' + t.pid + (t.startedAt ? ' · started ' + new Date(t.startedAt).toLocaleTimeString('en-GB', { hour12: false }) : '');
  const cachedAvatar = t.userId ? _avatarCache[t.userId] : null;
  const avatarInner = cachedAvatar
    ? '<img src="' + esc(cachedAvatar) + '" alt=""/>'
    : (t.userId
        ? (t.username || '?')[0].toUpperCase()
        : '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>');
  return `
    <div class="card temp-card presence-${state}${presenceOnline(tempAcc) ? ' is-live' : ''}" data-id="${id}" data-temp="1" title="Roblox session launched outside rbxSWAP (PID ${t.pid})">
      <div class="card-dot launched" title="Running (external session)"></div>
      <div class="card-av presence-${state}" id="av-${id}" title="Roblox presence: ${state}">${avatarInner}</div>
      <div class="card-id">
        <div class="card-name-row">
          <div class="card-name">${esc(name)}</div>
        </div>
        <div class="card-uid">${sub}</div>
      </div>
      <div class="card-row">
        <button class="btn btn-launch" style="flex:1" onclick="addTempSession(${t.pid})">Add</button>
        <button class="btn btn-danger" style="flex:1" onclick="killTempSession(${t.pid})">Kill</button>
      </div>
    </div>`;
}

async function addTempSession(pid) {
  logEntry('info', 'add', `Capturing external session (PID ${pid}) as a permanent account...`, { pid });
  const res = await api.addTempSession(pid);
  if (!res || !res.ok) {
    const msg = res?.error || 'Could not add this session';
    toast(msg, 'err');
    logEntry('err', 'add', msg, { pid });
    return;
  }
  const acc = res.account;
  const existing = accounts.find(x => String(x.userId) === String(acc.userId));
  if (existing) {
    existing.username = acc.username;
    existing.cookie = acc.cookie;
    await api.updateAccount(existing.id, { username: acc.username, cookie: acc.cookie });
  } else {
    accounts.push(acc);
  }
  // Main now claims this PID, so drop the temp card locally for instant feedback.
  _tempSessions = _tempSessions.filter(t => t.pid !== pid);
  _tempSig = _tempSessions.map(s => s.pid + ':' + (s.userId || '') + ':' + (s.username || '')).sort().join(',');
  render();
  refreshPresence(true);
  toast((existing ? 'Updated cookie for ' : 'Added ') + acc.username, 'ok');
  logEntry('ok', 'add', `${existing ? 'Updated cookie for' : 'Added'} ${acc.username} (external session captured)`, { accountId: acc.id, username: acc.username, userId: acc.userId });
}

async function killTempSession(pid) {
  logEntry('warn', 'kill', `Killing external Roblox session (PID ${pid})...`, { pid });
  const res = await api.killTemp(pid);
  if (!res || !res.ok) { toast(res?.error || 'Could not kill that instance', 'err'); return; }
  logEntry('ok', 'kill', `Killed external Roblox session (PID ${pid})`, { pid });
  // The card drops out once the next temp poll no longer sees the process.
  toast('Killed external session', 'ok');
}

function applyTempSessions(list) {
  const arr = Array.isArray(list) ? list : [];
  _tempSessions = arr;
  const sig = arr.map(s => s.pid + ':' + (s.userId || '') + ':' + (s.username || '')).sort().join(',');
  if (sig === _tempSig) return; // no set/identity change; skip re-render
  _tempSig = sig;
  // Drop presence state for sessions that ended so a reused PID can't inherit it.
  const liveIds = new Set(arr.map(s => 'temp-' + s.pid));
  for (const key of Object.keys(_presence)) if (key.startsWith('temp-') && !liveIds.has(key)) delete _presence[key];
  for (const key of Object.keys(_presenceUnavailable)) if (key.startsWith('temp-') && !liveIds.has(key)) delete _presenceUnavailable[key];
  if (document.getElementById('page-accounts')?.classList.contains('active')) {
    render();
    if (arr.some(t => t.userId)) refreshPresence(true); // ring color right away
  }
}

async function fetchTempSessions() {
  if (!window.api || typeof api.getTempSessions !== 'function') return;
  try { applyTempSessions(await api.getTempSessions()); } catch {}
  try { loadTempAvatars(); } catch {}
}

const _tempAvatarAttempts = {}; // pid -> epoch ms when the next attempt is allowed
async function loadTempAvatars() {
  const now = Date.now();
  const missing = _tempSessions.filter(t => t.userId && !_avatarCache[t.userId] && (!_tempAvatarAttempts[t.pid] || now >= _tempAvatarAttempts[t.pid]));
  if (!missing.length) return;
  for (const t of missing) {
    const uid = String(t.userId);
    try {
      if (_avatarCache[uid]) continue;
      const r = await fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png');
      const d = await r.json();
      const item = d && d.data && d.data[0];
      if (item && item.imageUrl) {
        _avatarCache[uid] = item.imageUrl;
        delete _tempAvatarAttempts[t.pid];
        const el = document.getElementById('av-temp-' + t.pid);
        if (el && !el.querySelector('img')) el.innerHTML = '<img src="' + esc(item.imageUrl) + '" alt=""/>';
      } else {
        // Pending/Error -> retry shortly after (mirrors the saved-account flow
        // which repaints on later renders; here the poll drives the retries).
        _tempAvatarAttempts[t.pid] = Date.now() + 4000;
      }
    } catch { _tempAvatarAttempts[t.pid] = Date.now() + 4000; }
  }
}

const _cookieStatus = {}; // id -> 'checking' | 'ok' | 'dead' | 'unknown' | 'refreshing'
function applyCookieStatus(id) {
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) card.classList.toggle('cookie-dead', _cookieStatus[id] === 'dead');
  // Keep destructive password actions disabled while the post-change or
  // recovery login is still obtaining a fresh cookie.
  if (_aiAccount && String(_aiAccount.id) === String(id)) {
    const btn = document.getElementById('ai-btn-change-password');
    if (btn && !_aiActionBusy?.has('ai-btn-change-password')) btn.disabled = _cookieStatus[id] === 'refreshing';
  }
  if (editAcc && String(editAcc.id) === String(id)) {
    const status = document.getElementById('edit-cookie-status');
    if (status) status.textContent = editCookieStatusText(editAcc);
    const btn = document.getElementById('edit-change-roblox-password');
    if (btn && !_aiActionBusy?.has('edit-change-roblox-password')) btn.disabled = _cookieStatus[id] === 'refreshing';
  }
}
let _cookieRefreshTriedAt = {}; // id -> last store-refresh attempt epoch ms
const COOKIE_REFRESH_RETRY_MS = 5 * 60 * 1000;
async function tryAutoRefreshCookie(a) {
  if (!a || !a.cookie) return false;
  const now = Date.now();
  if (_cookieRefreshTriedAt[a.id] && (now - _cookieRefreshTriedAt[a.id]) < COOKIE_REFRESH_RETRY_MS) return false;
  _cookieRefreshTriedAt[a.id] = now;
  return refreshAccountCookieForAction(a, { silent: true });
}
function _flagCookieMaybeDead(id, error) {
  if (id && error && /cookie|expired|\b403\b/i.test(error)) {
    // A post-password-change re-login is in flight — the dead cookie is expected,
    // so don't slap the expired badge on mid-refresh.
    if (_cookieStatus[id] === 'refreshing') return;
    _cookieStatus[id] = 'dead';
    applyCookieStatus(id);
  }
}
let _cookieCheckRunning = false;
async function checkCookieHealth(list) {
  if (_cookieCheckRunning) return;
  const todo = list.filter(a => a.cookie && _cookieStatus[a.id] === undefined);
  if (!todo.length) return;
  _cookieCheckRunning = true;
  try {
    for (const a of todo) {
      if (_cookieStatus[a.id] !== undefined) continue;
      _cookieStatus[a.id] = 'checking';
      try {
        const res = await api.validateCookie(a.cookie);
        if (res && res.ok) {
          _cookieStatus[a.id] = 'ok';
          logEntry('info', 'cookie', `Cookie valid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
        } else if (await tryAutoRefreshCookie(a)) {
          // refreshed from the live Roblox session store; status is now 'ok'
        } else {
          _cookieStatus[a.id] = 'dead';
          logEntry('warn', 'cookie', `Cookie invalid for ${a.username || a.id}`, { accountId: a.id, username: a.username || null, userId: a.userId || null });
        }
      } catch { _cookieStatus[a.id] = 'unknown'; logEntry('warn', 'cookie', `Cookie check failed for ${a.username || a.id}`, { accountId: a.id }); }
      applyCookieStatus(a.id);
      await new Promise(r => setTimeout(r, 200)); // stagger; avoid bursting the endpoint
    }
  } finally { _cookieCheckRunning = false; }
}

const _presence = {};          // id -> { type, lastLocation } | null
const _presenceUnavailable = {}; // id -> true when Roblox did not return usable data
let _presenceGeneration = 0;
let _presenceRunning = false;
let _lastPresenceAt = 0;
const PRESENCE_TTL = 15_000;

function presenceOnline(a) {
  const p = _presence[a.id];
  // Only count as live (green border) if in-game
  return !!(p && p.type === 2);
}
function presenceClass(a) {
  if (_launchedIds.has(a.id) && _presenceResolved[a.id] !== true) return 'starting';
  const p = _presence[a.id];
  if (p && p.type === 2) return 'ingame';   // In Game -> green
  if (p && p.type === 3) return 'studio';   // In Studio -> blue
  if (p && p.type === 1) return 'menu';     // On Website/Menu -> blue
  if (_launchedIds.has(a.id)) return 'menu'; // Launched app (in Main Menu/Homepage) -> blue
  if (!p || p.type === -1 || _presenceUnavailable[a.id]) return 'unknown';
  return 'offline';
}

async function refreshPresence(force) {
  if (_presenceRunning) return;
  const now = Date.now();
  if (!force && now - _lastPresenceAt < PRESENCE_TTL) return;
  const list = accounts.filter(a => a.userId);
  // Temp sessions expose a userId too, so their cards get the same live ring.
  const tempList = _tempSessions.filter(t => t.userId).map(t => ({ id: 'temp-' + t.pid, userId: t.userId }));
  if (!list.length && !tempList.length) return;
  _presenceRunning = true;
  _lastPresenceAt = now;
  const requestStartedAt = now;
  const requestGeneration = _presenceGeneration;
  try {
    const res = await api.getPresence([...list.map(a => Number(a.userId)), ...tempList.map(t => Number(t.userId))]);
    if (requestGeneration !== _presenceGeneration) return;
    if (res && res.ok && Array.isArray(res.data)) {
      const byUser = new Map(res.data.map(p => [String(p.userId), p]));
      for (const a of list) {
        // A request that began before launch can return Roblox's old state after
        // the process starts. Never let that stale response clear the loader.
        if (_launchedIds.has(a.id) && _everLaunchedAt[a.id] > requestStartedAt) continue;
        const p = byUser.get(String(a.userId));
        let type = -1;
        let lastLoc = '';
        if (p) {
          type = Number.isFinite(Number(p.userPresenceType)) ? Number(p.userPresenceType) : -1;
          lastLoc = p.lastLocation || '';
          const locLower = lastLoc.trim().toLowerCase();
          // Fallback only for game/studio if Roblox returns 0 but gives a placeId
          if (type <= 0) {
            if (p.placeId || p.gameId || p.rootPlaceId) {
              type = 2; // InGame
            } else if (locLower.includes('studio')) {
              type = 3; // Studio
            }
          }
        }
        const nextPresence = { type, lastLocation: lastLoc };
        _presence[a.id] = nextPresence;
        _presenceUnavailable[a.id] = nextPresence.type === -1;
        const waitingForLaunchPresence = _launchedIds.has(a.id) && _presenceResolved[a.id] !== true;
        const responseStartedAfterLaunch = requestStartedAt >= (_everLaunchedAt[a.id] || 0);
        const msSinceLaunch = now - (_everLaunchedAt[a.id] || 0);
        if (!waitingForLaunchPresence || (msSinceLaunch > 2000 && (nextPresence.type > 0 || (nextPresence.type === 0 && responseStartedAfterLaunch)))) _presenceResolved[a.id] = true;
      }
      for (const t of tempList) {
        const p = byUser.get(String(t.userId));
        let type = -1, lastLoc = '';
        if (p) {
          type = Number.isFinite(Number(p.userPresenceType)) ? Number(p.userPresenceType) : -1;
          lastLoc = p.lastLocation || '';
          if (type <= 0) {
            if (p.placeId || p.gameId || p.rootPlaceId) type = 2;
            else if (lastLoc.trim().toLowerCase().includes('studio')) type = 3;
          }
        }
        _presence[t.id] = { type, lastLocation: lastLoc };
        _presenceUnavailable[t.id] = type === -1;
      }
      applyPresence();
    }
  } catch {} finally { _presenceRunning = false; }
}

function applyPresence() {
  for (const a of accounts) {
    const state = presenceClass(a);
    const card = document.querySelector('.card[data-id="' + a.id + '"]');
    if (!card) continue;
    card.classList.remove('presence-starting', 'presence-ingame', 'presence-online', 'presence-menu', 'presence-studio', 'presence-offline', 'presence-unknown');
    card.classList.add('presence-' + state);
    card.classList.toggle('is-live', presenceOnline(a));
    const avatar = document.getElementById('av-' + a.id);
    if (avatar) {
      avatar.classList.remove('presence-starting', 'presence-ingame', 'presence-online', 'presence-menu', 'presence-studio', 'presence-offline', 'presence-unknown');
      avatar.classList.add('presence-' + state);
      avatar.title = state === 'starting' ? 'Checking Roblox presence…' : 'Roblox presence: ' + state;
    }
  }
  // Temp (external) sessions get the same live ring treatment.
  for (const t of _tempSessions) {
    if (!t.userId) continue;
    const a = { id: 'temp-' + t.pid, userId: t.userId };
    const state = presenceClass(a);
    const card = document.querySelector('.card[data-id="' + a.id + '"]');
    if (!card) continue;
    card.classList.remove('presence-starting', 'presence-ingame', 'presence-online', 'presence-menu', 'presence-studio', 'presence-offline', 'presence-unknown');
    card.classList.add('presence-' + state);
    card.classList.toggle('is-live', presenceOnline(a));
    const avatar = document.getElementById('av-' + a.id);
    if (avatar) {
      avatar.classList.remove('presence-starting', 'presence-ingame', 'presence-online', 'presence-menu', 'presence-studio', 'presence-offline', 'presence-unknown');
      avatar.classList.add('presence-' + state);
      avatar.title = state === 'starting' ? 'Checking Roblox presence…' : 'Roblox presence: ' + state;
    }
  }
  if (typeof refreshPkgAvatarStatus === 'function') refreshPkgAvatarStatus();
}

// Recheck ALL cookies every 60s so status stays live
let _recheckRunning = false;
const _cookieCheckedAt = {};            // id -> last validation epoch ms
const OK_RECHECK_MS = 5 * 60 * 1000;    // re-check known-good cookies at most every 5 min
async function recheckAllCookies(force) {
  if (_recheckRunning) return; // bail if a previous pass is still going
  _recheckRunning = true;
  // flag unchecked cookies as 'checking' before the first await, otherwise the
  // checkCookieHealth pass inside render() races us and validates them twice
  for (const a of accounts) if (a.cookie && _cookieStatus[a.id] === undefined) _cookieStatus[a.id] = 'checking';
  try {
  let changed = false;
  const now = Date.now();
  for (const a of accounts) {
    if (!a.cookie) continue;
    // A background re-login (e.g. right after a password change) is in flight —
    // the stored cookie is the dead pre-change one, so skip it until that settles.
    if (_cookieStatus[a.id] === 'refreshing') continue;
    if (!force && _cookieStatus[a.id] === 'ok' && _cookieCheckedAt[a.id] && (now - _cookieCheckedAt[a.id]) < OK_RECHECK_MS) continue;
    const prev = _cookieStatus[a.id];
    _cookieStatus[a.id] = 'checking';
    try {
      const res = await api.validateCookie(a.cookie);
      _cookieCheckedAt[a.id] = Date.now();
      const next = (res && res.ok) ? 'ok' : 'dead';
      if (next === 'dead' && await tryAutoRefreshCookie(a)) {
        changed = true;
        continue;
      }
      if (next !== prev) {
        _cookieStatus[a.id] = next;
        applyCookieStatus(a.id); // toggles .cookie-dead on the card (badge + ring)
        changed = true;
        if (next === 'dead') logEntry('warn', 'cookie', `Cookie expired for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
        else if (prev === 'dead' && next === 'ok') logEntry('ok', 'cookie', `Cookie re-validated for ${a.username || a.id}`, { accountId: a.id, username: a.username, userId: a.userId });
      } else {
        _cookieStatus[a.id] = next;
      }
    } catch { _cookieStatus[a.id] = prev || 'unknown'; }
    await new Promise(r => setTimeout(r, 300));
  }
  if (changed) render(); // rebuild once at the end so the cards match
  } finally { _recheckRunning = false; }
}
setInterval(() => { if (accounts.length && !document.hidden) recheckAllCookies(false); }, 60000);


const _gameNameCache = {}; // accountId -> resolved game name
let _gameNamePersist = {};
try { _gameNamePersist = JSON.parse(localStorage.getItem('mr-gamenames') || '{}'); } catch { _gameNamePersist = {}; }
function _saveGameNames() { try { localStorage.setItem('mr-gamenames', JSON.stringify(_gameNamePersist)); } catch {} }

function extractTargetLabel(target) {
  if (!target) return '';
  const t = target.trim();
  if (/^\d+$/.test(t)) return t;
  try {
    const u = new URL(t.startsWith('http') ? t : 'https://' + t);
    const parts = u.pathname.split('/').filter(Boolean);
    // extract linkCode or share code for private servers
    const name = (parts[2] || parts[1] || '').replace(/-/g, ' ').trim();
    return name || u.hostname;
  } catch { return truncate(target, 22); }
}

async function fetchGameName(accountId, target) {
  if (!target) return;
  const t = target.trim();
  // Persistent cache hit: skip the network entirely.
  if (_gameNamePersist[t]) {
    _gameNameCache[accountId] = _gameNamePersist[t];
    updateGameLabel(accountId);
    return;
  }
  // Find the account to get its cookie for authenticated requests
  const acct = accounts.find(a => a.id === accountId);
  const cookie = acct ? acct.cookie : null;
  let placeId = null;
  if (/^\d+$/.test(t)) {
    placeId = t;
  } else {
    try {
      const u = new URL(t.startsWith('http') ? t : 'https://' + t);
      const parts = u.pathname.split('/').filter(Boolean);
      // /games/<placeId>/... or /games/<placeId>
      if (parts[0] === 'games' && parts[1] && /^\d+$/.test(parts[1])) placeId = parts[1];
      if (!placeId) placeId = u.searchParams.get('placeId');
      // PlaceLauncher URLs: ?placeId=...
      if (!placeId) { const m = t.match(/[?&]placeId=(\d+)/); if (m) placeId = m[1]; }
    } catch {}
  }
  if (!cookie) {
    _gameNameCache[accountId] = extractTargetLabel(target);
    updateGameLabel(accountId);
    return;
  }
  // Fetch via main process (authenticated with cookie)
  const name = await api.getGameName(placeId || t, cookie);
  _gameNameCache[accountId] = name || extractTargetLabel(target);
  // Persist only genuine resolved names (not the raw fallback label).
  if (name) { _gameNamePersist[t] = name; _saveGameNames(); }
  updateGameLabel(accountId);
}

function updateGameLabel(accountId) {
  const el = document.getElementById('gt-' + accountId);
  if (!el) return;
  const a = accounts.find(x => x.id === accountId);
  if (!a || !a.gameTarget) return;
  el.textContent = truncate(_gameNameCache[accountId] || extractTargetLabel(a.gameTarget), 22);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '\u2026' : s; }

let _dragSaveTimer = null;
let _dragging = null, _dragClone = null, _dragOffX = 0, _dragOffY = 0, _dragOverId = null;

function initDrag() {
  const grid = document.getElementById('grid');

  // Temp/external session cards are not draggable (they aren't saved accounts).
  grid.querySelectorAll('.card:not([data-temp])').forEach(card => {
    const handle = card.querySelector('.drag-handle');
    const startEl = handle || card;

    startEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      e.preventDefault();

      _dragging = card;
      const rect = card.getBoundingClientRect();
      _dragOffX = e.clientX - rect.left;
      _dragOffY = e.clientY - rect.top;

      // Create floating clone
      _dragClone = card.cloneNode(true);
      _dragClone.querySelectorAll('.drag-handle').forEach(el => el.remove());
      _dragClone.style.cssText = `
        position:fixed;left:${rect.left}px;top:${rect.top}px;
        width:${rect.width}px;height:${rect.height}px;
        opacity:0.85;pointer-events:none;z-index:9999;
        box-shadow:0 16px 40px rgba(0,0,0,.6);
        transform:scale(1.04);border-color:var(--ac);
        transition:box-shadow .15s;border-radius:var(--r);
        background:var(--s2);border:1px solid var(--ac);
      `;
      if (grid.classList.contains('list-view')) _dragClone.classList.add('drag-list-clone');
      document.body.appendChild(_dragClone);
      card.style.opacity = '0.3';

      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });
  });
}

function onDragMove(e) {
  if (!_dragging || !_dragClone || !_dragging.isConnected) return;
  _dragClone.style.left = (e.clientX - _dragOffX) + 'px';
  _dragClone.style.top  = (e.clientY - _dragOffY) + 'px';

  // nudge the scroll when the cursor gets near the top/bottom edge
  const wrap = document.querySelector('.grid-wrap');
  if (wrap) {
    const wr = wrap.getBoundingClientRect();
    if (e.clientY < wr.top + 60) wrap.scrollTop -= 16;
    else if (e.clientY > wr.bottom - 60) wrap.scrollTop += 16;
  }

  // Find the card under the cursor (the clone is hidden for the hit-test so it
  // never matches itself).
  _dragClone.style.display = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  _dragClone.style.display = '';
  const target = el ? el.closest('.card[data-id]') : null;
  if (!target || target === _dragging) return;
  const newId = target.dataset.id;
  if (newId === _dragOverId) return; // already settled against this neighbour
  _dragOverId = newId;

  const grid = document.getElementById('grid');
  const cards = Array.from(grid.querySelectorAll('.card[data-id]'));
  const srcPos = cards.indexOf(_dragging);
  const tgtPos = cards.indexOf(target);
  if (srcPos < 0 || tgtPos < 0) return;
  grid.insertBefore(_dragging, srcPos < tgtPos ? target.nextSibling : target);
  _syncAccountsOrderFromDom();
}

function _syncAccountsOrderFromDom() {
  const grid = document.getElementById('grid');
  const visIds = Array.from(grid.querySelectorAll('.card[data-id]')).map(c => c.dataset.id);
  const visSet = new Set(visIds);
  const byId = new Map(accounts.filter(a => visSet.has(a.id)).map(a => [a.id, a]));
  const queue = visIds.map(id => byId.get(id)).filter(Boolean);
  let qi = 0;
  accounts = accounts.map(a => (visSet.has(a.id) ? queue[qi++] : a));
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (_dragClone) { _dragClone.remove(); _dragClone = null; }
  if (_dragging) { _dragging.style.opacity = ''; _dragging = null; }
  _dragOverId = null;

  // settle the DOM and rebind the drag handlers with one render
  render();

  clearTimeout(_dragSaveTimer);
  _dragSaveTimer = setTimeout(() => {
    api.reorderAccounts(accounts.map(a => a.id));
  }, 400);
}

function loadAvatar(id, uid) {
  if (_avatarCache[uid]) {
    const el = document.getElementById('av-' + id);
    if (el) el.innerHTML = '<img src="' + _avatarCache[uid] + '" alt=""/>';
    return;
  }
  fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png')
    .then(r => r.json()).then(d => {
      const url = d?.data?.[0]?.imageUrl;
      if (url) {
        _avatarCache[uid] = url;
        const el = document.getElementById('av-' + id);
        if (el) el.innerHTML = '<img src="' + esc(url) + '" alt=""/>';
      }
    }).catch(() => {});
}

async function loadAvatarsBatch(list) {
  const paint = a => {
    if (a.userId && _avatarCache[a.userId]) {
      const el = document.getElementById('av-' + a.id);
      if (el && !el.querySelector('img')) el.innerHTML = '<img src="' + esc(_avatarCache[a.userId]) + '" alt=""/>';
      const pmEl = document.getElementById('pm-av-' + a.id);
      if (pmEl && !pmEl.querySelector('img')) pmEl.innerHTML = '<img src="' + esc(_avatarCache[a.userId]) + '" alt=""/>';
    }
  };
  const need = [], seen = new Set();
  for (const a of list) {
    if (!a.userId) continue;
    if (_avatarCache[a.userId]) { paint(a); continue; }
    if (!seen.has(a.userId)) { seen.add(a.userId); need.push(a.userId); }
  }
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    try {
      const r = await fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + chunk.join(',') + '&size=48x48&format=Png');
      const d = await r.json();
      (d?.data || []).forEach(item => { if (item && item.targetId && item.imageUrl) _avatarCache[item.targetId] = item.imageUrl; });
      list.forEach(paint);
    } catch {
      chunk.forEach(uid => { const a = list.find(x => x.userId === uid); if (a) loadAvatar(a.id, uid); });
    }
  }
}

function loadPkgAvatar(pkgId, accountId, uid, attempt) {
  const elId = 'pkg-av-' + pkgId + '-' + accountId;
  const paint = url => {
    _avatarCache[uid] = url;
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<img src="' + esc(url) + '" alt=""/>';
  };
  if (_avatarCache[uid]) { paint(_avatarCache[uid]); return; }
  fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + uid + '&size=48x48&format=Png')
    .then(r => r.json()).then(d => {
      const item = d?.data?.[0];
      if (item && item.imageUrl && item.state === 'Completed') { paint(item.imageUrl); return; }
      // Roblox returns Pending while it generates the thumbnail; retry briefly.
      if (item && item.state === 'Pending' && (attempt || 0) < 3) {
        setTimeout(() => loadPkgAvatar(pkgId, accountId, uid, (attempt || 0) + 1), 1500);
      } else if (item && item.imageUrl) { paint(item.imageUrl); }
    }).catch(() => {});
}

const _userInfoCache = {};
function loadUserInfo(uid, cb) {
  if (_userInfoCache[uid]) { cb(_userInfoCache[uid]); return; }
  fetch('https://users.roblox.com/v1/users/' + uid)
    .then(r => r.json()).then(d => { _userInfoCache[uid] = d; cb(d); })
    .catch(() => cb(null));
}

function positionAvTip(av, tip) {
  const rect = av.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = rect.top - th - 10;
  if (top < 8) top = rect.bottom + 10;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function showAvTip(av) {
  const uid = av.dataset.uid || '';
  const uname = av.dataset.uname || '';
  const nick = av.dataset.nick || '';
  const tip = document.getElementById('av-tip');
  tip.dataset.uid = uid;
  setStreamerText('av-tip-name', nick && nick !== uname ? nick : (uname || 'Unknown'));
  setStreamerText('av-tip-uname', uname ? '@' + uname : (uid ? 'ID ' + uid : ''));
  const avEl = document.getElementById('av-tip-av');
  avEl.innerHTML = _avatarCache[uid] ? '<img src="' + _avatarCache[uid] + '" alt=""/>' : (uname || '?')[0].toUpperCase();
  // Mirror the account's presence ring color (green in-game, blue menu, grey
  // offline/unknown) instead of always showing the accent blue.
  avEl.classList.remove('presence-ingame', 'presence-menu', 'presence-studio', 'presence-starting', 'presence-offline', 'presence-unknown');
  const pres = [...av.classList].find(c => c.startsWith('presence-'));
  if (pres) avEl.classList.add(pres);
  document.getElementById('av-tip-created').textContent = uid ? 'Loading\u2026' : 'Unknown';
  tip.classList.add('show');
  positionAvTip(av, tip);
  if (uid) {
    loadUserInfo(uid, info => {
      if (tip.dataset.uid !== uid || !tip.classList.contains('show')) return;
      const createdEl = document.getElementById('av-tip-created');
      if (info && info.created) {
        const d = new Date(info.created);
        createdEl.textContent = 'Created ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } else {
        createdEl.textContent = 'Unknown';
      }
      positionAvTip(av, tip);
    });
  }
}

function hideAvTip() {
  document.getElementById('av-tip').classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av) showAvTip(av);
});
document.addEventListener('mouseout', e => {
  const av = e.target.closest('.pkg-avatar:not(.more)');
  if (av && !(e.relatedTarget && av.contains(e.relatedTarget))) hideAvTip();
});
window.addEventListener('scroll', hideAvTip, true);

function _showPanel(panel) {
  ['choose','cookie','browser'].forEach(p => {
    document.getElementById('login-panel-' + p).style.display = p === panel ? '' : 'none';
  });
  document.getElementById('btn-cookie-add').style.display = panel === 'cookie' ? '' : 'none';
  document.getElementById('btn-login-back').style.display = panel === 'choose' ? 'none' : '';
  setStatus('login-status', 'hidden', '');
}

function openLogin() {
  document.getElementById('cookie-input').value = '';
  _showPanel('choose');
  openModal('m-login');
}

function showCookiePanel() {
  _showPanel('cookie');
  setTimeout(() => document.getElementById('cookie-input').focus(), 50);
}

function backToChoose() {
  _showPanel('choose');
}

async function startBrowserLogin(prefill) {
  _showPanel('browser');
  // Show waiting state by default - only switch to download UI if Chrome needs to be downloaded
  document.getElementById('login-dl').style.display = 'none';
  document.getElementById('login-waiting').style.display = '';
  document.getElementById('dl-bar').style.width = '0%';
  document.getElementById('dl-pct').textContent = '0%';
  const res = await api.openLogin(prefill || null);
  if (!document.getElementById('m-login').classList.contains('open')) return;
  if (!res || !res.success) {
    if (res && res.error && res.error !== 'Login window closed') {
      _showPanel('choose');
      setStatus('login-status', 'err', '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' + esc(res.error));
    } else {
      closeModal('m-login');
    }
    return;
  }
  await finishLogin(res);
}

async function addByCookie() {
  let cookie = document.getElementById('cookie-input').value.trim();
  if (!cookie) return;
  // Strip any prefix the user may have accidentally included
  if (cookie.startsWith('.ROBLOSECURITY=')) cookie = cookie.slice('.ROBLOSECURITY='.length);
  if (cookie.startsWith('ROBLOSECURITY=')) cookie = cookie.slice('ROBLOSECURITY='.length);
  // Remove any surrounding quotes
  cookie = cookie.replace(/^["']|["']$/g, '').trim();
  if (!cookie || cookie.length < 100) {
    setStatus('login-status', 'err', '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Cookie looks too short - make sure you copied the full value');
    return;
  }
  const btn = document.getElementById('btn-cookie-add');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin"></div>Verifying…';
  setStatus('login-status', 'load', '<div class="spin"></div>Verifying cookie…');
  const res = await api.validateCookie(cookie);
  btn.disabled = false;
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Add Account';
  if (!res.ok) {
    setStatus('login-status', 'err', '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' + (res.reason || 'Invalid cookie - make sure you copied the full .ROBLOSECURITY value'));
    return;
  }
  await finishLogin({ success: true, cookie, username: res.username, userId: res.userId });
}

function cancelLogin() {
  closeModal('m-login');
  api.cancelLogin && api.cancelLogin();
}

async function finishLogin(res) {
  setStatus('login-status', 'ok', '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>Signed in as ' + esc(res.username));
  const existing = res.userId != null ? accounts.find(x => String(x.userId) === String(res.userId)) : undefined;
  if (existing) {
    // Re-login of an existing account: refresh its cookie in place instead of
    // creating a duplicate entry (cookies expire and force re-login).
    existing.username = res.username;
    existing.cookie = res.cookie;
    const upd = { username: res.username, cookie: res.cookie };
    // Browser login captures the typed password automatically, so a later
    // "Change password (random)" doesn't need it again. Stored encrypted.
    if (res.password) upd.password = res.password;
    await api.updateAccount(existing.id, upd);
  } else {
    const extra = res.password ? { password: res.password } : {};
    const a = await api.addAccount({ username: res.username, userId: res.userId, cookie: res.cookie, gameTarget: '', ...extra });
    accounts.push(a);
  }
  render();
  refreshPresence(true);
  setTimeout(() => {
    closeModal('m-login');
    toast((existing ? 'Updated cookie for ' : 'Added ') + esc(res.username), 'ok');
    const grid = document.getElementById('grid');
    if (grid) grid.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 800);
}

function editCookieStatusText(a) {
  const state = a ? _cookieStatus[a.id] : null;
  if (state === 'ok') return 'Cookie status: active';
  if (state === 'dead') return 'Cookie status: expired';
  if (state === 'refreshing') return 'Cookie status: refreshing…';
  if (state === 'checking') return 'Cookie status: checking…';
  return a?.cookie ? 'Cookie status: not checked' : 'Cookie status: missing';
}

function openEdit(id) {
  editAcc = accounts.find(a => a.id === id); if (!editAcc) return;
  document.getElementById('edit-title').textContent = 'Account settings — ' + (editAcc.nickname || editAcc.username);
  document.getElementById('edit-username').textContent = editAcc.username || '—';
  document.getElementById('edit-userid').textContent = editAcc.userId || '—';
  document.getElementById('in-nickname').value = editAcc.nickname || '';
  document.getElementById('in-login-password').value = editAcc.password || '';
  document.getElementById('in-login-password').type = 'password';
  document.getElementById('edit-password-state').textContent = editAcc.password
    ? 'Saved securely for automatic cookie recovery.'
    : 'No saved password — automatic recovery needs a browser login.';
  document.getElementById('edit-cookie-status').textContent = editCookieStatusText(editAcc);
  openModal('m-edit');
  applyCookieStatus(editAcc.id);
  setTimeout(() => document.getElementById('in-nickname').focus(), 220);
}

function toggleEditPasswordVisibility() {
  const input = document.getElementById('in-login-password');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function saveEdit() {
  if (!editAcc) return;
  return runAiAction('edit-save', 'Saving…', async () => {
    const nickname = document.getElementById('in-nickname').value.trim();
    const password = document.getElementById('in-login-password').value;
    const updated = await api.updateAccount(editAcc.id, { nickname, password });
    if (updated) {
      const idx = accounts.findIndex(a => a.id === editAcc.id);
      if (idx !== -1) accounts[idx] = updated;
      editAcc = updated;
      render();
      closeModal('m-edit');
      toast(password ? 'Account settings saved' : 'Settings saved — automatic login password cleared', 'ok');
      return true;
    }
    toast('Could not save account settings', 'err');
    return false;
  });
}

async function editRefreshCookie() {
  if (!editAcc) return;
  const account = editAcc;
  return runAiAction('edit-refresh-cookie', 'Refreshing…', async () => {
    const ok = await refreshAccountCookieForAction(account, { validateCurrent: true });
    const status = document.getElementById('edit-cookie-status');
    if (status) status.textContent = editCookieStatusText(account);
    if (!ok) {
      toast('Cookie refresh needs a Roblox browser login or security challenge.', 'err');
      return false;
    }
    toast('Cookie and profile refreshed', 'ok');
    return true;
  });
}

async function editChangeRobloxPassword() {
  if (!editAcc || !editAcc.cookie) { toast('No cookie found for this account', 'err'); return false; }
  const account = editAcc;
  if (_cookieStatus[account.id] === 'refreshing') return false;
  return runAiAction('edit-change-roblox-password', 'Changing…', () =>
    applyPasswordChange(account, account.cookie, account.password || '')
  );
}

async function editOpenBrowser() {
  if (!editAcc) return false;
  const account = editAcc;
  return runAiAction('edit-open-browser', 'Opening…', async () => {
    if (!await refreshAccountCookieForAction(account, { validateCurrent: true })) {
      toast('No valid cookie is available. Complete the Roblox login challenge and try again.', 'err');
      return false;
    }
    const res = await api.openBrowserWithCookie(account.cookie, 'https://www.roblox.com/home');
    if (res && !res.ok) toast(res.error || 'Failed to open browser', 'err');
    return !!(!res || res.ok);
  });
}

function confirmAction(message, onConfirm) {
  document.getElementById('m-confirm-delete-msg').textContent = message;
  const btn = document.getElementById('m-confirm-delete-btn');
  const newBtn = btn.cloneNode(true); // clone to remove old listeners
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => { closeModal('m-confirm-delete'); onConfirm(); });
  openModal('m-confirm-delete');
}

async function removeAcc(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  confirmAction('Remove "' + a.username + '"? This cannot be undone.', async () => {
    await api.removeAccount(id); accounts = accounts.filter(x => x.id !== id); render();
    if (packages.some(p => p.accountIds.includes(id))) {
      packages.forEach(p => { p.accountIds = p.accountIds.filter(aid => aid !== id); });
      api.savePackages(packages);
      renderPackages();
    }
    toast('Removed ' + a.username, 'err');
  });
}
async function clearAll() {
  if (!accounts.length) return;
  confirmAction('Remove all ' + accounts.length + ' accounts? This cannot be undone.', async () => {
    for (const a of accounts) await api.removeAccount(a.id);
    accounts = []; render();
    packages.forEach(p => { p.accountIds = []; });
    api.savePackages(packages);
    renderPackages();
    toast('All accounts cleared', 'err');
  });
}

let _weaoExploitsData = null;
let _weaoVersionsData = null;
let _installedVersionsList = [];
let _selectedVersionHash = '';
let _launchRequiredVersionHash = null;

function normalizeVersionHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  if (!value) return null;
  return value.startsWith('version-') ? value : 'version-' + value;
}

async function loadWeaoForLaunch() {
  const filterSel = document.getElementById('launch-exploit-filter');
  const statusEl = document.getElementById('launch-weao-status');

  try {
    _installedVersionsList = (await api.getInstalledVersions()) || [];
  } catch {
    _installedVersionsList = [];
  }

  if (!_weaoExploitsData) {
    if (filterSel) filterSel.innerHTML = '<option value="all">Loading WEAO exploits…</option>';
    try {
      const [expRes, verRes] = await Promise.all([
        api.weaoExploits(),
        api.weaoVersions('current')
      ]);
      if (expRes && expRes.ok && Array.isArray(expRes.data)) {
        _weaoExploitsData = expRes.data;
      }
      if (verRes && verRes.ok && verRes.data) {
        _weaoVersionsData = verRes.data;
      }
      if (statusEl) statusEl.textContent = _weaoExploitsData ? 'WEAO Live' : 'Offline';
    } catch {
      if (statusEl) statusEl.textContent = 'Offline';
    }
  }

  populateLaunchExploitFilter();
  if (typeof window.renderExecutorSettings === 'function') window.renderExecutorSettings();
  onLaunchExploitFilterChange();
}

let _disabledExecutors = [];
try { _disabledExecutors = JSON.parse(localStorage.getItem('rblx_disabled_executors') || '[]'); } catch {}
let _defaultExecutor = localStorage.getItem('rblx_default_executor') || '';

function populateLaunchExploitFilter() {
  const filterSel = document.getElementById('launch-exploit-filter');
  if (!filterSel) return;

  const options = [];

  if (Array.isArray(_weaoExploitsData)) {
    _weaoExploitsData.forEach(exp => {
      const name = exp.title || exp.name || exp.exploit || 'Exploit';
      if (_disabledExecutors.includes(name)) return;
      const isUp = exp.updateStatus === true || exp.updated === true || exp.isUpdated === true || exp.status === 'Updated' || exp.updatedStatus === 'Updated' || exp.updatedStatus === true;
      const verHash = exp.rbxversion || exp.robloxVersion || exp.versionHash || (_weaoVersionsData ? _weaoVersionsData.Windows : '');
      const statusLabel = isUp ? 'Updated' : 'Patched';
      options.push({
        label: `${name} [${statusLabel}] ${verHash ? '(' + truncate(verHash, 14) + ')' : ''}`,
        value: name,
      });
    });
  }

  if (!options.length) {
    filterSel.innerHTML = '<option value="">No exploits available</option>';
    return;
  }

  filterSel.innerHTML = options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');

  if (_defaultExecutor && options.some(o => o.value === _defaultExecutor)) {
    filterSel.value = _defaultExecutor;
  }
}

window.renderExecutorSettings = function() {
  const defSel = document.getElementById('setting-default-executor');
  const listEl = document.getElementById('setting-executors-list');
  if (!defSel || !listEl) return;

  if (!Array.isArray(_weaoExploitsData)) {
    defSel.innerHTML = '<option value="">Loading executors…</option>';
    listEl.innerHTML = '<div style="grid-column:1/-1; padding:12px; color:var(--t3); font-size:12px; text-align:center">Loading executors…</div>';
    loadWeaoForLaunch();
    return;
  }

  const opts = [];
  opts.push({ label: 'None (Select on launch)', value: '' });

  _weaoExploitsData.forEach(exp => {
    const name = exp.title || exp.name || exp.exploit || 'Exploit';
    opts.push({ label: name, value: name });
  });

  defSel.innerHTML = opts.map(o => `<option value="${esc(o.value)}"${o.value === _defaultExecutor ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

  listEl.innerHTML = _weaoExploitsData.map(exp => {
    const name = exp.title || exp.name || exp.exploit || 'Exploit';
    const isChecked = !_disabledExecutors.includes(name);
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:var(--s2); border:1px solid var(--bd); border-radius:6px">
        <span style="font-size:12px; font-weight:500; color:var(--t1)">${esc(name)}</span>
        <label class="toggle">
          <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleExecutorExclusion('${esc(name)}', this.checked)"/>
          <span class="toggle-trk"></span>
        </label>
      </div>
    `;
  }).join('');
};

window.saveExecutorSettings = function() {
  const defSel = document.getElementById('setting-default-executor');
  if (defSel) {
    _defaultExecutor = defSel.value;
    localStorage.setItem('rblx_default_executor', _defaultExecutor);
    // Mirror into app settings so the main process can resolve the executor's
    // synced Roblox build for browser (protocol) launches too.
    api.saveSettings({ defaultExecutor: _defaultExecutor }).catch(() => {});
  }
  populateLaunchExploitFilter();
  if (typeof window.executorsRender === 'function') window.executorsRender();
};

window.toggleExecutorExclusion = function(name, enabled) {
  if (enabled) {
    _disabledExecutors = _disabledExecutors.filter(x => x !== name);
  } else {
    if (!_disabledExecutors.includes(name)) _disabledExecutors.push(name);
  }
  localStorage.setItem('rblx_disabled_executors', JSON.stringify(_disabledExecutors));
  api.saveSettings({ disabledExecutors: _disabledExecutors }).catch(() => {});
  window.renderExecutorSettings();
  populateLaunchExploitFilter();
  if (typeof window.executorsRender === 'function') window.executorsRender();
};

window.setAllExecutorsEnabled = function(enableAll) {
  if (!Array.isArray(_weaoExploitsData)) return;
  if (enableAll) {
    _disabledExecutors = [];
  } else {
    _disabledExecutors = _weaoExploitsData.map(exp => exp.title || exp.name || exp.exploit || 'Exploit');
  }
  localStorage.setItem('rblx_disabled_executors', JSON.stringify(_disabledExecutors));
  api.saveSettings({ disabledExecutors: _disabledExecutors }).catch(() => {});
  window.renderExecutorSettings();
  populateLaunchExploitFilter();
  if (typeof window.executorsRender === 'function') window.executorsRender();
};

function onLaunchExploitFilterChange() {
  const filterVal = document.getElementById('launch-exploit-filter')?.value || 'all';
  const listEl = document.getElementById('launch-ver-list');
  const reqInfoEl = document.getElementById('launch-req-ver-info');
  const installBox = document.getElementById('launch-install-box');
  const installTitle = document.getElementById('launch-install-title');
  const installSub = document.getElementById('launch-install-sub');
  const btnLaunch = document.getElementById('btn-launch');
  if (!listEl) return;

  let requiredVersionHash = null;
  let exploitName = filterVal;

  if (filterVal !== 'all' && filterVal !== 'official' && Array.isArray(_weaoExploitsData)) {
    const expObj = _weaoExploitsData.find(e => (e.title || e.name || e.exploit) === filterVal);
    if (expObj) {
      requiredVersionHash = normalizeVersionHash(expObj.rbxversion || expObj.robloxVersion || expObj.versionHash || (_weaoVersionsData ? _weaoVersionsData.Windows : null));
    }
  } else if (filterVal === 'official' && _weaoVersionsData) {
    requiredVersionHash = normalizeVersionHash(_weaoVersionsData.Windows);
  }

  const items = [];
  _installedVersionsList.forEach(v => {
    // Partial/interrupted installs can't launch — keep them out of the picker
    // (they stay visible in the RDD Installed Versions list, badged).
    if (v.complete === false) return;
    const isCompat = (filterVal === 'all') || (requiredVersionHash ? normalizeVersionHash(v.hash) === requiredVersionHash : true);
    items.push({
      title: v.hash,
      loc: v.location,
      value: v.hash,
      isCompat
    });
  });

  // A selected executor owns the Roblox build used for launch. Do not keep a
  // previous manual choice or silently fall back to another installed build.
  _launchRequiredVersionHash = requiredVersionHash || null;
  if (requiredVersionHash) {
    const installedVersion = _installedVersionsList.find(v => normalizeVersionHash(v.hash) === requiredVersionHash);
    const isInstalled = !!installedVersion;
    _selectedVersionHash = installedVersion ? installedVersion.hash : '';
    _launchRequiredVersionHash = installedVersion ? installedVersion.hash : requiredVersionHash;
  } else if (!_selectedVersionHash || _selectedVersionHash === 'auto') {
    _selectedVersionHash = (_installedVersionsList.find(v => v.complete !== false))?.hash || '';
  }

  renderInstalledVersionsListView(items);

  if (requiredVersionHash) {
    const isInstalled = _installedVersionsList.some(v => normalizeVersionHash(v.hash) === requiredVersionHash);
    if (reqInfoEl) reqInfoEl.textContent = `Requires: ${truncate(requiredVersionHash, 16)}`;

    if (isInstalled) {
      if (installBox) installBox.style.display = 'none';
      if (btnLaunch) btnLaunch.disabled = false;
    } else {
      if (installBox) installBox.style.display = 'flex';
      if (installTitle) installTitle.textContent = `${exploitName} requires version download`;
      if (installSub) installSub.textContent = `Version ${truncate(requiredVersionHash, 14)} is not installed locally.`;
      if (installBox) installBox.dataset.requiredVer = requiredVersionHash;
      if (btnLaunch) btnLaunch.disabled = true;
    }
  } else {
    if (reqInfoEl) reqInfoEl.textContent = '';
    if (installBox) installBox.style.display = 'none';
    if (btnLaunch) btnLaunch.disabled = false;
  }
}

function renderInstalledVersionsListView(items) {
  const listEl = document.getElementById('launch-ver-list');
  if (!listEl) return;

  if (!items.length) {
    listEl.innerHTML = '<div style="font-size:12px; color:var(--t3); padding:10px; text-align:center">No installed Roblox versions found</div>';
    return;
  }

  listEl.innerHTML = items.map(item => {
    const isSelected = _selectedVersionHash === item.value;
    const badgeHtml = item.isCompat ? `<span class="ver-item-badge compat">Compatible</span>` : (item.loc && item.loc !== 'Installed' ? `<span class="ver-item-badge">${esc(item.loc)}</span>` : '');
    return `
      <div class="ver-item${isSelected ? ' selected' : ''}" onclick="selectLaunchVersionItem('${esc(item.value)}')">
        <div class="ver-item-left">
          <div class="ver-item-icon"></div>
          <div class="ver-item-info">
            <div class="ver-item-title">${esc(item.title)}</div>
          </div>
        </div>
        ${badgeHtml}
      </div>
    `;
  }).join('');
}

function selectLaunchVersionItem(val) {
  // Executor sync is automatic; manual version clicks only apply when no
  // executor version is currently required.
  if (_launchRequiredVersionHash) return;
  _selectedVersionHash = val;
  onLaunchExploitFilterChange();
}

async function installWorkingVersionForSelectedExploit() {
  const installBox = document.getElementById('launch-install-box');
  const requiredVer = installBox?.dataset?.requiredVer;
  if (!requiredVer) return;
  await installRequiredVersion(requiredVer, { viaButton: true });
}

const _MST_OK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const _MST_ERR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

// Download a required executor-synced Roblox build via RDD (used by the launch
// modal banner AND the shared launch preflight, which runs with the modal
// closed). Returns the installed version hash, or null on failure.
let _installStatusOwnedByModal = false; // modal-driven installs keep their own status text
let _outdatedNoticeLabel = null; // label override for the outdated-version notice (e.g. group launches)
async function installRequiredVersion(requiredVer, opts = {}) {
  const { viaButton = false } = opts;
  const norm = normalizeVersionHash(requiredVer);
  const btnInstall = document.getElementById('btn-install-working');
  const launchModalOpen = !!(document.getElementById('m-launch')?.classList.contains('open'));
  const showStatus = (type, html) => { if (launchModalOpen) setStatus('launch-status', type, html); };

  if (viaButton && btnInstall) { btnInstall.disabled = true; btnInstall.innerHTML = '<div class="spin"></div> Installing...'; }
  // Outdated/not-supported build on launch → tell the user the latest
  // supported version is being fetched automatically (no action needed).
  const label = _outdatedNoticeLabel || (launchAcc ? (launchAcc.username || 'This account') : 'Launch');
  const outdated = notifyOutdatedVersionBeforeLaunch(label);
  const dlLabel = outdated
    ? '<div class="spin"></div> Older version detected \u2014 downloading the latest supported one\u2026'
    : `<div class="spin"></div> Downloading Roblox version ${truncate(requiredVer, 14)} via RDD\u2026`;
  showStatus('load', dlLabel);
  logEntry('info', 'launch', `Downloading required Roblox version ${requiredVer} via RDD\u2026`);

  _installStatusOwnedByModal = launchModalOpen;
  try {
    if (typeof window.performAutomatedRddInstallation === 'function') {
      await window.performAutomatedRddInstallation(requiredVer);
    }
    _installedVersionsList = (await api.getInstalledVersions()) || [];
    const installedVersion = _installedVersionsList.find(v => v.complete !== false && normalizeVersionHash(v.hash) === norm);
    if (!installedVersion) {
      throw new Error(`Version ${truncate(requiredVer, 14)} was not installed successfully.`);
    }
    _launchRequiredVersionHash = installedVersion.hash;
    _selectedVersionHash = installedVersion.hash;
    onLaunchExploitFilterChange();
    showStatus('ok', _MST_OK_SVG + ' Latest supported version installed! Ready to play.');
    toast(`Version ${truncate(requiredVer, 14)} ready`, 'ok');
    logEntry('ok', 'launch', `Required Roblox version ${installedVersion.hash} installed`);
    return installedVersion.hash;
  } catch (e) {
    showStatus('err', _MST_ERR_SVG + ' Failed to download version: ' + esc(e.message));
    toast('Failed to download version: ' + (e.message || 'unknown error'), 'err');
    logEntry('err', 'launch', `Failed to download required Roblox version ${requiredVer}: ${e.message}`);
    return null;
  } finally {
    if (viaButton && btnInstall) { btnInstall.disabled = false; btnInstall.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4 4 4-4"/></svg>Install Working'; }
    _installStatusOwnedByModal = false;
  }
}

// ─── Unified launch workflow ────────────────────────────────────────────────
// Every launch entry point (account Start modal, context-menu Launch/
// Relaunch, Launch Game picker, group launches) goes through the same steps:
//   1. Sync WEAO exploit data + installed versions (executor version check).
//   2. Resolve the Roblox build the selected executor requires.
//   3. Auto-install that build via RDD when it is missing.
//   4. Launch with the synced build hash.

function resetLaunchModalUI() {
  const btn = document.getElementById('btn-launch');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Start'; }
  setStatus('launch-status', 'hidden', '');
  _selectedVersionHash = '';
  _launchRequiredVersionHash = null;
}

// Shared preflight. Resolves to the Roblox version hash to launch with
// ('auto' when no executor version is pinned), or null when the executor's
// required build could not be installed and the launch must not proceed.
async function ensureLaunchVersionSynced(opts = {}) {
  const { silent = false } = opts;
  try { await loadWeaoForLaunch(); } catch {}
  const required = _launchRequiredVersionHash;
  if (required) {
    const norm = normalizeVersionHash(required);
    const installedVersion = _installedVersionsList.find(v => v.complete !== false && normalizeVersionHash(v.hash) === norm);
    if (!installedVersion) {
      if (!silent) {
        logEntry('info', 'launch', `Executor needs Roblox version ${truncate(required, 16)} \u2014 installing it before launch\u2026`);
      }
      const hash = await installRequiredVersion(required, { viaButton: false });
      if (!hash) return null;
    } else {
      _launchRequiredVersionHash = installedVersion.hash;
      _selectedVersionHash = installedVersion.hash;
    }
  } else if (!_selectedVersionHash || _selectedVersionHash === 'auto') {
    _selectedVersionHash = (_installedVersionsList.find(v => v.complete !== false))?.hash || '';
  }
  return _launchRequiredVersionHash || _selectedVersionHash || 'auto';
}

let _launchGameOverride = null; // one-shot game picker selection for doLaunch
let _launchBusy = false; // guards against double-launching the same account

function openLaunch(id) {
  launchAcc = accounts.find(a => a.id === id); if (!launchAcc) return;
  const target = launchAcc.gameTarget || '';
  const gameName = _gameNameCache[launchAcc.id] || (target ? extractTargetLabel(target) : '');
  const p = document.getElementById('launch-prev');
  p.innerHTML = '<div class="prev-av" id="prev-av">' + esc((launchAcc.username || '?')[0].toUpperCase()) + '</div>' +
    '<div><div class="prev-name' + (settings.streamerMode ? ' streamer-mask' : '') + '" title="' + (settings.streamerMode ? 'Hover to reveal' : '') + '">' + esc(launchAcc.username) + '</div>' +
    '<div class="prev-uid">' + esc(gameName || 'Opens home screen') + '</div></div>';
  // Avatar
  if (launchAcc.userId) {
    fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + launchAcc.userId + '&size=48x48&format=Png')
      .then(r => r.json()).then(d => {
        const url = d?.data?.[0]?.imageUrl, el = document.getElementById('prev-av');
        if (url && el) el.innerHTML = '<img src="' + esc(url) + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>';
      }).catch(() => {});
  }

  // Same reset for every path into this modal (card Start button, context-menu
  // Launch, context-menu Relaunch on an already-running instance) so a stale
  // "Launching\u2026" state can never stick.
  resetLaunchModalUI();
  loadWeaoForLaunch();
  openModal('m-launch');
}

function collectLaunchOptions() {
  const options = {};
  const fpsEl = document.getElementById('mix-fps');
  if (fpsEl && !document.getElementById('mix-fps-unl')?.checked) options.fpsCap = parseInt(fpsEl.value, 10);
  const gfxEl = document.getElementById('mix-gfx');
  if (gfxEl && !document.getElementById('mix-gfx-auto')?.checked) options.gfxLevel = parseInt(gfxEl.value, 10);
  const ramVal = localStorage.getItem('mix-ram-limit');
  if (ramVal && !document.getElementById('mix-ram-unl')?.checked) {
    options.ramLimitMb = parseInt(ramVal, 10);
  } else if (launchAcc) {
    // Direct launches fall back to the account's group RAM cap so a limit
    // configured on a group still applies when the account is started from
    // its card instead of through the group.
    const pkg = packages.find(p => Array.isArray(p.accountIds) && p.accountIds.includes(launchAcc.id) && typeof p.ramLimitMb === 'number');
    if (pkg) options.ramLimitMb = pkg.ramLimitMb;
  }
  return options;
}

async function doLaunch() {
  if (!launchAcc) return;
  const acc = launchAcc; // capture: later launches must not mutate this run
  const btn = document.getElementById('btn-launch');
  const launchModalOpen = !!(document.getElementById('m-launch')?.classList.contains('open'));
  if (launchModalOpen && btn && btn.disabled) return;
  if (_launchBusy) return;
  _launchBusy = true;

  // When an executor is selected, always pass its synced build hash. This
  // prevents a stale/manual version selection from launching the wrong build.
  const chosenVer = _launchRequiredVersionHash || _selectedVersionHash || 'auto';

  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Launching\u2026'; }
  setStatus('launch-status', 'load', '<div class="spin"></div>Launching in background\u2026');

  closeModal('m-launch');

  markLaunched(acc.id);

  const options = collectLaunchOptions();

  logEntry('info', 'launch', `Launching Roblox for ${acc.username || acc.id}...`, { accountId: acc.id, username: acc.username, userId: acc.userId, target: (acc.gameTarget || (_launchGameOverride ? _launchGameOverride.placeId : null) || 'Roblox home'), versionHash: chosenVer });
  const target = _launchGameOverride ? String(_launchGameOverride.placeId) : (acc.gameTarget || null);
  let res;
  try {
    res = await api.launchRoblox(acc.id, acc.cookie, target, chosenVer, options);
  } catch (e) {
    res = { success: false, error: e?.message || 'Launch request failed' };
  } finally {
    // One-shot: never leak the game-picker selection into a later launch,
    // even if the IPC call rejects.
    _launchGameOverride = null;
    _launchBusy = false;
  }
  if (!res || !res.success) {
    if (res?.cancelled) {
      _launchedIds.delete(acc.id);
      render();
      if (btn) { btn.disabled = false; btn.innerHTML = 'Start'; }
      setStatus('launch-status', 'load', 'Launch cancelled');
      return;
    }
    logEntry('err', 'launch', `Launch failed for ${acc.username || acc.id}: ${res.error}`, { accountId: acc.id });
    _flagCookieMaybeDead(acc.id, res.error);
    _launchedIds.delete(acc.id);
    render();
    toast('Launch failed: ' + (res.error || 'Unknown error'), 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = 'Start'; }
    setStatus('launch-status', 'err', _MST_ERR_SVG + 'Launch failed: ' + esc(res.error || 'Unknown error'));
    return;
  }
  setStatus('launch-status', 'ok', _MST_OK_SVG + 'Launched as ' + acc.username);
  logEntry('ok', 'launch', `Roblox launched successfully as ${acc.username || acc.id}`, { accountId: acc.id, username: acc.username, userId: acc.userId });
  toast('Launched as ' + acc.username, 'ok');
  // Keep Start clickable so an already-running instance can be relaunched;
  // every entry point resets the modal state itself (resetLaunchModalUI).
  if (btn) { btn.disabled = false; btn.innerHTML = 'Start'; }
}

function renderPackages() {
  const list = document.getElementById('pkg-list'), empty = document.getElementById('pkg-empty');
  if (!list) return;
  if (!packages.length) { list.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  list.innerHTML = packages.map((p, i) => {
    const members = (p.accountIds || []).map(id => accounts.find(a => a.id === id)).filter(Boolean);
    const shown = members.slice(0, 6);
    const extra = members.length - shown.length;
    const avatarsHtml = shown.map(m => `<div class="pkg-avatar presence-${presenceClass(m)}" id="pkg-av-${p.id}-${m.id}" data-acc-id="${m.id}" data-uid="${m.userId || ''}" data-uname="${esc(m.username || '')}" data-nick="${esc(m.nickname || '')}">${(m.username || '?')[0].toUpperCase()}</div>`).join('')
      + (extra > 0 ? `<div class="pkg-avatar more">+${extra}</div>` : '');
    return `
    <div class="pkg-card" data-id="${p.id}" style="animation-delay:${i * 18}ms">
      <div class="pkg-card-top">
        <div class="pkg-card-info">
          <div class="pkg-name">${esc(p.name)}</div>
          <div class="pkg-meta">${members.length} account${members.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="pkg-avatars">${avatarsHtml}</div>
        <div class="pkg-card-actions">
          <button class="btn btn-edit" onclick="openEditPackage('${p.id}')" title="Edit group &amp; performance settings">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>
          <button class="btn btn-del" onclick="deletePackage('${p.id}')" title="Delete group">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </div>
      <div class="pkg-link-row">
        <div class="pkg-link-field">           <span class="pkg-game-icon-wrap">
             <svg class="pkg-link-icon" id="pkg-icon-svg-${p.id}" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
             <img class="pkg-game-icon" id="pkg-icon-img-${p.id}" alt="" style="display:none"/>
           </span>
           <input type="text" class="pkg-link-input" id="pkg-link-${p.id}" placeholder="Game ID or server link for everyone to join…"
             value="${esc(p.link || '')}" onchange="setPackageLink('${p.id}', this.value);loadPackageIcon('${p.id}');"
            onkeydown="if(event.key==='Enter'){this.blur();launchPackage('${p.id}');}"/>
        </div>
        <button class="btn btn-launch pkg-launch-btn" onclick="launchPackage('${p.id}')" ${members.length ? '' : 'disabled'} title="Launch group">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
      <div class="pkg-progress" id="pkg-progress-${p.id}"></div>
    </div>`;
  }).join('');
  packages.forEach(p => { if (p.link && parsePlaceId(p.link)) loadPackageIcon(p.id); });
  packages.forEach(p => {
    (p.accountIds || []).slice(0, 6).forEach(id => {
      const m = accounts.find(a => a.id === id);
      if (m && m.userId) loadPkgAvatar(p.id, m.id, m.userId);
    });
  });
  refreshPkgAvatarStatus();
}

function openCreatePackage() {
  editingPackageId = null;
  document.getElementById('pkg-modal-title').textContent = 'New group';
  document.getElementById('in-pkg-name').value = '';
  document.getElementById('pkg-fps').value = 60;
  document.getElementById('pkg-fps-val').textContent = '60';
  document.getElementById('pkg-gfx').value = 10;
  document.getElementById('pkg-gfx-val').textContent = '10';
  document.getElementById('pkg-ram').value = 2048;
  document.getElementById('pkg-ram-val').textContent = '2048 MB';
  document.getElementById('pkg-vol').value = 100;
  document.getElementById('pkg-vol-val').textContent = '100%';
  renderPackagePicker([]);
  openModal('m-package');
  setTimeout(() => document.getElementById('in-pkg-name').focus(), 220);
}

function openEditPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  editingPackageId = id;
  document.getElementById('pkg-modal-title').textContent = 'Edit group';
  document.getElementById('in-pkg-name').value = p.name || '';
  const fps = typeof p.fpsCap === 'number' ? p.fpsCap : 60;
  const gfx = typeof p.gfxLevel === 'number' ? p.gfxLevel : 10;
  const ram = typeof p.ramLimitMb === 'number' ? p.ramLimitMb : 2048;
  const vol = typeof p.startVolume === 'number' ? p.startVolume : 100;
  document.getElementById('pkg-fps').value = fps;
  document.getElementById('pkg-fps-val').textContent = fps;
  document.getElementById('pkg-gfx').value = gfx;
  document.getElementById('pkg-gfx-val').textContent = gfx;
  document.getElementById('pkg-ram').value = ram;
  document.getElementById('pkg-ram-val').textContent = ram + ' MB';
  document.getElementById('pkg-vol').value = vol;
  document.getElementById('pkg-vol-val').textContent = vol + '%';
  renderPackagePicker(p.accountIds || []);
  openModal('m-package');
}

function renderPackagePicker(selectedIds) {
  const wrap = document.getElementById('pkg-account-picker');
  if (!accounts.length) {
    wrap.innerHTML = '<div class="pkg-pick-empty">No accounts yet. Add one from the Accounts tab first.</div>';
    updatePkgCount();
    return;
  }
  wrap.innerHTML = accounts.map(a => `
    <label class="pm-row">
      <input type="checkbox" value="${a.id}" ${selectedIds.includes(a.id) ? 'checked' : ''}/>
      <span class="pm-av" id="pm-av-${a.id}">${a.userId && _avatarCache[a.userId] ? `<img src="${esc(_avatarCache[a.userId])}" alt=""/>` : esc((a.username || '?')[0].toUpperCase())}</span>
      <span class="pm-info">
        <span class="pm-name${streamerMaskClass()}" title="${settings.streamerMode ? 'Hover to reveal' : ''}">${esc(a.nickname || a.username || 'Unknown')}</span>
        <span class="pm-meta${streamerMaskClass()}" title="${settings.streamerMode ? 'Hover to reveal' : ''}">${a.userId ? 'ID ' + a.userId : 'No ID'}</span>
      </span>
      <span class="pm-check"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
    </label>`).join('');
  updatePkgCount();
}

function updatePkgCount() {
  const el = document.getElementById('pkg-count');
  if (!el) return;
  const n = document.querySelectorAll('#pkg-account-picker input:checked').length;
  el.textContent = n + ' selected';
}

function savePackageModal() {
  const name = document.getElementById('in-pkg-name').value.trim();
  if (!name) { toast('Give the group a name', 'err'); return; }
  const checked = Array.from(document.querySelectorAll('#pkg-account-picker input:checked')).map(c => c.value);
  const fpsCap = parseInt(document.getElementById('pkg-fps').value, 10) || 60;
  const gfxLevel = parseInt(document.getElementById('pkg-gfx').value, 10) || 10;
  const ramLimitMb = parseInt(document.getElementById('pkg-ram').value, 10) || 2048;
  const startVolume = parseInt(document.getElementById('pkg-vol').value, 10);
  const volVal = isNaN(startVolume) ? 100 : startVolume;

  if (editingPackageId) {
    const p = packages.find(x => x.id === editingPackageId);
    if (p) {
      p.name = name;
      p.accountIds = checked;
      p.fpsCap = fpsCap;
      p.gfxLevel = gfxLevel;
      p.ramLimitMb = ramLimitMb;
      p.startVolume = volVal;
    }
  } else {
    packages.push({ id: Date.now().toString(), name, accountIds: checked, link: '', fpsCap, gfxLevel, ramLimitMb, startVolume: volVal });
  }
  api.savePackages(packages);
  renderPackages();
  closeModal('m-package');
  toast('Group saved', 'ok');
}

function deletePackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  confirmAction('Delete package "' + p.name + '"? The accounts themselves won\u2019t be removed.', () => {
    packages = packages.filter(x => x.id !== id);
    api.savePackages(packages);
    renderPackages();
    toast('Group deleted', 'err');
  });
}

const _pkgIconCache = new Map();
function parsePlaceId(value) {
  const m = String(value || '').trim().match(/\d{5,}/);
  return m ? m[0] : '';
}
async function fetchGameIconUrl(placeId) {
  try {
    if (_pkgIconCache.has(placeId)) return _pkgIconCache.get(placeId);
    const uni = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`).then(r => r.json());
    if (!uni || !uni.universeId) return null;
    const th = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${uni.universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`).then(r => r.json());
    const url = th && th.data && th.data[0] && th.data[0].imageUrl;
    if (url) _pkgIconCache.set(placeId, url);
    return url || null;
  } catch (e) { return null; }
}
async function loadPackageIcon(id) {
  const input = document.getElementById('pkg-link-' + id);
  const img = document.getElementById('pkg-icon-img-' + id);
  const svg = document.getElementById('pkg-icon-svg-' + id);
  if (!input || !img || !svg) return;
  const pid = parsePlaceId(input.value);
  if (!pid) { img.style.display = 'none'; svg.style.display = ''; return; }
  const url = await fetchGameIconUrl(pid);
  if (!img || !svg) return;
  if (parsePlaceId(input.value) !== pid) return; // stale response, link changed
  if (url) { img.src = url; img.style.display = 'block'; svg.style.display = 'none'; }
  else { img.style.display = 'none'; svg.style.display = ''; }
}
function setPackageLink(id, value) {
  const p = packages.find(x => x.id === id); if (!p) return;
  p.link = value.trim();
  api.savePackages(packages);
}

async function launchPackage(id) {
  const p = packages.find(x => x.id === id); if (!p) return;
  const members = (p.accountIds || []).map(aid => accounts.find(a => a.id === aid)).filter(Boolean);
  if (!members.length) { toast('This group has no accounts yet', 'err'); return; }

  const card = document.querySelector('.pkg-card[data-id="' + id + '"]');
  const btn = card ? card.querySelector('.pkg-launch-btn') : null;
  const progress = document.getElementById('pkg-progress-' + id);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin" style="width:13px;height:13px"></div>'; }
  if (progress) {
    progress.innerHTML = members.map(m => `
      <span class="pkg-chip load" id="pkg-chip-${id}-${m.id}">
        <div class="spin" style="width:9px;height:9px;border-width:2px"></div>${esc(m.nickname || m.username || '')}
      </span>`).join('');
  }

  // Unified launch workflow for groups too: sync WEAO + installed versions
  // and auto-install the executor's required build before launching anyone.
  let groupVer = 'auto';
  const prevLaunchAcc = launchAcc;
  const prevOverride = _launchGameOverride;
  // Name the group in the outdated-version notice; installRequiredVersion
  // falls back to launchAcc's username when no label override is set.
  _outdatedNoticeLabel = `Group "${p.name}"`;
  _launchGameOverride = null;
  try {
    const synced = await ensureLaunchVersionSynced();
    if (!synced) {
      toast('Selected executor needs a version install first', 'err');
      logEntry('warn', 'launch', `Group launch "${p.name}" skipped: required Roblox version could not be installed`);
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>'; }
      if (progress) progress.innerHTML = '';
      return;
    }
    groupVer = synced;
  } finally {
    launchAcc = prevLaunchAcc;
    _launchGameOverride = prevOverride;
    _outdatedNoticeLabel = null;
  }

  const link = (p.link || '').trim();
  const options = {
    fpsCap: typeof p.fpsCap === 'number' ? p.fpsCap : 60,
    gfxLevel: typeof p.gfxLevel === 'number' ? p.gfxLevel : 10,
    ramLimitMb: typeof p.ramLimitMb === 'number' ? p.ramLimitMb : 2048,
    volume: typeof p.startVolume === 'number' ? p.startVolume : undefined
  };
  let okCount = 0;
  // Launch members sequentially so Roblox bootstrap handoffs never overlap.
  for (const m of members) {
    const target = link || m.gameTarget || null;
    logEntry('info', 'launch', `Launching Roblox for ${m.username || m.id} (package)...`, { accountId: m.id, username: m.username || null, userId: m.userId || null, target: target || 'Roblox home', versionHash: groupVer });
    let res;
    try {
      res = await api.launchRoblox(m.id, m.cookie, target, groupVer, options);
    } catch (e) {
      res = { success: false, error: e.message || 'Launch request failed' };
    }
    const chip = document.getElementById('pkg-chip-' + id + '-' + m.id);
    if (res.success) {
      okCount++;
      logEntry('ok', 'launch', `Launched as ${m.username || m.id} (package)`, { accountId: m.id, username: m.username || null });
      markLaunched(m.id);
      if (chip) { chip.className = 'pkg-chip ok'; chip.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' + esc(m.nickname || m.username || ''); }
    } else if (chip) {
      if (res.cancelled) {
        chip.className = 'pkg-chip';
        chip.title = 'Launch cancelled';
        chip.innerHTML = esc(m.nickname || m.username || '');
      } else {
        chip.className = 'pkg-chip err';
        chip.title = res.error || '';
        chip.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' + esc(m.nickname || m.username || '');
        _flagCookieMaybeDead(m.id, res.error);
      }
    }
  }

  if (btn) { btn.disabled = false; btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>'; }
  toast('Launched ' + okCount + '/' + members.length + ' accounts in "' + p.name + '"', okCount === members.length ? 'ok' : 'err');
}

function switchAcctSubTab(tab) {
  const isList = tab === 'list';
  document.getElementById('acct-tab-list')?.classList.toggle('active', isList);
  document.getElementById('acct-tab-gen')?.classList.toggle('active', !isList);
  const viewList = document.getElementById('acct-subview-list');
  const viewGen = document.getElementById('acct-subview-gen');
  const ctrls = document.getElementById('acct-controls-wrap');
  if (viewList) viewList.style.display = isList ? 'flex' : 'none';
  if (viewGen) viewGen.style.display = isList ? 'none' : 'block';
  if (ctrls) ctrls.style.display = isList ? 'flex' : 'none';

  if (!isList) {
    renderGenHistory();
  }
}

function onBloxGenKeyInput() {
  const keyInput = document.getElementById('bloxgen-api-key');
  const btn = document.getElementById('btn-save-bloxgen-key');
  if (btn && keyInput) {
    btn.disabled = false;
    btn.textContent = 'Save Key';
  }
}

function saveBloxGenApiKey() {
  const keyInput = document.getElementById('bloxgen-api-key');
  const val = (keyInput?.value || '').trim();
  try { localStorage.setItem('rblx_bloxgen_api_key', val); } catch {}
  toast(val ? 'BloxGen API key saved' : 'BloxGen API key removed', 'ok');
}

let _genHistory = [];
try { _genHistory = JSON.parse(localStorage.getItem('rblx_gen_history') || '[]'); } catch {}

function saveGenHistoryItem(item) {
  _genHistory = _genHistory.filter(x => String(x.userId || x.id) !== String(item.userId || item.id));
  _genHistory.unshift(item);
  if (_genHistory.length > 5) _genHistory = _genHistory.slice(0, 5);
  try { localStorage.setItem('rblx_gen_history', JSON.stringify(_genHistory)); } catch {}
  renderGenHistory();
}

function renderGenHistory() {
  const list = document.getElementById('gen-history-list');
  if (!list) return;
  if (!_genHistory.length) {
    list.innerHTML = '<div style="font-size:12px; color:var(--t3); padding:10px 0">No accounts generated yet.</div>';
    return;
  }
  list.innerHTML = _genHistory.map(item => {
    const avatar = item.thumbUrl
      ? `<img src="${esc(item.thumbUrl)}" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid var(--bd)" alt=""/>`
      : `<div style="width:36px; height:36px; border-radius:50%; background:var(--s2); display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--t1); border:1px solid var(--bd)">${esc((item.username || '?')[0].toUpperCase())}</div>`;
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; background:var(--s2); border:1px solid var(--bd); border-radius:8px; padding:8px 12px">
        <div style="display:flex; align-items:center; gap:10px">
          ${avatar}
          <div>
            <div style="font-size:13px; font-weight:600; color:var(--t1)">${esc(item.username || 'Generated Account')}</div>
            <div style="font-size:11px; color:var(--t3)">ID: ${esc(item.userId || '-')}</div>
          </div>
        </div>
        <button class="btn btn-ghost" style="font-size:11px; padding:4px 8px" onclick="openAccountInfoModal('${item.id}')">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>Details
        </button>
      </div>
    `;
  }).join('');
}

function onSettingsBloxGenKeyInput() {
  const input = document.getElementById('setting-bloxgen-api-key');
  const btn = document.getElementById('btn-save-settings-bloxgen-key');
  if (btn && input) {
    btn.disabled = false;
    btn.textContent = 'Save Key';
  }
}

function saveSettingsBloxGenApiKey() {
  const input = document.getElementById('setting-bloxgen-api-key');
  const val = (input?.value || '').trim();
  try { localStorage.setItem('rblx_bloxgen_api_key', val); } catch {}
  toast(val ? 'BloxGen API key saved' : 'BloxGen API key removed', 'ok');
}

let _currentGenAccount = null;
async function generateBloxGenAccount() {
  const apiKey = (localStorage.getItem('rblx_bloxgen_api_key') || '').trim();
  if (!apiKey) {
    toast('Please set your BloxGen API key in Settings first', 'err');
    return;
  }
  const btn = document.getElementById('btn-gen-acct');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Generating Account…'; }

  try {
    const result = await api.generateBloxGenAccount(apiKey);
    if (!result || !result.ok) {
      throw new Error(result?.error || 'BloxGen request failed');
    }
    const d = result.data || {};

    const uname = d.username;
    const uid = String(d.userId || d.id);
    const oldPw = d.password;
    const cookie = d.cookie;

    const acctObj = {
      id: Date.now().toString(),
      username: uname,
      nickname: '',
      userId: uid,
      cookie: cookie,
      password: oldPw || '', // current password, stored so a later change is automatic
      addedAt: new Date().toISOString(),
      gameTarget: '',
      thumbUrl: ''
    };

    // Save generated account to list
    accounts.push(acctObj);
    api.saveAccounts(accounts);
    render();

    // Fetch avatar
    try {
      const avatarRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${uid}&size=150x150&format=Png&isCircular=false`);
      if (avatarRes.ok) {
        const avData = await avatarRes.json();
        if (avData.data && avData.data[0] && avData.data[0].imageUrl) {
          acctObj.thumbUrl = avData.data[0].imageUrl;
          _avatarCache[acctObj.id] = acctObj.thumbUrl;
        }
      }
    } catch {}

    saveGenHistoryItem(acctObj);
    _currentGenAccount = { acctObj, oldPw };

    // Pop up Automatic Password Change Modal
    document.getElementById('gen-modal-username').textContent = uname;
    document.getElementById('gen-modal-userid').textContent = 'ID: ' + uid;
    document.getElementById('gen-modal-old-pw').value = oldPw;
    genNewRandomPw();
    const avatarEl = document.getElementById('gen-modal-avatar');
    if (acctObj.thumbUrl) { avatarEl.src = acctObj.thumbUrl; avatarEl.style.display = 'block'; }
    else { avatarEl.style.display = 'none'; }

    openModal('m-gen-pw-change');
    toast('Account generated successfully!', 'ok');
  } catch (e) {
    console.error('Account generation error:', e);
    const msg = (e && e.message) || 'Unknown error';
    logEntry('err', 'gen', 'BloxGen account generation failed', { error: msg });
    toast(msg, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>Generate Account'; }
  }
}

// Secure random password that meets Roblox's rules (8-128 chars, letter +
// number, no spaces) and never contains the username. Regenerates if needed.
function genSecurePassword(username) {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^&*';
  const all = lower + upper + digits + symbols;
  const pick = set => set.charAt(Math.floor(Math.random() * set.length));
  let pw = '';
  do {
    pw = pick(upper) + pick(lower) + pick(digits) + pick(symbols);
    for (let i = 4; i < 16; i++) pw += pick(all);
    pw = pw.split('').sort(() => Math.random() - 0.5).join('');
  } while (username && pw.toLowerCase().includes(username.toLowerCase()));
  return pw;
}

function genNewRandomPw() {
  document.getElementById('gen-modal-new-pw').value = genSecurePassword('');
}

let _revealPw = '';
function showPwRevealModal(pw) {
  _revealPw = pw;
  document.getElementById('pw-reveal-value').textContent = pw;
  openModal('m-pw-reveal');
  try { navigator.clipboard.writeText(pw); } catch {}
}
function copyRevealPassword() {
  try { navigator.clipboard.writeText(_revealPw); } catch {}
  toast('Password copied to clipboard', 'ok');
  closeModal('m-pw-reveal');
}

function beginPostPasswordChangeRefresh(a) {
  if (!a || !a.id) return;
  _cookieStatus[a.id] = 'refreshing';
  applyCookieStatus(a.id);
  refreshAccountCookieForAction(a);
}

async function applyPasswordChange(a, cookie, currentPw, requestedPassword, options = {}) {
  const newPw = requestedPassword || genSecurePassword(a.username || '');
  const reveal = options.reveal !== false;
  const announce = options.announce !== false;
  let ck = cookie;
  let attempt = 0;
  for (;;) {
    const res = await api.changePassword(a.id, ck, currentPw || '', newPw);
    if (res && res.ok) {
      a.password = newPw;
      if (res.cookie) {
        // Roblox may rotate the session directly in the password-change response.
        // Keep that verified cookie instead of starting another login flow.
        a.cookie = res.cookie;
        try { await api.updateAccount(a.id, { password: newPw, cookie: res.cookie }); } catch {}
        _cookieStatus[a.id] = 'ok';
        _cookieCheckedAt[a.id] = Date.now();
        applyCookieStatus(a.id);
        render();
        if (reveal) showPwRevealModal(newPw);
        if (announce) toast('Password changed — session cookie kept active', 'ok');
      } else {
        // If Roblox did not rotate a cookie in the response, obtain a new one
        // through the saved credentials/challenge flow.
        try { await api.updateAccount(a.id, { password: newPw }); } catch {}
        beginPostPasswordChangeRefresh(a);
        if (reveal) showPwRevealModal(newPw);
        if (announce) toast('Password changed — refreshing your cookie in the background…', 'ok');
      }
      logEntry('ok', 'cookie', `Password changed for ${a.username || a.id} (secure random generated)`, { accountId: a.id });
      return true;
    }
    const err = (res && res.error) || 'Unknown error';
    const code = (res && res.code) || null;
    if (code === 'not-authenticated' && attempt === 0) {
      attempt = 1;
      if (await refreshAccountCookieForAction(a)) {
        ck = a.cookie;
        continue;
      }
    }
    if (code === 'challenge') {
      toast(err, 'err');
      logEntry('warn', 'cookie', `Password change for ${a.username || a.id} blocked by Roblox's security check — must be completed in a browser`, { accountId: a.id, username: a.username || null });
    } else {
      toast('Could not change password: ' + err, 'err');
      logEntry('err', 'cookie', `Password change failed for ${a.username || a.id}: ${err}`, { accountId: a.id, username: a.username || null });
    }
    return false;
  }
}

const _backgroundRefreshBusy = new Set();
async function adoptCookieFromStoreAfterRefresh(a) {
  try {
    const res = await api.refreshCookieFromStore(a.id, a.userId);
    if (!res || !res.ok || !res.cookie) return false;
    a.cookie = res.cookie;
    if (res.username) a.username = res.username;
    try { await api.updateAccount(a.id, { cookie: res.cookie, username: a.username }); } catch {}
    _cookieStatus[a.id] = 'ok';
    _cookieCheckedAt[a.id] = Date.now();
    applyCookieStatus(a.id);
    render();
    return true;
  } catch { return false; }
}

async function refreshCookieInVisibleBrowser(a) {
  if (!a || !a.userId) return false;
  const targetUserId = String(a.userId);
  try {
    // The hidden browser may be blocked by a captcha/2FA. Reuse the normal
    // browser-login flow so Roblox can display that challenge to the user.
    closeModal('m-acct-info');
    openLogin();
    await startBrowserLogin(a.username && a.password ? { username: a.username, password: a.password } : null);
    const updated = accounts.find(x => String(x.userId) === targetUserId);
    if (!updated || !updated.cookie) return false;
    const valid = await api.validateCookie(updated.cookie);
    if (!valid || !valid.ok) return false;
    Object.assign(a, updated);
    _cookieStatus[a.id] = 'ok';
    _cookieCheckedAt[a.id] = Date.now();
    applyCookieStatus(a.id);
    render();
    return true;
  } catch (e) {
    console.error('visible cookie refresh failed:', e);
    return false;
  }
}

async function refreshAccountCookieForAction(a, { silent = false, validateCurrent = false } = {}) {
  if (!a || !a.id) return false;
  if (validateCurrent && a.cookie) {
    try {
      const current = await api.validateCookie(a.cookie);
      if (current && current.ok) {
        _cookieStatus[a.id] = 'ok';
        _cookieCheckedAt[a.id] = Date.now();
        applyCookieStatus(a.id);
        return true;
      }
    } catch {}
  }
  _cookieStatus[a.id] = 'refreshing';
  applyCookieStatus(a.id);
  if (await adoptCookieFromStoreAfterRefresh(a)) return true;
  const ok = await refreshCookieInBackground(a, !silent, silent);
  if (ok) return true;
  // Explicit actions may fall back to a visible login for captcha/2FA. Health
  // checks pass silent:true and never open a browser unexpectedly.
  if (!silent && await refreshCookieInVisibleBrowser(a)) return true;
  if (_cookieStatus[a.id] === 'refreshing') {
    _cookieStatus[a.id] = 'dead';
    applyCookieStatus(a.id);
  }
  return false;
}

async function refreshCookieInBackground(a, manual, silent = false) {
  if (!a || !a.username || !a.password) {
    if (manual) toast('No stored password for this account — add it once via "Sign in with Roblox" or paste a fresh cookie', 'warn');
    // Can't re-login automatically, so a post-password-change account is
    // genuinely dead until the user re-adds it.
    if (_cookieStatus[a.id] === 'refreshing') { _cookieStatus[a.id] = 'dead'; applyCookieStatus(a.id); }
    return false;
  }
  if (_backgroundRefreshBusy.has(a.id)) {
    if (manual) toast('A cookie refresh is already running — wait a moment', 'warn');
    return false;
  }
  _backgroundRefreshBusy.add(a.id);
  try {
    if (!silent) toast('Refreshing cookie in the background…', 'ok');
    // Renderer-side cap so the busy flag can never stick even if the IPC hangs.
    const res = await Promise.race([
      api.reloginHeadless(a.username, a.password),
      new Promise(r => setTimeout(() => r({ ok: false, error: 'Background login timed out' }), 75000)),
    ]);
    if (!res || !res.ok) {
      if (await adoptCookieFromStoreAfterRefresh(a)) {
        if (!silent) toast('Cookie refreshed automatically — account is live again', 'ok');
        logEntry('ok', 'cookie', `Recovered fresh cookie from the Roblox session store for ${a.username || a.id}`, { accountId: a.id, userId: a.userId || null });
        return true;
      }
      if (res && res.needs2fa) {
        if (!silent) toast('This account has 2-step verification — complete the code once in a browser window to refresh the cookie', 'warn');
        logEntry('warn', 'cookie', `Cookie refresh blocked by 2-step verification for ${a.username || a.id}`, { accountId: a.id });
      } else if (res && res.captcha) {
        if (!silent) toast(res.error, 'warn');
        logEntry('warn', 'cookie', `Cookie refresh blocked by a captcha for ${a.username || a.id}`, { accountId: a.id });
      } else {
        if (!silent) toast('Cookie refresh failed: ' + ((res && res.error) || 'unknown error'), 'warn');
        logEntry('err', 'cookie', `Cookie refresh failed for ${a.username || a.id}: ${res && res.error}`, { accountId: a.id });
      }
      // The re-login is definitively over and the old cookie is dead — surface
      // the expired state now instead of leaving the account stuck mid-refresh.
      if (_cookieStatus[a.id] === 'refreshing') { _cookieStatus[a.id] = 'dead'; applyCookieStatus(a.id); }
      return false;
    }
    a.cookie = res.cookie;
    if (res.username && res.username !== a.username) a.username = res.username;
    try { await api.updateAccount(a.id, { cookie: res.cookie, username: a.username }); } catch {}
    _cookieStatus[a.id] = 'ok'; // the fresh cookie just authenticated — keep the badge off
    applyCookieStatus(a.id);
    render();
    if (!silent) toast('Cookie refreshed automatically — account is live again', 'ok');
    logEntry('ok', 'cookie', `Automatically refreshed cookie for ${a.username || a.id}`, { accountId: a.id, userId: res.userId || null });
    return true;
  } catch (e) {
    console.error('background cookie refresh failed:', e);
    if (await adoptCookieFromStoreAfterRefresh(a)) {
      if (!silent) toast('Cookie refreshed automatically — account is live again', 'ok');
      return true;
    }
    if (manual && !silent) toast('Cookie refresh failed: ' + (e?.message || 'unknown error'), 'err');
    if (_cookieStatus[a.id] === 'refreshing') { _cookieStatus[a.id] = 'dead'; applyCookieStatus(a.id); }
    return false;
  } finally {
    _backgroundRefreshBusy.delete(a.id);
  }
}

async function doChangeGenPassword() {
  const btn = document.getElementById('btn-change-gen-pw');
  const newPw = (document.getElementById('gen-modal-new-pw') || {}).value || '';
  const acc = _currentGenAccount && _currentGenAccount.acctObj;
  const oldPw = _currentGenAccount && _currentGenAccount.oldPw;
  if (!acc || !acc.cookie || !oldPw || !newPw) { toast('Missing data for the password change', 'err'); closeModal('m-gen-pw-change'); return; }
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Changing Password…'; }
  try {
    const changed = await applyPasswordChange(acc, acc.cookie, oldPw, newPw, { reveal: false, announce: false });
    if (!changed) return;
    try { navigator.clipboard.writeText(newPw); } catch {}
    toast('Password changed and saved — refreshing cookie in the background…', 'ok');
    logEntry('ok', 'cookie', `Password changed for generated account ${acc.username || acc.id}`, { accountId: acc.id });
  } catch (e) {
    toast('Password change failed: ' + (e?.message || 'Unknown error'), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>Change Password &amp; Save'; }
    closeModal('m-gen-pw-change');
  }
}

let _aiAccount = null;
function openAccountInfoModal(id) {
  const a = accounts.find(x => x.id === id) || _genHistory.find(x => String(x.id) === String(id));
  if (!a) return;
  _aiAccount = a;

  const uname = a.username || 'Unknown';
  const uid = a.userId || '-';
  const nickname = a.nickname || '';
  const dateStr = a.addedAt ? new Date(a.addedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
  const groupName = (packages.find(p => (p.accountIds || []).includes(a.id)))?.name || 'None';

  setStreamerText('ai-modal-name', a.displayName || uname);
  setStreamerText('ai-modal-handle', '@' + uname);
  setStreamerText('ai-modal-group', 'Group: ' + groupName);
  setStreamerText('ai-modal-user', uname);
  // `nickname` is this app's alias, not the Roblox display name.
  setStreamerText('ai-modal-display', a.displayName || uname);
  if (a.userId) {
    loadUserInfo(a.userId, info => {
      if (_aiAccount !== a || !document.getElementById('m-acct-info')?.classList.contains('open')) return;
      const displayName = info?.displayName || a.displayName || uname;
      setStreamerText('ai-modal-name', displayName);
      setStreamerText('ai-modal-display', displayName);
    });
  }
  setStreamerText('ai-modal-userid', uid);
  // Robux balance and the app-local alias are not account identifiers, so they
  // stay readable in Streamer Mode (only username/display/ID get masked).
  const robuxEl = document.getElementById('ai-modal-robux');
  if (robuxEl) { robuxEl.textContent = '0'; robuxEl.classList.remove('streamer-mask'); robuxEl.title = ''; }
  setStreamerText('ai-modal-added', dateStr);
  const aliasEl = document.getElementById('ai-modal-alias');
  if (aliasEl) { aliasEl.textContent = nickname || '—'; aliasEl.classList.remove('streamer-mask'); aliasEl.title = ''; }
  // Password is NOT displayed in the info modal — it's only shown in the
  // one-time reveal modal after a change.

  const avatarEl = document.getElementById('ai-modal-avatar');
  const thumb = a.thumbUrl || (a.userId ? _avatarCache[a.userId] : null);
  if (thumb) {
    avatarEl.src = thumb;
    avatarEl.style.display = 'block';
  } else if (a.userId) {
    avatarEl.src = '';
    avatarEl.style.display = 'block';
    fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${a.userId}&size=150x150&format=Png&isCircular=false`)
      .then(r => r.json())
      .then(d => {
        const url = d?.data?.[0]?.imageUrl;
        if (url) {
          _avatarCache[a.userId] = url;
          avatarEl.src = url;
        }
      }).catch(() => {});
  } else {
    avatarEl.src = '';
    avatarEl.style.display = 'block';
  }

  openModal('m-acct-info');
  const changeBtn = document.getElementById('ai-btn-change-password');
  if (changeBtn && !_aiActionBusy.has('ai-btn-change-password')) {
    changeBtn.disabled = _cookieStatus[a.id] === 'refreshing';
  }
}

const _aiActionBusy = new Set();
async function runAiAction(actionId, busyLabel, fn) {
  if (_aiActionBusy.has(actionId)) return false;
  const btn = document.getElementById(actionId);
  if (btn?.disabled) return false;
  _aiActionBusy.add(actionId);
  const original = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="spin" style="width:13px;height:13px;border-width:2px"></div>${busyLabel}`;
  }
  try { return await fn(); }
  finally {
    _aiActionBusy.delete(actionId);
    if (btn) {
      btn.innerHTML = original;
      const account = _aiAccount || editAcc;
      const isPasswordAction = actionId === 'ai-btn-change-password' || actionId === 'edit-change-roblox-password';
      const refreshInFlight = isPasswordAction && account && _cookieStatus[account.id] === 'refreshing';
      btn.disabled = !!refreshInFlight;
    }
  }
}

async function aiCopyCookie() {
  if (!_aiAccount || !_aiAccount.cookie) { toast('No cookie found', 'err'); return; }
  return runAiAction('ai-btn-copy-cookie', 'Copying…', async () => {
    await navigator.clipboard.writeText(_aiAccount.cookie);
    toast('Cookie copied to clipboard', 'ok');
    return true;
  });
}

function copyAccountPassword() {
  if (!_aiAccount || !_aiAccount.password) { toast('No password saved for this account', 'err'); return; }
  navigator.clipboard.writeText(_aiAccount.password).then(() => toast('Password copied to clipboard', 'ok'));
}

async function aiRefreshProfile() {
  if (!_aiAccount) return;
  return runAiAction('ai-btn-refresh', 'Refreshing…', async () => {
    const account = _aiAccount;
    const ok = await refreshAccountCookieForAction(account, { validateCurrent: true });
    if (!ok) {
      toast('Could not refresh the cookie. Roblox may require a captcha or 2-step verification.', 'err');
      return false;
    }
    if (account.userId) loadUserInfo(account.userId, () => {});
    render();
    toast('Cookie and profile refreshed', 'ok');
    return true;
  });
}

async function aiChangePassword() {
  if (!_aiAccount || !_aiAccount.cookie) { toast('No cookie found', 'err'); return; }
  const account = _aiAccount;
  if (_cookieStatus[account.id] === 'refreshing') {
    toast('A cookie refresh is already running for this account — wait a moment', 'warn');
    return false;
  }
  return runAiAction('ai-btn-change-password', 'Changing password…', () =>
    applyPasswordChange(account, account.cookie, account.password || '')
  );
}

async function aiOpenBrowser() {
  if (!_aiAccount) return;
  return runAiAction('ai-btn-open-browser', 'Opening browser…', async () => {
    const account = _aiAccount;
    if (!await refreshAccountCookieForAction(account, { validateCurrent: true })) {
      toast('No valid cookie is available. Complete any Roblox captcha or 2-step verification, then try again.', 'err');
      return false;
    }
    toast('Launching browser session...', 'ok');
    const res = await api.openBrowserWithCookie(account.cookie, 'https://www.roblox.com/home');
    if (res && !res.ok) toast(res.error || 'Failed to open browser', 'err');
    return !!(!res || res.ok);
  });
}

// Inline alias (nickname) editor inside the Account info modal. Clicking the
// ALIAS value swaps it for a text input; Enter/blur saves, Escape cancels.
let _aiAliasEditing = false;
function editAliasFromInfo() {
  const a = _aiAccount;
  if (!a || _aiAliasEditing) return;
  const el = document.getElementById('ai-modal-alias');
  if (!el) return;
  _aiAliasEditing = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = a.nickname || '';
  input.maxLength = 40;
  input.placeholder = '—';
  input.style.cssText = 'flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--t1);background:transparent;border:none;outline:none;padding:0';
  el.replaceWith(input);
  input.focus();
  input.select();
  const restore = () => {
    const div = document.createElement('div');
    div.id = 'ai-modal-alias';
    div.setAttribute('onclick', 'editAliasFromInfo()');
    div.title = 'Click to edit alias';
    div.style.cssText = 'flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:text';
    div.textContent = a.nickname || '—';
    input.replaceWith(div);
  };
  const finish = save => {
    if (!_aiAliasEditing) return;
    _aiAliasEditing = false;
    const val = input.value.trim();
    if (save && val !== (a.nickname || '')) {
      api.updateAccount(a.id, { nickname: val }).then(updated => {
        if (updated) {
          a.nickname = updated.nickname || '';
          if (_aiAccount === a) _aiAccount = updated;
          const idx = accounts.findIndex(x => x.id === a.id);
          if (idx !== -1) accounts[idx] = updated;
          render();
        }
        restore();
        toast(a.nickname ? 'Alias saved' : 'Alias cleared', 'ok');
      }).catch(() => { restore(); toast('Could not save alias', 'err'); });
    } else {
      restore();
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
let _saveKeyTimer;
function onKeyInput() {
  const btn = document.getElementById('btn-save-key');
  if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
}
async function saveKeySettings() {
  const keyVal = document.getElementById('custom-key').value;
  const btn = document.getElementById('btn-save-key');
  if (btn.disabled) return;
  clearTimeout(_saveKeyTimer);
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  _saveKeyTimer = setTimeout(async () => {
    try {
      await api.saveSettings({ encryptionType: selectedEnc });
      // enc:setKey changes the key and re-encrypts accounts in one step.
      const r = await api.encSetKey(keyVal);
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'could not update key');
      if (!keyVal.trim()) throw new Error('Encryption key cannot be empty.');
      settings.encryptionType = selectedEnc; settings.keySet = true;
      document.getElementById('custom-key').value = '';
      // Reload accounts so the renderer holds cookies under the new key.
      try { accounts = await api.loadAccounts(); render(); } catch {}
      toast('Encryption key updated', 'ok');
      applySettings();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }, 300);
}

let _modalReturnFocus = null;
function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (!document.querySelector('.overlay.open')) _modalReturnFocus = document.activeElement;
  modal.classList.add('open');
  requestAnimationFrame(() => {
    const target = Array.from(modal.querySelectorAll('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'))
      .find(el => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden');
    if (target) target.focus();
  });
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('open');
  if (document.querySelector('.overlay.open')) return;
  const returnFocus = _modalReturnFocus;
  _modalReturnFocus = null;
  if (returnFocus && typeof returnFocus.focus === 'function' && returnFocus.isConnected) requestAnimationFrame(() => returnFocus.focus());
}
function setStatus(id, type, html) { const el = document.getElementById(id); el.className = 'mst ' + type; el.innerHTML = html; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(msg, type) {
  const el = document.getElementById('toast');
  const icon = type === 'ok'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
    : type === 'warn'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
  el.innerHTML = icon + esc(msg);
  el.className = 'toast show ' + type; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2700);
}

async function refreshMultiStatus() {
  const s = await api.multiInstanceStatus();
  if (!s.enabled) { await api.saveSettings({ multiInstance: true }); settings.multiInstance = true; }
}

async function refreshProtocolStatus() {
  try {
    const res = await api.getProtocolStatus();
    const desc = document.getElementById('protocol-status-desc');
    const bdg = document.getElementById('protocol-status-badge');
    if (!desc || !bdg) return;
    if (res && res.isRegistered) {
      desc.textContent = 'Registered to this launcher (roblox-player:// & roblox://)';
      bdg.textContent = 'Registered';
      bdg.className = 'badge g';
    } else {
      desc.textContent = 'Not registered to this launcher';
      bdg.textContent = 'Not registered';
      bdg.className = 'badge muted';
    }
  } catch {}
}

async function registerProtocolHandler() {
  const res = await api.registerProtocol();
  if (res && res.ok) {
    toast('Registered as default Roblox launcher', 'ok');
    logEntry('ok', 'protocol', 'Registered application as roblox-player:// handler');
  } else {
    toast(res?.error || 'Could not register handler', '');
    logEntry('err', 'protocol', `Protocol registration failed: ${res?.error || 'unknown'}`);
  }
  refreshProtocolStatus();
}

async function removeProtocolHandler() {
  const res = await api.removeProtocol();
  if (res && res.ok) {
    toast('Removed Roblox protocol handler', 'ok');
    logEntry('info', 'protocol', 'Removed roblox-player:// protocol handler');
  } else {
    toast(res?.error || 'Could not remove handler', '');
  }
  refreshProtocolStatus();
}

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('mousedown', e => {
    if (e.target === o && o.dataset.backdropClose === 'true') closeModal(o.id);
  });
});
document.addEventListener('keydown', e => {
  // Ctrl/Cmd+F opens native-style find on the logs page.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && document.getElementById('page-logs')?.classList.contains('active')) {
    e.preventDefault(); openLogFind(); return;
  }
  // Find-bar keys: Enter = next, Shift+Enter = previous, Esc = close.
  if (e.target && e.target.id === 'log-find-input') {
    if (e.key === 'Enter') { e.preventDefault(); logFind(e.shiftKey); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeLogFind(); return; }
  }
  if (e.key === 'Escape') {
    const lf = document.getElementById('log-find');
    if (lf && lf.style.display !== 'none') { closeLogFind(); return; }
    closeAllCdd();
    const editEl = document.getElementById('m-edit');
    if (editEl.classList.contains('open')) {
      if (document.activeElement !== document.getElementById('in-login-password') && document.activeElement !== document.getElementById('in-nickname')) closeModal('m-edit');
    } else document.querySelectorAll('.overlay.open').forEach(m => closeModal(m.id));
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); openLogin(); }
  // "/" focuses the account search (when not already typing in a field).
  if (e.key === '/' && document.getElementById('page-accounts')?.classList.contains('active')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    document.getElementById('acct-search')?.focus();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && document.getElementById('m-edit').classList.contains('open')) {
    e.preventDefault(); saveEdit();
  }
});

let chartTab = 'popular';
let allCharts = {};
let chartsLoaded = false;

function switchChartTab(tab) {
  chartTab = tab;
  document.querySelectorAll('#page-charts .tab-btn').forEach(t => t.classList.remove('active'));
  document.getElementById('ctab-' + tab).classList.add('active');
  const s = document.getElementById('chart-search'); if (s) s.value = '';
  _searchMode = false;
  if (chartsLoaded) renderCharts(allCharts[tab] || [], false);
}

async function loadCharts() {
  const grid = document.getElementById('charts-grid');
  const loading = document.getElementById('charts-loading');
  const empty = document.getElementById('charts-empty');
  chartsLoaded = false;
  grid.style.display = 'none'; empty.style.display = 'none'; loading.style.display = 'flex';

  try {
    // Use official Roblox explore-api with a random sessionId per load
    const [popular, trending] = await Promise.all([
      fetchRobloxGames('top-playing-now'),
      fetchRobloxGames('top-rated'),
    ]);
    allCharts = { popular, trending };
    chartsLoaded = true;
    loading.style.display = 'none';
    renderRecentGames();
    renderCharts(allCharts[chartTab] || [], false);
  } catch(e) {
    console.error('Charts load error:', e);
    loading.style.display = 'none';
    empty.style.display = 'flex';
  }
}

function randomGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function fetchRobloxGames(sortId) {
  // Official Roblox explore API
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${sessionId}&sortId=${sortId}&device=computer&country=all`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();

  // Response shape: { sorts: [{ games: [...] }] } or { games: [...] }
  const games = d.games || (d.sorts && d.sorts[0] && d.sorts[0].games) || [];
  if (!games.length) throw new Error('No games in response');

  // Fetch thumbnails for all universeIds
  let thumbMap = {};
  try {
    const universeIds = games.map(g => g.universeId).filter(Boolean).join(',');
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const thumbData = await thumbRes.json();
      (thumbData.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return games.map(g => ({
    universeId: g.universeId,
    placeId: g.rootPlaceId || g.placeId,
    name: g.name,
    playerCount: g.playerCount,
    thumbUrl: thumbMap[g.universeId] || ''
  }));
}

let _chartGameMap = {};
let _searchDebounce = null;
let _searchMode = false;

function renderCharts(games, searchMode) {
  const grid = document.getElementById('charts-grid');
  const emptyEl = document.getElementById('charts-empty');
  const loading = document.getElementById('charts-loading');
  loading.style.display = 'none';
  _chartGameMap = {};
  if (!games || !games.length) {
    emptyEl.style.display = 'flex';
    grid.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = games.map((g, i) => {
    _chartGameMap[i] = g;
    const players = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing' : '';
    const rankLabel = searchMode ? `<div class="chart-card-rank">Search result</div>` : `<div class="chart-card-rank">#${i + 1}</div>`;
    const thumb = g.thumbUrl
      ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=chart-card-thumb-ph><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'28\' height=\'28\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><rect x=\'2\' y=\'6\' width=\'20\' height=\'12\' rx=\'2\'/><path d=\'m22 10-6.3 3.15a1 1 0 0 1-.9 0L2 7\'/></svg></div>'"/>`
      : `<div class="chart-card-thumb-ph"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m22 10-6.3 3.15a1 1 0 0 1-.9 0L2 7"/></svg></div>`;
    return `<div class="chart-card" style="animation-delay:${i * 12}ms" onclick="openGameModal(${i})" title="View game info">
      ${thumb}
      <div class="chart-card-body">
        ${rankLabel}
        <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
        ${players ? `<div class="chart-card-stat"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${players}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function searchRobloxGames(query) {
  const sessionId = randomGuid();
  const url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${sessionId}`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();

  // Extract game universe IDs from omni-search results
  const contents = d.searchResults || [];
  const gameSection = contents.find(s => s.contentGroupType === 'Game') || contents[0];
  if (!gameSection || !gameSection.contents) return [];

  const universeIds = gameSection.contents.map(c => c.contentId).filter(Boolean);
  if (!universeIds.length) return [];

  // Fetch full game details
  const detailsRes = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeIds.join(',')}`);
  const details = detailsRes.ok ? await detailsRes.json() : { data: [] };
  const detailMap = {};
  (details.data || []).forEach(g => { detailMap[g.id] = g; });

  // Fetch thumbnails
  let thumbMap = {};
  try {
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeIds.join(',')}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
    );
    if (thumbRes.ok) {
      const td = await thumbRes.json();
      (td.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl; });
    }
  } catch {}

  return universeIds.map(uid => {
    const det = detailMap[uid] || {};
    return {
      universeId: uid,
      placeId: det.rootPlaceId,
      name: det.name,
      playerCount: det.playing,
      thumbUrl: thumbMap[uid] || ''
    };
  }).filter(g => g.placeId);
}

async function resolvePlaceId(placeId) {
  const id = String(placeId).trim();
  if (!/^\d+$/.test(id)) return null;
  // Place -> universe
  const u = await fetch(`https://apis.roblox.com/universes/v1/places/${id}/universe`);
  if (!u.ok) throw new Error(`HTTP ${u.status}`);
  const ud = await u.json();
  if (!ud || !ud.universeId) return null;
  const uni = ud.universeId;
  // Universe -> game details (name, player count)
  const r = await fetch(`https://games.roblox.com/v1/games?universeIds=${uni}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const det = Array.isArray(d.data) ? d.data[0] : null;
  if (!det || !det.name) return null;
  let thumbUrl = '';
  try {
    const t = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${uni}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`);
    if (t.ok) {
      const td = await t.json();
      thumbUrl = td?.data?.[0]?.imageUrl || '';
    }
  } catch {}
  return {
    placeId: id, // launch into exactly what the user typed
    universeId: uni,
    name: det.name,
    playerCount: typeof det.playing === 'number' ? det.playing : undefined,
    thumbUrl
  };
}

const _gamePickerCacheKey = 'rblx_cached_launch_game';
let _cachedLaunchGame = null;
try { _cachedLaunchGame = JSON.parse(localStorage.getItem(_gamePickerCacheKey) || 'null'); } catch { _cachedLaunchGame = null; }
function _saveCachedLaunchGame(g) { _cachedLaunchGame = g; try { localStorage.setItem(_gamePickerCacheKey, JSON.stringify(g)); } catch {} }
let _gpQuery = '', _gpDebounce = null, _gpMap = {};

// ─── Favorite games (max 2) ──────────────────────────────────────────────────
// Starred from the Launch Game picker search results; shown below the results
// under a divider, capped at 2 entries.
const GP_FAV_KEY = 'rblx_favorite_games';
const GP_FAV_MAX = 2;
let _gpFavorites = [];
try { _gpFavorites = JSON.parse(localStorage.getItem(GP_FAV_KEY) || '[]'); } catch { _gpFavorites = []; }
if (!Array.isArray(_gpFavorites)) _gpFavorites = [];

function gpFavIsFavorite(placeId) {
  return _gpFavorites.some(f => String(f.placeId) === String(placeId));
}

function gpFavToggle(placeId) {
  const existing = _gpFavorites.findIndex(f => String(f.placeId) === String(placeId));
  if (existing !== -1) {
    _gpFavorites.splice(existing, 1);
  } else {
    if (_gpFavorites.length >= GP_FAV_MAX) {
      toast(`You can favorite up to ${GP_FAV_MAX} games \u2014 remove one first`, 'warn');
      return;
    }
    const g = _gpMap[placeId] || _cachedLaunchGame;
    const snap = g && String(g.placeId) === String(placeId)
      ? { placeId: g.placeId, name: g.name, thumbUrl: g.thumbUrl || '' }
      : { placeId, name: 'Unknown', thumbUrl: '' };
    _gpFavorites.unshift(snap);
  }
  try { localStorage.setItem(GP_FAV_KEY, JSON.stringify(_gpFavorites)); } catch {}
  renderGamePickerFavorites();
  gpRerenderResultStars();
}

// Re-star the currently rendered search results after a toggle.
function gpRerenderResultStars() {
  const list = document.getElementById('gp-list');
  if (!list) return;
  list.querySelectorAll('.gp-fav-btn[data-pid]').forEach(btn => {
    btn.classList.toggle('active', gpFavIsFavorite(btn.dataset.pid));
  });
}

// Favorites strip rendered below the search results, separated by a divider.
function renderGamePickerFavorites() {
  const favList = document.getElementById('gp-fav-list');
  const divider = document.getElementById('gp-fav-divider');
  const favHeader = document.getElementById('gp-fav-header');
  const favCount = document.getElementById('gp-fav-count');
  if (!favList || !divider) return;
  if (!_gpFavorites.length) {
    favList.style.display = 'none';
    divider.style.display = 'none';
    if (favHeader) favHeader.style.display = 'none';
    return;
  }
  favList.style.display = 'flex';
  divider.style.display = 'block';
  if (favHeader) favHeader.style.display = 'flex';
  if (favCount) favCount.textContent = `${_gpFavorites.length}/${GP_FAV_MAX}`;
  favList.innerHTML = _gpFavorites.map((g, i) => `
    <div class="chart-card gp-fav-card" role="option" tabindex="0" aria-label="Favorite ${esc(g.name || 'Unknown')}" onclick="gpSelectIndex('fav_${i}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();gpSelectIndex('fav_${i}')}" title="Launch into ${esc(g.name || '')}">
      ${g.thumbUrl ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy"/>` : `<div class="chart-card-thumb-ph"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m22 10-6.3 3.15a1 1 0 0 1-.9 0L2 7"/></svg></div>`}
      <div class="chart-card-body">
        <div class="chart-card-rank">Favorite</div>
        <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
      </div>
      <button class="gp-fav-btn active" data-pid="${esc(String(g.placeId))}" title="Remove from favorites" onclick="event.stopPropagation();gpFavToggle('${esc(String(g.placeId))}')">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
      </button>
    </div>`).join('');
}

// Hide the search results dropdown and mirror the aria-expanded state.
function gpHideDropdown() {
  const dropdown = document.getElementById('gp-dropdown');
  const inp = document.getElementById('gp-search');
  if (dropdown) dropdown.classList.remove('visible');
  if (inp) inp.setAttribute('aria-expanded', 'false');
}

// Close the dropdown whenever the user presses anywhere outside the search
// box area. Presses inside the wrapper (including on result cards and the
// favorite strip) are left alone so their click handlers still fire.
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (t && typeof t.closest === 'function' && t.closest('.gp-search-wrap')) return;
  const dropdown = document.getElementById('gp-dropdown');
  if (dropdown && dropdown.classList.contains('visible')) gpHideDropdown();
});

function openGamePicker() {
  _gpQuery = '';
  _gpMap = {};
  const inp = document.getElementById('gp-search');
  if (inp) { inp.value = ''; }
  gpHideDropdown();
  renderGamePickerCached();
  renderGamePickerOutdatedNotice();
  renderGamePickerFavorites();
  // Refresh WEAO in the background so the outdated notice reflects reality
  // even if executor data went stale since the last open.
  loadWeaoForLaunch().then(() => renderGamePickerOutdatedNotice()).catch(() => {});
  const list = document.getElementById('gp-list');
  const hint = document.getElementById('gp-hint');
  // With a cached selection, Enter already launches \u2014 the hint would be wrong.
  if (hint) hint.style.display = (launchAcc && launchAcc.gameTarget) ? 'none' : '';
  if (list) list.innerHTML = '';
  const launchBtn = document.getElementById('gp-launch-btn');
  if (launchBtn) launchBtn.disabled = !_cachedLaunchGame?.placeId;
  if (inp) {
    inp.setAttribute('aria-expanded', 'false');
    setTimeout(() => inp.focus(), 60);
  }
  openModal('m-game-picker');
}

// Small inline notice in the game picker: shown when the installed Roblox
// build does not match the selected executor's required WEAO version (or no
// usable version is installed). No popup \u2014 purely informational.
function renderGamePickerOutdatedNotice() {
  const box = document.getElementById('gp-outdated');
  const txt = document.getElementById('gp-outdated-text');
  if (!box || !txt) return;
  const info = outdatedVersionInfo();
  if (!info) { box.style.display = 'none'; return; }
  const executorName = _defaultExecutor || 'the selected executor';
  txt.textContent = info.currentHash
    ? `Roblox ${truncate(info.currentHash, 18)} is outdated \u2014 ${executorName} needs ${truncate(info.requiredHash, 18)}. It will be updated automatically on launch.`
    : `No usable Roblox version installed \u2014 ${executorName}'s required version will be downloaded automatically on launch.`;
  box.style.display = 'flex';
}

function renderGamePickerCached() {
  const chip = document.getElementById('gp-cached');
  if (!chip) return;
  if (!_cachedLaunchGame || !_cachedLaunchGame.placeId) { chip.style.display = 'none'; return; }
  const g = _cachedLaunchGame;
  chip.style.display = 'flex';
  chip.innerHTML = `<div class="gp-cached-thumb">${g.thumbUrl ? `<img src="${esc(g.thumbUrl)}" alt="" onerror="this.style.display='none'"/>` : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><path d="M6 8h12a4 4 0 0 1 3.86 5l-1.5 6A2 2 0 0 1 18.42 20H17a2 2 0 0 1-1.79-1.11L14.5 17h-5l-.71 1.89A2 2 0 0 1 7 20H5.58a2 2 0 0 1-1.94-1.52l-1.5-6A4 4 0 0 1 6 8Z"/></svg>`}</div>
    <div style="flex:1;min-width:0">
      <div class="gp-cached-label">Currently selected</div>
      <div class="gp-cached-name">${esc(g.name || 'Game ' + g.placeId)}</div>
    </div>`;
  const launchBtn = document.getElementById('gp-launch-btn');
  if (launchBtn) launchBtn.disabled = !g.placeId;
}

let _gpLaunching = false;
async function _gpLaunch() {
  if (_gpLaunching) return;
  _gpLaunching = true;
  try {
    // Same unified workflow as every other launch path: sync WEAO + installed
    // versions, then auto-install the executor's required build if missing.
    const chosenVer = await ensureLaunchVersionSynced();
    if (!chosenVer) {
      toast('Selected executor needs a version install first', 'err');
      logEntry('warn', 'launch', 'Launch Game skipped: required Roblox version could not be installed');
      return;
    }
    // Pin the resolved build so doLaunch() cannot fall back to another hash.
    _launchRequiredVersionHash = chosenVer === 'auto' ? null : chosenVer;
    if (chosenVer !== 'auto') _selectedVersionHash = chosenVer;
    await doLaunch();
  } finally { _gpLaunching = false; }
}

function gpLaunchCached() {
  if (!_cachedLaunchGame || !_cachedLaunchGame.placeId) return;
  saveRecentGame(_cachedLaunchGame); // remember the game being launched
  _launchGameOverride = { placeId: _cachedLaunchGame.placeId, name: _cachedLaunchGame.name };
  closeModal('m-game-picker');
  _gpLaunch();
}

function gpSelectIndex(i) {
  // 'fav_<n>' selects from the favorites strip below the results.
  if (typeof i === 'string' && i.startsWith('fav_')) {
    const fav = _gpFavorites[parseInt(i.slice(4), 10)];
    if (fav) gpSelectGame(fav);
    return;
  }
  gpSelectGame(_gpMap[i]);
}

function gpSelectGame(g) {
  if (!g || !g.placeId) return;
  const snap = { placeId: g.placeId, name: g.name, thumbUrl: g.thumbUrl || '' };
  _saveCachedLaunchGame(snap);
  saveRecentGame(snap);
  renderGamePickerCached();
  renderGamePickerFavorites();
  const inp = document.getElementById('gp-search');
  if (inp) {
    inp.value = g.name || '';
    inp.setAttribute('aria-expanded', 'false');
  }
  const dropdown = document.getElementById('gp-dropdown');
  if (dropdown) dropdown.classList.remove('visible');
  const hint = document.getElementById('gp-hint');
  if (hint) hint.style.display = 'none';
  const list = document.getElementById('gp-list');
  if (list) list.innerHTML = '';
  const launchBtn = document.getElementById('gp-launch-btn');
  if (launchBtn) launchBtn.disabled = false;
}

// Enter picks the first result; a numeric query is resolved as a place ID
// immediately instead of waiting for the search debounce. When the search
// returns exactly one result, Enter launches straight into it. When nothing
// matches but a cached game is selected, Enter launches that instead.
async function gpSearchKeydown(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const inp = document.getElementById('gp-search');
  const q = (inp?.value || '').trim();
  if (!q) return;
  if (/^\d+$/.test(q) && !_gpMap[0]) {
    let g = null;
    try { g = await resolvePlaceId(q); } catch {}
    if (g) {
      // A place ID resolves to exactly one game \u2014 launch it directly.
      gpSelectGame(g);
      closeModal('m-game-picker');
      _gpLaunch();
      return;
    }
    // fallthrough renders nothing extra: favorites stay visible below
    const loading = document.getElementById('gp-loading');
    if (loading) loading.style.display = 'none';
    const list = document.getElementById('gp-list');
    if (list) list.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12px;padding:24px 0">No game found for place ID ${esc(q)}.</div>`;
    return;
  }
  if (_gpMap[0]) {
    // Exactly one hit \u2014 Enter launches into it without an extra click.
    if (!_gpMap[1]) {
      gpSelectIndex(0);
      closeModal('m-game-picker');
      _gpLaunch();
      return;
    }
    gpSelectIndex(0);
    return;
  }
  // No live results: fall back to the cached selection if one is set.
  if (_cachedLaunchGame && _cachedLaunchGame.placeId) {
    closeModal('m-game-picker');
    _gpLaunch();
  }
}

function gpSearchInput(v) {
  _gpQuery = (v || '').trim();
  const hint = document.getElementById('gp-hint');
  if (!_gpQuery) {
    if (hint) hint.style.display = '';
    if (document.getElementById('gp-list')) document.getElementById('gp-list').innerHTML = '';
    const dropdown = document.getElementById('gp-dropdown');
    if (dropdown) dropdown.classList.remove('visible');
    const inp = document.getElementById('gp-search');
    if (inp) inp.setAttribute('aria-expanded', 'false');
    return;
  }
  clearTimeout(_gpDebounce);
  _gpDebounce = setTimeout(async () => {
    const list = document.getElementById('gp-list');
    const loading = document.getElementById('gp-loading');
    const dropdown = document.getElementById('gp-dropdown');
    if (dropdown) dropdown.classList.add('visible');
    const input = document.getElementById('gp-search');
    if (input) input.setAttribute('aria-expanded', 'true');
    if (hint) hint.style.display = 'none';
    if (loading) loading.style.display = 'flex';
    if (list) list.innerHTML = '';
    try {
      const query = _gpQuery;
      const isPlaceId = /^\d+$/.test(query);
      let results;
      if (isPlaceId) {
        // A pure-number query is treated as a place ID and resolved directly.
        const g = await resolvePlaceId(query);
        results = g ? [g] : [];
      } else {
        results = await searchRobloxGames(query);
      }
      if (document.getElementById('gp-search')?.value.trim() !== query) return;
      if (loading) loading.style.display = 'none';
      // Drop stale hits so Enter can never launch a game from a previous query.
      _gpMap = {};
      if (!results.length) { if (list) list.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12px;padding:24px 0">${isPlaceId ? `No game found for place ID ${esc(query)}.` : 'No games found.'}</div>`; return; }
      list.innerHTML = results.map((g, i) => {
        _gpMap[i] = g;
        if (g.placeId) _gpMap[String(g.placeId)] = g; // placeId lookup for starring
        const players = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing' : '';
        const isFav = g.placeId ? gpFavIsFavorite(g.placeId) : false;
        const thumb = g.thumbUrl
          ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy"/>`
          : `<div class="chart-card-thumb-ph"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><path d="M6 8h12a4 4 0 0 1 3.86 5l-1.5 6A2 2 0 0 1 18.42 20H17a2 2 0 0 1-1.79-1.11L14.5 17h-5l-.71 1.89A2 2 0 0 1 7 20H5.58a2 2 0 0 1-1.94-1.52l-1.5-6A4 4 0 0 1 6 8Z"/></svg></div>`;
        return `<div class="chart-card" role="option" tabindex="0" aria-label="Select ${esc(g.name || 'Unknown')}" onclick="gpSelectIndex(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();gpSelectIndex(${i})}" title="Launch into ${esc(g.name || '')}" style="animation-delay:${i * 12}ms">
          ${thumb}
          <div class="chart-card-body">
            <div class="chart-card-rank">${isPlaceId ? 'Place ID' : 'Select'}</div>
            <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
            ${players ? `<div class="chart-card-stat"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${players}</div>` : ''}
          </div>
          ${g.placeId ? `<button class="gp-fav-btn${isFav ? ' active' : ''}" data-pid="${esc(String(g.placeId))}" title="${isFav ? 'Remove from favorites' : 'Add to favorites (max 2)'}" onclick="event.stopPropagation();gpFavToggle('${esc(String(g.placeId))}')"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>` : ''}
        </div>`;
      }).join('');
      renderGamePickerFavorites();
    } catch (e) {
      if (loading) loading.style.display = 'none';
      _gpMap = {};
      if (list) list.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);font-size:12px;padding:24px 0">Search failed. Check your connection.</div>';
    }
  }, 420);
}

let _recentGames = [];
try { _recentGames = JSON.parse(localStorage.getItem('rblx_recent_searched_games') || '[]'); } catch {}

function saveRecentGame(game) {
  if (!game || !game.placeId) return;
  _recentGames = _recentGames.filter(x => String(x.placeId) !== String(game.placeId));
  _recentGames.unshift(game);
  if (_recentGames.length > 4) _recentGames = _recentGames.slice(0, 4);
  try { localStorage.setItem('rblx_recent_searched_games', JSON.stringify(_recentGames)); } catch {}
  renderRecentGames();
}

let _recentGameMap = {};
function renderRecentGames() {
  const wrap = document.getElementById('recent-games-wrap');
  const list = document.getElementById('recent-games-list');
  if (!wrap || !list) return;
  if (!_recentGames.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'flex';
  _recentGameMap = {};
  list.innerHTML = _recentGames.map((g, idx) => {
    _recentGameMap['rg_' + idx] = g;
    const players = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing' : '';
    const thumb = g.thumbUrl
      ? `<img class="chart-card-thumb" src="${esc(g.thumbUrl)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=chart-card-thumb-ph><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'28\' height=\'28\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'><rect x=\'2\' y=\'6\' width=\'20\' height=\'12\' rx=\'2\'/><path d=\'m22 10-6.3 3.15a1 1 0 0 1-.9 0L2 7\'/></svg></div>'"/>`
      : `<div class="chart-card-thumb-ph"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m22 10-6.3 3.15a1 1 0 0 1-.9 0L2 7"/></svg></div>`;
    return `
      <div class="chart-card" onclick="openRecentGameModal('rg_${idx}')" title="${esc(g.name || '')}">
        ${thumb}
        <div class="chart-card-body">
          <div class="chart-card-rank">Recent</div>
          <div class="chart-card-name">${esc(g.name || 'Unknown')}</div>
          ${players ? `<div class="chart-card-stat"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${players}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function openRecentGameModal(key) {
  const g = _recentGameMap[key];
  if (!g) return;
  _gameModal = g;
  const thumb = document.getElementById('game-modal-thumb');
  if (g.thumbUrl) { thumb.src = g.thumbUrl; thumb.style.display = 'block'; }
  else { thumb.style.display = 'none'; }
  document.getElementById('game-modal-name').textContent = g.name || 'Unknown';
  document.getElementById('game-modal-id').textContent = g.placeId || '-';
  const stat = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing now' : '';
  document.getElementById('game-modal-stat').textContent = stat;
  openModal('m-game');
}

function filterCharts(val) {
  clearTimeout(_searchDebounce);
  const query = val.trim();
  const wrap = document.getElementById('recent-games-wrap');
  if (!query) {
    _searchMode = false;
    renderRecentGames();
    if (chartsLoaded) renderCharts(allCharts[chartTab] || [], false);
    else {
      document.getElementById('charts-grid').style.display = 'none';
      document.getElementById('charts-empty').style.display = 'none';
      document.getElementById('charts-loading').style.display = 'flex';
    }
    return;
  }
  _searchMode = true;
  if (wrap) wrap.style.display = 'none';
  _searchDebounce = setTimeout(async () => {
    const grid = document.getElementById('charts-grid');
    const loading = document.getElementById('charts-loading');
    const emptyEl = document.getElementById('charts-empty');
    grid.style.display = 'none';
    emptyEl.style.display = 'none';
    loading.style.display = 'flex';
    try {
      const results = await searchRobloxGames(query);
      if (document.getElementById('chart-search').value.trim() === query) {
        if (results && results.length) {
          saveRecentGame(results[0]);
          if (wrap) wrap.style.display = 'none';
        }
        renderCharts(results, true);
      }
    } catch(e) {
      console.error('Search error:', e);
      loading.style.display = 'none';
      emptyEl.style.display = 'flex';
    }
  }, 420);
}

let _gameModal = {};
function openGameModal(idx) {
  const g = _chartGameMap[idx];
  if (!g) return;
  _gameModal = g;
  const thumb = document.getElementById('game-modal-thumb');
  if (g.thumbUrl) { thumb.src = g.thumbUrl; thumb.style.display = 'block'; }
  else { thumb.style.display = 'none'; }
  document.getElementById('game-modal-name').textContent = g.name || 'Unknown';
  document.getElementById('game-modal-id').textContent = g.placeId || '-';
  const stat = typeof g.playerCount === 'number' ? Number(g.playerCount).toLocaleString() + ' playing now' : '';
  document.getElementById('game-modal-stat').textContent = stat;
  openModal('m-game');
}
function copyGameId() {
  const id = String(_gameModal.placeId || '');
  if (!id) return;
  navigator.clipboard.writeText(id).then(() => toast('Place ID copied', 'ok'));
}
function gamePageOpen() {
  if (_gameModal.placeId) api.openExternal('https://www.roblox.com/games/' + _gameModal.placeId);
}


const FF_GFX = 'DFIntDebugFRMQualityLevelOverride';
const FF_FPS = 'DFIntTaskSchedulerTargetFps';
let _volTimer = null, _mixRunning = 0;

async function syncFpsControls() {
  let fpsCap = null, fpsUnl = false;
  if (typeof settings.fpsCap === 'number') { fpsCap = settings.fpsCap; fpsUnl = (fpsCap === 0); }
  if (typeof settings.fpsUnlimited === 'boolean') fpsUnl = settings.fpsUnlimited;
  if (fpsCap === null) {
    try {
      const xmlCap = await api.readFpsCap();
      fpsCap = xmlCap; fpsUnl = (xmlCap === 0);
    } catch {}
  }
  if (fpsCap === null) fpsCap = 60;
  const unlEl = document.getElementById('mix-fps-unl');
  const fpsEl = document.getElementById('mix-fps');
  if (!unlEl || !fpsEl) return;
  unlEl.checked = fpsUnl;
  fpsEl.value = fpsUnl ? 60 : Math.max(5, fpsCap || 60);
  fpsEl.disabled = fpsUnl;
  const valEl = document.getElementById('mix-fps-val');
  if (valEl) valEl.textContent = fpsUnl ? '\u221e' : (fpsCap || 60);
  updateSliderFill(fpsEl);
}

async function mixInit() {
  // Pull current values from saved Fast Flags + settings.
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}

  // Graphics
  const gfxRaw = flags[FF_GFX];
  const gfxAuto = (gfxRaw === undefined || gfxRaw === null || gfxRaw === '');
  document.getElementById('mix-gfx-auto').checked = gfxAuto;
  const gfxVal = clampInt(gfxRaw, 1, 21, 10);
  document.getElementById('mix-gfx').value = gfxVal;
  document.getElementById('mix-gfx-val').textContent = gfxAuto ? 'Auto' : gfxVal;
  document.getElementById('mix-gfx').disabled = gfxAuto;

  // FPS - synced from saved app settings with XML fallback (see syncFpsControls).
  await syncFpsControls();

  // RAM Limit
  let savedRam = null;
  try { savedRam = localStorage.getItem('mix-ram-limit'); } catch {}
  const ramUnl = (savedRam === null || savedRam === undefined || savedRam === '');
  const ramEl = document.getElementById('mix-ram');
  const ramUnlEl = document.getElementById('mix-ram-unl');
  const ramValEl = document.getElementById('mix-ram-val');
  if (ramUnlEl) ramUnlEl.checked = ramUnl;
  if (ramEl) {
    const ramVal = clampInt(savedRam, 256, 8192, 2048);
    ramEl.value = ramVal;
    ramEl.disabled = ramUnl;
    if (ramValEl) ramValEl.textContent = ramUnl ? 'Unlimited' : ramVal + ' MB';
    updateSliderFill(ramEl);
  }

  // Volume
  _volMuted = false;
  _volPrevLevel = null;
  const vol = (typeof settings.masterVolume === 'number') ? settings.masterVolume : 100;
  document.getElementById('mix-vol').value = vol;
  document.getElementById('mix-vol-val').textContent = vol + '%';
  updateVolMuteIcon();

  updateSliderFill(document.getElementById('mix-gfx'));
  updateSliderFill(document.getElementById('mix-fps'));
  updateSliderFill(document.getElementById('mix-vol'));
  mixRefreshRunning();
}

// FPS
function mixFpsInput(v) {
  document.getElementById('mix-fps-val').textContent = v;
  updateSliderFill(document.getElementById('mix-fps'));
}
async function mixFpsUnlToggle() {
  const unl = document.getElementById('mix-fps-unl').checked;
  document.getElementById('mix-fps').disabled = unl;
  if (unl) {
    document.getElementById('mix-fps-val').textContent = '\u221e';
    settings.fpsCap = 0;
    settings.fpsUnlimited = true;
    let result;
    try { result = await api.writeFpsCap(0); } catch { result = null; }
    if (!result || !result.ok) {
      toast('Could not save FPS setting', 'err');
      return;
    }
    toast('FPS set to unlimited (next launch)', 'ok');
  } else {
    await mixFpsCommit();
  }
}
async function mixFpsCommit() {
  if (document.getElementById('mix-fps-unl').checked) return;
  const v = parseInt(document.getElementById('mix-fps').value, 10);
  if (!Number.isFinite(v) || v < 5) {
    toast('Invalid FPS value', 'err');
    return;
  }
  document.getElementById('mix-fps-val').textContent = v;
  settings.fpsCap = v;
  settings.fpsUnlimited = false;
  // fps:write persists the preference in AppData and updates Roblox XML.
  let result;
  try { result = await api.writeFpsCap(v); } catch { result = null; }
  if (!result || !result.ok) {
    toast('Could not save FPS setting', 'err');
    return;
  }
  toast('FPS cap: ' + v + ' (next launch)', 'ok');
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Lightweight global poll so the running count stays current off the Mixer
// page too. Cheap (tasklist under the hood); 3s cadence matches the rest of UI.
let _runningPoll = null;
let _lastCountPushAt = 0;
async function pollRunningCount() {
  // main pushes the count every ~5s while watching; skip our own tasklist
  // call if one of those landed recently (it also pushes temp sessions then).
  if (Date.now() - _lastCountPushAt < 6500) return;
  let n = 0;
  try { n = await api.getRunningCount(); } catch { n = 0; }
  _mixRunning = n;
  // When nothing is being watched there are no pushes, so detect external
  // sessions here on the existing idle poll cadence.
  await fetchTempSessions();
}
function scheduleRunningPoll() {
  if (_runningPoll) { clearTimeout(_runningPoll); _runningPoll = null; }
  if (document.hidden) return;
  const delay = _mixRunning > 0 ? 3500 : 8000;
  _runningPoll = setTimeout(async () => { _runningPoll = null; await pollRunningCount(); scheduleRunningPoll(); }, delay);
}
function startRunningPoll() {
  if (!startRunningPoll._wired) {
    startRunningPoll._wired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (_runningPoll) { clearTimeout(_runningPoll); _runningPoll = null; } }
      else pollRunningCount().then(scheduleRunningPoll);
    });
  }
  pollRunningCount().then(scheduleRunningPoll);
}

async function mixRefreshRunning() {
  try {
    _mixRunning = await api.getRunningCount();
  } catch { _mixRunning = 0; }

}

// Merge a single key into the on-disk Fast Flags without disturbing others.
async function mixWriteFlag(key, value) {
  let flags = {};
  try { flags = (await api.readFFlags()) || {}; } catch {}
  if (value === null) delete flags[key];
  else flags[key] = String(value);
  try { await api.writeFFlags(flags); } catch {}
}

// Smoothly fill the slider track up to the current value.
function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 100, v = parseFloat(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.background = 'linear-gradient(90deg, var(--ac) ' + pct + '%, var(--s4) ' + pct + '%)';
}

// Graphics
function mixGfxInput(v) {
  document.getElementById('mix-gfx-val').textContent = v;
  updateSliderFill(document.getElementById('mix-gfx'));
}
function mixGfxAutoToggle() {
  const auto = document.getElementById('mix-gfx-auto').checked;
  document.getElementById('mix-gfx').disabled = auto;
  if (auto) {
    document.getElementById('mix-gfx-val').textContent = 'Auto';
    mixWriteFlag(FF_GFX, null);
    toast('Graphics set to Auto', 'ok');
  } else {
    mixGfxCommit();
  }
}
function mixGfxCommit() {
  if (document.getElementById('mix-gfx-auto').checked) return;
  const v = document.getElementById('mix-gfx').value;
  document.getElementById('mix-gfx-val').textContent = v;
  mixWriteFlag(FF_GFX, v);
  toast('Graphics quality: ' + v + ' (next launch)', 'ok');
}

let _volMuted = false;
let _volPrevLevel = null;
const VOL_SPEAKER_HTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
const VOL_MUTED_HTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
function updateVolMuteIcon() {
  const btn = document.getElementById('vol-mute-btn');
  if (!btn) return;
  btn.innerHTML = _volMuted ? VOL_MUTED_HTML : VOL_SPEAKER_HTML;
  btn.style.opacity = _volMuted ? '0.4' : '1';
  btn.title = _volMuted ? 'Unmute' : 'Mute';
}
function mixVolToggleMute() {
  const slider = document.getElementById('mix-vol');
  if (!slider) return;
  if (_volMuted) {
    // Unmute: restore the exact level that was set before muting.
    _volMuted = false;
    const level = (typeof _volPrevLevel === 'number') ? _volPrevLevel : 100;
    _volPrevLevel = null;
    slider.value = level;
    document.getElementById('mix-vol-val').textContent = level + '%';
    updateSliderFill(slider);
    settings.masterVolume = level;
    api.saveSettings({ masterVolume: level });
    clearTimeout(_volTimer);
    _volTimer = setTimeout(async () => {
      const res = await api.setRobloxVolume(level);
      if (res && res.ok) toast('Volume ' + level + '%', 'ok');
    }, 60);
  } else {
    // Mute: remember the level, zero the slider, silence every session live.
    _volMuted = true;
    _volPrevLevel = parseInt(slider.value, 10) || 100;
    slider.value = 0;
    document.getElementById('mix-vol-val').textContent = '0%';
    updateSliderFill(slider);
    clearTimeout(_volTimer);
    _volTimer = setTimeout(() => { api.setRobloxVolume(0); }, 60);
    toast('Muted', 'ok');
  }
  updateVolMuteIcon();
}

// Volume - applies live while dragging (debounced so we don't spawn the helper
// on every drag tick), and saves + confirms on release.
function mixVolInput(v) {
  if (_volMuted) { _volMuted = false; _volPrevLevel = null; updateVolMuteIcon(); }
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  clearTimeout(_volTimer);
  _volTimer = setTimeout(() => { api.setRobloxVolume(parseInt(v, 10)); }, 90);
}
function mixVolCommit() {
  if (_volMuted) { _volMuted = false; _volPrevLevel = null; updateVolMuteIcon(); }
  const v = parseInt(document.getElementById('mix-vol').value, 10);
  document.getElementById('mix-vol-val').textContent = v + '%';
  updateSliderFill(document.getElementById('mix-vol'));
  settings.masterVolume = v;
  api.saveSettings({ masterVolume: v });
  clearTimeout(_volTimer);
  _volTimer = setTimeout(async () => {
    const res = await api.setRobloxVolume(v);
    if (res && res.ok) {
      toast('Volume ' + v + '%', 'ok');
    } else {
      toast('Couldn\u2019t set volume' + (res && res.error ? ': ' + res.error : ''), 'err');
    }
  }, 60);
}

// RAM limit
function mixRamInput(v) {
  document.getElementById('mix-ram-val').textContent = v + ' MB';
  updateSliderFill(document.getElementById('mix-ram'));
}
function mixRamUnlToggle() {
  const unl = document.getElementById('mix-ram-unl').checked;
  const slider = document.getElementById('mix-ram');
  if (slider) slider.disabled = unl;
  if (unl) {
    document.getElementById('mix-ram-val').textContent = 'Unlimited';
    try { localStorage.removeItem('mix-ram-limit'); } catch {}
    toast('RAM limit set to Unlimited', 'ok');
  } else {
    mixRamCommit();
  }
}
function mixRamCommit() {
  if (document.getElementById('mix-ram-unl')?.checked) return;
  const v = document.getElementById('mix-ram')?.value || '2048';
  document.getElementById('mix-ram-val').textContent = v + ' MB';
  updateSliderFill(document.getElementById('mix-ram'));
  try { localStorage.setItem('mix-ram-limit', v); } catch {}
  toast('RAM limit: ' + v + ' MB', 'ok');
}

async function mixSaveSettings() {
  const gfxAuto = document.getElementById('mix-gfx-auto')?.checked;
  const gfxVal = parseInt(document.getElementById('mix-gfx')?.value, 10) || 10;
  const fpsUnl = document.getElementById('mix-fps-unl')?.checked;
  const fpsVal = parseInt(document.getElementById('mix-fps')?.value, 10) || 60;
  const ramUnl = document.getElementById('mix-ram-unl')?.checked;
  const ramVal = parseInt(document.getElementById('mix-ram')?.value, 10) || 2048;
  const volVal = parseInt(document.getElementById('mix-vol')?.value, 10) || 100;

  // Save FastFlags & Global Settings
  if (gfxAuto) mixWriteFlag(FF_GFX, null);
  else mixWriteFlag(FF_GFX, gfxVal);

  if (ramUnl) {
    try { localStorage.removeItem('mix-ram-limit'); } catch {}
  } else {
    try { localStorage.setItem('mix-ram-limit', ramVal); } catch {}
  }

  settings.masterVolume = volVal;
  settings.fpsCap = fpsUnl ? 0 : fpsVal;
  settings.fpsUnlimited = !!fpsUnl;
  await api.saveSettings({ masterVolume: volVal });
  let fpsResult;
  try { fpsResult = await api.writeFpsCap(settings.fpsCap); } catch { fpsResult = null; }
  if (!fpsResult || !fpsResult.ok) {
    toast('Could not save FPS setting', 'err');
    return;
  }

  toast('Mixer settings saved', 'ok');
}


let _swapCleaning = false;
let _swapInited = false;
let _swapAnticheatProceed = null;

function setupHoldButton(btnId, barId, callback) {
  const btn = document.getElementById(btnId);
  const bar = document.getElementById(barId);
  if (!btn || !bar) return;

  let timer = null;
  let startTime = 0;
  let animFrame = null;
  const HOLD_MS = 5000;

  function reset() {
    if (timer) clearInterval(timer);
    if (animFrame) cancelAnimationFrame(animFrame);
    timer = null;
    animFrame = null;
    bar.style.transition = 'none';
    bar.style.width = '0%';
  }

  function startHold(e) {
    if (btn.disabled) return;
    reset();
    startTime = Date.now();
    bar.style.transition = 'none';

    function tick() {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(100, (elapsed / HOLD_MS) * 100);
      bar.style.width = pct + '%';

      if (elapsed >= HOLD_MS) {
        reset();
        callback();
      } else {
        animFrame = requestAnimationFrame(tick);
      }
    }

    animFrame = requestAnimationFrame(tick);
  }

  btn.addEventListener('mousedown', startHold);
  btn.addEventListener('touchstart', startHold, { passive: true });

  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => {
    btn.addEventListener(evt, reset);
  });
}

async function swapInit() {
  swapRefreshBackup();
  setupHoldButton('swap-spoof-btn', 'swap-spoof-hold-bar', () => swapRunSpoof());
  setupHoldButton('swap-clean-btn', 'swap-clean-hold-bar', () => swapRunClean());
  try {
    const elevated = await api.hwidIsElevated();
    const warn = document.getElementById('swap-admin-warn');
    if (warn) warn.style.display = elevated ? 'none' : 'flex';
  } catch {}
}

function swapLog(msg, level) {
  const box = document.getElementById('swap-log');
  if (!box) return;
  if (box.dataset.empty !== '0') { box.innerHTML = ''; box.dataset.empty = '0'; }
  const color = (level === 'ok' || level === 'success') ? 'var(--green)'
    : (level === 'err' || level === 'error') ? 'var(--red)'
    : (level === 'warn') ? '#f5a623' : 'var(--t2)';
  const line = document.createElement('div');
  line.style.color = color;
  line.textContent = '› ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function swapClearLog() {
  const box = document.getElementById('swap-log');
  if (box) { box.textContent = 'No activity yet.'; box.dataset.empty = '1'; }
}

function swapSetProgress(pct, label) {
  const bar = document.getElementById('swap-progress-bar');
  const txt = document.getElementById('swap-status-text');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (txt && label) txt.textContent = label;
}

async function swapRefreshBackup() {
  const dot = document.getElementById('swap-backup-dot');
  const txt = document.getElementById('swap-backup-text');
  if (!dot || !txt) return;
  try {
    const info = await api.hwidBackupInfo();
    if (info && info.exists) {
      const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : 'unknown time';
      dot.style.background = 'var(--green)';
      txt.textContent = `Spoofed — backup saved ${when}`;
    } else {
      dot.style.background = 'var(--t3)';
      txt.textContent = 'No backup. Not currently spoofed.';
    }
  } catch {
    dot.style.background = 'var(--t3)';
    txt.textContent = 'Backup status unavailable';
  }
}

// Locally-administered random MAC (mirrors the source adapter's OUI when known).
function swapRandomMac(adapter) {
  const lbit = ['2', '6', 'A', 'E'];
  const hx = () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)];
  let head;
  if (adapter && adapter.MacAddress && adapter.MacAddress.length === 17) {
    head = adapter.MacAddress[0] + lbit[Math.floor(Math.random() * 4)] + adapter.MacAddress.substring(2, 9);
  } else {
    head = hx() + lbit[Math.floor(Math.random() * 4)] + '-' + hx() + hx() + '-' + hx() + hx() + '-';
  }
  const tail = hx() + hx() + '-' + hx() + hx() + '-' + hx() + hx();
  return head + tail;
}

async function swapRelaunchAdmin() {
  swapLog('Requesting administrator elevation…', 'info');
  try {
    const res = await api.relaunchAsAdmin();
    if (res && res.ok) { swapLog('Relaunching as administrator…', 'ok'); return true; }
    if (res && res.cancelled) { swapLog('Elevation cancelled by user.', 'warn'); toast('Admin elevation cancelled', ''); return false; }
    swapLog(`Could not relaunch as admin: ${res?.error || 'unknown error'}`, 'err');
  } catch (e) {
    swapLog(`Relaunch failed: ${e.message}`, 'err');
  }
  return false;
}

async function swapRunSpoof(macOnly) {
  // macOnly=true (the "MAC only" button) randomises network adapters only,
  // regardless of the toggles. The hold button spoofs whatever is ticked.
  const doMac = macOnly || document.getElementById('swap-t-mac').checked;
  const doHwid = !macOnly && document.getElementById('swap-t-hwid').checked;
  const doVol = !macOnly && document.getElementById('swap-t-vol').checked;
  if (!doMac && !doHwid && !doVol) { swapLog('Nothing selected to spoof. Pick at least one option.', 'err'); return; }

  // Spoofing writes to HKLM and the raw boot sector — needs administrator rights.
  // If we're not elevated, offer to relaunch as admin (UAC) instead of failing.
  try {
    const elevated = await api.hwidIsElevated();
    if (!elevated) {
      if (confirm('Spoofing hardware IDs needs administrator rights.\n\nRelaunch rbxSWAP as administrator now?')) {
        await swapRelaunchAdmin();
      } else {
        swapLog('Spoofing needs administrator rights — relaunch as admin to continue.', 'warn');
        toast('Admin rights required for spoofing', '');
      }
      return;
    }
  } catch {}

  // Warn on live kernel anti-cheats — they can flag or interfere with id changes.
  try {
    const acs = await api.detectAnticheat();
    if (acs && acs.length > 0) {
      swapLog(`Warning: ${acs.map(a => a.name).join(', ')} is running.`, 'warn');
      swapOpenAnticheat(acs, () => swapPerformSpoof(doMac, doHwid, doVol));
      return;
    }
  } catch {}

  swapPerformSpoof(doMac, doHwid, doVol);
}

async function swapPerformSpoof(doMac, doHwid, doVol) {
  const btn = document.getElementById('swap-spoof-btn');
  btn.disabled = true;
  try {
    if (document.getElementById('swap-t-rp').checked) {
      swapLog('Creating system restore point (may take a moment)…', 'info');
      const rp = await api.createRestorePoint('rbxSWAP pre-spoof');
      swapLog(rp.ok ? 'Restore point created.' : `Restore point skipped: ${rp.message}`, rp.ok ? 'ok' : 'warn');
    }

    await api.backupHwid(); // snapshot real originals before touching anything
    let errs = 0;

    if (doMac) {
      const adapters = await api.getAdapters();
      if (!adapters || adapters.length === 0) {
        swapLog('No spoofable network adapters found (run as administrator?).', 'err');
        errs++;
      } else {
        for (const a of adapters) {
          const mac = swapRandomMac(a);
          swapLog(`Spoofing [${a.Name}] → ${mac}…`, 'info');
          try {
            const ok = await api.spoofMac(a.InterfaceDescription || '', mac);
            if (ok) { await api.restartAdapter(a.Name); swapLog(`Done [${a.Name}]`, 'ok'); }
            else { swapLog(`Failed [${a.Name}] — run as administrator?`, 'err'); errs++; }
          } catch (e) { swapLog(`Failed [${a.Name}] — ${e.message}`, 'err'); errs++; }
        }
      }
    }

    if (doHwid || doVol) {
      swapLog('Spoofing hardware identifiers…', 'info');
      try {
        const hw = await api.spoofHwid({ guids: doHwid, volume: doVol });
        if (hw.success) {
          let needsReboot = false;
          for (const r of hw.results || []) {
            swapLog(r.ok ? `Done [${r.name}] → ${r.value}` : `Failed [${r.name}] — ${r.error || 'run as admin?'}`, r.ok ? 'ok' : 'err');
            if (!r.ok) errs++;
            if (r.ok && r.reboot) needsReboot = true;
          }
          if (needsReboot) swapLog('Volume serial change applies after a reboot.', 'warn');
        } else { swapLog(`HWID spoof failed${hw.message ? ' — ' + hw.message : ''}`, 'err'); errs++; }
      } catch (e) { swapLog(`HWID spoof failed — ${e.message}`, 'err'); errs++; }
    }

    if (errs > 0) { swapLog(`Completed with ${errs} error(s).`, 'err'); toast('Spoof completed with errors', ''); }
    else { swapLog('Spoofing complete.', 'ok'); toast('Machine identity spoofed', 'ok'); }
    logEntry(errs > 0 ? 'warn' : 'ok', 'swap', errs > 0 ? `Spoof completed with ${errs} error(s)` : 'Machine identifiers spoofed');
  } finally {
    btn.disabled = false;
    swapRefreshBackup();
  }
}

async function swapRevert() {
  if (await api.hwidBackupExists()) { swapOpenRestore(); return; }
  swapLog('No backup found — nothing to revert.', 'warn');
  toast('No spoof backup to revert', '');
}

async function swapOpenRestore() {
  const info = await api.hwidBackupInfo();
  if (!info || !info.exists) { swapLog('No backup found to restore from.', 'err'); return; }
  const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : 'unknown time';
  document.getElementById('restore-when').textContent = `Backup made: ${when}`;
  const rows = [
    ['restore-row-mac', 'restore-mac', info.has.mac],
    ['restore-row-hwid', 'restore-hwid', info.has.guids],
    ['restore-row-vol', 'restore-vol', info.has.volume],
  ];
  for (const [rowId, chkId, present] of rows) {
    document.getElementById(rowId).style.display = present ? 'flex' : 'none';
    document.getElementById(chkId).checked = present;
  }
  const hint = document.getElementById('restore-hwid-hint');
  hint.textContent = info.serials && info.serials.machineGuid ? `(${info.serials.machineGuid.slice(0, 8)}…)` : '';
  openModal('m-restore');
}

async function swapExecuteRestore() {
  const opts = {
    mac: document.getElementById('restore-mac').checked,
    guids: document.getElementById('restore-hwid').checked,
    volume: document.getElementById('restore-vol').checked,
  };
  if (!opts.mac && !opts.guids && !opts.volume) { swapLog('Nothing selected to restore.', 'err'); return; }
  closeModal('m-restore');
  swapLog('Restoring selected identifiers from backup…', 'info');
  try {
    const res = await api.restoreHwid(opts);
    for (const id of res.identifiers || []) swapLog(id.restored ? `Restored ${id.name}` : `Skipped ${id.name} (${id.reason})`, id.restored ? 'ok' : 'err');
    for (const a of res.adapters || []) swapLog(a.restored ? `Restored [${a.name}]` : `Failed [${a.name}] (${a.reason})`, a.restored ? 'ok' : 'err');
    if (res.volume) {
      swapLog(res.volume.restored ? `Restored volume serial [${res.volume.drive}]` : `Volume serial not restored (${res.volume.reason})`, res.volume.restored ? 'ok' : 'err');
      if (res.volume.restored && res.volume.reboot) swapLog('Volume serial revert applies after a reboot.', 'warn');
    }
    if (res.ok && !res.coveredEverything) swapLog('Selected items restored. Backup kept for the rest.', 'warn');
    else swapLog(res.ok ? 'Restore complete.' : 'Restore finished with errors (backup kept).', res.ok ? 'ok' : 'err');
    logEntry(res.ok ? 'ok' : 'warn', 'swap', res.ok ? 'Machine identity restored from backup' : 'Identity restore finished with errors');
  } catch (e) {
    swapLog(`Restore failed — ${e.message}`, 'err');
  }
  swapRefreshBackup();
}

function swapOpenAnticheat(acs, onProceed) {
  _swapAnticheatProceed = onProceed;
  document.getElementById('ac-title').textContent = `${acs.map(a => a.name).join(' + ')} detected`;
  const box = document.getElementById('ac-steps');
  box.innerHTML = '';
  for (const ac of acs) {
    if (acs.length > 1) {
      const h = document.createElement('p');
      h.className = 'ac-step';
      h.style.fontWeight = '600';
      h.textContent = ac.name;
      box.appendChild(h);
    }
    for (const step of ac.steps) {
      if (step.c) {
        const row = document.createElement('div');
        row.className = 'ac-cmd';
        const code = document.createElement('code');
        code.textContent = step.c;
        const btn = document.createElement('button');
        btn.className = 'ac-copy';
        btn.textContent = 'Copy';
        btn.onclick = () => swapCopyCmd(step.c, btn);
        row.appendChild(code); row.appendChild(btn);
        box.appendChild(row);
      } else {
        const p = document.createElement('p');
        p.className = 'ac-step';
        p.textContent = step.t;
        box.appendChild(p);
      }
    }
  }
  openModal('m-anticheat');
}

function swapCopyCmd(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }).catch(() => {});
}

function swapProceedAnticheat() {
  const fn = _swapAnticheatProceed;
  _swapAnticheatProceed = null;
  closeModal('m-anticheat');
  if (fn) fn();
}

async function swapRunClean() {
  if (_swapCleaning) return;
  const opts = {
    preserveSettings: document.getElementById('swap-c-settings').checked,
    preserveFastflags: document.getElementById('swap-c-fflags').checked,
    deleteStudio: document.getElementById('swap-c-studio').checked,
    purgeAuth: document.getElementById('swap-c-auth').checked,
  };
  _swapCleaning = true;
  const btn = document.getElementById('swap-clean-btn');
  if (btn) btn.disabled = true;
  swapSetProgress(0, 'Starting…');
  swapLog('Clean started — closing Roblox and wiping local traces…', 'info');
  logEntry('warn', 'swap', 'Roblox trace clean started', opts);
  await api.runSwap(opts);
}

// One-time registration of the swap main-process event forwarders.
(function swapWireEvents() {
  if (_swapInited || !window.api) return;
  _swapInited = true;
  api.onSwapLog(d => { if (d) swapLog(d.message, d.level); });
  api.onSwapStatus(d => {
    if (!d) return;
    const label = d.status ? d.status.charAt(0).toUpperCase() + d.status.slice(1) : '';
    swapSetProgress(typeof d.progress === 'number' ? d.progress : 0, label);
  });
  api.onSwapComplete(d => {
    _swapCleaning = false;
    const btn = document.getElementById('swap-clean-btn');
    if (btn) btn.disabled = false;
    if (d && d.success !== false) {
      swapSetProgress(100, 'Complete');
      swapLog('Trace clean complete.', 'ok');
      toast('Roblox traces cleaned', 'ok');
      logEntry('ok', 'swap', 'Roblox trace clean complete');
    } else {
      swapSetProgress(100, 'Error');
      swapLog(`Trace clean failed: ${d?.message || 'unknown error'}`, 'err');
      toast('Clean failed', '');
      logEntry('err', 'swap', `Roblox trace clean failed: ${d?.message || 'unknown'}`);
    }
  });
})();

(function () {
  const HOST = 'https://setup-aws.rbxcdn.com'; // only the AWS mirror has CORS configured

  const EXTRACT_ROOTS = {
    player: {
      'RobloxApp.zip': '', 'redist.zip': '', 'shaders.zip': 'shaders/', 'ssl.zip': 'ssl/',
      'WebView2.zip': '', 'WebView2RuntimeInstaller.zip': 'WebView2RuntimeInstaller/',
      'content-avatar.zip': 'content/avatar/', 'content-configs.zip': 'content/configs/',
      'content-fonts.zip': 'content/fonts/', 'content-sky.zip': 'content/sky/',
      'content-sounds.zip': 'content/sounds/', 'content-textures2.zip': 'content/textures/',
      'content-models.zip': 'content/models/',
      'content-platform-fonts.zip': 'PlatformContent/pc/fonts/',
      'content-platform-dictionaries.zip': 'PlatformContent/pc/shared_compression_dictionaries/',
      'content-terrain.zip': 'PlatformContent/pc/terrain/', 'content-textures3.zip': 'PlatformContent/pc/textures/',
      'extracontent-luapackages.zip': 'ExtraContent/LuaPackages/', 'extracontent-translations.zip': 'ExtraContent/translations/',
      'extracontent-models.zip': 'ExtraContent/models/', 'extracontent-textures.zip': 'ExtraContent/textures/',
      'extracontent-places.zip': 'ExtraContent/places/',
    },
    studio: {
      'RobloxStudio.zip': '', 'RibbonConfig.zip': 'RibbonConfig/', 'redist.zip': '', 'Libraries.zip': '', 'LibrariesQt5.zip': '',
      'WebView2.zip': '', 'WebView2RuntimeInstaller.zip': '', 'shaders.zip': 'shaders/', 'ssl.zip': 'ssl/',
      'Qml.zip': 'Qml/', 'Plugins.zip': 'Plugins/', 'StudioFonts.zip': 'StudioFonts/', 'BuiltInPlugins.zip': 'BuiltInPlugins/',
      'ApplicationConfig.zip': 'ApplicationConfig/', 'BuiltInStandalonePlugins.zip': 'BuiltInStandalonePlugins/',
      'content-qt_translations.zip': 'content/qt_translations/', 'content-sky.zip': 'content/sky/',
      'content-fonts.zip': 'content/fonts/', 'content-avatar.zip': 'content/avatar/', 'content-models.zip': 'content/models/',
      'content-sounds.zip': 'content/sounds/', 'content-configs.zip': 'content/configs/', 'content-api-docs.zip': 'content/api_docs/',
      'content-textures2.zip': 'content/textures/', 'content-studio_svg_textures.zip': 'content/studio_svg_textures/',
      'content-platform-fonts.zip': 'PlatformContent/pc/fonts/',
      'content-platform-dictionaries.zip': 'PlatformContent/pc/shared_compression_dictionaries/',
      'content-terrain.zip': 'PlatformContent/pc/terrain/', 'content-textures3.zip': 'PlatformContent/pc/textures/',
      'extracontent-translations.zip': 'ExtraContent/translations/', 'extracontent-luapackages.zip': 'ExtraContent/LuaPackages/',
      'extracontent-textures.zip': 'ExtraContent/textures/', 'extracontent-scripts.zip': 'ExtraContent/scripts/',
      'extracontent-models.zip': 'ExtraContent/models/',
      'studiocontent-models.zip': 'StudioContent/models/', 'studiocontent-textures.zip': 'StudioContent/textures/',
    },
  };

  const BINARY_TYPES = {
    WindowsPlayer: { blobDirs: { 'x86-64': '/' } },
    WindowsStudio64: { blobDirs: { 'x86-64': '/' } },
    MacPlayer: { defaultArch: 'arm64', blobDirs: { 'arm64': '/mac/arm64/', 'x86-64': '/mac/' } },
    MacStudio: { defaultArch: 'arm64', blobDirs: { 'arm64': '/mac/arm64/', 'x86-64': '/mac/' } },
  };

  let rddBusy = false;
  let weaoVersionsLoaded = false;
  const el = (id) => document.getElementById(id);

  function rddLog(msg) {
    const box = el('rdd-console');
    if (!box) return;
    if (box.dataset.empty !== '0') { box.textContent = ''; box.dataset.empty = '0'; }
    box.textContent += msg + '\n';
    box.scrollTop = box.scrollHeight;
  }

  window.rddClearConsole = function () {
    const box = el('rdd-console');
    if (box) { box.textContent = 'Idle. Pick a binary type, then Download.'; box.dataset.empty = '1'; }
  };

  window.rddPopulateArch = function () {
    const bt = el('rdd-binaryType').value;
    const sel = el('rdd-arch');
    sel.innerHTML = '';
    const obj = BINARY_TYPES[bt];
    if (!obj) return;
    for (const a of Object.keys(obj.blobDirs)) {
      const o = document.createElement('option');
      o.value = a; o.text = a;
      sel.appendChild(o);
    }
    sel.value = obj.defaultArch || Object.keys(obj.blobDirs)[0];
  };

  window.rddInit = function () {
    if (!el('rdd-arch').options.length) window.rddPopulateArch();
    if (typeof JSZip === 'undefined') rddLog('[!] Warning: JSZip did not load — Windows downloads will be unavailable.');
    if (!weaoVersionsLoaded) window.rddLoadWeaoVersions();
    window.rddLoadInstalledVersions();
  };

  let _installedRddVersions = [];
  let _rddRemoveArmed = {};
  let _rddUsage = {};            // hash -> bytes on disk (null while calculating)
  let _rddUsageKnown = false;
  let _rddCleanArmed = false;
  let _rddWeaoCurrentHash = '';  // WEAO "current" Windows build, fallback keep-hash

  const rddStripVer = (h) => String(h || '').replace(/^version-/, '');

  // Hashes the cleaner must never remove: the executor-synced build (or the
  // current WEAO build when no executor is configured) plus Roblox's own installs.
  function rddProtectedHashes() {
    const set = new Set();
    for (const v of _installedRddVersions) {
      if (v.location === 'Official Roblox') set.add(rddStripVer(v.hash));
    }
    const required = (typeof _launchRequiredVersionHash === 'string' && _launchRequiredVersionHash) || _rddWeaoCurrentHash;
    if (required) set.add(rddStripVer(required));
    return set;
  }

  function rddCleanCandidates() {
    const keep = rddProtectedHashes();
    return _installedRddVersions.filter(v =>
      v.location !== 'Official Roblox' && !keep.has(rddStripVer(v.hash)));
  }

  function rddFmtBytes(n) {
    const b = Number(n);
    if (!Number.isFinite(b) || b <= 0) return '0 B';
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  async function rddFetchUsage() {
    try {
      const usage = await api.getVersionsDiskUsage();
      if (usage && usage.ok) {
        const map = {};
        for (const v of (usage.versions || [])) map[v.hash] = v.bytes;
        _rddUsage = map;
        _rddUsageKnown = true;
      }
    } catch {}
  }

  function rddUpdateDiskSummary() {
    const summary = el('rdd-disk-summary');
    const cleanBtn = el('rdd-clean-btn');
    const candidates = rddCleanCandidates();
    if (summary) {
      if (!_installedRddVersions.length) {
        summary.textContent = 'No versions installed';
      } else if (!_rddUsageKnown) {
        summary.textContent = _installedRddVersions.length + ' version' + (_installedRddVersions.length !== 1 ? 's' : '') + ' · calculating disk usage…';
      } else {
        const total = _installedRddVersions.reduce((s, v) => s + (_rddUsage[v.hash] || 0), 0);
        summary.textContent = _installedRddVersions.length + ' version' + (_installedRddVersions.length !== 1 ? 's' : '')
          + ' · ' + rddFmtBytes(total) + ' on disk';
      }
    }
    if (cleanBtn) {
      cleanBtn.classList.toggle('btn-danger', _rddCleanArmed);
      cleanBtn.classList.toggle('btn-ghost', !_rddCleanArmed);
      if (_rddCleanArmed) {
        const bytes = candidates.reduce((s, v) => s + (_rddUsage[v.hash] || 0), 0);
        cleanBtn.textContent = 'Confirm remove (' + candidates.length + ' · ' + rddFmtBytes(bytes) + ')';
        cleanBtn.disabled = false;
      } else {
        cleanBtn.textContent = 'Clean old versions';
        cleanBtn.disabled = !candidates.length;
      }
    }
  }

  window.rddCleanOldVersions = async function () {
    if (!_rddCleanArmed) {
      _rddCleanArmed = true;
      rddUpdateDiskSummary();
      return;
    }
    const cleanBtn = el('rdd-clean-btn');
    if (cleanBtn) { cleanBtn.disabled = true; cleanBtn.textContent = 'Cleaning…'; }
    const candidates = rddCleanCandidates();
    // Safety net: only hashes NOT selected for removal are passed as keep-list,
    // so the main-side handler never deletes anything the renderer didn't
    // explicitly mark as old.
    const keep = _installedRddVersions
      .filter(v => !candidates.some(c => c.hash === v.hash))
      .map(v => v.hash);
    const r = await api.cleanOldVersions(keep);
    _rddCleanArmed = false;
    if (r && r.ok && Array.isArray(r.removed) && r.removed.length) {
      toast('Removed ' + r.removed.length + ' version' + (r.removed.length !== 1 ? 's' : '') + ' · freed ' + rddFmtBytes(r.freedBytes || 0), 'ok');
      logEntry('ok', 'rdd', 'Cleaned ' + r.removed.length + ' old Roblox version(s), freed ' + rddFmtBytes(r.freedBytes || 0));
    } else if (r && Array.isArray(r.removed) && r.removed.length) {
      toast('Removed ' + r.removed.length + ' · ' + r.failed.length + ' failed (running client?)', 'warn');
      logEntry('warn', 'rdd', 'Cleaned ' + r.removed.length + ' version(s); ' + r.failed.length + ' could not be removed');
    } else {
      toast(r?.error || 'Nothing to remove', 'err');
    }
    await window.rddLoadInstalledVersions();
  };

  window.rddLoadInstalledVersions = async function () {
    const box = el('rdd-ver-list');
    if (!box) return;
    const refreshBtn = el('rdd-ver-refresh');
    if (refreshBtn) refreshBtn.disabled = true;
    box.innerHTML = '<div class="weao-hint">Loading installed versions…</div>';
    _rddCleanArmed = false;
    try {
      _installedRddVersions = (await api.getInstalledVersions()) || [];
      rddUpdateDiskSummary();
      const q = (el('rdd-ver-search') ? el('rdd-ver-search').value : '').trim().toLowerCase();
      window.rddRenderInstalledVersions(q);
      await rddFetchUsage();
      window.rddRenderInstalledVersions((el('rdd-ver-search') ? el('rdd-ver-search').value : '').trim().toLowerCase());
    } catch (e) {
      box.innerHTML = `<div class="weao-hint">Failed to load versions: ${esc(e.message)}</div>`;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  window.rddFilterInstalledVersions = function (val) {
    window.rddRenderInstalledVersions((val || '').trim().toLowerCase());
  };

  // Inline handlers can't reach closure `let`s, so arming goes through this.
  window.rddArmRemove = function (hash) {
    _rddRemoveArmed = {}; // only one inline confirm armed at a time
    _rddRemoveArmed[hash] = true;
    window.rddRenderInstalledVersions((el('rdd-ver-search') ? el('rdd-ver-search').value : '').trim().toLowerCase());
  };

  // Clicking anywhere outside the armed Confirm buttons (or the clean button)
  // disarms every pending confirmation again.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (t && typeof t.closest === 'function' && (t.closest('.rdd-ver-del') || t.closest('#rdd-clean-btn'))) return;
    if (!_rddCleanArmed && !Object.keys(_rddRemoveArmed).length) return;
    _rddCleanArmed = false;
    _rddRemoveArmed = {};
    window.rddRenderInstalledVersions((el('rdd-ver-search') ? el('rdd-ver-search').value : '').trim().toLowerCase());
    rddUpdateDiskSummary();
  });

  window.rddRenderInstalledVersions = function (q) {
    const box = el('rdd-ver-list');
    if (!box) return;
    if (!_installedRddVersions.length) {
      box.innerHTML = '<div class="weao-hint">No installed versions found. Use RDD above to download one.</div>';
      return;
    }
    const list = _installedRddVersions.filter(v =>
      !q || String(v.hash || '').toLowerCase().includes(q) || String(v.location || '').toLowerCase().includes(q));
    if (!list.length) {
      box.innerHTML = '<div class="weao-hint">No versions match your search.</div>';
      return;
    }
    box.innerHTML = list.map(v => {
      const armed = !!_rddRemoveArmed[v.hash];
      const usage = _rddUsage[v.hash];
      const sizeHtml = Number.isFinite(usage) ? ' · ' + rddFmtBytes(usage) : '';
      const btnHtml = armed
        ? `<button class="btn btn-danger rdd-ver-del" style="flex-shrink:0;padding:5px 10px;font-size:11px" onclick="rddRemoveVersion('${esc(v.hash)}')">Confirm</button>`
        : `<button class="btn btn-ghost rdd-ver-del" style="flex-shrink:0;padding:5px 8px" title="Remove this version" onclick="rddArmRemove('${esc(v.hash)}')"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>`;
      const openHtml = `<button class="btn btn-ghost rdd-ver-open" style="flex-shrink:0;padding:5px 8px" title="Open install directory" onclick="rddOpenVersion('${esc(v.hash)}')"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/></svg></button>`;
      return `<div class="rdd-ver-row">
        <img class="rdd-ver-icon" src="roblox_icon.png" alt=""/>
        <div class="rdd-ver-info">
          <div class="rdd-ver-hash">${esc(v.hash)}</div>
          <div class="rdd-ver-loc">${v.complete === false ? '<span class="rdd-ver-incomplete">Incomplete — cannot launch</span>' : esc(v.location || 'Installed') + sizeHtml}</div>
        </div>
        <div class="rdd-ver-actions">${openHtml}${btnHtml}</div>
      </div>`;
    }).join('');
    // Anything not rendered stops being armed (keeps the map small).
    for (const h of Object.keys(_rddRemoveArmed)) {
      if (!list.some(v => v.hash === h)) delete _rddRemoveArmed[h];
    }
    rddUpdateDiskSummary();
  };

  window.rddOpenVersion = async function (hash) {
    const result = await api.openRobloxVersionDirectory(hash);
    if (result && result.ok) return;
    toast(result?.error || 'Could not open the install directory', 'err');
    // Re-scan immediately if the folder was deleted outside the app.
    window.rddLoadInstalledVersions();
  };

  window.rddRemoveVersion = async function (hash) {
    const box = el('rdd-ver-list');
    if (box) box.innerHTML = '<div class="weao-hint">Removing…</div>';
    const r = await api.removeRobloxVersion(hash);
    if (r && r.ok) {
      delete _rddRemoveArmed[hash];
      // Just drop the removed version from the local list — no full re-scan.
      _installedRddVersions = _installedRddVersions.filter(v => v.hash !== hash);
      toast(`Removed ${truncate(hash, 18)}`, 'ok');
      logEntry('ok', 'rdd', `Removed installed Roblox version ${hash}`);
      window.rddRenderInstalledVersions((el('rdd-ver-search') ? el('rdd-ver-search').value : '').trim().toLowerCase());
    } else {
      toast(r?.error || 'Could not remove version', 'err');
      window.rddRenderInstalledVersions((el('rdd-ver-search') ? el('rdd-ver-search').value : '').trim().toLowerCase());
    }
  };

  function weaoVerRow(platform, version, date, binaryType) {
    if (!version) return '';
    const clickable = binaryType && String(version).startsWith('version-');
    const verHtml = clickable
      ? `<span class="weao-ver clickable" title="Load into the downloader below" onclick="rddUseWeaoVer('${binaryType}','${esc(version)}')">${esc(version)}</span>`
      : `<span class="weao-ver">${esc(version)}</span>`;
    return `<div class="weao-row"><span class="weao-plat">${platform}</span>${verHtml}<span class="weao-date">${date ? esc(date) : ''}</span></div>`;
  }

  function weaoGroup(label, res) {
    if (!res || !res.ok || !res.data) {
      const msg = res && res.error ? esc(res.error) : 'unavailable';
      return `<div class="weao-group"><div class="weao-glabel">${label}</div><div class="weao-row"><span class="weao-plat">—</span><span class="weao-ver muted">${msg}</span><span class="weao-date"></span></div></div>`;
    }
    const d = res.data;
    let rows = '';
    rows += weaoVerRow('Windows', d.Windows, d.WindowsDate, 'WindowsPlayer');
    return `<div class="weao-group"><div class="weao-glabel">${label}</div>${rows}</div>`;
  }

  window.rddLoadWeaoVersions = async function () {
    const box = el('weao-versions');
    if (!box) return;
    const refreshBtn = el('weao-ver-refresh');
    if (refreshBtn) refreshBtn.disabled = true;
    box.innerHTML = '<div class="weao-hint">Loading current version…</div>';
    try {
      const cur = await api.weaoVersions('current');
      if (cur && cur.rateLimited) {
        box.innerHTML = '<div class="weao-hint">Rate limited by WEAO — press Refresh again in a moment.</div>';
        return;
      }
      box.innerHTML = weaoGroup('Current', cur);
      try {
        const d = cur && cur.ok && cur.data ? cur.data : null;
        if (d && d.Windows) _rddWeaoCurrentHash = String(d.Windows);
      } catch {}
      weaoVersionsLoaded = true;
    } catch (e) {
      box.innerHTML = `<div class="weao-hint">Failed to load versions: ${esc(e.message)}</div>`;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  };

  // Load a WEAO version hash straight into the deployment downloader below.
  window.rddUseWeaoVer = function (binaryType, hash) {
    if (!hash) return;
    el('rdd-channel').value = 'LIVE';
    el('rdd-binaryType').value = binaryType;
    window.rddPopulateArch();
    el('rdd-version').value = hash;
    toast(`Loaded ${hash} into downloader`, 'ok');
  };


  function requestBinary(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        if (xhr.status === 200 && xhr.response) resolve(xhr.response);
        else reject(new Error(`HTTP ${xhr.status} @ ${url}`));
      };
      xhr.onerror = () => reject(new Error(`request failed @ ${url}`));
      xhr.send();
    });
  }

  function rddUpdateProgress(text, pct) {
    // The download process lives inside the Download button: fill its bar and
    // block it while a transfer is running (label text never changes).
    const dlBar = el('rdd-download-bar');
    if (dlBar) dlBar.style.width = Math.max(0, Math.min(100, Math.round(pct))) + '%';
    // Mirror into the topbar status bar so a renderer-side RDD download is
    // visible from any tab (main-process installs push the same channel).
    if (typeof window.tbDlShow === 'function') {
      if (pct >= 100) {
        window.tbDlShow(text || 'Installation complete!', 100, 'done');
        window.tbDlHideSoon(4000);
      } else {
        window.tbDlShow(text || 'Downloading Roblox version…', pct, '');
      }
    }
  }

  async function reassembleWindows(channel, binaryType, version, versionPath, manifestBody) {
    const lines = manifestBody.split('\n').map((l) => l.trim());
    if (lines[0] !== 'v0') { throw new Error(`Unknown manifest format; expected "v0", got "${lines[0]}"`); }

    let roots;
    if (lines.includes('RobloxApp.zip')) {
      roots = EXTRACT_ROOTS.player;
    } else if (lines.includes('RobloxStudio.zip')) {
      roots = EXTRACT_ROOTS.studio;
    } else {
      throw new Error('Unrecognized rbxPkgManifest');
    }

    rddUpdateProgress(`Downloading packages for ${truncate(version, 14)}…`, 10);

    // Save AppSettings.xml
    const appSettingsB64 = btoa('<?xml version="1.0" encoding="UTF-8"?>\n<Settings>\n\t<ContentFolder>content</ContentFolder>\n\t<BaseUrl>http://www.roblox.com</BaseUrl>\n</Settings>\n');
    await api.rddSaveExtractedFile(version, 'AppSettings.xml', appSettingsB64);

    const packages = lines.filter((l) => l.endsWith('.zip'));
    let completedPkgs = 0;

    for (const pkg of packages) {
      const data = await requestBinary(versionPath + pkg);
      const root = roots[pkg] || '';
      const packageZip = await JSZip.loadAsync(data);

      const fileEntries = Object.keys(packageZip.files);
      const batch = [];
      for (const fileName of fileEntries) {
        const zipObj = packageZip.files[fileName];
        if (zipObj.dir) continue;

        const relPath = (root + fileName.replace(/\\/g, '/')).replace(/^\//, '');
        const arrayBuf = await zipObj.async('arraybuffer');

        let binary = '';
        const bytes = new Uint8Array(arrayBuf);
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        batch.push({ relPath, base64Data: btoa(binary) });
      }

      if (batch.length) {
        if (typeof api.rddSaveExtractedBatch === 'function') {
          await api.rddSaveExtractedBatch(version, batch);
        } else if (typeof api.rddSaveExtractedFile === 'function') {
          for (const item of batch) {
            await api.rddSaveExtractedFile(version, item.relPath, item.base64Data);
          }
        }
      }

      completedPkgs++;
      const currentPct = 10 + Math.round((completedPkgs / packages.length) * 85);
      rddUpdateProgress(`Installing ${pkg} (${completedPkgs}/${packages.length})…`, currentPct);
    }

    rddUpdateProgress('Installation complete!', 100);
    toast(`Version ${version} installed automatically!`, 'ok');
    logEntry('ok', 'rdd', `Automated installation complete for ${version}`);

    try {
      _installedVersionsList = (await api.getInstalledVersions()) || [];
      if (typeof onLaunchExploitFilterChange === 'function') onLaunchExploitFilterChange();
      if (typeof window.rddLoadInstalledVersions === 'function') window.rddLoadInstalledVersions();
    } catch {}

  }

  window.performAutomatedRddInstallation = async function(versionHash) {
    const version = versionHash.startsWith('version-') ? versionHash : 'version-' + versionHash;
    const hosts = [
      'https://setup.rbxcdn.com/',
      'https://setup-aws.rbxcdn.com/',
      'https://setup-ak.rbxcdn.com/',
      'https://setup.rbxcdn.com/channel/common/',
      'https://setup-aws.rbxcdn.com/channel/common/',
      'https://setup.rbxcdn.com/channel/zlive/',
      'https://setup-aws.rbxcdn.com/channel/zlive/'
    ];

    rddUpdateProgress(`Fetching manifest for ${truncate(version, 14)}…`, 5);
    let resp = null;
    let validVersionPath = '';

    for (const h of hosts) {
      const vPath = `${h}${version}-`;
      try {
        const r = await fetch(vPath + 'rbxPkgManifest.txt');
        if (r.ok) {
          resp = r;
          validVersionPath = vPath;
          break;
        }
      } catch {}
    }

    if (!resp || !resp.ok) {
      throw new Error(`Roblox manifest for ${truncate(version, 14)} is no longer hosted on CDN.`);
    }

    const manifestBody = await resp.text();
    await reassembleWindows('LIVE', 'WindowsPlayer', version, validVersionPath, manifestBody);
  };

  window.rddDownload = async function () {
    if (rddBusy) return;
    const channel = el('rdd-channel').value.trim() || 'LIVE';
    const binaryType = el('rdd-binaryType').value;
    const arch = el('rdd-arch').value;
    let version = el('rdd-version').value.trim().toLowerCase();

    const btObj = BINARY_TYPES[binaryType];
    if (!btObj) { toast(`Unsupported binaryType "${binaryType}"`, ''); return; }
    if (typeof JSZip === 'undefined') { toast('JSZip not available', ''); return; }
    const blobDir = btObj.blobDirs[arch] || Object.values(btObj.blobDirs)[0];

    rddBusy = true;
    const dlBtn = el('rdd-download-btn');
    const dlBar = el('rdd-download-bar');
    if (dlBtn) dlBtn.disabled = true;
    if (dlBar) dlBar.style.width = '0%';
    try {
      if (!version) {
        rddUpdateProgress(`Resolving latest version…`, 5);
        const r = await api.rddGetVersion(channel, binaryType);
        if (!r || !r.ok || !r.versionHash) { toast('Version lookup failed', ''); return; }
        version = r.versionHash.toLowerCase();
        el('rdd-version').value = version;
      }
      if (!version.startsWith('version-')) version = 'version-' + version;

      const channelName = channel.toUpperCase() === 'LIVE' ? 'LIVE' : channel.toLowerCase();
      let channelPath = channelName === 'LIVE' ? HOST : `${HOST}/channel/${channelName}`;
      let versionPath = `${channelPath}${blobDir}${version}-`;

      logEntry('info', 'rdd', `Automated RDD download started: ${binaryType} ${version}`);
      rddUpdateProgress(`Fetching package manifest…`, 5);

      let resp = await fetch(versionPath + 'rbxPkgManifest.txt');
      if (!resp.ok) {
        channelPath = `${HOST}/channel/common`;
        versionPath = `${channelPath}${blobDir}${version}-`;
        resp = await fetch(versionPath + 'rbxPkgManifest.txt');
      }
      if (!resp.ok) { toast('Manifest fetch failed — check version hash', ''); return; }
      const manifestBody = await resp.text();

      await reassembleWindows(channel, binaryType, version, versionPath, manifestBody);
    } catch (e) {
      toast('RDD installation failed: ' + e.message, '');
      logEntry('err', 'rdd', `RDD installation failed: ${e.message}`);
    } finally {
      rddBusy = false;
      if (dlBtn) dlBtn.disabled = false;
      if (dlBar) dlBar.style.width = '0%';
    }
  };
})();

(function () {
  let data = [];
  let loaded = false;
  let wired = false;
  const el = (id) => document.getElementById(id);

  window.executorsInit = function () {
    if (!wired) {
      const list = el('exec-list');
      if (list) {
        // Delegated open-link handler — keeps third-party URLs out of inline onclick.
        list.addEventListener('click', (ev) => {
          const btn = ev.target.closest('.exec-link');
          if (btn && btn.dataset.url) api.openExternal(btn.dataset.url);
        });
        wired = true;
      }
    }
    if (!loaded) window.executorsLoad();
  };

  window.executorsLoad = async function () {
    const status = el('exec-status');
    const list = el('exec-list');
    if (status) { status.style.display = ''; status.textContent = 'Loading executors…'; }
    if (list) list.innerHTML = '';
    try {
      const res = await api.weaoExploits();
      if (!res || !res.ok) {
        if (status) status.textContent = res && res.rateLimited ? 'Rate limited by WEAO — press Refresh shortly.' : `Failed to load: ${res?.error || 'unknown error'}`;
        return;
      }
      data = (res.data || []).filter((e) => !e.hidden);
      loaded = true;
      window.executorsRender();
    } catch (e) {
      if (status) status.textContent = 'Failed to load: ' + e.message;
    }
  };

  function pill(text, cls, title) {
    return `<span class="exec-pill ${cls}"${title ? ` title="${title}"` : ''}>${text}</span>`;
  }

  function feat(on) {
    return on ? '<span style="color:var(--green);font-weight:700">✓</span>' : '<span style="color:var(--t3)">✕</span>';
  }

  function row(e) {
    const name = e.title || 'Unknown';
    const isDefault = _defaultExecutor === name;
    const excluded = _disabledExecutors.includes(name);
    const updated = e.updateStatus ? pill('Updated', 'ok') : pill('Outdated', 'bad');
    const ver = e.version ? pill(String(e.version).replace(/^v/, ''), 'muted') : '';
    const plat = e.platform ? pill(esc(String(e.platform)), 'muted') : '';

    const links = [];
    if (e.websitelink) links.push(`<button class="btn btn-ghost exec-link" data-url="${esc(e.websitelink)}" title="Website"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>Website</button>`);
    if (e.discordlink) links.push(`<button class="btn btn-ghost exec-link" data-url="${esc(e.discordlink)}" title="Discord"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-6-6 6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Discord</button>`);
    // No Purchase button — user requested.

    const stats = [];
    if (typeof e.suncPercentage === 'number') stats.push(`<span>sUNC: <b>${e.suncPercentage}%</b></span>`);
    if (typeof e.uncPercentage === 'number') stats.push(`<span>UNC: <b>${e.uncPercentage}%</b></span>`);
    if (typeof e.decompiler === 'boolean') stats.push(`<span>Decompiler: ${feat(e.decompiler)}</span>`);
    if (typeof e.multiInject === 'boolean') stats.push(`<span>Multi-Instance: ${feat(e.multiInject)}</span>`);
    if (typeof e.raknet === 'boolean') stats.push(`<span>Raknet Library: ${feat(e.raknet)}</span>`);

    return `<div class="exec-row${excluded ? ' excluded' : ''}">
      <div class="exec-row-head">
        <div class="exec-row-title">
          <span class="exec-row-name">${esc(name)}</span>
          ${isDefault ? pill('Default', 'accent') : ''}
          ${excluded ? pill('Hidden', 'bad') : ''}
        </div>
        <div class="exec-row-pills">${ver}${plat}${updated}</div>
      </div>
      ${e.updatedDate ? `<div class="exec-row-updated">Last updated: ${esc(String(e.updatedDate))}</div>` : ''}
      <div class="exec-row-actions">${links.join('')}</div>
      ${stats.length ? `<div class="exec-row-stats">${stats.join('')}</div>` : ''}
    </div>`;
  }

  window.executorsRender = function () {
    const list = el('exec-list');
    const status = el('exec-status');
    if (!list) return;
    if (!data.length) {
      list.innerHTML = '';
      if (status) { status.style.display = ''; status.textContent = 'No executor data available.'; }
      return;
    }
    const visible = data.filter((e) => !_disabledExecutors.includes(e.title || e.name || e.exploit || 'Exploit'));
    if (!visible.length) {
      list.innerHTML = '';
      if (status) { status.style.display = ''; status.textContent = 'All executors are hidden — enable some in “Default Executor &amp; Exclusions” below.'; }
      return;
    }
    if (status) {
      status.textContent = `Showing ${visible.length} of ${data.length} enabled executors — manage which are enabled below.`;
      status.style.display = '';
    }
    list.innerHTML = visible.map(row).join('');
  };
})();
/* ═════════════════════════════════════════════════════════════════════════
   THEME ENGINE
   ═════════════════════════════════════════════════════════════════════════ */
const THEME_KEY = 'rblx_theme';
const THEME_PRESETS = [
  { id: 'midnight', name: 'Midnight', accent: '#5c5ce0', dark: 50 },
  { id: 'ocean',    name: 'Ocean',    accent: '#3b9dd4', dark: 62 },
  { id: 'forest',   name: 'Forest',   accent: '#3ecf8e', dark: 70 },
  { id: 'sunset',   name: 'Sunset',   accent: '#f0766f', dark: 45 },
  { id: 'violet',   name: 'Violet',   accent: '#b46be0', dark: 55 },
  { id: 'gold',     name: 'Gold',     accent: '#e0a83c', dark: 35 },
  { id: 'crimson',  name: 'Crimson',  accent: '#e0405c', dark: 80 },
  { id: 'slate',    name: 'Slate',    accent: '#8a94a6', dark: 90 },
];
const DEFAULT_THEME = { preset: 'midnight', accent: '#5c5ce0', dark: 50, radius: 10, scale: 100, reduceMotion: false };
let _theme = { ...DEFAULT_THEME };

function loadTheme() {
  try { const raw = localStorage.getItem(THEME_KEY); if (raw) _theme = { ...DEFAULT_THEME, ...JSON.parse(raw) }; } catch {}
  _theme.dark = Math.max(0, Math.min(100, +_theme.dark || 50));
  _theme.radius = Math.max(0, Math.min(22, +_theme.radius || 10));
  _theme.scale = Math.max(85, Math.min(125, +_theme.scale || 100));
}
function saveTheme() { try { localStorage.setItem(THEME_KEY, JSON.stringify(_theme)); } catch {} }

function themeMix(hex, f) { // f<0 darken, f>0 lighten toward white
  const n = parseInt(hex.slice(1), 16);
  const c = v => f < 0 ? Math.round(v * (1 + f)) : Math.round(v + (255 - v) * f);
  return '#' + [c(n >> 16 & 255), c(n >> 8 & 255), c(n & 255)].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}
function themeSurfaces(dark) {
  const d = dark / 100;
  const bg = themeMix(themeMix('#0e0e10', -0.55), d * 0.32);
  const s1 = themeMix(themeMix('#111114', -0.5), d * 0.34);
  const s2 = themeMix(themeMix('#18181d', -0.5), d * 0.36);
  const s3 = themeMix(themeMix('#1f1f26', -0.5), d * 0.38);
  const s4 = themeMix(themeMix('#26262f', -0.5), d * 0.40);
  const lum = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; };
  const light = lum(bg) > 0.45;
  return { bg, s1, s2, s3, s4, t1: light ? '#141418' : '#f0f0f5', t2: light ? '#4a4a55' : '#aaaab2', t3: light ? '#84848f' : '#73737d' };
}

function applyTheme() {
  const t = _theme;
  const r = document.documentElement;
  const ac = t.accent || DEFAULT_THEME.accent;
  const sur = themeSurfaces(t.dark);
  r.style.setProperty('--bg', sur.bg);
  r.style.setProperty('--s1', sur.s1);
  r.style.setProperty('--s2', sur.s2);
  r.style.setProperty('--s3', sur.s3);
  r.style.setProperty('--s4', sur.s4);
  r.style.setProperty('--t1', sur.t1);
  r.style.setProperty('--t2', sur.t2);
  r.style.setProperty('--t3', sur.t3);
  r.style.setProperty('--ac', ac);
  r.style.setProperty('--ac-h', themeMix(ac, 0.18));
  r.style.setProperty('--ac2', hexToRgba(ac, 0.35));
  r.style.setProperty('--ac3', hexToRgba(ac, 0.5));
  r.style.setProperty('--r', t.radius + 'px');
  r.style.setProperty('--r2', Math.max(0, t.radius - 2) + 'px');
  r.style.fontSize = (t.scale / 100 * 16) + 'px';
  r.classList.toggle('th-no-motion', !!t.reduceMotion);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('theme-accent', ac); set('theme-accent-hex', ac);
  set('theme-darkness', t.dark); set('theme-radius', t.radius); set('theme-scale', t.scale);
  const rm = document.getElementById('theme-reduce-motion'); if (rm) rm.checked = !!t.reduceMotion;
  const dl = document.getElementById('theme-dark-label'); if (dl) dl.textContent = t.dark < 33 ? 'Deep' : t.dark < 66 ? 'Dark' : 'Soft';
  const rl = document.getElementById('theme-radius-label'); if (rl) rl.textContent = t.radius + 'px';
  const sl = document.getElementById('theme-scale-label'); if (sl) sl.textContent = t.scale + '%';
  document.querySelectorAll('.th-range, .pill-range-track').forEach(el => {
    const min = +el.min || 0, max = +el.max || 100;
    el.style.setProperty('--fill', ((+el.value - min) / (max - min) * 100) + '%');
  });
  document.querySelectorAll('.th-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === t.preset));
}

function renderThemePresets() {
  const grid = document.getElementById('theme-preset-grid');
  if (!grid) return;
  grid.innerHTML = THEME_PRESETS.map(p => {
    const sur = themeSurfaces(p.dark);
    return `<div class="th-preset${_theme.preset === p.id ? ' active' : ''}" data-preset="${p.id}" onclick="onThemePreset('${p.id}')">
      <div class="sw-chips">
        <span class="sw-chip" style="background:${p.accent}"></span>
        <span class="sw-chip" style="background:${sur.s2}"></span>
        <span class="sw-chip" style="background:${sur.bg}"></span>
      </div>
      <div class="sw-name">${esc(p.name)}</div>
    </div>`;
  }).join('');
}

function onThemePreset(id) {
  const p = THEME_PRESETS.find(x => x.id === id);
  if (!p) return;
  _theme = { ..._theme, preset: p.id, accent: p.accent, dark: p.dark };
  saveTheme(); applyTheme(); renderThemePresets();
}
function onThemeAccentInput(v) { _theme.accent = v; _theme.preset = ''; saveTheme(); applyTheme(); renderThemePresets(); }
function onThemeAccentHexInput(v) {
  v = (v || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) { _theme.accent = v; _theme.preset = ''; saveTheme(); applyTheme(); renderThemePresets(); }
}
function onThemeDarkness(v) { _theme.dark = +v; _theme.preset = ''; saveTheme(); applyTheme(); renderThemePresets(); }
function _thRangeFill(el) { const min = +el.min || 0, max = +el.max || 100; el.style.setProperty('--fill', ((+el.value - min) / (max - min) * 100) + '%'); }
function onThemeRadius(v) { _theme.radius = +v; saveTheme(); applyTheme(); _thRangeFill(document.getElementById('theme-radius')); }
function onThemeScale(v) { _theme.scale = +v; saveTheme(); applyTheme(); _thRangeFill(document.getElementById('theme-scale')); }
function onThemeReduceMotion(on) { _theme.reduceMotion = !!on; saveTheme(); applyTheme(); }
function resetTheme() { _theme = { ...DEFAULT_THEME }; saveTheme(); applyTheme(); renderThemePresets(); toast('Theme reset to default', 'ok'); }

function initTheme() {
  loadTheme();
  applyTheme();
  renderThemePresets();
}

/* ═════════════════════════════════════════════════════════════════════════
   ONBOARDING TUTORIAL
   ═════════════════════════════════════════════════════════════════════════ */
const TUTORIAL_KEY = 'rblx_tutorial_done';
const TUT_STEPS = [
  { title: 'Welcome to rbxSWAP', text: 'Your multi-account Roblox launcher. Add accounts once, switch and launch them in seconds — sessions, spoofing and version management all live here.', icon: 'rocket' },
  { title: 'Accounts', text: 'This is your home. Each card shows an account with live presence, RAM stats and quick actions. Use the search and filter to organize, right-click a card for per-account tools.', icon: 'users' },
  { title: 'Launch & Swap', text: 'Launch any account into Roblox, or open the Swap tab to spoof MAC, HWID and volume identifiers before a session — with restore points when you need them.', icon: 'zap' },
  { title: 'RDD & Executors', text: 'The RDD tab downloads and manages Roblox versions on disk, cleaning old ones safely. The Executor tab picks which executor gets attached to launches.', icon: 'download' },
  { title: 'Make it yours', text: 'Under Settings → Appearance & Themes you can restyle everything: accent color, brightness, radius, interface scale and more. You can replay this tour anytime from Settings → Help.', icon: 'palette' },
];
const TUT_ICONS = {
  rocket: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  users: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  zap: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  download: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  palette: '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>',
};
let _tutStep = 0;

function tutRender() {
  const s = TUT_STEPS[_tutStep];
  const count = document.getElementById('tut-count');
  const title = document.getElementById('tut-title');
  const text = document.getElementById('tut-text');
  const icon = document.getElementById('tut-step-icon');
  const dots = document.getElementById('tut-dots');
  const next = document.getElementById('tut-next');
  const body = document.querySelector('.tut-body');
  if (!title || !icon) return;
  // Cross-step transition: fade+drift the content out, swap content, ease back in.
  const swap = () => {
    count.textContent = `Step ${_tutStep + 1} of ${TUT_STEPS.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    icon.innerHTML = TUT_ICONS[s.icon] || '';
    dots.innerHTML = TUT_STEPS.map((_, i) => `<div class="tut-dot${i <= _tutStep ? ' on' : ''}"></div>`).join('');
    next.textContent = _tutStep === TUT_STEPS.length - 1 ? 'Done' : _tutStep === 0 ? 'Get started' : 'Next';
    requestAnimationFrame(() => {
      icon.classList.add('show');
      body.classList.remove('tut-leaving');
    });
  };
  icon.classList.remove('show');
  body.classList.add('tut-leaving');
  setTimeout(swap, 170);
}
function tutNext() {
  if (_tutStep < TUT_STEPS.length - 1) { _tutStep++; tutRender(); }
  else closeTutorial(true);
}
function startTutorial() {
  _tutStep = 0;
  tutRender();
  openModal('m-tutorial');
}
function closeTutorial(finished) {
  closeModal('m-tutorial');
  try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch {}
  if (finished) toast('You are all set — enjoy rbxSWAP!', 'ok');
}
function maybeAutoTutorial() {
  let done = false;
  try { done = localStorage.getItem(TUTORIAL_KEY) === '1'; } catch {}
  if (!done) setTimeout(() => startTutorial(), 450);
}
