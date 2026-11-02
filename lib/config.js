'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const PLACEHOLDER_TOKEN = 'PASTE_API_TOKEN_HERE';

function configPath() {
  return process.env.JIRA_APP_CONFIG || path.join(ROOT, 'config.json');
}

/**
 * Decrypts a token stored with Windows DPAPI (PowerShell ConvertFrom-SecureString).
 * Only the same Windows user on the same machine can decrypt it. The blob is passed
 * through an environment variable so it never appears on a command line.
 */
function decryptDpapi(blob) {
  if (process.platform !== 'win32') {
    throw new Error('apiTokenDpapi can only be decrypted on Windows by the user who created it. Use apiToken or JIRA_API_TOKEN instead.');
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$s = ConvertTo-SecureString $env:JIRA_APP_DPAPI_BLOB',
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)',
    'try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, JIRA_APP_DPAPI_BLOB: blob },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    const reason = (result.stderr || (result.error && result.error.message) || '').trim();
    throw new Error(`Could not decrypt the stored API token. Run setup.ps1 again. ${reason}`.trim());
  }
  return result.stdout.trim();
}

function readConfigFile(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

/** First non-empty environment variable among `names`. Includes names commonly used by Jira/Atlassian MCP servers. */
function envFirst(...names) {
  for (const n of names) {
    if (process.env[n] && String(process.env[n]).trim()) return { name: n, value: String(process.env[n]).trim() };
  }
  return null;
}

function siteOrigin(raw) {
  try {
    const u = new URL(String(raw).trim());
    return u.origin;
  } catch (e) {
    return String(raw || '').trim().replace(/\/+$/, '');
  }
}

function gitUserEmail() {
  try {
    const res = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8', timeout: 2000 });
    const email = (res.stdout || '').trim();
    if (email && /^[^@\s]+@[^@\s]+$/.test(email)) return email;
  } catch (e) {}
  return '';
}

/**
 * Looks for the Jira credentials that Kiro's Jira MCP server already uses
 * (~/.kiro/settings/mcp.json), so the app can connect without asking.
 * Only reads values locally; nothing is copied or sent anywhere else.
 */
function kiroMcpCredentials() {
  const home = os.homedir();
  const files = [
    process.env.JIRA_APP_MCP_CONFIG,
    path.join(home, '.kiro', 'settings', 'mcp.json'),
    path.join(home, '.kiro', 'mcp.json'),
    path.join(home, '.config', 'kiro', 'mcp.json'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Kiro', 'settings', 'mcp.json') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.kiro', 'settings', 'mcp.json') : null,
    path.join(process.cwd(), '.kiro', 'settings', 'mcp.json'),
  ].filter(Boolean);
  const resolve = (v) => String(v || '').replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] || '').trim();
  const pick = (env, ...names) => {
    for (const n of names) { if (env[n] && resolve(env[n])) return resolve(env[n]); }
    return '';
  };
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, ''));
    } catch (e) {
      continue;
    }
    const servers = (json && (json.mcpServers || json.servers)) || {};
    for (const [name, server] of Object.entries(servers)) {
      if (!server || server.disabled) continue;
      const env = { ...(server.env || {}) };
      // Also accept "--jira-token X" style arguments.
      const args = Array.isArray(server.args) ? server.args : [];
      args.forEach((a, i) => {
        const m = /^--(jira-url|jira-username|jira-token|jira-personal-token)(?:=(.*))?$/.exec(String(a));
        if (m) env[`ARG_${m[1]}`] = m[2] !== undefined ? m[2] : args[i + 1];
      });
      const apiToken = pick(env, 'JIRA_API_TOKEN', 'JIRA_TOKEN', 'ATLASSIAN_API_TOKEN', 'ATLASSIAN_TOKEN', 'CONFLUENCE_API_TOKEN', 'ARG_jira-token');
      const email = pick(env, 'JIRA_USERNAME', 'JIRA_EMAIL', 'JIRA_USER', 'ATLASSIAN_EMAIL', 'ATLASSIAN_USERNAME', 'CONFLUENCE_USERNAME', 'ARG_jira-username');
      const baseUrl = pick(env, 'JIRA_URL', 'JIRA_BASE_URL', 'ATLASSIAN_SITE_URL', 'ATLASSIAN_URL', 'JIRA_HOST', 'ARG_jira-url');
      if (apiToken && email) return { apiToken, email, baseUrl, source: `Kiro MCP server "${name}" (${file})` };
    }
  }
  return null;
}

