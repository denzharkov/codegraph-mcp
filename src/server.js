// MCP server exposing the repo graph to Claude Code (CLI and VS Code).
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Index } from './indexer.js';
import { Notes } from './memory.js';
import { Stats } from './stats.js';
import { VectorStore, symbolItems, noteItems, semanticSearch } from './semantic.js';

function text(s, counterfactualChars = null) {
  const res = { content: [{ type: 'text', text: s }] };
  if (counterfactualChars !== null) res.counterfactualChars = counterfactualChars;
  return res;
}

function fmtSymbol(sym, i = null) {
  const prefix = i !== null ? `${i + 1}. ` : '';
  const parent = sym.parent ? ` (in ${sym.parent})` : '';
  const exp = sym.exported ? ' [exported]' : '';
  return `${prefix}${sym.kind} ${sym.name}${parent}${exp}\n   ${sym.file}:${sym.startLine}-${sym.endLine}\n   ${sym.signature}`;
}

export async function createServer(root) {
  const index = new Index(root);
  const notes = new Notes(root);
  const stats = new Stats(root);
  const vectors = new VectorStore(root);

  const server = new McpServer({ name: 'codegraph', version: '0.2.0' });

  // Every tool call is recorded; handlers may pass a counterfactual size to
  // text() when a direct "vs reading the whole file" comparison exists.
  // usage_stats itself is excluded so reading the report doesn't skew it.
  const registerTool = (name, def, handler) =>
    server.registerTool(name, def, async (args) => {
      const res = await handler(args ?? {});
      if (name !== 'usage_stats') {
        const chars = (res.content || []).reduce((n, c) => n + (c.text?.length || 0), 0);
        stats.record(name, chars, res.counterfactualChars ?? null);
        delete res.counterfactualChars;
      }
      return res;
    });

  registerTool(
    'repo_map',
    {
      description:
        'Compact overview of the repository: languages, file/symbol counts, and the exported symbols of the most significant files. Use this FIRST to orient yourself instead of reading many files.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max files to show (default 25)')
      }
    },
    async ({ limit = 25 }) => {
      await index.ensure();
      const g = index.graph;
      const stats = g.stats();
      const lines = [
        `Repo: ${root}`,
        `Files indexed: ${stats.files}, symbols: ${stats.symbols}, call edges: ${stats.calls}`,
        `Languages: ${Object.entries(stats.byLang).map(([l, n]) => `${l} (${n})`).join(', ') || 'none'}`,
        ''
      ];
      const ranked = [...g.files.entries()]
        .map(([file, rec]) => ({ file, rec, weight: rec.symbols.filter((s) => s.exported).length * 2 + rec.symbols.length }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, limit);
      for (const { file, rec } of ranked) {
        const names = rec.symbols
          .filter((s) => !s.parent)
          .slice(0, 12)
          .map((s) => `${s.name}${s.kind === 'class' || s.kind === 'struct' || s.kind === 'interface' ? `(${s.kind})` : ''}`);
        lines.push(`${file}: ${names.join(', ')}${rec.symbols.length > 12 ? ', …' : ''}`);
      }
      return text(lines.join('\n'));
    }
  );

  registerTool(
    'find_symbol',
    {
      description:
        'Locate the definition of a function/class/method/type by name across the whole repo. Returns file:line, signature and container. Much cheaper than grep + reading files.',
      inputSchema: {
        name: z.string().describe('Symbol name (case-insensitive; substring match unless exact=true)'),
        exact: z.boolean().optional().describe('Exact name match only (default false)'),
        kind: z.string().optional().describe('Filter by kind: function|method|class|struct|interface|type|enum|const'),
        limit: z.number().int().min(1).max(50).optional()
      }
    },
    async ({ name, exact = false, kind, limit = 10 }) => {
      await index.ensure();
      const syms = index.graph.findSymbols(name, { exact, kind: kind || null, limit });
      if (syms.length === 0) return text(`No definitions found for "${name}". Try exact=false or check spelling.`);
      return text(`${syms.length} definition(s) for "${name}":\n\n` + syms.map((s, i) => fmtSymbol(s, i)).join('\n\n'));
    }
  );

  registerTool(
    'read_symbol',
    {
      description:
        'Read the FULL source code of one symbol (function/class/method) without reading the whole file. Provide the symbol name; optionally the file path to disambiguate.',
      inputSchema: {
        name: z.string().describe('Symbol name (exact, case-insensitive)'),
        file: z.string().optional().describe('Repo-relative file path to disambiguate'),
        index: z.number().int().min(1).optional().describe('1-based pick when several matches exist')
      }
    },
    async ({ name, file, index: pick }) => {
      await index.ensure();
      let syms = index.graph.findSymbols(name, { exact: true, limit: 50 });
      if (syms.length === 0) syms = index.graph.findSymbols(name, { exact: false, limit: 50 });
      if (file) {
        const norm = file.replace(/\\/g, '/');
        syms = syms.filter((s) => s.file === norm || s.file.endsWith(norm));
      }
      if (syms.length === 0) return text(`Symbol "${name}" not found${file ? ` in ${file}` : ''}.`);
      if (syms.length > 1 && !pick) {
        return text(
          `Ambiguous: ${syms.length} matches. Re-call with index=<n> or file=<path>:\n\n` +
            syms.map((s, i) => fmtSymbol(s, i)).join('\n\n')
        );
      }
      const sym = syms[(pick || 1) - 1] || syms[0];
      const abs = path.join(root, sym.file);
      let src;
      try {
        src = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        return text(`Cannot read ${sym.file}: ${e.message}`);
      }
      const lines = src.split('\n').slice(sym.startLine - 1, sym.endLine);
      const out = `${sym.file}:${sym.startLine}-${sym.endLine} — ${sym.kind} ${sym.name}\n\n${lines.join('\n')}`;
      return text(out, src.length);
    }
  );

  registerTool(
    'file_skeleton',
    {
      description:
        'Compact outline of a file: imports plus every symbol signature with line ranges, WITHOUT bodies. 10-50x fewer tokens than reading the file. Use before deciding what to read in full.',
      inputSchema: {
        path: z.string().describe('Repo-relative file path')
      }
    },
    async ({ path: relPath }) => {
      await index.ensure();
      const norm = relPath.replace(/\\/g, '/');
      let rec = index.graph.files.get(norm);
      let key = norm;
      if (!rec) {
        for (const [f, r] of index.graph.files) {
          if (f.endsWith(norm)) {
            rec = r;
            key = f;
            break;
          }
        }
      }
      if (!rec) return text(`File "${relPath}" is not in the index (unsupported language, ignored, or does not exist).`);
      const lines = [`${key} (${rec.lang}, ${rec.symbols.length} symbols)`];
      if (rec.imports.length > 0) lines.push(`imports: ${rec.imports.slice(0, 30).join(', ')}`);
      lines.push('');
      for (const s of rec.symbols) {
        const indent = s.parent ? '  ' : '';
        lines.push(`${indent}${s.startLine}-${s.endLine} ${s.signature}${s.exported ? '  [exported]' : ''}`);
      }
      const out = lines.join('\n');
      return text(out, rec.size);
    }
  );

  registerTool(
    'semantic_search',
    {
      description:
        'Search code symbols and/or notes BY MEANING, not by name: "where is auth token validated", "retry logic for http calls". Uses a local embedding model; falls back to keyword match if unavailable. Use when you do not know the exact symbol name.',
      inputSchema: {
        query: z.string().describe('Natural-language description of what you are looking for'),
        scope: z.enum(['code', 'notes', 'all']).optional().describe('What to search (default code)'),
        limit: z.number().int().min(1).max(30).optional()
      }
    },
    async ({ query, scope = 'code', limit = 8 }) => {
      await index.ensure();
      notes.load();
      const lines = [];
      if (scope === 'code' || scope === 'all') {
        const items = symbolItems(index.graph);
        if (items.length === 0) {
          lines.push('No symbols indexed.');
        } else {
          const { mode, results, truncated } = await semanticSearch(vectors, query, items, limit);
          lines.push(`Top code matches (${mode} search${truncated ? ', index partially embedded — call again to embed more' : ''}):`, '');
          results.forEach((r, i) => lines.push(fmtSymbol(r.item.sym, i) + `\n   relevance: ${r.score.toFixed(2)}`, ''));
          if (results.length === 0) lines.push('(nothing relevant found)', '');
        }
      }
      if (scope === 'notes' || scope === 'all') {
        const items = noteItems(notes.notes);
        if (items.length > 0) {
          const { results } = await semanticSearch(vectors, query, items, Math.min(limit, 5));
          if (results.length > 0) {
            lines.push('Related notes:', '');
            for (const r of results) lines.push(`#${r.item.note.id}: ${r.item.note.text}`);
          }
        } else if (scope === 'notes') {
          lines.push('No notes saved yet.');
        }
      }
      return text(lines.join('\n'));
    }
  );

  registerTool(
    'usage_stats',
    {
      description: 'Show how much this server has been used and a conservative estimate of tokens saved.',
      inputSchema: {}
    },
    async () => text(stats.summary())
  );

  registerTool(
    'find_callers',
    {
      description: 'List every call site of a function/method across the repo, with the enclosing caller symbol.',
      inputSchema: {
        name: z.string().describe('Called symbol name (exact, case-insensitive)'),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async ({ name, limit = 50 }) => {
      await index.ensure();
      const callers = index.graph.findCallers(name, { limit });
      if (callers.length === 0) return text(`No call sites of "${name}" found.`);
      const lines = [`${callers.length} call site(s) of "${name}":`, ''];
      for (const c of callers) {
        const who = c.caller ? `${c.caller.name} (${c.caller.kind})` : '<module level>';
        lines.push(`${c.file}:${c.line} — in ${who}`);
      }
      return text(lines.join('\n'));
    }
  );

  registerTool(
    'analyze_impact',
    {
      description:
        'Transitive impact analysis: who calls X, who calls the callers, etc. Use BEFORE changing a function signature or behavior to see the blast radius.',
      inputSchema: {
        name: z.string().describe('Symbol name to analyze (exact, case-insensitive)'),
        depth: z.number().int().min(1).max(5).optional().describe('Max caller depth (default 3)')
      }
    },
    async ({ name, depth = 3 }) => {
      await index.ensure();
      const { layers, total, truncated } = index.graph.impact(name, { maxDepth: depth });
      if (total === 0) return text(`No callers found for "${name}" — changing it affects only its own file (or it is called dynamically).`);
      const lines = [`Impact of changing "${name}": ${total} call site(s) across ${depth} level(s)${truncated ? ' (truncated)' : ''}`, ''];
      for (const layer of layers) {
        lines.push(`— depth ${layer.depth}:`);
        for (const e of layer.entries) {
          const who = e.caller ? `${e.caller.name}` : '<module>';
          lines.push(`  ${e.file}:${e.line} — ${who} calls ${e.calls}`);
        }
      }
      return text(lines.join('\n'));
    }
  );

  registerTool(
    'reindex',
    {
      description: 'Force a re-scan of the repository. Use full=true to rebuild the index from scratch.',
      inputSchema: {
        full: z.boolean().optional().describe('Rebuild everything (default: incremental)')
      }
    },
    async ({ full = false }) => {
      if (full) {
        const stats = await index.fullReindex();
        return text(`Full reindex done: ${stats.files} files, ${stats.symbols} symbols, ${stats.calls} call edges.`);
      }
      await index.ensure();
      const r = await index.refresh({ force: true });
      const stats = index.graph.stats();
      return text(`Refreshed: ${r.parsed} file(s) re-parsed, ${r.removed} removed. Index: ${stats.files} files, ${stats.symbols} symbols.`);
    }
  );

  registerTool(
    'save_note',
    {
      description:
        'Persist a short project note (decision, gotcha, convention) that survives across sessions. Keep it to 1-3 sentences.',
      inputSchema: {
        text: z.string().min(3).describe('The note text'),
        tags: z.array(z.string()).optional().describe('Optional tags for recall')
      }
    },
    async ({ text: noteText, tags = [] }) => {
      const note = notes.add(noteText, tags);
      return text(`Saved note #${note.id}.`);
    }
  );

  registerTool(
    'recall_notes',
    {
      description: 'Retrieve previously saved project notes relevant to a query (keyword match, most relevant first).',
      inputSchema: {
        query: z.string().describe('What are you working on / looking for'),
        limit: z.number().int().min(1).max(20).optional()
      }
    },
    async ({ query, limit = 5 }) => {
      notes.load();
      let found;
      if (notes.notes.length === 0) {
        found = [];
      } else {
        const { results } = await semanticSearch(vectors, query, noteItems(notes.notes), limit);
        found = results.map((r) => r.item.note);
        if (found.length === 0) found = notes.recall(query, limit);
      }
      if (found.length === 0) return text('No matching notes.');
      return text(
        found
          .map((n) => `#${n.id} [${n.createdAt.slice(0, 10)}]${n.tags.length > 0 ? ' (' + n.tags.join(', ') + ')' : ''}\n${n.text}`)
          .join('\n\n')
      );
    }
  );

  return { server, index };
}

export async function startStdio(root) {
  const { server } = await createServer(root);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[codegraph] serving ${root}`);
}
