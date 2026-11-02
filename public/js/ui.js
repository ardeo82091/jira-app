/* Jira App - Jira-style UI components: issue type / priority icons, avatars, status picker, issue drawer. */
'use strict';

(function (JA) {
  const { h } = JA;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svg(viewBox, size, children, label) {
    const el = document.createElementNS(SVG_NS, 'svg');
    el.setAttribute('viewBox', viewBox);
    el.setAttribute('width', size);
    el.setAttribute('height', size);
    el.setAttribute('class', 'icon');
    if (label) {
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', label);
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = label;
      el.appendChild(title);
    } else {
      el.setAttribute('aria-hidden', 'true');
    }
    for (const [tag, attrs] of children) {
      const c = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
      el.appendChild(c);
    }
    return el;
  }

  const TYPE_STYLES = [
    { re: /epic/i, color: '#904ee2', shape: [['path', { d: 'M9.2 2.5 4.5 9h3.3l-1 4.5L11.5 7H8.2z', fill: '#fff' }]] },
    { re: /bug|defect|incident/i, color: '#e5493a', shape: [['circle', { cx: 8, cy: 8, r: 3.2, fill: '#fff' }]] },
    { re: /sub-?task/i, color: '#4bade8', shape: [['rect', { x: 4, y: 4, width: 4.5, height: 4.5, rx: 0.8, fill: 'none', stroke: '#fff', 'stroke-width': 1.4 }], ['rect', { x: 7.5, y: 7.5, width: 4.5, height: 4.5, rx: 0.8, fill: '#fff' }]] },
    { re: /story|feature|requirement/i, color: '#63ba3c', shape: [['path', { d: 'M5 3.5h6v9L8 10.5l-3 2z', fill: '#fff' }]] },
    { re: /task|change|request/i, color: '#4bade8', shape: [['path', { d: 'M4.5 8.2 7 10.6l4.6-5', fill: 'none', stroke: '#fff', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]] },
  ];

  /** Jira-like 16px issue type icon. */
  JA.typeIcon = (typeName) => {
    const name = String(typeName || 'Issue');
    const style = TYPE_STYLES.find((s) => s.re.test(name)) || { color: '#8590a2', shape: [['circle', { cx: 8, cy: 8, r: 2.2, fill: '#fff' }]] };
    return svg('0 0 16 16', 16, [['rect', { x: 0.5, y: 0.5, width: 15, height: 15, rx: 3, fill: style.color }], ...style.shape], name);
  };

  /** Jira-like priority arrows. */
  JA.priorityIcon = (priorityName) => {
    const name = String(priorityName || '');
    if (!name) return null;
    const n = name.toLowerCase();
    let color = '#ff8b00';
    let paths;
    if (/highest|blocker|critical|p0/.test(n)) { color = '#c9372c'; paths = [['path', { d: 'M3 8.5 8 4l5 4.5M3 12.5 8 8l5 4.5', fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]]; }
    else if (/high|major|p1/.test(n)) { color = '#e2483d'; paths = [['path', { d: 'M3 10.5 8 6l5 4.5', fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]]; }
    else if (/lowest|trivial/.test(n)) { color = '#0c66e4'; paths = [['path', { d: 'M3 3.5 8 8l5-4.5M3 7.5 8 12l5-4.5', fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]]; }
    else if (/low|minor/.test(n)) { color = '#1d7afc'; paths = [['path', { d: 'M3 5.5 8 10l5-4.5', fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]]; }
    else { paths = [['path', { d: 'M3 6h10M3 10h10', fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round' }]]; }
    return svg('0 0 16 16', 16, paths, `Priority: ${name}`);
  };

  const AVATAR_COLORS = ['#0c66e4', '#1f845a', '#c9372c', '#6e5dc6', '#e56910', '#227d9b', '#ae4787', '#5b7f24', '#943d73', '#0055cc'];
  /** Round avatar with initials (no external image requests). */
  JA.avatar = (name, size = 24) => {
    const label = String(name || '').trim();
    if (!label) {
      return h('span', { class: 'avatar empty', style: `width:${size}px;height:${size}px`, title: 'Unassigned', 'aria-label': 'Unassigned', role: 'img' }, '?');
    }
    const initials = label.split(/[\s(]+/).filter((p) => /^[A-Za-z]/.test(p)).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || label[0].toUpperCase();
    let hash = 0;
    for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
    return h('span', { class: 'avatar', style: `width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size * 0.42)}px`, title: label, 'aria-label': label, role: 'img' }, initials);
  };

  // ---- popover -----------------------------------------------------------------------
  let openPopover = null;
  function closePopover(restoreFocus) {
    if (!openPopover) return;
    const { el, anchor, onKey, onDoc } = openPopover;
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDoc, true);
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus) anchor.focus();
    openPopover = null;
  }
  JA.closePopover = closePopover;

  /** Opens a small menu under `anchor`. items: [{label, node?, onSelect}] or a Promise of them. */
  JA.popover = async (anchor, itemsOrPromise, opts = {}) => {
    if (openPopover && openPopover.anchor === anchor) { closePopover(true); return; }
    closePopover(false);
    const el = h('div', { class: 'popover', role: 'menu', 'aria-label': opts.label || 'Options' }, JA.spinner('Loading…'));
    document.body.appendChild(el);
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      let left = Math.min(r.left, window.innerWidth - w - 8);
      left = Math.max(8, left);
      let top = r.bottom + 4;
      if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 4);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    place();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePopover(true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const buttons = Array.from(el.querySelectorAll('button'));
        if (!buttons.length) return;
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    const onDoc = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover(false); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDoc, true);
    anchor.setAttribute('aria-expanded', 'true');
    openPopover = { el, anchor, onKey, onDoc };

    let items;
    try {
      items = await itemsOrPromise;
    } catch (err) {
      if (openPopover && openPopover.el === el) JA.mount(el, h('div', { class: 'popover-empty error-text' }, err.message));
      return;
    }
    if (!openPopover || openPopover.el !== el) return;
    JA.mount(el, items.length
      ? items.map((item) => h('button', {
        type: 'button',
        role: 'menuitem',
        class: 'popover-item',
        onclick: () => { closePopover(true); item.onSelect(); },
      }, item.node || item.label))
      : h('div', { class: 'popover-empty' }, opts.empty || 'Nothing to show'));
    place();
    const first = el.querySelector('button');
    if (first) first.focus();
  };

  // ---- status picker (lozenge with transitions dropdown, like Jira) ------------------
  const transitionCache = new Map();
  JA.loadTransitions = (key, force) => {
    if (force || !transitionCache.has(key)) {
      transitionCache.set(key, JA.api.get(`/api/issue/${key}/transitions`, { quiet: true }).catch((err) => { transitionCache.delete(key); throw err; }));
    }
    return transitionCache.get(key);
  };
  JA.forgetTransitions = (key) => transitionCache.delete(key);

  JA.doTransition = async (key, transition, commentText) => {
    if (transition.requiredFields && transition.requiredFields.length) {
      const ok = window.confirm(`"${transition.name}" needs: ${transition.requiredFields.join(', ')}.\nJira App can't fill those in, so Jira will probably reject it. Try anyway?`);
      if (!ok) return false;
    }
    await JA.api.post(`/api/issue/${key}/transitions`, { id: transition.id, commentText: commentText || '' });
    JA.forgetTransitions(key);
    JA.toast(`${key} → ${transition.to ? transition.to.name : transition.name}`, 'ok');
    return true;
  };

  /** A status lozenge button; clicking it lists transitions. onChanged(transition) after success. */
  JA.statusPicker = (key, status, onChanged) => {
    const name = status ? (status.name || status) : 'Unknown';
    const category = status ? (status.category || (status.statusCategory && status.statusCategory.key) || '') : '';
    const btn = h('button', {
      type: 'button',
      class: `lozenge-btn badge ${JA.tone(name, category)}`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': `Status: ${name}. Change status`,
      title: 'Change status',
    }, name, h('span', { class: 'caret', 'aria-hidden': 'true' }, ' ▾'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      JA.popover(btn, JA.loadTransitions(key).then((list) => list.map((t) => ({
        node: t.to && t.to.name === t.name
          ? h('span', { class: `badge ${JA.tone(t.to.name, t.to.category)}` }, t.to.name)
          : h('span', { class: 'row', style: 'gap:6px' }, t.name, t.to ? h('span', { class: 'muted small' }, '→') : null,
            t.to ? h('span', { class: `badge ${JA.tone(t.to.name, t.to.category)}` }, t.to.name) : null),
        onSelect: async () => {
          try {
            if (await JA.doTransition(key, t)) onChanged && onChanged(t);
          } catch (err) { /* toast shown */ }
        },
      }))), { label: `Transitions for ${key}`, empty: 'No transitions available' });
    });
    return btn;
  };

  // ---- issue drawer (Jira's side "issue view") -----------------------------------------
  const drawerState = { key: null, onChange: null, returnFocus: null };

  JA.openDrawer = (key, opts = {}) => {
    const drawer = document.getElementById('drawer');
    const body = document.getElementById('drawer-body');
    drawerState.key = key;
    drawerState.onChange = opts.onChange || null;
    drawerState.returnFocus = document.activeElement;
    drawer.hidden = false;
    document.body.classList.add('drawer-open');
    document.getElementById('drawer-full').href = `#/issue/${key}`;
    document.getElementById('drawer-title').textContent = key;
    JA.renderIssue(body, key, new URLSearchParams(opts.tab ? { tab: opts.tab } : {}), {
      embedded: true,
      onChange: (changedKey) => drawerState.onChange && drawerState.onChange(changedKey),
    });
    document.getElementById('drawer-close').focus();
  };

  JA.closeDrawer = () => {
    const drawer = document.getElementById('drawer');
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    document.body.classList.remove('drawer-open');
    JA.clear(document.getElementById('drawer-body'));
    drawerState.key = null;
    if (drawerState.returnFocus && document.body.contains(drawerState.returnFocus)) drawerState.returnFocus.focus();
  };
  JA.drawerKey = () => drawerState.key;

  JA.initDrawer = () => {
    const topbar = document.querySelector('.topbar');
    if (topbar && window.ResizeObserver) {
      new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
    }
    document.getElementById('drawer-close').addEventListener('click', JA.closeDrawer);
    document.getElementById('drawer-full').addEventListener('click', () => setTimeout(JA.closeDrawer, 0));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !openPopover && !document.getElementById('drawer').hidden) {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'TEXTAREA' || (tag === 'INPUT' && document.activeElement.value)) return;
        JA.closeDrawer();
      }
    });
  };

  /** Click handler for list rows / cards: plain click opens the drawer, Ctrl/middle-click keeps the link. */
  JA.openFromEvent = (e, key, opts) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    JA.openDrawer(key, opts);
  };

  // ---- desktop (Electron) integration ---------------------------------------------------
  JA.initDesktop = () => {
    const desktop = window.desktop;
    const bar = document.getElementById('titlebar');
    if (!desktop || !desktop.isDesktop) return;
    document.body.classList.add('desktop');
    bar.hidden = false;
    const pin = document.getElementById('tb-pin');
    const compact = document.getElementById('tb-compact');
    const max = document.getElementById('tb-max');
    let state = { compact: false, alwaysOnTop: false };
    pin.addEventListener('click', () => desktop.setPin(!state.alwaysOnTop));
    compact.addEventListener('click', () => desktop.setCompact(!state.compact));
    max.addEventListener('click', () => desktop.toggleMaximize());
    document.getElementById('tb-min').addEventListener('click', () => desktop.minimize());
    document.getElementById('tb-close').addEventListener('click', () => desktop.hide());
    document.getElementById('tb-settings').addEventListener('click', () => desktop.openSettings());
    bar.addEventListener('dblclick', (e) => { if (e.target === bar || e.target.classList.contains('tb-drag')) desktop.toggleMaximize(); });
    desktop.onState((s) => {
      state = s;
      document.body.classList.toggle('compact', !!s.compact);
      pin.setAttribute('aria-pressed', s.alwaysOnTop ? 'true' : 'false');
      pin.title = s.alwaysOnTop ? 'Unpin (stop floating on top)' : 'Pin on top of other windows';
      compact.setAttribute('aria-pressed', s.compact ? 'true' : 'false');
      compact.title = s.compact ? 'Expand to full window' : 'Shrink to floating widget';
      compact.textContent = s.compact ? '⤢' : '⤡';
      max.textContent = s.maximized ? '❐' : '☐';
      max.title = s.maximized ? 'Restore' : 'Maximize';
      document.getElementById('tb-hint').textContent = s.shortcut ? `${s.shortcut} to show/hide` : '';
    });
    desktop.onNavigate((hash) => {
      if (/^#\/[\w/?=&%.-]*$/.test(hash)) location.hash = hash;
    });
    if (desktop.onRefresh) desktop.onRefresh(() => JA.me && JA.me.load());
    desktop.requestState();
  };

  /** Sub-task hierarchy chips for list rows: "↳ parent" on sub-tasks, "☰ done/total" on parents. */
  JA.hierarchyChips = (issue) => {
    if (!issue) return null;
    const parts = [];
    if (issue.parent && issue.parent.key) {
      parts.push(h('span', {
        class: 'hier-chip hier-parent',
        title: `Sub-task of ${issue.parent.key} ${issue.parent.summary || ''}`.trim(),
      }, h('span', { 'aria-hidden': 'true' }, '↳ '), h('span', { class: 'visually-hidden' }, 'Sub-task of '), issue.parent.key));
    }
    if (issue.subtasks) {
      const all = issue.subtasksDone === issue.subtasks;
      parts.push(h('span', {
        class: `hier-chip hier-subs${all ? ' all' : ''}`,
        title: `${issue.subtasksDone} of ${issue.subtasks} sub-tasks done`,
      }, h('span', { 'aria-hidden': 'true' }, '☰ '), `${issue.subtasksDone}/${issue.subtasks}`, h('span', { class: 'visually-hidden' }, ' sub-tasks done')));
    }
    return parts.length ? parts : null;
  };
})(window.JA);
