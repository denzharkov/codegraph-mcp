// Resolves stored import specifiers to repo-relative file paths and builds
// the reverse import graph (who imports whom). Best-effort per language:
// relative JS/TS paths are resolved precisely, Python dotted modules are
// mapped to files, everything else falls back to basename matching.

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];

function dirOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

function normalize(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Candidate repo-relative paths a specifier may point to. */
function candidates(fromFile, lang, spec) {
  const out = [];
  if ((lang === 'javascript' || lang === 'typescript' || lang === 'tsx') && spec.startsWith('.')) {
    const base = normalize(dirOf(fromFile) + '/' + spec);
    out.push(base);
    for (const ext of JS_EXTS) out.push(base + ext);
    for (const ext of JS_EXTS) out.push(base + '/index' + ext);
    // TS allows importing './x.js' that is actually './x.ts'
    const stripped = base.replace(/\.(js|mjs|cjs)$/, '');
    if (stripped !== base) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) out.push(stripped + ext);
  } else if (lang === 'python') {
    // stored as full statement text: "import a.b" / "from a.b import c"
    const m = spec.match(/^(?:from|import)\s+([\w.]+)/);
    if (m) {
      const mod = m[1].replace(/^\.+/, '');
      const modPath = mod.replace(/\./g, '/');
      out.push(modPath + '.py', modPath + '/__init__.py');
      // relative imports: resolve against the importing file's package
      if (/^(?:from|import)\s+\./.test(spec)) {
        const base = dirOf(fromFile);
        out.push(normalize(base + '/' + modPath) + '.py', normalize(base + '/' + modPath) + '/__init__.py');
      }
    }
  }
  return out;
}

/**
 * Returns Map<relPath, Set<relPath>>: for each file, the set of files that
 * import it. Unresolvable (external/package) imports are ignored.
 */
export function buildReverseImports(graph) {
  const reverse = new Map();
  // basename index for the fallback: "utils" -> [paths]
  const byBasename = new Map();
  // source-root prefixes: src-layout projects (src/pkg/...) import by package
  // name, so candidates are also tried under each top-level directory
  const roots = new Set(['']);
  for (const file of graph.files.keys()) {
    const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(file);
    const cut = file.indexOf('/');
    if (cut > 0) roots.add(file.slice(0, cut + 1));
  }
  const resolveCandidate = (c) => {
    for (const r of roots) {
      const full = r + c;
      if (graph.files.has(full)) return full;
    }
    return null;
  };

  for (const [file, rec] of graph.files) {
    for (const spec of rec.imports) {
      let targets = candidates(file, rec.lang, spec).map(resolveCandidate).filter(Boolean);
      if (targets.length === 0 && !spec.startsWith('.') && !spec.includes(' ')) {
        // fallback: match last path segment against basenames (go/rust/java/c includes)
        const last = spec.split(/[/\\:]/).pop().replace(/\.[^.]+$/, '');
        const sameName = byBasename.get(last) || [];
        if (sameName.length === 1) targets = sameName;
      }
      for (const target of targets) {
        if (target === file) continue;
        if (!reverse.has(target)) reverse.set(target, new Set());
        reverse.get(target).add(file);
      }
    }
  }
  return reverse;
}
