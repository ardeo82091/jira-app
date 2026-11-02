'use strict';

const { adfToText, adfTables, rowsToMarkdown } = require('./adf');

/**
 * Rule-based ticket analysis (runs locally, no AI service, nothing leaves the laptop
 * except the normal Jira API calls). It turns a ticket into:
 *  - objective and acceptance criteria
 *  - business rules (numbers, limits, defaults, conditions) that need implementing/testing
 *  - tables found in the description
 *  - open questions / TBD items to clarify with the reporter
 *  - ticket hygiene warnings (missing assignee, estimate, etc.)
 *  - suggested test scenarios
 *  - a Markdown report you can paste into a comment, design doc or chat
 */

const OPEN_ITEM_RE = /\b(TBD|TBC|TBA|to be (decided|confirmed|discussed|shared)|pending|clarif\w*|not (yet )?(final|confirmed|decided)|open (point|question)|awaiting|need(s)? (confirmation|input)|WIP)\b/i;
const RULE_RE = /(\d+(\.\d+)?\s*(%|x|years?|yrs?|days?|months?|lakh|lac|crore|cr|rs\.?|inr|₹)|\bminimum\b|\bmaximum\b|\bmin\b|\bmax\b|\bdefault\b|\bmandatory\b|\boptional\b|\bnot allowed\b|\bonly\b|\bmust\b|\bshould\b|\bif\b|\bin case\b|\bfreez|\bread-only\b|\bnon-editable\b|\bdisabled?\b|\bhidden\b|\bvisible\b|\bpopup\b|\bpop up\b|\berror\b|\bvalidation\b)/i;
const NUMBER_RE = /\d+(\.\d+)?/;
const HEADER_AC_RE = /^\W*(acceptance criteria|acceptance criterion|\bac\b)\W*/i;
const HEADER_OBJECTIVE_RE = /^\W*(objective|goal|purpose|summary|user story|as an? )/i;
const BULLET_PREFIX_RE = /^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s+/;
const CONFLICT_PAIRS = [
  [/\b(freez\w*|read-only|non-editable|disabled|default(ed)? and fixed)\b/i, /\b(select|editable|dropdown|user can (choose|select|enter)|all (values|options))\b/i],
  [/\bmandatory\b/i, /\boptional\b/i],
  [/\bnot allowed\b/i, /\ballowed\b/i],
];

