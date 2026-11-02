'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');

const { JiraClient, JiraError, assertIssueKey, assertNumericId } = require('./jira');
const { textToAdf, adfToText, isAdfDoc } = require('./adf');
const { analyzeIssue } = require('./analyze');
const personal = require('./personal');
const { loadConfig, validateConfig, saveConfig, readPublicConfig, kiroMcpCredentials } = require('./config');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const JSON_LIMIT = 1024 * 1024; // 1 MB
const UPLOAD_LIMIT = 50 * 1024 * 1024; // 50 MB
const CLIENT_HEADER = 'x-jira-app';
const TIME_SPENT_RE = /^\s*(\d+(\.\d+)?\s*[wdhm]\s*)+$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(port) {
  const self = `http://127.0.0.1:${port} http://localhost:${port}`;
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' ${self} data: https:`,
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

function sendJson(res, status, data, extraHeaders) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Request is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) throw new HttpError(415, 'Expected a JSON body.');
  const buf = await readBody(req, JSON_LIMIT);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
}

function requireText(value, label, max = 32767) {
  const text = typeof value === 'string' ? value : '';
  if (!text.trim()) throw new HttpError(400, `${label} is required.`);
  if (text.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters).`);
  return text;
}

/** Light-weight row used by the search results table. */
function mapSearchIssue(issue) {
  const f = issue.fields || {};
  return {
    id: issue.id,
    key: issue.key,
    summary: f.summary || '',
    status: f.status ? { name: f.status.name, category: f.status.statusCategory && f.status.statusCategory.key } : null,
    type: f.issuetype ? f.issuetype.name : '',
    priority: f.priority ? f.priority.name : '',
    assignee: f.assignee ? f.assignee.displayName : '',
    reporter: f.reporter ? f.reporter.displayName : '',
    project: f.project ? f.project.key : '',
    duedate: f.duedate || null,
    labels: f.labels || [],
    isSubtask: !!(f.issuetype && f.issuetype.subtask),
    parent: f.parent ? { key: f.parent.key, summary: (f.parent.fields && f.parent.fields.summary) || '', type: (f.parent.fields && f.parent.fields.issuetype && f.parent.fields.issuetype.name) || '' } : null,
    subtasks: Array.isArray(f.subtasks) ? f.subtasks.length : 0,
    subtasksDone: Array.isArray(f.subtasks) ? f.subtasks.filter((s) => s.fields && s.fields.status && s.fields.status.statusCategory && s.fields.status.statusCategory.key === 'done').length : 0,
    created: f.created,
    updated: f.updated,
  };
}

/** Converts any Jira field value into readable text for the "All fields" tab. */
function fieldValueToText(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(fieldValueToText).filter(Boolean).join(', ');
  if (typeof value !== 'object') return String(value);
  if (isAdfDoc(value)) return adfToText(value);
  if (value.displayName) return value.displayName;
  if (value.name && value.value === undefined) return value.name;
  if (value.value !== undefined) return value.child ? `${value.value} / ${fieldValueToText(value.child)}` : String(value.value);
  if (value.key && value.fields && value.fields.summary) return `${value.key} ${value.fields.summary}`;
  if (value.key) return String(value.key);
  if (value.filename) return value.filename;
  if (value.title) return value.title;
  if (value.originalEstimate || value.timeSpent || value.remainingEstimate) {
    return ['originalEstimate', 'remainingEstimate', 'timeSpent']
      .filter((k) => value[k]).map((k) => `${k}: ${value[k]}`).join(', ');
  }
  if (value.total !== undefined && Array.isArray(value.comments)) return `${value.total} comment(s)`;
  if (value.total !== undefined && Array.isArray(value.worklogs)) return `${value.total} worklog(s)`;
  if (value.watchCount !== undefined) return `${value.watchCount} watcher(s)`;
  if (value.votes !== undefined) return `${value.votes} vote(s)`;
  if (value.progress !== undefined && value.total !== undefined) return `${value.progress}/${value.total}`;
  try {
    const json = JSON.stringify(value);
    return json.length > 500 ? `${json.slice(0, 497)}...` : json;
  } catch (err) {
    return '[complex value]';
  }
}

function allFieldsText(issue) {
  const names = issue.names || {};
  const out = [];
  for (const [id, value] of Object.entries(issue.fields || {})) {
    const text = fieldValueToText(value);
    if (text) out.push({ id, name: names[id] || id, value: text });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Builds Jira field values for the create form from simple user input. */
function buildExtraFields(extra, fieldMeta) {
  const fields = {};
  if (!extra || typeof extra !== 'object') return fields;
  const metaById = new Map((fieldMeta || []).map((m) => [m.fieldId || m.key, m]));
  for (const [id, raw] of Object.entries(extra)) {
    if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) continue;
    if (!/^[A-Za-z0-9_]+$/.test(id)) continue;
    const meta = metaById.get(id);
    const schema = (meta && meta.schema) || {};
    const isTextarea = typeof schema.custom === 'string' && schema.custom.endsWith(':textarea');
    switch (schema.type) {
      case 'number': fields[id] = Number(raw); break;
      case 'option': fields[id] = { id: String(raw) }; break;
      case 'priority': fields[id] = { id: String(raw) }; break;
      case 'version':
      case 'component': fields[id] = { id: String(raw) }; break;
      case 'user': fields[id] = { accountId: String(raw) }; break;
      case 'date': fields[id] = String(raw).slice(0, 10); break;
      case 'array': {
        const items = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
        fields[id] = schema.items === 'string' ? items.map(String) : items.map((v) => ({ id: String(v) }));
        break;
      }
      default:
        fields[id] = isTextarea || schema.system === 'environment' ? textToAdf(String(raw)) : String(raw);
    }
  }
  return fields;
}

function createApp(cfg, deps = {}) {
  let activeCfg = { ...cfg };
  let client = deps.client || (activeCfg.apiToken ? new JiraClient({ baseUrl: activeCfg.baseUrl, email: activeCfg.email, apiToken: activeCfg.apiToken }) : null);
  const sessionToken = deps.sessionToken || crypto.randomBytes(24).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  const headers = securityHeaders(cfg.port);
  const log = deps.log || ((...args) => console.log(new Date().toISOString(), ...args));
  let cachedUser = null;

  const ensureClient = () => {
    if (!client) throw new HttpError(401, 'Jira App is not configured yet. Complete setup at /setup-web.html');
    return client;
  };

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, opts });

  // ---- session ----------------------------------------------------------
  route('GET', /^\/api\/session$/, async () => {
    ensureClient();
    cachedUser = await client.myself();
    return {
      user: {
        accountId: cachedUser.accountId,
        displayName: cachedUser.displayName,
        emailAddress: cachedUser.emailAddress,
        timeZone: cachedUser.timeZone,
      },
      baseUrl: cfg.baseUrl,
      defaultJql: cfg.defaultJql,
      token: sessionToken,
    };
  });

  // ---- search -----------------------------------------------------------
  route('GET', /^\/api\/search$/, async ({ query }) => {
    const jql = String(query.get('jql') || cfg.defaultJql).slice(0, 10000);
    const data = await client.searchJql({ jql, nextPageToken: query.get('nextPageToken') || undefined, maxResults: query.get('maxResults') || 50 });
    return { jql, issues: (data.issues || []).map(mapSearchIssue), nextPageToken: data.nextPageToken || null, isLast: data.isLast !== false && !data.nextPageToken };
  });

  route('GET', /^\/api\/count$/, async ({ query }) => {
    const data = await client.approximateCount(String(query.get('jql') || cfg.defaultJql));
    return { count: data && typeof data.count === 'number' ? data.count : null };
  });

  route('GET', /^\/api\/filters\/favourite$/, async () => {
    const filters = await client.favouriteFilters();
    return (filters || []).map((flt) => ({ id: flt.id, name: flt.name, jql: flt.jql }));
  });

  // ---- issue ------------------------------------------------------------
  route('GET', /^\/api\/issue\/([^/]+)$/, async ({ params }) => {
    const key = assertIssueKey(params[0]);
    const [issue, comments, remoteLinks] = await Promise.all([
      client.getIssue(key),
      client.getComments(key).catch(() => ({ comments: [] })),
      client.remoteLinks(key).catch(() => []),
    ]);
    return {
      issue,
      comments: comments.comments || [],
      commentsTotal: comments.total || (comments.comments || []).length,
      remoteLinks: remoteLinks || [],
      descriptionText: adfToText(issue.fields && issue.fields.description),
      allFields: allFieldsText(issue),
    };
  });

  route('PUT', /^\/api\/issue\/([^/]+)$/, async ({ params, body }) => {
    const key = assertIssueKey(params[0]);
    const fields = {};
    if (body.summary !== undefined) fields.summary = requireText(body.summary, 'Summary', 255).trim();
    if (body.descriptionText !== undefined) fields.description = textToAdf(String(body.descriptionText));
    if (body.labels !== undefined) {
      const labels = (Array.isArray(body.labels) ? body.labels : String(body.labels).split(/[,\s]+/)).map((l) => String(l).trim()).filter(Boolean);
      if (labels.some((l) => /\s/.test(l))) throw new HttpError(400, 'Labels cannot contain spaces.');
      fields.labels = labels;
    }
    if (body.priorityId !== undefined) fields.priority = { id: assertNumericId(body.priorityId, 'priority id') };
    if (body.duedate !== undefined) fields.duedate = body.duedate ? String(body.duedate).slice(0, 10) : null;
    if (!Object.keys(fields).length) throw new HttpError(400, 'Nothing to update.');
    await client.editIssue(key, fields);
    log(`updated ${key}: ${Object.keys(fields).join(', ')}`);
    return { ok: true };
  }, { json: true });

  route('GET', /^\/api\/issue\/([^/]+)\/editmeta$/, async ({ params }) => {
    const meta = await client.editMeta(assertIssueKey(params[0]));
    const priority = meta.fields && meta.fields.priority;
    return {
      editable: Object.keys(meta.fields || {}),
      priorities: priority && priority.allowedValues ? priority.allowedValues.map((p) => ({ id: p.id, name: p.name })) : [],
    };
  });

  route('GET', /^\/api\/issue\/([^/]+)\/analysis$/, async ({ params }) => {
    const key = assertIssueKey(params[0]);
    const [issue, comments, remoteLinks] = await Promise.all([
      client.getIssue(key),
      client.getComments(key).catch(() => ({ comments: [] })),
      client.remoteLinks(key).catch(() => []),
    ]);
    return analyzeIssue(issue, comments.comments || [], remoteLinks || []);
  });

  route('POST', /^\/api\/issue\/([^/]+)\/comment$/, async ({ params, body }) => {
    const key = assertIssueKey(params[0]);
    const comment = await client.addComment(key, textToAdf(requireText(body.text, 'Comment')));
    log(`commented on ${key}`);
    return comment;
  }, { json: true });

  route('GET', /^\/api\/issue\/([^/]+)\/transitions$/, async ({ params }) => {
    const data = await client.transitions(assertIssueKey(params[0]));
    return (data.transitions || []).map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to ? { name: t.to.name, category: t.to.statusCategory && t.to.statusCategory.key } : null,
      requiredFields: Object.entries(t.fields || {}).filter(([, m]) => m.required && !m.hasDefaultValue).map(([id, m]) => m.name || id),
    }));
  });

  route('POST', /^\/api\/issue\/([^/]+)\/transitions$/, async ({ params, body }) => {
    const key = assertIssueKey(params[0]);
    const comment = body.commentText && String(body.commentText).trim() ? textToAdf(String(body.commentText)) : null;
    await client.doTransition(key, body.id, comment);
    log(`transitioned ${key} via ${body.id}`);
    return { ok: true };
  }, { json: true });

  route('GET', /^\/api\/issue\/([^/]+)\/assignable$/, async ({ params, query }) => {
    const users = await client.assignableUsers(assertIssueKey(params[0]), String(query.get('query') || '').slice(0, 100));
    return (users || []).filter((u) => u.active !== false).map((u) => ({ accountId: u.accountId, displayName: u.displayName, emailAddress: u.emailAddress || '' }));
  });

  route('PUT', /^\/api\/issue\/([^/]+)\/assignee$/, async ({ params, body }) => {
    const key = assertIssueKey(params[0]);
    let accountId = body.accountId === undefined ? null : body.accountId;
    if (accountId === 'me') {
      if (!cachedUser) cachedUser = await client.myself();
      accountId = cachedUser.accountId;
    }
    if (accountId !== null && !/^[A-Za-z0-9:_-]{1,128}$/.test(String(accountId))) throw new HttpError(400, 'Invalid account id.');
    await client.assign(key, accountId);
    log(`assigned ${key} to ${accountId || 'nobody'}`);
    return { ok: true };
  }, { json: true });

  route('GET', /^\/api\/issue\/([^/]+)\/worklog$/, async ({ params }) => {
    const data = await client.worklogs(assertIssueKey(params[0]));
    return (data.worklogs || []).map((w) => ({
      id: w.id,
      author: w.author && w.author.displayName,
      started: w.started,
      timeSpent: w.timeSpent,
      comment: adfToText(w.comment),
    })).sort((a, b) => String(b.started).localeCompare(String(a.started)));
  });

  route('POST', /^\/api\/issue\/([^/]+)\/worklog$/, async ({ params, body }) => {
    const key = assertIssueKey(params[0]);
    const timeSpent = String(body.timeSpent || '').trim();
    if (!TIME_SPENT_RE.test(timeSpent)) throw new HttpError(400, 'Time spent must look like "1h 30m", "2h" or "1d".');
    let started = new Date();
    if (body.started) {
      started = new Date(String(body.started));
      if (Number.isNaN(started.getTime())) throw new HttpError(400, 'Invalid start date/time.');
    }
    const comment = body.commentText && String(body.commentText).trim() ? textToAdf(String(body.commentText)) : null;
    const wl = await client.addWorklog(key, { timeSpent, started, adfComment: comment });
    log(`logged ${timeSpent} on ${key}`);
    return { id: wl.id };
  }, { json: true });

  route('POST', /^\/api\/issue\/([^/]+)\/attachments$/, async ({ params, req }) => {
    const key = assertIssueKey(params[0]);
    const type = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data;\s*boundary=/i.test(type)) throw new HttpError(415, 'Expected multipart/form-data upload.');
    const buf = await readBody(req, UPLOAD_LIMIT);
    const result = await client.uploadAttachments(key, buf, type);
    log(`uploaded ${(result || []).length} attachment(s) to ${key}`);
    return (result || []).map((a) => ({ id: a.id, filename: a.filename, size: a.size }));
  });

  // ---- links ------------------------------------------------------------
  route('GET', /^\/api\/link-types$/, async () => {
    const data = await client.linkTypes();
    return (data.issueLinkTypes || []).map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward }));
  });

  route('POST', /^\/api\/issue-link$/, async ({ body }) => {
    const typeName = requireText(body.typeName, 'Link type', 255);
    const from = assertIssueKey(body.fromKey);
    const to = assertIssueKey(body.toKey);
    // "fromKey <outward phrase> toKey"  e.g. "A blocks B": outwardIssue = B, inwardIssue = A (Jira semantics)
    const direction = body.direction === 'inward' ? 'inward' : 'outward';
    const linkSpec = direction === 'outward'
      ? { typeName, inwardKey: from, outwardKey: to }
      : { typeName, inwardKey: to, outwardKey: from };
    await client.createLink(linkSpec);
    log(`linked ${from} ${direction} ${to} (${typeName})`);
    return { ok: true };
  }, { json: true });

  // ---- create -----------------------------------------------------------
  route('GET', /^\/api\/projects$/, async ({ query }) => {
    const data = await client.projects(String(query.get('query') || '').slice(0, 100));
    return (data.values || []).map((p) => ({ id: p.id, key: p.key, name: p.name }));
  });

  route('GET', /^\/api\/projects\/([A-Za-z0-9_]+)\/issuetypes$/, async ({ params }) => {
    const data = await client.issueTypes(params[0]);
    const types = data.issueTypes || data.values || [];
    return types.map((t) => ({ id: t.id, name: t.name, subtask: !!t.subtask }));
  });

  const HANDLED_CREATE_FIELDS = new Set(['project', 'issuetype', 'summary', 'description', 'reporter', 'parent', 'attachment', 'issuelinks']);

  route('GET', /^\/api\/projects\/([A-Za-z0-9_]+)\/issuetypes\/(\d+)\/fields$/, async ({ params }) => {
    const data = await client.issueTypeFields(params[0], params[1]);
    const fields = data.fields || data.values || [];
    return fields
      .filter((m) => !HANDLED_CREATE_FIELDS.has(m.fieldId || m.key))
      .map((m) => ({
        id: m.fieldId || m.key,
        name: m.name,
        required: !!m.required && !m.hasDefaultValue,
        schema: m.schema || {},
        allowedValues: Array.isArray(m.allowedValues)
          ? m.allowedValues.slice(0, 500).map((v) => ({ id: v.id, name: v.name || v.value || v.key || String(v.id) }))
          : null,
      }));
  });

  route('POST', /^\/api\/issue$/, async ({ body }) => {
    const projectKey = String(body.projectKey || '').trim();
    if (!/^[A-Za-z0-9_]+$/.test(projectKey)) throw new HttpError(400, 'Choose a project.');
    const issueTypeId = assertNumericId(body.issueTypeId, 'issue type');
    const fields = {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary: requireText(body.summary, 'Summary', 255).trim(),
    };
    const description = textToAdf(body.descriptionText || '');
    if (description) fields.description = description;
    if (body.parentKey) fields.parent = { key: assertIssueKey(body.parentKey) };
    if (body.extraFields && Object.keys(body.extraFields).length) {
      const meta = await client.issueTypeFields(projectKey, issueTypeId);
      Object.assign(fields, buildExtraFields(body.extraFields, meta.fields || meta.values || []));
    }
    const created = await client.createIssue(fields);
    log(`created ${created.key}`);
    return { key: created.key, id: created.id };
  }, { json: true });

  // ---- attachment download (token in query so <img>/<a> can use it) ------
  route('GET', /^\/api\/attachment\/(\d+)$/, async ({ params, res, query }) => {
    const upstream = await client.attachmentContent(params[0]);
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const out = {
      ...headers,
      'Content-Type': type,
      'Cache-Control': 'private, max-age=600',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    };
    const disposition = upstream.headers.get('content-disposition');
    if (query.get('download') === '1') out['Content-Disposition'] = disposition && /attachment/i.test(disposition) ? disposition : 'attachment';
    else if (disposition) out['Content-Disposition'] = disposition.replace(/^attachment/i, /^image\//i.test(type) ? 'inline' : 'attachment');
    const len = upstream.headers.get('content-length');
    if (len) out['Content-Length'] = len;
    res.writeHead(200, out);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
    return undefined;
  }, { tokenInQuery: true });

  // ---- personal tracker (local only) ----------------------------------------
  route('GET', /^\/api\/me$/, async () => personal.load());

  route('PUT', /^\/api\/me\/issue\/([^/]+)$/, async ({ params, body }) => ({ record: personal.patchIssue(params[0], body) }), { json: true });

  route('PUT', /^\/api\/me\/tags$/, async ({ body }) => ({ tags: personal.setTags(body.tags) }), { json: true });

  route('POST', /^\/api\/me\/timer\/start$/, async ({ body }) => personal.startTimer(body.key, body.summary), { json: true });

  async function logEntry(entry, commentText) {
    const timeSpent = personal.toJiraDuration(entry.seconds);
    const comment = commentText && String(commentText).trim() ? textToAdf(String(commentText)) : null;
    await client.addWorklog(entry.key, { timeSpent, started: new Date(entry.start), adfComment: comment });
    personal.markLogged(entry.id);
    log(`logged ${timeSpent} on ${entry.key} from timer`);
    return timeSpent;
  }

  route('POST', /^\/api\/me\/timer\/stop$/, async ({ body }) => {
    const entry = personal.stopTimer();
    if (!entry) throw new HttpError(400, 'No timer is running.');
    let timeSpent = null;
    if (body.log) timeSpent = await logEntry(entry, body.commentText);
    return { entry: { ...entry, logged: !!timeSpent }, timeSpent };
  }, { json: true });

  route('POST', /^\/api\/me\/timer\/entries\/([a-f0-9]+)\/log$/, async ({ params, body }) => {
    const entry = personal.load().timer.entries.find((e) => e.id === params[0]);
    if (!entry) throw new HttpError(404, 'Time entry not found.');
    if (entry.logged) throw new HttpError(400, 'This time is already logged in Jira.');
    return { timeSpent: await logEntry(entry, body.commentText) };
  }, { json: true });

  route('DELETE', /^\/api\/me\/timer\/entries\/([a-f0-9]+)$/, async ({ params }) => ({ ok: personal.deleteEntry(params[0]) }));

  // ---- first-run / setup (web mode, for colleagues who don't have config yet) ----------
  route('GET', /^\/api\/setup\/prefill$/, async () => {
    const pub = readPublicConfig();
    return {
      baseUrl: pub.baseUrl || 'https://axismaxlife.atlassian.net',
      email: pub.email || '',
      hasToken: pub.hasToken,
      kiroDetected: !!pub.kiroDetected,
    };
  });

  route('POST', /^\/api\/setup\/save$/, async ({ body }) => {
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '') || 'https://axismaxlife.atlassian.net';
    const email = String(body.email || '').trim();
    const token = String(body.apiToken || '').trim();
    if (!/^https:\/\/[^/\s]+$/i.test(baseUrl)) return { ok: false, error: 'Jira site must look like https://yourcompany.atlassian.net' };
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { ok: false, error: 'Enter the e-mail you use to log in to Jira.' };
    const existing = readPublicConfig();
    if (!token && !existing.hasToken) return { ok: false, error: 'Paste your API token.' };
    try {
      const testToken = token || (activeCfg && activeCfg.apiToken) || loadConfig().apiToken;
      const testClient = new JiraClient({ baseUrl, email, apiToken: testToken });
      const me = await testClient.myself();
      saveConfig({ baseUrl, email, apiToken: token || undefined });
      activeCfg = loadConfig();
      client = new JiraClient(activeCfg);
      log(`Jira App configured for ${email} (${me.displayName})`);
      return { ok: true, user: me.displayName };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }, { json: true });

  // ---- Kiro CLI summary post ----------------------------------------------------------------
  route('POST', /^\/api\/issue\/([^/]+)\/kiro-summary$/, async ({ params }) => {
    ensureClient();
    const key = assertIssueKey(params[0]);
    const [issue, comments, remoteLinks] = await Promise.all([
      client.getIssue(key),
      client.getComments(key).catch(() => ({ comments: [] })),
      client.remoteLinks(key).catch(() => []),
    ]);
    const analysis = analyzeIssue(issue, comments.comments || [], remoteLinks || []);
    const summary = analysis.markdown;

    // Search for Kiro CLI binary across standard platform locations
    const candidates = [
      'kiro',
      'kiro.cmd',
      'kiro.exe',
      '/usr/local/bin/kiro',
      '/opt/homebrew/bin/kiro',
      '/usr/bin/kiro',
      path.join(os.homedir(), '.kiro', 'bin', 'kiro'),
      path.join(os.homedir(), '.kiro', 'bin', 'kiro.exe'),
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Kiro', 'kiro.exe') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'kiro.cmd') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'kiro') : null,
    ].filter(Boolean);

    let kiroBin = null;
    for (const c of candidates) {
      try {
        const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
        if (r.status === 0 || (r.stderr && String(r.stderr).toLowerCase().includes('kiro')) || (r.stdout && String(r.stdout).toLowerCase().includes('kiro'))) {
          kiroBin = c;
          break;
        }
      } catch (e) { /* continue checking */ }
    }

    if (!kiroBin) {
      log(`kiro-summary ${key}: Kiro CLI not found on PATH`);
      return { ok: false, notInstalled: true, key, markdown: summary };
    }

    const prompt = `Jira issue ${key} summary and analysis:\n\n${summary}`;

    // Try multiple CLI execution modes supported by kiro
    let runResult = null;
    for (const cliArgs of [['ask', prompt], ['chat', prompt], [prompt]]) {
      try {
        const res = spawnSync(kiroBin, cliArgs, {
          encoding: 'utf8',
          timeout: 25000,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (res.status === 0) {
          runResult = { code: 0, stdout: (res.stdout || 'Summary successfully sent to Kiro CLI.').trim() };
          break;
        }
      } catch (e) {}
    }

    // Fallback: spawn and stream prompt through stdin
    if (!runResult) {
      runResult = await new Promise((resolve) => {
        try {
          const proc = require('child_process').spawn(kiroBin, ['ask'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 25000 });
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (d) => { stdout += d; });
          proc.stderr.on('data', (d) => { stderr += d; });
          proc.on('close', (code) => resolve({ code: code || 0, stdout: (stdout || stderr || 'Summary sent to Kiro CLI.').trim() }));
          proc.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
          proc.stdin.write(prompt);
          proc.stdin.end();
        } catch (err) {
          resolve({ code: -1, stdout: '', stderr: err.message });
        }
      });
    }

    log(`kiro-summary ${key}: exit ${runResult.code}`);
    return {
      ok: runResult.code === 0,
      key,
      kiroResponse: runResult.stdout || runResult.stderr || 'Summary sent to Kiro CLI.',
      markdown: summary,
    };
  });

  // ---- request handling -------------------------------------------------
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { ...headers, 'Cache-Control': 'no-cache', 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string' || candidate.length !== sessionToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(sessionToken));
  }

  async function handler(req, res) {
    const started = Date.now();
    let url;
    try {
      // Block DNS-rebinding: only accept our own host names.
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'Forbidden host.');
      url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === '/health') {
        sendJson(res, 200, { app: 'jira-app', ok: true }, headers);
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        if ((url.pathname === '/' || url.pathname === '/index.html') && (!activeCfg.apiToken || !client)) {
          res.writeHead(302, { Location: '/setup-web.html' });
          res.end();
          return;
        }
        serveStatic(req, res, url.pathname);
        return;
      }

      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) throw new HttpError(404, 'Unknown API endpoint.');

      // CSRF protection: API calls must come from this app's own page.
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'Cross-origin request blocked.');
      const viaHeader = req.headers[CLIENT_HEADER] === '1';
      const viaToken = match.opts.tokenInQuery && tokenMatches(url.searchParams.get('t'));
      if (!viaHeader && !viaToken) throw new HttpError(403, 'Request must come from the Jira App page.');

      const params = match.pattern.exec(url.pathname).slice(1).map((p) => decodeURIComponent(p));
      const body = match.opts.json ? await readJson(req) : undefined;
      const result = await match.handler({ req, res, params, query: url.searchParams, body });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result, headers);
      if (req.method !== 'GET' && typeof deps.onMutation === 'function' && !url.pathname.startsWith('/api/me')) {
        const keys = new Set();
        params.forEach((p) => { if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(p)) keys.add(p.toUpperCase()); });
        if (body && typeof body === 'object') {
          ['fromKey', 'toKey'].forEach((k) => { if (typeof body[k] === 'string') keys.add(body[k].toUpperCase()); });
        }
        if (result && typeof result.key === 'string') keys.add(result.key);
        try { deps.onMutation([...keys]); } catch (e) { /* ignore */ }
      }
      log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof JiraError || err instanceof personal.ValidationError ? err.status : 500;
      if (status >= 500) log(`ERROR ${req.method} ${url ? url.pathname : req.url}: ${err.stack || err.message}`);
      else log(`${req.method} ${url ? url.pathname : req.url} ${status}: ${err.message}`);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status === 500 && !(err instanceof JiraError) ? 'Unexpected error in Jira App. See logs\\server.log.' : err.message,
          details: err instanceof JiraError ? err.details : undefined,
        }, headers);
      } else {
        res.destroy();
      }
    }
  }

  const server = http.createServer((req, res) => { handler(req, res); });
  return { server, sessionToken, client };
}

module.exports = { createApp, fieldValueToText, buildExtraFields, mapSearchIssue };
