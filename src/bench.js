// Token benchmark: what the agent pays to read a file whole (Read / cat)
// versus what codegraph hands it instead — the file_skeleton text and then
// the source of one symbol. Measured on the real index of a real repo, with
// the same chars/4 estimate usage_stats uses, so the numbers are comparable
// with the live counters.
import fs from 'node:fs';
import path from 'node:path';
import { Index } from './indexer.js';
import { formatSkeleton } from './server.js';

const toTokens = (chars) => Math.ceil(chars / 4);

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function runBench(root, { minLines = 300 } = {}) {
  const index = new Index(root);
  await index.ensure();

  const rows = [];
  for (const [file, rec] of index.graph.files) {
    if (rec.symbols.length === 0) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    const symbolTokens = rec.symbols.map((s) =>
      toTokens(lines.slice(s.startLine - 1, s.endLine).join('\n').length)
    );
    rows.push({
      file,
      lang: rec.lang,
      lines: lines.length,
      symbols: rec.symbols.length,
      fileTokens: toTokens(src.length),
      skeletonTokens: toTokens(formatSkeleton(file, rec).length),
      medianSymbolTokens: median(symbolTokens)
    });
  }
  rows.sort((a, b) => b.fileTokens - a.fileTokens);

  const sum = (list, key) => list.reduce((acc, r) => acc + r[key], 0);
  const aggregate = (list) => {
    const file = sum(list, 'fileTokens');
    const skeleton = sum(list, 'skeletonTokens');
    const skeletonPlusSymbol = skeleton + sum(list, 'medianSymbolTokens');
    const pct = (x) => (file ? Math.round((1 - x / file) * 100) : 0);
    return {
      files: list.length,
      fileTokens: file,
      skeletonTokens: skeleton,
      skeletonPlusSymbolTokens: skeletonPlusSymbol,
      skeletonSavedPct: pct(skeleton),
      skeletonPlusSymbolSavedPct: pct(skeletonPlusSymbol)
    };
  };

  return {
    root,
    measuredAt: new Date().toISOString(),
    minLines,
    all: aggregate(rows),
    aboveThreshold: aggregate(rows.filter((r) => r.lines > minLines)),
    top: rows.slice(0, 10)
  };
}

export function formatBench(result) {
  const fmt = (n) => n.toLocaleString('en-US');
  const block = (title, a) => [
    `${title}: ${a.files} files`,
    `  whole file            ${fmt(a.fileTokens).padStart(10)} tokens`,
    `  file_skeleton         ${fmt(a.skeletonTokens).padStart(10)} tokens  (-${a.skeletonSavedPct}%)`,
    `  skeleton + one symbol ${fmt(a.skeletonPlusSymbolTokens).padStart(10)} tokens  (-${a.skeletonPlusSymbolSavedPct}%)`
  ];
  const lines = [
    `codegraph bench — ${result.root}`,
    '',
    ...block('All indexed files with symbols', result.all),
    '',
    ...block(`Files above the hook threshold (> ${result.minLines} lines)`, result.aboveThreshold),
    '',
    'Largest files:',
    '  lines  whole  skeleton  symbol  file'
  ];
  for (const r of result.top) {
    lines.push(
      `  ${String(r.lines).padStart(5)}  ${fmt(r.fileTokens).padStart(6)}  ${fmt(r.skeletonTokens).padStart(8)}  ${fmt(r.medianSymbolTokens).padStart(6)}  ${r.file}`
    );
  }
  return lines.join('\n');
}
