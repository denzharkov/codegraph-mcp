// Per-language extraction specs for the symbol graph.
// Each spec answers three questions about an AST node:
//   definition(node, src, stack) -> {name, kind, exported, emit, container} | null
//   callee(node, src)            -> callee name | null  (node.type must be in callTypes)
//   importText(node, src)        -> import specifier | null (node.type in importTypes)

function fieldText(node, field, src) {
  const c = node.childForFieldName(field);
  return c ? src.slice(c.startIndex, c.endIndex) : null;
}

function nodeText(node, src, cap = 200) {
  return src.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + cap));
}

function hasModifier(node, src, word) {
  for (const child of node.children) {
    if (child.type.includes('modifier')) {
      if (src.slice(child.startIndex, child.endIndex).includes(word)) return true;
    }
  }
  return false;
}

function stripQuotes(s) {
  return s ? s.replace(/^['"`]|['"`]$/g, '') : s;
}

// ---------- JavaScript / TypeScript / TSX ----------

const JS_DEF_TYPES = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  module: 'namespace'
};

const jsSpec = {
  definition(node, src) {
    const kind = JS_DEF_TYPES[node.type];
    if (kind) {
      const name = fieldText(node, 'name', src);
      if (!name) return null;
      const exported =
        node.parent?.type === 'export_statement' ||
        (node.type === 'method_definition' ? false : hasModifier(node, src, 'export'));
      const container = kind === 'class' || kind === 'function' || kind === 'method' || kind === 'namespace';
      return { name, kind, exported, container };
    }
    // app.foo = function () {} / Foo.prototype.bar = () => {}
    if (node.type === 'assignment_expression') {
      const right = node.childForFieldName('right');
      const isFn = right && (right.type === 'arrow_function' || right.type === 'function_expression' || right.type === 'function');
      if (!isFn) return null;
      const left = node.childForFieldName('left');
      let name = null;
      if (left?.type === 'member_expression') name = fieldText(left, 'property', src);
      else if (left?.type === 'identifier') name = src.slice(left.startIndex, left.endIndex);
      if (!name || name === 'exports') return null;
      return { name, kind: 'function', exported: true, container: true };
    }
    // const foo = () => {} / const foo = function () {} at top level
    if (node.type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      if (!value) return null;
      const isFn = value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function';
      const decl = node.parent; // lexical_declaration | variable_declaration
      const top = decl?.parent;
      const topLevel = top?.type === 'program' || top?.type === 'export_statement';
      if (!isFn && !topLevel) return null;
      const name = fieldText(node, 'name', src);
      if (!name || name.startsWith('{') || name.startsWith('[')) return null;
      return {
        name,
        kind: isFn ? 'function' : 'const',
        exported: top?.type === 'export_statement',
        container: isFn
      };
    }
    return null;
  },
  callTypes: new Set(['call_expression', 'new_expression']),
  callee(node, src) {
    const fn = node.childForFieldName('function') || node.childForFieldName('constructor');
    if (!fn) return null;
    if (fn.type === 'identifier') return src.slice(fn.startIndex, fn.endIndex);
    if (fn.type === 'member_expression') return fieldText(fn, 'property', src);
    return null;
  },
  importTypes: new Set(['import_statement']),
  importText(node, src) {
    return stripQuotes(fieldText(node, 'source', src));
  }
};

// ---------- Python ----------

const pySpec = {
  definition(node, src, stack) {
    if (node.type === 'function_definition') {
      const name = fieldText(node, 'name', src);
      const inClass = stack.some((s) => s.kind === 'class');
      return name ? { name, kind: inClass ? 'method' : 'function', exported: !name.startsWith('_'), container: true } : null;
    }
    if (node.type === 'class_definition') {
      const name = fieldText(node, 'name', src);
      return name ? { name, kind: 'class', exported: !name.startsWith('_'), container: true } : null;
    }
    return null;
  },
  callTypes: new Set(['call']),
  callee(node, src) {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return src.slice(fn.startIndex, fn.endIndex);
    if (fn.type === 'attribute') return fieldText(fn, 'attribute', src);
    return null;
  },
  importTypes: new Set(['import_statement', 'import_from_statement']),
  importText(node, src) {
    return nodeText(node, src, 160).replace(/\s+/g, ' ').trim();
  }
};

// ---------- Go ----------

const goSpec = {
  definition(node, src) {
    if (node.type === 'function_declaration' || node.type === 'method_declaration') {
      const name = fieldText(node, 'name', src);
      if (!name) return null;
      let parent = null;
      if (node.type === 'method_declaration') {
        const recv = node.childForFieldName('receiver');
        if (recv) {
          const m = src.slice(recv.startIndex, recv.endIndex).match(/\*?([A-Za-z_]\w*)\s*\)?\s*$/);
          parent = m ? m[1] : null;
        }
      }
      return { name, kind: node.type === 'method_declaration' ? 'method' : 'function', exported: /^[A-Z]/.test(name), container: true, parentName: parent };
    }
    if (node.type === 'type_spec') {
      const name = fieldText(node, 'name', src);
      const typeNode = node.childForFieldName('type');
      const kind = typeNode?.type === 'interface_type' ? 'interface' : typeNode?.type === 'struct_type' ? 'struct' : 'type';
      return name ? { name, kind, exported: /^[A-Z]/.test(name), container: false } : null;
    }
    return null;
  },
  callTypes: new Set(['call_expression']),
  callee(node, src) {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return src.slice(fn.startIndex, fn.endIndex);
    if (fn.type === 'selector_expression') return fieldText(fn, 'field', src);
    return null;
  },
  importTypes: new Set(['import_spec']),
  importText(node, src) {
    const p = node.childForFieldName('path');
    return p ? stripQuotes(src.slice(p.startIndex, p.endIndex)) : null;
  }
};

