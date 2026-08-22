// Static, self-contained HTML dashboard generated from .codegraph/stats.json
// and the symbol graph. No external assets, works offline, light/dark aware.
import fs from 'node:fs';
import path from 'node:path';
import { Index } from './indexer.js';
import { buildReverseImports } from './imports.js';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
};

export async function generateDashboard(root, liveIndex = null) {
  const index = liveIndex ?? new Index(root);
  await index.ensure();
  const g = index.graph;
  const graphStats = g.stats();

  let usage = { since: null, tools: {} };
  try {
    usage = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'stats.json'), 'utf8'));
  } catch {
    // no usage recorded yet
  }

  const tools = Object.entries(usage.tools || {}).sort((a, b) => b[1].calls - a[1].calls);
  const totals = tools.reduce(
    (acc, [, t]) => ({
      calls: acc.calls + t.calls,
      output: acc.output + t.outputTokens,
      saved: acc.saved + t.savedTokens
    }),
    { calls: 0, output: 0, saved: 0 }
  );
  const maxCalls = Math.max(1, ...tools.map(([, t]) => t.calls));

  const langs = Object.entries(graphStats.byLang).sort((a, b) => b[1] - a[1]);
  const maxLang = Math.max(1, ...langs.map(([, n]) => n));

  const reverse = buildReverseImports(g);
  const central = [...reverse.entries()]
    .map(([file, importers]) => ({ file, inbound: importers.size }))
    .sort((a, b) => b.inbound - a.inbound)
    .slice(0, 10);

  const toolRows = tools
    .map(([name, t]) => {
      const w = Math.max(1.5, (t.calls / maxCalls) * 100);
      const saved = t.savedTokens > 0 ? `<td class="num saved">${esc(fmt(t.savedTokens))}</td>` : '<td class="num muted">—</td>';
      return `<tr title="${esc(name)}: ${t.calls} calls, ~${t.outputTokens} output tokens">
        <th scope="row">${esc(name)}</th>
        <td class="barcell"><div class="bar" style="width:${w.toFixed(1)}%"></div></td>
        <td class="num">${t.calls}</td>
        <td class="num">${esc(fmt(t.outputTokens))}</td>
        ${saved}
      </tr>`;
    })
    .join('\n');

  const langRows = langs
    .map(([lang, n]) => {
      const w = Math.max(1.5, (n / maxLang) * 100);
      return `<tr><th scope="row">${esc(lang)}</th>
        <td class="barcell"><div class="bar" style="width:${w.toFixed(1)}%"></div></td>
        <td class="num">${n}</td></tr>`;
    })
    .join('\n');

  const centralRows = central
    .map((c) => `<tr><th scope="row"><code>${esc(c.file)}</code></th><td class="num">${c.inbound}</td></tr>`)
    .join('\n');

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const since = usage.since ? usage.since.slice(0, 10) : null;

  return `<title>Codegraph Dashboard</title>
<style>
  :root {
    color-scheme: light;
    --page: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
    --bar: #2a78d6; --saved: #006300;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --page: #0d0d0d; --surface: #1a1a19;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
      --bar: #3987e5; --saved: #0ca30c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
    --bar: #3987e5; --saved: #0ca30c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--page); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px 56px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--ink-2); margin: 0 0 24px; font-size: 13px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile .v { font-size: 28px; font-weight: 650; letter-spacing: -0.01em; }
  .tile .v.saved { color: var(--saved); }
  .tile .l { color: var(--ink-2); font-size: 12.5px; margin-top: 2px; }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; overflow-x: auto; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .note { color: var(--muted); font-size: 12.5px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 10px 5px 0; font-weight: 400; font-size: 13.5px; border-bottom: 1px solid var(--grid); vertical-align: middle; }
  tr:last-child th, tr:last-child td { border-bottom: none; }
  thead th { color: var(--muted); font-size: 12px; }
  th[scope="row"] { color: var(--ink); white-space: nowrap; padding-right: 14px; }
  .barcell { width: 42%; min-width: 120px; }
  .bar { height: 10px; background: var(--bar); border-radius: 0 4px 4px 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--ink-2); }
  .num.saved { color: var(--saved); }
  .muted { color: var(--muted); }
  code { font: 12.5px ui-monospace, SFMono-Regular, Consolas, monospace; }
</style>
<div class="wrap">
  <h1>Codegraph</h1>
  <p class="sub">${esc(root)} · generated ${esc(generatedAt)}</p>

  <div class="tiles">
    <div class="tile"><div class="v saved">${esc(fmt(totals.saved))}</div><div class="l">tokens saved vs full-file reads</div></div>
    <div class="tile"><div class="v">${esc(fmt(totals.calls))}</div><div class="l">tool calls${since ? ' since ' + esc(since) : ''}</div></div>
    <div class="tile"><div class="v">${esc(fmt(graphStats.symbols))}</div><div class="l">symbols in ${esc(fmt(graphStats.files))} files</div></div>
    <div class="tile"><div class="v">${esc(fmt(graphStats.calls))}</div><div class="l">call edges in the graph</div></div>
  </div>

  <section>
    <h2>Tool usage</h2>
    <p class="note">Savings are counted only where a direct counterfactual exists (read_symbol / file_skeleton vs reading the whole file).</p>
    ${
      tools.length > 0
        ? `<table>
      <thead><tr><th>tool</th><th></th><th class="num">calls</th><th class="num">output&nbsp;tok</th><th class="num">saved&nbsp;tok</th></tr></thead>
      <tbody>${toolRows}</tbody></table>`
        : '<p class="note">No tool calls recorded yet — work with Claude Code in this repo and regenerate.</p>'
    }
  </section>

  <section>
    <h2>Indexed languages</h2>
    <table><tbody>${langRows || '<tr><td class="muted">nothing indexed</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Most central files</h2>
    <p class="note">By number of files importing them (resolved import graph).</p>
    ${
      central.length > 0
        ? `<table><thead><tr><th>file</th><th class="num">imported&nbsp;by</th></tr></thead><tbody>${centralRows}</tbody></table>`
        : '<p class="note">No resolved intra-repo imports.</p>'
    }
  </section>
</div>
`;
}

export async function writeDashboard(root, liveIndex = null) {
  const html = await generateDashboard(root, liveIndex);
  const file = path.join(root, '.codegraph', 'dashboard.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<!doctype html>\n<html><head><meta charset="utf-8">\n' + html + '</html>');
  return file;
}
