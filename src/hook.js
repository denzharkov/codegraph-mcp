// PreToolUse hook for Claude Code: steers Read / Bash away from whole-file
// reads and identifier greps on files the graph already knows about.
//
// The MCP `instructions` field is advice; the agent's habit is grep + cat.
// A hook is the only mechanism that runs BEFORE the tool and can say no. It
// works from the persisted index alone (no server, no tree-sitter), so it
// costs one JSON parse per Read/Bash call.
//
// Deny only when codegraph can actually answer better:
//   Read of a whole indexed file above the line threshold  -> file_skeleton / read_symbol
//   cat of such a file                                     -> same
//   recursive grep for a bare identifier the index defines -> find_symbol / find_references
//   grep for "class X" / "def X" of an indexed symbol       -> read_symbol
//   sed -n a,bp / Read offset+limit that spans one symbol   -> read_symbol
// Small targeted reads, head/tail, regex greps, unknown identifiers and
// unindexed files always pass through.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MIN_LINES = 300;
const GREP_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
// flags whose value is the next token (when not written as --flag=value)
const GREP_VALUE_FLAGS = new Set([
  '-A', '-B', '-C', '-m', '-e', '-f', '-g', '-t', '-T',
  '--include', '--exclude', '--exclude-dir', '--glob', '--type', '--max-count', '--context'
]);
const IDENTIFIER = /^(?:\\b)?([A-Za-z_][A-Za-z0-9_]*)(?:\\b)?$/;
const DEFINITION = /^(?:class|def|function|func|fn|struct|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const SED_RANGE = /^sed\s+-n\s+'?(\d+),(\d+)p'?\s+(\S+)$/;
const MIN_SUBSTRING = 5;
const MIN_SYMBOL_LINES = 15;

export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.codegraph', 'index.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'index.json'), 'utf8'));
    const files = raw.files || {};
    const symbols = new Map();
    for (const [file, entry] of Object.entries(files)) {
      for (const s of entry.symbols || []) {
        if (!symbols.has(s.name)) symbols.set(s.name, { file, kind: s.kind, line: s.startLine });
      }
    }
    return { files, symbols };
  } catch {
    return null;
  }
}

function substringMatches(index, name) {
  if (name.length < MIN_SUBSTRING) return [];
  const needle = name.toLowerCase();
  const out = [];
  for (const key of index.symbols.keys()) {
    if (key.toLowerCase().includes(needle)) out.push(key);
    if (out.length === 3) break;
  }
  return out;
}

// The read is "one symbol read by line numbers" when the range and a
// top-level symbol cover at least 60% of each other. A small window inside a
// class, a wide sweep over several symbols, a short helper and the head of
// the file (imports) are left alone.
function symbolSpanning(index, rel, from, to) {
  if (from <= 1) return null;
  let best = null;
  for (const s of index.files[rel].symbols || []) {
    if (s.parent || s.endLine - s.startLine + 1 < MIN_SYMBOL_LINES) continue;
    const overlap = Math.min(to, s.endLine) - Math.max(from, s.startLine) + 1;
    if (overlap <= 0) continue;
    const symLen = s.endLine - s.startLine + 1;
    const rangeLen = to - from + 1;
    if (overlap < 0.6 * symLen || overlap < 0.6 * rangeLen) continue;
    if (!best || symLen < best.endLine - best.startLine + 1) best = s;
  }
  return best;
}

function rangeReason(ctx, rel, from, to) {
  const s = symbolSpanning(ctx.index, rel, from, to);
  if (!s) return null;
  return (
    `Lines ${from}-${to} of ${rel} are ${s.kind} ${s.name} (${s.startLine}-${s.endLine}). ` +
    `Call read_symbol("${s.name}", file="${rel}") instead of reading by line numbers.`
  );
}

