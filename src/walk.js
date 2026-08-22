// Repo file walker: skips vendored/generated dirs, honors simple root
// .gitignore patterns, filters binaries and minified bundles.
import fs from 'node:fs';
import path from 'node:path';
import { EXT_TO_LANG } from './languages.js';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'vendor', '.venv', 'venv', 'env', '__pycache__', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.cache', '.idea', '.vscode', '.codegraph', 'obj',
  '.terraform', 'Pods', 'DerivedData', '.gradle', '.tox', 'site-packages'
]);

const MAX_FILE_SIZE = 1_200_000;
const MAX_FILES = 20_000;

function loadGitignore(root) {
  const patterns = [];
  try {
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      patterns.push(line);
    }
  } catch {
    // no .gitignore — fine
  }
  return patterns;
}

function matchesGitignore(relPath, name, isDir, patterns) {
  for (const p of patterns) {
    const pat = p.replace(/\/$/, '');
    if (pat.includes('*')) {
      // glob on basename only: *.log, *.min.js
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(name)) return true;
    } else if (pat.startsWith('/')) {
      if (relPath === pat.slice(1) || relPath.startsWith(pat.slice(1) + '/')) return true;
    } else if (name === pat || relPath === pat || relPath.endsWith('/' + pat)) {
      return true;
    }
  }
  return false;
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

/** Returns [{path, relPath, lang, size, mtimeMs}] for indexable source files. */
export function walkRepo(root) {
  const gitignore = loadGitignore(root);
  const results = [];
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
        const lang = EXT_TO_LANG[ext];
        if (!lang) continue;
        if (matchesGitignore(childRel, name, false, gitignore)) continue;
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
  return results;
}
