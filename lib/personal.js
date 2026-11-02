'use strict';

/**
 * Personal tracking data that lives only on this laptop (never sent to Jira unless you
 * choose "log work"): focus list, private notes, checklists, personal tags, follow-up
 * reminders and a time tracker.
 *
 * Stored as JSON in %APPDATA%\jira-app\personal.json (or $JIRA_APP_DATA_DIR/personal.json).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_NOTES = 20000;
const MAX_CHECKLIST = 100;
const MAX_TAGS = 12;
const MAX_ENTRIES = 5000;
const TAG_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#60a5fa', '#818cf8', '#c084fc', '#f472b6'];
const DEFAULT_TAGS = [
  { name: 'follow-up', color: '#fbbf24' },
  { name: 'waiting', color: '#22d3ee' },
  { name: 'blocked', color: '#f87171' },
  { name: 'review', color: '#c084fc' },
  { name: 'urgent', color: '#fb923c' },
  { name: 'idea', color: '#34d399' },
];

function dataDir() {
  if (process.env.JIRA_APP_DATA_DIR) return process.env.JIRA_APP_DATA_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'jira-app');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'jira-app');
  return path.join(os.homedir(), '.jira-app');
}
const filePath = () => path.join(dataDir(), 'personal.json');

function emptyData() {
  return { version: 1, issues: {}, tags: DEFAULT_TAGS.slice(), timer: { active: null, entries: [] } };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    const data = { ...emptyData(), ...raw };
    data.issues = raw.issues && typeof raw.issues === 'object' ? raw.issues : {};
    data.tags = Array.isArray(raw.tags) ? raw.tags : DEFAULT_TAGS.slice();
    data.timer = { active: null, entries: [], ...(raw.timer || {}) };
    return data;
  } catch (err) {
    return emptyData();
  }
}

function save(data) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function checkKey(key) {
  const k = String(key || '').trim().toUpperCase();
  if (!KEY_RE.test(k)) throw new ValidationError('Invalid issue key.');
  return k;
}
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
const cleanText = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);

/** Applies a partial update to one issue's personal record and returns it. */
function patchIssue(key, patch) {
  const k = checkKey(key);
  if (!patch || typeof patch !== 'object') throw new ValidationError('Nothing to update.');
  const data = load();
  const rec = { notes: '', checklist: [], tags: [], focus: false, focusOrder: 0, remindAt: null, remindNote: '', reminded: false, summary: '', ...(data.issues[k] || {}) };

  if (patch.notes !== undefined) {
    if (String(patch.notes).length > MAX_NOTES) throw new ValidationError(`Notes are limited to ${MAX_NOTES} characters.`);
    rec.notes = cleanText(patch.notes, MAX_NOTES);
  }
  if (patch.checklist !== undefined) {
    if (!Array.isArray(patch.checklist) || patch.checklist.length > MAX_CHECKLIST) throw new ValidationError(`Checklist is limited to ${MAX_CHECKLIST} items.`);
    rec.checklist = patch.checklist
      .map((item) => ({ id: /^[a-z0-9]{1,16}$/i.test(item && item.id) ? item.id : crypto.randomBytes(4).toString('hex'), text: cleanText(item && item.text, 300).trim(), done: !!(item && item.done) }))
      .filter((item) => item.text);
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > MAX_TAGS) throw new ValidationError(`Up to ${MAX_TAGS} tags per issue.`);
    rec.tags = [...new Set(patch.tags.map((t) => cleanText(t, 30).trim().toLowerCase()).filter(Boolean))];
  }
  if (patch.focus !== undefined) {
    rec.focus = !!patch.focus;
    if (rec.focus && !(data.issues[k] && data.issues[k].focus)) {
      rec.focusOrder = Math.max(0, ...Object.values(data.issues).filter((i) => i.focus).map((i) => i.focusOrder || 0)) + 1;
    }
  }
  if (patch.focusOrder !== undefined && Number.isFinite(Number(patch.focusOrder))) rec.focusOrder = Number(patch.focusOrder);
  if (patch.remindAt !== undefined) {
    if (patch.remindAt === null || patch.remindAt === '') {
      rec.remindAt = null;
      rec.reminded = false;
    } else {
      const d = new Date(patch.remindAt);
      if (Number.isNaN(d.getTime())) throw new ValidationError('Invalid reminder date.');
      rec.remindAt = d.toISOString();
      rec.reminded = false;
    }
  }
  if (patch.remindNote !== undefined) rec.remindNote = cleanText(patch.remindNote, 300);
  if (patch.reminded !== undefined) rec.reminded = !!patch.reminded;
  if (patch.summary !== undefined) rec.summary = cleanText(patch.summary, 255);
  rec.updatedAt = new Date().toISOString();

  // Drop empty records to keep the file small.
  const empty = !rec.notes && !rec.checklist.length && !rec.tags.length && !rec.focus && !rec.remindAt;
  if (empty) delete data.issues[k]; else data.issues[k] = rec;

  // Remember new tag names in the palette.
  for (const t of rec.tags) {
    if (!data.tags.some((x) => x.name === t)) data.tags.push({ name: t, color: TAG_COLORS[data.tags.length % TAG_COLORS.length] });
  }
  save(data);
  return empty ? null : rec;
}

