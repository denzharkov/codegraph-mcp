#!/usr/bin/env node
// Entry point. Default: stdio MCP server for the current directory.
//   codegraph-mcp [--root <path>]       start MCP server
//   codegraph-mcp index [--root <path>] build/refresh the index and print stats
//   codegraph-mcp install               register in Claude Code (user scope)
//   codegraph-mcp uninstall             remove the registration
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
} else if (command === 'install' || command === 'uninstall') {
  const claudeArgs =
    command === 'install'
      ? ['mcp', 'add', 'codegraph', '-s', 'user', '--', process.execPath, fileURLToPath(import.meta.url)]
      : ['mcp', 'remove', 'codegraph', '-s', 'user'];
  // single command string with explicit quoting: works with the .cmd shim on
  // Windows and avoids unescaped-args concatenation
  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const r = spawnSync(['claude', ...claudeArgs].map(quote).join(' '), { stdio: 'inherit', shell: true });
  if (r.error || r.status !== 0) {
    console.error(
      `\nCould not run the "claude" CLI${r.error ? ` (${r.error.message})` : ''}.\n` +
        `Register manually:\n  claude mcp ${claudeArgs.slice(1).join(' ')}`
    );
    process.exit(1);
  }
  if (command === 'install') {
    console.log('\ncodegraph registered for all your projects (CLI and VS Code extension).');
    console.log('Restart your Claude Code session, then verify with: claude mcp list');
  }
} else if (command === null || command === 'serve') {
  const { startStdio } = await import('../src/server.js');
  await startStdio(root);
} else {
  console.error(`Unknown command: ${command}\nUsage: codegraph-mcp [serve|index|install|uninstall] [--root <path>]`);
  process.exit(1);
}
