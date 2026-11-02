'use strict';

/**
 * Jira App - desktop shell (Electron).
 *
 *  - Floating window: frameless, optional "always on top", compact widget mode,
 *    remembers size/position, close = hide to tray.
 *  - Tray icon with menu, global shortcut Ctrl+Shift+J to show/hide.
 *  - Desktop notifications when your issues change (assigned / reported / watching).
 *  - Runs the local Jira App server in-process (or reuses one already running).
 *  - First-run / Settings window stores the API token encrypted (Windows DPAPI).
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, Notification, nativeImage, screen,
} = require('electron');

const ROOT_DIR = path.resolve(__dirname, '..');
const IS_MOCK_EARLY = process.argv.includes('--mock') || process.env.JIRA_APP_DESKTOP_MOCK === '1';
if (IS_MOCK_EARLY) {
  app.setPath('userData', path.join(app.getPath('appData'), 'jira-app-mock'));
  process.env.JIRA_APP_DATA_DIR = app.getPath('userData');
}

const ROOT = ROOT_DIR;
const { loadConfig, validateConfig, saveConfig, readPublicConfig } = require(path.join(ROOT, 'lib', 'config'));
const { createApp } = require(path.join(ROOT, 'lib', 'app'));
const { JiraClient } = require(path.join(ROOT, 'lib', 'jira'));
const personal = require(path.join(ROOT, 'lib', 'personal'));

const ASSETS = path.join(__dirname, 'assets');
const SHORTCUT = 'CommandOrControl+Shift+J';
const POLL_MS = 2 * 60 * 1000;
const COMPACT_SIZE = { width: 400, height: 680 };
const FULL_SIZE = { width: 1280, height: 820 };
const IS_MOCK = process.argv.includes('--mock') || process.env.JIRA_APP_DESKTOP_MOCK === '1';

let mainWindow = null;
let setupWindow = null;
let tray = null;
let quitting = false;
let serverHandle = null; // { server } when we host the server
let appUrl = null;
let cfg = null;
let client = null;
let mockJira = null;
let pollTimer = null;
const seenUpdates = new Map(); // key -> updated
let pollSeeded = false;
const recentlyMine = new Map(); // key -> timestamp of my own change

// ---- persisted UI state ------------------------------------------------------
const statePath = () => path.join(app.getPath('userData'), 'window-state.json');
const defaultState = {
  compact: true,
  alwaysOnTop: true,
  notifications: true,
  fullBounds: null,
  compactBounds: null,
  opacity: 1,
  widget: { x: null, y: null, tabX: null, tabY: null, side: 'right', displayId: null, collapsed: false },
};
let uiState = { ...defaultState };
let firstRun = false;

function loadState() {
  firstRun = !fs.existsSync(statePath());
  try {
    uiState = { ...defaultState, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) };
  } catch (err) {
    uiState = { ...defaultState };
  }
  uiState.widget = { ...defaultState.widget, ...(uiState.widget || {}) };
  if (!uiState.widgetMigrated) {
    // The side widget replaces the old "compact" main window.
    uiState.compact = false;
    uiState.alwaysOnTop = false;
    uiState.widgetMigrated = true;
  }
}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify(uiState, null, 2));
    } catch (err) { /* ignore */ }
  }, 300);
}

function boundsVisible(b) {
  if (!b) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 10 && b.y < a.y + a.height - 50;
  });
}

function defaultCompactBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: COMPACT_SIZE.width,
    height: Math.min(COMPACT_SIZE.height, area.height - 40),
    x: area.x + area.width - COMPACT_SIZE.width - 20,
    y: area.y + area.height - Math.min(COMPACT_SIZE.height, area.height - 40) - 20,
  };
}
function defaultFullBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(FULL_SIZE.width, area.width - 40);
  const height = Math.min(FULL_SIZE.height, area.height - 40);
  return { width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2) };
}
function boundsFor(compact) {
  const saved = compact ? uiState.compactBounds : uiState.fullBounds;
  return boundsVisible(saved) ? saved : (compact ? defaultCompactBounds() : defaultFullBounds());
}

