'use strict';

(async function setup() {
  const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  const show = (text, kind) => { msg.textContent = text; msg.className = `msg ${kind}`; };

  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'widget') document.body.classList.add('widget-mode');
  const initialMessage = params.get('message');
  if (initialMessage) show(initialMessage, 'error');

  const current = await window.desktop.getSettings();
  if (current) {
    $('baseUrl').value = current.baseUrl;
    $('email').value = current.email;
    if (current.hasToken) {
      $('token').placeholder = 'Saved (leave empty to keep it)';
      $('token-hint').prepend('A token is already saved. ');
    }
  }
  ($('email').value ? $('token') : $('email')).focus();

  const openTokenPage = (e) => {
    e.preventDefault();
    window.desktop.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens');
  };
  $('token-link').addEventListener('click', openTokenPage);
  if ($('token-link-2')) $('token-link-2').addEventListener('click', openTokenPage);
  $('cancel').addEventListener('click', () => window.close());

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const save = $('save');
    save.disabled = true;
    save.textContent = 'Testing…';
    show('Connecting to Jira…', 'ok');
    const result = await window.desktop.saveSettings({
      baseUrl: $('baseUrl').value,
      email: $('email').value,
      apiToken: $('token').value,
    });
    $('token').value = '';
    if (result && result.ok) {
      show(`Connected as ${result.user}. Opening Jira App…`, 'ok');
    } else {
      show((result && result.error) || 'Could not save settings.', 'error');
      save.disabled = false;
      save.textContent = 'Test & save';
    }
  });
})();
