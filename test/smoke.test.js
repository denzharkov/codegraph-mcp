import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fixtureDir;

before(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fixture-'));
  const write = (rel, content) => {
    const abs = path.join(fixtureDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write(
    'src/db.js',
    `export function saveUser(user) {\n  return validate(user) && persist(user);\n}\nfunction validate(u) { return !!u.name; }\nfunction persist(u) { return true; }\n`
  );
  write(
    'src/api.js',
    `import { saveUser } from './db.js';\nexport function createUserHandler(req) {\n  return saveUser(req.body);\n}\n`
  );
  write(
    'src/routes.js',
    `import { createUserHandler } from './api.js';\nexport function registerRoutes(app) {\n  app.post('/users', createUserHandler);\n  createUserHandler({ body: {} });\n}\n`
  );
  write(
    'lib/utils.py',
    `class Cache:\n    def get(self, key):\n        return self._read(key)\n    def _read(self, key):\n        return None\n\ndef warm_cache():\n    c = Cache()\n    c.get("a")\n`
  );
});

after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('indexer builds a graph over a mixed-language fixture', async () => {
  const { Index } = await import('../src/indexer.js');
  const index = new Index(fixtureDir);
  await index.ensure();
  const stats = index.graph.stats();
  assert.equal(stats.files, 4);
  assert.ok(stats.symbols >= 8, `expected >=8 symbols, got ${stats.symbols}`);

  const defs = index.graph.findSymbols('saveUser', { exact: true });
  assert.equal(defs.length, 1);
  assert.equal(defs[0].file, 'src/db.js');
  assert.equal(defs[0].exported, true);

  const callers = index.graph.findCallers('saveUser');
  assert.equal(callers.length, 1);
  assert.equal(callers[0].caller.name, 'createUserHandler');

  const impact = index.graph.impact('saveUser', { maxDepth: 3 });
  const allCallers = impact.layers.flatMap((l) => l.entries.map((e) => e.caller?.name));
  assert.ok(allCallers.includes('createUserHandler'), 'depth 1 caller');
  assert.ok(allCallers.includes('registerRoutes'), 'depth 2 transitive caller');

  const pyDefs = index.graph.findSymbols('warm_cache', { exact: true });
  assert.equal(pyDefs.length, 1);
  assert.equal(pyDefs[0].file, 'lib/utils.py');
});

test('incremental refresh picks up edits and deletions', async () => {
  const { Index } = await import('../src/indexer.js');
  const index = new Index(fixtureDir);
  await index.ensure();

  const newFile = path.join(fixtureDir, 'src', 'extra.js');
  fs.writeFileSync(newFile, 'export function extraThing() { return 1; }\n');
  // ensure mtime differs even on coarse filesystems
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(newFile, future, future);

  index.lastRefresh = 0;
  await index.refresh({ force: true });
  assert.equal(index.graph.findSymbols('extraThing', { exact: true }).length, 1);

  fs.rmSync(newFile);
  index.lastRefresh = 0;
  await index.refresh({ force: true });
  assert.equal(index.graph.findSymbols('extraThing', { exact: true }).length, 0);
});

test('persisted index reloads without re-parsing', async () => {
  const { Index } = await import('../src/indexer.js');
  const first = new Index(fixtureDir);
  await first.ensure();
  first.graph.save();

  const second = new Index(fixtureDir);
  await second.ensure();
  assert.ok(second.graph.findSymbols('saveUser', { exact: true }).length === 1);
});

test('MCP stdio round-trip: tools list and calls work end-to-end', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'bin', 'codegraph-mcp.js'), '--root', fixtureDir]
  });
  const client = new Client({ name: 'smoke', version: '0.0.1' });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'analyze_impact',
      'file_skeleton',
      'find_callers',
      'find_symbol',
      'read_symbol',
      'recall_notes',
      'reindex',
      'repo_map',
      'save_note',
      'semantic_search',
      'usage_stats'
    ]);

    const findRes = await client.callTool({ name: 'find_symbol', arguments: { name: 'saveUser', exact: true } });
    assert.match(findRes.content[0].text, /src\/db\.js:1/);

    const readRes = await client.callTool({ name: 'read_symbol', arguments: { name: 'saveUser' } });
    assert.match(readRes.content[0].text, /validate\(user\) && persist\(user\)/);

    const skelRes = await client.callTool({ name: 'file_skeleton', arguments: { path: 'src/db.js' } });
    assert.match(skelRes.content[0].text, /saveUser/);
    assert.ok(!skelRes.content[0].text.includes('!!u.name'), 'skeleton must not contain bodies');

    const impactRes = await client.callTool({ name: 'analyze_impact', arguments: { name: 'saveUser' } });
    assert.match(impactRes.content[0].text, /registerRoutes/);

    const noteRes = await client.callTool({ name: 'save_note', arguments: { text: 'saveUser validates before persisting', tags: ['db'] } });
    assert.match(noteRes.content[0].text, /Saved note/);
    const recallRes = await client.callTool({ name: 'recall_notes', arguments: { query: 'how does saveUser work' } });
    assert.match(recallRes.content[0].text, /validates before persisting/);

    const statsRes = await client.callTool({ name: 'usage_stats', arguments: {} });
    assert.match(statsRes.content[0].text, /read_symbol: 1 call/);
    assert.match(statsRes.content[0].text, /tokens saved/);
  } finally {
    await client.close();
  }
});

test('semantic_search finds code by meaning (or falls back to keywords)', { timeout: 120_000 }, async () => {
  const { createServer } = await import('../src/server.js');
  const { server } = await createServer(fixtureDir);
  void server; // tools are exercised through direct module APIs below

  const { VectorStore, symbolItems, semanticSearch } = await import('../src/semantic.js');
  const { Index } = await import('../src/indexer.js');
  const index = new Index(fixtureDir);
  await index.ensure();
  const store = new VectorStore(fixtureDir);
  const { mode, results } = await semanticSearch(store, 'store a user record in the database', symbolItems(index.graph), 3);
  assert.ok(['semantic', 'keyword'].includes(mode));
  assert.ok(results.length > 0, 'expected at least one result');
  if (mode === 'semantic') {
    assert.ok(
      results.some((r) => ['saveUser', 'persist'].includes(r.item.sym.name)),
      `expected saveUser/persist in top results, got: ${results.map((r) => r.item.sym.name).join(', ')}`
    );
  }
});
