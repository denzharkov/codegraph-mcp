// Lightweight persistent session notes with keyword recall.
// Stored per-repo in .codegraph/notes.json.
//
// Several server processes (CLI + VS Code sessions) share one notes.json, so
// load() always re-reads from disk — a memoized cache here caused lost
// updates: a stale in-memory array written back by save() silently destroyed
// notes added by the other session.
import fs from 'node:fs';
import path from 'node:path';

function tokenize(text) {
  return ((text || '').toLowerCase().match(/[a-zа-яё0-9_]{2,}/gi) || []).map((t) => t.toLowerCase());
}

// hand-edited or older-schema entries must never crash recall — normalize
// every element to the {id, text, tags, createdAt} shape on read
function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const n of raw) {
    if (!n || typeof n.text !== 'string' || n.text.length === 0) continue;
    out.push({
      id: Number.isFinite(n.id) ? n.id : out.length + 1,
      text: n.text,
      tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string') : [],
      createdAt: typeof n.createdAt === 'string' ? n.createdAt : ''
    });
  }
  return out;
}

export class Notes {
  constructor(root) {
    this.file = path.join(root, '.codegraph', 'notes.json');
    this.notes = [];
  }

  load() {
    try {
      this.notes = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.notes = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.notes, null, 1));
    fs.renameSync(tmp, this.file);
  }

  add(text, tags = []) {
    this.load(); // fresh read: never clobber notes another session just saved
    const note = {
      id: this.notes.length > 0 ? Math.max(...this.notes.map((n) => n.id)) + 1 : 1,
      text,
      tags,
      createdAt: new Date().toISOString()
    };
    this.notes.push(note);
    if (this.notes.length > 500) this.notes = this.notes.slice(-500);
    this.save();
    return note;
  }

  /** Empty/blank query returns the most recent notes, newest first. */
  recall(query = '', limit = 5) {
    this.load();
    const qTokens = new Set(tokenize(query));
    if (qTokens.size === 0) return this.notes.slice(-limit).reverse();
    const scored = this.notes.map((n, order) => {
      const nTokens = tokenize(n.text + ' ' + n.tags.join(' '));
      let hits = 0;
      for (const t of nTokens) if (qTokens.has(t)) hits++;
      const score = hits / Math.max(nTokens.length, 1) + hits * 0.5 + order / (this.notes.length * 100);
      return { note: n, score, hits };
    });
    return scored
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.note);
  }
}
