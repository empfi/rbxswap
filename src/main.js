const { app, BrowserWindow, ipcMain, shell, net, session, safeStorage, Tray, Menu, dialog } = require('electron');

const path = require('path');
if (process.platform === 'win32') {
  app.setPath('userData', path.join(app.getPath('appData'), 'rblxswap'));
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
app.commandLine.appendSwitch('user-agent', CHROME_UA);
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendArgument('--no-sandbox');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const Module = require('module');

const execFileAsync = promisify(execFile);
const fsPromises = fs.promises;
const hwid = require('./hwid'); 

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); });

let _antiAfkProc = null;
let _mutexProc = null;
let _mutexReady = false;
let _mutexReadyPromise = null;
const _accountPids = new Map(); 


const _launchGenerations = new Map(); 
const _watchGenerations = new Map(); 
const _launchVolumeTimers = new Map(); 
const _launchVolumeGenerations = new Map(); 

let _nativeHelperPromise = null;

function nativeSrcPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'RobloxNative.cs')
    : path.join(__dirname, 'RobloxNative.cs');
}

function pruneStaleNativeHelpers(keepName) {
  if (process.platform !== 'win32') return;
  try {
    const base = app.getPath('userData');
    for (const name of fs.readdirSync(base)) {
      const isHashed = /^RobloxNative-[0-9a-f]{16}\.exe$/.test(name);
      const isPlainLegacy = name === 'RobloxNative.exe'; 
      if ((isHashed || isPlainLegacy) && name !== keepName) {
        try { fs.unlinkSync(path.join(base, name)); } catch {}
      }
    }
  } catch {}
}

function pruneChromiumCaches() {
  if (process.platform !== 'win32') return;
  const base = app.getPath('userData');
  const junk = [
    'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'Session Storage', 'Shared Dictionary', 'SharedDictionary', 'blob_storage',
    'SharedStorage', 'SharedStorage-wal', 'DIPS', 'DIPS-wal',
  ];
  for (const name of junk) {
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch {}
  }
}
function bundledNativeExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'RobloxNative.exe')
    : path.join(__dirname, 'RobloxNative.exe');
}
function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}



function ensureNativeHelper() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (_nativeHelperPromise) return _nativeHelperPromise;
  _nativeHelperPromise = (async () => {
    const src = nativeSrcPath();
    let sourceVersion = 'unknown';
    try {
      sourceVersion = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16);
    } catch {}
    
    try { if (!fs.existsSync(src)) return null; } catch { return null; }
    const outExe = path.join(app.getPath('userData'), `RobloxNative-${sourceVersion}.exe`);
    try {
      
      if (fs.existsSync(outExe) && fs.statSync(outExe).mtimeMs >= fs.statSync(src).mtimeMs) {
        pruneStaleNativeHelpers(path.basename(outExe));
        return outExe;
      }
    } catch {}
    const csc = findCsc();
    if (!csc) { console.error('[native] csc.exe not found; native helper unavailable'); return null; }
    const ok = await new Promise((resolve) => {
      try {
        const proc = spawn(csc, [
          '/nologo', '/optimize+', '/platform:x64', '/target:exe',
          '/out:' + outExe, src,
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let err = '';
        if (proc.stderr) proc.stderr.on('data', d => { err += d.toString(); });
        proc.on('error', () => resolve(false));
        proc.on('exit', (code) => {
          if (code !== 0 && err.trim()) console.error('[native] compile failed:', err.trim());
          resolve(code === 0 && fs.existsSync(outExe));
        });
        setTimeout(() => { try { proc.kill(); } catch {} resolve(fs.existsSync(outExe)); }, 30000);
      } catch (e) { console.error('[native] compile error:', e.message); resolve(false); }
    });
    if (ok) pruneStaleNativeHelpers(path.basename(outExe));
    return ok ? outExe : null;
  })();
  return _nativeHelperPromise;
}

function isMultiInstanceEnabled() {
  return !!(loadSettings().multiInstance);
}

async function startMutexHolder() {
  if (process.platform !== 'win32') return;
  if (_mutexProc) return _mutexReadyPromise || Promise.resolve();
  const nativeExe = await ensureNativeHelper();
  _mutexReadyPromise = new Promise((resolve) => {
    try {
      if (!nativeExe) { console.error('[mutex] native helper unavailable'); resolve(); return; }
      _mutexProc = spawn(nativeExe, ['mutex'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      _mutexProc.stdout.on('data', (data) => {
        if (data.toString().includes('MUTEX_HELD')) {
          _mutexReady = true;
          resolve();
        }
      });
      if (_mutexProc.stderr) _mutexProc.stderr.on('data', d => {
        const text = d.toString().trim();
        if (text) console.error('[mutex]', text);
      });
      setTimeout(resolve, 8000);
      _mutexProc.on('exit', () => { _mutexProc = null; _mutexReady = false; });
      _mutexProc.on('error', () => { _mutexProc = null; _mutexReady = false; resolve(); });
    } catch (e) {
      _mutexProc = null;
      _mutexReady = false;
      resolve();
    }
  });
  return _mutexReadyPromise;
}

function stopMutexHolder() {
  if (!_mutexProc) return;
  try { _mutexProc.kill(); } catch {}
  _mutexProc = null;
  _mutexReady = false;
  _mutexReadyPromise = null;
}

async function restartMutexHolder() {
  stopMutexHolder();
  await startMutexHolder();
}

function stopStaleNativeHelpers() {
  if (process.platform !== 'win32') return Promise.resolve();
  
  
  return new Promise((resolve) => {
    try {
      const cmd = 'taskkill /F /IM RobloxNative.exe /T 2>nul & ' +
        'wmic process where "name like \'RobloxNative-%\'" call terminate >nul 2>&1';
      const proc = spawn('cmd', ['/c', cmd], { windowsHide: true, stdio: 'ignore' });
      proc.on('error', () => resolve());
      proc.on('close', () => resolve());
      setTimeout(() => resolve(), 3000);
    } catch { resolve(); }
  });
}

async function startAntiAfk() {
  if (process.platform !== 'win32') return;
  if (_antiAfkProc) return;
  const nativeExe = await ensureNativeHelper();
  if (!nativeExe) { console.error('[antiafk] native helper unavailable; cannot run anti-AFK'); return; }
  const s = loadSettings();
  let deadline = parseInt(s.antiAfkInterval, 10);
  if (!Number.isFinite(deadline) || deadline < 60) deadline = 19 * 60; 
  try {
    _antiAfkProc = spawn(nativeExe, ['antiafk', String(deadline)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    sendLog('ok', 'afk', `Anti-AFK started (interval: ${Math.round(deadline/60)} min)`, { intervalSec: deadline });
    if (_antiAfkProc.stdout) _antiAfkProc.stdout.on('data', d => {
      const lines = d.toString().trim().split('\n');
      for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        const mw = t.match(/^ANTIAFK_TICK:(\d+)$/);
        if (mw) sendLog('info', 'afk', `Anti-AFK: tapped ${mw[1]} Roblox window${mw[1]==='1'?'':'s'}`, { windows: parseInt(mw[1]) });
        else sendLog('info', 'afk', `Anti-AFK: ${t}`);
      }
    });
    if (_antiAfkProc.stderr) _antiAfkProc.stderr.on('data', d => {
      const t = d.toString().trim();
      if (t) { console.error('[antiafk]', t); sendLog('warn', 'afk', `Anti-AFK warning: ${t}`); }
    });
    _antiAfkProc.on('exit', (code) => { sendLog('warn', 'afk', `Anti-AFK process exited (code ${code})`); _antiAfkProc = null; });
    _antiAfkProc.on('error', (e) => { sendLog('err', 'afk', `Anti-AFK process error: ${e.message}`); _antiAfkProc = null; });
  } catch (e) { _antiAfkProc = null; console.error('[antiafk] spawn failed:', e.message); }
}

function stopAntiAfk() {
  if (!_antiAfkProc) return;
  sendLog('warn', 'afk', 'Anti-AFK stopped');
  try { _antiAfkProc.kill(); } catch {}
  _antiAfkProc = null;
}


function waitForRobloxFullyClosed(maxWaitMs = 5000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      let out = '';
      try {
        const proc = spawn('cmd', ['/c',
          'tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH & tasklist /FI "IMAGENAME eq RobloxCrashHandler.exe" /NH'
        ], { windowsHide: true });
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve());
        proc.on('close', () => {
          const stillRunning = /RobloxPlayerBeta\.exe|RobloxCrashHandler\.exe/i.test(out);
          if (!stillRunning || Date.now() - startedAt >= maxWaitMs) { resolve(); return; }
          setTimeout(check, 300);
        });
      } catch { resolve(); }
    };
    check();
  });
}



function isRobloxPlayerPid(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return false;
  return new Promise((resolve) => {
    let out = '';
    try {
      const proc = spawn('cmd', ['/c', `tasklist /FI "PID eq ${pid}" /NH`], { windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => resolve(false));
      proc.on('close', () => resolve(new RegExp(`RobloxPlayerBeta\\.exe\\s+${pid}\\s`, 'i').test(out)));
    } catch { resolve(false); }
  });
}

function scheduleLaunchVolume(accountId, requestedVolume, launchStartedAt, launchPid) {
  const oldTimer = _launchVolumeTimers.get(accountId);
  if (oldTimer) clearTimeout(oldTimer);
  const generation = (_launchVolumeGenerations.get(accountId) || 0) + 1;
  _launchVolumeGenerations.set(accountId, generation);
  const startedAt = Date.now();
  const isCurrent = () => _launchVolumeGenerations.get(accountId) === generation;
  const attempt = async () => {
    if (!isCurrent() || Date.now() - startedAt >= 45000) {
      if (isCurrent()) _launchVolumeTimers.delete(accountId);
      return;
    }
    try {
      let result;
      const currentPid = Number.isInteger(_accountPids.get(accountId))
        ? _accountPids.get(accountId)
        : launchPid;
      if (Number.isInteger(currentPid) && currentPid > 0) {
        result = await setRobloxVolume(requestedVolume, [currentPid]);
      } else {
        
        result = await setRobloxVolumeAfter(requestedVolume, launchStartedAt);
      }
      if (result && result.count > 0 && Number.isInteger(currentPid)) {
        
        
      }
    } catch (e) {
      console.error('[volume] launch retry failed:', e.message);
    }
    if (!isCurrent()) return;
    const timer = setTimeout(attempt, 2000);
    _launchVolumeTimers.set(accountId, timer);
  };
  const timer = setTimeout(attempt, 9000);
  _launchVolumeTimers.set(accountId, timer);
}

async function setRobloxVolumeAfter(percent, sinceMs) {
  if (process.platform !== 'win32') return { ok: false, count: 0, error: 'Windows only' };
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const since = Number.isFinite(Number(sinceMs)) ? Math.round(Number(sinceMs)) : Date.now();
  const nativeExe = await ensureNativeHelper();
  return new Promise((resolve) => {
    let out = '';
    try {
      if (!nativeExe) { resolve({ ok: false, count: 0, error: 'native helper unavailable' }); return; }
      const proc = spawn(nativeExe, ['volumeafter', String(pct), String(since)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      if (proc.stderr) proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[volumeafter]', s); });
      proc.on('error', () => resolve({ ok: false, count: 0, error: 'spawn failed' }));
      proc.on('close', () => {
        const m = out.match(/SET:(\d+)/);
        resolve({ ok: true, count: m ? parseInt(m[1], 10) : 0 });
      });
      setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: true, count: 0 }); }, 12000);
    } catch (e) { resolve({ ok: false, count: 0, error: e.message }); }
  });
}


async function setRobloxVolume(percent, pids) {
  if (process.platform !== 'win32') return { ok: false, count: 0, error: 'Windows only' };
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const targetPids = Array.isArray(pids) ? pids.filter(pid => Number.isInteger(pid) && pid > 0) : [];
  const nativeExe = await ensureNativeHelper();
  return new Promise((resolve) => {
    let out = '';
    try {
      if (!nativeExe) { resolve({ ok: false, count: 0, error: 'native helper unavailable' }); return; }
      const args = ['volume', String(pct), ...targetPids.map(String)];
      const proc = spawn(nativeExe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      if (proc.stderr) proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[volume]', s); });
      proc.on('error', () => resolve({ ok: false, count: 0, error: 'spawn failed' }));
      proc.on('close', () => {
        const m = out.match(/SET:(\d+)/);
        resolve({ ok: true, count: m ? parseInt(m[1], 10) : 0 });
      });
      
      setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: true, count: 0 }); }, 12000);
    } catch (e) {
      resolve({ ok: false, count: 0, error: e.message });
    }
  });
}

function normalizeRamLimitMb(value) {
  const mb = Number(value);
  if (!Number.isFinite(mb)) return null;
  const rounded = Math.round(mb);
  return rounded >= 256 && rounded <= 8192 ? rounded : null;
}

function applyRamLimit(accountId, pid, mb, launchStartedAt) {
  const old = _ramLimitProcs.get(accountId);
  if (old) { try { old.kill(); } catch {} _ramLimitProcs.delete(accountId); }
  const limit = normalizeRamLimitMb(mb);
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'RAM limiting is supported on Windows only' });
  }
  if (!Number.isInteger(pid) || pid <= 0 || limit === null) {
    return Promise.resolve({ ok: false, error: 'invalid RAM limit or Roblox PID' });
  }
  const since = Number.isFinite(Number(launchStartedAt)) ? Math.round(Number(launchStartedAt)) : Date.now();
  return ensureNativeHelper().then((nativeExe) => new Promise((resolve) => {
    
    
    if (!nativeExe || _launchTimes.get(accountId) !== launchStartedAt || _accountPids.get(accountId) !== pid) {
      resolve({ ok: false, error: 'native helper unavailable or launch was superseded' });
      return;
    }
    let proc;
    let output = '';
    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    try {
      
      
      proc = spawn(nativeExe, ['setram', String(pid), String(limit), String(since)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      _ramLimitProcs.set(accountId, proc);
      if (proc.stdout) proc.stdout.on('data', d => {
        output += d.toString();
        const match = output.match(/RAM_SET:(\d+):(\d+)/);
        if (match) {
          sendLog('ok', 'performance', `RAM limit enforced at ${match[2]} MB (PID ${match[1]})`, { accountId, ramLimitMb: limit, pid: parseInt(match[1], 10) });
          finish({ ok: true, pid: parseInt(match[1], 10), mb: parseInt(match[2], 10) });
        }
      });
      if (proc.stderr) proc.stderr.on('data', d => {
        const text = d.toString().trim();
        if (text) console.error('[ram]', text);
      });
      proc.on('exit', (code) => {
        if (_ramLimitProcs.get(accountId) === proc) _ramLimitProcs.delete(accountId);
        if (!settled) finish({ ok: false, error: `native helper exited before applying the limit (code ${code})` });
      });
      proc.on('error', (err) => {
        if (_ramLimitProcs.get(accountId) === proc) _ramLimitProcs.delete(accountId);
        finish({ ok: false, error: `native helper failed: ${err.message}` });
      });
      
      
      timeout = setTimeout(() => {
        if (!settled) {
          try { proc.kill(); } catch {}
          if (_ramLimitProcs.get(accountId) === proc) _ramLimitProcs.delete(accountId);
          finish({ ok: false, error: 'Roblox did not become ready before the RAM-limit timeout' });
        }
      }, 95000);
    } catch (e) {
      if (proc && _ramLimitProcs.get(accountId) === proc) _ramLimitProcs.delete(accountId);
      finish({ ok: false, error: e.message });
    }
  })).catch((err) => ({ ok: false, error: err.message || 'native helper unavailable' }));
}

function clearRamLimit(accountId) {
  const proc = _ramLimitProcs.get(accountId);
  if (proc) { try { proc.kill(); } catch {} }
  _ramLimitProcs.delete(accountId);
}

function enforceRamLimitForAccount(accountId, pid, mb, launchStartedAt, generation) {
  const limit = normalizeRamLimitMb(mb);
  if (limit === null || process.platform !== 'win32') return;
  _accountRamLimits.set(accountId, limit);
  applyRamLimit(accountId, pid, limit, launchStartedAt).then(result => {
    if (!result.ok && _launchGenerations.get(accountId) === generation && _accountPids.get(accountId) === pid) {
      sendLog('warn', 'performance', `RAM limit was not enforced: ${result.error}`, { accountId, ramLimitMb: limit, pid });
    }
  }).catch(() => {});
}

function spawnRamLimitedRoblox(nativeExe, robloxExe, robloxCwd, robloxUri, mb) {
  return new Promise((resolve) => {
    let proc;
    let output = '';
    let errors = '';
    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    try {
      proc = spawn(nativeExe, ['launchram', robloxExe, robloxCwd, String(mb), robloxUri], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (proc.stdout) proc.stdout.on('data', d => {
        output += d.toString();
        const match = output.match(/RAM_SET:(\d+):(\d+)/);
        if (match) finish({ ok: true, helper: proc, pid: parseInt(match[1], 10), mb: parseInt(match[2], 10) });
      });
      if (proc.stderr) proc.stderr.on('data', d => { errors += d.toString(); });
      proc.on('error', err => finish({ ok: false, error: `RAM-limited launch helper failed: ${err.message}` }));
      proc.on('exit', code => {
        if (!settled) finish({ ok: false, error: errors.trim() || `RAM-limited launch helper exited (code ${code})` });
      });
      timeout = setTimeout(() => {
        if (!settled) {
          try { proc.kill(); } catch {}
          finish({ ok: false, error: errors.trim() || 'RAM-limited launch timed out before the Job Object was attached' });
        }
      }, 20000);
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}


function countRobloxProcesses() {
  return new Promise((resolve) => {
    let out = '';
    if (process.platform !== 'win32') {
      
      try {
        const proc = spawn('pgrep', ['-x', 'RobloxPlayer']);
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('error', () => resolve(0));
        proc.on('close', () => resolve(out.trim() ? out.trim().split('\n').filter(Boolean).length : 0));
      } catch { resolve(0); }
      return;
    }
    try {
      const proc = spawn('cmd', ['/c', 'tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH'], { windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => resolve(0));
      proc.on('close', () => {
        const matches = out.match(/RobloxPlayerBeta\.exe/gi);
        resolve(matches ? matches.length : 0);
      });
    } catch { resolve(0); }
  });
}

function getRobloxProcessList() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve([]); return; }
    let out = '';
    try {
      const script = 'Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + "," + ([DateTimeOffset]$_.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString() }';
      const proc = spawn('powershell', ['-NoProfile', '-Command', script], { windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => resolve([]));
      proc.on('close', () => {
        const list = [];
        for (const line of out.split(/\r?\n/)) {
          const parts = line.trim().split(',');
          const pid = parseInt(parts[0], 10);
          const startedAt = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
          if (pid > 0) list.push({ pid, startedAt: startedAt > 0 ? startedAt : 0 });
        }
        resolve(list);
      });
      setTimeout(() => resolve([]), 8000);
    } catch { resolve([]); }
  });
}

const _tempIdentityCache = new Map(); 

function robloxLogsDir() {
  return path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'logs');
}

function parseLogTimestamp(s) {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const TEMP_IDENTITY_RETRY_MS = 5000;

let _cookieStoreIdentity = null; 

async function getCookieStoreIdentity() {
  const COOKIE_STORE_TTL = 30000;
  if (_cookieStoreIdentity && Date.now() - _cookieStoreIdentity.at < COOKIE_STORE_TTL) return _cookieStoreIdentity;
  let result = null;
  try {
    const cookie = await readRobloxCookieStore();
    if (cookie) {
      const info = await fetchUserInfo(cookie);
      if (info && info.ok) result = { at: Date.now(), userId: info.userId, username: info.username };
    }
  } catch {}
  _cookieStoreIdentity = result;
  return result;
}

async function resolveTempSessionIdentity(pid, startedAtMs) {
  try {
    const cached = _tempIdentityCache.get(pid);
    if (cached && cached.startedAt === startedAtMs) {
      
      if (cached.userId || (Date.now() - (cached.attemptedAt || 0)) < TEMP_IDENTITY_RETRY_MS) return cached;
    }
    let userId = null, username = null;
    const logsDir = robloxLogsDir();
    if (fs.existsSync(logsDir) && startedAtMs > 0) {
      let files = [];
      try { files = await fsPromises.readdir(logsDir); } catch {}
      let bestFile = null, bestDiff = Infinity;
      for (const f of files) {
        const m = /(\d{8}T\d{6}Z)/.exec(f);
        if (!m) continue;
        const t = parseLogTimestamp(m[1]);
        if (t === null) continue;
        const diff = Math.abs(t - startedAtMs);
        if (diff < bestDiff) { bestDiff = diff; bestFile = f; }
      }
      
      
      if (bestFile && bestDiff <= 15000) {
        const text = await fsPromises.readFile(path.join(logsDir, bestFile), 'utf8');
        
        const uidMatch = /game_join_loadtime:[^\n]*?userid:(\d+)/.exec(text) || /userid:(\d+)/.exec(text);
        if (uidMatch) {
          userId = parseInt(uidMatch[1], 10);
          try {
            const res = await httpsGet('https://users.roblox.com/v1/users/' + userId);
            const d = res && res.body ? JSON.parse(res.body) : null;
            if (d && typeof d.name === 'string') username = d.name;
          } catch {}
        }
      }
    }
    if (!userId) {
      const store = await getCookieStoreIdentity();
      if (store) { userId = store.userId; username = store.username; }
    }
    const identity = userId
      ? { startedAt: startedAtMs, userId, username }
      : { startedAt: startedAtMs, userId: null, username: null, attemptedAt: Date.now() };
    _tempIdentityCache.set(pid, identity);
    return identity;
  } catch { return { startedAt: startedAtMs, userId: null, username: null, attemptedAt: Date.now() }; }
}

async function enrichTempSessions(temp, alivePids) {
  const out = [];
  let byUserId = null;
  for (const s of temp) {
    const id = await resolveTempSessionIdentity(s.pid, s.startedAt);
    if (id.userId) {
      if (byUserId === null) byUserId = new Map(loadAccounts().map(a => [String(a.userId), a.id]));
      const accountId = byUserId.get(String(id.userId));
      if (accountId) {
        const current = _accountPids.get(accountId);
        const currentAlive = current != null && alivePids && alivePids.has(current);
        
        
        if (!currentAlive) {
          _accountPids.set(accountId, s.pid);
          continue;
        }
      }
    }
    out.push({ pid: s.pid, startedAt: s.startedAt, userId: id.userId || null, username: id.username || null });
  }
  const live = new Set(temp.map(s => s.pid));
  for (const pid of _tempIdentityCache.keys()) if (!live.has(pid)) _tempIdentityCache.delete(pid);
  return out;
}

function killTempRoblox(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) { resolve({ ok: false, error: 'Bad PID' }); return; }
    if (Array.from(_accountPids.values()).includes(pid)) { resolve({ ok: false, error: 'PID belongs to a saved account' }); return; }
    try {
      const proc = spawn('cmd', ['/c', `taskkill /F /PID ${pid} /T`], { windowsHide: true });
      proc.on('error', () => resolve({ ok: true }));
      proc.on('close', () => resolve({ ok: true }));
      setTimeout(() => resolve({ ok: true }), 3000);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

function readRobloxCookieStore() {
  return new Promise((resolve) => {
    try {
      const p = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'LocalStorage', 'RobloxCookies.dat');
      if (!fs.existsSync(p)) { resolve(null); return; }
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!json || !json.CookiesData) { resolve(null); return; }
      const psScript = 'Add-Type -AssemblyName System.Security\n' +
        `$b = [Convert]::FromBase64String('${json.CookiesData}')` + '\n' +
        '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)' + '\n' +
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8' + '\n' +
        'Write-Output ([System.Text.Encoding]::UTF8.GetString($plain))';
      const proc = spawn('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => resolve(null));
      proc.on('close', () => {
        
        const idx = out.indexOf('.ROBLOSECURITY\t');
        if (idx < 0) { resolve(null); return; }
        let value = out.slice(idx + '.ROBLOSECURITY\t'.length);
        const semi = value.indexOf('; ');
        if (semi >= 0) value = value.slice(0, semi);
        resolve(value.trim() || null);
      });
      setTimeout(() => resolve(null), 10000);
    } catch { resolve(null); }
  });
}

function pushTempSessionsNow(delayMs = 4000) {
  setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const list = await getRobloxProcessList();
      const alivePids = new Set(list.map(p => p.pid));
      const pidStartMap = new Map(list.map(p => [p.pid, p.startedAt]));
      const { claimedPids } = claimRobloxPids(alivePids, pidStartMap, alivePids.size > 0, Date.now());
      const temp = list.filter(p => !claimedPids.has(p.pid)).map(p => ({ pid: p.pid, startedAt: p.startedAt }));
      const enriched = await enrichTempSessions(temp, alivePids);
      if (win && !win.isDestroyed()) win.webContents.send('roblox:temp', enriched);
    } catch {}
  }, delayMs);
}