function stripMarkup(line) {
  return line
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\\([*_|`~[\]()#-])/g, '$1')
    .replace(/(^|\s)_(\S.*?\S|\S)_(?=\s|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBullet(line) {
  return stripMarkup(line.replace(BULLET_PREFIX_RE, ''));
}

function unique(list) {
  const seen = new Set();
  return list.filter((item) => {
    const k = item.toLowerCase();
    if (!item || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function fieldByName(issue, ...candidates) {
  const names = issue.names || {};
  const wanted = candidates.map((c) => c.toLowerCase());
  for (const [id, name] of Object.entries(names)) {
    if (wanted.includes(String(name).toLowerCase())) {
      const value = issue.fields ? issue.fields[id] : undefined;
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function extractSections(lines) {
  let objective = '';
  const acceptance = [];
  let inAc = false;
  let acHeaderSeen = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripMarkup(raw);
    if (!line) continue;

    if (!objective && HEADER_OBJECTIVE_RE.test(line)) {
      const rest = line.replace(HEADER_OBJECTIVE_RE, '').replace(/^[\s:–—-]+/, '').trim();
      objective = rest || stripMarkup(lines[i + 1] || '');
      if (/^as an? /i.test(line)) objective = line;
      continue;
    }
    if (HEADER_AC_RE.test(line)) {
      inAc = true;
      acHeaderSeen = true;
      const rest = line.replace(HEADER_AC_RE, '').replace(/^[\s:–—-]+/, '').trim();
      if (rest) acceptance.push(rest);
      continue;
    }
    if (inAc && /^#{1,6}\s/.test(raw) && !HEADER_AC_RE.test(line)) inAc = false;
    if (inAc && !raw.startsWith('|')) acceptance.push(cleanBullet(raw));
  }

  if (!acHeaderSeen) {
    for (const raw of lines) if (BULLET_PREFIX_RE.test(raw)) acceptance.push(cleanBullet(raw));
  }
  if (!objective) {
    const first = lines.map(stripMarkup).find((l) => l && !l.startsWith('|'));
    objective = first || '';
  }
  return { objective, acceptance: unique(acceptance.filter((a) => a.length > 1)) };
}

function findConflicts(lines) {
  const conflicts = [];
  const cleaned = lines.map(stripMarkup).filter(Boolean);
  for (const line of cleaned) {
    for (const [a, b] of CONFLICT_PAIRS) {
      if (a.test(line) && b.test(line)) conflicts.push(line);
    }
  }
  return unique(conflicts);
}

function testScenarios(rules, tables) {
  const scenarios = [];
  for (const rule of rules) {
    scenarios.push(`Verify: ${rule}`);
    if (NUMBER_RE.test(rule) && /\b(min|max|minimum|maximum|age|term|limit|range|to|between|>=|<=|less|greater)\b/i.test(rule)) {
      scenarios.push(`Boundary: test just below, at, and just above each limit in "${rule.length > 90 ? `${rule.slice(0, 87)}...` : rule}"`);
    }
  }
  tables.forEach((rows, index) => {
    if (rows.length > 1) scenarios.push(`Table ${index + 1}: one test per row (${rows.length - 1} rows) covering every column combination.`);
  });
  return unique(scenarios).slice(0, 150);
}

function hygiene(issue, comments) {
  const f = issue.fields || {};
  const warnings = [];
  const statusCategory = f.status && f.status.statusCategory && f.status.statusCategory.key;
  if (!f.assignee) warnings.push('No assignee.');
  if (!f.description) warnings.push('Description is empty.');
  if (statusCategory !== 'done' && !f.duedate) warnings.push('No due date.');
  if (!f.fixVersions || !f.fixVersions.length) warnings.push('No fix version / release.');
  if (!f.components || !f.components.length) warnings.push('No component.');
  if (!f.labels || !f.labels.length) warnings.push('No labels.');
  if (!f.issuelinks || !f.issuelinks.length) warnings.push('No linked issues (epic/parent, dependencies or test cases).');
  if (!comments || !comments.length) warnings.push('No comments / discussion yet.');
  if (!f.attachment || !f.attachment.length) warnings.push('No attachments (BRD, mock-ups, rate tables).');
  const sp = fieldByName(issue, 'Story Points', 'Story point estimate');
  if (f.issuetype && /story|task|bug/i.test(f.issuetype.name || '') && (sp === undefined) && !f.timeoriginalestimate) {
    warnings.push('No estimate (story points or original estimate).');
  }
  return warnings;
}

function analyzeIssue(issue, comments = [], remoteLinks = []) {
  const f = issue.fields || {};
  const descriptionText = adfToText(f.description);
  const lines = descriptionText.split('\n');
  const tables = f.description && typeof f.description === 'object' ? adfTables(f.description) : [];
  const { objective, acceptance } = extractSections(lines);

  const proseLines = lines.filter((l) => !l.trim().startsWith('|')).map(cleanBullet).filter(Boolean);
  const rules = unique(proseLines.filter((l) => RULE_RE.test(l) && l.length > 6 && !HEADER_AC_RE.test(l))).slice(0, 200);

  const commentTexts = comments.map((c) => ({
    author: (c.author && c.author.displayName) || 'Unknown',
    created: c.created,
    text: adfToText(c.body),
  }));

  const openItems = unique([
    ...proseLines.filter((l) => OPEN_ITEM_RE.test(l) || /\?\s*$/.test(l)),
    ...tables.flat(2).filter((cell) => OPEN_ITEM_RE.test(cell)).map((cell) => `Table value: ${cell}`),
    ...commentTexts.flatMap((c) => c.text.split('\n').map(stripMarkup)
      .filter((l) => /\?\s*$/.test(l) || OPEN_ITEM_RE.test(l))
      .map((l) => `${c.author} (comment): ${l}`)),
  ]);

  const conflicts = findConflicts(lines);
  const links = (f.issuelinks || []).map((link) => {
    const other = link.outwardIssue || link.inwardIssue;
    const relation = link.outwardIssue ? link.type.outward : link.type.inward;
    return {
      relation,
      key: other && other.key,
      summary: other && other.fields && other.fields.summary,
      status: other && other.fields && other.fields.status && other.fields.status.name,
    };
  });

  const facts = {
    key: issue.key,
    summary: f.summary || '',
    type: f.issuetype && f.issuetype.name,
    status: f.status && f.status.name,
    priority: f.priority && f.priority.name,
    assignee: f.assignee ? f.assignee.displayName : 'Unassigned',
    reporter: f.reporter && f.reporter.displayName,
    created: f.created,
    updated: f.updated,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    fixVersions: (f.fixVersions || []).map((v) => v.name),
    parent: f.parent ? `${f.parent.key} ${f.parent.fields ? f.parent.fields.summary : ''}`.trim() : null,
    attachments: (f.attachment || []).map((a) => a.filename),
    remoteLinks: remoteLinks.map((r) => (r.object && (r.object.title || r.object.url)) || '').filter(Boolean),
  };

  const result = {
    facts,
    objective,
    acceptanceCriteria: acceptance,
    rules,
    tables,
    openItems,
    possibleConflicts: conflicts,
    hygiene: hygiene(issue, comments),
    links,
    testScenarios: testScenarios(rules, tables),
    stats: {
      descriptionWords: descriptionText ? descriptionText.split(/\s+/).filter(Boolean).length : 0,
      comments: comments.length,
      tables: tables.length,
    },
  };
  result.markdown = toMarkdown(result);
  return result;
}

function list(items, empty = '_None found._') {
  return items && items.length ? items.map((i) => `- ${i}`).join('\n') : empty;
}

function toMarkdown(a) {
  const f = a.facts;
  const parts = [
    `# ${f.key}: ${f.summary}`,
    '',
    `**Type:** ${f.type || '-'} | **Status:** ${f.status || '-'} | **Priority:** ${f.priority || '-'} | **Assignee:** ${f.assignee} | **Reporter:** ${f.reporter || '-'}`,
    f.parent ? `**Parent:** ${f.parent}` : '',
    f.fixVersions.length ? `**Fix versions:** ${f.fixVersions.join(', ')}` : '',
    f.components.length ? `**Components:** ${f.components.join(', ')}` : '',
    '',
    '## Objective',
    a.objective || '_Not stated._',
    '',
    `## Acceptance criteria (${a.acceptanceCriteria.length})`,
    list(a.acceptanceCriteria),
    '',
    `## Business rules to implement (${a.rules.length})`,
    list(a.rules),
  ];
  if (a.tables.length) {
    parts.push('', '## Tables from the description');
    a.tables.forEach((rows, i) => parts.push('', `**Table ${i + 1}**`, '', rowsToMarkdown(rows)));
  }
  parts.push(
    '',
    `## Open questions / items to clarify (${a.openItems.length})`,
    list(a.openItems),
    '',
    '## Possible contradictions to confirm',
    list(a.possibleConflicts),
    '',
    '## Ticket hygiene',
    list(a.hygiene, '_Looks complete._'),
  );
  if (a.links.length) {
    parts.push('', '## Linked issues', list(a.links.map((l) => `${l.relation}: ${l.key} ${l.summary || ''} ${l.status ? `(${l.status})` : ''}`.trim())));
  }
  parts.push('', `## Suggested test scenarios (${a.testScenarios.length})`, list(a.testScenarios));
  return parts.filter((p, i, arr) => !(p === '' && arr[i - 1] === '')).join('\n').trim() + '\n';
}

module.exports = { analyzeIssue, toMarkdown };
