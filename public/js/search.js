/* Jira App - search view (JQL, quick filters, saved searches, results table). */
'use strict';

(function (JA) {
  const { h } = JA;

  JA.PRESETS = [
    { name: 'My open issues', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
    { name: 'Reported by me', jql: 'reporter = currentUser() ORDER BY created DESC' },
    { name: 'Watching', jql: 'watcher = currentUser() ORDER BY updated DESC' },
    { name: 'My open sprint', jql: 'assignee = currentUser() AND sprint in openSprints() ORDER BY rank' },
    { name: 'Updated in last 7 days (mine)', jql: 'assignee = currentUser() AND updated >= -7d ORDER BY updated DESC' },
    { name: 'Recently viewed', jql: 'issuekey in issueHistory() ORDER BY lastViewed DESC' },
    { name: 'Created in FUL2 this week', jql: 'project = FUL2 AND created >= startOfWeek() ORDER BY created DESC' },
  ];

  /** Turns the quick-search text into JQL (or an issue key to open). */
  JA.interpretQuery = (raw) => {
    const q = String(raw || '').trim();
    if (!q) return { jql: JA.state.session.defaultJql };
    const urlKey = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/.exec(q);
    if (urlKey) return { key: urlKey[1].toUpperCase() };
    if (JA.issueKeyRe.test(q)) return { key: q.toUpperCase() };
    const looksLikeJql = /(\b(AND|OR|ORDER BY|NOT|IN|IS|WAS|CHANGED)\b|[=~<>!]|\bcurrentUser\(\))/.test(q);
    if (looksLikeJql) return { jql: q };
    const escaped = q.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { jql: `text ~ "${escaped}" ORDER BY updated DESC` };
  };

  JA.searchHref = (jql) => `#/search?jql=${encodeURIComponent(jql)}`;

  const COLUMNS = [
    { id: 'key', label: 'Key' },
    { id: 'type', label: 'Type' },
    { id: 'summary', label: 'Summary' },
    { id: 'status', label: 'Status' },
    { id: 'priority', label: 'Priority' },
    { id: 'assignee', label: 'Assignee' },
    { id: 'reporter', label: 'Reporter' },
    { id: 'updated', label: 'Updated' },
  ];

  function sortValue(issue, col) {
    if (col === 'status') return issue.status ? issue.status.name : '';
    if (col === 'key') {
      const [p, n] = issue.key.split('-');
      return `${p}-${String(n).padStart(10, '0')}`;
    }
    return issue[col] || '';
  }

  function issueRow(issue, onChanged) {
    const open = (e) => JA.openFromEvent(e, issue.key, { onChange: onChanged });
    const row = h('tr', { class: 'clickable' },
      h('td', { class: 'key' }, h('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, JA.typeIcon(issue.type), h('a', { href: `#/issue/${issue.key}`, onclick: open }, issue.key))),
      h('td', { class: 'nowrap' }, issue.type),
      h('td', { class: 'summary' }, h('a', { href: `#/issue/${issue.key}`, onclick: open }, issue.summary), JA.hierarchyChips(issue) ? h('span', { class: 'hier-wrap' }, JA.hierarchyChips(issue)) : null),
      h('td', null, JA.statusPicker(issue.key, issue.status, () => onChanged && onChanged(issue.key))),
      h('td', { class: 'nowrap' }, h('span', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, JA.priorityIcon(issue.priority), issue.priority)),
      h('td', { class: 'nowrap' }, h('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, JA.avatar(issue.assignee, 22), issue.assignee || h('span', { class: 'muted' }, 'Unassigned'))),
      h('td', { class: 'nowrap' }, issue.reporter),
      h('td', { class: 'nowrap', title: JA.fmtDate(issue.updated) }, JA.relTime(issue.updated)));
    row.addEventListener('click', (e) => { if (!e.target.closest('a,button')) JA.openDrawer(issue.key, { onChange: onChanged }); });
    return row;
  }

  function toCsv(issues) {
    const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [COLUMNS.map((c) => c.label).concat('Created').map(esc).join(',')];
    for (const i of issues) {
      lines.push([i.key, i.type, i.summary, i.status ? i.status.name : '', i.priority, i.assignee, i.reporter, i.updated, i.created].map(esc).join(','));
    }
    return `\ufeff${lines.join('\r\n')}`;
  }

  JA.renderSearch = async (main, params) => {
    const jql = params.get('jql') || JA.state.session.defaultJql;
    const state = { issues: [], nextPageToken: null, isLast: true, sort: null, dir: 1 };
    JA.state.lastSearch = jql;

    const jqlInput = h('textarea', { id: 'jql', 'aria-label': 'JQL query', spellcheck: 'false', value: jql });
    jqlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); location.hash = JA.searchHref(jqlInput.value.trim()); }
    });
    const countEl = h('span', { class: 'muted' });
    const tbody = h('tbody');
    const moreBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => load(true) }, 'Load more');
    const statusEl = h('div', { 'aria-live': 'polite' });
    const headRow = h('tr', null, COLUMNS.map((c) => h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: () => sortBy(c.id), 'aria-label': `Sort by ${c.label}` }, c.label, h('span', { class: 'sort-ind', 'data-col': c.id })))));

    function renderRows() {
      let rows = state.issues.slice();
      if (state.sort) rows.sort((a, b) => String(sortValue(a, state.sort)).localeCompare(String(sortValue(b, state.sort))) * state.dir);
      JA.mount(tbody, rows.map((r) => issueRow(r, () => load(false))));
      headRow.querySelectorAll('.sort-ind').forEach((s) => { s.textContent = s.dataset.col === state.sort ? (state.dir > 0 ? ' ▲' : ' ▼') : ''; });
      if (!rows.length) JA.mount(tbody, h('tr', null, h('td', { colspan: COLUMNS.length, class: 'muted' }, 'No issues match this search.')));
    }
    function sortBy(col) {
      state.dir = state.sort === col ? -state.dir : 1;
      state.sort = col;
      renderRows();
    }

    async function load(more) {
      JA.mount(statusEl, JA.spinner(more ? 'Loading more…' : 'Searching Jira…'));
      moreBtn.hidden = true;
      try {
        const q = new URLSearchParams({ jql, maxResults: '50' });
        if (more && state.nextPageToken) q.set('nextPageToken', state.nextPageToken);
        const data = await JA.api.get(`/api/search?${q}`, { quiet: true });
        state.issues = more ? state.issues.concat(data.issues) : data.issues;
        state.nextPageToken = data.nextPageToken;
        state.isLast = data.isLast;
        renderRows();
        JA.clear(statusEl);
        moreBtn.hidden = state.isLast;
        countEl.textContent = `Showing ${state.issues.length}`;
        if (!more) {
          JA.api.get(`/api/count?${new URLSearchParams({ jql })}`, { quiet: true })
            .then((c) => { if (c.count !== null) countEl.textContent = `Showing ${state.issues.length} of about ${c.count}`; })
            .catch(() => {});
        }
      } catch (err) {
        JA.mount(statusEl, h('p', { class: 'error-text' }, err.message));
      }
    }

    const saveBtn = h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => {
        const name = window.prompt('Name for this saved search:', '');
        if (!name) return;
        const saved = JA.store.get('saved', []);
        saved.push({ name: name.slice(0, 80), jql: jqlInput.value.trim() });
        JA.store.set('saved', saved);
        JA.renderSidebar();
        JA.toast('Search saved', 'ok');
      },
    }, '☆ Save search');

    JA.mount(main,
      h('div', { class: 'page-head' },
        h('h1', null, 'Filters'),
        h('a', { class: 'btn', href: `#/board?jql=${encodeURIComponent(jql)}` }, '▦ Show as board')),
      h('div', { class: 'card' },
        h('div', { class: 'jql-box' },
          jqlInput,
          h('button', { class: 'btn primary', type: 'button', onclick: () => { location.hash = JA.searchHref(jqlInput.value.trim()); } }, 'Run JQL'),
          saveBtn,
          h('a', { class: 'btn', href: `${JA.state.baseUrl}/issues/?jql=${encodeURIComponent(jql)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Jira ↗'),
          h('button', { class: 'btn', type: 'button', onclick: () => JA.download('jira-search.csv', toCsv(state.issues), 'text/csv') }, 'Export CSV')),
        h('p', { class: 'small muted' }, 'Tip: Enter runs the query, Shift+Enter adds a new line. In the top search box you can type an issue key, plain text or JQL.')),
      h('div', { class: 'row' }, countEl),
      statusEl,
      h('div', { class: 'table-wrap card', style: 'padding:0' }, h('table', { class: 'issues' }, h('thead', null, headRow), tbody)),
      h('div', { class: 'row' }, moreBtn));

    await load(false);
  };

  // ---- sidebar ---------------------------------------------------------------
  let favouriteFilters = null;

  JA.renderSidebar = () => {
    const current = location.hash;
    const linkItem = (name, href, onRemove) => h('li', null,
      h('a', { href, title: name, 'aria-current': current === href ? 'page' : undefined }, name),
      onRemove ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${name}`, title: 'Remove', onclick: onRemove }, '✕') : null);

    JA.mount(document.getElementById('preset-list'), JA.PRESETS.map((p) => linkItem(p.name, JA.searchHref(p.jql))));

    const saved = JA.store.get('saved', []);
    JA.mount(document.getElementById('saved-list'), saved.length
      ? saved.map((s, i) => linkItem(s.name, JA.searchHref(s.jql), () => {
        const list = JA.store.get('saved', []);
        list.splice(i, 1);
        JA.store.set('saved', list);
        JA.renderSidebar();
      }))
      : h('li', { class: 'muted small' }, 'Use "☆ Save search" on any search.'));

    const recent = JA.store.get('recent', []);
    JA.mount(document.getElementById('recent-list'), recent.length
      ? recent.map((r) => linkItem(`${r.key} ${r.summary || ''}`, `#/issue/${r.key}`))
      : h('li', { class: 'muted small' }, 'Issues you open appear here.'));

    const filterList = document.getElementById('filter-list');
    if (favouriteFilters) {
      JA.mount(filterList, favouriteFilters.length
        ? favouriteFilters.map((f) => linkItem(f.name, JA.searchHref(f.jql)))
        : h('li', { class: 'muted small' }, 'No starred filters in Jira.'));
    }
  };

  JA.loadFavouriteFilters = async () => {
    try {
      favouriteFilters = (await JA.api.get('/api/filters/favourite', { quiet: true })).filter((f) => f.jql);
    } catch (err) {
      favouriteFilters = [];
    }
    JA.renderSidebar();
  };

  JA.rememberRecent = (key, summary) => {
    const list = JA.store.get('recent', []).filter((r) => r.key !== key);
    list.unshift({ key, summary: String(summary || '').slice(0, 80) });
    JA.store.set('recent', list.slice(0, 12));
  };
})(window.JA);
