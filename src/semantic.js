// Semantic search over symbols and notes. Vectors are cached on disk keyed by
// a content hash, so only new/changed symbols get embedded on each call.
// Storage: .codegraph/vectors.meta.json (keys) + .codegraph/vectors.bin (f32).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEmbedder, cosineTopK } from './embeddings.js';

const MAX_EMBED_PER_CALL = 2000;
const BATCH = 48;

function hashKey(text) {
  return crypto.createHash('sha1').update(text).digest('base64url').slice(0, 16);
}

export class VectorStore {
  constructor(root) {
    this.dir = path.join(root, '.codegraph');
    this.metaFile = path.join(this.dir, 'vectors.meta.json');
    this.binFile = path.join(this.dir, 'vectors.bin');
    this.keys = null; // key -> row index
    this.matrix = null; // Float32Array rows*dim
    this.dim = 0;
    this.model = null;
  }

  load(model, dim) {
    if (this.keys) return;
    this.keys = new Map();
    this.dim = dim;
    this.model = model;
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      if (meta.model === model && meta.dim === dim) {
        const buf = fs.readFileSync(this.binFile);
        const matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        if (matrix.length === meta.keys.length * dim) {
          meta.keys.forEach((k, i) => this.keys.set(k, i));
          this.matrix = matrix;
          return;
        }
      }
    } catch {
      // no cache yet
    }
    this.matrix = new Float32Array(0);
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const keys = [...this.keys.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    fs.writeFileSync(this.metaFile, JSON.stringify({ model: this.model, dim: this.dim, keys }));
    fs.writeFileSync(this.binFile, Buffer.from(this.matrix.buffer, this.matrix.byteOffset, this.matrix.byteLength));
  }

  async ensureVectors(items, embedder) {
    // items: [{key, text}]
    const missing = items.filter((it) => !this.keys.has(it.key)).slice(0, MAX_EMBED_PER_CALL);
    if (missing.length === 0) return { embedded: 0, truncated: false };
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const vecs = await embedder.embed(batch.map((b) => b.text));
      const oldRows = this.matrix.length / this.dim;
      const grown = new Float32Array(this.matrix.length + vecs.length);
      grown.set(this.matrix);
      grown.set(vecs, this.matrix.length);
      this.matrix = grown;
      batch.forEach((b, j) => this.keys.set(b.key, oldRows + j));
    }
    this.save();
    const totalMissing = items.filter((it) => !this.keys.has(it.key)).length;
    return { embedded: missing.length, truncated: totalMissing > 0 };
  }

  /** Search among the given items only (they must have been ensured). */
  search(queryVec, items, k) {
    // build a compact matrix view of just these items
    const sub = new Float32Array(items.length * this.dim);
    const present = [];
    for (const it of items) {
      const row = this.keys.get(it.key);
      if (row === undefined) continue;
      sub.set(this.matrix.subarray(row * this.dim, (row + 1) * this.dim), present.length * this.dim);
      present.push(it);
    }
    const top = cosineTopK(queryVec, sub.subarray(0, present.length * this.dim), this.dim, k);
    return top.map((t) => ({ item: present[t.index], score: t.score }));
  }
}

export function symbolItems(graph) {
  const items = [];
  for (const [file, rec] of graph.files) {
    for (const sym of rec.symbols) {
      const text = `${sym.kind} ${sym.name}${sym.parent ? ' in ' + sym.parent : ''}: ${sym.signature} (file ${file})`;
      items.push({ key: hashKey(text), text, sym: { ...sym, file } });
    }
  }
  return items;
}

export function noteItems(notes) {
  return notes.map((n) => {
    const text = `${n.text} ${n.tags.join(' ')}`;
    return { key: hashKey('note:' + text), text, note: n };
  });
}

/** Keyword fallback used when the embedding model is unavailable. */
export function keywordSearch(query, items, k) {
  const qTokens = new Set((query.toLowerCase().match(/[a-zа-яё0-9_]{2,}/gi) || []).map((t) => t.toLowerCase()));
  const scored = items.map((item) => {
    const tokens = (item.text.toLowerCase().match(/[a-zа-яё0-9_]{2,}/gi) || []);
    let hits = 0;
    for (const t of tokens) if (qTokens.has(t)) hits++;
    return { item, score: hits / Math.max(tokens.length, 1) + hits * 0.1 };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function semanticSearch(store, query, items, k) {
  const embedder = await getEmbedder();
  if (!embedder) {
    return { mode: 'keyword', results: keywordSearch(query, items, k), truncated: false };
  }
  store.load(embedder.model, embedder.dim);
  const { truncated } = await store.ensureVectors(items, embedder);
  const queryVec = await embedder.embed([query]);
  return { mode: 'semantic', results: store.search(queryVec, items, k), truncated };
}
