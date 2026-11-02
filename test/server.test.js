'use strict';

/**
 * End-to-end test: starts a fake Jira Cloud server and the Jira App server, then
 * exercises the app's HTTP API exactly like the browser does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../lib/app');
const { startMockJira, freePort, EMAIL, TOKEN, EXPECTED_AUTH } = require('./mock-jira');

test('Jira App API end-to-end against a mock Jira', async (t) => {
  const jira = await startMockJira();
  const port = await freePort();
  const cfg = { baseUrl: `http://127.0.0.1:${jira.port}`, email: EMAIL, apiToken: TOKEN, port, defaultJql: 'assignee = currentUser()' };
  const { server } = createApp(cfg, { log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => { server.close(); jira.server.close(); });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Jira-App': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  };

  await t.test('static UI is served with a strict CSP', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await res.text(), /<title>Jira App<\/title>/);
    assert.equal((await fetch(`${base}/js/core.js`)).status, 200);
    assert.equal((await fetch(`${base}/..%2Fconfig.json`)).status, 404);
  });

  await t.test('session returns the user and a token', async () => {
    const r = await call('GET', '/api/session');
    assert.equal(r.status, 200);
    assert.equal(r.data.user.displayName, 'Ankit Raj');
    assert.equal(r.data.token.length, 48);
    assert.equal(jira.calls.at(-1).headers.authorization, EXPECTED_AUTH);
  });

  await t.test('CSRF / DNS-rebinding protections', async () => {
    assert.equal((await fetch(`${base}/api/session`)).status, 403); // no custom header
    assert.equal((await call('GET', '/api/session', undefined, { Origin: 'https://evil.example' })).status, 403);
    const rebinding = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/session', headers: { Host: `evil.example:${port}`, 'X-Jira-App': '1' } }, (res) => resolve(res.statusCode));
    });
    assert.equal(rebinding, 403);
  });

  await t.test('search, count and JQL errors', async () => {
    const r = await call('GET', `/api/search?jql=${encodeURIComponent('project = FUL2')}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.issues[0].key, 'FUL2-315620');
    assert.equal(r.data.issues[0].status.category, 'new');
    assert.equal((await call('GET', '/api/count?jql=x')).data.count, 1);
    const bad = await call('GET', '/api/search?jql=bad%20jql');
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Error in the JQL Query/);
  });

  await t.test('issue details, analysis and 404', async () => {
    const r = await call('GET', '/api/issue/ful2-315620');
    assert.equal(r.status, 200);
    assert.equal(r.data.issue.key, 'FUL2-315620');
    assert.equal(r.data.commentsTotal, 1);
    assert.ok(r.data.allFields.some((f) => f.name === 'Story Points' && f.value === '3'));
    const a = await call('GET', '/api/issue/FUL2-315620/analysis');
    assert.ok(a.data.openItems.some((o) => /TBD/.test(o)));
    assert.ok(a.data.openItems.some((o) => /QA \(comment\): Is PCB default\?/.test(o)));
    const missing = await call('GET', '/api/issue/FUL2-404');
    assert.equal(missing.status, 404);
    assert.equal((await call('GET', '/api/issue/not-a-key')).status, 400);
  });

  await t.test('write operations send correct Jira payloads', async () => {
    assert.equal((await call('PUT', '/api/issue/FUL2-315620', { summary: 'New title', labels: 'a, b', descriptionText: 'Line 1\n\n- item' })).status, 200);
    const edit = JSON.parse(jira.calls.at(-1).body);
    assert.equal(edit.fields.summary, 'New title');
    assert.deepEqual(edit.fields.labels, ['a', 'b']);
    assert.equal(edit.fields.description.content[1].type, 'bulletList');

    assert.equal((await call('POST', '/api/issue/FUL2-315620/comment', { text: 'Hello' })).status, 200);
    assert.equal(JSON.parse(jira.calls.at(-1).body).body.content[0].content[0].text, 'Hello');
    assert.equal((await call('POST', '/api/issue/FUL2-315620/comment', { text: '  ' })).status, 400);

    assert.equal((await call('GET', '/api/issue/FUL2-315620/transitions')).data[0].name, 'In Progress');
    assert.equal((await call('POST', '/api/issue/FUL2-315620/transitions', { id: '31', commentText: 'Starting' })).status, 200);
    const tr = JSON.parse(jira.calls.at(-1).body);
    assert.equal(tr.transition.id, '31');
    assert.ok(tr.update.comment[0].add.body);

    assert.equal((await call('PUT', '/api/issue/FUL2-315620/assignee', { accountId: 'me' })).status, 200);
    assert.equal(JSON.parse(jira.calls.at(-1).body).accountId, 'acc-1');

    assert.equal((await call('POST', '/api/issue/FUL2-315620/worklog', { timeSpent: '1h 30m', started: '2026-10-30T10:00' })).status, 200);
    assert.match(JSON.parse(jira.calls.at(-1).body).started, /^2026-10-30T10:00:00\.000[+-]\d{4}$/);
    assert.equal((await call('POST', '/api/issue/FUL2-315620/worklog', { timeSpent: 'lots' })).status, 400);

    const created = await call('POST', '/api/issue', { projectKey: 'FUL2', issueTypeId: '10001', summary: 'New story', descriptionText: 'Desc' });
    assert.equal(created.data.key, 'FUL2-315621');
  });

  await t.test('attachments: download needs token, upload passes multipart through', async () => {
    const { data: session } = await call('GET', '/api/session');
    assert.equal((await fetch(`${base}/api/attachment/555?t=wrong`)).status, 403);
    const ok = await fetch(`${base}/api/attachment/555?t=${session.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await ok.arrayBuffer()).length, 4);

    const form = new FormData();
    form.append('file', new Blob(['hello']), 'a.txt');
    const up = await fetch(`${base}/api/issue/FUL2-315620/attachments`, { method: 'POST', headers: { 'X-Jira-App': '1' }, body: form });
    assert.equal(up.status, 200);
    const last = jira.calls.at(-1);
    assert.equal(last.headers['x-atlassian-token'], 'no-check');
    assert.match(last.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(last.body, /filename="a.txt"/);
  });

  await t.test('bad credentials surface a clear message', async () => {
    const badPort = await freePort();
    const bad = createApp({ ...cfg, apiToken: 'wrong', port: badPort }, { log: () => {} });
    await new Promise((r) => bad.server.listen(badPort, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${badPort}/api/session`, { headers: { 'X-Jira-App': '1' } });
    const data = await res.json();
    bad.server.close();
    assert.equal(res.status, 401);
    assert.match(data.error, /bad auth/);
  });

  await t.test('setup prefill returns public config', async () => {
    const res = await call('GET', '/api/setup/prefill');
    assert.equal(res.status, 200);
    assert.ok(typeof res.data.baseUrl === 'string');
    assert.ok(typeof res.data.email === 'string');
  });

  await t.test('kiro summary endpoint produces summary markdown', async () => {
    const res = await call('POST', '/api/issue/FUL2-315620/kiro-summary');
    assert.equal(res.status, 200);
    assert.equal(res.data.key, 'FUL2-315620');
    assert.match(res.data.markdown, /FUL2-315620/);
  });
});
