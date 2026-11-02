/* Jira App - bootstrap and hash router. */
'use strict';

(function (JA) {
  const { h } = JA;
  const main = () => document.getElementById('main');

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/home';
    const [path, qs] = raw.split('?');
    return { path, params: new URLSearchParams(qs || '') };
  }

  function highlightNav(path) {
    const section = path.startsWith('/board') ? 'board' : path.startsWith('/search') ? 'search' : path.startsWith('/work') ? 'work' : path.startsWith('/home') || path === '/' ? 'home' : '';
    document.querySelectorAll('.topnav a').forEach((a) => {
      if (a.dataset.nav === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  JA.route = async () => {
    const { path, params } = parseHash();
    const el = main();
    JA.closePopover(false);
    JA.closeDrawer();
    highlightNav(path);
    JA.renderSidebar();
    const issueMatch = /^\/issue\/([^/]+)$/.exec(path);
    try {
      if (issueMatch) {
        await JA.renderIssue(el, decodeURIComponent(issueMatch[1]).toUpperCase(), params);
      } else if (path === '/create') {
        await JA.renderCreate(el, params);
      } else if (path === '/board') {
        await JA.renderBoard(el, params);
      } else if (path === '/search') {
        document.title = 'Filters - Jira App';
        await JA.renderSearch(el, params);
      } else if (path === '/work') {
        await JA.renderWork(el, params);
      } else {
        await JA.renderTracker(el, params);
      }
    } catch (err) {
      JA.mount(el, h('p', { class: 'error-text' }, err.message));
    }
    window.scrollTo(0, 0);
    if (document.activeElement === document.body) el.focus({ preventScroll: true });
  };

  function setupShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const a = document.activeElement;
      const tag = (a && a.tagName) || '';
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (a && a.isContentEditable)) return;
      const go = { c: '#/create', h: '#/home', w: '#/work', b: '#/board', f: '#/search' }[e.key];
      if (go) { e.preventDefault(); location.hash = go; }
    });
  }

  function setupTheme() {
    const btn = document.getElementById('theme-toggle');
    const apply = (theme) => {
      document.documentElement.dataset.theme = theme;
      btn.textContent = theme === 'dark' ? '☀' : '🌙';
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    };
    apply(JA.store.get('theme', 'dark'));
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      JA.store.set('theme', next);
      apply(next);
    });
  }

  function setupQuickSearch() {
    const form = document.getElementById('quick-search');
    const input = document.getElementById('quick-search-input');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const result = JA.interpretQuery(input.value);
      if (result.key) location.hash = `#/issue/${result.key}`;
      else location.hash = JA.searchHref(result.jql);
      input.select();
    });
    document.addEventListener('keydown', (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !document.activeElement.isContentEditable) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  function showSetupError(err) {
    JA.mount(main(), h('div', { class: 'card setup-error' },
      h('h1', null, 'Cannot connect to Jira'),
      h('p', { class: 'error-text' }, err.message),
      h('ol', null,
        h('li', null, 'Create an API token at ', h('a', { href: 'https://id.atlassian.com/manage-profile/security/api-tokens', target: '_blank', rel: 'noopener noreferrer' }, 'id.atlassian.com → Security → API tokens'), '.'),
        h('li', null, window.desktop
          ? 'Click ⚙ in the title bar and paste your e-mail and token.'
          : ['Create a ', h('code', null, 'config.json'), ' in the jira-app folder (copy ', h('code', null, 'config.example.json'), ') and fill in your e-mail and API token.']),
        h('li', null, 'Check that you are on the internet / VPN, then reload this page.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Retry')));
  }

  async function start() {
    setupTheme();
    JA.initDesktop();
    JA.initDrawer();
    setupQuickSearch();
    setupShortcuts();
    try {
      const session = await JA.api.get('/api/session', { quiet: true });
      JA.state.session = session;
      JA.state.token = session.token;
      JA.state.baseUrl = session.baseUrl;
      JA.mount(document.getElementById('user-box'), JA.avatar(session.user.displayName, 28));
    } catch (err) {
      JA.mount(document.getElementById('filter-list'));
      showSetupError(err);
      return;
    }
    window.addEventListener('hashchange', JA.route);
    JA.loadFavouriteFilters();
    await JA.me.load();
    await JA.route();
  }

  start();
})(window.JA);
