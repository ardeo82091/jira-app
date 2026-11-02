/* Jira App - personal tracking: focus list, tags, private notes, checklist, reminders, timer. */
'use strict';

(function (JA) {
  const { h } = JA;
  JA.tabs = JA.tabs || {};
  const listeners = new Set();
  let data = { issues: {}, tags: [], timer: { active: null, entries: [] } };

  const EMPTY = { notes: '', checklist: [], tags: [], focus: false, remindAt: null, remindNote: '', reminded: false };

  JA.me = {
    get data() { return data; },
    get: (key) => ({ ...EMPTY, ...(data.issues[key] || {}) }),
    async load() {
      try { data = await JA.api.get('/api/me', { quiet: true }); } catch (err) { /* keep previous */ }
      emit();
      return data;
    },
    async patch(key, patch, summary) {
      const body = { ...patch };
      if (summary) body.summary = summary;
      const res = await JA.api.put(`/api/me/issue/${encodeURIComponent(key)}`, body);
      if (res.record) data.issues[key] = res.record; else delete data.issues[key];
      emit();
      return res.record;
    },
    tagColor(name) {
      const t = data.tags.find((x) => x.name === name);
      return t ? t.color : '#94a3b8';
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    focusList() {
      return Object.entries(data.issues).filter(([, r]) => r.focus).sort((a, b) => (a[1].focusOrder || 0) - (b[1].focusOrder || 0)).map(([key, r]) => ({ key, ...r }));
    },
    reminders() {
      return Object.entries(data.issues).filter(([, r]) => r.remindAt).sort((a, b) => a[1].remindAt.localeCompare(b[1].remindAt)).map(([key, r]) => ({ key, ...r }));
    },
    trackedSeconds(key) {
      let s = (data.timer.entries || []).filter((e) => e.key === key).reduce((sum, e) => sum + e.seconds, 0);
      if (data.timer.active && data.timer.active.key === key) s += (Date.now() - new Date(data.timer.active.startedAt)) / 1000;
      return Math.round(s);
    },
    loggedSeconds(key) {
      return Math.round((data.timer.entries || []).filter((e) => e.key === key && e.logged).reduce((sum, e) => sum + e.seconds, 0));
    },
  };
  function emit() { listeners.forEach((fn) => { try { fn(data); } catch (e) { /* ignore */ } }); }

  JA.fmtDuration = (seconds, withSeconds) => {
    const s = Math.max(0, Math.round(seconds));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (withSeconds) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    if (hh && mm) return `${hh}h ${mm}m`;
    if (hh) return `${hh}h`;
    return `${mm}m`;
  };

  // ---- helpers for highlighting -------------------------------------------------------
  JA.prioLevel = (name) => {
    const n = String(name || '').toLowerCase();
    if (/highest|blocker|critical|p0/.test(n)) return 'highest';
    if (/high|major|p1/.test(n)) return 'high';
    if (/lowest|trivial/.test(n)) return 'lowest';
    if (/low|minor/.test(n)) return 'low';
    return n ? 'medium' : 'none';
  };

  /** overdue | today | soon | later | none - based on Jira due date or my reminder. */
  JA.dueState = (issue) => {
    if (!issue || !issue.duedate || (issue.status && issue.status.category === 'done')) return 'none';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(`${issue.duedate}T00:00:00`);
    const days = Math.round((due - today) / 86400000);
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days <= 7) return 'soon';
    return 'later';
  };
  JA.isStale = (issue) => issue && issue.status && issue.status.category !== 'done' && issue.updated && (Date.now() - new Date(issue.updated)) > 7 * 86400000;

  JA.dueChip = (issue) => {
    const state = JA.dueState(issue);
    if (state === 'none') return null;
    const d = new Date(`${issue.duedate}T00:00:00`);
    const label = state === 'overdue' ? `Overdue ${JA.fmtDate(d, false)}` : state === 'today' ? 'Due today' : `Due ${JA.fmtDate(d, false)}`;
    return h('span', { class: `due-chip due-${state}`, title: `Jira due date ${issue.duedate}` }, state === 'overdue' ? '⚠ ' : '📅 ', label);
  };

  JA.tagChip = (name, opts = {}) => h(opts.button ? 'button' : 'span', {
    class: `tag-chip${opts.active === false ? ' off' : ''}`,
    style: `--tag:${JA.me.tagColor(name)}`,
    type: opts.button ? 'button' : undefined,
    'aria-pressed': opts.button ? String(opts.active !== false) : undefined,
    onclick: opts.onClick,
  }, `#${name}`);

  /** Small personal markers for list rows / cards: focus star, tags, notes, checklist, reminder. */
  JA.personalMarks = (key) => {
    const r = JA.me.get(key);
    const done = r.checklist.filter((c) => c.done).length;
    const parts = [
      r.focus ? h('span', { class: 'mark mark-focus', title: "In today's focus" }, '🎯') : null,
      ...r.tags.map((t) => JA.tagChip(t)),
      r.notes ? h('span', { class: 'mark', title: 'Has private notes' }, '📝') : null,
      r.checklist.length ? h('span', { class: `mark mark-check${done === r.checklist.length ? ' all' : ''}`, title: 'Checklist' }, `☑ ${done}/${r.checklist.length}`) : null,
      r.remindAt ? h('span', { class: `mark mark-remind${new Date(r.remindAt) <= new Date() ? ' due' : ''}`, title: `Reminder ${JA.fmtDate(r.remindAt)}` }, '⏰') : null,
    ].filter(Boolean);
    return parts.length ? h('span', { class: 'marks' }, parts) : null;
  };

  /** ☆/★ toggle to add or remove an issue from today's focus. */
  JA.focusToggle = (key, summary) => {
    const on = JA.me.get(key).focus;
    return h('button', {
      type: 'button',
      class: `star-btn${on ? ' on' : ''}`,
      'aria-pressed': String(on),
      'aria-label': on ? `Remove ${key} from today's focus` : `Add ${key} to today's focus`,
      title: on ? "Remove from today's focus" : "Add to today's focus",
      onclick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await JA.me.patch(key, { focus: !on }, summary);
        JA.toast(on ? `${key} removed from focus` : `🎯 ${key} added to today's focus`, 'ok');
      },
    }, on ? '★' : '☆');
  };

  // ---- log work (adds hours + description straight to the Jira work log) ---------------
  const QUICK_TIMES = ['15m', '30m', '1h', '2h', '3h', '4h', '6h', '1d'];

  /** Parses Jira durations ("1h 30m", "1d", "45m") into seconds (1d = 8h, 1w = 5d). */
  JA.parseDuration = (text) => {
    const re = /(\d+(?:\.\d+)?)\s*([wdhm])/gi;
    const units = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 };
    let total = 0;
    let m;
    const clean = String(text || '').trim();
    if (!/^\s*(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(clean)) return 0;
    while ((m = re.exec(clean))) total += parseFloat(m[1]) * units[m[2].toLowerCase()];
    return Math.round(total);
  };

  /** Opens the "Log work" form for an issue. */
  JA.openLogWork = (key, summary, onDone) => {
    const toLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const spent = h('input', { type: 'text', id: 'lw-spent', placeholder: 'e.g. 1h 30m', autocomplete: 'off', 'aria-describedby': 'lw-hint' });
    const started = h('input', { type: 'datetime-local', id: 'lw-started', value: toLocal(new Date()) });
    const comment = h('textarea', { id: 'lw-desc', rows: 4, placeholder: 'What did you work on? (goes to the Jira work log)' });
    const error = h('p', { class: 'error-text small', role: 'alert' });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, '＋ Add to work log');

    const chips = h('div', { class: 'lw-chips', role: 'group', 'aria-label': 'Quick times' }, QUICK_TIMES.map((t) => h('button', {
      type: 'button',
      class: 'lw-chip',
      'aria-pressed': 'false',
      onclick: (e) => {
        spent.value = t;
        chips.querySelectorAll('.lw-chip').forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
        comment.focus();
      },
    }, t)));
    spent.addEventListener('input', () => chips.querySelectorAll('.lw-chip').forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === spent.value.trim()))));

    const dayChip = (label, daysAgo) => h('button', {
      type: 'button',
      class: 'lw-chip small',
      onclick: () => {
        const d = new Date();
        if (daysAgo) { d.setDate(d.getDate() - daysAgo); d.setHours(18, 0, 0, 0); }
        started.value = toLocal(d);
      },
    }, label);

    const form = h('form', { class: 'lw-form', novalidate: true },
      h('h2', { id: 'lw-title' }, '⏱ Log work'),
      h('p', { class: 'lw-issue' }, h('strong', null, key), summary ? ` ${summary}` : ''),
      h('label', { for: 'lw-spent' }, 'Time spent'),
      chips,
      spent,
      h('p', { id: 'lw-hint', class: 'muted small lw-hint' }, 'Use w, d, h, m - e.g. 45m, 2h, 1h 30m, 1d (= 8h)'),
      h('label', { for: 'lw-started' }, 'When'),
      h('div', { class: 'row' }, started, dayChip('Today', 0), dayChip('Yesterday', 1)),
      h('label', { for: 'lw-desc' }, 'Description'),
      comment,
      error,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        submit));

    const dialog = h('dialog', { class: 'modal lw-modal', 'aria-labelledby': 'lw-title' }, form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const seconds = JA.parseDuration(spent.value);
      if (!seconds) { error.textContent = 'Enter the time spent, e.g. 1h 30m.'; spent.focus(); return; }
      if (seconds > 7 * 24 * 3600) { error.textContent = 'That is more than a week - please check the time.'; spent.focus(); return; }
      submit.disabled = true;
      submit.textContent = 'Adding…';
      try {
        await JA.api.post(`/api/issue/${encodeURIComponent(key)}/worklog`, {
          timeSpent: spent.value.trim(),
          started: started.value ? new Date(started.value).toISOString() : undefined,
          commentText: comment.value,
          summary: summary || '',
        }, { quiet: true });
        JA.toast(`✓ Logged ${spent.value.trim()} to ${key}`, 'ok');
        dialog.close();
        await JA.me.load();
        if (onDone) onDone();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
        submit.textContent = '＋ Add to work log';
      }
    });
    comment.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    spent.focus();
  };

  /** Small "＋ log work" button for rows and cards. */
  JA.logWorkButton = (key, summary, onDone) => h('button', {
    type: 'button',
    class: 'log-btn',
    title: 'Log work (hours + description)',
    'aria-label': `Log work on ${key}`,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); JA.openLogWork(key, summary, onDone); },
  }, '＋', h('span', { class: 'log-btn-text' }, 'Log'));

  // ---- timer --------------------------------------------------------------------------
  JA.timer = {
    async start(key, summary) {
      const res = await JA.api.post('/api/me/timer/start', { key, summary });
      await JA.me.load();
      if (res.stopped) JA.toast(`Stopped ${res.stopped.key} (${JA.fmtDuration(res.stopped.seconds)}) - log it from the tracker`, 'ok');
      JA.toast(`⏱ Timer started on ${key}`, 'ok');
    },
    stop() { openStopDialog(); },
  };

  JA.timerButton = (key, summary) => {
    const active = data.timer.active && data.timer.active.key === key;
    return h('button', {
      type: 'button',
      class: `timer-btn${active ? ' running' : ''}`,
      title: active ? 'Stop timer' : 'Start timer on this issue',
      'aria-label': active ? `Stop timer on ${key}` : `Start timer on ${key}`,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); if (active) JA.timer.stop(); else JA.timer.start(key, summary); },
    }, active ? '■' : '▶');
  };

  function openStopDialog() {
    const a = data.timer.active;
    if (!a) return;
    const seconds = (Date.now() - new Date(a.startedAt)) / 1000;
    const comment = h('textarea', { rows: 3, placeholder: 'What did you work on? (optional, goes to Jira work log)', 'aria-label': 'Work log comment' });
    const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'stop-title' },
      h('h2', { id: 'stop-title' }, `⏱ ${JA.fmtDuration(seconds)} on ${a.key}`),
      h('p', { class: 'muted small' }, a.summary || ''),
      comment,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Keep running'),
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, 'Stop (keep private)'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true) }, 'Stop & log to Jira')));
    async function finish(logIt) {
      try {
        const res = await JA.api.post('/api/me/timer/stop', { log: logIt, commentText: comment.value });
        JA.toast(res.timeSpent ? `Logged ${res.timeSpent} to ${res.entry.key}` : `Stopped - ${JA.fmtDuration(res.entry.seconds)} saved in your tracker`, 'ok');
      } catch (err) { /* toast shown */ }
      dialog.close();
      await JA.me.load();
    }
    dialog.addEventListener('close', () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    comment.focus();
  }

  // Timer pill in the header, ticking every second.
  function renderTimerPill() {
    const box = document.getElementById('timer-pill');
    if (!box) return;
    const a = data.timer.active;
    if (!a) { box.hidden = true; JA.clear(box); return; }
    box.hidden = false;
    const secs = (Date.now() - new Date(a.startedAt)) / 1000;
    JA.mount(box,
      h('a', { href: `#/issue/${a.key}`, class: 'timer-link', title: a.summary || a.key, onclick: (e) => JA.openFromEvent(e, a.key) },
        h('span', { class: 'pulse', 'aria-hidden': 'true' }), `${a.key} `, h('strong', { class: 'timer-time' }, JA.fmtDuration(secs, true))),
      h('button', { class: 'timer-stop', type: 'button', onclick: () => JA.timer.stop(), 'aria-label': 'Stop timer', title: 'Stop timer' }, '■'));
  }
  setInterval(() => {
    const t = document.querySelector('#timer-pill .timer-time');
    if (t && data.timer.active) t.textContent = JA.fmtDuration((Date.now() - new Date(data.timer.active.startedAt)) / 1000, true);
  }, 1000);
  JA.me.onChange(renderTimerPill);

  // In-app reminder banner (the desktop app also shows a Windows notification).
  function renderReminderBanner() {
    const box = document.getElementById('reminder-banner');
    if (!box) return;
    const due = JA.me.reminders().filter((r) => new Date(r.remindAt) <= new Date());
    if (!due.length) { box.hidden = true; JA.clear(box); return; }
    box.hidden = false;
    JA.mount(box, h('span', { class: 'bell', 'aria-hidden': 'true' }, '⏰'),
      h('span', { class: 'banner-text' }, due.length === 1 ? 'Follow-up due: ' : `${due.length} follow-ups due: `,
        due.slice(0, 3).map((r, i) => [i ? ', ' : '', h('a', { href: `#/issue/${r.key}`, onclick: (e) => JA.openFromEvent(e, r.key, { tab: 'mine' }) }, r.key), r.remindNote ? ` (${r.remindNote})` : ''])),
      h('a', { class: 'btn small-btn', href: '#/home' }, 'Open tracker'));
  }
  JA.me.onChange(renderReminderBanner);
  setInterval(renderReminderBanner, 30000);
  setInterval(() => JA.me.load(), 60000);

  // ---- "Mine" tab in the issue view ------------------------------------------------------
  JA.tabs.mine = (ctx) => {
    const { issue } = ctx.data;
    const key = issue.key;
    const summary = issue.fields.summary;
    const box = h('div', { class: 'mine' });

    const render = () => {
      const r = JA.me.get(key);
      const doneCount = r.checklist.filter((c) => c.done).length;
      const pct = r.checklist.length ? Math.round((doneCount / r.checklist.length) * 100) : 0;
      const running = data.timer.active && data.timer.active.key === key;

      // Notes (autosave)
      const notes = h('textarea', { id: 'mine-notes', rows: 7, value: r.notes, placeholder: 'Private notes - only on this laptop. Decisions, questions for the reporter, links, test data…' });
      const saved = h('span', { class: 'muted small', 'aria-live': 'polite' });
      let t;
      notes.addEventListener('input', () => {
        saved.textContent = 'Saving…';
        clearTimeout(t);
        t = setTimeout(async () => {
          try { await JA.me.patch(key, { notes: notes.value }, summary); saved.textContent = 'Saved ✓'; } catch (err) { saved.textContent = 'Not saved'; }
        }, 600);
      });

      // Checklist
      const newItem = h('input', { type: 'text', placeholder: 'Add a checklist item and press Enter', 'aria-label': 'New checklist item' });
      const saveList = (list) => JA.me.patch(key, { checklist: list }, summary).then(render);
      newItem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && newItem.value.trim()) {
          e.preventDefault();
          saveList([...r.checklist, { text: newItem.value.trim(), done: false }]);
        }
      });

      // Reminder
      const toLocal = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
      const remindAt = h('input', { type: 'datetime-local', id: 'mine-remind', value: toLocal(r.remindAt) });
      const remindNote = h('input', { type: 'text', id: 'mine-remind-note', value: r.remindNote, placeholder: 'e.g. Ask Krishna about UIN', maxlength: 300 });
      const quick = (label, ms) => h('button', { class: 'btn chip-btn', type: 'button', onclick: () => { remindAt.value = toLocal(new Date(Date.now() + ms).toISOString()); } }, label);

      // Tags
      const tagInput = h('input', { type: 'text', placeholder: 'new tag', 'aria-label': 'New tag', maxlength: 30, class: 'tag-input' });
      tagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && tagInput.value.trim()) {
          e.preventDefault();
          JA.me.patch(key, { tags: [...r.tags, tagInput.value.trim().toLowerCase().replace(/\s+/g, '-')] }, summary).then(() => JA.me.load()).then(render);
        }
      });

      JA.mount(box,
        h('div', { class: 'mine-top' },
          h('button', {
            type: 'button',
            class: `big-toggle${r.focus ? ' on' : ''}`,
            'aria-pressed': String(r.focus),
            onclick: () => JA.me.patch(key, { focus: !r.focus }, summary).then(render),
          }, r.focus ? "🎯 In today's focus" : "☆ Add to today's focus"),
          h('button', {
            type: 'button',
            class: `big-toggle timer${running ? ' on' : ''}`,
            onclick: async () => { if (running) JA.timer.stop(); else { await JA.timer.start(key, summary); render(); } },
          }, running ? '■ Stop timer' : '▶ Start timer'),
          h('span', { class: 'tracked' }, `Tracked here: ${JA.fmtDuration(JA.me.trackedSeconds(key))}`)),

        h('h3', null, 'My tags'),
        h('div', { class: 'tag-row' },
          data.tags.map((t) => JA.tagChip(t.name, {
            button: true,
            active: r.tags.includes(t.name),
            onClick: () => JA.me.patch(key, { tags: r.tags.includes(t.name) ? r.tags.filter((x) => x !== t.name) : [...r.tags, t.name] }, summary).then(render),
          })),
          tagInput),

        h('h3', null, `Checklist ${r.checklist.length ? `(${doneCount}/${r.checklist.length})` : ''}`),
        r.checklist.length ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Checklist progress' }, h('span', { style: `width:${pct}%` })) : null,
        h('ul', { class: 'checklist' }, r.checklist.map((item, i) => h('li', { class: item.done ? 'done' : '' },
          h('label', { class: 'check-label' },
            h('input', {
              type: 'checkbox',
              checked: item.done,
              onchange: () => saveList(r.checklist.map((c, j) => (j === i ? { ...c, done: !c.done } : c))),
            }),
            h('span', null, item.text)),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete "${item.text}"`, onclick: () => saveList(r.checklist.filter((_, j) => j !== i)) }, '✕')))),
        newItem,

        h('h3', null, 'Follow-up reminder'),
        h('div', { class: 'form-grid' },
          h('div', null, h('label', { for: 'mine-remind' }, 'Remind me at'), remindAt),
          h('div', null, h('label', { for: 'mine-remind-note' }, 'About'), remindNote)),
        h('div', { class: 'row' },
          quick('+1 hour', 3600e3), quick('+3 hours', 3 * 3600e3), quick('Tomorrow', 24 * 3600e3), quick('Next week', 7 * 24 * 3600e3),
          h('span', { class: 'spacer' }),
          r.remindAt ? h('button', { class: 'btn', type: 'button', onclick: () => JA.me.patch(key, { remindAt: null, remindNote: '' }, summary).then(render) }, 'Clear') : null,
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              if (!remindAt.value) { JA.toast('Pick a date and time', 'error'); return; }
              await JA.me.patch(key, { remindAt: new Date(remindAt.value).toISOString(), remindNote: remindNote.value }, summary);
              JA.toast(`⏰ Reminder set for ${JA.fmtDate(new Date(remindAt.value))}`, 'ok');
              render();
            },
          }, 'Set reminder')),

        h('h3', null, h('label', { for: 'mine-notes', style: 'margin:0;font-size:14px' }, 'Private notes'), ' ', saved),
        notes);
    };
    render();
    return box;
  };
})(window.JA);
