/* Jira App - issue tabs: description, comments, analysis, attachments, links, work log, history, all fields. */
'use strict';

(function (JA) {
  const { h } = JA;
  JA.tabs = {};

  // ---- Description -------------------------------------------------------
  JA.tabs.description = (ctx) => {
    const { data, reload } = ctx;
    const html = data.issue.renderedFields && data.issue.renderedFields.description;
    const box = h('div');
    const view = () => JA.mount(box,
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: edit }, '✎ Edit description')),
      html ? h('div', { class: 'rich' }, JA.safeHtml(html)) : h('p', { class: 'muted' }, 'No description.'));
    const edit = () => {
      const ta = h('textarea', { id: 'desc-edit', rows: 18, value: data.descriptionText });
      JA.mount(box,
        h('label', { for: 'desc-edit' }, 'Description (plain text)'),
        h('p', { class: 'small muted' }, 'Blank line = new paragraph, "- " = bullet, "1. " = numbered list. Saving replaces rich formatting (tables, colours, images) with plain text - use Jira for complex formatting.'),
        ta,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', type: 'button', onclick: view }, 'Cancel'),
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await JA.api.put(`/api/issue/${data.issue.key}`, { descriptionText: ta.value });
                JA.toast('Description saved', 'ok');
                reload('description');
              } catch (err) { e.target.disabled = false; }
            },
          }, 'Save')));
      ta.focus();
    };
    view();
    return box;
  };

  // ---- Sub-tasks ---------------------------------------------------------
  const isDone = (s) => !!(s && s.fields && s.fields.status && s.fields.status.statusCategory && s.fields.status.statusCategory.key === 'done');
  /** Turns an entry of the Jira "subtasks" field into the list-row shape used by /api/search. */
  const fromSubtaskField = (s) => ({
    key: s.key,
    summary: (s.fields && s.fields.summary) || '',
    type: (s.fields && s.fields.issuetype && s.fields.issuetype.name) || 'Sub-task',
    priority: (s.fields && s.fields.priority && s.fields.priority.name) || '',
    status: s.fields && s.fields.status ? { name: s.fields.status.name, category: s.fields.status.statusCategory && s.fields.status.statusCategory.key } : null,
    assignee: '',
  });

  JA.tabs.subtasks = (ctx) => {
    const { data, reload } = ctx;
    const { issue } = data;
    const f = issue.fields;
    const key = issue.key;

    // A sub-task cannot have its own sub-tasks in Jira - point to the parent instead.
    if (f.issuetype && f.issuetype.subtask) {
      return h('div', null,
        h('p', null, 'This issue is a sub-task of ',
          f.parent ? h('a', { href: `#/issue/${f.parent.key}?tab=subtasks` }, f.parent.key) : 'its parent',
          f.parent && f.parent.fields ? ` ${f.parent.fields.summary}` : '', '.'),
        f.parent ? h('a', { class: 'btn', href: `#/issue/${f.parent.key}?tab=subtasks` }, '↑ Open parent and its sub-tasks') : null);
    }

    const fieldSubs = f.subtasks || [];
    const done = fieldSubs.filter(isDone).length;
    const pct = fieldSubs.length ? Math.round((done / fieldSubs.length) * 100) : 0;
    const listBox = h('ul', { class: 'work-list subtask-list', 'aria-label': `Sub-tasks of ${key}` });
    const onChanged = () => reload('subtasks');

    const renderList = (items) => {
      if (!items.length) { JA.mount(listBox, h('li', { class: 'muted', style: 'padding:6px 2px' }, 'No sub-tasks yet - add one below.')); return; }
      JA.mount(listBox, items.map((i) => JA.issueListItem(i, onChanged)));
    };
    // Show what the issue already tells us right away, then enrich with assignee/priority from search.
    renderList(fieldSubs.map(fromSubtaskField));
    if (fieldSubs.length) {
      const jql = `parent = ${key} ORDER BY created ASC`;
      JA.api.get(`/api/search?maxResults=100&jql=${encodeURIComponent(jql)}`, { quiet: true }).then((res) => {
        if (!document.body.contains(listBox)) return;
        const found = new Map((res.issues || []).map((i) => [i.key, i]));
        // Keep Jira's sub-task order; newly created ones may not be indexed for search yet.
        renderList(fieldSubs.map((s) => found.get(s.key) || fromSubtaskField(s)));
      }).catch(() => { /* keep the basic list */ });
    }

    // Quick add: summary only, using the project's sub-task issue type.
    const summary = h('input', { id: 'subtask-summary', type: 'text', maxlength: 255, placeholder: 'What needs to be done?', autocomplete: 'off' });
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, '＋ Add sub-task');
    const error = h('p', { class: 'error-text small', role: 'alert' });
    const form = h('form', { class: 'subtask-add', novalidate: true },
      h('label', { for: 'subtask-summary' }, 'Add a sub-task'),
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, summary, addBtn),
      error,
      h('p', { class: 'small muted' }, 'Need more fields? ', h('a', { href: `#/create?parent=${encodeURIComponent(key)}` }, 'Open the full create form'), '.'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const text = summary.value.trim();
      if (!text) { error.textContent = 'Enter a summary for the sub-task.'; summary.focus(); return; }
      const projectKey = f.project && f.project.key;
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      try {
        const types = await JA.api.get(`/api/projects/${encodeURIComponent(projectKey)}/issuetypes`, { quiet: true });
        const subType = types.find((t) => t.subtask);
        if (!subType) throw new Error(`Project ${projectKey} has no sub-task issue type.`);
        const created = await JA.api.post('/api/issue', { projectKey, issueTypeId: subType.id, summary: text, parentKey: key }, { quiet: true });
        JA.toast(`✓ Created sub-task ${created.key}`, 'ok');
        reload('subtasks');
      } catch (err) {
        error.textContent = err.message;
        addBtn.disabled = false;
        addBtn.textContent = '＋ Add sub-task';
      }
    });

    return h('div', null,
      f.parent ? h('p', { class: 'small muted' }, 'Parent: ', h('a', { href: `#/issue/${f.parent.key}` }, f.parent.key), f.parent.fields ? ` ${f.parent.fields.summary}` : '') : null,
      h('h3', null, `Sub-tasks (${done}/${fieldSubs.length} done)`),
      fieldSubs.length ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Sub-tasks done' }, h('span', { style: `width:${pct}%` })) : null,
      listBox,
      form);
  };

  // ---- Comments ----------------------------------------------------------
  JA.tabs.comments = (ctx) => {
    const { data, reload } = ctx;
    const ta = h('textarea', { id: 'new-comment', rows: 4, placeholder: 'Write a comment…' });
    const submit = async (e) => {
      if (!ta.value.trim()) { JA.toast('Comment is empty', 'error'); return; }
      e.target.disabled = true;
      try {
        await JA.api.post(`/api/issue/${data.issue.key}/comment`, { text: ta.value });
        JA.toast('Comment added', 'ok');
        reload('comments');
      } catch (err) { e.target.disabled = false; }
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit({ target: ta }); });
    return h('div', null,
      h('label', { for: 'new-comment' }, 'Add a comment'),
      ta,
      h('div', { class: 'row end' }, h('span', { class: 'small muted' }, 'Ctrl+Enter to send'), h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Add comment')),
      h('h3', null, `Comments (${data.commentsTotal})`),
      data.comments.length
        ? data.comments.map((c) => h('article', { class: 'comment' },
          h('div', { class: 'meta' }, h('strong', null, c.author ? c.author.displayName : 'Unknown'), ` · ${JA.fmtDate(c.created)}`, c.updated && c.updated !== c.created ? ' · edited' : ''),
          h('div', { class: 'rich' }, JA.safeHtml(c.renderedBody || ''))))
        : h('p', { class: 'muted' }, 'No comments yet.'));
  };

  // ---- Analysis ----------------------------------------------------------
  JA.tabs.analysis = (ctx) => {
    const box = h('div', { class: 'analysis' }, JA.spinner('Analysing ticket…'));
    JA.api.get(`/api/issue/${ctx.data.issue.key}/analysis`, { quiet: true }).then((a) => {
      const section = (title, items, cls, empty) => [
        h('h3', null, `${title}${items ? ` (${items.length})` : ''}`),
        items && items.length ? h('ul', { class: cls || '' }, items.map((i) => h('li', null, i))) : h('p', { class: 'muted' }, empty || 'None found.'),
      ];
      const tables = a.tables.map((rows, i) => h('div', { class: 'table-wrap' },
        h('h3', null, `Table ${i + 1}`),
        h('table', { class: 'data' },
          h('thead', null, h('tr', null, (rows[0] || []).map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, rows.slice(1).map((r) => h('tr', null, r.map((c) => h('td', null, c))))))));
      JA.mount(box,
        h('div', { class: 'row end' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => JA.postToKiro(a.facts.key), title: 'Post summary of this issue to Kiro CLI' }, '🤖 Post to Kiro CLI'),
          h('button', { class: 'btn', type: 'button', onclick: () => JA.copy(a.markdown, 'Analysis') }, 'Copy as Markdown'),
          h('button', { class: 'btn', type: 'button', onclick: () => JA.download(`${a.facts.key}-analysis.md`, a.markdown) }, 'Download .md'),
          h('button', {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              if (!window.confirm(`Post this analysis as a comment on ${a.facts.key}? Everyone with access to the ticket will see it.`)) return;
              await JA.api.post(`/api/issue/${a.facts.key}/comment`, { text: a.markdown.replace(/\*\*/g, '') });
              JA.toast('Analysis posted as a comment', 'ok');
              ctx.reload('comments');
            },
          }, 'Post as comment')),
        h('p', { class: 'small muted' }, `Rule-based analysis computed locally from the description (${a.stats.descriptionWords} words), ${a.stats.comments} comment(s) and ticket fields. Review before sharing.`),
        h('h3', null, 'Objective'), h('p', null, a.objective || h('span', { class: 'muted' }, 'Not stated.')),
        section('Acceptance criteria', a.acceptanceCriteria),
        section('Business rules to implement', a.rules),
        tables.length ? h('div', null, h('h3', null, 'Tables from the description'), tables) : null,
        section('Open questions / items to clarify', a.openItems, 'warn', 'Nothing flagged as TBD or a question.'),
        section('Possible contradictions to confirm', a.possibleConflicts, 'warn', 'None detected.'),
        section('Ticket hygiene', a.hygiene, 'warn', 'Looks complete.'),
        section('Suggested test scenarios', a.testScenarios),
        h('details', null, h('summary', null, 'Markdown report'), h('pre', { class: 'markdown' }, a.markdown)));
    }).catch((err) => JA.mount(box, h('p', { class: 'error-text' }, err.message)));
    return box;
  };

  // ---- Attachments -------------------------------------------------------
  JA.tabs.attachments = (ctx) => {
    const { data, reload } = ctx;
    const files = data.issue.fields.attachment || [];
    const input = h('input', { type: 'file', id: 'upload', multiple: true });
    const upload = async (e) => {
      if (!input.files.length) { JA.toast('Choose one or more files first', 'error'); return; }
      const form = new FormData();
      for (const f of input.files) form.append('file', f, f.name);
      e.target.disabled = true;
      e.target.textContent = 'Uploading…';
      try {
        await JA.api.post(`/api/issue/${data.issue.key}/attachments`, form);
        JA.toast('Uploaded', 'ok');
        reload('attachments');
      } catch (err) {
        e.target.disabled = false;
        e.target.textContent = 'Upload';
      }
    };
    return h('div', null,
      h('label', { for: 'upload' }, 'Upload files (max 50 MB total)'),
      h('div', { class: 'row' }, input, h('button', { class: 'btn primary', type: 'button', onclick: upload }, 'Upload')),
      h('h3', null, `Attachments (${files.length})`),
      files.length
        ? h('div', { class: 'attachments' }, files.map((f) => h('div', { class: 'attachment' },
          /^image\//.test(f.mimeType || '') ? h('a', { href: JA.attachmentUrl(f.id), target: '_blank', rel: 'noopener' }, h('img', { src: JA.attachmentUrl(f.id), alt: f.filename, loading: 'lazy' })) : null,
          h('a', { href: JA.attachmentUrl(f.id, true), download: f.filename }, f.filename),
          h('div', { class: 'muted' }, `${JA.bytes(f.size)} · ${f.author ? f.author.displayName : ''} · ${JA.fmtDate(f.created, false)}`))))
        : h('p', { class: 'muted' }, 'No attachments.'));
  };

  // ---- Links -------------------------------------------------------------
  JA.tabs.links = (ctx) => {
    const { data, reload } = ctx;
    const f = data.issue.fields;
    const issueLinks = f.issuelinks || [];
    const subtasks = f.subtasks || [];
    const typeSelect = h('select', { id: 'link-type' }, h('option', { value: '' }, 'Loading link types…'));
    const target = h('input', { id: 'link-target', type: 'text', placeholder: 'e.g. FUL2-123456', autocomplete: 'off' });
    JA.api.get('/api/link-types', { quiet: true }).then((types) => {
      JA.mount(typeSelect, types.flatMap((t) => [
        h('option', { value: `${t.name}|outward` }, `${data.issue.key} ${t.outward} …`),
        t.inward !== t.outward ? h('option', { value: `${t.name}|inward` }, `${data.issue.key} ${t.inward} …`) : null,
      ]));
    }).catch(() => JA.mount(typeSelect, h('option', { value: '' }, 'Could not load link types')));

    const add = async (e) => {
      const [typeName, direction] = typeSelect.value.split('|');
      const toKey = target.value.trim().toUpperCase();
      if (!typeName || !JA.issueKeyRe.test(toKey)) { JA.toast('Choose a link type and enter a valid issue key', 'error'); return; }
      e.target.disabled = true;
      try {
        await JA.api.post('/api/issue-link', { typeName, direction, fromKey: data.issue.key, toKey });
        JA.toast('Link created', 'ok');
        reload('links');
      } catch (err) { e.target.disabled = false; }
    };

    const issueItem = (relation, other) => h('tr', null,
      h('td', { class: 'nowrap' }, relation),
      h('td', { class: 'nowrap' }, h('a', { href: `#/issue/${other.key}` }, other.key)),
      h('td', null, other.fields ? other.fields.summary : ''),
      h('td', null, other.fields && other.fields.status ? JA.statusBadge(other.fields.status) : ''));

    return h('div', null,
      f.parent ? h('p', null, 'Parent: ', h('a', { href: `#/issue/${f.parent.key}` }, f.parent.key), ` ${f.parent.fields ? f.parent.fields.summary : ''}`) : null,
      h('h3', null, `Linked issues (${issueLinks.length})`),
      issueLinks.length
        ? h('table', { class: 'data' }, h('tbody', null, issueLinks.map((l) => (l.outwardIssue ? issueItem(l.type.outward, l.outwardIssue) : issueItem(l.type.inward, l.inwardIssue)))))
        : h('p', { class: 'muted' }, 'No linked issues.'),
      subtasks.length ? [h('h3', null, `Sub-tasks (${subtasks.length})`), h('table', { class: 'data' }, h('tbody', null, subtasks.map((s) => issueItem('sub-task', s))))] : null,
      h('h3', null, `Web links (${data.remoteLinks.length})`),
      data.remoteLinks.length
        ? h('ul', null, data.remoteLinks.map((r) => {
          const url = r.object && r.object.url;
          const safe = url && /^https?:\/\//i.test(url) ? url : null;
          return h('li', null, safe ? h('a', { href: safe, target: '_blank', rel: 'noopener noreferrer' }, r.object.title || safe) : (r.object && r.object.title) || 'link');
        }))
        : h('p', { class: 'muted' }, 'No web links.'),
      h('h3', null, 'Add a link'),
      h('div', { class: 'form-grid' },
        h('div', null, h('label', { for: 'link-type' }, 'Relationship'), typeSelect),
        h('div', null, h('label', { for: 'link-target' }, 'Other issue key'), target)),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Create link')));
  };

  // ---- Work log ----------------------------------------------------------
  JA.tabs.worklog = (ctx) => {
    const { data, reload } = ctx;
    const listBox = h('div', null, JA.spinner('Loading work log…'));
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const spent = h('input', { id: 'wl-spent', type: 'text', placeholder: '1h 30m', autocomplete: 'off' });
    const started = h('input', { id: 'wl-started', type: 'datetime-local', value: now });
    const comment = h('textarea', { id: 'wl-comment', rows: 3, placeholder: 'What did you work on? (optional)' });
    const submit = async (e) => {
      if (!/^\s*(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(spent.value)) { JA.toast('Time spent must look like 1h 30m, 2h or 1d', 'error'); return; }
      e.target.disabled = true;
      try {
        await JA.api.post(`/api/issue/${data.issue.key}/worklog`, { timeSpent: spent.value.trim(), started: started.value, commentText: comment.value });
        JA.toast('Work logged', 'ok');
        reload('worklog');
      } catch (err) { e.target.disabled = false; }
    };
    JA.api.get(`/api/issue/${data.issue.key}/worklog`, { quiet: true }).then((logs) => {
      JA.mount(listBox, logs.length
        ? h('table', { class: 'data' },
          h('thead', null, h('tr', null, ['Started', 'Who', 'Time', 'Comment'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, logs.map((w) => h('tr', null, h('td', { class: 'nowrap' }, JA.fmtDate(w.started)), h('td', null, w.author), h('td', null, w.timeSpent), h('td', null, w.comment)))))
        : h('p', { class: 'muted' }, 'No work logged.'));
    }).catch((err) => JA.mount(listBox, h('p', { class: 'error-text' }, err.message)));
    const tt = data.issue.fields.timetracking || {};
    return h('div', null,
      h('p', null, `Original estimate: ${tt.originalEstimate || '-'} · Remaining: ${tt.remainingEstimate || '-'} · Logged: ${tt.timeSpent || '-'}`),
      h('div', { class: 'form-grid' },
        h('div', null, h('label', { for: 'wl-spent' }, 'Time spent'), spent),
        h('div', null, h('label', { for: 'wl-started' }, 'Started'), started),
        h('div', { class: 'wide' }, h('label', { for: 'wl-comment' }, 'Comment'), comment)),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Log work')),
      h('h3', null, 'Work log'),
      listBox);
  };

  // ---- History -----------------------------------------------------------
  JA.tabs.history = (ctx) => {
    const histories = ((ctx.data.issue.changelog && ctx.data.issue.changelog.histories) || []).slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
    if (!histories.length) return h('p', { class: 'muted' }, 'No history.');
    return h('div', { class: 'history' },
      ctx.data.issue.changelog.total > histories.length ? h('p', { class: 'small muted' }, `Showing latest ${histories.length} of ${ctx.data.issue.changelog.total} changes. Open in Jira for the full history.`) : null,
      histories.map((hst) => h('div', { class: 'history-item' },
        h('div', { class: 'meta' }, h('strong', null, hst.author ? hst.author.displayName : 'System'), ` · ${JA.fmtDate(hst.created)}`),
        h('ul', null, (hst.items || []).map((it) => h('li', null,
          h('strong', null, it.field), ': ',
          it.fromString ? h('del', null, String(it.fromString).slice(0, 300)) : h('span', { class: 'muted' }, '(empty)'),
          ' → ',
          it.toString ? String(it.toString).slice(0, 300) : h('span', { class: 'muted' }, '(empty)')))))));
  };

  // ---- All fields --------------------------------------------------------
  JA.tabs.fields = (ctx) => {
    const filter = h('input', { type: 'search', placeholder: 'Filter fields…', 'aria-label': 'Filter fields' });
    const tbody = h('tbody');
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      JA.mount(tbody, ctx.data.allFields
        .filter((f) => !q || f.name.toLowerCase().includes(q) || f.value.toLowerCase().includes(q) || f.id.toLowerCase().includes(q))
        .map((f) => h('tr', null, h('th', { scope: 'row', title: f.id }, f.name), h('td', { style: 'white-space:pre-wrap' }, f.value.length > 3000 ? `${f.value.slice(0, 3000)}…` : f.value))));
    };
    filter.addEventListener('input', render);
    render();
    return h('div', null, h('p', { class: 'small muted' }, `${ctx.data.allFields.length} non-empty fields (including custom fields).`), filter, h('table', { class: 'data' }, tbody));
  };
})(window.JA);
