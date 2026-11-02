'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { textToAdf, adfToText, adfTables } = require('../lib/adf');
const { analyzeIssue } = require('../lib/analyze');
const { formatJiraDateTime, assertIssueKey } = require('../lib/jira');
const { fieldValueToText, buildExtraFields } = require('../lib/app');

const SAMPLE_DOC = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Objective', marks: [{ type: 'strong' }] }, { type: 'text', text: ' - As a seller I should be able to initiate SWIFT PAR journey.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Acceptance Criteria -', marks: [{ type: 'strong' }] }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'UIN - TBD' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Minimum entry age is 18 years' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cash Bonus Payout default Arrears and will be in freezed mode, user can select all values in UAT' }] }] },
      ],
    },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Variant' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Max age' }] }] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wealth Plus' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '65 years' }] }] }] },
      ],
    },
  ],
};

test('textToAdf builds paragraphs, bullets and ordered lists', () => {
  const doc = textToAdf('Hello\nworld\n\n- a\n- b\n1. one\n2. two');
  assert.equal(doc.type, 'doc');
  assert.deepEqual(doc.content.map((n) => n.type), ['paragraph', 'bulletList', 'orderedList']);
  assert.equal(doc.content[0].content[1].type, 'hardBreak');
  assert.equal(doc.content[1].content.length, 2);
  assert.equal(textToAdf('   '), null);
});

test('adfToText round-trips readable text and tables', () => {
  const text = adfToText(SAMPLE_DOC);
  assert.match(text, /\*\*Objective\*\* - As a seller/);
  assert.match(text, /- UIN - TBD/);
  assert.match(text, /\| Variant \| Max age \|/);
  assert.deepEqual(adfTables(SAMPLE_DOC), [[['Variant', 'Max age'], ['Wealth Plus', '65 years']]]);
  assert.equal(adfToText(textToAdf('- x\n- y')), '- x\n- y');
});

test('analyzeIssue extracts objective, AC, rules, open items, conflicts, hygiene', () => {
  const issue = {
    key: 'FUL2-1',
    fields: { summary: 'Product Details Changes', description: SAMPLE_DOC, issuetype: { name: 'Story' }, status: { name: 'New', statusCategory: { key: 'new' } }, priority: { name: 'Low' }, assignee: null, labels: [], issuelinks: [] },
    names: {},
  };
  const a = analyzeIssue(issue, [], []);
  assert.match(a.objective, /initiate SWIFT PAR journey/);
  assert.equal(a.acceptanceCriteria.length, 3);
  assert.ok(a.rules.some((r) => /Minimum entry age is 18 years/.test(r)));
  assert.ok(a.openItems.some((o) => /UIN - TBD/.test(o)));
  assert.ok(a.possibleConflicts.some((c) => /freezed mode/.test(c)));
  assert.ok(a.hygiene.includes('No assignee.'));
  assert.equal(a.tables.length, 1);
  assert.ok(a.testScenarios.some((s) => s.startsWith('Boundary:')));
  assert.match(a.markdown, /^# FUL2-1: Product Details Changes/);
});

test('helpers: date format, key validation, field text, extra fields', () => {
  assert.match(formatJiraDateTime(new Date(2026, 9, 30, 10, 5, 7, 9)), /^2026-10-30T10:05:07\.009[+-]\d{4}$/);
  assert.equal(assertIssueKey('ful2-315620'), 'FUL2-315620');
  assert.throws(() => assertIssueKey('../etc'), /not a valid issue key/);
  assert.equal(fieldValueToText({ displayName: 'Ankit' }), 'Ankit');
  assert.equal(fieldValueToText([{ name: 'A' }, { name: 'B' }]), 'A, B');
  assert.equal(fieldValueToText(SAMPLE_DOC).includes('Wealth Plus'), true);
  const fields = buildExtraFields(
    { customfield_1: '5', customfield_2: '10001', customfield_3: 'a, b', customfield_4: 'text', 'bad id!': 'x' },
    [
      { fieldId: 'customfield_1', schema: { type: 'number' } },
      { fieldId: 'customfield_2', schema: { type: 'option' } },
      { fieldId: 'customfield_3', schema: { type: 'array', items: 'string' } },
      { fieldId: 'customfield_4', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } },
    ],
  );
  assert.deepEqual(fields.customfield_1, 5);
  assert.deepEqual(fields.customfield_2, { id: '10001' });
  assert.deepEqual(fields.customfield_3, ['a', 'b']);
  assert.equal(fields.customfield_4.type, 'doc');
  assert.equal(fields['bad id!'], undefined);
});
