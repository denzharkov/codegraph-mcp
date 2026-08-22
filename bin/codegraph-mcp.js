#!/usr/bin/env node
// Entry point. Default: stdio MCP server for the current directory.
//   codegraph-mcp [--root <path>]       start MCP server
//   codegraph-mcp index [--root <path>] build/refresh the index and print stats
//   codegraph-mcp install               register in Claude Code (user scope)
//   codegraph-mcp uninstall             remove the registration
//   codegraph-mcp dashboard [--root <path>] [--no-open]  generate HTML report
//   codegraph-mcp map [--root <path>] [--no-open]        interactive architecture map
//   codegraph-mcp proxy [--port <n>]    transparent dedup proxy to the Anthropic API
//   codegraph-mcp wrap [args...]        launch claude through the proxy (like cf wrap)
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
} else if (command === 'proxy') {
  const { startProxy } = await import('../src/proxy.js');
  const port = Number(argValue(args, '--port')) || 3210;
  const upstream = argValue(args, '--upstream') || process.env.CODEGRAPH_UPSTREAM || 'https://api.anthropic.com';
  await startProxy({ port, upstream, root });
  console.error(`\nPoint Claude Code at it:\n  CLI:     ANTHROPIC_BASE_URL=http://127.0.0.1:${port} claude`);
  console.error(`  VS Code: add to .claude/settings.json -> {"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}"}}`);
} else if (command === 'wrap') {
  const { startProxy } = await import('../src/proxy.js');
  const port = Number(argValue(args, '--port')) || 3210;
  const server = await startProxy({ port, quiet: true, root });
  console.error(`[codegraph-proxy] on http://127.0.0.1:${port}; launching claude...`);
  const claudeArgs = args.filter((a, i) => !(a === '--port' || args[i - 1] === '--port'));
  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const r = spawnSync(['claude', ...claudeArgs].map(quote).join(' '), {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` }
  });
  server.close();
  process.exit(r.status ?? 0);
} else if (command === 'dashboard' || command === 'map') {
  const file =
    command === 'dashboard'
      ? await (await import('../src/dashboard.js')).writeDashboard(root)
      : await (await import('../src/archmap.js')).writeArchMap(root);
  console.log(`${command === 'map' ? 'Architecture map' : 'Dashboard'} written to ${file}`);
  if (!args.includes('--no-open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
    spawnSync(opener[0], opener[1], { stdio: 'ignore' });
  }
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
