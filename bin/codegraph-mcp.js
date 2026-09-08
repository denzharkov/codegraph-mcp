#!/usr/bin/env node
// Entry point. Default: stdio MCP server for the current directory.
//   codegraph-mcp [--root <path>]       start MCP server
//   codegraph-mcp index [--root <path>] build/refresh the index and print stats
//   codegraph-mcp install               register in Claude Code (user scope) + PreToolUse hook
//   codegraph-mcp uninstall             remove the registration and the hook
//   codegraph-mcp bench [--root <path>] [--no-write]     tokens: whole file vs file_skeleton / read_symbol
//   codegraph-mcp dashboard [--root <path>] [--no-open]  generate HTML report
//   codegraph-mcp map [--root <path>] [--no-open]        interactive architecture map
//   codegraph-mcp proxy [--port <n>] [--idle <s>]  transparent shrinking proxy to the Anthropic API
//   codegraph-mcp wrap [args...]        launch claude through the proxy (like cf wrap)
import os from 'node:os';
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
  const idleMs = (Number(argValue(args, '--idle')) || 0) * 1000;
  await startProxy({ port, upstream, root, idleMs });
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
} else if (command === 'bench') {
  const { runBench, formatBench } = await import('../src/bench.js');
  const result = await runBench(root, { minLines: Number(process.env.CODEGRAPH_MIN_LINES) || 300 });
  console.log(formatBench(result));
  if (!args.includes('--no-write')) {
    const file = path.join(root, '.codegraph', 'benchmark.json');
    (await import('node:fs')).writeFileSync(file, JSON.stringify(result, null, 1));
    console.log(`\nWritten to ${file}`);
  }
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
  // The PreToolUse hook lives in user settings next to the MCP registration:
  // it is what turns the usage guidance from advice into a gate.
  const { installHook, uninstallHook, installProxyEnv, uninstallProxyEnv } = await import('../src/hook.js');
  const { DEFAULT_PROXY_PORT } = await import('../src/proxy.js');
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codegraph-hook.js');
  const proxyUrl = `http://127.0.0.1:${Number(process.env.CODEGRAPH_PROXY_PORT) || DEFAULT_PROXY_PORT}`;
  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  if (command === 'install') {
    installHook(settingsFile, `${quote(process.execPath)} ${quote(hookScript)}`);
    const kept = installProxyEnv(settingsFile, proxyUrl);
    if (kept) console.error(`ANTHROPIC_BASE_URL is already ${kept} in ${settingsFile}; left as is, the proxy is not wired in.`);
  } else {
    uninstallHook(settingsFile);
    uninstallProxyEnv(settingsFile);
  }
  const claudeArgs =
    command === 'install'
      ? ['mcp', 'add', 'codegraph', '-s', 'user', '--', process.execPath, fileURLToPath(import.meta.url)]
      : ['mcp', 'remove', 'codegraph', '-s', 'user'];
  // single command string with explicit quoting: works with the .cmd shim on
  // Windows and avoids unescaped-args concatenation
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
    console.log(`PreToolUse hook added to ${settingsFile} (Read/Bash on indexed files are routed to codegraph tools).`);
    console.log(`ANTHROPIC_BASE_URL=${proxyUrl} set there too: every session goes through the shrinking proxy,`);
    console.log('which the MCP server starts on demand (CODEGRAPH_NO_PROXY=1 to opt out).');
    console.log('Restart your Claude Code session, then verify with: claude mcp list');
  }
} else if (command === null || command === 'serve') {
  const { startStdio } = await import('../src/server.js');
  await startStdio(root);
} else {
  console.error(`Unknown command: ${command}\nUsage: codegraph-mcp [serve|index|bench|install|uninstall] [--root <path>]`);
  process.exit(1);
}
