#!/usr/bin/env node
'use strict';

/**
 * Jira App - local Jira Cloud workspace.
 *
 *   node server.js            start the app (opens the browser if configured)
 *   node server.js --check    verify config + Jira credentials, then exit
 *   node server.js --no-open  start without opening the browser
 */

const http = require('http');
const { spawn } = require('child_process');
const { loadConfig, validateConfig } = require('./lib/config');
const { createApp } = require('./lib/app');
const { JiraClient } = require('./lib/jira');

const args = new Set(process.argv.slice(2));

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch (err) {
    console.log(`Open ${url} in your browser.`);
  }
}

function existingInstance(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).app === 'jira-app'); } catch (err) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }

  const problems = validateConfig(cfg);
  if (args.has('--check')) {
    if (problems.length) {
      console.error(`Jira App is not configured yet (${cfg.configPath}):`);
      problems.forEach((p) => console.error(`  - ${p}`));
      process.exit(2);
    }
    try {
      const me = await new JiraClient(cfg).myself();
      console.log(`OK - connected to ${cfg.baseUrl} as ${me.displayName} (${me.emailAddress || cfg.email}). Token source: ${cfg.tokenSource}.`);
      process.exit(0);
    } catch (err) {
      console.error(`FAILED - ${err.message}`);
      process.exit(2);
    }
  }

  const isConfigured = problems.length === 0;
  const url = isConfigured ? `http://127.0.0.1:${cfg.port}/` : `http://127.0.0.1:${cfg.port}/setup-web.html`;
  const shouldOpen = cfg.openBrowserOnStart && !args.has('--no-open');
  const { server } = createApp(cfg);

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (await existingInstance(cfg.port)) {
        console.log(`Jira App is already running at ${url}`);
        if (shouldOpen || args.has('--open')) openBrowser(url);
        process.exit(0);
      }
      console.error(`Port ${cfg.port} is used by another program. Change "port" in config.json.`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });

  server.listen(cfg.port, '127.0.0.1', () => {
    if (isConfigured) {
      console.log(`${new Date().toISOString()} Jira App running at ${url} (Jira: ${cfg.baseUrl}, user: ${cfg.email})`);
    } else {
      console.log(`${new Date().toISOString()} Jira App started in setup mode at ${url}`);
      console.log(`Opening browser to connect your Jira account (one-time setup)...`);
    }
    if (shouldOpen) openBrowser(url);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
