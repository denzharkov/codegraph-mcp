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
  // the spawned MCP server may release .codegraph/* handles slightly after
  // client.close() on Windows — retry instead of failing teardown
  fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    const instructions = client.getInstructions();
    assert.ok(instructions && instructions.includes('file_skeleton'), 'server must ship usage instructions via MCP');

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'analyze_impact',
      'file_skeleton',
      'find_references',
      'find_symbol',
      'read_symbol',
      'recall_notes',
      'reindex',
      'repo_map',
      'save_note',
      'semantic_search',
      'usage_stats',
      'who_imports'
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

    const refsRes = await client.callTool({ name: 'find_references', arguments: { name: 'saveUser' } });
    const refsText = refsRes.content[0].text;
    assert.match(refsText, /src\/db\.js:1.*\[definition\]/, 'definition marked');
    assert.match(refsText, /src\/api\.js:1/, 'import line found');
    assert.match(refsText, /in function createUserHandler.*\[call\]/, 'call site marked with enclosing symbol');

    const whoRes = await client.callTool({ name: 'who_imports', arguments: { path: 'src/api.js' } });
    assert.match(whoRes.content[0].text, /src\/routes\.js/);

    const mapRes = await client.callTool({ name: 'repo_map', arguments: {} });
    assert.match(mapRes.content[0].text, /src\/db\.js \[imported by 1\]/);

    const noteRes = await client.callTool({ name: 'save_note', arguments: { text: 'saveUser validates before persisting', tags: ['db'] } });
    assert.match(noteRes.content[0].text, /Saved note/);
    const recallRes = await client.callTool({ name: 'recall_notes', arguments: { query: 'how does saveUser work' } });
    assert.match(recallRes.content[0].text, /validates before persisting/);

    // every tool must accept its minimal argument set without a protocol
    // error — the exact failure mode a user hit with argless recall_notes
    const minimalArgs = {
      repo_map: {},
      find_symbol: { name: 'saveUser' },
      read_symbol: { name: 'saveUser' },
      file_skeleton: { path: 'src/db.js' },
      semantic_search: { query: 'save user' },
      find_references: { name: 'saveUser' },
      who_imports: { path: 'src/api.js' },
      analyze_impact: { name: 'saveUser' },
      reindex: {},
      save_note: { text: 'minimal-args sweep note' },
      recall_notes: {},
      usage_stats: {}
    };
    for (const t of tools.tools) {
      assert.ok(Object.hasOwn(minimalArgs, t.name), `no minimal-args case for new tool "${t.name}" — add one`);
      let r;
      try {
        // generous timeout: semantic_search may cold-load the embedding model
        r = await client.callTool({ name: t.name, arguments: minimalArgs[t.name] }, undefined, { timeout: 120_000 });
      } catch (e) {
        assert.fail(`${t.name} raised a protocol error on minimal args: ${e.message}`);
      }
      assert.ok(!r.isError, `${t.name} failed on minimal args: ${r.content?.[0]?.text}`);
    }

    // an INCOMPLETE call must come back as a readable tool result the agent
    // can react to, never as a raw -32602 protocol error
    const incomplete = await client.callTool({ name: 'find_symbol', arguments: {} });
    assert.equal(incomplete.isError, true);
    assert.match(incomplete.content[0].text, /Missing required parameter "name"/);

    // recency contract: the newest note comes back FIRST on an argless call
    await client.callTool({ name: 'save_note', arguments: { text: 'ordering probe: newest note wins' } });
    const argless = await client.callTool({ name: 'recall_notes', arguments: {} });
    const firstBlock = argless.content[0].text.split('\n\n')[0];
    assert.match(firstBlock, /ordering probe: newest note wins/, 'argless recall must list the newest note first');

    const statsRes = await client.callTool({ name: 'usage_stats', arguments: {} });
    // exact counts guard against double-recording in the registerTool wrapper:
    // each of these ran once in the explicit section and once in the sweep
    // (the incomplete find_symbol call above is rejected before recording)
    assert.match(statsRes.content[0].text, /read_symbol: 2 call/);
    assert.match(statsRes.content[0].text, /find_symbol: 2 call/);
    assert.match(statsRes.content[0].text, /analyze_impact: 2 call/);
    assert.match(statsRes.content[0].text, /tokens saved/);
    assert.ok(!statsRes.content[0].text.includes('usage_stats:'), 'usage_stats must not record itself');

    const dashRes = await client.callTool({ name: 'usage_stats', arguments: { dashboard: true } });
    assert.match(dashRes.content[0].text, /dashboard\.html/, 'dashboard=true returns the report path');

    const mapHtmlRes = await client.callTool({ name: 'repo_map', arguments: { html: true } });
    assert.match(mapHtmlRes.content[0].text, /map\.html/, 'repo_map html=true returns the map path');
  } finally {
    await client.close();
  }
});