// ---- server ------------------------------------------------------------------
function isOurServer(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data).app === 'jira-app'); } catch (e) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function stopBackgroundServer() {
  if (process.platform !== 'win32') return;
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'stop-jira-app.ps1')], { windowsHide: true, timeout: 20000 });
}

async function stopServer() {
  if (serverHandle) {
    await new Promise((r) => serverHandle.server.close(() => r()));
    serverHandle = null;
  }
}

async function startServer() {
  await stopServer();
  if (IS_MOCK && !mockJira) {
    const { startMockJira, EMAIL, TOKEN } = require(path.join(ROOT, 'test', 'mock-jira'));
    mockJira = await startMockJira(0);
    Object.assign(process.env, { JIRA_BASE_URL: `http://127.0.0.1:${mockJira.port}`, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN, JIRA_APP_PORT: process.env.JIRA_APP_PORT || '4797' });
  }
  cfg = loadConfig();
  const problems = validateConfig(cfg);
  if (problems.length) {
    const err = new Error(problems.join('\n'));
    err.notConfigured = true;
    throw err;
  }
  client = new JiraClient(cfg);
  appUrl = `http://127.0.0.1:${cfg.port}/`;

  const handle = createApp(cfg, {
    client,
    onMutation: (keys) => keys.forEach((k) => recentlyMine.set(k, Date.now())),
  });
  await new Promise((resolve, reject) => {
    handle.server.once('error', async (err) => {
      if (err.code === 'EADDRINUSE' && await isOurServer(cfg.port)) {
        // A background instance (auto-start shortcut) is running: replace it so settings
        // changes and notification hooks apply to this process.
        stopBackgroundServer();
        setTimeout(() => {
          handle.server.once('error', reject);
          handle.server.listen(cfg.port, '127.0.0.1', resolve);
        }, 800);
      } else {
        reject(err.code === 'EADDRINUSE' ? new Error(`Port ${cfg.port} is used by another program. Change "port" in config.json.`) : err);
      }
    });
    handle.server.listen(cfg.port, '127.0.0.1', resolve);
  });
  serverHandle = handle;
}

// ---- windows -------------------------------------------------------------------
const iconPath = () => path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon-256.png');

function securePreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: true,
    devTools: !app.isPackaged,
  };
}

function lockDownNavigation(win, allowedOrigin) {
  const allowed = () => (typeof allowedOrigin === 'function' ? allowedOrigin() : allowedOrigin);
  win.webContents.on('will-navigate', (event, url) => {
    let origin = null;
    try { origin = new URL(url).origin; } catch (e) { /* ignore */ }
    if (origin !== allowed()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'notifications'));
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('win:state', {
      compact: uiState.compact,
      alwaysOnTop: uiState.alwaysOnTop,
      notifications: uiState.notifications,
      opacity: uiState.opacity,
      maximized: mainWindow.isMaximized(),
      shortcut: SHORTCUT.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    });
  }
  refreshTrayMenu();
}

function createMainWindow() {
  const bounds = boundsFor(uiState.compact);
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    show: false,
    backgroundColor: '#0b0f19',
    title: 'Jira App',
    icon: iconPath(),
    alwaysOnTop: uiState.alwaysOnTop,
    webPreferences: securePreferences(),
  });
  if (uiState.alwaysOnTop) mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setOpacity(uiState.opacity || 1);
  lockDownNavigation(mainWindow, new URL(appUrl).origin);

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow.show();
    sendState();
  });
  mainWindow.webContents.on('did-finish-load', sendState);

  // Developer aid: electron . --mock --screenshot=out.png [--hash=#/board] [--drawer=KEY] [--widget]
  attachScreenshotAid(mainWindow, null);

  const rememberBounds = () => {
    if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    uiState[uiState.compact ? 'compactBounds' : 'fullBounds'] = mainWindow.getBounds();
    saveState();
  };
  mainWindow.on('moved', rememberBounds);
  mainWindow.on('resized', rememberBounds);
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
      showHideHintOnce();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(appUrl);
}

