# codegraph-mcp

Local MCP server that gives Claude Code (CLI **and** the VS Code extension) a
queryable model of your codebase — where things are defined, who calls what,
what depends on what, and what was decided in earlier sessions. Without it the
agent rediscovers your architecture every session through grep and
file-by-file reading; with it, structural questions get structural answers:

- **Safer changes** — before touching a function the agent sees its blast
  radius (`analyze_impact`), every call site (`find_callers`), every mention
  (`find_references`) and every dependent module (`who_imports`), instead of
  editing whatever grep happened to surface.
- **Faster orientation** — one `repo_map` call maps the project by import
  centrality; `find_symbol` and `semantic_search` ("where is auth token
  validated") land directly on the right code.
- **Continuity** — `save_note` / `recall_notes` carry decisions and gotchas
  across sessions, per repository.
- **Cheaper exploration** — as a consequence of the above the agent reads
  signatures instead of whole files (`file_skeleton`, `read_symbol`), and a
  transparent proxy compresses conversation history at the wire level.
  `usage_stats` reports the measured savings.

**100% portable**: pure JavaScript + WASM grammars. No node-gyp, no native
compilation. `npm install` works identically on Windows, macOS and Linux.

## Tools exposed to the agent

**Understanding & navigation**

| Tool | What it does |
|---|---|
| `repo_map` | Project map: languages, counts, key files by import centrality; `html=true` writes an interactive architecture map |
| `find_symbol` | Locate a function/class/method/type definition by name, repo-wide |
| `semantic_search` | Find code/notes **by meaning** ("where is auth token validated") |

**Change safety**

| Tool | What it does |
|---|---|
| `analyze_impact` | Transitive callers (blast radius) before changing a function |
| `find_references` | Every mention of an identifier — call sites marked `[call]` — with the enclosing symbol |
| `who_imports` | Direct dependents of a module (reverse import graph) |

**Focused reading**

| Tool | What it does |
|---|---|
| `file_skeleton` | Imports + all signatures of a file, no bodies (10–50× fewer tokens) |
| `read_symbol` | Read the full source of *one* symbol without reading the file |

**Memory & operations**

| Tool | What it does |
|---|---|
| `save_note` / `recall_notes` | Persistent per-repo notes that survive sessions |
| `reindex` | Force incremental or full re-scan |
| `usage_stats` | Calls per tool + tokens saved; `dashboard=true` also writes the HTML report |

Supported languages: JavaScript, TypeScript, TSX, Python, Go, Rust, Java,
Ruby, C, C++, C#, PHP, GDScript. Files the indexer cannot extract are counted
and reported by `repo_map`, so partial coverage is always visible.

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
guidance ("run `analyze_impact` before changing a function, `find_symbol`
instead of grep, `file_skeleton` before reading a file, …") through the MCP
`instructions` field, which Claude Code injects into the agent's context
automatically on connect. Install, register, done.

## Transparent proxy (guaranteed savings)

The MCP tools above save tokens only when the agent chooses to use them. The
proxy layer works the other way — like ContextForge, it sits between Claude
Code and the Anthropic API and compresses traffic **regardless of agent
behavior**:

- **History deduplication**: when the conversation contains identical
  tool results (the same file read twice, repeated command output), every
  occurrence after the first is replaced with a short stub before the request
  leaves your machine. The first occurrence stays verbatim, so the model
  loses nothing it could actually use — and the prompt-cache prefix is
  preserved (only the new tail is ever rewritten, so dedup never causes
  cache misses on old turns).
- **Stale-read skeletonization**: when a file was read, edited, and read
  again, the older full copy in history is replaced by its tree-sitter
  signature skeleton (imports + declarations with line ranges); the newest
  read always stays verbatim. Non-code files fall back to head+tail
  truncation. Transforms are pure functions of the content, so repeated
  requests produce identical bytes and the prompt cache re-stabilizes after
  a single rewrite.
- Auth headers pass through untouched (API key or OAuth). Anything the proxy
  cannot parse is forwarded verbatim. Streaming (SSE) is piped through.

```bash
codegraph-mcp wrap                 # like 'cf wrap claude': proxy + claude in one command
codegraph-mcp proxy --port 3210    # or run the proxy standalone
```

For the VS Code extension, run the proxy and point the extension at it via
project or global settings:

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:3210" } }
```

Cumulative savings are tracked in `~/.codegraph/proxy-stats.json` and printed
on proxy start.

## CLI usage

```bash
node bin/codegraph-mcp.js index                # index cwd, print stats
node bin/codegraph-mcp.js index --root ~/proj  # index another directory
node bin/codegraph-mcp.js dashboard            # HTML report, opens in browser
node bin/codegraph-mcp.js map                  # interactive architecture map
node bin/codegraph-mcp.js                      # start stdio MCP server (cwd)
```

The architecture map (`.codegraph/map.html`) is a layered, C4-style view of
the repo, fully derived from the index:

- **Overview** — subsystem cards (top-level directories) with weighted import
  edges between them, plus auto-derived starting points (hub, entry point,
  largest module);
- **Subsystem** — the files of one directory with their import edges and
  collapsed neighbor subsystems; click a file to trace dependents and
  dependencies, click again to drill in;
- **File** — its symbols with intra-file call arrows, importers and imports
  as navigable columns.

Every level narrates *purpose*, not just structure: descriptions are pulled
from the code's own documentation — module docstrings and header comments for
files and symbols, READMEs / `__init__.py` / `index.*` for folders and the
repo itself — and shown on folder cards, in tooltips and in the side panel.

Levels are deep-linkable (`#d=src`, `#f=src/proxy.js`), search with `/`,
`Esc` goes up a level, drag pans, wheel zooms. Self-contained HTML, offline.

The dashboard (`--no-open` to just write the file) lands in
`.codegraph/dashboard.html`: token savings, per-tool usage, indexed languages
and the most-imported files. Static HTML, no server, light/dark aware. The
agent can also generate it on request via `usage_stats` with `dashboard=true`.

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
