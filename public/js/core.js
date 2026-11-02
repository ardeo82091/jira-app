/* Jira App - shared helpers (API client, DOM builder, HTML sanitiser, toasts). */
'use strict';

window.JA = window.JA || {};

(function (JA) {
  JA.state = { session: null, token: '', baseUrl: '', lastSearch: null };

  // ---- API ---------------------------------------------------------------
  async function api(method, path, body, opts) {
    const init = { method, headers: { 'X-Jira-App': '1', Accept: 'application/json' } };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      throw new Error('Jira App server is not running. Start it with: node server.js');
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = { error: text }; }
    }
    if (!res.ok) {
      const error = new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
      error.status = res.status;
      error.details = data && data.details;
      if (!(opts && opts.quiet)) toast(error.message, 'error');
      throw error;
    }
    return data;
  }
  JA.api = {
    get: (p, o) => api('GET', p, undefined, o),
    post: (p, b, o) => api('POST', p, b, o),
    put: (p, b, o) => api('PUT', p, b, o),
    del: (p, o) => api('DELETE', p, undefined, o),
  };

  // ---- DOM builder ---------------------------------------------------------
  /** h('div', {class:'x', onclick: fn}, child, 'text', [children]) */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendChildren(el, child);
      else if (child instanceof Node) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
  }
  JA.h = h;
  JA.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  JA.mount = (el, ...children) => { JA.clear(el); appendChildren(el, children); return el; };

  // ---- toasts ------------------------------------------------------------
  function toast(message, kind) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = h('div', { class: `toast ${kind || ''}` }, message);
    box.appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3500);
  }
  JA.toast = toast;

  // ---- formatting --------------------------------------------------------
  JA.fmtDate = (iso, withTime = true) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return withTime
      ? d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  };
  JA.relTime = (iso) => {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (Math.abs(diff) < 60) return 'just now';
    if (diff < 0) {
      // future date
      const abs = -diff;
      if (abs < 3600) return `in ${Math.round(abs / 60)} min`;
      if (abs < 86400) return `in ${Math.round(abs / 3600)} h`;
      return `in ${Math.round(abs / 86400)} d`;
    }
    if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
    if (diff < 86400 * 30) return `${Math.round(diff / 86400)} d ago`;
    return JA.fmtDate(iso, false);
  };
  /** Colour family for a status: different colours for to-do, progress, review, blocked and done. */
  JA.tone = (name, category) => {
    const n = String(name || '').toLowerCase();
    let tone;
    if (category === 'done' || /\b(done|closed|resolved|complete|released|deployed)\b/.test(n)) tone = 'done';
    else if (/block|hold|wait|impediment|pending|on.?hold|rejected|to.?fix|fix|reopen|fail|defect/.test(n)) tone = 'blocked';
    else if (/review|qa|test|uat|verify|validation|sign.?off/.test(n)) tone = 'review';
    else if (category === 'indeterminate' || /progress|dev|doing|working|started|analysis|build/.test(n)) tone = 'progress';
    else tone = 'todo';
    return `${category || ''} tone-${tone}`;
  };
  JA.statusBadge = (status) => {
    if (!status) return '';
    const name = status.name || status;
    const category = status.category || (status.statusCategory && status.statusCategory.key) || '';
    return h('span', { class: `badge ${JA.tone(name, category)}` }, name);
  };
  JA.bytes = (n) => {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  JA.spinner = (label) => h('p', { class: 'muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${label || 'Loading…'}`);
  JA.copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label || 'Text'} copied`, 'ok');
    } catch (err) {
      toast('Could not copy to clipboard', 'error');
    }
  };
  JA.download = (filename, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/markdown' }));
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  JA.modal = (title, content) => {
    const pre = h('pre', { style: 'white-space:pre-wrap;max-height:55vh;overflow-y:auto;background:var(--surface-sunken);padding:14px;border-radius:8px;font-size:13px;line-height:1.5;margin:12px 0' }, content);
    const closeBtn = h('button', { class: 'btn primary', type: 'button' }, 'Close');
    const copyBtn = h('button', { class: 'btn', type: 'button', onclick: () => JA.copy(content, 'Content') }, '⧉ Copy');
    const dialog = h('dialog', { class: 'modal', style: 'max-width:680px;width:92%' },
      h('h2', { style: 'margin-top:0;font-size:18px' }, title),
      pre,
      h('div', { class: 'row end', style: 'margin-top:14px;gap:8px' }, copyBtn, closeBtn)
    );
    closeBtn.onclick = () => { dialog.close(); dialog.remove(); };
    dialog.addEventListener('click', (e) => { if (e.target === dialog) { dialog.close(); dialog.remove(); } });
    document.body.appendChild(dialog);
    dialog.showModal();
    return dialog;
  };

  JA.postToKiro = async (key) => {
    JA.toast(`Analyzing ${key} & posting summary to Kiro CLI…`, 'ok');
    try {
      const res = await JA.api.post(`/api/issue/${encodeURIComponent(key)}/kiro-summary`, {});
      if (res.ok) {
        JA.toast(`✓ Posted summary of ${key} to Kiro CLI!`, 'ok');
        if (res.kiroResponse) {
          JA.modal(`Kiro CLI Response – ${key}`, res.kiroResponse);
        }
      } else if (res.notInstalled) {
        if (res.markdown) await JA.copy(res.markdown, 'Summary');
        JA.toast(`Summary copied! (Kiro CLI not found on PATH)`, 'ok');
        JA.modal(
          `Kiro CLI – ${key} Summary`,
          `✓ Summary for ${key} has been copied to your clipboard!\n\n` +
          `Kiro CLI was not detected on system PATH.\n` +
          `To run Kiro manually in your terminal:\n` +
          `  kiro ask "Summarize and review Jira ticket ${key}"\n\n` +
          `--------------------------------------------------\n\n` +
          `Summary Preview:\n\n${(res.markdown || '').slice(0, 1500)}${(res.markdown && res.markdown.length > 1500) ? '...' : ''}`
        );
      } else {
        JA.toast(`Kiro CLI: ${res.kiroResponse || 'Could not post summary'}`, 'error');
      }
    } catch (err) {
      JA.toast(err.message, 'error');
    }
  };

  JA.issueKeyRe = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

  // ---- local storage (saved searches / recent issues) ----------------------
  JA.store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(`jira-app:${key}`)) || fallback; } catch (err) { return fallback; }
    },
    set(key, value) { localStorage.setItem(`jira-app:${key}`, JSON.stringify(value)); },
  };

  // ---- sanitiser for Jira-rendered HTML ------------------------------------
  const ALLOWED_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'sub', 'sup', 'p', 'br', 'hr', 'div', 'span',
    'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'tt', 'small', 'big', 'dl', 'dt', 'dd', 'font', 'cite', 'q', 'kbd', 'mark']);
  const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'frame', 'frameset', 'audio', 'video', 'source']);
  const ALLOWED_ATTRS = { a: ['title'], img: ['alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], col: ['span'], ol: ['start'] };
  const ATTACHMENT_RE = /\/(?:rest\/api\/[23]\/attachment\/(?:content|thumbnail)\/|secure\/attachment\/|secure\/thumbnail\/|attachment\/content\/)(\d+)/;
  const BROWSE_RE = /\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?(?:[?#].*)?$/;

  function isJiraUrl(url) {
    try { return new URL(url, JA.state.baseUrl).origin === new URL(JA.state.baseUrl).origin; } catch (err) { return false; }
  }

  function rewriteUrl(raw, forImage) {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (/^data:image\/(png|jpe?g|gif|webp);/i.test(value)) return forImage ? value : null;
    let abs;
    try { abs = new URL(value, JA.state.baseUrl); } catch (err) { return null; }
    if (!['http:', 'https:', 'mailto:'].includes(abs.protocol)) return null;
    if (isJiraUrl(abs.href)) {
      const att = ATTACHMENT_RE.exec(abs.pathname);
      if (att) return JA.attachmentUrl(att[1], !forImage);
      const browse = BROWSE_RE.exec(abs.pathname);
      if (browse && !forImage) return `#/issue/${browse[1]}`;
    }
    return abs.href;
  }

  function cleanNode(node, doc) {
    if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return null;
    const children = Array.from(node.childNodes).map((c) => cleanNode(c, doc)).filter(Boolean);
    if (!ALLOWED_TAGS.has(tag)) {
      const frag = doc.createDocumentFragment();
      children.forEach((c) => frag.appendChild(c));
      return frag;
    }
    const el = doc.createElement(tag === 'font' ? 'span' : tag);
    for (const attr of ALLOWED_ATTRS[tag] || []) {
      if (node.hasAttribute(attr)) el.setAttribute(attr, node.getAttribute(attr).slice(0, 500));
    }
    if (tag === 'a') {
      const href = rewriteUrl(node.getAttribute('href'), false);
      if (href) {
        el.setAttribute('href', href);
        if (!href.startsWith('#')) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }
    }
    if (tag === 'img') {
      const src = rewriteUrl(node.getAttribute('src'), true);
      if (!src) return doc.createTextNode(node.getAttribute('alt') || '[image]');
      el.setAttribute('src', src);
      el.setAttribute('loading', 'lazy');
      if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
    }
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  /** Returns a safe DOM fragment built from Jira's rendered HTML. */
  JA.safeHtml = (html) => {
    const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html || ''}</body>`, 'text/html');
    const frag = document.createDocumentFragment();
    Array.from(parsed.body.childNodes).forEach((n) => {
      const c = cleanNode(n, document);
      if (c) frag.appendChild(c);
    });
    return frag;
  };

  JA.attachmentUrl = (id, download) => `/api/attachment/${encodeURIComponent(id)}?t=${encodeURIComponent(JA.state.token)}${download ? '&download=1' : ''}`;
  JA.jiraBrowseUrl = (key) => `${JA.state.baseUrl}/browse/${encodeURIComponent(key)}`;
})(window.JA);
