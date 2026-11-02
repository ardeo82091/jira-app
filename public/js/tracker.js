/* Jira App - "My tracker" home: personal dashboard for tracking my Jira work. */
'use strict';

(function (JA) {
  const { h } = JA;
  const OPEN_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  const DONE_WEEK_JQL = 'assignee = currentUser() AND statusCategory = Done AND updated >= startOfWeek() ORDER BY updated DESC';

  const TILES = [
    { id: 'all', label: 'Open', icon: '📋', color: '#60a5fa', test: () => true },
    { id: 'progress', label: 'In progress', icon: '🚀', color: '#22d3ee', test: (i) => i.status && i.status.category === 'indeterminate' },
    { id: 'todo', label: 'To do', icon: '🗂', color: '#818cf8', test: (i) => i.status && i.status.category === 'new' },
    { id: 'overdue', label: 'Overdue', icon: '⚠', color: '#f87171', test: (i) => JA.dueState(i) === 'overdue' },
    { id: 'soon', label: 'Due this week', icon: '📅', color: '#fbbf24', test: (i) => ['today', 'soon'].includes(JA.dueState(i)) },
    { id: 'stale', label: 'No update 7d+', icon: '💤', color: '#f472b6', test: (i) => JA.isStale(i) },
    { id: 'high', label: 'High priority', icon: '🔥', color: '#fb923c', test: (i) => ['highest', 'high'].includes(JA.prioLevel(i.priority)) },
  ];

  function startOfWeek() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7; // Monday = 0
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    return d;
  }

  /** Row for a tracked issue: star, type, key + summary, marks, due chip, priority, status, timer. */
  function trackerRow(issue, onChanged, extra) {
    const row = h('li', { class: `t-row prio-${JA.prioLevel(issue.priority)}${JA.dueState(issue) === 'overdue' ? ' is-overdue' : ''}` },
      JA.focusToggle(issue.key, issue.summary),
      h('a', {
        class: 't-link',
        href: `#/issue/${issue.key}`,
        onclick: (e) => JA.openFromEvent(e, issue.key, { onChange: onChanged }),
      },
      JA.typeIcon(issue.type),
      h('span', { class: 't-main' },
        h('span', { class: 't-summary' }, issue.summary || issue.key),
        h('span', { class: 't-meta' }, h('span', { class: 't-key' }, issue.key), JA.hierarchyChips(issue), JA.dueChip(issue), JA.personalMarks(issue.key),
          JA.isStale(issue) ? h('span', { class: 'stale-chip', title: 'Not updated for more than a week' }, `💤 ${JA.relTime(issue.updated)}`) : null))),
      extra || null,
      h('span', { class: 't-side' },
        JA.priorityIcon(issue.priority),
        issue.status ? JA.statusPicker(issue.key, issue.status, () => onChanged && onChanged(issue.key)) : null,
        JA.timerButton(issue.key, issue.summary),
        JA.logWorkButton(issue.key, issue.summary)));
    return row;
  }
  JA.trackerRow = trackerRow;

  function barChart(rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return h('div', { class: 'bars' }, rows.map((r) => h('div', { class: 'bar-row' },
      h('span', { class: 'bar-label' }, r.label),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${Math.max(2, (r.value / max) * 100)}%;--bar:${r.color}` })),
      h('span', { class: 'bar-value' }, r.text || String(r.value)))));
  }

  JA.renderTracker = async (main, params) => {
    document.title = 'My tracker - Jira App';
    let issues = [];
    let doneThisWeek = [];
    let activeTile = params.get('tile') || 'all';
    let loaded = false;

    const tilesBox = h('div', { class: 'tiles' });
    const focusBox = h('section', { class: 'panel panel-focus', 'aria-labelledby': 'focus-h' });
    const remindBox = h('section', { class: 'panel panel-remind', 'aria-labelledby': 'remind-h' });
    const listBox = h('section', { class: 'panel panel-list', 'aria-labelledby': 'list-h' });
    const timeBox = h('section', { class: 'panel panel-time', 'aria-labelledby': 'time-h' });
    const statsBox = h('section', { class: 'panel panel-stats', 'aria-labelledby': 'stats-h' });
    const filter = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter my issues', class: 'mini-filter' });
    filter.addEventListener('input', () => renderList());

    const reload = () => load(true);
    const byKey = (key) => issues.find((i) => i.key === key) || doneThisWeek.find((i) => i.key === key);

    function renderTiles() {
      JA.mount(tilesBox, TILES.map((t) => {
        const count = issues.filter(t.test).length;
        return h('button', {
          type: 'button',
          class: `tile${activeTile === t.id ? ' active' : ''}${count && ['overdue', 'stale'].includes(t.id) ? ' alert' : ''}`,
          style: `--tile:${t.color}`,
          'aria-pressed': String(activeTile === t.id),
          onclick: () => { activeTile = activeTile === t.id && t.id !== 'all' ? 'all' : t.id; renderTiles(); renderList(); },
        }, h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, t.icon), h('span', { class: 'tile-count' }, loaded ? String(count) : '…'), h('span', { class: 'tile-label' }, t.label));
      }), h('div', { class: 'tile tile-static', style: '--tile:#34d399' },
        h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, '✅'), h('span', { class: 'tile-count' }, loaded ? String(doneThisWeek.length) : '…'), h('span', { class: 'tile-label' }, 'Done this week')));
    }

    function renderFocus() {
      const focus = JA.me.focusList();
      const addInput = h('input', { type: 'text', placeholder: 'Add issue key (e.g. FUL2-315620)', 'aria-label': 'Add issue key to focus', class: 'mini-filter' });
      addInput.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const key = addInput.value.trim().toUpperCase();
        if (!JA.issueKeyRe.test(key)) { JA.toast('Enter an issue key like FUL2-123', 'error'); return; }
        const known = byKey(key);
        await JA.me.patch(key, { focus: true }, known ? known.summary : undefined);
      });
      const move = async (index, dir) => {
        const list = focus.slice();
        const j = index + dir;
        if (j < 0 || j >= list.length) return;
        [list[index], list[j]] = [list[j], list[index]];
        for (let i = 0; i < list.length; i += 1) await JA.me.patch(list[i].key, { focusOrder: i + 1 });
      };
      JA.mount(focusBox,
        h('div', { class: 'panel-head' }, h('h2', { id: 'focus-h' }, "🎯 Today's focus"), h('span', { class: 'count' }, String(focus.length))),
        focus.length
          ? h('ul', { class: 't-list' }, focus.map((f, i) => {
            const issue = byKey(f.key) || { key: f.key, summary: f.summary, status: null };
            return trackerRow(issue, reload, h('span', { class: 'order-btns' },
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${f.key} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${f.key} down`, disabled: i === focus.length - 1, onclick: () => move(i, 1) }, '↓')));
          }))
          : h('p', { class: 'muted empty-hint' }, 'Click ☆ on any issue to plan what you will work on today.'),
        addInput);
    }

    function renderReminders() {
      const list = JA.me.reminders();
      const now = new Date();
      JA.mount(remindBox,
        h('div', { class: 'panel-head' }, h('h2', { id: 'remind-h' }, '⏰ Follow-ups'), h('span', { class: 'count' }, String(list.length))),
        list.length
          ? h('ul', { class: 'remind-list' }, list.map((r) => {
            const due = new Date(r.remindAt) <= now;
            return h('li', { class: `remind-item${due ? ' due' : ''}` },
              h('a', { href: `#/issue/${r.key}`, onclick: (e) => JA.openFromEvent(e, r.key, { tab: 'mine', onChange: reload }) },
                h('strong', null, r.key), ` ${r.remindNote || r.summary || ''}`),
              h('span', { class: 'remind-when' }, due ? `due ${JA.relTime(r.remindAt)}` : JA.fmtDate(r.remindAt)),
              h('span', { class: 'row', style: 'gap:4px' },
                h('button', { class: 'btn chip-btn', type: 'button', title: 'Snooze 1 hour', onclick: () => JA.me.patch(r.key, { remindAt: new Date(Date.now() + 3600e3).toISOString() }) }, '+1h'),
                h('button', { class: 'btn chip-btn', type: 'button', title: 'Snooze until tomorrow', onclick: () => JA.me.patch(r.key, { remindAt: new Date(Date.now() + 86400e3).toISOString() }) }, '+1d'),
                h('button', { class: 'btn chip-btn ok', type: 'button', title: 'Done', onclick: () => JA.me.patch(r.key, { remindAt: null, remindNote: '' }) }, '✓')));
          }))
          : h('p', { class: 'muted empty-hint' }, 'Set a follow-up from an issue\'s "★ Mine" tab - you\'ll get a reminder at that time.'));
    }

    function renderList() {
      const tile = TILES.find((t) => t.id === activeTile) || TILES[0];
      const q = filter.value.trim().toLowerCase();
      const tagFilter = JA.state.trackerTag;
      const shown = issues.filter(tile.test)
        .filter((i) => !q || `${i.key} ${i.summary} ${i.status ? i.status.name : ''} ${JA.me.get(i.key).tags.join(' ')}`.toLowerCase().includes(q))
        .filter((i) => !tagFilter || JA.me.get(i.key).tags.includes(tagFilter));
      const usedTags = [...new Set(issues.flatMap((i) => JA.me.get(i.key).tags))];
      JA.mount(listBox,
        h('div', { class: 'panel-head' },
          h('h2', { id: 'list-h' }, `${tile.icon} ${tile.id === 'all' ? 'My open issues' : tile.label}`),
          h('span', { class: 'count' }, String(shown.length)),
          h('span', { class: 'spacer' }),
          filter),
        usedTags.length ? h('div', { class: 'tag-row' }, h('span', { class: 'muted small' }, 'My tags:'), usedTags.map((t) => JA.tagChip(t, {
          button: true,
          active: !tagFilter || tagFilter === t,
          onClick: () => { JA.state.trackerTag = tagFilter === t ? null : t; renderList(); },
        }))) : null,
        !loaded ? JA.spinner('Loading your issues…')
          : shown.length ? h('ul', { class: 't-list' }, shown.map((i) => trackerRow(i, reload)))
            : h('p', { class: 'muted empty-hint' }, activeTile === 'all' ? 'No open issues assigned to you 🎉' : 'Nothing here.'));
    }

    function renderTime() {
      const entries = JA.me.data.timer.entries || [];
      const weekStart = startOfWeek();
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => {
        const start = new Date(weekStart.getTime() + i * 86400000);
        const end = new Date(start.getTime() + 86400000);
        const secs = entries.filter((e) => new Date(e.start) >= start && new Date(e.start) < end).reduce((s, e) => s + e.seconds, 0);
        const today = new Date().getDay() === (i + 1) % 7;
        return { label, value: secs, text: secs ? JA.fmtDuration(secs) : '–', color: today ? '#22d3ee' : '#60a5fa' };
      });
      const total = days.reduce((s, d) => s + d.value, 0);
      const unlogged = entries.filter((e) => !e.logged).slice(-6).reverse();
      JA.mount(timeBox,
        h('div', { class: 'panel-head' }, h('h2', { id: 'time-h' }, '⏱ My time this week'), h('span', { class: 'count' }, JA.fmtDuration(total))),
        barChart(days),
        unlogged.length ? h('div', null,
          h('h3', null, 'Not yet logged in Jira'),
          h('ul', { class: 'remind-list' }, unlogged.map((e) => h('li', { class: 'remind-item' },
            h('a', { href: `#/issue/${e.key}`, onclick: (ev) => JA.openFromEvent(ev, e.key) }, h('strong', null, e.key), ` ${e.summary || ''}`),
            h('span', { class: 'remind-when' }, `${JA.fmtDuration(e.seconds)} · ${JA.fmtDate(e.start)}`),
            h('span', { class: 'row', style: 'gap:4px' },
              h('button', {
                class: 'btn chip-btn ok',
                type: 'button',
                title: 'Log this time in Jira',
                onclick: async () => {
                  const r = await JA.api.post(`/api/me/timer/entries/${e.id}/log`, { commentText: '' });
                  JA.toast(`Logged ${r.timeSpent} to ${e.key}`, 'ok');
                  JA.me.load();
                },
              }, 'Log'),
              h('button', {
                class: 'btn chip-btn',
                type: 'button',
                title: 'Delete this entry',
                onclick: async () => { await JA.api.del(`/api/me/timer/entries/${e.id}`); JA.me.load(); },
              }, '✕')))))) : h('p', { class: 'muted empty-hint' }, 'Press ▶ on any issue to track time. Stop it to log the time to Jira, or keep it private.'));
    }

    function renderStats() {
      const byStatus = new Map();
      issues.forEach((i) => {
        const name = i.status ? i.status.name : 'Unknown';
        byStatus.set(name, (byStatus.get(name) || { n: 0, cat: i.status && i.status.category }));
        byStatus.get(name).n += 1;
      });
      const toneColor = { todo: '#818cf8', progress: '#22d3ee', review: '#c084fc', blocked: '#f87171', done: '#34d399' };
      const statusRows = [...byStatus.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, v]) => ({ label: name, value: v.n, color: toneColor[JA.tone(name, v.cat).split('tone-')[1]] }));
      const prio = ['highest', 'high', 'medium', 'low', 'lowest'].map((p) => ({ label: p[0].toUpperCase() + p.slice(1), value: issues.filter((i) => JA.prioLevel(i.priority) === p).length, color: { highest: '#f87171', high: '#fb923c', medium: '#fbbf24', low: '#22d3ee', lowest: '#94a3b8' }[p] })).filter((r) => r.value);
      JA.mount(statsBox,
        h('div', { class: 'panel-head' }, h('h2', { id: 'stats-h' }, '📊 My workload')),
        loaded && issues.length ? [h('h3', null, 'By status'), barChart(statusRows), h('h3', null, 'By priority'), barChart(prio)] : h('p', { class: 'muted empty-hint' }, loaded ? 'No open issues.' : 'Loading…'));
    }

    const renderAll = () => { renderTiles(); renderFocus(); renderReminders(); renderList(); renderTime(); renderStats(); };
    const off = JA.me.onChange(() => { if (!document.body.contains(main.querySelector('.tracker'))) { off(); return; } renderAll(); });

    async function load(quiet) {
      try {
        const [open, done] = await Promise.all([
          JA.api.get(`/api/search?${new URLSearchParams({ jql: OPEN_JQL, maxResults: '100' })}`, { quiet: true }),
          JA.api.get(`/api/search?${new URLSearchParams({ jql: DONE_WEEK_JQL, maxResults: '100' })}`, { quiet: true }).catch(() => ({ issues: [] })),
        ]);
        issues = open.issues;
        doneThisWeek = done.issues;
        loaded = true;
        // Keep summaries of focused issues fresh for the offline focus list.
        renderAll();
      } catch (err) {
        loaded = true;
        renderAll();
        if (!quiet) JA.mount(listBox, h('p', { class: 'error-text' }, err.message));
      }
    }

    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = JA.state.session && JA.state.session.user ? JA.state.session.user.displayName.split(' ')[0] : '';
    JA.mount(main, h('div', { class: 'tracker' },
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, `${greet}${name ? `, ${name}` : ''}`),
          h('p', { class: 'muted small', style: 'margin:2px 0 0' }, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }), ' · your personal Jira tracker')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => { JA.me.load(); load(false); }, title: 'Refresh' }, '↻'),
          h('a', { class: 'btn', href: '#/board' }, '▦ Board'))),
      tilesBox,
      h('div', { class: 'tracker-grid' },
        h('div', { class: 'col-main' }, focusBox, listBox),
        h('div', { class: 'col-side' }, remindBox, timeBox, statsBox))));
    renderAll();
    await Promise.all([JA.me.load(), load(false)]);
  };
})(window.JA);