function setTags(tags) {
  if (!Array.isArray(tags) || tags.length > 50) throw new ValidationError('Invalid tag list.');
  const data = load();
  data.tags = tags
    .map((t) => ({ name: cleanText(t && t.name, 30).trim().toLowerCase(), color: isColor(t && t.color) ? t.color : TAG_COLORS[0] }))
    .filter((t) => t.name);
  save(data);
  return data.tags;
}

function startTimer(key, summary) {
  const k = checkKey(key);
  const data = load();
  let stopped = null;
  if (data.timer.active) stopped = finishActive(data);
  data.timer.active = { key: k, summary: cleanText(summary, 255), startedAt: new Date().toISOString() };
  save(data);
  return { active: data.timer.active, stopped };
}

function finishActive(data) {
  const a = data.timer.active;
  if (!a) return null;
  const end = new Date();
  const seconds = Math.max(0, Math.round((end - new Date(a.startedAt)) / 1000));
  const entry = { id: crypto.randomBytes(5).toString('hex'), key: a.key, summary: a.summary || '', start: a.startedAt, end: end.toISOString(), seconds, logged: false };
  data.timer.entries.push(entry);
  if (data.timer.entries.length > MAX_ENTRIES) data.timer.entries = data.timer.entries.slice(-MAX_ENTRIES);
  data.timer.active = null;
  return entry;
}

function stopTimer() {
  const data = load();
  const entry = finishActive(data);
  save(data);
  return entry;
}

function markLogged(entryId) {
  const data = load();
  const e = data.timer.entries.find((x) => x.id === entryId);
  if (e) { e.logged = true; save(data); }
  return e || null;
}

function deleteEntry(entryId) {
  const data = load();
  const before = data.timer.entries.length;
  data.timer.entries = data.timer.entries.filter((x) => x.id !== entryId);
  if (data.timer.entries.length !== before) save(data);
  return before !== data.timer.entries.length;
}

/** Reminders that are due and not yet notified. */
function dueReminders(now = new Date()) {
  const data = load();
  return Object.entries(data.issues)
    .filter(([, r]) => r.remindAt && !r.reminded && new Date(r.remindAt) <= now)
    .map(([key, r]) => ({ key, ...r }));
}

/** Rounds seconds to Jira's "1h 25m" format (minimum 1 minute). */
function toJiraDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '1m';
}

module.exports = {
  load, save, patchIssue, setTags, startTimer, stopTimer, markLogged, deleteEntry, dueReminders, toJiraDuration, filePath, ValidationError, TAG_COLORS,
};
