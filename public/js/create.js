/* Jira App - create issue view. */
'use strict';

(function (JA) {
  const { h } = JA;

  function extraFieldInput(meta) {
    const id = `cf-${meta.id}`;
    const schema = meta.schema || {};
    let input;
    if (meta.allowedValues && meta.allowedValues.length) {
      const multiple = schema.type === 'array';
      input = h('select', { id, multiple: multiple || undefined, size: multiple ? Math.min(6, meta.allowedValues.length) : undefined },
        multiple ? null : h('option', { value: '' }, meta.required ? 'Select…' : '(none)'),
        meta.allowedValues.map((v) => h('option', { value: v.id }, v.name)));
    } else if (schema.type === 'number') {
      input = h('input', { id, type: 'number', step: 'any' });
    } else if (schema.type === 'date') {
      input = h('input', { id, type: 'date' });
    } else if (schema.type === 'string' && typeof schema.custom === 'string' && schema.custom.endsWith(':textarea')) {
      input = h('textarea', { id, rows: 3 });
    } else if (schema.type === 'string' || (schema.type === 'array' && schema.items === 'string')) {
      input = h('input', { id, type: 'text', placeholder: schema.type === 'array' ? 'comma separated' : '' });
    } else {
      return { node: h('div', null, h('label', null, meta.name, meta.required ? ' *' : ''), h('p', { class: 'small muted' }, `This field type (${schema.type || 'unknown'}) can't be set here. Set it in Jira after creating the issue.`)), read: () => undefined };
    }
    const read = () => {
      if (input.multiple) return Array.from(input.selectedOptions).map((o) => o.value);
      return input.value;
    };
    return { node: h('div', { class: input.tagName === 'TEXTAREA' ? 'wide' : '' }, h('label', { for: id }, meta.name, meta.required ? ' *' : ''), input), read, meta };
  }

  JA.renderCreate = async (main, params) => {
    document.title = 'Create issue - Jira App';
    const projectSearch = h('input', { id: 'c-project-search', type: 'search', placeholder: 'Search project name or key…', autocomplete: 'off' });
    const projectSelect = h('select', { id: 'c-project', required: true }, h('option', { value: '' }, 'Loading projects…'));
    const typeSelect = h('select', { id: 'c-type', required: true, disabled: true }, h('option', { value: '' }, 'Choose a project first'));
    const summary = h('input', { id: 'c-summary', type: 'text', maxlength: 255, required: true });
    const description = h('textarea', { id: 'c-desc', rows: 10, placeholder: 'Blank line = new paragraph, "- " = bullet, "1. " = numbered list' });
    const parent = h('input', { id: 'c-parent', type: 'text', placeholder: 'Optional, e.g. FUL2-300000 (epic or parent for sub-task)', value: params.get('parent') || '' });
    const extraBox = h('div', { class: 'form-grid' });
    const optionalToggle = h('input', { type: 'checkbox', id: 'c-optional' });
    let extraInputs = [];
    let fieldMeta = [];

    const loadProjects = async (query) => {
      try {
        const projects = await JA.api.get(`/api/projects?query=${encodeURIComponent(query || '')}`, { quiet: true });
        const remembered = params.get('project') || JA.store.get('lastProject', '');
        JA.mount(projectSelect, h('option', { value: '' }, projects.length ? 'Select project…' : 'No projects found'),
          projects.map((p) => h('option', { value: p.key, selected: p.key === remembered }, `${p.name} (${p.key})`)));
        if (projectSelect.value) loadTypes();
      } catch (err) {
        JA.mount(projectSelect, h('option', { value: '' }, `Error: ${err.message}`));
      }
    };
    let searchTimer;
    projectSearch.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadProjects(projectSearch.value), 300); });

    const renderExtra = () => {
      const show = fieldMeta.filter((m) => m.required || optionalToggle.checked);
      extraInputs = show.map(extraFieldInput);
      JA.mount(extraBox, extraInputs.length ? extraInputs.map((e) => e.node) : h('p', { class: 'muted small wide' }, 'No other required fields.'));
    };
    optionalToggle.addEventListener('change', renderExtra);

    const loadFields = async () => {
      fieldMeta = [];
      JA.mount(extraBox, JA.spinner('Loading fields…'));
      if (!projectSelect.value || !typeSelect.value) { JA.clear(extraBox); return; }
      try {
        fieldMeta = await JA.api.get(`/api/projects/${encodeURIComponent(projectSelect.value)}/issuetypes/${encodeURIComponent(typeSelect.value)}/fields`, { quiet: true });
        renderExtra();
      } catch (err) {
        JA.mount(extraBox, h('p', { class: 'error-text' }, err.message));
      }
    };

    const loadTypes = async () => {
      typeSelect.disabled = true;
      JA.mount(typeSelect, h('option', { value: '' }, 'Loading…'));
      if (!projectSelect.value) return;
      JA.store.set('lastProject', projectSelect.value);
      try {
        const types = await JA.api.get(`/api/projects/${encodeURIComponent(projectSelect.value)}/issuetypes`, { quiet: true });
        const rememberedType = JA.store.get('lastType', 'Story');
        JA.mount(typeSelect, h('option', { value: '' }, 'Select type…'), types.map((t) => h('option', { value: t.id, selected: t.name === rememberedType }, `${t.name}${t.subtask ? ' (sub-task)' : ''}`)));
        typeSelect.disabled = false;
        if (typeSelect.value) loadFields();
      } catch (err) {
        JA.mount(typeSelect, h('option', { value: '' }, `Error: ${err.message}`));
      }
    };
    projectSelect.addEventListener('change', loadTypes);
    typeSelect.addEventListener('change', () => {
      const opt = typeSelect.selectedOptions[0];
      if (opt && opt.value) JA.store.set('lastType', opt.textContent.replace(' (sub-task)', ''));
      loadFields();
    });

    const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Create issue');
    const errorBox = h('div', { 'aria-live': 'assertive' });
    const form = h('form', { class: 'card', novalidate: true },
      h('div', { class: 'form-grid' },
        h('div', null, h('label', { for: 'c-project-search' }, 'Find project'), projectSearch),
        h('div', null, h('label', { for: 'c-project' }, 'Project *'), projectSelect),
        h('div', null, h('label', { for: 'c-type' }, 'Issue type *'), typeSelect),
        h('div', null, h('label', { for: 'c-parent' }, 'Parent / epic key'), parent),
        h('div', { class: 'wide' }, h('label', { for: 'c-summary' }, 'Summary *'), summary),
        h('div', { class: 'wide' }, h('label', { for: 'c-desc' }, 'Description'), description)),
      h('h2', null, 'Other fields'),
      h('div', { class: 'row' }, optionalToggle, h('label', { for: 'c-optional', style: 'margin:0;font-weight:400' }, 'Show optional fields too')),
      extraBox,
      errorBox,
      h('div', { class: 'row end' }, h('a', { class: 'btn', href: '#/search' }, 'Cancel'), submitBtn));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      JA.clear(errorBox);
      if (!projectSelect.value || !typeSelect.value || !summary.value.trim()) {
        JA.mount(errorBox, h('p', { class: 'error-text' }, 'Project, issue type and summary are required.'));
        return;
      }
      const parentKey = parent.value.trim().toUpperCase();
      if (parentKey && !JA.issueKeyRe.test(parentKey)) {
        JA.mount(errorBox, h('p', { class: 'error-text' }, 'Parent must be an issue key like FUL2-123.'));
        return;
      }
      const extraFields = {};
      for (const input of extraInputs) {
        if (!input.meta) continue;
        const value = input.read();
        if (value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) extraFields[input.meta.id] = value;
        else if (input.meta.required) {
          JA.mount(errorBox, h('p', { class: 'error-text' }, `"${input.meta.name}" is required.`));
          return;
        }
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      try {
        const created = await JA.api.post('/api/issue', {
          projectKey: projectSelect.value,
          issueTypeId: typeSelect.value,
          summary: summary.value,
          descriptionText: description.value,
          parentKey: parentKey || undefined,
          extraFields,
        }, { quiet: true });
        JA.toast(`Created ${created.key}`, 'ok');
        location.hash = `#/issue/${created.key}`;
      } catch (err) {
        JA.mount(errorBox, h('p', { class: 'error-text' }, err.message));
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create issue';
      }
    });

    JA.mount(main, h('h1', null, 'Create issue'), form);
    loadProjects('');
    summary.focus();
  };
})(window.JA);
