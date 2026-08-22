// Derives human-readable descriptions from the code's own documentation:
// module docstrings / file header comments, per-symbol docstrings or leading
// comments, and README summaries for directories. Line-based on the raw
// source so one implementation covers every supported language.

const HASH_LANGS = new Set(['python', 'ruby', 'gdscript']);

// lines that are machinery, not documentation
const PRAGMA =
  /^(#!|# -\*-|# (coding|type:|noqa|pylint|flake8|ruff)|\/\/ ?(eslint|prettier|biome|tslint|@ts-)|\/\* ?eslint|<\?php|declare\s*\(strict_types|['"]use strict['"])/i;
const BOILERPLATE = /copyright|licen[cs]e|spdx|all rights reserved|permission is hereby|warranty/i;

function firstSentence(s, cap) {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = t.match(/^.{15,}?[.!?](?=\s|$)/);
  let out = m ? m[0] : t;
  if (out.length > cap) out = out.slice(0, cap - 1).trimEnd() + '…';
  return out || null;
}

function cleanCommentLine(t) {
  return t
    .replace(/^\/\/[!/]?\s?/, '')
    .replace(/^\/\*+\s?/, '')
    .replace(/\*+\/\s*$/, '')
    .replace(/^\*\s?/, '')
    .replace(/^#\s?/, '')
    .trim();
}

function isCommentLine(t, hash) {
  if (hash) return t.startsWith('#') && !t.startsWith('#[');
  return /^(\/\/|\/\*|\*\/|\*($|\s))/.test(t) || t.startsWith('#');
}

function summarizeBlock(block, cap) {
  let cleaned = block.map(cleanCommentLine);
  // keep only prose before the first doc tag (@param, @returns, :param:)
  const tagIdx = cleaned.findIndex((l) => /^(@\w|:\w+:|Args:|Returns:|Raises:)/.test(l));
  if (tagIdx >= 0) cleaned = cleaned.slice(0, tagIdx);
  cleaned = cleaned.filter((l) => l && !PRAGMA.test(l) && !/^(TODO|FIXME|XXX)\b/i.test(l));
  const joined = cleaned.join(' ');
  if (!joined || BOILERPLATE.test(joined)) return null;
  return firstSentence(joined, cap);
}

// contiguous comment block directly above line index `idx` (0-based);
// decorators/attributes between the block and the definition are skipped.
function docAbove(lines, idx, hash) {
  let i = idx - 1;
  while (i >= 0 && /^(@|#\[|\[)/.test(lines[i].trim()) && lines[i].trim() !== '') i--;
  const block = [];
  while (i >= 0 && isCommentLine(lines[i].trim(), hash)) {
    block.unshift(lines[i].trim());
    i--;
  }
  return block.length ? summarizeBlock(block, 140) : null;
}

// Reads a Python docstring whose opening quotes sit on line `i` (0-based).
function readDocstring(lines, i) {
  const t = lines[i].trim();
  const m = t.match(/^[rbu]{0,2}("""|''')/i);
  if (!m) return null;
  const q = m[1];
  const body = t.slice(t.indexOf(q) + 3);
  const closeSame = body.indexOf(q);
  if (closeSame >= 0) return firstSentence(body.slice(0, closeSame), 140);
  const parts = [body];
  for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
    const close = lines[j].indexOf(q);
    if (close >= 0) {
      parts.push(lines[j].slice(0, close));
      return firstSentence(parts.join(' '), 140);
    }
    parts.push(lines[j].trim());
  }
  return firstSentence(parts.join(' '), 140);
}

// Python-style docstring: the first statement in the body, when it's a string.
function docstringAfter(lines, defIdx) {
  // find the end of the def header (line whose code part ends with ':')
  let h = defIdx;
  for (; h < Math.min(defIdx + 12, lines.length); h++) {
    const code = lines[h].split('#')[0].trimEnd();
    if (code.endsWith(':')) break;
  }
  for (let i = h + 1; i < Math.min(h + 4, lines.length); i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('#')) continue;
    return readDocstring(lines, i);
  }
  return null;
}

// File-level description: module docstring, or the top comment block.
// A block glued directly to a symbol definition documents that symbol,
// not the file — but glued to an import/statement it's still a header.
function fileDoc(lines, langId, hash, symbols) {
  let i = 0;
  while (i < lines.length && i < 30) {
    const t = lines[i].trim();
    if (t === '' || PRAGMA.test(t)) {
      i++;
      continue;
    }
    if (langId === 'python' && /^[rbu]{0,2}("""|''')/i.test(t)) return readDocstring(lines, i);
    if (!isCommentLine(t, hash)) return null;
    const block = [];
    let e = i;
    while (e < lines.length && isCommentLine(lines[e].trim(), hash) && lines[e].trim() !== '') {
      block.push(lines[e].trim());
      e++;
    }
    const doc = summarizeBlock(block, 180);
    if (doc === null) {
      i = e; // license/pragma block — try the next one
      continue;
    }
    // glued to a definition? then it belongs to that definition
    let c = e;
    while (c < lines.length && /^(@|#\[|\[)/.test(lines[c].trim()) && lines[c].trim() !== '') c++;
    if (c < lines.length && lines[c].trim() !== '' && symbols.some((s) => s.startLine - 1 === c)) return null;
    return doc;
  }
  return null;
}

/** Mutates `extracted`: sets .doc (file) and symbol.doc where the source documents them. */
export function attachDocs(extracted, src, langId) {
  if (!extracted) return extracted;
  const lines = src.split('\n');
  const hash = HASH_LANGS.has(langId);
  for (const s of extracted.symbols) {
    let doc = null;
    if (langId === 'python') doc = docstringAfter(lines, s.startLine - 1);
    if (!doc) doc = docAbove(lines, s.startLine - 1, hash);
    if (doc) s.doc = doc;
  }
  const fd = fileDoc(lines, langId, hash, extracted.symbols);
  if (fd) extracted.doc = fd;
  return extracted;
}

/** First real paragraph of a README (whole paragraph, wraps joined), markdown stripped. */
export function readmeSummary(md) {
  const structural = (t) =>
    t.startsWith('#') ||
    t.startsWith('[![') ||
    t.startsWith('![') ||
    t.startsWith('<') ||
    t.startsWith('>') ||
    t.startsWith('```') ||
    t.startsWith('|') ||
    /^[-=*_]{3,}$/.test(t);
  const lines = md.split('\n').slice(0, 60);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || structural(t)) continue;
    const para = [];
    for (let j = i; j < lines.length; j++) {
      const p = lines[j].trim();
      if (!p || structural(p)) break;
      para.push(p);
    }
    return firstSentence(para.join(' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''), 170);
  }
  return null;
}
