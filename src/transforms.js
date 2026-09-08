// Request-body transforms for the transparent proxy.
//
// skeletonizeStaleReads: when the SAME file appears in several read results
// (Read tool, or Bash `cat file` / `sed -n a,bp file`), every occurrence
// except the LAST is replaced by a tree-sitter signature skeleton — the model
// keeps structure and line numbers of the stale version but not its body; a
// stale partial read (sed range, Read with offset) becomes a one-line stub.
// The newest read always stays verbatim. The transform is a pure function of
// the content, so repeated requests produce identical bytes and the prompt
// cache re-stabilizes after one rewrite.
//
// truncateStaleOutputs: when the same Bash command was run several times
// (test reruns, tailing a task log), every output except the LAST keeps only
// its head and tail. Identical outputs are the dedup transform's job.
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

const CAT_CMD = /^cat\s+(?:-[A-Za-z]+\s+)*(\S+)$/;
const SED_CMD = /^sed\s+-n\s+'?(\d+),(\d+)p'?\s+(\S+)$/;

/** {file, partial} when a Bash command is a plain read of one file. */
export function bashRead(command) {
  const cmd = String(command || '').trim();
  if (/&&|\|\||;|\||\n/.test(cmd)) return null;
  const cat = CAT_CMD.exec(cmd);
  if (cat) return { file: cat[1].replace(/^['"]|['"]$/g, ''), partial: null };
  const sed = SED_CMD.exec(cmd);
  if (sed) return { file: sed[3].replace(/^['"]|['"]$/g, ''), partial: `${sed[1]}-${sed[2]}` };
  return null;
}

/** {file, partial} for a tool_use that reads a file, else null. */
function readOf(use) {
  if (!use) return null;
  if (use.name === 'Read' && use.input?.file_path) {
    const { offset, limit } = use.input;
    const partial = offset != null || limit != null ? `${offset ?? 1}+${limit ?? ''}` : null;
    return { file: String(use.input.file_path), partial };
  }
  if (use.name === 'Bash') return bashRead(use.input?.command);
  return null;
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

  // locate every read result per file, in order
  const readsPerFile = new Map(); // filePath -> [{mi, bi, partial}]
  body.messages.forEach((msg, mi) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return;
    msg.content.forEach((block, bi) => {
      if (block?.type !== 'tool_result') return;
      const read = readOf(toolUses.get(block.tool_use_id));
      if (!read) return;
      if (!readsPerFile.has(read.file)) readsPerFile.set(read.file, []);
      readsPerFile.get(read.file).push({ mi, bi, partial: read.partial });
    });
  });

  let savedChars = 0;
  let count = 0;
  let messages = body.messages;

  for (const [file, occurrences] of readsPerFile) {
    if (occurrences.length < 2) continue;
    const last = occurrences[occurrences.length - 1];
    const lastText = blockText(body.messages[last.mi].content[last.bi].content);
    for (const { mi, bi, partial } of occurrences.slice(0, -1)) {
      const block = messages[mi].content[bi];
      const text = blockText(block.content);
      if (text.length < MIN_SKELETON_CHARS) continue;
      // identical repeats are the dedup transform's job (it keeps the FIRST
      // copy verbatim — lossless); never skeletonize them or its own stubs
      if (text === lastText || text.startsWith('[codegraph-proxy')) continue;
      const skeleton = partial
        ? `[codegraph-proxy: stale partial read of ${file} (${partial}) — a newer read appears later in this conversation; ${text.length} chars elided]`
        : await skeletonOf(text, file);
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

const MIN_TRUNCATE_LINES = 30;
const HEAD_LINES = 15;
const TAIL_LINES = 10;

function commandKey(command) {
  return String(command || '')
    .replace(/\bsleep\s+\d+\s*;?\s*/g, '')
    .replace(/\b(head|tail)\s+(-n\s*)?-?\d+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateStaleOutputs(body) {
  if (!Array.isArray(body?.messages)) return { body, savedChars: 0, count: 0 };
  const toolUses = buildToolUseIndex(body.messages);

  const runsPerCommand = new Map(); // normalized command -> [{mi, bi}]
  body.messages.forEach((msg, mi) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return;
    msg.content.forEach((block, bi) => {
      if (block?.type !== 'tool_result') return;
      const use = toolUses.get(block.tool_use_id);
      if (!use || use.name !== 'Bash' || !use.input?.command || bashRead(use.input.command)) return;
      const key = commandKey(use.input.command);
      if (!runsPerCommand.has(key)) runsPerCommand.set(key, []);
      runsPerCommand.get(key).push({ mi, bi });
    });
  });

  let savedChars = 0;
  let count = 0;
  let messages = body.messages;
  for (const [key, runs] of runsPerCommand) {
    if (runs.length < 2) continue;
    const last = runs[runs.length - 1];
    const lastText = blockText(body.messages[last.mi].content[last.bi].content);
    for (const { mi, bi } of runs.slice(0, -1)) {
      const block = messages[mi].content[bi];
      const text = blockText(block.content);
      if (text === lastText || text.startsWith('[codegraph-proxy')) continue;
      const lines = text.split('\n');
      if (lines.length <= MIN_TRUNCATE_LINES) continue;
      const cut =
        `[codegraph-proxy: earlier run of \`${key.slice(0, 80)}\` — a newer run appears later in this conversation; ` +
        `${lines.length - HEAD_LINES - TAIL_LINES} of ${lines.length} lines elided]\n` +
        `${lines.slice(0, HEAD_LINES).join('\n')}\n[…]\n${lines.slice(-TAIL_LINES).join('\n')}`;
      if (cut.length >= text.length) continue;
      if (messages === body.messages) messages = body.messages.slice();
      const msg = { ...messages[mi], content: messages[mi].content.slice() };
      msg.content[bi] = { ...block, content: [{ type: 'text', text: cut }] };
      messages[mi] = msg;
      savedChars += text.length - cut.length;
      count++;
    }
  }
  return { body: count > 0 ? { ...body, messages } : body, savedChars, count };
}
