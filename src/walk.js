// Repo file walker: skips vendored/generated dirs, honors simple root
// .gitignore patterns, filters binaries and minified bundles.
import fs from 'node:fs';
import path from 'node:path';
import { EXT_TO_LANG } from './languages.js';
import { REGEX_EXTS } from './regexlangs.js';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'vendor', '.venv', 'venv', 'env', '__pycache__', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.cache', '.idea', '.vscode', '.codegraph', 'obj',
  '.terraform', 'Pods', 'DerivedData', '.gradle', '.tox', 'site-packages'
]);

const MAX_FILE_SIZE = 1_200_000;
const MAX_FILES = 20_000;

function loadGitignore(root) {
  const rules = [];
  try {
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const neg = line.startsWith('!');
      rules.push({ neg, pat: (neg ? line.slice(1) : line).replace(/\/$/, '') });
    }
  } catch {
    // no .gitignore — fine
  }
  return rules;
}

function ruleMatches(pat, relPath, name) {
  if (pat.includes('*')) {
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    // path-shaped globs match the rel path, bare globs the basename
    return pat.includes('/') ? re.test(relPath) || re.test(relPath.replace(/^\//, '')) : re.test(name);
  }
  if (pat.startsWith('/')) {
    return relPath === pat.slice(1) || relPath.startsWith(pat.slice(1) + '/');
  }
  return name === pat || relPath === pat || relPath.endsWith('/' + pat);
}

// git semantics: rules are evaluated in order, the LAST matching rule wins —
// this is what makes "ignore all, un-ignore some" (`*` then `!src`) work
function matchesGitignore(relPath, name, isDir, rules) {
  let ignored = false;
  for (const { neg, pat } of rules) {
    if (ruleMatches(pat, relPath, name)) ignored = !neg;
  }
  return ignored;
}

function looksMinified(filePath, size) {
  if (/\.min\.(js|css)$/.test(filePath)) return true;
  if (size < 20_000) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, n);
    if (chunk.includes(0)) return true; // binary
    const text = chunk.toString('utf8');
    const lines = text.split('\n');
    const avg = text.length / Math.max(lines.length, 1);
    return avg > 400;
  } catch {
    return true;
  }
}

/**
 * Returns {files: [{path, relPath, lang, size, mtimeMs}], unsupported: {ext: count}}.
 * `unsupported` counts source-looking files whose extension has no extractor —
 * surfaced in repo_map so an empty index explains itself.
 */
export function walkRepo(root) {
  const gitignore = loadGitignore(root);
  const results = [];
  const unsupported = {};
  const queue = [''];

  while (queue.length > 0 && results.length < MAX_FILES) {
    const rel = queue.shift();
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const childRel = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        if (name.startsWith('.') && name !== '.') continue;
        if (DEFAULT_IGNORED_DIRS.has(name)) continue;
        if (matchesGitignore(childRel, name, true, gitignore)) continue;
        queue.push(childRel);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        const lang = EXT_TO_LANG[ext] || REGEX_EXTS[ext];
        if (matchesGitignore(childRel, name, false, gitignore)) continue;
        if (!lang) {
          if (ext && ext.length <= 12) unsupported[ext] = (unsupported[ext] || 0) + 1;
          continue;
        }
        let stat;
        try {
          stat = fs.statSync(path.join(abs, name));
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_SIZE) continue;
        if (looksMinified(path.join(abs, name), stat.size)) continue;
        results.push({
          path: path.join(abs, name),
          relPath: childRel,
          lang,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  }
  return { files: results, unsupported };
}
