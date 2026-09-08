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
// Targeted reads (offset/limit, sed -n ranges, head/tail), regex greps,
// unknown identifiers and unindexed files always pass through.
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
  if (!input.file_path || input.offset != null || input.limit != null) return null;
  const rel = relPath(ctx.root, input.file_path, ctx.cwd);
  if (!rel || !ctx.index.files[rel]) return null;
  return wholeFileReason(ctx, rel);
}

function tokens(segment) {
  return segment.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, '')).filter(Boolean);
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
  const m = IDENTIFIER.exec(pattern);
  if (!m) return null;
  if (!recursive) {
    recursive = targets.some((x) => {
      const rel = relPath(ctx.root, x, ctx.cwd);
      return rel !== null && fs.existsSync(path.join(ctx.root, rel)) && fs.statSync(path.join(ctx.root, rel)).isDirectory();
    });
  }
  if (!recursive) return null;
  const def = ctx.index.symbols.get(m[1]);
  if (!def) return null;
  return (
    `${m[1]} is a ${def.kind} codegraph knows (${def.file}:${def.line}). ` +
    `Use find_symbol("${m[1]}") for the definition, find_references("${m[1]}") for every mention ` +
    `or analyze_impact("${m[1]}") for callers instead of grep.`
  );
}

function checkBash(input, ctx) {
  const command = input.command || '';
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    if (!segment.includes('|')) {
      const reason = checkCat(segment, ctx);
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
