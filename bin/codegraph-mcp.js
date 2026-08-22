#!/usr/bin/env node
// Entry point. Default: stdio MCP server for the current directory.
//   codegraph-mcp [--root <path>]      start MCP server
//   codegraph-mcp index [--root <path>] build/refresh the index and print stats
import path from 'node:path';
import process from 'node:process';

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args[0] : null;
const root = path.resolve(argValue(args, '--root') || process.env.CODEGRAPH_ROOT || process.cwd());

if (command === 'index') {
  const { Index } = await import('../src/indexer.js');
  const t0 = Date.now();
  const index = new Index(root);
  await index.ensure();
  const stats = index.graph.stats();
  console.log(
    `Indexed ${root} in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
      `${stats.files} files, ${stats.symbols} symbols, ${stats.calls} call edges`
  );
  console.log(`Languages: ${Object.entries(stats.byLang).map(([l, n]) => `${l}=${n}`).join(' ') || 'none'}`);
} else if (command === null || command === 'serve') {
  const { startStdio } = await import('../src/server.js');
  await startStdio(root);
} else {
  console.error(`Unknown command: ${command}\nUsage: codegraph-mcp [serve|index] [--root <path>]`);
  process.exit(1);
}
