// Line-based extractors for languages without a bundled tree-sitter WASM
// grammar. GDScript's rigid, indentation-scoped syntax makes this reliable.

const GD_KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'match', 'return', 'func', 'var', 'const',
  'class', 'signal', 'await', 'yield', 'assert', 'preload', 'load', 'print', 'range',
  'len', 'str', 'int', 'float', 'bool', 'not', 'and', 'or', 'in', 'is', 'as', 'pass',
  'breakpoint', 'super'
]);

function indentOf(line) {
  const m = line.match(/^[\t ]*/)[0];
  return m.replace(/\t/g, '    ').length;
}

/** End line of an indentation block starting at defLine (1-based). */
function blockEnd(lines, defIndex, defIndent) {
  let end = defIndex;
  for (let i = defIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= defIndent) break;
    end = i;
  }
  return end + 1; // 1-based
}

function extractGDScript(src) {
  const lines = src.split('\n');
  const symbols = [];
  const calls = [];
  const imports = [];
  // innermost enclosing container per line: stack of {name, indent, symIndex}
  const stack = [];

  const defRes = [
    { re: /^class_name\s+([A-Za-z_]\w*)/, kind: 'class', container: false },
    { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class', container: true },
    { re: /^(?:static\s+)?func\s+([A-Za-z_]\w*)/, kind: 'function', container: true },
    { re: /^signal\s+([A-Za-z_]\w*)/, kind: 'signal', container: false },
    { re: /^(?:@[\w()."'\s,-]+\s+)?(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'var', container: false }
  ];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = indentOf(raw);
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();

    const ext = trimmed.match(/^extends\s+([\w."']+)/);
    if (ext) {
      imports.push(`extends ${ext[1].replace(/["']/g, '')}`);
      continue;
    }
    for (const m of trimmed.matchAll(/\b(?:preload|load)\(\s*["']([^"']+)["']\s*\)/g)) {
      imports.push(m[1]);
    }

    let wasDef = false;
    for (const { re, kind, container } of defRes) {
      const m = trimmed.match(re);
      if (!m) continue;
      // vars only at file or class level, not inside functions
      const inFunc = stack.some((s) => s.kind === 'function');
      if (kind === 'var' && inFunc) break;
      const name = m[1];
      const enclosing = [...stack].reverse().find((s) => s.kind === 'class');
      const symIndex = symbols.length;
      symbols.push({
        name,
        kind: kind === 'function' && enclosing ? 'method' : kind,
        exported: !name.startsWith('_'),
        startLine: i + 1,
        endLine: container ? blockEnd(lines, i, indent) : i + 1,
        signature: trimmed.replace(/:\s*$/, '').slice(0, 240),
        parent: enclosing ? enclosing.name : null
      });
      if (container) stack.push({ name, kind, indent, symIndex });
      wasDef = true;
      break;
    }

    // call sites: identifiers followed by '(' that are not defs/keywords
    const codePart = trimmed.split('#')[0];
    if (!wasDef || /func/.test(codePart)) {
      for (const m of codePart.matchAll(/(?:^|[^.\w])(?:[\w\]).]*\.)?([A-Za-z_]\w*)\s*\(/g)) {
        const callee = m[1];
        if (GD_KEYWORDS.has(callee)) continue;
        if (wasDef && symbols[symbols.length - 1].name === callee) continue;
        const caller = [...stack].reverse().find((s) => s.symIndex >= 0);
        calls.push({ caller: caller ? caller.symIndex : -1, callee, line: i + 1 });
      }
    }
  }
  return { symbols, calls, imports };
}

export const REGEX_LANGS = {
  gdscript: extractGDScript
};

export const REGEX_EXTS = {
  '.gd': 'gdscript'
};
