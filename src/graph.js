// In-memory symbol graph with JSON persistence (.codegraph/index.json).
import fs from 'node:fs';
import path from 'node:path';

const INDEX_VERSION = 2; // v2: file/symbol doc summaries

export class Graph {
  constructor(root) {
    this.root = root;
    // relPath -> {mtimeMs, size, lang, imports: [], symbols: [symbolRecord], calls: [{caller, callee, line}]}
    this.files = new Map();
    // derived indexes
    this.nameIndex = new Map(); // lower name -> [{file, i}]
    this.reverseCalls = new Map(); // lower callee -> [{file, callerIndex, line}]
    this.dirty = false;
  }

  indexPath() {
    return path.join(this.root, '.codegraph', 'index.json');
  }

  setFile(relPath, record) {
    this.files.set(relPath, record);
    this.dirty = true;
  }

  removeFile(relPath) {
    if (this.files.delete(relPath)) this.dirty = true;
  }

  rebuildIndexes() {
    this.nameIndex.clear();
    this.reverseCalls.clear();
    for (const [file, rec] of this.files) {
      rec.symbols.forEach((sym, i) => {
        const key = sym.name.toLowerCase();
        if (!this.nameIndex.has(key)) this.nameIndex.set(key, []);
        this.nameIndex.get(key).push({ file, i });
      });
      for (const call of rec.calls) {
        const key = call.callee.toLowerCase();
        if (!this.reverseCalls.has(key)) this.reverseCalls.set(key, []);
        this.reverseCalls.get(key).push({ file, callerIndex: call.caller, line: call.line });
      }
    }
  }

  symbolAt(file, i) {
    const rec = this.files.get(file);
    const sym = rec?.symbols[i];
    return sym ? { ...sym, file } : null;
  }

  /** Find symbol definitions by name. exact=false also matches substrings. */
  findSymbols(name, { exact = false, kind = null, limit = 20 } = {}) {
    const key = name.toLowerCase();
    const out = [];
    const seen = new Set();
    const push = (file, i) => {
      const id = `${file}#${i}`;
      if (seen.has(id)) return;
      seen.add(id);
      const sym = this.symbolAt(file, i);
      if (sym && (!kind || sym.kind === kind)) out.push(sym);
    };
    for (const ref of this.nameIndex.get(key) || []) push(ref.file, ref.i);
    if (!exact && out.length < limit) {
      for (const [k, refs] of this.nameIndex) {
        if (out.length >= limit) break;
        if (k === key || !k.includes(key)) continue;
        for (const ref of refs) {
          if (out.length >= limit) break;
          push(ref.file, ref.i);
        }
      }
    }
    return out.slice(0, limit);
  }

  /** Call sites that invoke `name`. */
  findCallers(name, { limit = 50 } = {}) {
    const refs = this.reverseCalls.get(name.toLowerCase()) || [];
    const out = [];
    for (const ref of refs) {
      if (out.length >= limit) break;
      const caller = ref.callerIndex >= 0 ? this.symbolAt(ref.file, ref.callerIndex) : null;
      out.push({
        file: ref.file,
        line: ref.line,
        caller: caller ? { name: caller.name, kind: caller.kind, startLine: caller.startLine } : null
      });
    }
    return out;
  }

  /** Transitive callers of `name`, BFS over the reverse call graph. */
  impact(name, { maxDepth = 3, limit = 200 } = {}) {
    const layers = [];
    let frontier = new Set([name.toLowerCase()]);
    const visited = new Set(frontier);
    let total = 0;

    for (let depth = 1; depth <= maxDepth && frontier.size > 0 && total < limit; depth++) {
      const layer = [];
      const next = new Set();
      for (const target of frontier) {
        for (const ref of this.reverseCalls.get(target) || []) {
          if (total >= limit) break;
          const caller = ref.callerIndex >= 0 ? this.symbolAt(ref.file, ref.callerIndex) : null;
          const callerKey = caller ? caller.name.toLowerCase() : null;
          const entryId = `${ref.file}#${caller ? caller.name : '<module>'}#${target}`;
          if (layer.some((l) => l.id === entryId)) continue;
          layer.push({
            id: entryId,
            file: ref.file,
            line: ref.line,
            calls: target,
            caller: caller ? { name: caller.name, kind: caller.kind, startLine: caller.startLine } : null
          });
          total++;
          if (callerKey && !visited.has(callerKey)) {
            visited.add(callerKey);
            next.add(callerKey);
          }
        }
      }
      if (layer.length > 0) layers.push({ depth, entries: layer });
      frontier = next;
    }
    return { layers, total, truncated: total >= limit };
  }

  /**
   * Every textual mention of an identifier across indexed files (word-boundary,
   * case-sensitive), annotated with the enclosing symbol. Complements
   * findCallers: also finds type usages, variable refs, imports/exports.
   */
  findReferences(name, { limit = 100 } = {}) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const out = [];
    let truncated = false;
    const nameLower = name.toLowerCase();
    for (const [file, rec] of this.files) {
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      let src;
      try {
        src = fs.readFileSync(path.join(this.root, file), 'utf8');
      } catch {
        continue;
      }
      if (!re.test(src)) continue;
      const callLines = new Set(rec.calls.filter((c) => c.callee.toLowerCase() === nameLower).map((c) => c.line));
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const lineNo = i + 1;
        // innermost enclosing symbol
        let enclosing = null;
        for (const s of rec.symbols) {
          if (s.startLine <= lineNo && lineNo <= s.endLine && (!enclosing || s.startLine >= enclosing.startLine)) {
            enclosing = s;
          }
        }
        const isDefinition = rec.symbols.some((s) => s.name === name && s.startLine === lineNo);
        out.push({ file, line: lineNo, text: lines[i].trim().slice(0, 160), enclosing, isDefinition, isCall: callLines.has(lineNo) });
        if (out.length >= limit) {
          truncated = true;
          break;
        }
      }
    }
    return { refs: out, truncated };
  }

  stats() {
    let symbols = 0;
    let calls = 0;
    const byLang = {};
    for (const rec of this.files.values()) {
      symbols += rec.symbols.length;
      calls += rec.calls.length;
      byLang[rec.lang] = (byLang[rec.lang] || 0) + 1;
    }
    return { files: this.files.size, symbols, calls, byLang };
  }

  save() {
    if (!this.dirty) return;
    const dir = path.dirname(this.indexPath());
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      version: INDEX_VERSION,
      files: Object.fromEntries(this.files)
    };
    const tmp = this.indexPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.indexPath());
    this.dirty = false;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath(), 'utf8'));
      if (data.version !== INDEX_VERSION) return false;
      this.files = new Map(Object.entries(data.files));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }
}
