// Honest token accounting per tool. "Saved" is only claimed where a direct
// counterfactual exists (read_symbol / file_skeleton vs reading the whole
// file); for other tools we just count calls and output size.
import fs from 'node:fs';
import path from 'node:path';

const toTokens = (chars) => Math.ceil(chars / 4);

export class Stats {
  constructor(root) {
    this.file = path.join(root, '.codegraph', 'stats.json');
    this.data = null;
  }

  load() {
    if (this.data) return;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { since: new Date().toISOString(), tools: {} };
    }
  }

  record(tool, outputChars, counterfactualChars = null) {
    this.load();
    const t = (this.data.tools[tool] ||= { calls: 0, outputTokens: 0, savedTokens: 0 });
    t.calls++;
    t.outputTokens += toTokens(outputChars);
    if (counterfactualChars !== null && counterfactualChars > outputChars) {
      t.savedTokens += toTokens(counterfactualChars) - toTokens(outputChars);
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch {
      // stats are best-effort
    }
  }

  summary() {
    this.load();
    const rows = Object.entries(this.data.tools).sort((a, b) => b[1].calls - a[1].calls);
    let calls = 0;
    let output = 0;
    let saved = 0;
    const lines = [`Codegraph usage since ${this.data.since.slice(0, 10)}:`, ''];
    for (const [tool, t] of rows) {
      calls += t.calls;
      output += t.outputTokens;
      saved += t.savedTokens;
      lines.push(
        `${tool}: ${t.calls} call(s), ~${t.outputTokens} output tokens` +
          (t.savedTokens > 0 ? `, ~${t.savedTokens} tokens saved vs reading whole files` : '')
      );
    }
    if (rows.length === 0) lines.push('(no tool calls recorded yet)');
    lines.push('');
    lines.push(`Total: ${calls} call(s), ~${output} output tokens, ~${saved} tokens saved (conservative: only counts read_symbol/file_skeleton vs full-file reads).`);
    return lines.join('\n');
  }
}
