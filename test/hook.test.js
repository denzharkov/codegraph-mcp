import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root;
let ctx;

const event = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: root });

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hook-'));
  const write = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const bigBody = Array.from({ length: 400 }, (_, i) => `    x${i} = ${i}`).join('\n');
  write('app/models.py', `class Device:\n    def playlist(self):\n        return None\n\n\ndef build_grid():\n${bigBody}\n`);
  write('app/small.py', 'def tiny():\n    return 1\n');
  write('app/notes.txt', Array(500).fill('plain text').join('\n') + '\n');

  const { Index } = await import('../src/indexer.js');
  const index = new Index(root);
  await index.ensure();
  index.graph.save();

  const { loadIndex } = await import('../src/hook.js');
  ctx = { root, cwd: root, index: loadIndex(root), minLines: 300 };
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('Read of a whole large indexed file is denied, targeted and small reads pass', async () => {
  const { decide } = await import('../src/hook.js');
  const big = path.join(root, 'app', 'models.py');
  const reason = decide(event('Read', { file_path: big }), ctx);
  assert.ok(reason && reason.includes('file_skeleton("app/models.py")'), reason);
  assert.equal(decide(event('Read', { file_path: big, offset: 10, limit: 40 }), ctx), null);
  assert.equal(decide(event('Read', { file_path: path.join(root, 'app', 'small.py') }), ctx), null);
  assert.equal(decide(event('Read', { file_path: path.join(root, 'app', 'notes.txt') }), ctx), null);
  assert.equal(decide(event('Read', { file_path: '/etc/hosts' }), ctx), null);
});

test('cat of a large indexed file is denied, sed ranges and pipes pass', async () => {
  const { decide } = await import('../src/hook.js');
  assert.ok(decide(event('Bash', { command: 'cat app/models.py' }), ctx));
  assert.ok(decide(event('Bash', { command: 'ls && cat app/models.py; echo done' }), ctx));
  assert.equal(decide(event('Bash', { command: 'cat app/models.py | wc -l' }), ctx), null);
  assert.equal(decide(event('Bash', { command: 'sed -n 1,40p app/models.py' }), ctx), null);
  assert.equal(decide(event('Bash', { command: 'cat app/small.py' }), ctx), null);
});

test('recursive grep for a known identifier is denied, regex and unknown names pass', async () => {
  const { decide } = await import('../src/hook.js');
  const reason = decide(event('Bash', { command: 'grep -rn build_grid app' }), ctx);
  assert.ok(reason && reason.includes('find_symbol("build_grid")'), reason);
  assert.ok(decide(event('Bash', { command: 'grep -rn --include="*.py" -e Device .' }), ctx));
  assert.ok(decide(event('Bash', { command: 'rg "\\bDevice\\b" app | head' }), ctx));
  assert.ok(decide(event('Bash', { command: 'grep -n playlist app' }), ctx), 'directory target implies recursion');
  assert.equal(decide(event('Bash', { command: 'grep -n playlist app/models.py' }), ctx), null);
  assert.equal(decide(event('Bash', { command: 'grep -rn "def build" app' }), ctx), null);
  assert.equal(decide(event('Bash', { command: 'grep -rn not_a_symbol app' }), ctx), null);
  assert.equal(decide(event('Bash', { command: 'grep -rn TODO app' }), ctx), null);
});

test('hook script: deny decision on stdout, silence outside an indexed repo', () => {
  const run = (payload) =>
    spawnSync(process.execPath, [path.join(projectRoot, 'bin', 'codegraph-hook.js')], {
      input: JSON.stringify(payload),
      encoding: 'utf8'
    });
  const denied = run(event('Read', { file_path: path.join(root, 'app', 'models.py') }));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');

  const outside = run({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, cwd: os.tmpdir() });
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, '');

  const garbage = spawnSync(process.execPath, [path.join(projectRoot, 'bin', 'codegraph-hook.js')], {
    input: 'not json',
    encoding: 'utf8'
  });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, '');
});

test('install/uninstall edit settings.json without touching other hooks', async () => {
  const { installHook, uninstallHook } = await import('../src/hook.js');
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'lint' }] }] } })
  );
  installHook(file, 'node /x/codegraph-hook.js');
  installHook(file, 'node /y/codegraph-hook.js');
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, 'node /y/codegraph-hook.js');

  uninstallHook(file);
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: 'Write', hooks: [{ type: 'command', command: 'lint' }] }]);

  const fresh = path.join(root, 'fresh', 'settings.json');
  installHook(fresh, 'node /x/codegraph-hook.js');
  uninstallHook(fresh);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), {});
});

test('evals/hook-evals.json all pass against the fixture', async () => {
  const { runEvals } = await import('../evals/run.js');
  const results = await runEvals();
  const failed = results.filter((r) => !r.ok);
  assert.deepEqual(failed, [], failed.map((r) => `${r.name}: expected ${r.expect}, got ${r.got}`).join('\n'));
  assert.ok(results.length >= 30);
});

test('bench: skeleton and symbol are cheaper than the whole file', async () => {
  const { runBench, formatBench } = await import('../src/bench.js');
  const { fixtureRoot } = await import('../evals/run.js');
  const result = await runBench(fixtureRoot, { minLines: 300 });
  const models = result.top.find((r) => r.file === 'app/models.py');
  assert.ok(models, 'fixture file must be measured');
  assert.ok(models.skeletonTokens < models.fileTokens / 2, `${models.skeletonTokens} vs ${models.fileTokens}`);
  assert.ok(models.medianSymbolTokens < models.fileTokens / 4);
  assert.equal(result.aboveThreshold.files, 1);
  assert.ok(result.aboveThreshold.skeletonSavedPct > 50);
  assert.ok(formatBench(result).includes('app/models.py'));
});
