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
| `save_note` / `recall_notes` | Persistent per-repo notes that survive sessions |

Supported languages: JavaScript, TypeScript, TSX, Python, Go, Rust, Java,
Ruby, C, C++, C#, PHP.

## Install

Requires Node.js ≥ 20.

```bash
git clone <this repo> codegraph-mcp   # or copy the folder
cd codegraph-mcp
npm install
npm test          # optional: 4 smoke tests incl. full MCP round-trip
```

## Hook up to Claude Code

The server indexes **the directory it is started in** (Claude Code starts MCP
servers in the project directory), or the path given via `--root` /
`CODEGRAPH_ROOT`.

### Per project (recommended — works in CLI *and* VS Code extension)

Add `.mcp.json` to the project root:

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

On Windows use e.g. `"C:/Users/you/codegraph-mcp/bin/codegraph-mcp.js"`
(forward slashes are fine).

### For all projects (user scope)

```bash
claude mcp add codegraph -s user -- node /absolute/path/to/codegraph-mcp/bin/codegraph-mcp.js
```

Both registrations are picked up by the VS Code extension automatically — it
reads the same MCP configuration as the CLI. Check with `/mcp` inside Claude
Code.

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

Add `.codegraph/` to your project's `.gitignore` (it's a cache plus your
private notes).

## License

MIT
