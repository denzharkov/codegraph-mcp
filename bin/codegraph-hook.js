#!/usr/bin/env node
// Claude Code PreToolUse hook entry. Reads the event from stdin, prints a
// deny decision when codegraph can answer better, stays silent otherwise.
// Registered in ~/.claude/settings.json by `codegraph-mcp install`.
import process from 'node:process';
import { runHook } from '../src/hook.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let event;
try {
  event = JSON.parse(raw);
} catch {
  process.exit(0);
}

let out = null;
try {
  out = runHook(event);
} catch {
  process.exit(0);
}
if (out) process.stdout.write(JSON.stringify(out));