/**
 * Developer aid (used for automated UI checks):
 *   electron . --mock --screenshot=out.png [--widget] [--hash=#/board] [--drawer=KEY] [--eval-file=test.js]
 * flag === '--widget' attaches to the widget window, null to the main window.
 */
function attachScreenshotAid(win, flag) {
  const shotArg = process.argv.find((a) => a.startsWith('--screenshot='));
  if (!shotArg) return;
  const wantsWidget = process.argv.includes('--widget');
  if ((flag === '--widget') !== wantsWidget) return;
  win.webContents.once('did-finish-load', async () => {
    const hashArg = process.argv.find((a) => a.startsWith('--hash='));
    const drawerArg = process.argv.find((a) => a.startsWith('--drawer='));
    if (hashArg) win.webContents.send('navigate', hashArg.slice(7));
    await new Promise((r) => setTimeout(r, 2500));
    if (drawerArg) {
      await win.webContents.executeJavaScript(`window.JA.openDrawer(${JSON.stringify(drawerArg.slice(9))})`);
      await new Promise((res) => setTimeout(res, 2000));
    }
    const evalArg = process.argv.find((a) => a.startsWith('--eval-file='));
    if (evalArg && IS_MOCK) {
      const result = await win.webContents.executeJavaScript(fs.readFileSync(path.resolve(evalArg.slice(12)), 'utf8'));
      console.log(`[eval] ${JSON.stringify(result)}`);
      await new Promise((res) => setTimeout(res, 800));
    }
    let image = null;
    for (let attempt = 0; attempt < 5 && !image; attempt += 1) {
      try {
        win.show();
        image = await win.webContents.capturePage();
        if (image.isEmpty()) image = null;
      } catch (err) {
        console.log(`[screenshot] capture failed (${err.message}), retrying`);
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (image) fs.writeFileSync(path.resolve(shotArg.slice(13)), image.toPNG());
    console.log(`[screenshot] bounds ${JSON.stringify(win.getBounds())}`);
    quitting = true;
    app.quit();
  });
}

let hintShown = false;
function showHideHintOnce() {
  if (hintShown || !Notification.isSupported()) return;
  hintShown = true;
  new Notification({
    title: 'Jira App is still running',
    body: `It's in the system tray. Press ${SHORTCUT.replace('CommandOrControl', 'Ctrl')} to bring it back.`,
    icon: path.join(ASSETS, 'icon-64.png'),
    silent: true,
  }).show();
}

function showMain(hash) {
  if (!appUrl) { createWidget('setup'); return; }
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (hash) mainWindow.webContents.send('navigate', hash);
}

function toggleMain() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showMain();
}

function setCompact(compact) {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  uiState[uiState.compact ? 'compactBounds' : 'fullBounds'] = mainWindow.getBounds();
  uiState.compact = !!compact;
  mainWindow.setBounds(boundsFor(uiState.compact), true);
  saveState();
  sendState();
}

function setAlwaysOnTop(on) {
  uiState.alwaysOnTop = !!on;
  if (mainWindow) mainWindow.setAlwaysOnTop(uiState.alwaysOnTop, 'floating');
  saveState();
  sendState();
}

function setOpacity(value) {
  const v = Math.min(1, Math.max(0.4, Number(value) || 1));
  uiState.opacity = v;
  if (mainWindow) mainWindow.setOpacity(v);
  saveState();
  sendState();
}

function openSetup(message) {
  if (setupWindow) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Jira App - Settings',
    icon: iconPath(),
    backgroundColor: '#0b0f19',
    autoHideMenuBar: true,
    webPreferences: securePreferences(),
  });
  setupWindow.removeMenu();
  lockDownNavigation(setupWindow, 'file://');
  setupWindow.loadFile(path.join(__dirname, 'setup.html'), { query: { message: message || '' } });
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (!appUrl && !quitting) app.quit();
  });
}