function killAllRoblox() {
  return new Promise((resolve) => {
    const watchedIds = Array.from(_watchedAccounts.keys());
    
    
    const lifecycleIds = new Set([
      ...watchedIds,
      ..._accountPids.keys(),
      ..._launchTimes.keys(),
      ..._launchGenerations.keys(),
    ]);
    for (const id of lifecycleIds) {
      _launchGenerations.set(id, (_launchGenerations.get(id) || 0) + 1);
      _watchGenerations.delete(id);
      _launchTimes.delete(id);
      _everSeen.delete(id);
    }
    _watchedAccounts.clear();
    _missCounts.clear();
    _pidLostAt.clear();
    _stopWatchPollIfIdle();

    const notify = () => {
      if (win && !win.isDestroyed()) {
        for (const id of watchedIds) win.webContents.send('roblox:closed', id);
        win.webContents.send('roblox:allClosed');
      }
    };

    if (process.platform !== 'win32') {
      
      _accountPids.clear();
      for (const timer of _launchVolumeTimers.values()) clearTimeout(timer);
      _launchVolumeTimers.clear();
      _launchVolumeGenerations.clear();
      for (const proc of _ramLimitProcs.values()) { try { proc.kill(); } catch {} }
      _ramLimitProcs.clear();
      try {
        const kproc = spawn('pkill', ['-x', 'RobloxPlayer']);
        kproc.on('error', () => { notify(); resolve({ ok: false, error: 'pkill unavailable' }); });
        kproc.on('close', () => { notify(); resolve({ ok: true }); });
        setTimeout(() => { notify(); resolve({ ok: true }); }, 4000);
      } catch (e) { notify(); resolve({ ok: false, error: e.message }); }
      return;
    }

    try {
      const proc = spawn('cmd', ['/c',
        'taskkill /F /IM RobloxPlayerBeta.exe /IM RobloxCrashHandler.exe /IM RobloxPlayerLauncher.exe /T'
      ], { windowsHide: true });
      _accountPids.clear();
      for (const timer of _launchVolumeTimers.values()) clearTimeout(timer);
      _launchVolumeTimers.clear();
      _launchVolumeGenerations.clear();
      for (const proc of _ramLimitProcs.values()) { try { proc.kill(); } catch {} }
      _ramLimitProcs.clear();
      const hadRunning = watchedIds.length > 0;
      let settled = false;
      const finishUp = async () => {
        if (settled) return;
        settled = true;
        
        
        await waitForRobloxFullyClosed();
        if (hadRunning) { try { await restartMutexHolder(); } catch {} }
        else { try { await startMutexHolder(); } catch {} }
        notify();
      };
      proc.on('error', () => { finishUp().then(() => resolve({ ok: false, error: 'taskkill failed' })); });
      proc.on('close', () => { finishUp().then(() => resolve({ ok: true })); });
      setTimeout(() => { finishUp().then(() => resolve({ ok: true })); }, 6000);
    } catch (e) {
      notify();
      resolve({ ok: false, error: e.message });
    }
  });
}



function killAccountRoblox(accountId) {
  return new Promise((resolve) => {
    let pid = _accountPids.get(accountId);
    _accountPids.delete(accountId);
    const volumeTimer = _launchVolumeTimers.get(accountId);
    if (volumeTimer) clearTimeout(volumeTimer);
    _launchVolumeTimers.delete(accountId);
    _launchVolumeGenerations.set(accountId, (_launchVolumeGenerations.get(accountId) || 0) + 1);
    _launchGenerations.set(accountId, (_launchGenerations.get(accountId) || 0) + 1);
    _watchGenerations.delete(accountId);
    _watchedAccounts.delete(accountId);
    _missCounts.delete(accountId);
    _launchTimes.delete(accountId);
    _everSeen.delete(accountId);
    _pidLostAt.delete(accountId);
    clearRamLimit(accountId);
    _stopWatchPollIfIdle();

    const notify = () => { if (win && !win.isDestroyed()) win.webContents.send('roblox:closed', accountId); };

    if (!pid && process.platform === 'win32') {
      try {
        const stdout = execSync('powershell -NoProfile -Command "Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', { encoding: 'utf8', timeout: 3000 });
        const pids = stdout.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
        const claimedPids = new Set(_accountPids.values());
        const unassigned = pids.filter(p => !claimedPids.has(p));
        if (unassigned.length > 0) pid = unassigned[0];
        else if (pids.length === 1) pid = pids[0];
      } catch {}
    }

    if (!pid) {
      notify();
      resolve({ ok: true });
      return;
    }

    try {
      const proc = process.platform === 'win32'
        ? spawn('cmd', ['/c', `taskkill /F /PID ${pid} /T`], { windowsHide: true })
        : spawn('kill', ['-9', String(pid)]);
      proc.on('error', () => { notify(); resolve({ ok: true }); });
      proc.on('close', () => { notify(); resolve({ ok: true }); });
      setTimeout(() => { notify(); resolve({ ok: true }); }, 3000);
    } catch (e) {
      notify();
      resolve({ ok: true });
    }
  });
}


const settingsPath = path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { if (!fs.existsSync(settingsPath)) return {}; return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
}
function saveSettings(s) { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), { mode: 0o600 }); }

const SALT = 'multiroblox-v1-salt-2025';
const ITERATIONS = 210_000;
const KEY_LEN = 32;
const DIGEST = 'sha512';

function safeStorageReady() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; }
}



function getOrCreateDeviceKey() {
  const s = loadSettings();
  if (s._deviceKey && s._deviceKey.length === 64) {
    return Buffer.from(s._deviceKey, 'hex');
  }
  const key = crypto.randomBytes(KEY_LEN);
  saveSettings({ ...s, _deviceKey: key.toString('hex') });
  return key;
}

const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
function deriveScryptKey(p) { return crypto.scryptSync(p, SALT, KEY_LEN, SCRYPT_PARAMS); }
function deriveLegacyKey(p) { return crypto.pbkdf2Sync(p, SALT, ITERATIONS, KEY_LEN, DIGEST); }

let _cachedKey = null, _cachedLegacyKey = null, _sessionPass = null;

const sessionPath = path.join(app.getPath('userData'), '.keysession');
const VERIFY_TOKEN = 'multiroblox-verify-v1';
function bootId() { return Math.round(Date.now() / 1000 - os.uptime()); }
function passphraseMode() {
  const s = loadSettings();
  return !!(s.keyVerifier || s.customKeyEnc || (s.customKey && s.customKey.trim()));
}
function makeVerifier(pass) { return encryptGCM(VERIFY_TOKEN, deriveScryptKey(pass), 'gs'); }
function verifyPass(pass) {
  try {
    const v = loadSettings().keyVerifier;
    return !!v && decryptGCM(v, deriveScryptKey(pass), 'gs') === VERIFY_TOKEN;
  } catch { return false; }
}
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
function writeSessionKey(pass) {
  try {
    const payload = JSON.stringify({ pass, ts: Date.now() });
    let enc;
    if (safeStorageReady()) {
      enc = safeStorage.encryptString(payload).toString('base64');
    } else {
      enc = Buffer.from(payload, 'utf8').toString('base64');
    }
    fs.writeFileSync(sessionPath, enc, 'utf8');
  } catch {}
}
function readSessionKey() {
  try {
    if (!fs.existsSync(sessionPath)) return null;
    const raw = fs.readFileSync(sessionPath, 'utf8');
    let decStr;
    if (safeStorageReady()) {
      decStr = safeStorage.decryptString(Buffer.from(raw, 'base64'));
    } else {
      decStr = Buffer.from(raw, 'base64').toString('utf8');
    }
    const data = JSON.parse(decStr);
    if (!data || !data.pass || !data.ts) return null;
    if (Date.now() - data.ts > THIRTY_DAYS_MS) {
      clearSessionKey();
      return null;
    }
    return data.pass;
  } catch { return null; }
}
function clearSessionKey() { try { fs.unlinkSync(sessionPath); } catch {} }



function initEncryption() {
  try {
    const s = loadSettings();
    if (!s.keyVerifier) {
      let legacy = null;
      if (s.customKeyEnc && safeStorageReady()) { try { legacy = safeStorage.decryptString(Buffer.from(s.customKeyEnc, 'base64')); } catch {} }
      if (!legacy && s.customKey && s.customKey.trim()) legacy = s.customKey.trim();
      if (legacy) {
        const { customKey, customKeyEnc, ...rest } = s;
        saveSettings({ ...rest, keyVerifier: makeVerifier(legacy) });
        _sessionPass = legacy; writeSessionKey(legacy); 
        return;
      }
    }
    if (passphraseMode()) {
      const cached = readSessionKey();
      if (cached && verifyPass(cached)) _sessionPass = cached;
    }
  } catch {}
}
function getStoredPassphrase() { return _sessionPass; }



function getEncryptionKey() {
  if (_cachedKey) return _cachedKey;
  if (_sessionPass) { _cachedKey = deriveScryptKey(_sessionPass); return _cachedKey; }
  if (!passphraseMode()) { _cachedKey = getOrCreateDeviceKey(); return _cachedKey; }
  return null; 
}

function getLegacyKey() {
  if (_cachedLegacyKey) return _cachedLegacyKey;
  if (_sessionPass) { _cachedLegacyKey = deriveLegacyKey(_sessionPass); return _cachedLegacyKey; }
  if (!passphraseMode()) { _cachedLegacyKey = getOrCreateDeviceKey(); return _cachedLegacyKey; }
  return null; 
}
function invalidateKeyCache() { _cachedKey = null; _cachedLegacyKey = null; }

function prewarmKey() {
  try {
    if (_cachedKey || !_sessionPass) return;
    crypto.scrypt(_sessionPass, SALT, KEY_LEN, SCRYPT_PARAMS, (err, dk) => {
      if (!err && dk && !_cachedKey) _cachedKey = dk;
    });
  } catch {}
}



function encryptGCM(p, k, tag) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(p, 'utf8'), c.final()]);
  return tag + ':' + [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decryptGCM(ct, k, tag) {
  const s = ct.replace(new RegExp('^' + tag + ':'), '').split(':'); if (s.length < 3) return null;
  const iv = Buffer.from(s[0], 'base64'), at = Buffer.from(s[1], 'base64'), data = Buffer.from(s[2], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(at);
  return d.update(data, undefined, 'utf8') + d.final('utf8');
}



function decryptCBC(ct, k) {
  const s = ct.replace(/^cbc:/, '').split(':'); if (s.length < 2) return null;
  const iv = Buffer.from(s[0], 'base64'), data = Buffer.from(s[1], 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', k, iv);
  return d.update(data, undefined, 'utf8') + d.final('utf8');
}

function encryptField(p) {
  if (_sessionPass) return encryptGCM(p, getEncryptionKey(), 'gs'); 
  if (passphraseMode()) throw new Error('locked'); 
  if (safeStorageReady()) return 'safe:' + safeStorage.encryptString(p).toString('base64');
  return encryptGCM(p, getEncryptionKey(), 'gs'); 
}
function decryptField(ct) {
  try {
    if (!ct) return null;
    if (ct.startsWith('safe:')) {
      if (!safeStorageReady()) return null;
      return safeStorage.decryptString(Buffer.from(ct.slice(5), 'base64'));
    }
    if (ct.startsWith('gs:')) return decryptGCM(ct, getEncryptionKey(), 'gs');
    if (ct.startsWith('gcm:')) return decryptGCM(ct, getLegacyKey(), 'gcm');
    if (ct.startsWith('cbc:')) return decryptCBC(ct, getLegacyKey());
    return ct;
  } catch { return null; }
}

function isEncrypted(v) {
  return typeof v === 'string' && (v.startsWith('safe:') || v.startsWith('gs:') || v.startsWith('gcm:') || v.startsWith('cbc:'));
}
function encryptAccount(a) {
  const o = { ...a };
  if (o.cookie && !isEncrypted(o.cookie)) o.cookie = encryptField(o.cookie);
  
  if (o.password && !isEncrypted(o.password)) o.password = encryptField(o.password);
  o._enc = true;
  return o;
}
function decryptAccount(a) {
  const o = { ...a };
  if (o.cookie) o.cookie = decryptField(o.cookie) ?? '';
  if (o.password) o.password = decryptField(o.password) ?? '';
  return o;
}

const dataPath = path.join(app.getPath('userData'), 'accounts.json');
function loadAccounts() {
  try { if (!fs.existsSync(dataPath)) return []; return JSON.parse(fs.readFileSync(dataPath, 'utf8')).map(decryptAccount); } catch { return []; }
}
function saveAccounts(a) { fs.writeFileSync(dataPath, JSON.stringify(a.map(encryptAccount), null, 2), { mode: 0o600 }); }

function migrateAccountEncryptionToKeychain() {
  try {
    if (passphraseMode()) return; 
    if (!safeStorageReady()) return;
    if (!fs.existsSync(dataPath)) return;
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const needs = raw.some(a => a.cookie && (a.cookie.startsWith('gcm:') || a.cookie.startsWith('cbc:')));
    if (!needs) return;
    const plain = raw.map(decryptAccount);
    
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].cookie && !plain[i].cookie) { console.error('[migrate] decrypt failed; leaving accounts untouched'); return; }
    }
    saveAccounts(plain); 
    console.log('[migrate] upgraded account encryption to OS keychain');
  } catch (e) { console.error('[migrate] skipped:', e.message); }
}

const packagesPath = path.join(app.getPath('userData'), 'packages.json');
function loadPackages() {
  try { if (!fs.existsSync(packagesPath)) return []; return JSON.parse(fs.readFileSync(packagesPath, 'utf8')); } catch { return []; }
}
function savePackages(p) { fs.writeFileSync(packagesPath, JSON.stringify(p, null, 2), { mode: 0o600 }); }

let win;
let tray = null;
let _closeToTray = true;



