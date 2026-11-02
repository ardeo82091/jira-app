'use strict';

/**
 * Minimal Jira Cloud REST API v3 client (no dependencies; uses Node's global fetch).
 * Authenticates with e-mail + API token (HTTP Basic), so it has exactly the
 * permissions of the Jira user who owns the token.
 */

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const NUMERIC_ID_RE = /^\d+$/;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

class JiraError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.details = details || null;
  }
}

function assertIssueKey(key) {
  const normalized = String(key || '').trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(normalized)) throw new JiraError(400, `"${key}" is not a valid issue key (expected e.g. FUL2-315620).`);
  return normalized;
}

function assertNumericId(id, label) {
  const value = String(id || '').trim();
  if (!NUMERIC_ID_RE.test(value)) throw new JiraError(400, `${label || 'id'} must be numeric.`);
  return value;
}

function errorMessageFrom(status, body) {
  if (body && typeof body === 'object') {
    const messages = [];
    if (Array.isArray(body.errorMessages)) messages.push(...body.errorMessages);
    if (body.errors && typeof body.errors === 'object') {
      for (const [field, msg] of Object.entries(body.errors)) messages.push(`${field}: ${msg}`);
    }
    if (body.message) messages.push(body.message);
    if (messages.length) return messages.join(' ');
  }
  switch (status) {
    case 401: return 'Jira rejected the credentials. Check the e-mail and API token (run setup.ps1 again).';
    case 403: return 'Your Jira account does not have permission for this action.';
    case 404: return 'Not found in Jira (or you do not have permission to see it).';
    case 429: return 'Jira rate limit reached. Wait a few seconds and try again.';
    default: return `Jira request failed with HTTP ${status}.`;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Formats a Date as Jira expects for worklog "started": 2026-10-30T10:00:00.000+0530 */
function formatJiraDateTime(date) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.trunc(offsetMin / 60))}${pad(offsetMin % 60)}`;
}

class JiraClient {
  constructor({ baseUrl, email, apiToken, fetchImpl, timeoutMs }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    if (typeof this.fetch !== 'function') throw new Error('This app needs Node.js 18 or newer (global fetch).');
  }

  url(path, query) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Performs a request. Options: query, body (JSON), rawBody + contentType, headers, raw (return Response).
   * Retries on 429/503 honouring Retry-After.
   */
  async request(method, path, opts = {}) {
    const headers = { Authorization: this.authHeader, Accept: 'application/json', ...(opts.headers || {}) };
    let body;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await this.fetch(this.url(path, opts.query), {
          method,
          headers,
          body,
          redirect: 'follow',
          signal: AbortSignal.timeout(opts.timeoutMs || this.timeoutMs),
        });
      } catch (err) {
        const reason = err && err.name === 'TimeoutError' ? 'timed out' : (err && err.cause && err.cause.code) || err.message;
        throw new JiraError(502, `Could not reach Jira at ${this.baseUrl} (${reason}). Check your internet/VPN connection.`);
      }

      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1000 * (attempt + 1));
        continue;
      }

      if (opts.raw && res.ok) return res;

      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (err) { data = text; }
      }
      if (!res.ok) throw new JiraError(res.status, errorMessageFrom(res.status, data), data);
      return data;
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body, query) { return this.request('POST', path, { body, query }); }
  put(path, body, query) { return this.request('PUT', path, { body, query }); }

  // ---- user / search ------------------------------------------------------
  myself() { return this.get('/rest/api/3/myself'); }

  searchJql({ jql, nextPageToken, maxResults = 50, fields }) {
    return this.post('/rest/api/3/search/jql', {
      jql,
      maxResults: Math.min(Math.max(Number(maxResults) || 50, 1), 100),
      fields: fields || ['summary', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'updated', 'created', 'project', 'duedate', 'labels', 'parent', 'subtasks'],
      ...(nextPageToken ? { nextPageToken } : {}),
    });
  }

  approximateCount(jql) { return this.post('/rest/api/3/search/approximate-count', { jql }); }

  favouriteFilters() { return this.get('/rest/api/3/filter/favourite'); }

  // ---- issues -------------------------------------------------------------
  getIssue(key) {
    return this.get(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}`, {
      fields: '*all',
      expand: 'renderedFields,names,schema,transitions,changelog',
    });
  }

  getComments(key, startAt = 0) {
    return this.get(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/comment`, {
      startAt, maxResults: 100, orderBy: '-created', expand: 'renderedBody',
    });
  }

  addComment(key, adfBody) {
    return this.post(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/comment`, { body: adfBody }, { expand: 'renderedBody' });
  }

  editIssue(key, fields) {
    return this.put(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}`, { fields });
  }

  editMeta(key) { return this.get(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/editmeta`); }

  transitions(key) {
    return this.get(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/transitions`, { expand: 'transitions.fields' });
  }

  doTransition(key, transitionId, adfComment) {
    const body = { transition: { id: assertNumericId(transitionId, 'transition id') } };
    if (adfComment) body.update = { comment: [{ add: { body: adfComment } }] };
    return this.post(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/transitions`, body);
  }

  assignableUsers(key, query) {
    return this.get('/rest/api/3/user/assignable/search', { issueKey: assertIssueKey(key), query: query || '', maxResults: 20 });
  }

  assign(key, accountId) {
    return this.put(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/assignee`, { accountId: accountId || null });
  }

  worklogs(key) {
    return this.get(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/worklog`, { maxResults: 100 });
  }

  addWorklog(key, { timeSpent, started, adfComment }) {
    const body = { timeSpent, started: formatJiraDateTime(started || new Date()) };
    if (adfComment) body.comment = adfComment;
    return this.post(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/worklog`, body);
  }

  remoteLinks(key) { return this.get(`/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/remotelink`); }

  linkTypes() { return this.get('/rest/api/3/issueLinkType'); }

  createLink({ typeName, inwardKey, outwardKey }) {
    return this.post('/rest/api/3/issueLink', {
      type: { name: typeName },
      inwardIssue: { key: assertIssueKey(inwardKey) },
      outwardIssue: { key: assertIssueKey(outwardKey) },
    });
  }

  createIssue(fields) { return this.post('/rest/api/3/issue', { fields }); }

  // ---- projects / create metadata ----------------------------------------
  projects(query) {
    return this.get('/rest/api/3/project/search', { query: query || '', maxResults: 50, orderBy: 'name' });
  }

  issueTypes(projectKey) {
    return this.get(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`, { maxResults: 100 });
  }

  issueTypeFields(projectKey, issueTypeId) {
    return this.get(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${assertNumericId(issueTypeId, 'issue type id')}`, { maxResults: 200 });
  }

  // ---- attachments --------------------------------------------------------
  attachmentContent(id) {
    return this.request('GET', `/rest/api/3/attachment/content/${assertNumericId(id, 'attachment id')}`, {
      raw: true, headers: { Accept: '*/*' }, timeoutMs: 120000,
    });
  }

  uploadAttachments(key, buffer, contentType) {
    return this.request('POST', `/rest/api/3/issue/${encodeURIComponent(assertIssueKey(key))}/attachments`, {
      rawBody: buffer,
      contentType,
      headers: { 'X-Atlassian-Token': 'no-check' },
      timeoutMs: 300000,
    });
  }
}

module.exports = { JiraClient, JiraError, assertIssueKey, assertNumericId, formatJiraDateTime, ISSUE_KEY_RE };