// ---- side widget (phone-style, docked to a screen edge) ----------------------------
let widgetWindow = null;
let widgetPage = null; // 'app' | 'setup'
let snapping = false;
const WIDGET_W = 380;
const TAB_W = 84;
const TAB_H = 158;

function widgetDisplay() {
  const id = uiState.widget.displayId;
  return (id && screen.getAllDisplays().find((d) => d.id === id)) || screen.getPrimaryDisplay();
}

function widgetBounds(collapsed) {
  const area = widgetDisplay().workArea;
  const side = uiState.widget.side === 'left' ? 'left' : 'right';
  const width = collapsed ? TAB_W : WIDGET_W;
  const height = collapsed ? TAB_H : Math.min(780, area.height - 16);

  const minX = area.x;
  const maxX = Math.max(area.x, area.x + area.width - width);
  const minY = area.y;
  const maxY = Math.max(area.y, area.y + area.height - height);

  let x, y;
  if (collapsed) {
    x = Number.isFinite(uiState.widget.tabX)
      ? uiState.widget.tabX
      : (side === 'left' ? area.x : maxX);
    y = Number.isFinite(uiState.widget.tabY)
      ? uiState.widget.tabY
      : area.y + Math.round((area.height - height) / 2);
  } else {
    // Allows moving anywhere on screen while remembering exact position
    x = Number.isFinite(uiState.widget.x)
      ? uiState.widget.x
      : (side === 'left' ? area.x + 12 : maxX - 12);
    y = Number.isFinite(uiState.widget.y)
      ? uiState.widget.y
      : area.y + 12;
  }

  // Strict clamp: never cut off from screen edges
  x = Math.min(Math.max(x, minX), maxX);
  y = Math.min(Math.max(y, minY), maxY);
  return { x, y, width, height };
}

function sendWidgetState() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('widget:state', { collapsed: !!uiState.widget.collapsed, side: uiState.widget.side });
  }
}

function setWidgetCollapsed(collapsed) {
  uiState.widget.collapsed = !!collapsed;
  saveState();
  if (widgetWindow) {
    snapping = true;
    widgetWindow.setBounds(widgetBounds(uiState.widget.collapsed));
    setTimeout(() => { snapping = false; }, 300);
  }
  sendWidgetState();
  refreshTrayMenu();
}

let clampTimer = null;
/** Clamps the widget within screen work area so it can be placed anywhere without cutting off the screen */
function onWidgetMove() {
  if (!widgetWindow || snapping) return;
  const b = widgetWindow.getBounds();
  const display = screen.getDisplayMatching(b);
  const area = display.workArea;

  const width = b.width;
  const height = b.height;
  const minX = area.x;
  const maxX = Math.max(area.x, area.x + area.width - width);
  const minY = area.y;
  const maxY = Math.max(area.y, area.y + area.height - height);

  const clampedX = Math.min(Math.max(b.x, minX), maxX);
  const clampedY = Math.min(Math.max(b.y, minY), maxY);

  uiState.widget.displayId = display.id;
  uiState.widget.side = clampedX + width / 2 < area.x + area.width / 2 ? 'left' : 'right';
  if (uiState.widget.collapsed) {
    uiState.widget.tabX = clampedX;
    uiState.widget.tabY = clampedY;
  } else {
    uiState.widget.x = clampedX;
    uiState.widget.y = clampedY;
  }
  saveState();

  // If outside screen boundaries, clamp back immediately
  if (clampedX !== b.x || clampedY !== b.y) {
    clearTimeout(clampTimer);
    clampTimer = setTimeout(() => {
      if (!widgetWindow || widgetWindow.isDestroyed()) return;
      snapping = true;
      widgetWindow.setBounds({ x: clampedX, y: clampedY, width, height });
      setTimeout(() => { snapping = false; }, 150);
    }, 60);
  }
  sendWidgetState();
}