function refreshTrayMenu() {
  if (!tray) return;
  try {
    const accts = loadAccounts();
    const launchItems = accts.slice(0, 15).map(a => ({
      label: (a.nickname || a.username || 'Unknown') + (a.gameTarget ? '  ·  ' + extractTargetLabelMain(a.gameTarget) : ''),
      click: () => trayLaunchAccount(a.id),
    }));
    const accountSub = launchItems.length
      ? { label: 'Quick launch', submenu: launchItems }
      : { label: 'Quick launch (no accounts)', enabled: false };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show rbxSWAP', click: () => { if (win) { win.show(); win.focus(); } } },
      accountSub,
      { type: 'separator' },
      { label: 'Quit', click: () => { _closeToTray = false; app.quit(); } }
    ]));
  } catch (e) { console.error('[tray] menu refresh failed:', e.message); }
}




async function trayLaunchAccount(accountId) {
  const acct = loadAccounts().find(a => a.id === accountId);
  if (!acct) return;
  sendLog('info', 'launch', `Tray quick-launch for ${acct.username || accountId}`, { accountId, username: acct.username || null });
  try {
    const res = await (_launchQueue = _launchQueue.then(() =>
      _doLaunch(acct.id, acct.cookie, acct.gameTarget || null, 'auto', {})));
    if (!res || !res.success) {
      sendLog('err', 'launch', `Tray launch failed for ${acct.username || accountId}: ${res?.error || 'unknown error'}`, { accountId });
    }
  } catch (e) {
    sendLog('err', 'launch', `Tray launch failed for ${acct.username || accountId}: ${e.message}`, { accountId });
  }
}



function extractTargetLabelMain(target) {
  const t = String(target || '').trim();
  if (!t) return '';
  if (/^\d+$/.test(t)) return 'Place ' + t;
  try {
    const u = new URL(t.startsWith('http') ? t : 'https://' + t);
    const parts = u.pathname.split('/').filter(Boolean);
    const name = (parts[2] || parts[1] || '').replace(/-/g, ' ').trim();
    return name || u.hostname;
  } catch { return t.slice(0, 24); }
}

function createTray() {
  if (tray || !win) return;
  try {
    tray = new Tray(path.join(__dirname, 'icon.ico'));
    tray.setToolTip('rbxSWAP - running in tray');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show rbxSWAP', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: 'Quit', click: () => { _closeToTray = false; app.quit(); } }
    ]));
    refreshTrayMenu(); 
    tray.on('click', () => {
      if (!win) return;
      if (win.isVisible()) win.hide();
      else { win.show(); win.focus(); }
    });
  } catch (e) { console.error('[tray] failed to create tray:', e.message); }
}

function hideToTray() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  createTray();
  win.hide();
}

function destroyTray() {
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
}

function sendLog(level, category, message, meta) {
  try {
    if (win && !win.isDestroyed())
      win.webContents.send('log:entry', { ts: Date.now(), level, category, message, meta: meta || {} });
  } catch {}
}

function createWindow({ startHiddenInTray = false } = {}) {
  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 945, minHeight: 755,
    frame: false, backgroundColor: '#0e0e10',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: true },
    show: false,
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (startHiddenInTray) { createTray(); } else { win.show(); }
  });
  
  
  win.on('close', (e) => {
    if (_closeToTray) { e.preventDefault(); hideToTray(); }
  });
}

