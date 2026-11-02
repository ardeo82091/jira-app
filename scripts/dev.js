#!/usr/bin/env node
'use strict';

/**
 * npm run dev
 *
 * Starts Jira App for development:
 *  - auto-restarts the server when lib/ or server.js change (node --watch)
 *  - UI files in public/ are served fresh on every request: just refresh the browser
 *  - runs on port 4787, so it does not clash with the auto-started app on 4777
 *  - if config.json is not set up yet (or you pass --mock), it starts a fake Jira with
 *    sample data, so the UI works without an API token
 *
 * Options:  --mock     always use the fake Jira
 *           --no-open  don't open the browser
 *           --port=N   use another port
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const portArg = args.find((a) => a.startsWith('--port='));
const DEV_PORT = Number(portArg ? portArg.split('=')[1] : process.env.JIRA_APP_DEV_PORT || 4787);

function realConfigProblems() {
  try {
    const { loadConfig, validateConfig } = require(path.join(ROOT, 'lib', 'config'));
    return validateConfig(loadConfig());
  } catch (err) {
    return [err.message];
  }
}

function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 300));
    attempt();
  });
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', '""', url], { ...opts, windowsHide: true, windowsVerbatimArguments: true });
  else if (process.platform === 'darwin') child = spawn('open', [url], opts);
  else child = spawn('xdg-open', [url], opts);
  child.on('error', () => {});
  child.unref();
}

async function main() {
  const env = { ...process.env, JIRA_APP_PORT: String(DEV_PORT), JIRA_APP_OPEN_BROWSER: 'false' };
  let mock = null;

  const problems = has('--mock') ? ['--mock requested'] : realConfigProblems();
  if (problems.length) {
    const { startMockJira, EMAIL, TOKEN } = require(path.join(ROOT, 'test', 'mock-jira'));
    mock = await startMockJira(0);
    Object.assign(env, {
      JIRA_BASE_URL: `http://127.0.0.1:${mock.port}`,
      JIRA_EMAIL: EMAIL,
      JIRA_API_TOKEN: TOKEN,
    });
    console.log('');
    console.log('  DEMO MODE: using a fake Jira with sample data (issue FUL2-315620).');
    if (!has('--mock')) {
      console.log('  Reason: real Jira is not configured yet:');
      problems.forEach((p) => console.log(`    - ${p}`));
      console.log('  To use your real Jira:  powershell -ExecutionPolicy Bypass -File setup.ps1');
    }
    console.log('');
  }

  const server = spawn(process.execPath, [
    '--watch-path=./lib',
    '--watch-path=./server.js',
    'server.js',
    '--no-open',
  ], { cwd: ROOT, env, stdio: 'inherit' });

  const url = `http://127.0.0.1:${DEV_PORT}/`;
  const stop = (code) => {
    if (!server.killed) server.kill();
    if (mock) mock.server.close();
    process.exit(code || 0);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  server.on('exit', (code) => {
    if (mock) mock.server.close();
    process.exit(code || 0);
  });

  if (await waitForHealth(DEV_PORT)) {
    console.log(`\n  Dev server ready: ${url}  (Ctrl+C to stop; edits in lib/ restart it, edits in public/ need a browser refresh)\n`);
    if (!has('--no-open')) openBrowser(mock ? `${url}#/issue/FUL2-315620` : url);
  } else {
    console.error(`\n  Dev server did not start on port ${DEV_PORT}. If the port is busy, run: npm run dev -- --port=4788\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
