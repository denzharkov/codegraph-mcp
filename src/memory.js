// Lightweight persistent session notes with keyword recall.
// Stored per-repo in .codegraph/notes.json.
import fs from 'node:fs';
import path from 'node:path';

function tokenize(text) {
  return (text.toLowerCase().match(/[a-zа-яё0-9_]{2,}/gi) || []).map((t) => t.toLowerCase());
}

export class Notes {
  constructor(root) {
    this.file = path.join(root, '.codegraph', 'notes.json');
    this.notes = null;
  }

  load() {
    if (this.notes) return;
    try {
      this.notes = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this.notes)) this.notes = [];
    } catch {
      this.notes = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.notes, null, 1));
  }

  add(text, tags = []) {
    this.load();
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

  recall(query, limit = 5) {
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
