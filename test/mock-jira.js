'use strict';

/** Fake Jira Cloud server used by the tests (and handy for UI development: node test/mock-jira.js). */
const http = require('http');

const EMAIL = 'tester@example.com';
const TOKEN = 'secret-token';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startMockJira(listenPort = 0) {
  const calls = [];
  const issue = {
    id: '1001',
    key: 'FUL2-315620',
    fields: {
      summary: 'Product Details Changes',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Objective - test. UIN - TBD' }] }] },
      status: { name: 'New', statusCategory: { key: 'new' } },
      issuetype: { name: 'Story' },
      priority: { id: '4', name: 'Low' },
      project: { key: 'FUL2', name: 'Fulfilment' },
      assignee: null,
      reporter: { displayName: 'Krishna Mishra' },
      labels: [],
      attachment: [{ id: '555', filename: 'brd.png', mimeType: 'image/png', size: 4 }],
      issuelinks: [],
      customfield_10016: 3,
    },
    names: { summary: 'Summary', customfield_10016: 'Story Points' },
    renderedFields: { description: '<p>Objective - test. <img src="/rest/api/3/attachment/content/555"></p>' },
    changelog: { histories: [], total: 0 },
  };

  const STATUS = {
    New: { key: 'new' }, 'In Progress': { key: 'indeterminate' }, 'In Review': { key: 'indeterminate' }, Done: { key: 'done' },
  };
  const WORKFLOW = {
    New: [['31', 'In Progress', 'In Progress'], ['41', 'Done', 'Done']],
    'In Progress': [['51', 'Send for review', 'In Review'], ['11', 'Back to New', 'New'], ['41', 'Done', 'Done']],
    'In Review': [['31', 'Rework', 'In Progress'], ['41', 'Approve', 'Done']],
    Done: [['61', 'Reopen', 'New']],
  };
  const transitionsFor = (statusName) => (WORKFLOW[statusName] || [])
    .map(([id, name, to]) => ({ id, name, to: { name: to, statusCategory: STATUS[to] }, fields: {} }));

  const sample = (n, summary, type, status, priority, assignee, hoursAgo) => ({
    id: String(2000 + n),
    key: `FUL2-3156${String(n).padStart(2, '0')}`,
    fields: {
      summary,
      issuetype: { name: type },
      status: { name: status, statusCategory: STATUS[status] },
      priority: { name: priority },
      project: { key: 'FUL2', name: 'Fulfilment' },
      assignee: assignee ? { displayName: assignee } : null,
      reporter: { displayName: 'Krishna Mishra' },
      labels: [],
      attachment: [],
      issuelinks: [],
      updated: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(),
      created: new Date(Date.now() - (hoursAgo + 72) * 3600 * 1000).toISOString(),
    },
  });
  const extras = [
    sample(21, 'SWIFT PAR - cover multiple rules by entry age', 'Story', 'In Progress', 'High', 'Ankit Raj', 2),
    sample(22, 'Cash bonus frequency dropdown shows Monthly for Annual mode', 'Bug', 'In Progress', 'Highest', 'Ankit Raj', 5),
    sample(23, 'Add Paid-up addition field and PUA conversion %', 'Story', 'New', 'Medium', 'Ankit Raj', 26),
    sample(24, 'Special milestone benefit year range 1..PT', 'Task', 'New', 'Low', 'Ankit Raj', 30),
    sample(25, 'Whitelist new BI payload keys', 'Sub-task', 'In Review', 'Medium', 'Ankit Raj', 8),
    sample(26, 'Accrual popup when payout option is Advance', 'Bug', 'In Review', 'High', 'Priya Sharma', 12),
    sample(27, 'Y-Junction config for SWIFT PAR product id', 'Task', 'Done', 'Medium', 'Ankit Raj', 50),
    sample(28, 'SWIFT PAR epic - product launch', 'Epic', 'In Progress', 'High', 'Rahul Verma', 70),
    sample(29, 'Unit tests for BI payload mapping', 'Sub-task', 'Done', 'Low', 'Priya Sharma', 20),
  ];
  // FUL2-315625 and FUL2-315629 are sub-tasks of FUL2-315620.
  const subtaskRef = (s) => ({ id: s.id, key: s.key, fields: { summary: s.fields.summary, status: s.fields.status, priority: s.fields.priority, issuetype: s.fields.issuetype } });
  const linkSubtask = (sub) => {
    sub.fields.issuetype = { name: 'Sub-task', subtask: true };
    sub.fields.parent = { id: issue.id, key: issue.key, fields: { summary: issue.fields.summary, status: issue.fields.status, issuetype: issue.fields.issuetype } };
    issue.fields.subtasks = [...(issue.fields.subtasks || []), subtaskRef(sub)];
  };
  issue.fields.subtasks = [];
  extras.filter((x) => x.fields.issuetype.name === 'Sub-task').forEach(linkSubtask);
  const dayOffset = (d) => { const x = new Date(Date.now() + d * 86400000); return x.toISOString().slice(0, 10); };
  extras[0].fields.duedate = dayOffset(2);
  extras[1].fields.duedate = dayOffset(-1);
  extras[3].fields.duedate = dayOffset(0);
  extras[2].fields.updated = new Date(Date.now() - 10 * 86400000).toISOString();
  issue.fields.updated = new Date(Date.now() - 3600 * 1000).toISOString();
  issue.fields.created = new Date(Date.now() - 80 * 3600 * 1000).toISOString();
  const allIssues = () => [issue, ...extras];
  const byKey = (key) => allIssues().find((i) => i.key === key);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body, headers: req.headers });
      const send = (status, data, type) => {
        res.writeHead(status, { 'Content-Type': type || 'application/json' });
        res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
      };
      if (req.headers.authorization !== EXPECTED_AUTH) return send(401, { errorMessages: ['bad auth'] });
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (p === '/rest/api/3/myself') return send(200, { accountId: 'acc-1', displayName: 'Ankit Raj', emailAddress: EMAIL });
      if (p === '/rest/api/3/search/jql' && req.method === 'POST') {
        const { jql } = JSON.parse(body);
        if (jql === 'bad jql') return send(400, { errorMessages: ["Error in the JQL Query: 'bad'"] });
        const parentQ = /\bparent\s*=\s*"?([A-Z0-9]+-\d+)"?/i.exec(jql || '');
        if (parentQ) return send(200, { issues: allIssues().filter((i) => i.fields.parent && i.fields.parent.key === parentQ[1].toUpperCase()), isLast: true });
        return send(200, { issues: allIssues(), isLast: true });
      }
      // Generic sample workflow for every issue (stateful, so drag & drop really moves cards).
      const trMatch = /^\/rest\/api\/3\/issue\/([A-Z0-9]+-\d+)\/transitions$/.exec(p);
      if (trMatch && byKey(trMatch[1])) {
        const target = byKey(trMatch[1]);
        if (req.method === 'GET') return send(200, { transitions: transitionsFor(target.fields.status.name) });
        const { transition } = JSON.parse(body || '{}');
        const t = transitionsFor(target.fields.status.name).find((x) => x.id === (transition && transition.id));
        if (!t) return send(400, { errorMessages: ['Transition is not valid for the current status.'] });
        target.fields.status = { name: t.to.name, statusCategory: t.to.statusCategory };
        target.fields.updated = new Date().toISOString();
        res.writeHead(204);
        return res.end();
      }
      const extraMatch = /^\/rest\/api\/3\/issue\/([A-Z0-9]+-\d+)$/.exec(p);
      if (extraMatch && extraMatch[1] !== 'FUL2-315620' && byKey(extraMatch[1]) && req.method === 'GET') {
        return send(200, { names: { summary: 'Summary' }, renderedFields: { description: '<p>Sample issue for the demo board.</p>' }, changelog: { histories: [], total: 0 }, ...byKey(extraMatch[1]) });
      }
      const subMatch = /^\/rest\/api\/3\/issue\/([A-Z0-9]+-\d+)\/(comment|remotelink|worklog)$/.exec(p);
      if (subMatch && subMatch[1] !== 'FUL2-315620' && byKey(subMatch[1]) && req.method === 'GET') {
        return send(200, subMatch[2] === 'comment' ? { comments: [], total: 0 } : subMatch[2] === 'worklog' ? { worklogs: [] } : []);
      }
      if (p === '/rest/api/3/search/approximate-count') return send(200, { count: 1 });
      if (p === '/rest/api/3/issue/FUL2-315620' && req.method === 'GET') return send(200, issue);
      if (p === '/rest/api/3/issue/FUL2-315620' && req.method === 'PUT') { res.writeHead(204); return res.end(); }
      if (p === '/rest/api/3/issue/FUL2-404') return send(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
      if (p === '/rest/api/3/issue/FUL2-315620/comment' && req.method === 'GET') return send(200, { comments: [{ id: '1', author: { displayName: 'QA' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Is PCB default?' }] }] }, renderedBody: '<p>Is PCB default?</p>' }], total: 1 });
      if (p === '/rest/api/3/issue/FUL2-315620/comment' && req.method === 'POST') return send(201, { id: '2' });
      if (p === '/rest/api/3/issue/FUL2-315620/remotelink') return send(200, []);
      if (p === '/rest/api/3/issue/FUL2-315620/transitions' && req.method === 'GET') return send(200, { transitions: [{ id: '31', name: 'In Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, fields: {} }] });
      if (p === '/rest/api/3/issue/FUL2-315620/transitions' && req.method === 'POST') { res.writeHead(204); return res.end(); }
      if (p === '/rest/api/3/issue/FUL2-315620/assignee') { res.writeHead(204); return res.end(); }
      if (p === '/rest/api/3/user/assignable/search') return send(200, [{ accountId: 'acc-2', displayName: 'Krishna Kumar', emailAddress: 'krishna@example.com', active: true }]);
      if (p === '/rest/api/3/issue/FUL2-315620/worklog' && req.method === 'POST') return send(201, { id: '900' });
      if (p === '/rest/api/3/attachment/content/555') return send(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
      if (p === '/rest/api/3/issue/FUL2-315620/attachments') return send(200, [{ id: '556', filename: 'a.txt', size: 5 }]);
      if (p === '/rest/api/3/issue' && req.method === 'POST') {
        const { fields } = JSON.parse(body || '{}');
        if (fields && fields.parent && fields.parent.key === issue.key) {
          const n = 40 + issue.fields.subtasks.length;
          const sub = sample(n, fields.summary, 'Sub-task', 'New', 'Medium', null, 0);
          extras.push(sub);
          linkSubtask(sub);
          return send(201, { id: sub.id, key: sub.key });
        }
        return send(201, { id: '1002', key: 'FUL2-315621' });
      }
      if (p === '/rest/api/3/project/search') return send(200, { values: [{ id: '1', key: 'FUL2', name: 'Fulfilment' }] });
      if (p === '/rest/api/3/issue/createmeta/FUL2/issuetypes') return send(200, { issueTypes: [{ id: '10001', name: 'Story', subtask: false }, { id: '10003', name: 'Sub-task', subtask: true }] });
      if (p === '/rest/api/3/issue/createmeta/FUL2/issuetypes/10001') return send(200, { fields: [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }, { fieldId: 'customfield_20000', name: 'Channel', required: true, schema: { type: 'option' }, allowedValues: [{ id: '1', value: 'Axis' }, { id: '2', value: 'YBL' }] }, { fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array', items: 'string' } }] });
      if (p === '/rest/api/3/filter/favourite') return send(200, [{ id: '1', name: 'My team board', jql: 'project = FUL2 ORDER BY updated DESC' }]);
      if (p === '/rest/api/3/issueLinkType') return send(200, { issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] });
      if (p === '/rest/api/3/issue/FUL2-315620/worklog' && req.method === 'GET') return send(200, { worklogs: [] });
      return send(404, { errorMessages: [`mock: no route ${req.method} ${p}`] });
    });
  });
  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}


module.exports = { startMockJira, freePort, EMAIL, TOKEN, EXPECTED_AUTH };

if (require.main === module) {
  startMockJira(Number(process.argv[2]) || 0).then(({ port }) => console.log(`Mock Jira on http://127.0.0.1:${port}`));
}