test('notes: two sessions share one store without lost updates; malformed entries never crash', async () => {
  const { Notes } = await import('../src/memory.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-notes-'));
  try {
    const sessionA = new Notes(dir);
    const sessionB = new Notes(dir);
    sessionA.add('decision from session A');
    sessionB.add('decision from session B'); // must NOT clobber A's note
    const fresh = new Notes(dir);
    const all = fresh.recall('', 10);
    assert.equal(all.length, 2, 'both sessions notes survive');
    assert.match(all[0].text, /session B/, 'newest first');

    // hand-edited / old-schema rows are normalized away or repaired, not fatal
    fs.writeFileSync(
      path.join(dir, '.codegraph', 'notes.json'),
      JSON.stringify([{ text: 'ok note' }, { id: 5 }, { text: 'tagged', tags: 'oops', createdAt: null }, 'garbage'])
    );
    const c = new Notes(dir);
    const recalled = c.recall('', 10);
    assert.equal(recalled.length, 2, 'entries without text are dropped');
    for (const n of recalled) {
      assert.equal(typeof n.createdAt, 'string');
      assert.ok(Array.isArray(n.tags));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('gdscript extractor finds funcs, signals, classes and calls', async () => {
  const { extractFile } = await import('../src/extract.js');
  const src = [
    'extends CharacterBody2D',
    'class_name Player',
    '',
    'signal died(cause)',
    '@export var speed := 300.0',
    'var _health = 100',
    '',
    'func _ready():',
    '\tconnect_signals()',
    '',
    'func take_damage(amount):',
    '\t_health -= amount',
    '\tif _health <= 0:',
    '\t\tdied.emit("hp")',
    '',
    'class Inventory:',
    '\tfunc add_item(item):',
    '\t\tpass',
    ''
  ].join('\n');
  const r = await extractFile('gdscript', src);
  const byName = Object.fromEntries(r.symbols.map((s) => [s.name, s]));
  assert.equal(byName.Player.kind, 'class');
  assert.equal(byName.died.kind, 'signal');
  assert.equal(byName.speed.kind, 'var');
  assert.equal(byName.take_damage.kind, 'function');
  assert.equal(byName.take_damage.endLine, 14, 'indentation block extent');
  assert.equal(byName.add_item.parent, 'Inventory');
  assert.ok(r.calls.some((c) => c.callee === 'connect_signals'), 'call edge found');
  assert.ok(r.imports.includes('extends CharacterBody2D'));
  assert.equal(byName._health.exported, false);
});

test('python src-layout: package imports resolve through the source root', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-srclayout-'));
  try {
    const write = (rel, content) => {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    };
    write('src/mypkg/__init__.py', '');
    write('src/mypkg/db.py', 'class Database:\n    def connect(self):\n        return True\n');
    write('src/mypkg/main.py', 'from mypkg.db import Database\n\ndef run():\n    return Database()\n');
    const { Index } = await import('../src/indexer.js');
    const { buildReverseImports } = await import('../src/imports.js');
    const index = new Index(dir);
    await index.ensure();
    const rev = buildReverseImports(index.graph);
    const dependents = rev.get('src/mypkg/db.py');
    assert.ok(dependents && dependents.has('src/mypkg/main.py'), 'main.py -> db.py edge resolved through src/ root');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('js extractor captures dynamic import() and require() as imports', async () => {
  const { extractFile } = await import('../src/extract.js');
  const src = "import fs from 'fs';\nasync function load() {\n  const { Index } = await import('../src/indexer.js');\n  const legacy = require('./legacy.js');\n  return new Index(legacy);\n}\n";
  const r = await extractFile('javascript', src);
  assert.ok(r.imports.includes('fs'), 'static import');
  assert.ok(r.imports.includes('../src/indexer.js'), 'dynamic import()');
  assert.ok(r.imports.includes('./legacy.js'), 'require()');
  assert.ok(!r.calls.some((c) => c.callee === 'require'), 'require not misfiled as a call');
});

test('architecture map embeds the import graph as self-contained HTML', async () => {
  const { generateArchMap, collectMapData } = await import('../src/archmap.js');
  const data = await collectMapData(fixtureDir);
  assert.ok(data.nodes.some((n) => n.id === 'src/db.js'), 'file nodes present');
  assert.ok(
    data.edges.some((e) => e[0] === 'src/api.js' && e[1] === 'src/db.js'),
    'import edge api.js -> db.js present'
  );
  const html = await generateArchMap(fixtureDir);
  assert.match(html, /Codegraph Map/);
  assert.match(html, /src\/db\.js/);
  assert.ok(!/src=["']https?:|href=["']https?:/.test(html), 'no external assets');
});

test('dashboard renders usage stats and central files', async () => {
  const { generateDashboard } = await import('../src/dashboard.js');
  const html = await generateDashboard(fixtureDir);
  assert.match(html, /Codegraph Dashboard/);
  assert.match(html, /tokens saved vs full-file reads/);
  assert.match(html, /javascript/);
  assert.match(html, /src\/api\.js/, 'central files table lists imported module');
  assert.ok(!html.includes('<script'), 'dashboard must be static HTML');
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