// ---------- Rust ----------

const RUST_DEF_TYPES = {
  function_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  mod_item: 'module'
};

const rustSpec = {
  definition(node, src, stack) {
    const kind = RUST_DEF_TYPES[node.type];
    if (kind) {
      const name = fieldText(node, 'name', src);
      if (!name) return null;
      const inImpl = stack.length > 0 && stack[stack.length - 1].kind === 'impl';
      return {
        name,
        kind: kind === 'function' && inImpl ? 'method' : kind,
        exported: hasModifier(node, src, 'pub'),
        container: kind === 'function' || kind === 'module' || kind === 'trait'
      };
    }
    if (node.type === 'impl_item') {
      const type = fieldText(node, 'type', src);
      return { name: type ? `impl ${type}` : 'impl', kind: 'impl', exported: false, container: true, emit: false };
    }
    return null;
  },
  callTypes: new Set(['call_expression']),
  callee(node, src) {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return src.slice(fn.startIndex, fn.endIndex);
    if (fn.type === 'field_expression') return fieldText(fn, 'field', src);
    if (fn.type === 'scoped_identifier') return fieldText(fn, 'name', src);
    return null;
  },
  importTypes: new Set(['use_declaration']),
  importText(node, src) {
    return nodeText(node, src, 160).replace(/\s+/g, ' ').replace(/^use\s+|;$/g, '').trim();
  }
};

// ---------- Java ----------

const JAVA_DEF_TYPES = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
  method_declaration: 'method',
  constructor_declaration: 'constructor'
};

const javaSpec = {
  definition(node, src) {
    const kind = JAVA_DEF_TYPES[node.type];
    if (!kind) return null;
    const name = fieldText(node, 'name', src);
    return name ? { name, kind, exported: hasModifier(node, src, 'public'), container: true } : null;
  },
  callTypes: new Set(['method_invocation', 'object_creation_expression']),
  callee(node, src) {
    if (node.type === 'object_creation_expression') {
      const t = node.childForFieldName('type');
      return t ? src.slice(t.startIndex, t.endIndex).replace(/<.*/s, '') : null;
    }
    return fieldText(node, 'name', src);
  },
  importTypes: new Set(['import_declaration']),
  importText(node, src) {
    return nodeText(node, src, 160).replace(/^import\s+|;\s*$/g, '').trim();
  }
};

// ---------- Ruby ----------

const rubySpec = {
  definition(node, src) {
    if (node.type === 'method' || node.type === 'singleton_method') {
      const name = fieldText(node, 'name', src);
      return name ? { name, kind: 'method', exported: true, container: true } : null;
    }
    if (node.type === 'class' || node.type === 'module') {
      const name = fieldText(node, 'name', src);
      return name ? { name, kind: node.type, exported: true, container: true } : null;
    }
    return null;
  },
  callTypes: new Set(['call']),
  callee(node, src) {
    return fieldText(node, 'method', src);
  },
  importTypes: new Set(),
  importText() {
    return null;
  }
};

// ---------- C / C++ ----------

function unwrapDeclarator(node, src) {
  // pointer_declarator / function_declarator / reference_declarator chains
  let cur = node;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.type === 'identifier' || cur.type === 'field_identifier' || cur.type === 'destructor_name' || cur.type === 'operator_name') {
      return src.slice(cur.startIndex, cur.endIndex);
    }
    if (cur.type === 'qualified_identifier') {
      const n = cur.childForFieldName('name');
      cur = n;
      continue;
    }
    cur = cur.childForFieldName('declarator');
  }
  return null;
}

