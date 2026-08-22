// Prompt grounding — the "transform the text BEFORE it reaches the model"
// layer, done the only safe way: the user's words are never rewritten.
// The proxy appends a clearly-labeled block of verifiable facts about the
// identifiers the message mentions (kind, location, one-line doc), so the
// model starts grounded instead of spending tool round-trips discovering
// the same facts.
//
// Cache safety: the block is deterministic for a given (message, index)
// pair, is appended only to the NEWEST human message, and is memoized by
// message hash so every later request re-attaches the identical bytes —
// the prompt-cache prefix never diverges.

const HEADER = '[codegraph context — facts about identifiers this message mentions, auto-attached by the local proxy]';
const MAX_ENTRIES = 8;
const MAX_BLOCK_CHARS = 1200;
const MAX_MEMO = 500;

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + s.length;
}

/** Human text of a message: text blocks only, none if it carries tool results. */
function humanText(msg) {
  if (msg.role !== 'user') return null;
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return null;
  if (msg.content.some((b) => b?.type === 'tool_result')) return null;
  const text = msg.content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return text || null;
}

/**
 * Deterministic grounding block for one message, or null when the message
 * mentions nothing the graph knows. Only exact-case symbol-name matches
 * count — that keeps prose words from dragging in unrelated symbols.
 */
export function buildGroundingBlock(graph, text) {
  if (text.includes(HEADER)) return null; // already grounded upstream
  const tokens = new Set();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,}/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/[\w./\\-]+\.[A-Za-z]{1,5}/g)) tokens.add(m[0].replace(/\\/g, '/'));

  const entries = [];
  const seen = new Set();
  for (const tok of tokens) {
    // file mention?
    if (tok.includes('.') && graph.files) {
      for (const [file, rec] of graph.files) {
        if (file === tok || file.endsWith('/' + tok)) {
          if (seen.has('f:' + file)) break;
          seen.add('f:' + file);
          entries.push({
            score: 3,
            line: `${file} — ${rec.lang}, ${rec.symbols.length} symbols${rec.doc ? ' — ' + rec.doc : ''}`
          });
          break;
        }
      }
      continue;
    }
    const defs = (graph.nameIndex.get(tok.toLowerCase()) || [])
      .map(({ file, i }) => ({ file, sym: graph.files.get(file)?.symbols[i] }))
      .filter((d) => d.sym && d.sym.name === tok); // exact case only
    if (defs.length === 0 || defs.length > 4) continue; // unknown or too ambiguous
    for (const { file, sym } of defs) {
      const key = 's:' + file + ':' + sym.name;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        score: (sym.exported ? 1 : 0) + (defs.length === 1 ? 1 : 0),
        line:
          `${sym.name} — ${sym.kind}${sym.parent ? ' in ' + sym.parent : ''}, ` +
          `${file}:${sym.startLine}-${sym.endLine}${sym.doc ? ' — ' + sym.doc : ''}`
      });
    }
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => b.score - a.score || a.line.localeCompare(b.line));
  const lines = [];
  let size = HEADER.length;
  for (const e of entries.slice(0, MAX_ENTRIES)) {
    if (size + e.line.length > MAX_BLOCK_CHARS) break;
    lines.push('- ' + e.line);
    size += e.line.length;
  }
  if (lines.length === 0) return null;
  return '\n\n' + HEADER + '\n' + lines.join('\n');
}

function appendBlock(msg, block) {
  if (typeof msg.content === 'string') return { ...msg, content: msg.content + block };
  return { ...msg, content: [...msg.content, { type: 'text', text: block.replace(/^\n+/, '') }] };
}

/**
 * Grounds the conversation: the newest human message gets a fresh block
 * (only while it is the final message — i.e. the user just sent it);
 * earlier human messages get their memoized block re-attached verbatim so
 * history stays byte-stable across the agentic loop.
 */
export function groundHistory(body, graph, memo) {
  if (!graph || !Array.isArray(body?.messages) || body.messages.length === 0) {
    return { body, addedChars: 0 };
  }
  const lastIdx = body.messages.length - 1;
  let addedChars = 0;
  let changed = false;
  const messages = body.messages.map((msg, i) => {
    const text = humanText(msg);
    if (!text) return msg;
    const key = fnv(text);
    let block;
    if (memo.has(key)) {
      block = memo.get(key);
    } else if (i === lastIdx) {
      block = buildGroundingBlock(graph, text);
      if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value);
      memo.set(key, block);
    } else {
      return msg; // never grounded while fresh — leave history untouched
    }
    if (!block) return msg;
    addedChars += block.length;
    changed = true;
    return appendBlock(msg, block);
  });
  return { body: changed ? { ...body, messages } : body, addedChars };
}
