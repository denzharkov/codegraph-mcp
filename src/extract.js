// Walks a parsed tree once, producing symbols, call edges and imports.
import { LANGUAGES } from './languages.js';
import { getLanguage, parseWith } from './parsers.js';
import { REGEX_LANGS } from './regexlangs.js';

const MAX_NODES = 400_000;

function signatureOf(node, src) {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 300);
  return src
    .slice(node.startIndex, end)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export async function extractFile(langId, src) {
  if (REGEX_LANGS[langId]) return REGEX_LANGS[langId](src);
  const lang = LANGUAGES[langId];
  if (!lang) return null;
  const language = await getLanguage(lang.grammar);
  if (!language) return null;

  const tree = parseWith(language, src);
  const spec = lang.spec;
  const symbols = [];
  const calls = []; // {caller: symbol index | -1, callee, line}
  const imports = [];

  // stack of {name, kind, symIndex} for enclosing containers
  const stack = [];
  let visited = 0;

  const walk = (node) => {
    if (++visited > MAX_NODES) return;

    let popAfter = false;
    const def = spec.definition ? spec.definition(node, src, stack) : null;

    if (def && def.name) {
      let symIndex = -1;
      if (def.emit !== false) {
        const CONTAINER_KINDS = new Set(['class', 'struct', 'module', 'namespace', 'trait', 'interface', 'impl']);
        const enclosing = [...stack].reverse().find((s) => CONTAINER_KINDS.has(s.kind) && (s.symIndex >= 0 || s.kind === 'impl'));
        symIndex = symbols.length;
        symbols.push({
          name: def.name,
          kind: def.kind,
          exported: !!def.exported,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: signatureOf(node, src),
          parent: def.parentName || (enclosing ? enclosing.name.replace(/^impl /, '') : null)
        });
      }
      if (def.container) {
        stack.push({ name: def.name, kind: def.kind, symIndex });
        popAfter = true;
      }
    } else if (spec.callTypes.has(node.type)) {
      const callee = spec.callee(node, src);
      if (callee) {
        const caller = [...stack].reverse().find((s) => s.symIndex >= 0);
        calls.push({ caller: caller ? caller.symIndex : -1, callee, line: node.startPosition.row + 1 });
      }
    } else if (spec.importTypes.has(node.type)) {
      const imp = spec.importText(node, src);
      if (imp) imports.push(imp);
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      walk(node.namedChild(i));
    }
    if (popAfter) stack.pop();
  };

  try {
    walk(tree.rootNode);
  } finally {
    tree.delete();
  }
  return { symbols, calls, imports };
}
