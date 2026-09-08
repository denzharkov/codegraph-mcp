#!/usr/bin/env node
// Runs evals/hook-evals.json against evals/fixture through the real decision
// function. Add a case whenever the hook wrongly blocks or passes a command
// seen in practice; `npm test` runs the same file.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Index } from '../src/indexer.js';
import { decide, loadIndex } from '../src/hook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = path.join(here, 'fixture');

export async function runEvals() {
  const index = new Index(fixtureRoot);
  await index.ensure();
  index.graph.save();
  const ctx = { root: fixtureRoot, cwd: fixtureRoot, index: loadIndex(fixtureRoot), minLines: 300 };

  const cases = JSON.parse(fs.readFileSync(path.join(here, 'hook-evals.json'), 'utf8'));
  return cases.map((c) => {
    const input = { ...c.input };
    if (input.file_path && !path.isAbsolute(input.file_path)) input.file_path = path.join(fixtureRoot, input.file_path);
    const reason = decide({ tool_name: c.tool, tool_input: input, cwd: fixtureRoot }, ctx);
    const got = reason ? 'deny' : 'pass';
    let ok = got === c.expect;
    if (ok && c.mentions && !reason.includes(c.mentions)) ok = false;
    return { name: c.name, expect: c.expect, got, ok, reason };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await runEvals();
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.expect.padEnd(4)}  ${r.name}${r.ok ? '' : `  (got ${r.got}${r.reason ? `: ${r.reason}` : ''})`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
