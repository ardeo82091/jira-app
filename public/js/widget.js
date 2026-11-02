/* Jira App - floating side widget: all pending tasks, highlighted by urgency, with quick actions. */
'use strict';

(function (JA) {
  const { h } = JA;
  const desktop = window.desktop && window.desktop.isDesktop ? window.desktop : null;
  const OPEN_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC';
  const REFRESH_MS = 2 * 60 * 1000;
  const $ = (id) => document.getElementById(id);

  let issues = [];
  let loaded = false;
  let error = null;
  let segment = JA.store.get('widgetSegment', 'all');
  let lastUpdated = null;

  const COLORS = { overdue: '#f87171', due: '#fbbf24', progress: '#38bdf8', todo: '#a5b4fc', focus: '#fbbf24' };

  function openMain(hash) {
    if (desktop && desktop.openMain) desktop.openMain(hash);
    else window.open(`/${hash}`, '_blank', 'noopener');
  }

  /** Puts every pending issue in exactly one urgency group. */
  function classify(list) {
    const groups = { overdue: [], due: [], focus: [], progress: [], todo: [] };
    for (const i of list) {
      const due = JA.dueState(i);
      if (due === 'overdue') groups.overdue.push(i);
      else if (due === 'today' || due === 'soon') groups.due.push(i);
      else if (JA.me.get(i.key).focus) groups.focus.push(i);
      else if (i.status && i.status.category === 'indeterminate') groups.progress.push(i);
      else groups.todo.push(i);
    }
    return groups;
  }

  const SEGMENTS = [
    { id: 'all', label: 'All' },
    { id: 'urgent', label: '⚠ Urgent', test: (i) => ['overdue', 'today', 'soon'].includes(JA.dueState(i)) || ['highest', 'high'].includes(JA.prioLevel(i.priority)) },
    { id: 'focus', label: '🎯 Focus', test: (i) => JA.me.get(i.key).focus },
    { id: 'doing', label: '🚀 Doing', test: (i) => i.status && i.status.category === 'indeterminate' },
    { id: 'todo', label: '🗂 To do', test: (i) => !i.status || i.status.category === 'new' },
  ];

  // ---- header -------------------------------------------------------------------
  function renderHeader() {
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const name = JA.state.session && JA.state.session.user ? JA.state.session.user.displayName.split(' ')[0] : '';
    $('w-hello').textContent = `${greet}${name ? `, ${name}` : ''}`;
    $('w-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  }

  // ---- donut ring -------------------------------------------------------------------
  function ring(groups, total) {
    const SVG = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 120 120');
    svg.setAttribute('width', '108');
    svg.setAttribute('height', '108');
    svg.setAttribute('aria-hidden', 'true');
    const r = 48;
    const c = 2 * Math.PI * r;
    const base = document.createElementNS(SVG, 'circle');
    Object.entries({ cx: 60, cy: 60, r, fill: 'none', stroke: 'rgba(148,163,184,.15)', 'stroke-width': 12 }).forEach(([k, v]) => base.setAttribute(k, v));
    svg.appendChild(base);
    let offset = 0;
    const gap = total > 1 ? 3 : 0;
    ['overdue', 'due', 'focus', 'progress', 'todo'].forEach((g) => {
      const n = groups[g].length;
      if (!n || !total) return;
      const len = (n / total) * c;
      const seg = document.createElementNS(SVG, 'circle');
      Object.entries({
        cx: 60, cy: 60, r, fill: 'none', stroke: COLORS[g], 'stroke-width': 12, 'stroke-linecap': 'round',
        'stroke-dasharray': `${Math.max(0.1, len - gap)} ${c}`, 'stroke-dashoffset': String(-offset), transform: 'rotate(-90 60 60)',
      }).forEach(([k, v]) => seg.setAttribute(k, v));
      svg.appendChild(seg);
      offset += len;
    });
    const label = h('div', { class: 'w-ring-label' }, h('strong', null, loaded ? String(total) : '…'), h('span', null, 'pending'));
    return [svg, label];
  }

  function renderHero(groups) {
    const total = issues.length;
    JA.mount($('w-ring'), ring(groups, total));
    $('w-ring').setAttribute('aria-label', `${total} pending tasks`);
    const counts = { ...Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), focus: issues.filter((i) => JA.me.get(i.key).focus).length };
    const stat = (g, icon, label) => h('button', {
      type: 'button',
      class: `w-stat${counts[g] ? '' : ' zero'}`,
      style: `--c:${COLORS[g]}`,
      onclick: () => { setSegment(g === 'overdue' || g === 'due' ? 'urgent' : g === 'progress' ? 'doing' : g); },
    }, h('span', { class: 'w-stat-n' }, String(counts[g])), h('span', { class: 'w-stat-l' }, `${icon} ${label}`));
    JA.mount($('w-hero-stats'),
      stat('overdue', '⚠', 'Overdue'),
      stat('due', '📅', 'Due soon'),
      stat('progress', '🚀', 'In progress'),
      stat('focus', '🎯', 'Focus'));
  }

  // ---- timer + next follow-up --------------------------------------------------------
  function renderTimer() {
    const box = $('w-timer');
    const a = JA.me.data.timer && JA.me.data.timer.active;
    if (!a) { box.hidden = true; JA.clear(box); return; }
    box.hidden = false;
    const secs = (Date.now() - new Date(a.startedAt)) / 1000;
    JA.mount(box,
      h('span', { class: 'pulse', 'aria-hidden': 'true' }),
      h('button', { class: 'w-timer-main', type: 'button', onclick: () => openMain(`#/issue/${a.key}?tab=mine`), title: a.summary || a.key },
        h('span', { class: 'w-timer-key' }, a.key), h('span', { class: 'w-timer-sum' }, a.summary || '')),
      h('strong', { class: 'w-timer-time', id: 'w-timer-time' }, JA.fmtDuration(secs, true)),
      h('button', { class: 'timer-stop', type: 'button', onclick: () => JA.timer.stop(), 'aria-label': 'Stop timer', title: 'Stop timer' }, '■'));
  }
  setInterval(() => {
    const el = $('w-timer-time');
    const a = JA.me.data.timer && JA.me.data.timer.active;
    if (el && a) el.textContent = JA.fmtDuration((Date.now() - new Date(a.startedAt)) / 1000, true);
  }, 1000);

  function renderNext() {
    const box = $('w-next');
    const list = JA.me.reminders();
    if (!list.length) { box.hidden = true; JA.clear(box); return; }
    const r = list[0];
    const due = new Date(r.remindAt) <= new Date();
    box.hidden = false;
    box.className = `w-next${due ? ' due' : ''}`;
    JA.mount(box,
      h('span', { class: due ? 'bell' : '', 'aria-hidden': 'true' }, '⏰'),
      h('button', { type: 'button', class: 'w-next-main', onclick: () => openMain(`#/issue/${r.key}?tab=mine`) },
        h('strong', null, r.key), ` ${r.remindNote || r.summary || 'Follow up'}`),
      h('span', { class: 'w-next-when' }, due ? 'now' : JA.relTimeFuture(r.remindAt)),
      due ? h('button', { type: 'button', class: 'w-mini ok', title: 'Done', 'aria-label': 'Mark follow-up done', onclick: () => JA.me.patch(r.key, { remindAt: null, remindNote: '' }) }, '✓') : null,
      due ? h('button', { type: 'button', class: 'w-mini', title: 'Snooze 1 hour', 'aria-label': 'Snooze 1 hour', onclick: () => JA.me.patch(r.key, { remindAt: new Date(Date.now() + 3600e3).toISOString() }) }, '+1h') : null);
  }

  JA.relTimeFuture = (iso) => {
    const diff = (new Date(iso) - Date.now()) / 1000;
    if (diff < 3600) return `in ${Math.max(1, Math.round(diff / 60))} min`;
    if (diff < 86400) return `in ${Math.round(diff / 3600)} h`;
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };

  // ---- segments + list -------------------------------------------------------------------
  function setSegment(id) {
    segment = id;
    JA.store.set('widgetSegment', id);
    render();
  }

  function renderSegments() {
    JA.mount($('w-seg'), SEGMENTS.map((s) => {
      const count = s.test ? issues.filter(s.test).length : issues.length;
      return h('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(segment === s.id),
        class: `w-seg-btn${segment === s.id ? ' on' : ''}`,
        onclick: () => setSegment(s.id),
      }, s.label, h('span', { class: 'w-seg-n' }, String(count)));
    }));
  }

  function card(issue, accent) {
    const r = JA.me.get(issue.key);
    const doneCount = r.checklist.filter((c) => c.done).length;
    const el = h('article', {
      class: `w-item prio-${JA.prioLevel(issue.priority)}`,
      style: `--accent:${accent}`,
      tabindex: '0',
      'aria-label': `${issue.key} ${issue.summary}`,
    },
    h('div', { class: 'w-item-top' },
      JA.typeIcon(issue.type),
      h('span', { class: 'w-item-key' }, issue.key),
      JA.hierarchyChips(issue),
      JA.dueChip(issue),
      h('span', { class: 'spacer' }),
      JA.priorityIcon(issue.priority)),
    h('div', { class: 'w-item-sum' }, issue.summary),
    (r.tags.length || r.checklist.length || r.notes || r.remindAt) ? h('div', { class: 'w-item-marks' },
      r.tags.map((t) => JA.tagChip(t)),
      r.checklist.length ? h('span', { class: `w-check${doneCount === r.checklist.length ? ' all' : ''}` },
        h('span', { class: 'w-check-bar' }, h('span', { style: `width:${Math.round((doneCount / r.checklist.length) * 100)}%` })), `${doneCount}/${r.checklist.length}`) : null,
      r.notes ? h('span', { class: 'mark', title: 'Has private notes' }, '📝') : null,
      r.remindAt ? h('span', { class: 'mark', title: `Reminder ${JA.fmtDate(r.remindAt)}` }, '⏰') : null) : null,
    h('div', { class: 'w-item-actions' },
      issue.status ? JA.statusPicker(issue.key, issue.status, () => load(true)) : null,
      h('span', { class: 'spacer' }),
      JA.focusToggle(issue.key, issue.summary),
      JA.timerButton(issue.key, issue.summary),
      JA.logWorkButton(issue.key, issue.summary),
      h('button', { type: 'button', class: 'w-mini', title: 'Open', 'aria-label': `Open ${issue.key}`, onclick: (e) => { e.stopPropagation(); openMain(`#/issue/${issue.key}`); } }, '↗')));
    el.addEventListener('click', (e) => { if (!e.target.closest('button,a')) openMain(`#/issue/${issue.key}`); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) openMain(`#/issue/${issue.key}`); });
    return el;
  }

  function accentFor(i) {
    const due = JA.dueState(i);
    if (due === 'overdue') return COLORS.overdue;
    if (due === 'today' || due === 'soon') return COLORS.due;
    if (JA.me.get(i.key).focus) return COLORS.focus;
    if (i.status && i.status.category === 'indeterminate') return COLORS.progress;
    return COLORS.todo;
  }

  function renderList(groups) {
    const list = $('w-list');
    if (error) {
      JA.mount(list, h('div', { class: 'w-empty' }, h('div', { class: 'w-empty-icon' }, '⚡'), h('p', null, error), h('button', { class: 'w-pill', type: 'button', onclick: () => load(false) }, 'Try again')));
      return;
    }
    if (!loaded) return;
    if (!issues.length) {
      JA.mount(list, h('div', { class: 'w-empty' }, h('div', { class: 'w-empty-icon' }, '🎉'), h('p', null, 'All clear - nothing pending!')));
      return;
    }
    if (segment === 'all') {
      const sections = [
        ['overdue', '⚠ Overdue'], ['due', '📅 Due soon'], ['focus', "🎯 Today's focus"], ['progress', '🚀 In progress'], ['todo', '🗂 To do'],
      ].filter(([g]) => groups[g].length);
      JA.mount(list, sections.map(([g, label]) => h('section', { class: 'w-group', style: `--c:${COLORS[g]}` },
        h('h2', { class: 'w-group-title' }, h('span', { class: 'w-dot' }), label, h('span', { class: 'w-group-n' }, String(groups[g].length))),
        groups[g].map((i) => card(i, COLORS[g])))));
      return;
    }
    const seg = SEGMENTS.find((s) => s.id === segment) || SEGMENTS[0];
    const shown = issues.filter(seg.test);
    JA.mount(list, shown.length
      ? shown.map((i) => card(i, accentFor(i)))
      : h('div', { class: 'w-empty' }, h('div', { class: 'w-empty-icon' }, segment === 'focus' ? '☆' : '✨'),
        h('p', null, segment === 'focus' ? 'Tap ☆ on a task to add it to today\'s focus.' : 'Nothing here.')));
  }

  function renderTab(groups) {
    $('w-tab-count').textContent = String(issues.length);
    $('w-tab-alert').hidden = !groups.overdue.length;
  }

  function render() {
    const groups = classify(issues);
    renderHeader();
    renderHero(groups);
    renderTimer();
    renderNext();
    renderSegments();
    renderList(groups);
    renderTab(groups);
    $('w-updated').textContent = lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
  }

  async function load(quiet) {
    if (!quiet) $('w-refresh').classList.add('spin');
    try {
      const data = await JA.api.get(`/api/search?${new URLSearchParams({ jql: OPEN_JQL, maxResults: '100' })}`, { quiet: true });
      issues = data.issues;
      error = null;
      lastUpdated = new Date();
    } catch (err) {
      error = err.message;
    }
    loaded = true;
    await JA.me.load();
    render();
    $('w-refresh').classList.remove('spin');
  }

  // ---- window controls -------------------------------------------------------------------
  function setCollapsed(collapsed) {
    $('w-card').hidden = collapsed;
    $('w-tab').hidden = !collapsed;
    document.body.classList.toggle('collapsed', collapsed);
  }

  async function start() {
    document.documentElement.dataset.theme = JA.store.get('theme', 'dark');
    $('w-refresh').addEventListener('click', () => load(false));
    $('w-open').addEventListener('click', () => openMain('#/home'));
    $('w-create').addEventListener('click', () => openMain('#/create'));
    $('w-board').addEventListener('click', () => openMain('#/board'));
    $('w-tracker').addEventListener('click', () => openMain('#/home'));
    $('w-collapse').addEventListener('click', () => { if (desktop) desktop.widgetCollapse(true); else setCollapsed(true); });
    $('w-tab').addEventListener('click', () => { if (desktop) desktop.widgetCollapse(false); else setCollapsed(false); });
    $('w-hide').addEventListener('click', () => { if (desktop) desktop.widgetHide(); });
    if (!desktop) $('w-hide').hidden = true;
    if (desktop && desktop.onWidgetState) {
      desktop.onWidgetState((s) => {
        setCollapsed(!!s.collapsed);
        document.body.dataset.side = s.side || 'right';
      });
      desktop.widgetReady();
    }
    if (desktop && desktop.onRefresh) desktop.onRefresh(() => load(true));

    renderHeader();
    try {
      const session = await JA.api.get('/api/session', { quiet: true });
      JA.state.session = session;
      JA.state.token = session.token;
      JA.state.baseUrl = session.baseUrl;
    } catch (err) {
      error = err.message;
      loaded = true;
      render();
      return;
    }
    JA.me.onChange(() => render());
    window.addEventListener('focus', () => load(true));
    window.addEventListener('storage', (e) => { if (e.key === 'jira-app:theme') document.documentElement.dataset.theme = JA.store.get('theme', 'dark'); });
    setInterval(() => load(true), REFRESH_MS);
    await load(false);
  }

  start();
})(window.JA);
