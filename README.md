# codegraph-mcp

Local MCP server that gives Claude Code (CLI **and** the VS Code extension) a
tree-sitter symbol graph of your repository: instant symbol lookup, compact
file skeletons, call-site and impact analysis, and persistent project notes —
so the agent reads *signatures* instead of whole files and spends far fewer
tokens exploring your codebase.

**100% portable**: pure JavaScript + WASM grammars. No node-gyp, no native
compilation. `npm install` works identically on Windows, macOS and Linux.

## Tools exposed to the agent

| Tool | What it does |
|---|---|
| `repo_map` | Overview: languages, counts, key files with their exported symbols |
| `find_symbol` | Locate a function/class/method/type definition by name, repo-wide |
| `read_symbol` | Read the full source of *one* symbol without reading the file |
| `file_skeleton` | Imports + all signatures of a file, no bodies (10–50× fewer tokens) |
| `find_callers` | Every call site of a symbol, with the enclosing caller |
| `analyze_impact` | Transitive callers (blast radius) before changing a function |
| `reindex` | Force incremental or full re-scan |
| `semantic_search` | Find code/notes **by meaning** ("where is auth token validated") |
| `save_note` / `recall_notes` | Persistent per-repo notes that survive sessions |
| `usage_stats` | Calls per tool + conservative estimate of tokens saved |

Supported languages: JavaScript, TypeScript, TSX, Python, Go, Rust, Java,
Ruby, C, C++, C#, PHP.

## Install

Requires Node.js ≥ 20 and Claude Code. Identical on Windows / macOS / Linux:

```bash
git clone https://github.com/denzharkov/codegraph-mcp
cd codegraph-mcp && npm install
node bin/codegraph-mcp.js install     # registers in Claude Code (user scope)
```

That's it — the `install` command runs `claude mcp add` for you, and the
server works in the CLI **and** the VS Code extension (they share MCP
configuration). Verify with `claude mcp list` or `/mcp` inside Claude Code.

The server indexes **the directory it is started in** (Claude Code starts MCP
servers in the project directory), or the path given via `--root` /
`CODEGRAPH_ROOT`. To limit it to a single project instead of user scope, add
`.mcp.json` to that project:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "node",
      "args": ["/absolute/path/to/codegraph-mcp/bin/codegraph-mcp.js"]
    }
  }
}
```

To remove: `node bin/codegraph-mcp.js uninstall`.

## Zero configuration

No `CLAUDE.md` edits or prompt tweaks are needed: the server ships its usage
guidance ("prefer `file_skeleton` over reading files, `find_symbol` over
grep, …") through the MCP `instructions` field, which Claude Code injects
into the agent's context automatically on connect. Install, register, done.

## CLI usage

```bash
node bin/codegraph-mcp.js index                # index cwd, print stats
node bin/codegraph-mcp.js index --root ~/proj  # index another directory
node bin/codegraph-mcp.js                      # start stdio MCP server (cwd)
```

## How it works

- Files are parsed with tree-sitter **WASM** grammars (`tree-sitter-wasms`
  package) via `web-tree-sitter` — no platform-specific binaries.
- The extractor walks each AST once, collecting definitions, call edges and
  imports per language spec ([src/languages.js](src/languages.js)).
- The graph persists to `.codegraph/index.json` inside the target repo;
  refreshes are incremental (mtime+size) and throttled, so queries stay fast.
- `node_modules`, build output, vendored and minified files are skipped;
  simple root `.gitignore` patterns are honored.
- `semantic_search` uses a local embedding model (all-MiniLM-L6-v2 via
  transformers.js, an *optional* dependency). On first use it downloads
  ~25 MB into `~/.codegraph/models` and caches symbol vectors per repo in
  `.codegraph/vectors.bin`. Offline or without the dependency it silently
  falls back to keyword search — everything else works regardless.

Add `.codegraph/` to your project's `.gitignore` (it's a cache plus your
private notes).

## License

MIT