function relPath(root, file, cwd) {
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd || root, file);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function countLines(root, rel) {
  try {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    let n = 0;
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

function wholeFileReason(ctx, rel) {
  const lines = countLines(ctx.root, rel);
  if (lines <= ctx.minLines) return null;
  const n = (ctx.index.files[rel].symbols || []).length;
  return (
    `${rel} is ${lines} lines and codegraph has it indexed (${n} symbols). ` +
    `Call file_skeleton("${rel}") for imports and signatures, then read_symbol(name) ` +
    `for the bodies you need, or Read with offset/limit for one exact section.`
  );
}

function checkRead(input, ctx) {
  if (!input.file_path) return null;
  const rel = relPath(ctx.root, input.file_path, ctx.cwd);
  if (!rel || !ctx.index.files[rel]) return null;
  if (input.offset == null && input.limit == null) return wholeFileReason(ctx, rel);
  const from = Number(input.offset) || 1;
  const to = input.limit != null ? from + Number(input.limit) - 1 : countLines(ctx.root, rel);
  return rangeReason(ctx, rel, from, to);
}

function checkSed(segment, ctx) {
  const m = SED_RANGE.exec(segment.trim());
  if (!m) return null;
  const rel = relPath(ctx.root, m[3].replace(/^['"]|['"]$/g, ''), ctx.cwd);
  if (!rel || !ctx.index.files[rel]) return null;
  return rangeReason(ctx, rel, Number(m[1]), Number(m[2]));
}

// Shell-ish split: whitespace separates, quotes group ("class Foo" is one token).
function tokens(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of segment.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

function checkCat(segment, ctx) {
  const t = tokens(segment);
  if (t[0] !== 'cat') return null;
  for (const arg of t.slice(1)) {
    if (arg.startsWith('-')) continue;
    const rel = relPath(ctx.root, arg, ctx.cwd);
    if (!rel || !ctx.index.files[rel]) continue;
    const reason = wholeFileReason(ctx, rel);
    if (reason) return reason;
  }
  return null;
}

function checkGrep(segment, ctx) {
  const t = tokens(segment);
  if (!GREP_TOOLS.has(t[0])) return null;
  let recursive = t[0] === 'rg' || t[0] === 'ag';
  let pattern = null;
  const targets = [];
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    if (a === '-e' || a === '--regexp') {
      pattern ??= t[++i];
    } else if (GREP_VALUE_FLAGS.has(a)) {
      i++;
    } else if (a.startsWith('-')) {
      if (/^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive' || a === '--dereference-recursive') recursive = true;
    } else if (pattern === null) {
      pattern = a;
    } else {
      targets.push(a);
    }
  }
  if (!pattern) return null;
  const def = DEFINITION.exec(pattern);
  if (def && ctx.index.symbols.has(def[1])) {
    const d = ctx.index.symbols.get(def[1]);
    return (
      `${def[1]} is a ${d.kind} codegraph knows (${d.file}:${d.line}). ` +
      `Call read_symbol("${def[1]}") for its full source instead of grep with context lines.`
    );
  }
  const m = IDENTIFIER.exec(pattern);
  if (!m) return null;
  if (!recursive) {
    recursive = targets.some((x) => {
      const rel = relPath(ctx.root, x, ctx.cwd);
      return rel !== null && fs.existsSync(path.join(ctx.root, rel)) && fs.statSync(path.join(ctx.root, rel)).isDirectory();
    });
  }
  if (!recursive) return null;
  const exact = ctx.index.symbols.get(m[1]);
  if (exact) {
    return (
      `${m[1]} is a ${exact.kind} codegraph knows (${exact.file}:${exact.line}). ` +
      `Use find_symbol("${m[1]}") for the definition, find_references("${m[1]}") for every mention ` +
      `or analyze_impact("${m[1]}") for callers instead of grep.`
    );
  }
  const partial = substringMatches(ctx.index, m[1]);
  if (partial.length === 0) return null;
  return (
    `"${m[1]}" is part of symbol names codegraph knows (${partial.join(', ')}). ` +
    `Call find_symbol("${m[1]}") (substring match) to get their definitions with line ranges instead of grep.`
  );
}

function checkBash(input, ctx) {
  const command = input.command || '';
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    if (!segment.includes('|')) {
      const reason = checkCat(segment, ctx) || checkSed(segment, ctx);
      if (reason) return reason;
    }
    for (const piece of segment.split('|')) {
      const reason = checkGrep(piece, ctx);
      if (reason) return reason;
    }
  }
  return null;
}

/**
 * Returns a deny reason for a PreToolUse event, or null to let the call
 * through. `ctx` = {root, index, cwd, minLines}.
 */
export function decide(event, ctx) {
  const input = event.tool_input || {};
  if (event.tool_name === 'Read') return checkRead(input, ctx);
  if (event.tool_name === 'Bash') return checkBash(input, ctx);
  return null;
}

export function runHook(event, env = process.env) {
  const cwd = event.cwd || process.cwd();
  const root = findRoot(cwd);
  if (!root) return null;
  const index = loadIndex(root);
  if (!index) return null;
  const minLines = Number(env.CODEGRAPH_MIN_LINES) || DEFAULT_MIN_LINES;
  const reason = decide(event, { root, index, cwd, minLines });
  if (!reason) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
}

// --- settings.json registration -------------------------------------------

const HOOK_MARK = 'codegraph-hook';

function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

function isOurs(entry) {
  return (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARK));
}

export function installHook(settingsFile, command) {
  const settings = readSettings(settingsFile);
  settings.hooks ??= {};
  const list = (settings.hooks.PreToolUse ??= []).filter((e) => !isOurs(e));
  list.push({ matcher: 'Read|Bash', hooks: [{ type: 'command', command }] });
  settings.hooks.PreToolUse = list;
  writeSettings(settingsFile, settings);
}

export function uninstallHook(settingsFile) {
  const settings = readSettings(settingsFile);
  const list = settings.hooks?.PreToolUse;
  if (!Array.isArray(list)) return;
  settings.hooks.PreToolUse = list.filter((e) => !isOurs(e));
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settingsFile, settings);
}

// ANTHROPIC_BASE_URL is set only when it is free, and removed only when it
// is ours: a user's own gateway is never clobbered.
export function installProxyEnv(settingsFile, url) {
  const settings = readSettings(settingsFile);
  settings.env ??= {};
  const current = settings.env.ANTHROPIC_BASE_URL;
  if (current && !/^http:\/\/127\.0\.0\.1:\d+$/.test(current)) return current;
  settings.env.ANTHROPIC_BASE_URL = url;
  writeSettings(settingsFile, settings);
  return null;
}

export function uninstallProxyEnv(settingsFile) {
  const settings = readSettings(settingsFile);
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (!current || !/^http:\/\/127\.0\.0\.1:\d+$/.test(current)) return;
  delete settings.env.ANTHROPIC_BASE_URL;
  if (Object.keys(settings.env).length === 0) delete settings.env;
  writeSettings(settingsFile, settings);
}