/** Loads configuration. Environment variables override config.json. */
function loadConfig() {
  const file = configPath();
  const fileCfg = readConfigFile(file);
  const envUrl = envFirst('JIRA_BASE_URL', 'JIRA_URL', 'ATLASSIAN_SITE_URL', 'ATLASSIAN_URL', 'JIRA_HOST');
  const envEmail = envFirst('JIRA_EMAIL', 'JIRA_USERNAME', 'JIRA_USER', 'ATLASSIAN_EMAIL', 'ATLASSIAN_USERNAME');
  const envToken = envFirst('JIRA_API_TOKEN', 'JIRA_TOKEN', 'ATLASSIAN_API_TOKEN', 'ATLASSIAN_TOKEN');

  const defaultBaseUrl = 'https://axismaxlife.atlassian.net';
  const cfg = {
    baseUrl: siteOrigin((envUrl && envUrl.value) || fileCfg.baseUrl || defaultBaseUrl),
    email: String((envEmail && envEmail.value) || fileCfg.email || '').trim(),
    apiToken: String((envToken && envToken.value) || fileCfg.apiToken || '').trim(),
    port: Number(process.env.JIRA_APP_PORT || fileCfg.port || 4777),
    openBrowserOnStart: toBool(process.env.JIRA_APP_OPEN_BROWSER, toBool(fileCfg.openBrowserOnStart, true)),
    defaultJql: String(fileCfg.defaultJql || DEFAULT_JQL),
    configPath: file,
    tokenSource: envToken ? `environment variable ${envToken.name}` : (fileCfg.apiToken ? 'config.json (plain text)' : null),
  };

  if (!cfg.apiToken && fileCfg.apiTokenDpapi) {
    cfg.apiToken = decryptDpapi(String(fileCfg.apiTokenDpapi).trim());
    cfg.tokenSource = 'config.json (Windows-encrypted)';
  }
  if (!cfg.apiToken && process.env.JIRA_APP_NO_MCP !== '1') {
    const mcp = kiroMcpCredentials();
    if (mcp) {
      cfg.apiToken = mcp.apiToken;
      if (!cfg.email) cfg.email = mcp.email;
      if (!cfg.baseUrl && mcp.baseUrl) cfg.baseUrl = siteOrigin(mcp.baseUrl);
      cfg.tokenSource = mcp.source;
    }
  }
  if (!cfg.email) {
    const gitEmail = gitUserEmail();
    if (gitEmail) cfg.email = gitEmail;
  }
  if (!cfg.baseUrl) cfg.baseUrl = defaultBaseUrl;
  return cfg;
}

/** Returns a list of human-readable problems; empty when the config is usable. */
function validateConfig(cfg) {
  const problems = [];
  let url;
  try {
    url = new URL(cfg.baseUrl);
  } catch (err) {
    url = null;
  }
  const isLocalHttp = url && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!url || !(url.protocol === 'https:' || isLocalHttp)) {
    problems.push('baseUrl must be your Jira site, e.g. https://axismaxlife.atlassian.net');
  }
  if (!cfg.email || !/^[^@\s]+@[^@\s]+$/.test(cfg.email)) problems.push('email must be the e-mail address you use to log in to Jira');
  if (!cfg.apiToken || cfg.apiToken === PLACEHOLDER_TOKEN) {
    problems.push('API token is missing. Create one at https://id.atlassian.com/manage-profile/security/api-tokens' + (process.platform === 'win32' ? ' and run setup.ps1' : ', then add it to config.json'));
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) problems.push('port must be a number between 1024 and 65535');
  return problems;
}

/** Encrypts a token with Windows DPAPI (same format as setup.ps1 / ConvertFrom-SecureString). */
function encryptDpapi(token) {
  if (process.platform !== 'win32') throw new Error('Token encryption is only available on Windows.');
  const script = "$ErrorActionPreference = 'Stop'; $s = ConvertTo-SecureString $env:JIRA_APP_PLAIN_TOKEN -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $s))";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, JIRA_APP_PLAIN_TOKEN: token },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    throw new Error(`Could not encrypt the API token. ${(result.stderr || (result.error && result.error.message) || '').trim()}`.trim());
  }
  return result.stdout.trim();
}

/**
 * Saves settings to config.json (merging with existing values). The token is stored
 * encrypted on Windows; elsewhere it is stored as plain text. The file is restricted
 * to the current Windows user.
 */
function saveConfig({ baseUrl, email, apiToken, port, openBrowserOnStart, defaultJql }) {
  const file = configPath();
  const existing = readConfigFile(file);
  const next = { ...existing };
  if (baseUrl !== undefined) next.baseUrl = String(baseUrl).trim().replace(/\/+$/, '');
  if (email !== undefined) next.email = String(email).trim();
  if (port !== undefined) next.port = Number(port);
  if (openBrowserOnStart !== undefined) next.openBrowserOnStart = !!openBrowserOnStart;
  if (defaultJql !== undefined) next.defaultJql = String(defaultJql);
  if (apiToken) {
    if (process.platform === 'win32') {
      next.apiTokenDpapi = encryptDpapi(String(apiToken).trim());
      delete next.apiToken;
    } else {
      next.apiToken = String(apiToken).trim();
      delete next.apiTokenDpapi;
    }
  }
  if (!next.port) next.port = 4777;
  if (!next.defaultJql) next.defaultJql = DEFAULT_JQL;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
  if (process.platform === 'win32') {
    const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    if (user) spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, timeout: 15000 });
  }
  return file;
}

/** Non-secret view of the saved settings (for pre-filling the settings form). */
function readPublicConfig() {
  const cfg = readConfigFile(configPath());
  const mcp = kiroMcpCredentials();
  const gitEmail = gitUserEmail();
  return {
    baseUrl: cfg.baseUrl || (mcp && mcp.baseUrl) || 'https://axismaxlife.atlassian.net',
    email: cfg.email || (mcp && mcp.email) || gitEmail || '',
    hasToken: !!(cfg.apiToken || cfg.apiTokenDpapi || (mcp && mcp.apiToken)),
    kiroDetected: !!(mcp && mcp.apiToken),
    port: cfg.port || 4777,
  };
}

module.exports = { loadConfig, validateConfig, configPath, saveConfig, readPublicConfig, kiroMcpCredentials, encryptDpapi, ROOT, DEFAULT_JQL };
