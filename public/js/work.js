/* Jira App - "Your work" home (like Jira's Your work): assigned, reported, watching, viewed. */
'use strict';

(function (JA) {
  const { h } = JA;

  const TABS = [
    { id: 'assigned', label: 'Assigned to me', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
    { id: 'reported', label: 'Reported', jql: 'reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
    { id: 'watching', label: 'Watching', jql: 'watcher = currentUser() AND statusCategory != Done ORDER BY updated DESC' },
    { id: 'done', label: 'Done recently', jql: 'assignee = currentUser() AND statusCategory = Done AND updated >= -30d ORDER BY updated DESC' },
    { id: 'viewed', label: 'Viewed', jql: 'issuekey in issueHistory() ORDER BY lastViewed DESC' },
  ];
  const GROUPS = [
    { category: 'indeterminate', label: 'In progress' },
    { category: 'new', label: 'To do' },
    { category: 'done', label: 'Done' },
  ];

  /** One Jira-style list row: focus star, type icon, key, summary, personal marks, priority, status picker, timer. */
  JA.issueListItem = (issue, onChanged) => h('li', { class: `work-item prio-${JA.prioLevel(issue.priority)}${JA.dueState(issue) === 'overdue' ? ' is-overdue' : ''}` },
    JA.focusToggle(issue.key, issue.summary),
    h('a', {
      class: 'work-link',
      href: `#/issue/${issue.key}`,
      onclick: (e) => JA.openFromEvent(e, issue.key, { onChange: onChanged }),
    },
    JA.typeIcon(issue.type),
    h('span', { class: 'work-main' },
      h('span', { class: 'work-summary' }, issue.summary),
      h('span', { class: 'work-meta' }, issue.key, issue.project ? ` · ${issue.project}` : '', ` · updated ${JA.relTime(issue.updated)} `, JA.hierarchyChips(issue), JA.dueChip(issue), JA.personalMarks(issue.key)))),
    h('span', { class: 'work-side' },
      JA.priorityIcon(issue.priority),
      JA.statusPicker(issue.key, issue.status, () => onChanged && onChanged(issue.key)),
      JA.timerButton(issue.key, issue.summary),
      JA.logWorkButton(issue.key, issue.summary),
      JA.avatar(issue.assignee, 22)));

  JA.renderWork = async (main, params) => {
    document.title = 'Your work - Jira App';
    const tab = TABS.find((t) => t.id === params.get('tab')) || TABS[0];
    const listBox = h('div', { 'aria-live': 'polite' });
    const filter = h('input', { type: 'search', placeholder: 'Filter this list…', 'aria-label': 'Filter this list', class: 'work-filter' });
    let issues = [];

    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = q ? issues.filter((i) => `${i.key} ${i.summary} ${i.status ? i.status.name : ''}`.toLowerCase().includes(q)) : issues;
      if (!shown.length) {
        JA.mount(listBox, h('div', { class: 'empty-state' },
          h('p', null, q ? 'Nothing matches your filter.' : 'Nothing here. Nice!'),
          h('a', { href: JA.searchHref(tab.jql) }, 'Open as a search')));
        return;
      }
      const grouped = tab.id === 'viewed' ? [{ label: 'Recently viewed', items: shown }]
        : GROUPS.map((g) => ({ label: g.label, items: shown.filter((i) => (i.status && i.status.category) === g.category) }))
          .concat([{ label: 'Other', items: shown.filter((i) => !GROUPS.some((g) => g.category === (i.status && i.status.category))) }])
          .filter((g) => g.items.length);
      JA.mount(listBox, grouped.map((g) => h('section', { class: 'work-group' },
        h('h2', { class: 'work-group-title' }, `${g.label} `, h('span', { class: 'count' }, String(g.items.length))),
        h('ul', { class: 'work-list' }, g.items.map((i) => JA.issueListItem(i, () => load(true)))))));
    };
    filter.addEventListener('input', render);
    const offMe = JA.me.onChange(() => { if (!document.body.contains(listBox)) { offMe(); return; } if (issues.length) render(); });

    async function load(quiet) {
      if (!quiet) JA.mount(listBox, JA.spinner('Loading your work…'));
      try {
        const data = await JA.api.get(`/api/search?${new URLSearchParams({ jql: tab.jql, maxResults: '100' })}`, { quiet: true });
        issues = data.issues;
        render();
      } catch (err) {
        JA.mount(listBox, h('p', { class: 'error-text' }, err.message));
      }
    }

    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Your work' }, TABS.map((t) => h('a', {
      role: 'tab',
      href: `#/work?tab=${t.id}`,
      'aria-selected': t.id === tab.id ? 'true' : 'false',
      class: 'tab-link',
    }, t.label)));

    const greeting = JA.state.session && JA.state.session.user ? JA.state.session.user.displayName.split(' ')[0] : '';
    JA.mount(main,
      h('div', { class: 'page-head' },
        h('h1', null, 'Your work'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => load(false), title: 'Refresh' }, '↻'),
          h('a', { class: 'btn', href: `#/board?jql=${encodeURIComponent(tab.jql.replace(/ ORDER BY.*$/i, '') + ' ORDER BY updated DESC')}` }, '▦ Board'))),
      greeting ? h('p', { class: 'muted small hello' }, `Hi ${greeting} 👋  Click an issue to open it, click its status to move it.`) : null,
      tabs,
      filter,
      listBox);
    await load(false);
  };
})(window.JA);
