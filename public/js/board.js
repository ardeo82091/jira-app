/* Jira App - Kanban board (like a Jira board): columns by status, drag & drop to transition. */
'use strict';

(function (JA) {
  const { h } = JA;
  const DEFAULT_BOARD_JQL = 'assignee = currentUser() AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC';
  const CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 };
  const MAX_ISSUES = 300;

  JA.BOARD_PRESETS = [
    { name: 'My issues', jql: DEFAULT_BOARD_JQL },
    { name: 'My open sprint', jql: 'assignee = currentUser() AND sprint in openSprints() ORDER BY rank' },
    { name: 'Reported by me', jql: 'reporter = currentUser() AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC' },
    { name: 'Updated this week (all projects)', jql: 'assignee = currentUser() AND updated >= startOfWeek() ORDER BY updated DESC' },
  ];

  function columnsFor(issues) {
    const map = new Map();
    for (const i of issues) {
      const name = i.status ? i.status.name : 'No status';
      if (!map.has(name)) map.set(name, { name, category: i.status ? i.status.category : '', issues: [] });
      map.get(name).issues.push(i);
    }
    return [...map.values()].sort((a, b) => ((CATEGORY_ORDER[a.category] ?? 1) - (CATEGORY_ORDER[b.category] ?? 1)) || a.name.localeCompare(b.name));
  }

  JA.renderBoard = async (main, params) => {
    document.title = 'Board - Jira App';
    const jql = params.get('jql') || DEFAULT_BOARD_JQL;
    let issues = [];
    let dragKey = null;
    let dragTransitions = [];

    const jqlInput = h('input', { type: 'search', value: jql, 'aria-label': 'Board JQL', class: 'board-jql', spellcheck: 'false' });
    jqlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `#/board?jql=${encodeURIComponent(jqlInput.value.trim() || DEFAULT_BOARD_JQL)}`; });
    const presetSelect = h('select', { 'aria-label': 'Board presets' },
      h('option', { value: '' }, 'Presets…'),
      JA.BOARD_PRESETS.map((p) => h('option', { value: p.jql, selected: p.jql === jql }, p.name)));
    presetSelect.addEventListener('change', () => { if (presetSelect.value) location.hash = `#/board?jql=${encodeURIComponent(presetSelect.value)}`; });
    const filter = h('input', { type: 'search', placeholder: 'Filter cards…', 'aria-label': 'Filter cards', class: 'board-filter' });
    const onlyMine = h('input', { type: 'checkbox', id: 'board-mine' });
    const statusLine = h('div', { class: 'muted small', 'aria-live': 'polite' });
    const extraDrop = h('div', { class: 'extra-drop', hidden: true, 'aria-hidden': 'true' });
    const boardEl = h('div', { class: 'board', role: 'list', 'aria-label': 'Board columns' });

    const me = JA.state.session && JA.state.session.user ? JA.state.session.user.displayName : '';

    function card(issue) {
      const el = h('div', {
        class: `card-issue prio-${JA.prioLevel(issue.priority)}${JA.dueState(issue) === 'overdue' ? ' is-overdue' : ''}${JA.me.get(issue.key).focus ? ' is-focus' : ''}`,
        role: 'listitem',
        draggable: 'true',
        tabindex: '0',
        dataset: { key: issue.key },
        'aria-label': `${issue.key} ${issue.summary}. Press Enter to open, M to move.`,
      },
      h('div', { class: 'card-summary' }, issue.summary),
      JA.personalMarks(issue.key, issue),
      h('div', { class: 'card-foot' },
        JA.typeIcon(issue.type),
        h('a', { class: 'card-key', href: `#/issue/${issue.key}`, tabindex: '-1', onclick: (e) => JA.openFromEvent(e, issue.key, { onChange: () => load(true) }) }, issue.key),
        h('span', { class: 'spacer' }),
        JA.priorityIcon(issue.priority),
        JA.avatar(issue.assignee, 22)));
      el.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        JA.openDrawer(issue.key, { onChange: () => load(true) });
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); JA.openDrawer(issue.key, { onChange: () => load(true) }); }
        if (e.key.toLowerCase() === 'm') {
          e.preventDefault();
          JA.popover(el, JA.loadTransitions(issue.key).then((list) => list.map((t) => ({
            label: `${t.name}${t.to && t.to.name !== t.name ? ` → ${t.to.name}` : ''}`,
            onSelect: () => moveIssue(issue.key, t),
          }))), { label: `Move ${issue.key}`, empty: 'No transitions available' });
        }
      });
      el.addEventListener('dragstart', (e) => {
        dragKey = issue.key;
        e.dataTransfer.setData('text/plain', issue.key);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
        dragTransitions = [];
        JA.loadTransitions(issue.key).then((list) => {
          if (dragKey !== issue.key) return;
          dragTransitions = list;
          highlightTargets(issue);
        }).catch(() => {});
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        dragKey = null;
        clearTargets();
      });
      return el;
    }

    function highlightTargets(issue) {
      const current = issue.status ? issue.status.name : '';
      boardEl.querySelectorAll('.column').forEach((col) => {
        const name = col.dataset.status;
        const ok = name !== current && dragTransitions.some((t) => t.to && t.to.name === name);
        col.classList.toggle('can-drop', ok);
        col.classList.toggle('no-drop', !ok && name !== current);
      });
      const columnNames = new Set([...boardEl.querySelectorAll('.column')].map((c) => c.dataset.status));
      const extras = dragTransitions.filter((t) => t.to && !columnNames.has(t.to.name));
      if (extras.length) {
        extraDrop.hidden = false;
        JA.mount(extraDrop, h('span', { class: 'muted small' }, 'Drop here to move to:'), extras.map((t) => {
          const zone = h('div', { class: `drop-chip badge ${JA.tone(t.to.name, t.to.category)}`, dataset: { transition: t.id } }, t.to.name);
          zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
          zone.addEventListener('dragleave', () => zone.classList.remove('over'));
          zone.addEventListener('drop', (e) => { e.preventDefault(); moveIssue(dragKey || e.dataTransfer.getData('text/plain'), t); });
          return zone;
        }));
      }
    }
    function clearTargets() {
      boardEl.querySelectorAll('.column').forEach((c) => c.classList.remove('can-drop', 'no-drop', 'over'));
      extraDrop.hidden = true;
      JA.clear(extraDrop);
    }

    async function moveIssue(key, transition) {
      clearTargets();
      const issue = issues.find((i) => i.key === key);
      if (!issue || !transition) return;
      const before = issue.status;
      issue.status = transition.to ? { name: transition.to.name, category: transition.to.category } : issue.status;
      render();
      try {
        const ok = await JA.doTransition(key, transition);
        if (!ok) { issue.status = before; render(); return; }
        load(true);
      } catch (err) {
        issue.status = before;
        render();
      }
    }

    function render() {
      const q = filter.value.trim().toLowerCase();
      const shown = issues.filter((i) => (!q || `${i.key} ${i.summary} ${i.assignee}`.toLowerCase().includes(q)) && (!onlyMine.checked || i.assignee === me));
      const cols = columnsFor(shown);
      if (!cols.length) {
        JA.mount(boardEl, h('div', { class: 'empty-state' }, h('p', null, 'No issues on this board.'), h('a', { href: JA.searchHref(jql) }, 'Open as a search')));
        return;
      }
      JA.mount(boardEl, cols.map((col) => {
        const column = h('section', { class: 'column', dataset: { status: col.name, tone: JA.tone(col.name, col.category).split('tone-')[1] }, 'aria-label': `${col.name}, ${col.issues.length} issues` },
          h('header', { class: 'column-head' }, h('span', { class: `badge ${JA.tone(col.name, col.category)}` }, col.name), h('span', { class: 'count' }, String(col.issues.length))),
          h('div', { class: 'column-body' }, col.issues.map(card)));
        column.addEventListener('dragover', (e) => {
          if (!dragKey) return;
          const t = dragTransitions.find((x) => x.to && x.to.name === col.name);
          if (t || !dragTransitions.length) { e.preventDefault(); column.classList.add('over'); }
        });
        column.addEventListener('dragleave', (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove('over'); });
        column.addEventListener('drop', async (e) => {
          e.preventDefault();
          column.classList.remove('over');
          const key = dragKey || e.dataTransfer.getData('text/plain');
          const issue = issues.find((i) => i.key === key);
          if (!issue || (issue.status && issue.status.name === col.name)) return;
          let list = dragTransitions;
          if (!list.length) { try { list = await JA.loadTransitions(key); } catch (err) { return; } }
          const t = list.find((x) => x.to && x.to.name === col.name);
          if (!t) { JA.toast(`Jira doesn't allow moving ${key} from "${issue.status.name}" to "${col.name}" directly.`, 'error'); clearTargets(); return; }
          moveIssue(key, t);
        });
        return column;
      }));
      statusLine.textContent = `${shown.length} issue(s)${issues.length >= MAX_ISSUES ? ` (first ${MAX_ISSUES} shown)` : ''} · drag a card to another column to change its status, or focus a card and press M`;
    }

    async function load(quiet) {
      if (!quiet) JA.mount(boardEl, JA.spinner('Loading board…'));
      try {
        let all = [];
        let token = null;
        do {
          const q = new URLSearchParams({ jql, maxResults: '100' });
          if (token) q.set('nextPageToken', token);
          const data = await JA.api.get(`/api/search?${q}`, { quiet: true });
          all = all.concat(data.issues);
          token = data.isLast ? null : data.nextPageToken;
        } while (token && all.length < MAX_ISSUES);
        issues = all.slice(0, MAX_ISSUES);
        render();
      } catch (err) {
        JA.mount(boardEl, h('p', { class: 'error-text' }, err.message));
      }
    }

    filter.addEventListener('input', render);
    onlyMine.addEventListener('change', render);
    const offMe = JA.me.onChange(() => { if (!document.body.contains(boardEl)) { offMe(); return; } if (!dragKey) render(); });

    JA.mount(main,
      h('div', { class: 'page-head' },
        h('h1', null, 'Board'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => load(false), title: 'Refresh' }, '↻'),
          h('a', { class: 'btn', href: JA.searchHref(jql) }, '☰ List'),
          h('a', { class: 'btn', href: `${JA.state.baseUrl}/issues/?jql=${encodeURIComponent(jql)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Jira ↗'))),
      h('div', { class: 'board-toolbar' },
        filter,
        presetSelect,
        h('label', { class: 'inline-check', for: 'board-mine' }, onlyMine, ' Only mine'),
        jqlInput),
      statusLine,
      extraDrop,
      boardEl);
    await load(false);
  };
})(window.JA);
