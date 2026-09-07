'use strict';
// contextBridge surface (ARCHITECTURE.md §8). Runs sandboxed: only `electron` is required, nothing
// from Node. `ipcRenderer` itself is never exposed — each channel gets a dedicated, typed wrapper.

const { contextBridge, ipcRenderer } = require('electron');

// Must match the main-process allowlist (main.js) — the check is enforced on both sides of the bridge.
const ALLOWED_EXTERNAL_HOSTS = ['claude.ai', 'anthropic.com', 'chatgpt.com', 'openai.com', 'github.com'];

function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_EXTERNAL_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch (err) {
    return false;
  }
}

// Subscriptions hand the payload (never the IPC event) to the renderer and return an unsubscribe.
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  // invoke
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', { patch }),
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  getHistory: (days) => ipcRenderer.invoke('get-history', { days }),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  claudeWebLogin: () => ipcRenderer.invoke('claude-web-login'),
  claudeWebLogout: () => ipcRenderer.invoke('claude-web-logout'),
  claudeWebOrgs: () => ipcRenderer.invoke('claude-web-orgs'),
  claudeWebSelectOrg: (id) => ipcRenderer.invoke('claude-web-select-org', { id }),

  // send
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  resizeWindow: (height) => ipcRenderer.send('resize-window', { height }),
  setCompactMode: (compact) => ipcRenderer.send('set-compact-mode', { compact: !!compact }),
  openExternal: (url) => {
    if (isAllowedExternalUrl(url)) {
      ipcRenderer.send('open-external', { url: String(url) });
    } else {
      console.warn('openExternal blocked — URL not in allowlist:', url);
    }
  },

  // on — each returns an unsubscribe function
  onUsageUpdated: (callback) => subscribe('usage-updated', callback),
  onSettingsUpdated: (callback) => subscribe('settings-updated', callback),
  onRefreshRequested: (callback) => subscribe('refresh-requested', callback),
  onClaudeWebSessionExpired: (callback) => subscribe('claude-web-session-expired', callback),
});