function createWidget(page) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    loadWidgetPage(page);
    return;
  }
  widgetWindow = new BrowserWindow({
    ...widgetBounds(page === 'setup' ? false : uiState.widget.collapsed),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Jira App',
    icon: iconPath(),
    webPreferences: securePreferences(),
  });
  widgetWindow.setAlwaysOnTop(true, 'floating');
  lockDownNavigation(widgetWindow, () => (appUrl ? new URL(appUrl).origin : 'null'));
  widgetWindow.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) widgetWindow.show(); });
  widgetWindow.webContents.on('did-finish-load', sendWidgetState);
  widgetWindow.on('moved', onWidgetMove);
  widgetWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      widgetWindow.hide();
      showHideHintOnce();
    }
  });
  widgetWindow.on('closed', () => { widgetWindow = null; });
  screen.on('display-metrics-changed', () => { if (widgetWindow && !snapping) widgetWindow.setBounds(widgetBounds(uiState.widget.collapsed)); });
  loadWidgetPage(page);
  attachScreenshotAid(widgetWindow, '--widget');
}

function loadWidgetPage(page) {
  widgetPage = page;
  if (page === 'setup') {
    snapping = true;
    widgetWindow.setBounds(widgetBounds(false));
    setTimeout(() => { snapping = false; }, 400);
    widgetWindow.loadFile(path.join(__dirname, 'setup.html'), { query: { mode: 'widget' } });
  } else {
    widgetWindow.setBounds(widgetBounds(uiState.widget.collapsed));
    widgetWindow.loadURL(`${appUrl}widget.html`);
  }
}

function showWidget() {
  if (!widgetWindow) { createWidget(appUrl ? 'app' : 'setup'); return; }
  if (uiState.widget.collapsed && widgetPage === 'app') setWidgetCollapsed(false);
  widgetWindow.show();
  widgetWindow.focus();
}

function toggleWidget() {
  if (widgetWindow && widgetWindow.isVisible() && (widgetWindow.isFocused() || uiState.widget.collapsed)) {
    if (uiState.widget.collapsed) setWidgetCollapsed(false); else widgetWindow.hide();
  } else {
    showWidget();
  }
}

