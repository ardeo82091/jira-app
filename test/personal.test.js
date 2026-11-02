'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-app-personal-'));
process.env.JIRA_APP_DATA_DIR = dir;

const personal = require('../lib/personal');
const { createApp } = require('../lib/app');
const { startMockJira, freePort, EMAIL, TOKEN } = require('./mock-jira');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('personal store: notes, checklist, tags, focus, reminders, timer', () => {
  const rec = personal.patchIssue('ful2-1', { notes: 'hello', checklist: [{ text: 'a' }, { text: 'b', done: true }, { text: '  ' }], tags: ['Follow-Up', 'new tag', 'new tag'], focus: true, summary: 'S' });
  assert.equal(rec.notes, 'hello');
  assert.equal(rec.checklist.length, 2);
  assert.deepEqual(rec.tags, ['follow-up', 'new tag']);
  assert.equal(rec.focus, true);
  assert.ok(personal.load().tags.some((t) => t.name === 'new tag'), 'new tag added to palette');

  personal.patchIssue('FUL2-2', { focus: true });
  assert.ok(personal.load().issues['FUL2-2'].focusOrder > personal.load().issues['FUL2-1'].focusOrder);

  personal.patchIssue('FUL2-1', { remindAt: new Date(Date.now() - 1000).toISOString(), remindNote: 'ping' });
  assert.equal(personal.dueReminders().length, 1);
  personal.patchIssue('FUL2-1', { reminded: true });
  assert.equal(personal.dueReminders().length, 0);

  // clearing everything removes the record
  assert.equal(personal.patchIssue('FUL2-2', { focus: false }), null);
  assert.equal(personal.load().issues['FUL2-2'], undefined);

  assert.throws(() => personal.patchIssue('bad key', { notes: 'x' }), /Invalid issue key/);
  assert.throws(() => personal.patchIssue('FUL2-1', { remindAt: 'not a date' }), /Invalid reminder/);
  assert.throws(() => personal.patchIssue('FUL2-1', { notes: 'x'.repeat(20001) }), /limited/);

  const started = personal.startTimer('FUL2-1', 'S');
  assert.equal(started.active.key, 'FUL2-1');
  const again = personal.startTimer('FUL2-3', 'T');
  assert.equal(again.stopped.key, 'FUL2-1', 'starting a new timer stops the old one');
  const entry = personal.stopTimer();
  assert.equal(entry.key, 'FUL2-3');
  assert.equal(personal.load().timer.active, null);
  assert.equal(personal.load().timer.entries.length, 2);

  assert.equal(personal.toJiraDuration(20), '1m');
  assert.equal(personal.toJiraDuration(5100), '1h 25m');
  assert.equal(personal.toJiraDuration(7200), '2h');
});

test('personal API end-to-end, including timer -> Jira work log', async (t) => {
  const jira = await startMockJira();
  const port = await freePort();
  const { server } = createApp({ baseUrl: `http://127.0.0.1:${jira.port}`, email: EMAIL, apiToken: TOKEN, port, defaultJql: 'x' }, { log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => { server.close(); jira.server.close(); });
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'X-Jira-App': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 403, 'needs the app header');
  const put = await call('PUT', '/api/me/issue/FUL2-315620', { tags: ['blocked'], notes: 'n' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data.record.tags, ['blocked']);
  assert.equal((await call('PUT', '/api/me/issue/nope', { notes: 'x' })).status, 400);
  assert.equal((await call('GET', '/api/me')).data.issues['FUL2-315620'].notes, 'n');

  assert.equal((await call('POST', '/api/me/timer/start', { key: 'FUL2-315620', summary: 'Product Details Changes' })).status, 200);
  const stop = await call('POST', '/api/me/timer/stop', { log: true, commentText: 'worked' });
  assert.equal(stop.status, 200);
  assert.equal(stop.data.timeSpent, '1m');
  assert.equal(stop.data.entry.logged, true);
  const wl = jira.calls.filter((c) => c.url.includes('/worklog') && c.method === 'POST').at(-1);
  assert.equal(JSON.parse(wl.body).timeSpent, '1m');
  assert.equal((await call('POST', '/api/me/timer/stop', {})).status, 400, 'no timer running');

  await call('POST', '/api/me/timer/start', { key: 'FUL2-315620' });
  const kept = await call('POST', '/api/me/timer/stop', { log: false });
  assert.equal(kept.data.entry.logged, false);
  const logLater = await call('POST', `/api/me/timer/entries/${kept.data.entry.id}/log`, {});
  assert.equal(logLater.data.timeSpent, '1m');
  assert.equal((await call('POST', `/api/me/timer/entries/${kept.data.entry.id}/log`, {})).status, 400, 'cannot log twice');
  assert.equal((await call('DELETE', `/api/me/timer/entries/${kept.data.entry.id}`)).data.ok, true);
});
