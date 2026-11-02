'use strict';

// Exposes a small, explicit API to the web UI. No Node.js access is given to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('win:minimize'),
  hide: () => ipcRenderer.send('win:hide'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  setPin: (on) => ipcRenderer.send('win:set-pin', !!on),
  setCompact: (on) => ipcRenderer.send('win:set-compact', !!on),
  setOpacity: (v) => ipcRenderer.send('win:set-opacity', Number(v)),
  requestState: () => ipcRenderer.send('win:get-state'),
  openSettings: () => ipcRenderer.send('app:settings'),
  openExternal: (url) => ipcRenderer.send('app:open-external', String(url)),
  onState: (cb) => ipcRenderer.on('win:state', (_e, state) => cb(state)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, hash) => cb(hash)),
  onRefresh: (cb) => ipcRenderer.on('navigate-refresh', () => cb()),
  // Side widget
  openMain: (hash) => ipcRenderer.send('widget:open-main', String(hash || '#/home')),
  widgetCollapse: (on) => ipcRenderer.send('widget:collapse', !!on),
  widgetHide: () => ipcRenderer.send('widget:hide'),
  widgetReady: () => ipcRenderer.send('widget:ready'),
  onWidgetState: (cb) => ipcRenderer.on('widget:state', (_e, state) => cb(state)),
  // Settings window only (main process verifies the sender).
  getSettings: () => ipcRenderer.invoke('setup:get'),
  saveSettings: (form) => ipcRenderer.invoke('setup:save', form),
});