function weaoGet(apiPath) {
  return new Promise((resolve) => {
    const req = https.get('https://weao.xyz' + apiPath, {
      headers: { 'User-Agent': 'WEAO-3PService', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

function normalizeRobloxVersionHash(hash) {
  const value = String(hash || '').trim().toLowerCase();
  if (!value) return null;
  return value.startsWith('version-') ? value : 'version-' + value;
}



async function getExecutorVersionHash() {
  const s = loadSettings();
  const defaultExec = s.defaultExecutor || '';
  const disabled = Array.isArray(s.disabledExecutors) ? s.disabledExecutors : [];
  if (!defaultExec || disabled.includes(defaultExec)) return null;
  try {
    const [expRes, verRes] = await Promise.all([weaoGet('/api/status/exploits'), weaoGet('/api/versions/current')]);
    if (expRes.status !== 200) return null;
    const exploits = JSON.parse(expRes.body);
    const exp = Array.isArray(exploits) ? exploits.find(e => (e.title || e.name || e.exploit) === defaultExec) : null;
    if (!exp) return null;
    let hash = exp.rbxversion || exp.robloxVersion || exp.versionHash || null;
    if (!hash && verRes.status === 200) {
      hash = (JSON.parse(verRes.body) || {}).Windows || null;
    }
    return normalizeRobloxVersionHash(hash);
  } catch { return null; }
}




async function ensureProtocolVersionUpToDate(requiredHash) {
  if (!requiredHash) return true;
  let win = null;
  try { win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null; } catch {}
  const installed = getInstalledRobloxVersions();
  const match = installed.find(v => normalizeRobloxVersionHash(v.hash) === requiredHash);
  if (match && isCompleteRobloxVersion(match.dir)) return true;

  const missing = !installed.length;
  const title = missing ? 'Roblox version required' : 'Roblox version outdated';
  const message = missing
    ? `Your executor needs Roblox ${requiredHash}, which is not installed yet. Download it now?`
    : `Your executor needs Roblox ${requiredHash}, which is newer than the version currently installed. Upgrade now?`;
  let choice = 'cancel';
  try {
    const r = win
      ? await dialog.showMessageBox(win, {
          type: 'question', buttons: ['Upgrade', 'Cancel'], defaultId: 0, cancelId: 1,
          title, message, detail: 'Roblox launches from the browser use the executor-synced version.',
          noLink: true,
        })
      : await dialog.showMessageBox({
          type: 'question', buttons: ['Upgrade', 'Cancel'], defaultId: 0, cancelId: 1,
          title, message, detail: 'Roblox launches from the browser use the executor-synced version.',
          noLink: true,
        });
    choice = r.response === 0 ? 'ok' : 'cancel';
  } catch { return null; }
  if (choice !== 'ok') return null;

  try {
    sendLog('info', 'launch', `Downloading Roblox ${requiredHash} for browser launch…`);
    await installRobloxVersionFromRobloxDeployment(requiredHash, (msg) => sendLog('info', 'launch', msg));
    sendLog('ok', 'launch', `Roblox ${requiredHash} installed`);
    return true;
  } catch (e) {
    sendLog('err', 'launch', `Could not install Roblox ${requiredHash}: ${e.message}`);
    try { dialog.showErrorBox('Version install failed', `Could not install Roblox ${requiredHash}:\n${e.message}`); } catch {}
    return null;
  }
}

function handleProtocolUrl(url) {
  if (!url || (!url.startsWith('roblox-player:') && !url.startsWith('roblox:'))) return false;
  try {
    
    
    handleProtocolUrlAsync(url).catch((e) => console.error('[protocol] launch failed:', e.message));
    return true;
  } catch (e) {
    console.error('[protocol] failed to forward URL:', e.message);
    return false;
  }
}

async function handleProtocolUrlAsync(url) {
  let robloxExe = null;
  const executorHash = await getExecutorVersionHash();

  if (executorHash) {
    const upToDate = await ensureProtocolVersionUpToDate(executorHash);
    if (!upToDate) {
      sendLog('warn', 'launch', 'Browser launch cancelled - the executor-synced Roblox version is not installed.');
      return;
    }
    const installed = getInstalledRobloxVersions();
    const match = installed.find(v => normalizeRobloxVersionHash(v.hash) === executorHash);
    if (match) robloxExe = match.exe;
  }

  if (!robloxExe) {
    try { const v = getLatestRobloxVersionDir(); if (v && v.exe && fs.existsSync(v.exe)) robloxExe = v.exe; } catch {}
  }
  if (!robloxExe) {
    const installed = getInstalledRobloxVersions();
    if (installed.length) robloxExe = installed[0].exe;
  }
  if (!robloxExe || !fs.existsSync(robloxExe)) {
    sendLog('err', 'launch', 'Browser launch failed: no complete Roblox installation found. Install a version from the RDD tab first.');
    return;
  }

  await closeSingletonAndHoldMutex();
  const launchStartedAt = Date.now();
  const child = spawn(robloxExe, [url], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  scheduleLaunchVolume(`protocol-${launchStartedAt}`, 100, launchStartedAt, child.pid);
  
  
  pushTempSessionsNow(5000);
}



const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  
  
  app.quit();
}

app.on('second-instance', (event, argv) => {
  
  const url = argv.find(a => a.startsWith('roblox-player:') || a.startsWith('roblox:'));
  if (url) {
    
    
    handleProtocolUrl(url);
  } else {
    
    if (win) { if (win.isMinimized()) win.restore(); if (!win.isVisible()) win.show(); win.focus(); }
  }
});

app.whenReady().then(async () => {
  pruneChromiumCaches(); 
  const protocolUrl = process.argv.slice(1).find(a => a.startsWith('roblox-player:') || a.startsWith('roblox:'));
  if (protocolUrl) {
    handleProtocolUrl(protocolUrl);
  }

  if (process.platform === 'win32') app.setAppUserModelId('com.rbswap.app');
  initEncryption(); 
  prewarmKey(); 
  
  migrateAccountEncryptionToKeychain();
  
  
  createWindow({ startHiddenInTray: !!protocolUrl });
  if (process.platform === 'win32') {
    await stopStaleNativeHelpers();
    await ensureNativeHelper();
    await startMutexHolder();
  }
  if (loadSettings().antiAfk) startAntiAfk();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { _closeToTray = false; });
app.on('will-quit', () => { destroyTray(); stopMutexHolder(); stopAntiAfk(); for (const proc of _ramLimitProcs.values()) { try { proc.kill(); } catch {} } _ramLimitProcs.clear(); });

app.on('open-url', (event, url) => { event.preventDefault(); handleProtocolUrl(url); });


ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window-close', () => win.close());
ipcMain.on('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('app:relaunchAsAdmin', async () => {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  const psq = (s) => String(s).replace(/'/g, "''");
  try {
    let inner;
    if (app.isPackaged) {
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      inner = `Start-Process -FilePath '${psq(exe)}' -Verb RunAs`;
    } else {
      
      inner = `Start-Process -FilePath '${psq(process.execPath)}' -ArgumentList '${psq(app.getAppPath())}' -Verb RunAs`;
    }
    const script = `$ErrorActionPreference='Stop'; try { ${inner}; Write-Output 'OK' } catch { Write-Output 'CANCEL' }`;
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    if (stdout.trim().endsWith('OK')) {
      setTimeout(() => { try { app.quit(); } catch {} }, 400);
      return { ok: true };
    }
    return { ok: false, cancelled: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('enc:status', () => {
  if (!passphraseMode()) {
    
    return { mode: 'setup' }; 
  }
  return { mode: _sessionPass ? 'unlocked' : 'locked' };
});
ipcMain.handle('enc:unlock', (_, pass) => {
  if (!pass || !verifyPass(pass)) return { ok: false };
  _sessionPass = pass; invalidateKeyCache(); writeSessionKey(pass);
  return { ok: true };
});


ipcMain.handle('enc:setKey', (_, pass) => {
  try {
    const np = (pass || '').trim();
    const raw = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : [];
    const accts = raw.map(decryptAccount);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].cookie && !accts[i].cookie) return { ok: false, error: 'decrypt failed' };
    }
    if (np) {
      _sessionPass = np; invalidateKeyCache();
      const { customKey, customKeyEnc, ...rest } = loadSettings();
      saveSettings({ ...rest, keyVerifier: makeVerifier(np), encSetupDone: true });
      writeSessionKey(np);
    } else {
      _sessionPass = null; invalidateKeyCache();
      const { customKey, customKeyEnc, keyVerifier, ...rest } = loadSettings();
      saveSettings({ ...rest, encSetupDone: true });
      clearSessionKey();
    }
    invalidateKeyCache();
    saveAccounts(accts); 
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('settings:load', () => {
  
  
  const s = loadSettings();
  const { customKeyEnc, customKey, keyVerifier, _deviceKey, ...rest } = s;
  return { ...rest, keySet: passphraseMode() };
});
ipcMain.handle('settings:save', (_, data) => {
  
  
  const { customKey, customKeyEnc, keyVerifier, ...rest } = data;
  saveSettings({ ...loadSettings(), ...rest });
  if ('encryptionType' in data) invalidateKeyCache();
  if ('multiInstance' in data) {
    if (data.multiInstance) startMutexHolder();
    else stopMutexHolder();
  }
  if ('antiAfk' in data) {
    if (data.antiAfk) startAntiAfk();
    else stopAntiAfk();
  } else if ('antiAfkInterval' in data && _antiAfkProc) {
    
    stopAntiAfk(); startAntiAfk();
  }
  return true;
});
ipcMain.handle('multiinstance:status', () => ({ enabled: isMultiInstanceEnabled(), active: !!_mutexProc }));
ipcMain.handle('antiafk:status', () => ({ enabled: !!loadSettings().antiAfk, active: !!_antiAfkProc }));

function getProtocolHandlerStatus() {
  if (process.platform !== 'win32') return { isRegistered: false, current: 'Not Windows' };
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query "HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command" /ve', { encoding: 'utf8', windowsHide: true });
    const lower = out.toLowerCase();
    const exe = (process.env.PORTABLE_EXECUTABLE_FILE || process.execPath).toLowerCase();
    const isReg = lower.includes('rblxlaunch.vbs') || lower.includes('rblxlaunch.bat') || lower.includes(exe);
    return { isRegistered: isReg, current: out.trim() };
  } catch {
    return { isRegistered: false, current: null };
  }
}

function getRobloxPlayerExePath() {
  try { const v = getLatestRobloxVersionDir(); if (v && v.exe && fs.existsSync(v.exe)) return v.exe; } catch {}
  try { const installed = getInstalledRobloxVersions(); if (installed.length) return installed[0].exe; } catch {}
  return null;
}

function registerProtocolHandlers() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  try {
    const { execFileSync } = require('child_process');
    const reg = (args) => execFileSync('reg', args, { windowsHide: true });

    const robloxExe = getRobloxPlayerExePath();
    if (!robloxExe) return { ok: false, error: 'Roblox not found. Install a version first.' };

    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    
    
    const cmd = app.isPackaged
      ? `"${exe}" "%1"`
      : `"${exe}" "${app.getAppPath()}" "%1"`;

    for (const proto of ['roblox-player', 'roblox']) {
      reg(['add', `HKCU\\Software\\Classes\\${proto}`, '/ve', '/t', 'REG_SZ', '/d', 'URL:Roblox Protocol', '/f']);
      reg(['add', `HKCU\\Software\\Classes\\${proto}`, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']);
      reg(['add', `HKCU\\Software\\Classes\\${proto}\\shell`, '/f']);
      reg(['add', `HKCU\\Software\\Classes\\${proto}\\shell\\open`, '/f']);
      reg(['add', `HKCU\\Software\\Classes\\${proto}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', cmd, '/f']);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function removeProtocolHandlers() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only' };
  try {
    const { execFileSync } = require('child_process');
    try { execFileSync('reg', ['delete', 'HKCU\\Software\\Classes\\roblox-player', '/f'], { windowsHide: true }); } catch {}
    try { execFileSync('reg', ['delete', 'HKCU\\Software\\Classes\\roblox', '/f'], { windowsHide: true }); } catch {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('protocol:status', () => getProtocolHandlerStatus());
ipcMain.handle('protocol:register', () => registerProtocolHandlers());
ipcMain.handle('protocol:remove', () => removeProtocolHandlers());

ipcMain.handle('accounts:load', () => loadAccounts());
ipcMain.handle('accounts:add', (_, account) => {
  const accounts = loadAccounts();
  const a = { id: Date.now().toString(), ...account, createdAt: new Date().toISOString(), lastUsed: null };
  accounts.push(a); saveAccounts(accounts); refreshTrayMenu(); return a;
});
ipcMain.handle('accounts:remove', (_, id) => { saveAccounts(loadAccounts().filter(a => a.id !== id)); refreshTrayMenu(); return true; });
ipcMain.handle('accounts:update', (_, id, data) => {
  const accounts = loadAccounts(), idx = accounts.findIndex(a => a.id === id);
  if (idx !== -1) { accounts[idx] = { ...accounts[idx], ...data }; saveAccounts(accounts); refreshTrayMenu(); return accounts[idx]; }
  return null;
});
ipcMain.handle('accounts:reorder', (_, ids) => {
  const accounts = loadAccounts();
  const reordered = ids.map(id => accounts.find(a => a.id === id)).filter(Boolean);
  const rest = accounts.filter(a => !ids.includes(a.id));
  saveAccounts([...reordered, ...rest]);
  return true;
});
ipcMain.handle('accounts:save', (_, list) => {
  if (!Array.isArray(list)) return false;
  saveAccounts(list);
  refreshTrayMenu();
  return true;
});

ipcMain.handle('packages:load', () => loadPackages());
ipcMain.handle('packages:save', (_, packages) => {
  try { savePackages(packages); return true; } catch (e) { return false; }
});

function generateBloxGenAccount(apiKey) {
  return new Promise((resolve) => {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) { resolve({ ok: false, status: 0, error: 'Missing BloxGen API key' }); return; }

    let settled = false;
    let timeout;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const bodyBuf = Buffer.from(JSON.stringify({ apiKey: key, type: 'alt' }));
    const req = https.request({
      hostname: 'core.bloxgen.net',
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'Accept': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        let data = null;
        try { data = body ? JSON.parse(body) : null; } catch {}
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          finish({ ok: false, status, data, error: data?.error || data?.message || `BloxGen request failed (HTTP ${status})` });
          return;
        }
        if (data && data.success === false) {
          finish({ ok: false, status, data, error: data.error || data.message || 'BloxGen rejected the request' });
          return;
        }
        
        
        const account = data?.data || data;
        if (!account || !account.username || !account.password || !account.cookie || (!account.id && !account.userId)) {
          finish({ ok: false, status, data, error: 'BloxGen returned an incomplete account response' });
          return;
        }
        finish({ ok: true, status, data: account });
      });
    });

    timeout = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish({ ok: false, status: 0, error: 'BloxGen request timed out' });
    }, 15000);

    req.on('error', e => finish({ ok: false, status: 0, error: e.message }));
    req.write(bodyBuf);
    req.end();
  });
}

function fetchUserInfo(cookie) {
  return new Promise((resolve) => {
    const req = net.request({ method: 'GET', url: 'https://users.roblox.com/v1/users/authenticated', useSessionCookies: false, headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'Accept': 'application/json' } });
    let body = '';
    req.on('response', res => { res.on('data', c => body += c); res.on('end', () => { try { const d = JSON.parse(body); if (d && d.id) resolve({ ok: true, username: d.name, userId: String(d.id) }); else resolve({ ok: false, reason: body.slice(0, 200) }); } catch { resolve({ ok: false, reason: 'parse error' }); } }); });
    req.on('error', e => resolve({ ok: false, reason: e.message }));
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve) => {
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: '', error: e.message }));
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function cookieFromResponseHeaders(headers) {
  const raw = headers && headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const line of lines) {
    const match = /(?:^|;\s*)\.ROBLOSECURITY=([^;]+)/i.exec(String(line));
    if (match && match[1] && match[1].length > 100) return match[1];
  }
  return null;
}

async function verifiedResponseCookie(headers) {
  const cookie = cookieFromResponseHeaders(headers);
  if (!cookie) return null;
  try {
    const info = await fetchUserInfo(cookie);
    return info && info.ok ? cookie : null;
  } catch { return null; }
}

const _csrfCache = new Map();
const CSRF_TTL = 5 * 60_000; 

const _ticketRequestAt = new Map(); 
const TICKET_MIN_GAP = 8_000;



let _launchQueue = Promise.resolve();
let _lastLaunchTs = 0;
const LAUNCH_STAGGER = 1500;

async function getCSRFToken(cookie) {
  const cached = _csrfCache.get(cookie);
  if (cached && Date.now() - cached.ts < CSRF_TTL) return cached.token;

  const cookieHeader = `.ROBLOSECURITY=${cookie}`;
  for (const endpoint of ['/v2/logout', '/v1/logout']) {
    try {
      const res = await httpsPost('auth.roblox.com', endpoint, { 'Cookie': cookieHeader }, null);
      const token = res.headers['x-csrf-token'];
      if (token) {
        _csrfCache.set(cookie, { token, ts: Date.now() });
        return token;
      }
    } catch {}
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAuthTicket(cookie, csrfToken) {
  const now = Date.now();
  const lastRequest = _ticketRequestAt.get(cookie) || 0;

  
  
  if (now - lastRequest < TICKET_MIN_GAP) {
    await sleep(TICKET_MIN_GAP - (now - lastRequest));
  }

  const baseHeaders = {
    'Cookie': `.ROBLOSECURITY=${cookie}`,
    'Referer': 'https://www.roblox.com',
    'Origin': 'https://www.roblox.com',
  };

  let token = csrfToken;
  const delays = [0, 2000, 5000];

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const sinceRequest = Date.now() - (_ticketRequestAt.get(cookie) || 0);
      if (sinceRequest < TICKET_MIN_GAP) await sleep(TICKET_MIN_GAP - sinceRequest);
    }
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    _ticketRequestAt.set(cookie, Date.now());

    const res = await httpsPost('auth.roblox.com', '/v1/authentication-ticket', {
      ...baseHeaders,
      'X-CSRF-TOKEN': token,
    }, null);

    const ticket = res.headers['rbx-authentication-ticket'];
    if (ticket && typeof ticket === 'string' && ticket.length >= 20) {
      _ticketRequestAt.set(cookie, Date.now());
      return { ok: true, ticket };
    }
    _ticketRequestAt.set(cookie, Date.now());

    if (res.status === 429) {
      _csrfCache.delete(cookie);
      const retryAfter = parseInt(res.headers['retry-after'] || '8', 10);
      await sleep(retryAfter * 1000);
      token = await getCSRFToken(cookie);
      if (!token) return { ok: false, error: 'Rate limited and could not refresh token. Wait a moment and try again.' };
      continue;
    }

    if (res.status === 403) {
      _csrfCache.delete(cookie);
      token = await getCSRFToken(cookie);
      if (!token) return { ok: false, error: 'Authentication failed (403). Cookie may be expired.' };
      continue;
    }

    return { ok: false, error: `Auth ticket request failed (HTTP ${res.status}). Try again in a moment.` };
  }

  return { ok: false, error: 'Still rate limited after 3 attempts. Please wait 30 seconds and try again.' };
}

async function getRobloxVersion() {
  try {
    const r = await httpsGet('https://clientsettingscdn.roblox.com/v2/client-version/WindowsPlayer');
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      if (d && d.clientVersionUpload) return d.clientVersionUpload;
      if (d && d.version) return d.version;
    }
  } catch {}
  return null;
}

ipcMain.handle('roblox:getVersion', async () => {
  try { return await getRobloxVersion(); } catch { return null; }
});


ipcMain.handle('bloxgen:generateAccount', async (_, apiKey) => {
  try { return await generateBloxGenAccount(apiKey); }
  catch (e) { return { ok: false, status: 0, error: e.message }; }
});

ipcMain.handle('roblox:validateCookie', async (_, cookie) => {
  const info = await fetchUserInfo(cookie);
  if (info && info.ok) {
    try { await getCSRFToken(cookie); } catch {}
  }
  return info;
});

ipcMain.handle('roblox:setVolume', async (_, percent) => {
  try { return await setRobloxVolume(percent); } catch (e) { return { ok: false, count: 0, error: e.message }; }
});
ipcMain.handle('roblox:killAll', async () => {
  try {
    const killAllAccts = loadAccounts();
    const runningNames = Array.from(_watchedAccounts.keys()).map(id => { const a = killAllAccts.find(x => x.id === id); return a ? (a.username || id) : id; });
    sendLog('warn', 'kill', `Killed all Roblox instances (${_watchedAccounts.size} running: ${runningNames.join(', ') || 'none'})`, { count: _watchedAccounts.size, accounts: runningNames });
    return await killAllRoblox();
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('roblox:killOne', async (_, accountId) => {
  try {
    const killAccts = loadAccounts(); const killAcct = killAccts.find(a => a.id === accountId) || {};
    sendLog('warn', 'kill', `Killed Roblox instance for ${killAcct.username || accountId}`, { accountId, username: killAcct.username || null, userId: killAcct.userId || null, pid: _accountPids.get(accountId) || null });
    return await killAccountRoblox(accountId);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('roblox:runningCount', async () => {
  try { return await countRobloxProcesses(); } catch { return 0; }
});

ipcMain.handle('roblox:tempSessions', async () => {
  try {
    const list = await getRobloxProcessList();
    const alivePids = new Set(list.map(p => p.pid));
    const pidStartMap = new Map(list.map(p => [p.pid, p.startedAt]));
    const { claimedPids } = claimRobloxPids(alivePids, pidStartMap, alivePids.size > 0, Date.now());
    return enrichTempSessions(list.filter(p => !claimedPids.has(p.pid)), alivePids);
  } catch { return []; }
});
ipcMain.handle('roblox:killTemp', async (_, pid) => {
  try { return await killTempRoblox(Number(pid)); } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('roblox:addTempSession', async (_, pid) => {
  try {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) return { ok: false, error: 'Bad PID' };
    const cookie = await readRobloxCookieStore();
    if (!cookie) return { ok: false, error: 'Could not read the Roblox cookie store. Start the game once from the browser and try again.' };
    const info = await fetchUserInfo(cookie);
    if (!info || !info.ok) return { ok: false, error: 'The cookie from the Roblox store could not be validated.' };
    
    
    const list = await getRobloxProcessList();
    const session = list.find(p => p.pid === numericPid);
    const identity = session ? await resolveTempSessionIdentity(numericPid, session.startedAt) : null;
    if (identity && identity.userId && String(identity.userId) !== String(info.userId)) {
      return { ok: false, error: 'The Roblox cookie store belongs to a different session than this card. Add it while only that game is running.' };
    }
    const accounts = loadAccounts();
    const existing = accounts.find(a => String(a.userId) === String(info.userId));
    let account;
    if (existing) {
      existing.username = info.username;
      existing.cookie = cookie;
      saveAccounts(accounts);
      account = existing;
    } else {
      account = { id: Date.now().toString(), username: info.username, userId: info.userId, cookie, gameTarget: '', createdAt: new Date().toISOString(), lastUsed: null };
      accounts.push(account);
      saveAccounts(accounts);
    }
    
    
    _accountPids.set(account.id, numericPid);
    sendLog('ok', 'add', `Captured external session as ${info.username} (auth ticket redeemed)`, { accountId: account.id, username: info.username, userId: info.userId });
    return { ok: true, account };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not add this session' };
  }
});

async function refreshAccountCookieFromStore(accountId, userId) {
  const cookie = await readRobloxCookieStore();
  if (!cookie) return { ok: false, reason: 'no-store' };
  const info = await fetchUserInfo(cookie);
  if (!info || !info.ok) return { ok: false, reason: 'store-invalid' };
  if (userId != null && String(info.userId) !== String(userId)) return { ok: false, reason: 'mismatch' };
  const accounts = loadAccounts();
  const acct = accounts.find(a => String(a.id) === String(accountId));
  if (!acct) return { ok: false, reason: 'not-found' };
  acct.cookie = cookie;
  acct.username = info.username;
  saveAccounts(accounts);
  sendLog('ok', 'cookie', `Auto-refreshed cookie for ${acct.username || accountId} from the Roblox session store`, { accountId, username: acct.username || null, userId: info.userId });
  return { ok: true, cookie, username: info.username, userId: info.userId };
}

ipcMain.handle('roblox:refreshCookieFromStore', async (_, accountId, userId) => {
  try {
    return await refreshAccountCookieFromStore(accountId, userId);
  } catch (e) {
    return { ok: false, error: e.message || 'Could not refresh cookie' };
  }
});

function robloxErrorText(body) {
  try {
    const d = JSON.parse(body || '{}');
    if (d.errors && d.errors[0] && d.errors[0].message) return d.errors[0].message;
    if (d.message) return d.message;
  } catch {}
  return null;
}
function postPasswordChange(cookie, csrf, currentPassword, newPassword) {
  return httpsPost('auth.roblox.com', '/v2/user/passwords/change', {
    'Cookie': `.ROBLOSECURITY=${cookie}`,
    'X-CSRF-TOKEN': csrf,
    'Origin': 'https://www.roblox.com',
    'Referer': 'https://www.roblox.com/my/account',
  }, { currentPassword, newPassword });
}
function classifyPasswordChangeError(body, status) {
  const text = robloxErrorText(body) || '';
  const t = text.toLowerCase();
  if (status === 401 || t.includes('not authenticated') || t.includes('authentication token')) {
    return { code: 'not-authenticated', error: 'The account cookie is expired or no longer valid - use "Refresh cookie & profile" or complete a browser login, then try again.' };
  }
  if (status === 403 || /challenge/i.test(t)) {
    return { code: 'challenge', error: 'Roblox now requires completing a security check (captcha) in a real browser before a password can be changed - open the account in the browser, change the password there, then refresh the account cookie.' };
  }
  return { code: null, error: text || `Roblox rejected the password change (HTTP ${status})` };
}

ipcMain.handle('roblox:changePassword', async (_, accountId, cookie, currentPassword, newPassword) => {
  try {
    if (!cookie && !accountId) return { ok: false, error: 'Missing cookie' };
    if (!newPassword) return { ok: false, error: 'Missing new password' };
    if (newPassword.length < 8 || newPassword.length > 128) return { ok: false, error: 'New password must be 8-128 characters' };
    if (newPassword.length !== newPassword.trim().length) return { ok: false, error: 'New password cannot start or end with a space' };
    if (!/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) return { ok: false, error: 'New password must contain at least one letter and one number' };

    let ck = cookie;
    if (accountId) {
      try {
        const acct = loadAccounts().find(a => String(a.id) === String(accountId));
        if (acct && acct.cookie) {
          const refreshed = await refreshAccountCookieFromStore(accountId, acct.userId);
          if (refreshed && refreshed.ok && refreshed.cookie) ck = refreshed.cookie;
        }
      } catch {}
    }
    if (!ck) return { ok: false, error: 'Missing cookie' };

    const csrf = await getCSRFToken(ck);
    if (!csrf) return { ok: false, code: 'not-authenticated', error: 'Could not get a CSRF token - the account cookie is expired or no longer valid' };
    const res = await Promise.race([
      postPasswordChange(ck, csrf, currentPassword || '', newPassword),
      new Promise(r => setTimeout(() => r({ status: 0, headers: {}, body: '', error: 'timeout' }), 15000)),
    ]);
    if (res.status === 403 && res.headers['x-csrf-token'] && !/challenge/i.test(robloxErrorText(res.body) || '')) {
      
      
      const retry = await postPasswordChange(ck, res.headers['x-csrf-token'], currentPassword || '', newPassword);
      if (retry.status >= 200 && retry.status < 300) {
        const rotatedCookie = await verifiedResponseCookie(retry.headers);
        return rotatedCookie ? { ok: true, cookie: rotatedCookie } : { ok: true };
      }
      return { ok: false, ...classifyPasswordChangeError(retry.body, retry.status) };
    }
    if (res.status >= 200 && res.status < 300) {
      const rotatedCookie = await verifiedResponseCookie(res.headers);
      return rotatedCookie ? { ok: true, cookie: rotatedCookie } : { ok: true };
    }
    if (res.error === 'timeout') return { ok: false, error: 'Request timed out' };
    return { ok: false, ...classifyPasswordChangeError(res.body, res.status) };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not change password' };
  }
});

ipcMain.handle('roblox:presence', async (_e, userIds) => {
  try {
    const ids = Array.from(new Set((userIds || [])
      .map(x => Number(x))
      .filter(x => Number.isFinite(x) && x > 0)));
    if (!ids.length) return { ok: true, data: [] };
    const out = [];
    let any = false;

    
    let firstValidCookie = null;
    const cookieByUserId = new Map();
    try {
      const accounts = loadAccounts();
      for (const a of accounts) {
        if (a && a.cookie) {
          if (!firstValidCookie) firstValidCookie = a.cookie;
          if (a.userId) cookieByUserId.set(Number(a.userId), a.cookie);
        }
      }
    } catch {}

    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const headers = { 'Accept': 'application/json' };

      let chunkCookie = null;
      for (const id of chunk) {
        if (cookieByUserId.has(id)) {
          chunkCookie = cookieByUserId.get(id);
          break;
        }
      }
      if (!chunkCookie) chunkCookie = firstValidCookie;
      if (chunkCookie) {
        let cVal = String(chunkCookie).trim();
        if (cVal.startsWith('.ROBLOSECURITY=')) cVal = cVal.slice('.ROBLOSECURITY='.length);
        headers['Cookie'] = '.ROBLOSECURITY=' + cVal;
      }

      
      
      const res = await Promise.race([
        httpsPost('presence.roblox.com', '/v1/presence/users',
          headers, { userIds: chunk }),
        new Promise((resolve) => setTimeout(() => resolve({ status: 0, headers: {}, body: '', error: 'timeout' }), 10000))
      ]);
      if (res.status === 200) {
        try {
          const j = JSON.parse(res.body);
          if (Array.isArray(j.userPresences)) { out.push(...j.userPresences); any = true; }
        } catch {}
      }
      
      
    }
    return any ? { ok: true, data: out } : { ok: false, error: 'presence unavailable' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

let puppeteerBrowserPath = null;
let _puppeteerCore = null;
let _puppeteerCoreLoadError = null;
let _puppeteerBrowsers = null;
let _puppeteerBrowsersLoadError = null;

function loadPackagedModule(name) {
  const roots = [];
  try { roots.push(app.getAppPath()); } catch {}
  if (process.resourcesPath) {
    roots.push(process.resourcesPath);
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
  }
  roots.push(__dirname);

  const tried = [];
  for (const root of roots) {
    try {
      const resolved = require.resolve(name, { paths: [root] });
      tried.push(resolved);
      return require(resolved);
    } catch (e) {
      tried.push(`${root}: ${e.code || e.message}`);
    }
  }
  
  
  for (const root of roots) {
    try {
      const scopedRequire = Module.createRequire(path.join(root, 'package.json'));
      return scopedRequire(name);
    } catch (e) {
      tried.push(`${root}/package.json: ${e.code || e.message}`);
    }
  }
  throw new Error(`Unable to load ${name}: ${tried.join(' | ')}`);
}

function loadPuppeteerCore() {
  if (_puppeteerCore) return _puppeteerCore;
  try {
    _puppeteerCore = loadPackagedModule('puppeteer-core');
    _puppeteerCoreLoadError = null;
    return _puppeteerCore;
  } catch (e) {
    _puppeteerCoreLoadError = e;
    console.error('[login] puppeteer-core load failed:', e.message);
    return null;
  }
}

function loadPuppeteerBrowsers() {
  if (_puppeteerBrowsers) return _puppeteerBrowsers;
  try {
    _puppeteerBrowsers = loadPackagedModule('@puppeteer/browsers');
    _puppeteerBrowsersLoadError = null;
    return _puppeteerBrowsers;
  } catch (e) {
    _puppeteerBrowsersLoadError = e;
    console.error('[login] @puppeteer/browsers load failed:', e.message);
    return null;
  }
}

async function ensureChrome() {
  try {
    const home = os.homedir();
    const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
    const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    const systemChromePaths = [
      path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ];
    for (const p of systemChromePaths) {
      if (fs.existsSync(p)) return p;
    }

    const pb = loadPuppeteerBrowsers();
    if (!pb) return null;
    const { install, Browser, detectBrowserPlatform, getInstalledBrowsers } = pb;
    const browserDir = path.join(app.getPath('userData'), 'chrome-for-login');

    if (fs.existsSync(browserDir)) {
      const installed = await getInstalledBrowsers({ cacheDir: browserDir });
      const chrome = installed.find(b => b.browser === Browser.CHROME);
      if (chrome && fs.existsSync(chrome.executablePath)) {
        return chrome.executablePath;
      }
    }

    if (win && !win.isDestroyed()) {
      win.webContents.send('chrome:download-progress', { status: 'downloading', percent: 0 });
    }

    const platform = detectBrowserPlatform();

    const buildId = await new Promise((resolve, reject) => {
      const req = net.request('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json');
      let body = '';
      req.on('response', res => {
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.channels.Stable.version);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    const result = await install({
      browser: Browser.CHROME,
      buildId,
      cacheDir: browserDir,
      platform,
      downloadProgressCallback: (downloaded, total) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('chrome:download-progress', {
            status: 'downloading',
            percent: total > 0 ? Math.round((downloaded / total) * 100) : 0
          });
        }
      }
    });

    if (win && !win.isDestroyed()) {
      win.webContents.send('chrome:download-progress', { status: 'done' });
    }

    return result.executablePath;
  } catch (e) {
    console.error('ensureChrome error:', e.message);
    return null;
  }
}

ipcMain.handle('roblox:openLogin', async (_e, prefill) => {
  const puppeteer = loadPuppeteerCore();
  if (!puppeteer) {
    return { success: false, error: `Browser login could not start: ${_puppeteerCoreLoadError?.message || 'puppeteer-core unavailable'}` };
  }
  const chromePath = await ensureChrome();
  if (!chromePath) {
    const detail = _puppeteerBrowsersLoadError?.message;
    return { success: false, error: detail
      ? `Chrome could not be found or downloaded: ${detail}`
      : 'Chrome could not be found or downloaded. Install Chrome or Edge and try again.' };
  }
  return puppeteerLogin(chromePath, prefill);
});

ipcMain.handle('roblox:openBrowserWithCookie', async (_, { cookie, targetUrl }) => {
  const puppeteer = loadPuppeteerCore();
  if (!puppeteer) return { ok: false, error: `Puppeteer could not start: ${_puppeteerCoreLoadError?.message || 'module unavailable'}` };
  const chromePath = await ensureChrome();
  if (!chromePath) return { ok: false, error: 'Chrome executable not found' };

  try {
    const puppeteer = loadPuppeteerCore();
    if (!puppeteer) throw (_puppeteerCoreLoadError || new Error('puppeteer-core unavailable'));
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const defaultPages = await browser.pages();
    const page = defaultPages.length > 0 ? defaultPages[0] : await browser.newPage();

    let cVal = cookie || '';
    if (cVal.startsWith('.ROBLOSECURITY=')) cVal = cVal.slice('.ROBLOSECURITY='.length);

    await page.setCookie({
      name: '.ROBLOSECURITY',
      value: cVal,
      domain: '.roblox.com',
      path: '/',
      httpOnly: true,
      secure: true
    });

    await page.goto(targetUrl || 'https://www.roblox.com/home', { waitUntil: 'domcontentloaded' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function puppeteerLogin(chromePath, prefill) {
  return new Promise(async (resolve) => {
    let browser = null;
    let resolved = false;
    const cleanup = async () => { if (browser) { try { await browser.close(); } catch (_) {} browser = null; } };

    try {
      const puppeteer = loadPuppeteerCore();
      if (!puppeteer) {
        resolve({ success: false, error: `Browser login could not start: ${_puppeteerCoreLoadError?.message || 'puppeteer-core unavailable'}` });
        return;
      }
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=530,700'],
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection'],
      });

      
      const defaultPages = await browser.pages();
      const page = defaultPages.length > 0 ? defaultPages[0] : await browser.newPage();

      await page.evaluateOnNewDocument(`
        Object.defineProperty(navigator,'webdriver',{get:()=>false});
        Object.defineProperty(navigator,'plugins',{get:()=>[{name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'}]});
      `);

      let capturedPassword = null;
      const attachPasswordCapture = (p) => {
        if (!p || p.__pwCapture) return;
        p.__pwCapture = true;
        try {
          p.on('request', (req) => {
            try {
              const u = req.url() || '';
              if (!/auth\.roblox\.com\/v[23]\/login/.test(u)) return;
              const data = req.postData();
              if (!data) return;
              const parsed = JSON.parse(data);
              if (parsed && typeof parsed.password === 'string' && parsed.password) capturedPassword = parsed.password;
            } catch {}
          });
        } catch {}
      };

      attachPasswordCapture(page);

      await page.goto('https://www.roblox.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (prefill && prefill.username && prefill.password) {
        try {
          await page.waitForSelector('#login-username, input[name="username"], input[name="UserName"]', { timeout: 20000 });
          await page.evaluate((username, password) => {
            const userSel = document.querySelector('#login-username, input[name="username"], input[name="UserName"]');
            const passSel = document.querySelector('#login-password, input[name="password"], input[name="Password"]');
            if (!userSel || !passSel) return false;
            const setVal = (el, val) => {
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
              el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            setVal(userSel, username);
            setVal(passSel, password);
            const btn = document.querySelector('#login-button, button[type="submit"], .login-button, .btn-primary[type="submit"]');
            if (btn) setTimeout(() => btn.click(), 350);
            return true;
          }, prefill.username, prefill.password);
        } catch (e) {
          console.error('login prefill failed:', e.message);
        }
      }

      const resolveActivePage = async () => {
        let pages = [];
        try { pages = await browser.pages(); } catch (e) { console.error('login: browser.pages() failed:', e.message); return null; }
        pages = pages.filter(p => { try { return !p.isClosed(); } catch { return false; } });
        if (pages.length === 0) return null;
        const onRoblox = pages.find(p => { try { return (p.url() || '').includes('roblox.com'); } catch { return false; } });
        attachPasswordCapture(onRoblox || pages[pages.length - 1]);
        return onRoblox || pages[pages.length - 1];
      };

      const tryGetCookie = async () => {
        const target = await resolveActivePage();
        if (!target) return null;
        let client = null;
        try {
          client = await target.createCDPSession();
          const { cookies } = await client.send('Network.getAllCookies');
          return cookies.find(ck => ck.name === '.ROBLOSECURITY' && ck.domain.includes('roblox.com') && ck.value && ck.value.length > 100) || null;
        } finally {
          if (client) { try { await client.detach(); } catch (_) {} }
        }
      };

      const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; 
      const startedAt = Date.now();
      let loginTimer = null;

      const finishOk = async (rbxCookie) => {
        resolved = true;
        clearInterval(poll);
        if (loginTimer) clearTimeout(loginTimer);
        await cleanup();
        const info = await fetchUserInfo(rbxCookie.value);
        if (!info.ok) { resolve({ success: false, error: info.reason || 'Could not verify account.' }); return; }
        resolve({ success: true, cookie: rbxCookie.value, username: info.username, userId: info.userId, password: capturedPassword || '' });
      };

      const poll = setInterval(async () => {
        if (resolved) return;
        try {
          const rbxCookie = await tryGetCookie();
          if (rbxCookie) { await finishOk(rbxCookie); return; }
        } catch (e) {
          
          console.error('login poll error (will retry):', e.message);
        }
      }, 1500);

      loginTimer = setTimeout(async () => {
        if (resolved) return;
        resolved = true;
        clearInterval(poll);
        await cleanup();
        console.error('login: timed out after', Math.round((Date.now() - startedAt) / 1000), 's');
        resolve({ success: false, error: 'Timed out waiting for login. Please try again, or use "Paste Cookie".' });
      }, LOGIN_TIMEOUT_MS);

      browser.on('disconnected', () => { clearInterval(poll); if (loginTimer) clearTimeout(loginTimer); if (!resolved) { resolved = true; resolve({ success: false, error: 'Login window closed' }); } });
      ipcMain.once('login:cancel', async () => { clearInterval(poll); if (loginTimer) clearTimeout(loginTimer); if (!resolved) { resolved = true; await cleanup(); resolve({ success: false, error: 'Login window closed' }); } });
    } catch (e) {
      console.error('puppeteerLogin error:', e.message);
      await cleanup();
      if (!resolved) resolve({ success: false, error: 'Failed to launch Chrome: ' + e.message });
    }
  });
}

async function headlessRelogin(username, password) {
  return new Promise(async (resolve) => {
    let browser = null;
    let resolved = false;
    const cleanup = async () => { if (browser) { try { await browser.close(); } catch (_) {} browser = null; } };
    const finish = (v) => { if (!resolved) { resolved = true; resolve(v); } };

    try {
      const puppeteer = loadPuppeteerCore();
      if (!puppeteer) return finish({ ok: false, error: `Browser engine unavailable: ${_puppeteerCoreLoadError?.message || 'puppeteer-core'}` });
      const chromePath = await ensureChrome();
      if (!chromePath) return finish({ ok: false, error: 'Chrome could not be found or downloaded.' });

      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        defaultViewport: { width: 1280, height: 800 },
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,800'],
        ignoreDefaultArgs: ['--enable-automation'],
      });

      const page = (await browser.pages())[0] || await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(`
        Object.defineProperty(navigator,'webdriver',{get:()=>false});
        Object.defineProperty(navigator,'plugins',{get:()=>[{name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'}]});
        Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
      `);

      sendLog('info', 'cookie', `Background re-login started for ${username} (headless, no window)`);
      await page.goto('https://www.roblox.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

      const filled = await page.waitForSelector('#login-username, input[name="username"], input[name="UserName"]', { timeout: 20000 }).then(() => page.evaluate((u, p) => {
        const setVal = (el, val) => {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const userEl = document.querySelector('#login-username, input[name="username"], input[name="UserName"]');
        const passEl = document.querySelector('#login-password, input[name="password"], input[name="Password"]');
        if (!userEl || !passEl) return false;
        setVal(userEl, u);
        setVal(passEl, p);
        const btn = document.querySelector('#login-button, button[type="submit"], .login-button, .btn-primary[type="submit"]');
        if (btn) setTimeout(() => btn.click(), 300);
        return true;
      }, username, password)).catch(() => false);
      if (!filled) return finish({ ok: false, error: 'Could not find the login form on the Roblox page.' });

      const getCookie = async () => {
        try {
          const client = await page.createCDPSession();
          try {
            const { cookies } = await client.send('Network.getAllCookies');
            return cookies.find(ck => ck.name === '.ROBLOSECURITY' && ck.domain.includes('roblox.com') && ck.value && ck.value.length > 100) || null;
          } finally { try { await client.detach(); } catch (_) {} }
        } catch { return null; }
      };

      const looksLike2FA = async () => {
        try {
          return await page.evaluate(() => {
            if (/two-step|verification|challenge/i.test(location.href || '')) return true;
            return Array.from(document.querySelectorAll('input')).some(i => /code|verification/i.test((i.id || '') + ' ' + (i.name || '') + ' ' + (i.placeholder || '')));
          });
        } catch { return false; }
      };

      const loginErrorText = async () => {
        try {
          return await page.evaluate(() => {
            const el = document.querySelector('#login-error');
            if (el && el.offsetParent !== null && el.textContent.trim()) return el.textContent.trim();
            const re = /incorrect username|incorrect password|username or password|is locked|too many attempts|invalid credential/i;
            for (const c of Array.from(document.querySelectorAll('div, span, p, h1, h2'))) {
              if (c.offsetParent === null) continue;
              const t = (c.textContent || '').trim();
              if (t.length > 0 && t.length < 140 && re.test(t)) return t;
            }
            return null;
          });
        } catch { return null; }
      };

      const looksLikeCaptcha = async () => {
        try {
          return await page.evaluate(() => {
            if (document.querySelector('iframe[src*="arkoselabs"], iframe[src*="captcha"], #arkose-iframe, .captcha-iframe')) return true;
            const el = document.querySelector('[id*="captcha"], [class*="captcha"], [class*="arkose"]');
            return !!el && el.offsetParent !== null;
          });
        } catch { return false; }
      };

      const startedAt = Date.now();
      const TIMEOUT = 45000;
      let timer = null;
      const poll = setInterval(async () => {
        if (resolved) return;
        const errTxt = await loginErrorText();
        if (errTxt) {
          clearInterval(poll); if (timer) clearTimeout(timer);
          await cleanup();
          sendLog('err', 'cookie', `Background re-login rejected for ${username}: ${errTxt}`);
          return finish({ ok: false, error: errTxt });
        }
        if (Date.now() - startedAt > 8000 && await looksLikeCaptcha()) {
          clearInterval(poll); if (timer) clearTimeout(timer);
          await cleanup();
          _reloginBlockedAt.set(username, Date.now());
          sendLog('warn', 'cookie', `Background re-login blocked by a captcha for ${username} - backing off`);
          return finish({ ok: false, captcha: true, error: 'Roblox is asking for a captcha to verify this login. Complete one login in a normal browser to clear it - the app will back off and retry later.' });
        }
        const ck = await getCookie();
        if (ck) {
          clearInterval(poll); if (timer) clearTimeout(timer);
          const info = await fetchUserInfo(ck.value);
          await cleanup();
          if (!info.ok) return finish({ ok: false, error: info.reason || 'Could not verify the fresh session.' });
          _reloginBlockedAt.delete(username); 
          sendLog('ok', 'cookie', `Background re-login succeeded for ${username}`);
          return finish({ ok: true, cookie: ck.value, username: info.username, userId: info.userId });
        }
        if (Date.now() - startedAt > 10000 && await looksLike2FA()) {
          clearInterval(poll); if (timer) clearTimeout(timer);
          await cleanup();
          _reloginBlockedAt.set(username, Date.now());
          sendLog('warn', 'cookie', `Background re-login needs a 2-step verification code for ${username} - backing off`);
          return finish({ ok: false, needs2fa: true, error: 'This account requires a 2-step verification code (Roblox security).' });
        }
      }, 1500);

      timer = setTimeout(async () => {
        clearInterval(poll);
        await cleanup();
        sendLog('err', 'cookie', `Background re-login timed out for ${username}`);
        finish({ ok: false, error: 'Timed out waiting for login. Roblox may be asking for extra verification (captcha/2FA) - try the "Re-login" button again, or add the account via browser login.' });
      }, TIMEOUT);

      browser.on('disconnected', () => { clearInterval(poll); if (timer) clearTimeout(timer); if (!resolved) finish({ ok: false, error: 'Browser engine closed unexpectedly.' }); });
    } catch (e) {
      await cleanup();
      finish({ ok: false, error: 'Background login failed: ' + e.message });
    }
  });
}

const _reloginBlockedAt = new Map(); 
const RELOGIN_BLOCK_MS = 20 * 60 * 1000; 

function _reloginBlockRemainingMs(username) {
  const ts = _reloginBlockedAt.get(username);
  if (!ts) return 0;
  const left = ts + RELOGIN_BLOCK_MS - Date.now();
  if (left <= 0) { _reloginBlockedAt.delete(username); return 0; }
  return left;
}

ipcMain.handle('roblox:reloginHeadless', async (_e, username, password) => {
  try {
    if (!username || !password) return { ok: false, error: 'Missing username or password' };
    const remaining = _reloginBlockRemainingMs(username);
    if (remaining > 0) {
      const mins = Math.max(1, Math.ceil(remaining / 60000));
      return { ok: false, blocked: true, error: `Roblox flagged this account's logins - waiting ${mins} min before retrying to avoid another captcha. Complete one login in a normal browser to clear it faster.` };
    }
    return await headlessRelogin(username, password);
  } catch (e) {
    return { ok: false, error: e.message || 'Background login failed' };
  }
});


function getCustomRobloxVersionsDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dir = path.join(appData, 'rblxswap', 'core', 'roblox');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function isCompleteRobloxVersion(dirPath) {
  try {
    if (!fs.existsSync(path.join(dirPath, 'RobloxPlayerBeta.exe'))) return false;
    for (const name of ['content', 'content-roblox']) {
      try {
        const p = path.join(dirPath, name);
        
        
        if (fs.existsSync(p) && fs.readdirSync(p).length > 0) return true;
      } catch {}
    }
    return false;
  } catch { return false; }
}

function isUsableInstalledVersion(dirPath) {
  try {
    const dirStat = fs.statSync(dirPath);
    const exe = path.join(dirPath, 'RobloxPlayerBeta.exe');
    const exeStat = fs.statSync(exe);
    return dirStat.isDirectory() && exeStat.isFile() && isCompleteRobloxVersion(dirPath);
  } catch { return false; }
}

function getLatestRobloxVersionDir() {
  try {
    const searchDirs = [
      getCustomRobloxVersionsDir(),
      path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions'),
      path.join(app.getPath('userData'), 'Versions')
    ];
    const candidates = [];
    for (const versionsBase of searchDirs) {
      if (!fs.existsSync(versionsBase)) continue;
      const found = fs.readdirSync(versionsBase)
        .filter(d => d.startsWith('version-'))
        .map(d => {
          const dirPath = path.join(versionsBase, d);
          const exe = path.join(dirPath, 'RobloxPlayerBeta.exe');
          if (!isCompleteRobloxVersion(dirPath)) return null;
          try {
            const st = fs.statSync(exe);
            const dirSt = fs.statSync(dirPath);
            const maxTime = Math.max(
              st.mtimeMs || 0, st.ctimeMs || 0, st.birthtimeMs || 0,
              dirSt.mtimeMs || 0, dirSt.ctimeMs || 0, dirSt.birthtimeMs || 0
            );
            return { dir: dirPath, exe, mtime: maxTime };
          } catch { return null; }
        })
        .filter(Boolean);
      candidates.push(...found);
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.length ? candidates[0] : null;
  } catch { return null; }
}

function getFFlagPath() {
  const latest = getLatestRobloxVersionDir();
  if (!latest) return null;
  return path.join(latest.dir, 'ClientSettings', 'ClientAppSettings.json');
}

ipcMain.handle('fflag:read', () => {
  try {
    const p = getFFlagPath();
    if (!p || !fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return {}; }
});

ipcMain.handle('fflag:write', (_, flags) => {
  try {
    const p = getFFlagPath();
    if (!p) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(flags, null, 2), 'utf8');
    return true;
  } catch { return false; }
});


function getGlobalSettingsDir() {
  return path.join(os.homedir(), 'AppData', 'Local', 'Roblox');
}

function getGlobalSettingsPaths() {
  const dir = getGlobalSettingsDir();
  try {
    const names = fs.readdirSync(dir).filter(n => /^GlobalBasicSettings_\d+\.xml$/i.test(n));
    names.sort(); 
    return names.map(n => path.join(dir, n));
  } catch { return []; }
}

function getGlobalSettingsPath() {
  const all = getGlobalSettingsPaths();
  return all.length ? all[0] : path.join(getGlobalSettingsDir(), 'GlobalBasicSettings_13.xml');
}

function writeGlobalSettingsInt(filePaths, name, value) {
  for (const p of filePaths) {
    try {
      if (!fs.existsSync(p)) continue;
      let xml = fs.readFileSync(p, 'utf8');
      const re = new RegExp(`<int\\s+name=\"${name}\"\\s*>(?:-?\\d+)<\\/int>`, 'gi');
      const had = re.test(xml);
      if (had) {
        xml = xml.replace(new RegExp(`<int\\s+name=\"${name}\"\\s*>(?:-?\\d+)<\\/int>`, 'gi'), `<int name="${name}">${value}</int>`);
      } else {
        xml = xml.replace(/(<\/Item>)/, `\t\t<int name="${name}">${value}</int>\n$1`);
      }
      fs.writeFileSync(p, xml, 'utf8');
    } catch {}
  }
}

ipcMain.handle('fps:read', () => {
  try {
    const saved = loadSettings();
    if (Number.isFinite(Number(saved.fpsCap))) return Math.max(0, Math.round(Number(saved.fpsCap)));

    const paths = getGlobalSettingsPaths();
    for (const p of paths) {
      if (!fs.existsSync(p)) continue;
      const xml = fs.readFileSync(p, 'utf8');
      const m = xml.match(/<int\s+name="FramerateCap"\s*>(-?\d+)<\/int>/i);
      if (m) {
        const value = Math.max(0, parseInt(m[1], 10));
        
        
        saveSettings({ ...saved, fpsCap: value, fpsUnlimited: value === 0 });
        return value;
      }
    }
    return 60;
  } catch { return 60; }
});

ipcMain.handle('fps:write', (_, cap) => {
  try {
    const numericCap = typeof cap === 'number' ? cap : Number(cap);
    if (!Number.isFinite(numericCap)) return { ok: false, error: 'Invalid FPS cap' };
    const value = Math.max(0, Math.round(numericCap));
    const current = loadSettings();
    
    
    saveSettings({ ...current, fpsCap: value, fpsUnlimited: value === 0 });
    const paths = getGlobalSettingsPaths();
    if (paths.length) writeGlobalSettingsInt(paths, 'FramerateCap', value);
    return { ok: true, value, persisted: true, xmlWritten: paths.length > 0 };
  } catch (e) { return { ok: false, error: e.message }; }
});

async function resolveShareLink(shareCode, cookie, csrfToken) {

  const makeRequest = (csrf) => new Promise((resolve) => {
    
    const tryPayload = (payloadStr, csrfHeader, cb) => {
      const req = https.request({
        hostname: 'apis.roblox.com',
        path: '/sharelinks/v1/resolve-link',
        method: 'POST',
        headers: {
          'Cookie': `.ROBLOSECURITY=${cookie}`,
          'X-CSRF-TOKEN': csrfHeader || '',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          cb(res.statusCode, res.headers, body);
        });
      });
      req.on('error', e => cb(0, {}, ''));
      req.setTimeout(8000, () => { req.destroy(); cb(0, {}, ''); });
      req.write(payloadStr);
      req.end();
    };

    const payloads = [
      JSON.stringify({ linkId: shareCode, linkType: 'Server' }),
      JSON.stringify({ code: shareCode, type: 'Server' }),
    ];

    const tryNext = (i, currentCsrf) => {
      if (i >= payloads.length) return resolve({ ok: false });
      tryPayload(payloads[i], currentCsrf, (status, headers, body) => {
        if (status === 200) {
          const pidM = body.match(/"placeId"\s*:\s*(\d+)/);
          const lcM = body.match(/"(?:linkCode|privateServerLinkCode|accessCode|linkcode)"\s*:\s*"([A-Za-z0-9_\-]+)"/);
          if (pidM && lcM) {
            return resolve({ ok: true, placeId: pidM[1], linkCode: lcM[1] });
          }
        }
        if (status === 403 && headers['x-csrf-token']) {
          
          tryPayload(payloads[i], headers['x-csrf-token'], (status2, headers2, body2) => {
            if (status2 === 200) {
              const pidM = body2.match(/"placeId"\s*:\s*(\d+)/);
              const lcM = body2.match(/"(?:linkCode|privateServerLinkCode|accessCode|linkcode)"\s*:\s*"([A-Za-z0-9_\-]+)"/);
              if (pidM && lcM) {
                return resolve({ ok: true, placeId: pidM[1], linkCode: lcM[1] });
              }
            }
            tryNext(i + 1, currentCsrf);
          });
        } else {
          tryNext(i + 1, currentCsrf);
        }
      });
    };

    tryNext(0, csrfToken || '');
  });

  const result = await makeRequest(csrfToken);
  if (!result.ok) {
    return { ok: false, error: 'Could not resolve share link. It may be expired or invalid.' };
  }

  return { ok: true, placeId: result.placeId, linkCode: result.linkCode };
}

async function followRedirect(url) {
  return new Promise((resolve) => {
    const req = net.request({ method: 'GET', url, redirect: 'manual', useSessionCookies: false });
    req.on('response', res => {
      const loc = res.headers['location'];
      resolve(loc || url);
    });
    req.on('error', () => resolve(url));
    req.end();
  });
}



async function getAccessCode(placeId, linkCode, cookie, csrfToken) {
  
  try {
    const bodyStr = JSON.stringify({ shareCode: linkCode, shareType: 'Server' });
    const req = net.request({
      method: 'POST',
      url: 'https://apis.roblox.com/sharelinks/v1/resolve',
      useSessionCookies: false,
      headers: {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'X-CSRF-TOKEN': csrfToken || '',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'application/json',
        'Origin': 'https://www.roblox.com',
        'Referer': 'https://www.roblox.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const result = await new Promise((resolve) => {
      let body = '';
      req.on('response', res => {
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const d = JSON.parse(body);
            const inv = d?.privateServerInviteData
              || d?.resolvedShareData?.privateServerInviteData
              || d?.experienceInviteData?.privateServerInviteData;
            if (inv && inv.accessCode) resolve(inv.accessCode);
            else resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(bodyStr);
      req.end();
    });
    if (result) return result;
  } catch {}

  
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'www.roblox.com',
      path: `/games/${placeId}?privateServerLinkCode=${linkCode}`,
      method: 'GET',
      headers: {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'Referer': 'https://www.roblox.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, res => {
      const loc = res.headers['location'] || '';
      const match = loc.match(/[?&]accessCode=([^&]+)/);
      resolve(match ? match[1] : null);
      res.resume();
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}


ipcMain.handle('roblox:getGameName', async (_, placeIdOrTarget, cookie) => {
  try {
    
    let placeId = placeIdOrTarget;
    if (!/^\d+$/.test(String(placeIdOrTarget).trim())) {
      
      try {
        const u = new URL(placeIdOrTarget.startsWith('http') ? placeIdOrTarget : 'https://' + placeIdOrTarget);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[0] === 'games' && parts[1] && /^\d+$/.test(parts[1])) {
          placeId = parts[1];
        } else {
          const m = placeIdOrTarget.match(/[?&]placeId=(\d+)/);
          if (m) placeId = m[1];
        }
      } catch {}
      if (!/^\d+$/.test(String(placeId).trim())) return null;
    }
    const result = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'games.roblox.com',
        path: '/v1/games/multiget-place-details?placeIds=' + placeId,
        method: 'GET',
        headers: {
          'Cookie': `.ROBLOSECURITY=${cookie}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const d = JSON.parse(body);
            const name = Array.isArray(d) ? d[0]?.name : null;
            resolve(name || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (result) return result;

    const getJson = (hostname, urlPath) => new Promise((resolve) => {
      const req = https.request({
        hostname, path: urlPath, method: 'GET',
        headers: {
          'Cookie': `.ROBLOSECURITY=${cookie}`,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    try {
      const uni = await getJson('apis.roblox.com', '/universes/v1/places/' + placeId + '/universe');
      const universeId = uni && uni.universeId;
      if (universeId) {
        const games = await getJson('games.roblox.com', '/v1/games?universeIds=' + universeId);
        const name = games && Array.isArray(games.data) ? (games.data[0] && games.data[0].name) : null;
        if (name) return name;
      }
    } catch {}
    return null;
  } catch { return null; }
});

function getInstalledRobloxVersions() {
  const list = [];

  
  try {
    const customBase = getCustomRobloxVersionsDir();
    if (fs.existsSync(customBase)) {
      const dirs = fs.readdirSync(customBase).filter(d => d.startsWith('version-'));
      for (const d of dirs) {
        const dirPath = path.join(customBase, d);
        const exe = path.join(dirPath, 'RobloxPlayerBeta.exe');
        if (isUsableInstalledVersion(dirPath)) {
          const st = fs.statSync(exe);
          list.push({ hash: d, dir: dirPath, exe, mtime: st.mtimeMs, location: 'Installed', complete: true });
        }
      }
    }
  } catch {}

  
  try {
    const versionsBase = path.join(os.homedir(), 'AppData', 'Local', 'Roblox', 'Versions');
    if (fs.existsSync(versionsBase)) {
      const dirs = fs.readdirSync(versionsBase).filter(d => d.startsWith('version-'));
      for (const d of dirs) {
        const dirPath = path.join(versionsBase, d);
        const exe = path.join(dirPath, 'RobloxPlayerBeta.exe');
        if (isUsableInstalledVersion(dirPath)) {
          const st = fs.statSync(exe);
          if (!list.some(x => x.hash === d)) {
            list.push({ hash: d, dir: dirPath, exe, mtime: st.mtimeMs, location: 'Official Roblox', complete: true });
          }
        }
      }
    }
  } catch {}

  
  try {
    const rddBase = path.join(app.getPath('userData'), 'Versions');
    if (fs.existsSync(rddBase)) {
      const dirs = fs.readdirSync(rddBase).filter(d => d.startsWith('version-'));
      for (const d of dirs) {
        const dirPath = path.join(rddBase, d);
        const exe = path.join(dirPath, 'RobloxPlayerBeta.exe');
        if (isUsableInstalledVersion(dirPath)) {
          const st = fs.statSync(exe);
          if (!list.some(x => x.hash === d)) {
            list.push({ hash: d, dir: dirPath, exe, mtime: st.mtimeMs, location: 'RDD Installed', complete: true });
          }
        }
      }
    }
  } catch {}

  return list.sort((a, b) => b.mtime - a.mtime);
}

ipcMain.handle('roblox:getInstalledVersions', () => getInstalledRobloxVersions());

ipcMain.handle('roblox:openVersionDirectory', async (_, hash) => {
  try {
    const requestedHash = String(hash || '').trim();
    const version = getInstalledRobloxVersions().find(v => v.hash === requestedHash);
    if (!version || !isUsableInstalledVersion(version.dir)) {
      return { ok: false, error: 'That Roblox version is no longer installed.' };
    }
    const error = await shell.openPath(version.dir);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'Could not open the install directory' };
  }
});

ipcMain.handle('roblox:removeVersion', async (_, hash) => {
  try {
    const versions = getInstalledRobloxVersions();
    const v = versions.find(x => x.hash === hash);
    if (!v || !v.dir) return { ok: false, error: 'Version not found' };
    const dir = path.resolve(v.dir);
    const customBase = getCustomRobloxVersionsDir();
    const officialBase = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions');
    const underCustom = customBase && (dir === path.resolve(customBase) || dir.startsWith(path.resolve(customBase) + path.sep));
    const underOfficial = dir.startsWith(path.resolve(officialBase) + path.sep);
    if (!underCustom && !underOfficial) return { ok: false, error: 'Refusing to remove outside Roblox version folders' };
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});




function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      try {
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile()) total += fs.statSync(p).size;
      } catch {}
    }
  }
  return total;
}

ipcMain.handle('roblox:getVersionsDiskUsage', async () => {
  try {
    const versions = getInstalledRobloxVersions();
    const out = versions.map(v => {
      let bytes = 0;
      try { bytes = dirSizeBytes(v.dir); } catch {}
      return {
        hash: v.hash,
        location: v.location || 'Installed',
        mtime: v.mtime || 0,
        bytes,
        
        protected: v.location === 'Official Roblox',
      };
    });
    return { ok: true, versions: out, totalBytes: out.reduce((s, v) => s + v.bytes, 0) };
  } catch (e) {
    return { ok: false, error: e.message, versions: [], totalBytes: 0 };
  }
});





ipcMain.handle('roblox:cleanOldVersions', async (_e, keepHashes) => {
  const removed = [];
  const failed = [];
  let freedBytes = 0;
  try {
    const keep = new Set((Array.isArray(keepHashes) ? keepHashes : [])
      .map(h => normalizeRobloxVersionHash(String(h || '')))
      .filter(Boolean));
    const customBase = getCustomRobloxVersionsDir();
    const officialBase = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions');
    const customRes = customBase ? path.resolve(customBase) : '';
    const officialRes = path.resolve(officialBase);
    const versions = getInstalledRobloxVersions();
    for (const v of versions) {
      if (keep.has(normalizeRobloxVersionHash(v.hash))) continue;
      if (v.location === 'Official Roblox') continue;
      const dir = path.resolve(v.dir);
      const underCustom = customRes && (dir === customRes || dir.startsWith(customRes + path.sep));
      const underOfficial = dir.startsWith(officialRes + path.sep);
      if (!underCustom && !underOfficial) { failed.push({ hash: v.hash, error: 'outside Roblox version folders' }); continue; }
      let bytes = 0;
      try { bytes = dirSizeBytes(v.dir); } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(v.hash);
        freedBytes += bytes;
      } catch (e) {
        failed.push({ hash: v.hash, error: e.message });
      }
    }
    return { ok: failed.length === 0, removed, failed, freedBytes };
  } catch (e) {
    return { ok: false, error: e.message, removed, failed, freedBytes };
  }
});

ipcMain.handle('roblox:launch', async (_, accountId, cookie, target, versionHash, options) => {
  const result = await (_launchQueue = _launchQueue.then(() => _doLaunch(accountId, cookie, target, versionHash, options)));
  return result;
});

const _watchedAccounts = new Map(); 
const _accountRamLimits = new Map(); 
const _ramLimitProcs = new Map();   
const _launchTimes = new Map();      
const _missCounts = new Map();      
const _everSeen = new Set();       
const _pidLostAt = new Map();      
const MISS_THRESHOLD = 2;      
const LAUNCH_VERIFY_MS = 15000; 
const POLL_INTERVAL = 2000;    
const LAUNCH_DELAY = 0;        
const LAUNCH_STARTUP_GRACE = 90000;
const PROCESS_REATTACH_GRACE = 20000; 
let _watchTimer = null;

function applyLaunchPerformanceSettings(robloxExePath, options) {
  if (!options) return;
  const fpsCap = (typeof options.fpsCap === 'number' && !isNaN(options.fpsCap)) ? options.fpsCap : null;
  const gfxLevel = (typeof options.gfxLevel === 'number' && !isNaN(options.gfxLevel)) ? options.gfxLevel : null;
  
  if (fpsCap !== null || gfxLevel !== null) {
    const applyToDir = (verDir) => {
      if (!verDir || !fs.existsSync(verDir)) return;
      const csDir = path.join(verDir, 'ClientSettings');
      const jsonPath = path.join(csDir, 'ClientAppSettings.json');
      try {
        fs.mkdirSync(csDir, { recursive: true });
        let flags = {};
        if (fs.existsSync(jsonPath)) {
          try { flags = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
        }
        if (fpsCap !== null) {
          flags['DFIntTaskSchedulerTargetFps'] = Math.max(5, Math.round(fpsCap));
        }
        if (gfxLevel !== null) {
          flags['FIntSavedQualityLevel'] = Math.max(1, Math.min(21, Math.round(gfxLevel)));
        }
        fs.writeFileSync(jsonPath, JSON.stringify(flags, null, 2), 'utf8');
      } catch (e) {}
    };

    if (robloxExePath) applyToDir(path.dirname(robloxExePath));
    try {
      const latest = getLatestRobloxVersionDir();
      if (latest && latest.dir) applyToDir(latest.dir);
    } catch {}

    try {
      const gPaths = getGlobalSettingsPaths();
      if (gPaths.length) {
        if (fpsCap !== null) writeGlobalSettingsInt(gPaths, 'FramerateCap', Math.max(5, Math.round(fpsCap)));
        if (gfxLevel !== null) writeGlobalSettingsInt(gPaths, 'GraphicsQualityLevel', Math.max(1, Math.min(21, Math.round(gfxLevel))));
      }
    } catch (e) {}
  }
}

function _startWatchPoll() {
  if (_watchTimer) return;
  _watchTimer = setInterval(_watchTick, POLL_INTERVAL);
}
function _stopWatchPollIfIdle() {
  if (_watchedAccounts.size === 0 && _watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
}

function claimRobloxPids(alivePids, pidStartMap, anyRunning, now) {
  const isWin = process.platform === 'win32';
  const claimedPids = new Set();
  for (const pid of _accountPids.values()) if (alivePids.has(pid)) claimedPids.add(pid);
  const runningMap = new Map();
  for (const [accountId, readyAt] of _watchedAccounts) {
    if (now < readyAt) continue;
    const pid = _accountPids.get(accountId);
    let running = (isWin && pid) ? alivePids.has(pid) : anyRunning;
    if (isWin && !running) {
      const launchAt = _launchTimes.get(accountId) || 0;
      const candidates = Array.from(alivePids)
        .filter(candidate => !claimedPids.has(candidate))
        .filter(candidate => (pidStartMap.get(candidate) || 0) >= Math.max(0, launchAt - 5000))
        .sort((a, b) => (pidStartMap.get(a) || Number.MAX_SAFE_INTEGER) - (pidStartMap.get(b) || Number.MAX_SAFE_INTEGER));
      if (candidates.length) {
        _accountPids.set(accountId, candidates[0]);
        claimedPids.add(candidates[0]);
        running = true;
        _pidLostAt.delete(accountId);
        
        
        const ramLimit = _accountRamLimits.get(accountId);
        const launchGeneration = _launchGenerations.get(accountId) || 0;
        if (ramLimit !== undefined && !_ramLimitProcs.has(accountId)) {
          enforceRamLimitForAccount(accountId, candidates[0], ramLimit, _launchTimes.get(accountId) || 0, launchGeneration);
        }
      } else if (pid && anyRunning) {
        const lostAt = _pidLostAt.get(accountId) || now;
        _pidLostAt.set(accountId, lostAt);
        if (now - lostAt < PROCESS_REATTACH_GRACE) {
          _missCounts.set(accountId, 0);
          runningMap.set(accountId, true); 
          continue;
        }
      }
    }
    if (running) _pidLostAt.delete(accountId);
    runningMap.set(accountId, running);
  }
  return { claimedPids, runningMap };
}

function _watchRoblox(accountId, generation) {
  const token = Number.isInteger(generation)
    ? generation
    : (_launchGenerations.get(accountId) || 0);
  _watchGenerations.set(accountId, token);
  _watchedAccounts.set(accountId, Date.now() + LAUNCH_DELAY);
  _missCounts.set(accountId, 0);
  _everSeen.delete(accountId);
  _pidLostAt.delete(accountId);
  _startWatchPoll();
}

function _watchTick() {
  if (_watchedAccounts.size === 0) { _stopWatchPollIfIdle(); return; }
  const isWin = process.platform === 'win32';
  const proc = isWin
    ? spawn('powershell', ['-NoProfile', '-Command', 'Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | ForEach-Object { $_.Id.ToString() + "," + $_.WorkingSet64.ToString() + "," + ([DateTimeOffset]$_.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString() }'], { windowsHide: true })
    : spawn('sh', ['-c', 'pgrep -x RobloxPlayer']);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.on('error', () => {});
  proc.on('close', () => {
    const alivePids = new Set();
    const pidRamMap = new Map();
    const pidStartMap = new Map();
    let anyRunning = false;
    if (isWin) {
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(',');
        if (parts.length >= 2) {
          const pid = parseInt(parts[0], 10);
          const bytes = parseInt(parts[1], 10);
          const startedAt = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
          if (pid > 0 && bytes >= 0) {
            alivePids.add(pid);
            pidRamMap.set(pid, Math.round(bytes / 1024 / 1024));
            if (startedAt > 0) pidStartMap.set(pid, startedAt);
          }
        }
      }
      anyRunning = alivePids.size > 0;
    } else {
      anyRunning = out.trim().length > 0;
    }

    
    

    const accountRamMap = {};
    for (const [accId, pid] of _accountPids) {
      if (alivePids.has(pid) && pidRamMap.has(pid)) {
        const configuredLimit = _accountRamLimits.get(accId);
        accountRamMap[accId] = {
          usageMb: pidRamMap.get(pid),
          limitMb: Number.isInteger(configuredLimit) ? configuredLimit : null,
        };
      }
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('roblox:ram-stats', accountRamMap);
    }

    const now = Date.now();
    const closed = [];
    const { claimedPids, runningMap } = claimRobloxPids(alivePids, pidStartMap, anyRunning, now);
    for (const [accountId, readyAt] of _watchedAccounts) {
      if (now < readyAt) continue;
      if (!runningMap.get(accountId)) {
        const launchAt = _launchTimes.get(accountId) || 0;
        if (!_everSeen.has(accountId) && (now - launchAt) < LAUNCH_STARTUP_GRACE) {
          _missCounts.set(accountId, 0);
          continue;
        }
        const misses = (_missCounts.get(accountId) || 0) + 1;
        _missCounts.set(accountId, misses);
        if (misses >= MISS_THRESHOLD) closed.push(accountId);
      } else {
        _missCounts.set(accountId, 0);
        _everSeen.add(accountId);
      }
    }
    for (const accountId of closed) {
      const wasSeen = _everSeen.has(accountId);
      _watchedAccounts.delete(accountId);
      _missCounts.delete(accountId);
      _everSeen.delete(accountId);
      _pidLostAt.delete(accountId);
      _accountRamLimits.delete(accountId);
      clearRamLimit(accountId);
      const launchAt = _launchTimes.get(accountId) || 0;
      _launchTimes.delete(accountId);
      const closedAccts = loadAccounts();
      const closedAcct = closedAccts.find(a => a.id === accountId) || {};
      sendLog('warn', 'crash', `Roblox closed unexpectedly for ${closedAcct.username || accountId} (missed ${MISS_THRESHOLD} consecutive checks)`, {
        accountId, username: closedAcct.username || null, userId: closedAcct.userId || null, pid: _accountPids.get(accountId) || null
      });
      if (!wasSeen && (now - launchAt) >= LAUNCH_STARTUP_GRACE) {
        sendLog('warn', 'launch', `Roblox did not remain visible after starting ${closedAcct.username || accountId}; no startup toast was shown because the process may have been closed intentionally.`, {
          accountId, username: closedAcct.username || null, userId: closedAcct.userId || null
        });
      }
      _watchGenerations.delete(accountId);
      _accountPids.delete(accountId);
      const volumeTimer = _launchVolumeTimers.get(accountId);
      if (volumeTimer) clearTimeout(volumeTimer);
      _launchVolumeTimers.delete(accountId);
      _launchVolumeGenerations.set(accountId, (_launchVolumeGenerations.get(accountId) || 0) + 1);
      if (win && !win.isDestroyed()) win.webContents.send('roblox:closed', accountId);
    }
    if (isWin && win && !win.isDestroyed()) {
      const temp = [];
      for (const pid of alivePids) {
        if (claimedPids.has(pid)) continue;
        temp.push({ pid, startedAt: pidStartMap.get(pid) || 0 });
      }
      win.webContents.send('roblox:count', alivePids.size);
      enrichTempSessions(temp, alivePids).then(enriched => {
        if (win && !win.isDestroyed()) win.webContents.send('roblox:temp', enriched);
      }).catch(() => {});
    }
    _stopWatchPollIfIdle();
  });
}

function closeSingletonHandlesOnly() {
  return ensureNativeHelper().then((nativeExe) => new Promise((resolve) => {
    if (!nativeExe) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const proc = spawn(nativeExe, ['closehandles'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      if (proc.stdout) proc.stdout.on('data', d => { if (d.toString().includes('HANDLES_DONE')) finish(); });
      if (proc.stderr) proc.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[closehandles]', s); });
      proc.on('exit', finish);
      proc.on('error', finish);
      setTimeout(finish, 4000);
    } catch { finish(); }
  }));
}

async function closeSingletonAndHoldMutex() {
  if (process.platform === 'win32') await startMutexHolder();
  
  
  await closeSingletonHandlesOnly();
}

async function _doLaunch(accountId, cookie, target, versionHash, options) {
  try {
    const launchGeneration = (_launchGenerations.get(accountId) || 0) + 1;
    _launchGenerations.set(accountId, launchGeneration);
    _watchGenerations.delete(accountId);

    
    
    const oldVolumeTimer = _launchVolumeTimers.get(accountId);
    if (oldVolumeTimer) clearTimeout(oldVolumeTimer);
    _launchVolumeTimers.delete(accountId);
    _launchVolumeGenerations.set(accountId, (_launchVolumeGenerations.get(accountId) || 0) + 1);
    const csrfToken = await getCSRFToken(cookie);
    if (!csrfToken) {
      const fa = (loadAccounts().find(a => a.id === accountId) || {});
      sendLog('err', 'launch', `Launch failed for ${fa.username || accountId}: could not get CSRF token (cookie may be expired)`, { accountId, username: fa.username || null });
      return { success: false, error: 'Failed to get CSRF token. Is the account cookie still valid?' };
    }

    const ticketResult = await getAuthTicket(cookie, csrfToken);
    if (!ticketResult.ok) {
      const fa2 = (loadAccounts().find(a => a.id === accountId) || {});
      sendLog('err', 'launch', `Launch failed for ${fa2.username || accountId}: auth ticket error - ${ticketResult.error}`, { accountId, username: fa2.username || null });
      return { success: false, error: `Failed to get auth ticket: ${ticketResult.error}` };
    }
    const { ticket } = ticketResult;

    const t = (target || '').trim();
    let launcherUrl = '';

    if (t) {
      if (/^\d+$/.test(t)) {
        launcherUrl = `https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId=${t}&isPlayTogetherGame=false`;
      } else {
        let rawUrl = t.startsWith('http') ? t : 'https://' + t;

        try {
          const parsed0 = new URL(rawUrl);
          if (parsed0.hostname === 'ro.blox.com' || parsed0.hostname.endsWith('.ro.blox.com')) {
            rawUrl = await followRedirect(rawUrl);
          }
        } catch {}

        let parsedUrl;
        try { parsedUrl = new URL(rawUrl); } catch {}

        if (parsedUrl) {
          const privateCode = parsedUrl.searchParams.get('privateServerLinkCode');
          const shareCode = parsedUrl.searchParams.get('code');
          const shareType = parsedUrl.searchParams.get('type');
          const placeId = parsedUrl.pathname.match(/\/games\/(\d+)/)?.[1]
            || parsedUrl.pathname.match(/\/(\d+)/)?.[1];

          if (privateCode && placeId) {
            const accessCode = await getAccessCode(placeId, privateCode, cookie, csrfToken);
            if (!accessCode) return { success: false, error: 'Could not resolve private server access code. The link may be expired or you may not have permission.' };
            launcherUrl = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestPrivateGame&placeId=${placeId}&accessCode=${accessCode}&linkCode=${privateCode}`;

          } else if (parsedUrl.pathname === '/share' || (shareCode && shareType)) {
            const code = shareCode;
            if (!code) return { success: false, error: 'Invalid share link -- no code found.' };
            const resolved = await resolveShareLink(code, cookie, csrfToken);
            if (!resolved.ok) return { success: false, error: resolved.error || 'Could not resolve share link. It may be expired or invalid.' };
            launcherUrl = `https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGameJob&placeId=${resolved.placeId}&isPlayTogetherGame=false&linkCode=${resolved.linkCode}`;

          } else if (placeId) {
            launcherUrl = `https://assetgame.roblox.com/game/placelauncher.ashx?request=RequestGame&placeId=${placeId}&isPlayTogetherGame=false`;

          } else {
            return { success: false, error: 'Could not find a Place ID in the URL.' };
          }
        } else {
          return { success: false, error: 'Unrecognised input. Enter a place ID, game URL, or private server link.' };
        }
      }
    }

    const launchTime = Date.now();
    const browserId = String(Math.floor(Math.random() * 9e12 + 1e12));
    let robloxUri;
    if (launcherUrl) {
      robloxUri = `roblox-player:1+launchmode:play+gameinfo:${ticket}+launchtime:${launchTime}+placelauncherurl:${encodeURIComponent(launcherUrl)}+browsertrackerid:${browserId}+robloxLocale:en_us+gameLocale:en_us`;
    } else {
      robloxUri = `roblox-player:1+launchmode:app+gameinfo:${ticket}+launchtime:${launchTime}+browsertrackerid:${browserId}+robloxLocale:en_us+gameLocale:en_us`;
    }

    
    let robloxExe = null;
    if (versionHash && versionHash !== 'auto') {
      const installed = getInstalledRobloxVersions();
      const targetVer = installed.find(x => x.hash === versionHash);
      if (targetVer && isCompleteRobloxVersion(targetVer.dir)) {
        robloxExe = targetVer.exe;
      }
    }
    if (!robloxExe) {
      try {
        const latest = getLatestRobloxVersionDir();
        if (latest) robloxExe = latest.exe;
      } catch {}
    }

    applyLaunchPerformanceSettings(robloxExe, options);
    const ramLimitMb = normalizeRamLimitMb(options && options.ramLimitMb);
    _accountRamLimits.delete(accountId);
    clearRamLimit(accountId);

    const sinceLastLaunch = Date.now() - _lastLaunchTs;
    if (_lastLaunchTs > 0 && sinceLastLaunch < LAUNCH_STAGGER) {
      await sleep(LAUNCH_STAGGER - sinceLastLaunch);
    }
    const launchStartedAt = Date.now();
    let launchedPid = null;
    if (robloxExe && fs.existsSync(robloxExe)) {
      await closeSingletonAndHoldMutex();
      const robloxCwd = path.dirname(robloxExe);
      let child;
      let ramHelperProc = null;
      let ramLimitedPid = null;
      if (ramLimitMb !== null && process.platform === 'win32') {
        const nativeExe = await ensureNativeHelper();
        if (!nativeExe) {
          return { success: false, error: 'Could not enforce the RAM limit because the native helper is unavailable.' };
        }
        const limited = await spawnRamLimitedRoblox(nativeExe, robloxExe, robloxCwd, robloxUri, ramLimitMb);
        if (!limited.ok) {
          return { success: false, error: limited.error };
        }
        child = limited.helper;
        ramHelperProc = limited.helper;
        ramLimitedPid = limited.pid;
        sendLog('ok', 'performance', `RAM limit enforced before startup at ${ramLimitMb} MB (PID ${ramLimitedPid})`, { accountId, ramLimitMb, pid: ramLimitedPid });
      } else {
        try {
          child = spawn(robloxExe, [robloxUri], {
            cwd: robloxCwd,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (e) {
          return { success: false, error: `Could not start Roblox: ${e.message}` };
        }
        const spawnFailure = await new Promise(resolve => {
          let settled = false;
          let timeout = null;
          const finish = value => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            resolve(value);
          };
          child.once('spawn', () => finish(null));
          child.once('error', err => finish(err));
          
          
          timeout = setTimeout(() => finish(null), 10000);
        });
        if (spawnFailure) {
          return { success: false, error: `Could not start Roblox: ${spawnFailure.message}` };
        }
      }
      if (child && (ramLimitedPid || child.pid)) {
        launchedPid = ramLimitedPid || child.pid;
        if (_launchGenerations.get(accountId) !== launchGeneration) {
          try { spawn('cmd', ['/c', `taskkill /F /PID ${launchedPid} /T`], { windowsHide: true, stdio: 'ignore' }); } catch {}
          if (ramHelperProc) { try { ramHelperProc.kill(); } catch {} }
          return { success: false, cancelled: true, error: 'Launch cancelled' };
        }
        _accountPids.set(accountId, launchedPid);
        _launchTimes.set(accountId, launchStartedAt);
        if (ramLimitMb !== null) {
          _accountRamLimits.set(accountId, ramLimitMb);
          if (ramHelperProc) {
            _ramLimitProcs.set(accountId, ramHelperProc);
            ramHelperProc.on('exit', code => {
              if (_ramLimitProcs.get(accountId) === ramHelperProc) {
                _ramLimitProcs.delete(accountId);
                if (_launchGenerations.get(accountId) === launchGeneration && _accountPids.get(accountId) === launchedPid) {
                  sendLog('warn', 'performance', `RAM limit helper exited; Roblox may no longer be capped (code ${code})`, { accountId, ramLimitMb, pid: launchedPid });
                }
              }
            });
          } else {
            enforceRamLimitForAccount(accountId, launchedPid, ramLimitMb, launchStartedAt, launchGeneration);
          }
        }
      }
      child.unref();      } else {
        return { success: false, error: 'No complete Roblox player installation found. Install a fresh version from the RDD tab first.' };
      }

      _lastLaunchTs = Date.now();
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    const acct = accounts[idx] || {};
    if (idx !== -1) { accounts[idx].lastUsed = new Date().toISOString(); saveAccounts(accounts); }

    sendLog('ok', 'launch', `Launched Roblox for ${acct.username || accountId}`, {
      accountId, username: acct.username || null, userId: acct.userId || null,
      target: (target || '').trim() || 'Roblox home', pid: _accountPids.get(accountId) || null
    });

    _watchRoblox(accountId, launchGeneration);

    setTimeout(() => {
      try {
        if (!_watchedAccounts.has(accountId)) return; 
        countRobloxProcesses().then((count) => { if (count > 0) hideToTray(); });
      } catch {}
    }, 4000);

    
    
    try {
      const requestedVolume = options && Number.isFinite(options.volume)
        ? Math.max(0, Math.min(100, Math.round(options.volume)))
        : 100;
      scheduleLaunchVolume(accountId, requestedVolume, launchStartedAt, launchedPid);
    } catch {}

    return { success: true, pid: launchedPid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}




let _swapBypassRunning = false;



function emitSwapLog(level, message) {
  if (win && !win.isDestroyed()) win.webContents.send('swap:log', { level, message, timestamp: Date.now() });
  const mapped = level === 'success' ? 'ok' : level === 'error' ? 'err' : level; 
  sendLog(mapped, 'swap', message);
}
function emitSwapStatus(status, progress) {
  if (win && !win.isDestroyed()) win.webContents.send('swap:status', { status, progress });
}

async function swapPathExists(targetPath) {
  try { await fsPromises.access(targetPath, fs.constants.F_OK); return true; } catch { return false; }
}

async function swapCollectFiles(rootDir, filenameMatcher, maxDepth = 5, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  if (!(await swapPathExists(rootDir))) return [];
  const collected = [];
  let entries = [];
  try { entries = await fsPromises.readdir(rootDir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && filenameMatcher.test(entry.name)) { collected.push(fullPath); continue; }
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const nested = await swapCollectFiles(fullPath, filenameMatcher, maxDepth, currentDepth + 1);
      if (nested.length) collected.push(...nested);
    }
  }
  return collected;
}

async function swapBackupFiles(pathsToBackup) {
  const backups = [];
  for (const filePath of pathsToBackup) {
    try { backups.push({ filePath, data: await fsPromises.readFile(filePath) }); } catch {}
  }
  return backups;
}

async function swapRestoreBackups(backups, successLabel) {
  for (const file of backups) {
    try {
      await fsPromises.mkdir(path.dirname(file.filePath), { recursive: true });
      await fsPromises.writeFile(file.filePath, file.data);
      emitSwapLog('success', `${successLabel}: ${path.basename(file.filePath)}`);
    } catch (error) {
      emitSwapLog('warn', `Failed to restore ${path.basename(file.filePath)}: ${error.message}`);
    }
  }
}

async function swapRemoveDirectory(targetPath, label) {
  try {
    if (!(await swapPathExists(targetPath))) { emitSwapLog('info', `${label} already clean`); return false; }
    await fsPromises.rm(targetPath, { recursive: true, force: true });
    emitSwapLog('success', `${label} removed`);
    return true;
  } catch (error) {
    emitSwapLog('warn', `Failed to remove ${label}: ${error.message}`);
    return false;
  }
}

async function swapTerminateRoblox() {
  if (process.platform !== 'win32') { emitSwapLog('warn', 'Process termination step skipped (Windows only)'); return; }
  const processNames = ['RobloxPlayerBeta.exe', 'RobloxPlayerLauncher.exe', 'RobloxStudioBeta.exe', 'RobloxCrashHandler.exe', 'RobloxNative.exe', 'RobloxPlayerBeta'];
  let terminatedAny = false;
  for (const name of processNames) {
    try {
      await execFileAsync('taskkill', ['/IM', name, '/F']);
      emitSwapLog('success', `Terminated ${name}`);
      terminatedAny = true;
    } catch (error) {
      if (error.code === 'ENOENT') { emitSwapLog('warn', 'taskkill unavailable; skipping process termination step'); return; }
      const stderr = error?.stderr || '';
      if (!stderr.includes('not found') && !stderr.includes('No tasks are running')) {
        emitSwapLog('warn', `Unable to terminate ${name}: ${error.message}`);
      }
    }
  }
  if (!terminatedAny) emitSwapLog('info', 'No Roblox processes were running');
}

async function swapCleanLaunchers(localAppData) {
  const launchers = ['Fishstrap', 'Bloxstrap', 'Voidstrap'];
  const subFolders = ['Logs', 'Downloads'];
  let detected = false;
  for (const launcherName of launchers) {
    const launcherRoot = path.join(localAppData, launcherName);
    if (!(await swapPathExists(launcherRoot))) continue;
    detected = true;
    emitSwapLog('info', `Detected ${launcherName} installation`);
    for (const folderName of subFolders) {
      await swapRemoveDirectory(path.join(launcherRoot, folderName), `${launcherName} / ${folderName}`);
    }
  }
  if (!detected) emitSwapLog('info', 'No Fishstrap/Bloxstrap/Voidstrap folders detected');
}

async function swapDeletePrefetch() {
  const systemRoot = process.env.SystemRoot || 'C:/Windows';
  const prefetchDir = path.join(systemRoot, 'Prefetch');
  if (!(await swapPathExists(prefetchDir))) { emitSwapLog('warn', 'Prefetch directory not accessible, skipping'); return; }
  try {
    const entries = await fsPromises.readdir(prefetchDir);
    const targets = entries.filter((f) =>
      (f.startsWith('ROBLOXCRASHHANDLER.EXE-') || f.startsWith('ROBLOXPLAYERBETA.EXE-')) && f.toUpperCase().endsWith('.PF'));
    if (targets.length === 0) { emitSwapLog('info', 'No Roblox prefetch files detected'); return; }
    await Promise.all(targets.map(async (fileName) => {
      try { await fsPromises.rm(path.join(prefetchDir, fileName), { force: true }); emitSwapLog('success', `Deleted Prefetch ${fileName}`); }
      catch (error) { emitSwapLog('warn', `Failed to delete Prefetch ${fileName}: ${error.message}`); }
    }));
  } catch (error) {
    emitSwapLog('warn', `Unable to enumerate prefetch: ${error.message}`);
  }
}

async function swapDeleteRegistryKey() {
  try {
    await execFileAsync('reg', ['delete', 'HKCU\\Software\\ROBLOX Corporation', '/f']);
    emitSwapLog('success', 'Removed Roblox registry keys');
  } catch (error) {
    if (error.code === 1) emitSwapLog('info', 'Registry keys already absent');
    else emitSwapLog('warn', `Failed to delete registry key: ${error.message}`);
  }
}

async function swapCleanRoaming() {
  const appData = process.env.APPDATA;
  if (!appData) { emitSwapLog('warn', 'APPDATA environment variable missing'); return; }
  const base = path.join(appData, 'Roblox');
  if (!(await swapPathExists(base))) { emitSwapLog('info', 'Roaming/Roblox not found'); return; }
  for (const folder of ['logs', 'http']) {
    await swapRemoveDirectory(path.join(base, folder), `Roaming Roblox / ${folder}`);
  }
}

async function swapCleanTemp() {
  const tempRoot = process.env.TEMP || os.tmpdir();
  await swapRemoveDirectory(path.join(tempRoot, 'Roblox'), 'Temp Roblox cache');
  await swapRemoveDirectory(path.join(tempRoot, 'RobloxLogs'), 'Temp RobloxLogs cache');
  try {
    const entries = await fsPromises.readdir(tempRoot, { withFileTypes: true });
    const matches = entries.filter((e) => e.isDirectory() && e.name.startsWith('Roblox'));
    if (matches.length === 0) { emitSwapLog('info', 'No additional Roblox temp directories detected'); return; }
    for (const match of matches) await swapRemoveDirectory(path.join(tempRoot, match.name), `Temp ${match.name}`);
  } catch (error) {
    emitSwapLog('warn', `Unable to clear temp: ${error.message}`);
  }
}

async function swapRemoveProgramData() {
  const programData = process.env.PROGRAMDATA;
  if (!programData) { emitSwapLog('warn', 'PROGRAMDATA environment variable missing'); return; }
  await swapRemoveDirectory(path.join(programData, 'Roblox'), 'ProgramData Roblox');
}



async function runSwapCleaner(opts = {}) {
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA environment variable is not defined');

  const preserveSettings = opts.preserveSettings !== false;
  const preserveFastflags = opts.preserveFastflags === true;
  const deleteStudio = opts.deleteStudio === true;
  const purgeAuth = opts.purgeAuth !== false;

  emitSwapLog('info', 'Starting Roblox trace clean…');

  let preservedSettingsFiles = [];
  let preservedFastflagFiles = [];

  if (preserveSettings) {
    const settingsRoots = [path.join(localAppData, 'Roblox')];
    if (appData) settingsRoots.push(path.join(appData, 'Roblox'));
    let settingsPaths = [];
    for (const root of settingsRoots) {
      const found = await swapCollectFiles(root, /^GlobalBasicSettings_\d+\.xml$/i, 6);
      if (found.length) settingsPaths.push(...found);
    }
    preservedSettingsFiles = await swapBackupFiles(Array.from(new Set(settingsPaths)));
    emitSwapLog('info', preservedSettingsFiles.length ? `Backed up ${preservedSettingsFiles.length} GlobalBasicSettings file(s)` : 'No GlobalBasicSettings files found to preserve');
  }

  if (preserveFastflags) {
    const launcherRoots = [
      path.join(localAppData, 'Bloxstrap'),
      path.join(localAppData, 'Fishstrap'),
      path.join(localAppData, 'Voidstrap'),
    ];
    let fastflagPaths = [];
    for (const root of launcherRoots) {
      const found = await swapCollectFiles(root, /^Client(Settings|AppSettings)\.json$/i, 6);
      if (found.length) fastflagPaths.push(...found);
    }
    preservedFastflagFiles = await swapBackupFiles(Array.from(new Set(fastflagPaths)));
    emitSwapLog('info', preservedFastflagFiles.length ? `Backed up ${preservedFastflagFiles.length} fastflag file(s)` : 'No fastflag files found to preserve');
  }

  emitSwapStatus('terminating Roblox processes', 5);
  await swapTerminateRoblox();

  emitSwapStatus('waiting for Roblox', 5);
  await sleep(2000);

  emitSwapStatus('detecting launchers', 15);
  await swapCleanLaunchers(localAppData);

  emitSwapStatus('purging Roblox install', 35);
  const targetLocalRoblox = path.join(localAppData, 'Roblox');
  if (!deleteStudio) {
    const versionsPath = path.join(targetLocalRoblox, 'Versions');
    if (await swapPathExists(versionsPath)) {
      try {
        const entries = await fsPromises.readdir(versionsPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const vf = path.join(versionsPath, entry.name);
          const hasStudio = await swapPathExists(path.join(vf, 'RobloxStudioBeta.exe'));
          if (hasStudio) emitSwapLog('info', `Skipping Studio dir ${entry.name}`);
          else await swapRemoveDirectory(vf, `Roblox Version ${entry.name}`);
        }
        await swapRemoveDirectory(path.join(targetLocalRoblox, 'Downloads'), 'Roblox Downloads');
        await swapRemoveDirectory(path.join(targetLocalRoblox, 'Logs'), 'Roblox Logs');
      } catch {}
    }
  } else {
    await swapRemoveDirectory(targetLocalRoblox, 'Roblox install folder');
  }

  const studioLauncherRoots = [
    path.join(localAppData, 'Bloxstrap', 'Versions'),
    path.join(localAppData, 'Fishstrap', 'Versions'),
    path.join(localAppData, 'Voidstrap', 'Versions'),
  ];
  for (const lbRoot of studioLauncherRoots) {
    if (!(await swapPathExists(lbRoot))) continue;
    if (!deleteStudio) {
      try {
        const entries = await fsPromises.readdir(lbRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const vf = path.join(lbRoot, entry.name);
          const hasStudio = await swapPathExists(path.join(vf, 'RobloxStudioBeta.exe'));
          if (hasStudio) emitSwapLog('info', `Skipping Studio install in ${lbRoot}`);
          else await swapRemoveDirectory(vf, `Launcher Version ${entry.name}`);
        }
      } catch {}
    } else {
      await swapRemoveDirectory(lbRoot, 'Launcher Versions');
    }
  }

  for (const pfEnv of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[pfEnv];
    if (!base) continue;
    const targetPF = path.join(base, 'Roblox');
    if (!deleteStudio) {
      const versionsPath = path.join(targetPF, 'Versions');
      if (await swapPathExists(versionsPath)) {
        try {
          const entries = await fsPromises.readdir(versionsPath, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const vf = path.join(versionsPath, entry.name);
            const hasStudio = await swapPathExists(path.join(vf, 'RobloxStudioBeta.exe'));
            if (!hasStudio) await swapRemoveDirectory(vf, `${pfEnv} Version ${entry.name}`);
          }
        } catch {}
      }
    } else {
      await swapRemoveDirectory(targetPF, `${pfEnv} Roblox`);
    }
  }

  emitSwapStatus('cleaning Roaming cache', 45);
  await swapCleanRoaming();

  emitSwapStatus('clearing Prefetch cache', 60);
  await swapDeletePrefetch();

  emitSwapStatus('removing registry keys', 75);
  await swapDeleteRegistryKey();

  emitSwapStatus('clearing temp cache', 88);
  await swapCleanTemp();

  emitSwapStatus('cleaning ProgramData', 94);
  await swapRemoveProgramData();

  if (purgeAuth) {
    emitSwapStatus('purging auth tokens & telemetry', 97);
    try {
      const purge = await hwid.purgeRobloxTraces();
      emitSwapLog('success', `Cleared ${purge.files} local token/log file(s)`);
      for (const r of purge.registry || []) emitSwapLog(r.deleted ? 'success' : 'info', r.deleted ? `Removed ${r.key}` : `${r.key} already absent`);
      for (const err of purge.errors || []) emitSwapLog('warn', err);
    } catch (e) {
      emitSwapLog('warn', `Trace purge failed: ${e.message}`);
    }
  }

  if (preserveSettings && preservedSettingsFiles.length) await swapRestoreBackups(preservedSettingsFiles, 'Restored settings file');
  if (preserveFastflags && preservedFastflagFiles.length) await swapRestoreBackups(preservedFastflagFiles, 'Restored fastflags file');

  emitSwapStatus('complete', 100);
  emitSwapLog('success', 'Trace clean complete');
}

ipcMain.handle('swap:run', async (_event, opts) => {
  if (_swapBypassRunning) { emitSwapLog('warn', 'Clean already running'); return { success: false, reason: 'busy' }; }
  _swapBypassRunning = true;
  emitSwapStatus('starting', 0);
  try {
    await runSwapCleaner(opts || {});
    if (win && !win.isDestroyed()) win.webContents.send('swap:complete', { success: true });
    return { success: true };
  } catch (error) {
    emitSwapLog('error', error.message || 'Unexpected failure');
    emitSwapStatus('error', 100);
    if (win && !win.isDestroyed()) win.webContents.send('swap:complete', { success: false, message: error.message });
    return { success: false, message: error.message };
  } finally {
    _swapBypassRunning = false;
  }
});

ipcMain.handle('mac:getAdapters', async () => {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $a = @(Get-NetAdapter -Physical | Where-Object { $_.MacAddress })
    if ($a.Count -eq 0) {
      $a = @(Get-NetAdapter | Where-Object { $_.MacAddress -and $_.InterfaceDescription -notmatch 'Loopback|Teredo|ISATAP|Tunnel|WAN Miniport|Kernel Debug' })
    }
    ConvertTo-Json -InputObject @($a | Select-Object Name, InterfaceDescription, MacAddress, Status) -Compress
  `;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
});

ipcMain.handle('mac:spoof', async (_e, adapterDesc, newMac) => {
  const script = `
    $adapters = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0*" -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc -eq '${String(adapterDesc).replace(/'/g, "''")}' }
    if ($adapters) {
      $path = $adapters[0].PSPath
      Set-ItemProperty -Path $path -Name "NetworkAddress" -Value "${String(newMac).replace(/-/g, '')}" -ErrorAction Stop
      Write-Output "SUCCESS"
    } else {
      Write-Output "NOT_FOUND"
    }
  `;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    return stdout.trim() === 'SUCCESS';
  } catch {
    return false;
  }
});

ipcMain.handle('mac:reset', async (_e, adapterDesc) => {
  const script = `
    $adapters = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0*" -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc -eq '${String(adapterDesc).replace(/'/g, "''")}' }
    if ($adapters) {
      $path = $adapters[0].PSPath
      Remove-ItemProperty -Path $path -Name "NetworkAddress" -ErrorAction SilentlyContinue
      Write-Output "SUCCESS"
    } else {
      Write-Output "NOT_FOUND"
    }
  `;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    return stdout.trim() === 'SUCCESS';
  } catch {
    return false;
  }
});

ipcMain.handle('mac:restartAdapter', async (_e, adapterName) => {
  const script = `
    Disable-NetAdapter -Name '${String(adapterName).replace(/'/g, "''")}' -Confirm:$false -ErrorAction Continue
    Enable-NetAdapter -Name '${String(adapterName).replace(/'/g, "''")}' -Confirm:$false -ErrorAction Continue
    Write-Output "SUCCESS"
  `;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
    return stdout.trim() === 'SUCCESS';
  } catch {
    return false;
  }
});

ipcMain.handle('mac:dhcpRefresh', async () => {
  try { await execFileAsync('ipconfig', ['/release']); await execFileAsync('ipconfig', ['/renew']); return true; }
  catch { return false; }
});

ipcMain.handle('hwid:isElevated', () => hwid.isElevated());
ipcMain.handle('hwid:detectAnticheat', async () => { try { return await hwid.detectAnticheats(); } catch { return []; } });
ipcMain.handle('hwid:restorePoint', async (_e, desc) => {
  try { return await hwid.createSystemRestorePoint(desc || 'rbxSWAP pre-spoof'); }
  catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('hwid:backupExists', () => hwid.backupExists());
ipcMain.handle('hwid:backupInfo', () => hwid.backupInfo());
ipcMain.handle('hwid:backup', async () => {
  try { const { created } = await hwid.createBackup(); return { success: true, created }; }
  catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle('hwid:spoof', async (_e, opts) => {
  try { const results = await hwid.spoofIdentifiers(opts || {}); return { success: results.some(r => r.ok), results }; }
  catch (error) { return { success: false, message: error.message }; }
});
ipcMain.handle('hwid:restore', async (_e, opts) => {
  try { return await hwid.restoreIdentifiers(opts || {}); }
  catch (error) { return { ok: false, reason: error.message }; }
});
ipcMain.handle('hwid:purgeRoblox', async () => {
  try { return { success: true, ...(await hwid.purgeRobloxTraces()) }; }
  catch (error) { return { success: false, message: error.message }; }
});






const RDD_PLAYER_PKG_ROOTS = {
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
};

function httpsGetBinary(url, onChunk) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': CHROME_UA, 'Accept': '*/*' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGetBinary(new URL(res.headers.location, url).href, onChunk).then(resolve, () => resolve({ status: 0, body: null, headers: {} }));
        return;
      }
      
      
      const totalBytes = Number(res.headers['content-length']) || 0;
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (onChunk) try { onChunk(c.length, totalBytes); } catch {} });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', () => resolve({ status: 0, body: null, headers: {} }));
    req.setTimeout(120000, () => { req.destroy(); resolve({ status: 0, body: null, headers: {} }); });
  });
}


function sendRddProgress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('rdd:download-progress', payload);
}

function expandArchiveViaPowerShell(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`], { windowsHide: true });
    ps.on('error', () => reject(new Error(`Could not extract ${path.basename(zipPath)}`)));
    ps.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed for ${path.basename(zipPath)} (code ${code})`)));
  });
}

function extractZipArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    let fellBack = false;
    const finish = (fn, arg) => { if (!fellBack) { fellBack = true; fn(arg); } };
    let tar;
    try {
      tar = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    } catch {
      finish(() => expandArchiveViaPowerShell(zipPath, destDir).then(resolve, reject));
      return;
    }
    tar.on('error', () => finish(() => expandArchiveViaPowerShell(zipPath, destDir).then(resolve, reject)));
    tar.on('close', (code) => {
      if (code === 0) finish(resolve);
      else finish(() => expandArchiveViaPowerShell(zipPath, destDir).then(resolve, reject));
    });
  });
}




async function installRobloxVersionFromRobloxDeployment(versionHash, log) {
  const version = normalizeRobloxVersionHash(versionHash);
  const hosts = [
    'https://setup.rbxcdn.com/',
    'https://setup-aws.rbxcdn.com/',
    'https://setup-ak.rbxcdn.com/',
    'https://setup.rbxcdn.com/channel/common/',
    'https://setup-aws.rbxcdn.com/channel/common/',
    'https://setup.rbxcdn.com/channel/zlive/',
    'https://setup-aws.rbxcdn.com/channel/zlive/'
  ];
  const baseDir = getCustomRobloxVersionsDir();
  const targetDir = path.join(baseDir, version);
  const tmpBase = path.join(baseDir, '.rdd-tmp-' + Date.now());
  fs.mkdirSync(tmpBase, { recursive: true });
  try {
    let manifest = null, versionPath = '';
    for (const h of hosts) {
      const vPath = `${h}${version}-`;
      const r = await httpsGetBinary(vPath + 'rbxPkgManifest.txt');
      if (r.status === 200 && r.body && r.body.length) {
        const text = r.body.toString('utf8');
        if (text.trimStart().startsWith('v0')) { manifest = text; versionPath = vPath; break; }
      }
    }
    if (!manifest) {
      sendRddProgress({ status: 'error', version, label: 'Manifest not found on CDN' });
      throw new Error(`Could not fetch the deployment manifest for ${version}`);
    }
    const lines = manifest.split('\n').map((l) => l.trim());
    if (!lines.includes('RobloxApp.zip')) throw new Error('Manifest is not a Windows player deployment');
    const packages = lines.filter((l) => l.endsWith('.zip'));

    fs.mkdirSync(targetDir, { recursive: true });
    
    const appSettings = '<?xml version="1.0" encoding="UTF-8"?>\n<Settings>\n\t<ContentFolder>content</ContentFolder>\n\t<BaseUrl>http://www.roblox.com</BaseUrl>\n</Settings>\n';
    fs.writeFileSync(path.join(targetDir, 'AppSettings.xml'), appSettings);

    sendRddProgress({ status: 'downloading', version, packageIndex: 0, packageCount: packages.length, percent: 0, label: `Fetching manifest \u2022 ${version}` });
    let done = 0;
    for (const pkg of packages) {
      if (log) log(`Downloading ${pkg} (${done + 1}/${packages.length})\u2026`);
      let got = 0;
      const buf = await httpsGetBinary(versionPath + pkg, (n, totalBytes) => {
        got += n;
        const frac = totalBytes > 0 ? got / totalBytes : 0;
        const overall = (done + Math.max(0.02, Math.min(0.98, frac))) / packages.length;
        sendRddProgress({
          status: 'downloading', version,
          packageIndex: done + 1, packageCount: packages.length,
          percent: Math.round(overall * 100),
          label: `${pkg.replace(/\.zip$/, '')} \u2022 ${done + 1}/${packages.length}`
        });
      });
      if (!buf || !buf.length) throw new Error(`Empty package downloaded: ${pkg}`);
      sendRddProgress({ status: 'downloading', version, packageIndex: done + 1, packageCount: packages.length, percent: Math.round(((done + 0.98) / packages.length) * 100), label: `Extracting ${pkg.replace(/\.zip$/, '')}\u2026` });
      const zipTmp = path.join(tmpBase, pkg);
      fs.writeFileSync(zipTmp, buf);
      const exTmp = path.join(tmpBase, 'ex-' + pkg.replace(/\.zip$/, ''));
      fs.mkdirSync(exTmp, { recursive: true });
      await extractZipArchive(zipTmp, exTmp);
      const root = RDD_PLAYER_PKG_ROOTS[pkg] || '';
      const destRoot = path.join(targetDir, root);
      fs.mkdirSync(destRoot, { recursive: true });
      for (const entry of fs.readdirSync(exTmp)) {
        const dest = path.join(destRoot, entry);
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
        fs.renameSync(path.join(exTmp, entry), dest);
      }
      try { fs.rmSync(zipTmp, { force: true }); } catch {}
      try { fs.rmSync(exTmp, { recursive: true, force: true }); } catch {}
      done++;
      sendRddProgress({ status: 'downloading', version, packageIndex: done, packageCount: packages.length, percent: Math.round((done / packages.length) * 100), label: `${done}/${packages.length} packages` });
    }
    if (!isCompleteRobloxVersion(targetDir)) {
      sendRddProgress({ status: 'error', version, label: 'Install incomplete' });
      throw new Error('Install finished but the version folder looks incomplete');
    }
    sendRddProgress({ status: 'done', version, label: `Installed ${version}` });
    return { ok: true };
  } catch (e) {
    sendRddProgress({ status: 'error', version, label: e.message || 'Download failed' });
    throw e;
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  }
}

ipcMain.handle('rdd:saveExtractedBatch', async (_e, versionHash, files) => {
  try {
    const targetDir = path.join(getCustomRobloxVersionsDir(), versionHash);
    fs.mkdirSync(targetDir, { recursive: true });
    if (Array.isArray(files)) {
      for (const f of files) {
        const fullPath = path.join(targetDir, f.relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, Buffer.from(f.base64Data, 'base64'));
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('rdd:saveExtractedFile', async (_e, versionHash, relPath, base64Data) => {
  try {
    const targetDir = path.join(getCustomRobloxVersionsDir(), versionHash);
    const fullPath = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('rdd:getVersion', async (_e, channel, binaryType) => {
  try {
    const ch = (channel || 'LIVE').trim() || 'LIVE';
    const bt = binaryType || 'WindowsPlayer';
    const base = 'https://clientsettingscdn.roblox.com/v2/client-version/' + encodeURIComponent(bt);
    const url = ch.toUpperCase() === 'LIVE' ? base : `${base}/channel/${encodeURIComponent(ch.toLowerCase())}`;
    const r = await httpsGet(url);
    if (r.status !== 200) return { ok: false, error: `HTTP ${r.status}` };
    const d = JSON.parse(r.body);
    return {
      ok: true,
      channel: ch,
      binaryType: bt,
      version: d.version || null,
      versionHash: d.clientVersionUpload || null,
      bootstrapperVersion: d.bootstrapperVersion || null,
      nextVersion: d.nextClientVersionUpload || null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});




ipcMain.handle('weao:versions', async (_e, which) => {
  const kind = ['current', 'future', 'past'].includes(which) ? which : 'current';
  const r = await weaoGet('/api/versions/' + kind);
  if (r.status === 429) return { ok: false, rateLimited: true, error: 'Rate limited by WEAO - wait a moment.' };
  if (r.status !== 200) return { ok: false, error: r.error || `HTTP ${r.status}` };
  try { return { ok: true, kind, data: JSON.parse(r.body) }; }
  catch { return { ok: false, error: 'Failed to parse WEAO response' }; }
});

ipcMain.handle('weao:exploits', async () => {
  const r = await weaoGet('/api/status/exploits');
  if (r.status === 429) return { ok: false, rateLimited: true, error: 'Rate limited by WEAO - wait a moment.' };
  if (r.status !== 200) return { ok: false, error: r.error || `HTTP ${r.status}` };
  try {
    const data = JSON.parse(r.body);
    return { ok: true, data: Array.isArray(data) ? data : [] };
  } catch {
    return { ok: false, error: 'Failed to parse WEAO response' };
  }
});



function fmVersionRoot() {
  const latest = getLatestRobloxVersionDir();
  return latest ? latest.dir : null;
}
function fmSafeJoin(root, rel) {
  const target = path.resolve(root, rel || '');
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) return null; 
  return target;
}

ipcMain.handle('files:versionInfo', () => {
  const root = fmVersionRoot();
  if (!root) return { ok: false, error: 'No Roblox version folder found. Launch Roblox once so it installs.' };
  let disk = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(root);
      disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    }
  } catch {}
  return { ok: true, root, versionHash: path.basename(root), disk };
});

ipcMain.handle('files:list', (_e, rel) => {
  const root = fmVersionRoot();
  if (!root) return { ok: false, error: 'No Roblox version folder found' };
  const dir = fmSafeJoin(root, rel);
  if (!dir) return { ok: false, error: 'Invalid path' };
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true });
    const entries = names.map((d) => {
      const full = path.join(dir, d.name);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      const isDir = d.isDirectory();
      return { name: d.name, isDir, size, mtime, ext: isDir ? '' : path.extname(d.name).slice(1).toLowerCase() };
    });
    entries.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : (a.isDir ? -1 : 1));
    return { ok: true, rel: rel || '', entries };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('files:open', (_e, rel) => {
  const root = fmVersionRoot(); if (!root) return { ok: false };
  const full = fmSafeJoin(root, rel); if (!full) return { ok: false };
  shell.openPath(full);
  return { ok: true };
});

ipcMain.handle('files:reveal', (_e, rel) => {
  const root = fmVersionRoot(); if (!root) return { ok: false };
  const full = fmSafeJoin(root, rel || ''); if (!full) return { ok: false };
  shell.showItemInFolder(full);
  return { ok: true };
});

ipcMain.handle('files:launchRoblox', () => {
  const root = fmVersionRoot();
  if (!root) return { ok: false, error: 'No Roblox version folder found' };
  const exe = process.platform === 'win32'
    ? path.join(root, 'RobloxPlayerBeta.exe')
    : path.join(root, 'RobloxPlayer');
  try {
    if (!fs.existsSync(exe)) return { ok: false, error: 'Roblox player not found in version folder' };
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