// ---- tray ----------------------------------------------------------------------
function loginItemEnabled() {
  try {
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  } catch (e) {
    return false;
  }
}
function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [path.resolve(ROOT)] };
}
function setLoginItem(enabled) {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: !!enabled });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Show side widget', click: () => showWidget() },
    { label: 'Collapse widget to edge', type: 'checkbox', checked: !!uiState.widget.collapsed, enabled: !!appUrl, click: (i) => setWidgetCollapsed(i.checked) },
    { type: 'separator' },
    { label: 'Open full app (tracker)', click: () => showMain('#/home') },
    { label: 'Board', click: () => showMain('#/board') },
    { label: 'Create issue', click: () => showMain('#/create') },
    { type: 'separator' },
    { label: 'Keep full app on top', type: 'checkbox', checked: uiState.alwaysOnTop, click: (i) => setAlwaysOnTop(i.checked) },
    {
      label: 'Full app transparency',
      submenu: [1, 0.95, 0.9, 0.8, 0.7].map((v) => ({ label: `${Math.round(v * 100)}%`, type: 'radio', checked: Math.abs((uiState.opacity || 1) - v) < 0.01, click: () => setOpacity(v) })),
    },
    { label: 'Desktop notifications', type: 'checkbox', checked: uiState.notifications, click: (i) => { uiState.notifications = i.checked; saveState(); sendState(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: loginItemEnabled(), click: (i) => setLoginItem(i.checked) },
    { type: 'separator' },
    { label: 'Open in browser', enabled: !!appUrl, click: () => appUrl && shell.openExternal(appUrl) },
    { label: 'Settings (Jira account)…', click: () => openSetup() },
    { label: 'Open logs folder', click: () => shell.openPath(app.getPath('logs')) },
    { type: 'separator' },
    { label: 'Quit Jira App', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon-32.png'));
  tray = new Tray(img);
  tray.setToolTip('Jira App');
  tray.on('click', toggleWidget);
  tray.on('double-click', () => showMain('#/home'));
  refreshTrayMenu();
}

// ---- notifications --------------------------------------------------------------
const WATCH_JQL = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -30m ORDER BY updated DESC';

async function pollUpdates() {
  if (!client) return;
  try {
    const data = await client.searchJql({ jql: WATCH_JQL, maxResults: 50, fields: ['summary', 'updated', 'status', 'assignee'] });
    const fresh = [];
    for (const issue of data.issues || []) {
      const updated = issue.fields && issue.fields.updated;
      const prev = seenUpdates.get(issue.key);
      if (prev !== updated) {
        seenUpdates.set(issue.key, updated);
        const mine = recentlyMine.get(issue.key);
        if (pollSeeded && !(mine && Date.now() - mine < 5 * 60 * 1000)) fresh.push(issue);
      }
    }
    pollSeeded = true;
    if (uiState.notifications && Notification.isSupported()) {
      fresh.slice(0, 3).forEach((issue) => {
        const f = issue.fields || {};
        const n = new Notification({
          title: `${issue.key} updated`,
          body: `${f.summary || ''}${f.status ? `\nStatus: ${f.status.name}` : ''}`,
          icon: path.join(ASSETS, 'icon-64.png'),
        });
        n.on('click', () => showMain(`#/issue/${issue.key}`));
        n.show();
      });
      if (fresh.length > 3) {
        const n = new Notification({ title: 'Jira App', body: `${fresh.length - 3} more of your issues were updated.`, icon: path.join(ASSETS, 'icon-64.png') });
        n.on('click', () => showMain('#/home'));
        n.show();
      }
    }
    if (tray) {
      const count = await client.approximateCount('assignee = currentUser() AND statusCategory != Done').catch(() => null);
      tray.setToolTip(count && typeof count.count === 'number' ? `Jira App - ${count.count} open issue(s) assigned to you` : 'Jira App');
    }
  } catch (err) {
    if (tray) tray.setToolTip(`Jira App - ${err.message}`.slice(0, 120));
  }
}

function startPolling() {
  clearInterval(pollTimer);
  seenUpdates.clear();
  pollSeeded = false;
  pollUpdates();
  pollTimer = setInterval(pollUpdates, POLL_MS);
}

// ---- personal follow-up reminders (from the "★ Mine" tab) --------------------------
let reminderTimer = null;
function checkReminders() {
  let due = [];
  try { due = personal.dueReminders(); } catch (e) { return; }
  for (const r of due) {
    try { personal.patchIssue(r.key, { reminded: true }); } catch (e) { /* ignore */ }
    if (!Notification.isSupported()) continue;
    const n = new Notification({
      title: `⏰ Follow up: ${r.key}`,
      body: [r.remindNote, r.summary].filter(Boolean).join('\n') || 'Your reminder is due.',
      icon: path.join(ASSETS, 'icon-64.png'),
    });
    n.on('click', () => showMain(`#/issue/${r.key}?tab=mine`));
    n.show();
  }
  if (due.length) {
    if (mainWindow) mainWindow.webContents.send('navigate-refresh');
    if (widgetWindow) widgetWindow.webContents.send('navigate-refresh');
  }
}
function startReminders() {
  clearInterval(reminderTimer);
  checkReminders();
  reminderTimer = setInterval(checkReminders, 30000);
}

// ---- IPC -------------------------------------------------------------------------
function fromMain(event) { return mainWindow && event.sender === mainWindow.webContents; }
function fromWidget(event) { return widgetWindow && event.sender === widgetWindow.webContents; }
function fromSetup(event) {
  return (setupWindow && event.sender === setupWindow.webContents) || (fromWidget(event) && widgetPage === 'setup');
}

function registerIpc() {
  ipcMain.on('widget:ready', (e) => { if (fromWidget(e)) sendWidgetState(); });
  ipcMain.on('widget:collapse', (e, on) => { if (fromWidget(e)) setWidgetCollapsed(on); });
  ipcMain.on('widget:hide', (e) => { if (fromWidget(e)) { widgetWindow.hide(); showHideHintOnce(); } });
  ipcMain.on('widget:open-main', (e, hash) => {
    if (!fromWidget(e)) return;
    const safe = typeof hash === 'string' && /^#\/[\w/?=&%.-]*$/.test(hash) ? hash : '#/home';
    showMain(safe);
  });
  ipcMain.on('win:minimize', (e) => { if (fromMain(e)) mainWindow.minimize(); });
  ipcMain.on('win:hide', (e) => { if (fromMain(e)) { mainWindow.hide(); showHideHintOnce(); } });
  ipcMain.on('win:toggle-maximize', (e) => {
    if (!fromMain(e)) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.on('win:set-pin', (e, on) => { if (fromMain(e)) setAlwaysOnTop(on); });
  ipcMain.on('win:set-compact', (e, on) => { if (fromMain(e)) setCompact(on); });
  ipcMain.on('win:set-opacity', (e, v) => { if (fromMain(e)) setOpacity(v); });
  ipcMain.on('win:get-state', (e) => { if (fromMain(e)) sendState(); });
  ipcMain.on('app:settings', (e) => { if (fromMain(e)) openSetup(); });
  ipcMain.on('app:open-external', (e, url) => {
    if ((fromMain(e) || fromSetup(e)) && typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('setup:get', (e) => (fromSetup(e) ? readPublicConfig() : null));
  ipcMain.handle('setup:save', async (e, form) => {
    if (!fromSetup(e) || !form || typeof form !== 'object') return { ok: false, error: 'Not allowed.' };
    const baseUrl = String(form.baseUrl || '').trim().replace(/\/+$/, '');
    const email = String(form.email || '').trim();
    const token = String(form.apiToken || '').trim();
    if (!/^https:\/\/[^/\s]+$/i.test(baseUrl)) return { ok: false, error: 'Jira site must look like https://yourcompany.atlassian.net' };
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { ok: false, error: 'Enter the e-mail you use to log in to Jira.' };
    const existing = readPublicConfig();
    if (!token && !existing.hasToken) return { ok: false, error: 'Paste your API token.' };
    try {
      // Test before saving, using the new token (or the saved one).
      const testToken = token || loadConfig().apiToken;
      const me = await new JiraClient({ baseUrl, email, apiToken: testToken }).myself();
      saveConfig({ baseUrl, email, apiToken: token || undefined });
      await startServer();
      startPolling();
      if (mainWindow) mainWindow.loadURL(appUrl);
      setTimeout(() => {
        if (setupWindow) setupWindow.close();
        createWidget('app');
        showWidget();
      }, 900);
      return { ok: true, user: me.displayName };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ---- lifecycle ---------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWidget());
  app.setAppUserModelId('com.local.jira-app');

  app.whenReady().then(async () => {
    loadState();
    if (!uiState.autoStartMigrated) {
      // Jira App opens only when you click it. (Auto-start can still be enabled from the tray menu.)
      try { if (!IS_MOCK) setLoginItem(false); } catch (e) { /* ignore */ }
      uiState.autoStartMigrated = true;
    }
    saveState();
    registerIpc();
    createTray();
    startReminders();
    try {
      await startServer();
      startPolling();
      // Clicking the app icon opens only the floating side widget. The full app opens on demand.
      createWidget('app');
      if (process.argv.some((a) => a.startsWith('--screenshot=')) && !process.argv.includes('--widget')) createMainWindow();
    } catch (err) {
      createWidget('setup');
      if (!err.notConfigured) console.error(err.message);
    }
    if (!globalShortcut.register(SHORTCUT, toggleWidget)) {
      console.warn(`Could not register global shortcut ${SHORTCUT} (used by another app).`);
    }
    refreshTrayMenu();
  });

  app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    clearInterval(pollTimer);
    clearInterval(reminderTimer);
    if (serverHandle) serverHandle.server.close();
    if (mockJira) mockJira.server.close();
  });
}
