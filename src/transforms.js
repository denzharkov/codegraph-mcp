// Request-body transforms for the transparent proxy.
//
// skeletonizeStaleReads: when the SAME file appears in several Read tool
// results (read, edited, re-read), every occurrence except the LAST is
// replaced by a tree-sitter signature skeleton — the model keeps structure
// and line numbers of the stale version but not its body; the newest read
// always stays verbatim. The transform is a pure function of the content, so
// repeated requests produce identical bytes and the prompt cache re-stabilizes
// after one rewrite.
import path from 'node:path';
import { EXT_TO_LANG } from './languages.js';

const MIN_SKELETON_CHARS = 1500; // below this a skeleton saves too little to risk a cache rewrite

const LINE_NO = /^\s*\d+→/;

function stripLineNumbers(text) {
  const lines = text.split('\n');
  const numbered = lines.filter((l) => LINE_NO.test(l)).length;
  if (numbered < lines.length * 0.5) return { src: text, hadNumbers: false };
  return { src: lines.map((l) => l.replace(LINE_NO, '')).join('\n'), hadNumbers: true };
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

function headTailFallback(text, filePath) {
  const lines = text.split('\n');
  if (lines.length <= 30) return null;
  const head = lines.slice(0, 20).join('\n');
  const tail = lines.slice(-5).join('\n');
  return (
    `[codegraph-proxy: stale read of ${filePath} — a newer read appears later in this conversation; ` +
    `middle elided (${lines.length} lines total)]\n${head}\n[…]\n${tail}`
  );
}

async function skeletonOf(text, filePath) {
  const { src } = stripLineNumbers(text);
  const lang = EXT_TO_LANG[path.extname(filePath).toLowerCase()];
  if (lang) {
    try {
      const { initParsers } = await import('./parsers.js');
      const { extractFile } = await import('./extract.js');
      await initParsers();
      const extracted = await extractFile(lang, src);
      if (extracted && extracted.symbols.length > 0) {
        const lines = [
          `[codegraph-proxy: stale read of ${filePath} — a newer read appears later in this conversation; ` +
            `body replaced by its signature skeleton]`
        ];
        if (extracted.imports.length > 0) lines.push(`imports: ${extracted.imports.slice(0, 25).join(', ')}`);
        for (const s of extracted.symbols.slice(0, 120)) {
          const indent = s.parent ? '  ' : '';
          lines.push(`${indent}${s.startLine}-${s.endLine} ${s.signature}`);
        }
        return lines.join('\n');
      }
    } catch {
      // fall through to head/tail
    }
  }
  return headTailFallback(src, filePath);
}

/** Map tool_use_id -> {name, input} from assistant messages. */
function buildToolUseIndex(messages) {
  const idx = new Map();
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_use') idx.set(block.id, { name: block.name, input: block.input });
    }
  }
  return idx;
}

export async function skeletonizeStaleReads(body) {
  if (!Array.isArray(body?.messages)) return { body, savedChars: 0, count: 0 };
  const toolUses = buildToolUseIndex(body.messages);

  // locate every Read result per file, in order
  const readsPerFile = new Map(); // filePath -> [{msgIndex, blockIndex}]
  body.messages.forEach((msg, mi) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return;
    msg.content.forEach((block, bi) => {
      if (block?.type !== 'tool_result') return;
      const use = toolUses.get(block.tool_use_id);
      if (!use || use.name !== 'Read' || !use.input?.file_path) return;
      const file = String(use.input.file_path);
      if (!readsPerFile.has(file)) readsPerFile.set(file, []);
      readsPerFile.get(file).push({ mi, bi });
    });
  });

  let savedChars = 0;
  let count = 0;
  let messages = body.messages;

  for (const [file, occurrences] of readsPerFile) {
    if (occurrences.length < 2) continue;
    const last = occurrences[occurrences.length - 1];
    const lastText = blockText(body.messages[last.mi].content[last.bi].content);
    for (const { mi, bi } of occurrences.slice(0, -1)) {
      const block = messages[mi].content[bi];
      const text = blockText(block.content);
      if (text.length < MIN_SKELETON_CHARS) continue;
      // identical repeats are the dedup transform's job (it keeps the FIRST
      // copy verbatim — lossless); never skeletonize them or its own stubs
      if (text === lastText || text.startsWith('[codegraph-proxy')) continue;
      const skeleton = await skeletonOf(text, file);
      if (!skeleton || skeleton.length >= text.length) continue;
      // copy-on-write so the caller's object stays untouched
      if (messages === body.messages) messages = body.messages.slice();
      const msg = { ...messages[mi], content: messages[mi].content.slice() };
      msg.content[bi] = { ...block, content: [{ type: 'text', text: skeleton }] };
      messages[mi] = msg;
      savedChars += text.length - skeleton.length;
      count++;
    }
  }

  return { body: count > 0 ? { ...body, messages } : body, savedChars, count };
}
