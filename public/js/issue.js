/* Jira App - issue view: header (summary, status, transitions), details panel, tabs. */
'use strict';

(function (JA) {
  const { h } = JA;

  const TABS = [
    { id: 'description', label: 'Description' },
    { id: 'subtasks', label: 'Sub-tasks' },
    { id: 'mine', label: '★ Mine' },
    { id: 'comments', label: 'Comments' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'attachments', label: 'Attachments' },
    { id: 'links', label: 'Links' },
    { id: 'worklog', label: 'Work log' },
    { id: 'history', label: 'History' },
    { id: 'fields', label: 'All fields' },
  ];

  function fieldByName(issue, ...names) {
    const wanted = names.map((n) => n.toLowerCase());
    for (const [id, name] of Object.entries(issue.names || {})) {
      if (wanted.includes(String(name).toLowerCase())) {
        const v = issue.fields[id];
        if (v !== null && v !== undefined && v !== '') return v;
      }
    }
    return undefined;
  }

  function sprintText(value) {
    if (!value) return '';
    const list = Array.isArray(value) ? value : [value];
    return list.map((s) => (typeof s === 'object' ? `${s.name}${s.state ? ` (${s.state.toLowerCase()})` : ''}` : String(s))).join(', ');
  }

  // ---- summary (inline edit) ---------------------------------------------------
  function summaryBlock(data, reload) {
    const box = h('div');
    const view = () => JA.mount(box,
      h('h1', { class: 'issue-title' }, data.issue.fields.summary,
        h('button', { class: 'btn link', type: 'button', 'aria-label': 'Edit summary', title: 'Edit summary', onclick: edit }, ' ✎')));
    const edit = () => {
      const input = h('input', { type: 'text', value: data.issue.fields.summary, maxlength: 255, 'aria-label': 'Summary', style: 'width:100%;font-size:18px' });
      const save = async () => {
        if (!input.value.trim()) { JA.toast('Summary cannot be empty', 'error'); return; }
        try {
          await JA.api.put(`/api/issue/${data.issue.key}`, { summary: input.value });
          JA.toast('Summary saved', 'ok');
          reload();
        } catch (err) { /* toast shown */ }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') view(); });
      JA.mount(box, input, h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: view }, 'Cancel'), h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save')));
      input.focus();
      input.select();
    };
    view();
    return box;
  }

  // ---- status / transitions ---------------------------------------------------
  function transitionControl(data, reload) {
    const { key } = data.issue;
    const summary = data.issue.fields.summary;
    const holder = h('div');
    const draw = () => JA.mount(holder, h('div', { class: 'row' },
      JA.statusPicker(key, data.issue.fields.status, () => reload()),
      JA.focusToggle(key, summary),
      JA.timerButton(key, summary),
      JA.logWorkButton(key, summary, () => reload()),
      JA.personalMarks(key),
      data.issue.fields.duedate ? JA.dueChip({ duedate: data.issue.fields.duedate, status: { category: data.issue.fields.status && data.issue.fields.status.statusCategory && data.issue.fields.status.statusCategory.key } }) : null,
      data.issue.fields.resolution ? h('span', { class: 'muted small' }, `Resolution: ${data.issue.fields.resolution.name}`) : null));
    draw();
    const off = JA.me.onChange(() => { if (!document.body.contains(holder)) { off(); return; } draw(); });
    return holder;
  }

  // ---- assignee ------------------------------------------------------------
  function assigneeControl(data, reload) {
    const f = data.issue.fields;
    const box = h('div');
    const assign = async (accountId, label) => {
      try {
        await JA.api.put(`/api/issue/${data.issue.key}/assignee`, { accountId });
        JA.toast(`Assigned to ${label}`, 'ok');
        reload();
      } catch (err) { /* toast shown */ }
    };
    const view = () => JA.mount(box,
      h('div', { class: 'row', style: 'gap:6px' }, JA.avatar(f.assignee && f.assignee.displayName, 24), f.assignee ? f.assignee.displayName : h('span', { class: 'muted' }, 'Unassigned')),
      h('div', { class: 'row' },
        h('button', { class: 'btn link', type: 'button', onclick: () => assign('me', 'you') }, 'Assign to me'),
        h('button', { class: 'btn link', type: 'button', onclick: edit }, 'Change'),
        f.assignee ? h('button', { class: 'btn link', type: 'button', onclick: () => assign(null, 'nobody') }, 'Unassign') : null));
    const edit = () => {
      const input = h('input', { type: 'search', placeholder: 'Type a name or e-mail…', 'aria-label': 'Search people to assign', autocomplete: 'off', style: 'width:100%' });
      const results = h('ul', { class: 'user-results', hidden: true });
      let timer;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            const users = await JA.api.get(`/api/issue/${data.issue.key}/assignable?query=${encodeURIComponent(input.value)}`, { quiet: true });
            results.hidden = false;
            JA.mount(results, users.length
              ? users.map((u) => h('li', null, h('button', { type: 'button', onclick: () => assign(u.accountId, u.displayName) }, u.displayName, u.emailAddress ? h('span', { class: 'muted small' }, ` ${u.emailAddress}`) : null)))
              : h('li', { class: 'muted', style: 'padding:6px 10px' }, 'No assignable users found.'));
          } catch (err) {
            results.hidden = false;
            JA.mount(results, h('li', { class: 'error-text', style: 'padding:6px 10px' }, err.message));
          }
        }, 300);
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape') view(); });
      JA.mount(box, input, results, h('button', { class: 'btn link', type: 'button', onclick: view }, 'Cancel'));
      input.focus();
      input.dispatchEvent(new Event('input'));
    };
    view();
    return box;
  }

  // ---- priority / labels / due date -------------------------------------------
  function priorityControl(data, reload) {
    const f = data.issue.fields;
    const box = h('div', null, f.priority ? f.priority.name : '-', ' ',
      h('button', {
        class: 'btn link',
        type: 'button',
        onclick: async () => {
          let meta;
          try { meta = await JA.api.get(`/api/issue/${data.issue.key}/editmeta`); } catch (err) { return; }
          if (!meta.priorities.length) { JA.toast('Priority cannot be edited on this issue', 'error'); return; }
          const select = h('select', { 'aria-label': 'Priority' }, meta.priorities.map((p) => h('option', { value: p.id, selected: f.priority && f.priority.id === p.id }, p.name)));
          JA.mount(box, select,
            h('button', {
              class: 'btn link',
              type: 'button',
              onclick: async () => {
                try {
                  await JA.api.put(`/api/issue/${data.issue.key}`, { priorityId: select.value });
                  JA.toast('Priority saved', 'ok');
                  reload();
                } catch (err) { /* toast shown */ }
              },
            }, 'Save'));
          select.focus();
        },
      }, 'Change'));
    return box;
  }

  function labelsControl(data, reload) {
    const labels = data.issue.fields.labels || [];
    const box = h('div');
    const view = () => JA.mount(box,
      labels.length ? labels.map((l) => h('a', { class: 'chip', href: JA.searchHref(`labels = "${l.replace(/"/g, '\\"')}" ORDER BY updated DESC`) }, l)) : h('span', { class: 'muted' }, 'None'),
      ' ', h('button', { class: 'btn link', type: 'button', onclick: edit }, 'Edit'));
    const edit = () => {
      const input = h('input', { type: 'text', value: labels.join(', '), 'aria-label': 'Labels separated by commas', style: 'width:100%' });
      const save = async () => {
        try {
          await JA.api.put(`/api/issue/${data.issue.key}`, { labels: input.value });
          JA.toast('Labels saved', 'ok');
          reload();
        } catch (err) { /* toast shown */ }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') view(); });
      JA.mount(box, input, h('div', { class: 'row' }, h('button', { class: 'btn link', type: 'button', onclick: save }, 'Save'), h('button', { class: 'btn link', type: 'button', onclick: view }, 'Cancel')));
      input.focus();
    };
    view();
    return box;
  }

  function dueDateControl(data, reload) {
    const due = data.issue.fields.duedate;
    const input = h('input', { type: 'date', value: due || '', 'aria-label': 'Due date' });
    input.addEventListener('change', async () => {
      try {
        await JA.api.put(`/api/issue/${data.issue.key}`, { duedate: input.value || null });
        JA.toast('Due date saved', 'ok');
        reload();
      } catch (err) { /* toast shown */ }
    });
    return input;
  }

  function detailsPanel(data, reload) {
    const { issue } = data;
    const f = issue.fields;
    const rows = [
      ['Assignee', assigneeControl(data, reload)],
      ['Reporter', f.reporter ? f.reporter.displayName : '-'],
      ['Priority', priorityControl(data, reload)],
      ['Type', f.issuetype ? f.issuetype.name : '-'],
      ['Project', f.project ? `${f.project.name} (${f.project.key})` : '-'],
      ['Labels', labelsControl(data, reload)],
      ['Due date', dueDateControl(data, reload)],
      ['Components', (f.components || []).map((c) => c.name).join(', ') || '-'],
      ['Fix versions', (f.fixVersions || []).map((v) => v.name).join(', ') || '-'],
      ['Sprint', sprintText(fieldByName(issue, 'Sprint')) || '-'],
      ['Story points', String(fieldByName(issue, 'Story Points', 'Story point estimate') ?? '-')],
      ['Epic / parent', f.parent ? h('a', { href: `#/issue/${f.parent.key}` }, `${f.parent.key} ${f.parent.fields ? f.parent.fields.summary : ''}`) : '-'],
      ['Resolution', f.resolution ? f.resolution.name : 'Unresolved'],
      ['Created', JA.fmtDate(f.created)],
      ['Updated', JA.fmtDate(f.updated)],
      ['Watchers', f.watches ? String(f.watches.watchCount) : '-'],
    ];
    return h('aside', { class: 'card details', 'aria-label': 'Issue details' },
      h('dl', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  JA.renderIssue = async (main, key, params, opts = {}) => {
    const embedded = !!opts.embedded;
    JA.mount(main, JA.spinner(`Loading ${key}…`));
    let data;
    try {
      data = await JA.api.get(`/api/issue/${encodeURIComponent(key)}`, { quiet: true });
    } catch (err) {
      JA.mount(main, h('div', { class: 'card' }, h('h1', null, key), h('p', { class: 'error-text' }, err.message),
        h('p', null, h('a', { href: JA.jiraBrowseUrl(key), target: '_blank', rel: 'noopener noreferrer' }, 'Try opening it in Jira ↗'))));
      return;
    }
    if (!document.body.contains(main)) return; // drawer closed / navigated away while loading
    const { issue } = data;
    if (!embedded) document.title = `${issue.key} ${issue.fields.summary} - Jira App`;
    JA.rememberRecent(issue.key, issue.fields.summary);
    JA.renderSidebar();

    let activeTab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'description';
    const reload = (tab) => {
      if (embedded) {
        JA.renderIssue(main, issue.key, new URLSearchParams({ tab: tab || activeTab }), opts);
        if (opts.onChange) opts.onChange(issue.key);
        return;
      }
      const target = `#/issue/${issue.key}${tab ? `?tab=${tab}` : (activeTab !== 'description' ? `?tab=${activeTab}` : '')}`;
      if (location.hash === target) JA.route(); else location.hash = target;
    };

    const tabPanelId = embedded ? 'drawer-tabpanel' : 'tabpanel';
    const tabPanel = h('div', { role: 'tabpanel', id: tabPanelId, tabindex: '0' });
    const tabButtons = TABS.map((t) => {
      let label = t.label;
      if (t.id === 'comments') label += ` (${data.commentsTotal})`;
      if (t.id === 'subtasks') {
        const subs = issue.fields.subtasks || [];
        const done = subs.filter((s) => s.fields && s.fields.status && s.fields.status.statusCategory && s.fields.status.statusCategory.key === 'done').length;
        label += subs.length ? ` (${done}/${subs.length})` : ' (0)';
      }
      if (t.id === 'attachments') label += ` (${(issue.fields.attachment || []).length})`;
      if (t.id === 'links') label += ` (${(issue.fields.issuelinks || []).length + data.remoteLinks.length})`;
      return h('button', { role: 'tab', type: 'button', id: `${embedded ? 'd-' : ''}tab-${t.id}`, 'aria-controls': tabPanelId, 'aria-selected': t.id === activeTab ? 'true' : 'false', tabindex: t.id === activeTab ? '0' : '-1', dataset: { tab: t.id } }, label);
    });
    const ctx = { data, reload };
    const showTab = (id, focus) => {
      activeTab = id;
      tabButtons.forEach((b) => { const on = b.dataset.tab === id; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
      tabPanel.setAttribute('aria-labelledby', `${embedded ? 'd-' : ''}tab-${id}`);
      JA.mount(tabPanel, JA.tabs[id](ctx));
      if (!embedded) history.replaceState(null, '', `#/issue/${issue.key}${id === 'description' ? '' : `?tab=${id}`}`);
    };
    const tabList = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Issue sections' }, tabButtons);
    tabList.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
    tabList.addEventListener('keydown', (e) => {
      const idx = tabButtons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
        showTab(tabButtons[next].dataset.tab, true);
      }
    });

    JA.mount(main,
      h('div', { class: 'issue-head' },
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { class: 'row breadcrumb' },
            !embedded && JA.state.lastSearch ? h('a', { href: JA.searchHref(JA.state.lastSearch), class: 'small' }, '← Back to results') : null,
            JA.typeIcon(issue.fields.issuetype && issue.fields.issuetype.name),
            h('span', { class: 'issue-key' }, `${issue.fields.project ? issue.fields.project.name : ''} / `,
              issue.fields.parent ? [h('a', { href: `#/issue/${issue.fields.parent.key}`, title: issue.fields.parent.fields ? issue.fields.parent.fields.summary : '' }, issue.fields.parent.key), ' / '] : null,
              issue.key)),
          summaryBlock(data, reload),
          transitionControl(data, reload)),
        h('div', { class: 'row issue-actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => JA.postToKiro(issue.key), title: 'Post summary of this issue to Kiro CLI' }, '🤖 Kiro Summary'),
          h('button', { class: 'btn', type: 'button', onclick: () => JA.copy(issue.key, 'Key'), title: 'Copy key' }, '⧉ Key'),
          h('button', { class: 'btn', type: 'button', onclick: () => JA.copy(JA.jiraBrowseUrl(issue.key), 'Link'), title: 'Copy Jira link' }, '🔗 Link'),
          h('button', { class: 'btn', type: 'button', onclick: () => reload(), title: 'Refresh' }, '↻'),
          h('a', { class: 'btn', href: JA.jiraBrowseUrl(issue.key), target: '_blank', rel: 'noopener noreferrer', title: 'Open in Jira' }, 'Jira ↗'))),
      h('div', { class: 'issue-grid' },
        h('section', { class: 'card', 'aria-label': 'Issue content' }, tabList, tabPanel),
        detailsPanel(data, reload)));
    showTab(activeTab);
  };
})(window.JA);