const cSpec = {
  definition(node, src) {
    if (node.type === 'function_definition') {
      const decl = node.childForFieldName('declarator');
      const name = decl ? unwrapDeclarator(decl, src) : null;
      return name ? { name, kind: 'function', exported: true, container: true } : null;
    }
    if ((node.type === 'struct_specifier' || node.type === 'enum_specifier' || node.type === 'union_specifier' || node.type === 'class_specifier') && node.childForFieldName('body')) {
      const name = fieldText(node, 'name', src);
      const kind = node.type === 'class_specifier' ? 'class' : node.type.replace('_specifier', '');
      return name ? { name, kind, exported: true, container: node.type === 'class_specifier' || node.type === 'struct_specifier' } : null;
    }
    if (node.type === 'namespace_definition') {
      const name = fieldText(node, 'name', src);
      return { name: name || '<anonymous>', kind: 'namespace', exported: true, container: true, emit: !!name };
    }
    return null;
  },
  callTypes: new Set(['call_expression']),
  callee(node, src) {
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return src.slice(fn.startIndex, fn.endIndex);
    if (fn.type === 'field_expression') return fieldText(fn, 'field', src);
    if (fn.type === 'qualified_identifier') {
      const n = fn.childForFieldName('name');
      return n ? src.slice(n.startIndex, n.endIndex) : null;
    }
    return null;
  },
  importTypes: new Set(['preproc_include']),
  importText(node, src) {
    const p = node.childForFieldName('path');
    return p ? src.slice(p.startIndex, p.endIndex).replace(/^[<"]|[>"]$/g, '') : null;
  }
};

// ---------- C# ----------

const CSHARP_DEF_TYPES = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  struct_declaration: 'struct',
  enum_declaration: 'enum',
  record_declaration: 'class',
  method_declaration: 'method',
  constructor_declaration: 'constructor',
  property_declaration: 'property'
};

const csharpSpec = {
  definition(node, src) {
    const kind = CSHARP_DEF_TYPES[node.type];
    if (!kind) return null;
    const name = fieldText(node, 'name', src);
    return name
      ? { name, kind, exported: hasModifier(node, src, 'public'), container: kind !== 'property' && kind !== 'enum' }
      : null;
  },
  callTypes: new Set(['invocation_expression', 'object_creation_expression']),
  callee(node, src) {
    if (node.type === 'object_creation_expression') {
      const t = node.childForFieldName('type');
      return t ? src.slice(t.startIndex, t.endIndex).replace(/<.*/s, '') : null;
    }
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return src.slice(fn.startIndex, fn.endIndex);
    if (fn.type === 'member_access_expression') return fieldText(fn, 'name', src);
    return null;
  },
  importTypes: new Set(['using_directive']),
  importText(node, src) {
    return nodeText(node, src, 160).replace(/^using\s+|;\s*$/g, '').trim();
  }
};

// ---------- PHP ----------

const PHP_DEF_TYPES = {
  function_definition: 'function',
  class_declaration: 'class',
  method_declaration: 'method',
  interface_declaration: 'interface',
  trait_declaration: 'trait'
};

const phpSpec = {
  definition(node, src) {
    const kind = PHP_DEF_TYPES[node.type];
    if (!kind) return null;
    const name = fieldText(node, 'name', src);
    return name ? { name, kind, exported: true, container: true } : null;
  },
  callTypes: new Set(['function_call_expression', 'member_call_expression', 'scoped_call_expression', 'object_creation_expression']),
  callee(node, src) {
    if (node.type === 'function_call_expression') {
      const fn = node.childForFieldName('function');
      return fn && (fn.type === 'name' || fn.type === 'qualified_name') ? src.slice(fn.startIndex, fn.endIndex).split('\\').pop() : null;
    }
    if (node.type === 'object_creation_expression') {
      for (const c of node.children) {
        if (c.type === 'name' || c.type === 'qualified_name') return src.slice(c.startIndex, c.endIndex).split('\\').pop();
      }
      return null;
    }
    return fieldText(node, 'name', src);
  },
  importTypes: new Set(['namespace_use_declaration']),
  importText(node, src) {
    return nodeText(node, src, 160).replace(/^use\s+|;\s*$/g, '').trim();
  }
};

// ---------- Registry ----------

export const LANGUAGES = {
  javascript: { grammar: 'javascript', spec: jsSpec },
  typescript: { grammar: 'typescript', spec: jsSpec },
  tsx: { grammar: 'tsx', spec: jsSpec },
  python: { grammar: 'python', spec: pySpec },
  go: { grammar: 'go', spec: goSpec },
  rust: { grammar: 'rust', spec: rustSpec },
  java: { grammar: 'java', spec: javaSpec },
  ruby: { grammar: 'ruby', spec: rubySpec },
  c: { grammar: 'c', spec: cSpec },
  cpp: { grammar: 'cpp', spec: cSpec },
  c_sharp: { grammar: 'c_sharp', spec: csharpSpec },
  php: { grammar: 'php', spec: phpSpec }
};

export const EXT_TO_LANG = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'c_sharp',
  '.php': 'php'
};
