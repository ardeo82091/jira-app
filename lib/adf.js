'use strict';

/**
 * Helpers for Atlassian Document Format (ADF), the rich-text JSON format used by
 * Jira Cloud REST API v3 for descriptions, comments and textarea custom fields.
 */

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;

function textNode(text) {
  return { type: 'text', text };
}

/** Builds paragraph content, turning single newlines into hardBreak nodes. */
function inlineContent(lines) {
  const content = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' });
    if (line.length > 0) content.push(textNode(line));
  });
  return content;
}

function paragraph(lines) {
  const content = inlineContent(lines);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function listNode(type, items) {
  return {
    type,
    content: items.map((item) => ({ type: 'listItem', content: [paragraph([item])] })),
  };
}

/**
 * Converts plain text into an ADF document.
 * - Blank lines separate paragraphs.
 * - Lines starting with "- ", "* " or "• " become bullet lists.
 * - Lines starting with "1. " / "1) " become ordered lists.
 * Returns null for empty input (used to clear a field).
 */
function textToAdf(text) {
  if (text === null || text === undefined) return null;
  const normalized = String(text).replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return null;

  const blocks = [];
  let paragraphLines = [];
  let list = null; // { type, items }

  const flushParagraph = () => {
    if (paragraphLines.length) {
      blocks.push(paragraph(paragraphLines));
      paragraphLines = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(listNode(list.type, list.items));
      list = null;
    }
  };

  for (const line of normalized.split('\n')) {
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? 'bulletList' : 'orderedList';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || ordered)[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraphLines.push(line);
    }
  }
  flushParagraph();
  flushList();

  return { type: 'doc', version: 1, content: blocks };
}

function applyMarks(text, marks) {
  if (!marks || !marks.length || !text) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'strong': out = `**${out}**`; break;
      case 'em': out = `_${out}_`; break;
      case 'code': out = `\`${out}\``; break;
      case 'strike': out = `~~${out}~~`; break;
      case 'link':
        if (mark.attrs && mark.attrs.href && mark.attrs.href !== text) out = `[${out}](${mark.attrs.href})`;
        break;
      default: break;
    }
  }
  return out;
}

function inlineToText(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((node) => {
    if (!node || typeof node !== 'object') return '';
    switch (node.type) {
      case 'text': return applyMarks(node.text || '', node.marks);
      case 'hardBreak': return '\n';
      case 'mention': return (node.attrs && node.attrs.text) ? (node.attrs.text.startsWith('@') ? node.attrs.text : `@${node.attrs.text}`) : '@user';
      case 'emoji': return (node.attrs && (node.attrs.text || node.attrs.shortName)) || '';
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard': return (node.attrs && node.attrs.url) || '';
      case 'status': return node.attrs && node.attrs.text ? `[${node.attrs.text}]` : '';
      case 'date': {
        const ts = node.attrs && Number(node.attrs.timestamp);
        return ts ? new Date(ts).toISOString().slice(0, 10) : '';
      }
      case 'placeholder': return (node.attrs && node.attrs.text) || '';
      default: return node.content ? inlineToText(node.content) : '';
    }
  }).join('');
}

function cellText(cell) {
  return blocksToText(cell.content || [], 0).replace(/\s*\n+\s*/g, ' ').trim();
}

function tableToRows(tableNode) {
  return (tableNode.content || [])
    .filter((row) => row && row.type === 'tableRow')
    .map((row) => (row.content || []).map(cellText));
}

function rowsToMarkdown(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => r.concat(Array(width - r.length).fill(''));
  const esc = (c) => c.replace(/\|/g, '\\|');
  const lines = [`| ${pad(rows[0]).map(esc).join(' | ')} |`, `|${' --- |'.repeat(width)}`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).map(esc).join(' | ')} |`);
  return lines.join('\n');
}

function blocksToText(nodes, depth) {
  if (!Array.isArray(nodes)) return '';
  const indent = '  '.repeat(depth);
  const parts = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    switch (node.type) {
      case 'paragraph':
        parts.push(inlineToText(node.content));
        break;
      case 'heading': {
        const level = Math.min(Math.max((node.attrs && node.attrs.level) || 1, 1), 6);
        parts.push(`${'#'.repeat(level)} ${inlineToText(node.content)}`);
        break;
      }
      case 'bulletList':
      case 'orderedList': {
        const items = (node.content || []).map((item, i) => {
          const marker = node.type === 'bulletList' ? '-' : `${((node.attrs && node.attrs.order) || 1) + i}.`;
          const inner = (item.content || []);
          const first = inner.length && !['bulletList', 'orderedList'].includes(inner[0].type)
            ? blocksToText([inner[0]], 0).replace(/\n/g, `\n${indent}  `) : '';
          const rest = blocksToText(first ? inner.slice(1) : inner, depth + 1);
          return `${indent}${marker} ${first}${rest ? `\n${rest}` : ''}`;
        });
        parts.push(items.join('\n'));
        break;
      }
      case 'codeBlock':
        parts.push(`\`\`\`${(node.attrs && node.attrs.language) || ''}\n${inlineToText(node.content)}\n\`\`\``);
        break;
      case 'blockquote':
        parts.push(blocksToText(node.content, 0).split('\n').map((l) => `> ${l}`).join('\n'));
        break;
      case 'rule':
        parts.push('---');
        break;
      case 'table':
        parts.push(rowsToMarkdown(tableToRows(node)));
        break;
      case 'mediaSingle':
      case 'mediaGroup':
      case 'media':
        parts.push('[attachment]');
        break;
      case 'panel':
      case 'expand':
      case 'nestedExpand':
      case 'layoutSection':
      case 'layoutColumn':
      case 'bodiedExtension':
        if (node.attrs && node.attrs.title) parts.push(`**${node.attrs.title}**`);
        parts.push(blocksToText(node.content, depth));
        break;
      case 'taskList':
      case 'decisionList':
        parts.push((node.content || []).map((item) => {
          const done = item.attrs && item.attrs.state === 'DONE';
          return `${indent}- [${done ? 'x' : ' '}] ${inlineToText(item.content)}`;
        }).join('\n'));
        break;
      default:
        if (node.content) parts.push(blocksToText(node.content, depth));
        else if (node.type === 'text' || node.type === 'hardBreak' || node.type === 'mention') parts.push(inlineToText([node]));
        break;
    }
  }
  return parts.filter((p) => p !== '').join(depth > 0 ? '\n' : '\n\n');
}

/** Converts an ADF document (or plain string) into readable Markdown-like text. */
function adfToText(doc) {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  if (Array.isArray(doc)) return blocksToText(doc, 0).trim();
  if (doc.type === 'doc') return blocksToText(doc.content, 0).trim();
  return blocksToText([doc], 0).trim();
}

/** Returns every table in an ADF document as an array of rows of cell strings. */
function adfTables(doc) {
  const tables = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'table') {
      tables.push(tableToRows(node));
      return;
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(doc);
  return tables;
}

function isAdfDoc(value) {
  return !!value && typeof value === 'object' && value.type === 'doc' && Array.isArray(value.content);
}

module.exports = { textToAdf, adfToText, adfTables, isAdfDoc, rowsToMarkdown };
