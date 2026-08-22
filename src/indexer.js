// Incremental indexing: loads the persisted graph, re-parses only files whose
// mtime/size changed, drops deleted files.
import fs from 'node:fs';
import { initParsers } from './parsers.js';
import { extractFile } from './extract.js';
import { walkRepo } from './walk.js';
import { Graph } from './graph.js';

const REFRESH_INTERVAL_MS = 3000;

export class Index {
  constructor(root) {
    this.root = root;
    this.graph = new Graph(root);
    this.initialized = false;
    this.lastRefresh = 0;
  }

  async ensure() {
    if (!this.initialized) {
      await initParsers();
      this.graph.load();
      this.initialized = true;
      await this.refresh({ force: true });
    } else {
      await this.refresh({});
    }
  }

  async refresh({ force = false }) {
    const now = Date.now();
    if (!force && now - this.lastRefresh < REFRESH_INTERVAL_MS) return { parsed: 0, removed: 0 };
    this.lastRefresh = now;

    const found = walkRepo(this.root);
    const foundSet = new Set(found.map((f) => f.relPath));
    let removed = 0;
    for (const relPath of [...this.graph.files.keys()]) {
      if (!foundSet.has(relPath)) {
        this.graph.removeFile(relPath);
        removed++;
      }
    }

    let parsed = 0;
    let failed = 0;
    for (const file of found) {
      const existing = this.graph.files.get(file.relPath);
      if (existing && existing.mtimeMs === file.mtimeMs && existing.size === file.size) continue;
      let src;
      try {
        src = fs.readFileSync(file.path, 'utf8');
      } catch {
        continue;
      }
      try {
        const extracted = await extractFile(file.lang, src);
        if (!extracted) continue;
        this.graph.setFile(file.relPath, {
          mtimeMs: file.mtimeMs,
          size: file.size,
          lang: file.lang,
          imports: extracted.imports,
          symbols: extracted.symbols,
          calls: extracted.calls
        });
        parsed++;
      } catch {
        failed++;
      }
    }

    if (parsed > 0 || removed > 0 || force) {
      this.graph.rebuildIndexes();
      this.graph.save();
    }
    return { parsed, removed, failed };
  }

  async fullReindex() {
    this.graph.files.clear();
    this.graph.dirty = true;
    this.initialized = false;
    await this.ensure();
    return this.graph.stats();
  }
}
