// Transparent local proxy between Claude Code and the Anthropic API —
// the ContextForge mechanism: savings are guaranteed by the wire layer,
// not by hoping the agent picks the right tools.
//
// Current transform: history deduplication. When the conversation contains
// several identical tool_result blocks (the same file read twice, the same
// command output repeated), every occurrence after the FIRST is replaced by a
// short stub. Keeping the first occurrence intact preserves the prompt-cache
// prefix, so this never costs a cache miss on old turns — only the new tail
// is rewritten.
//
// Auth headers pass through untouched (API key or OAuth alike). Anything the
// proxy cannot parse is forwarded verbatim.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MIN_DEDUP_CHARS = 400; // below this a stub saves nothing
const STUB = (n) =>
  `[codegraph-proxy: identical to an earlier tool result in this conversation (${n} chars elided; content unchanged)]`;

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  }
  return '';
}

function setBlockText(block, text) {
  if (typeof block.content === 'string') block.content = text;
  else if (Array.isArray(block.content)) block.content = [{ type: 'text', text }];
}

/**
 * Replaces repeated identical tool_result contents with stubs, keeping the
 * first occurrence. Mutates a deep-enough copy; returns {body, savedChars}.
 */
export function dedupeHistory(body) {
  if (!Array.isArray(body?.messages)) return { body, savedChars: 0 };
  const seen = new Set();
  let savedChars = 0;
  const messages = body.messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block?.type !== 'tool_result') return block;
      const text = blockText(block.content);
      if (text.length < MIN_DEDUP_CHARS) return block;
      if (!seen.has(text)) {
        seen.add(text);
        return block;
      }
      const copy = { ...block, content: block.content };
      setBlockText(copy, STUB(text.length));
      savedChars += text.length - blockText(copy.content).length;
      changed = true;
      return copy;
    });
    return changed ? { ...msg, content } : msg;
  });
  return { body: savedChars > 0 ? { ...body, messages } : body, savedChars };
}

class ProxyStats {
  constructor() {
    this.file = path.join(os.homedir(), '.codegraph', 'proxy-stats.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { since: new Date().toISOString(), requests: 0, charsSaved: 0 };
    }
  }

  record(savedChars, addedChars = 0) {
    this.data.requests++;
    this.data.charsSaved += savedChars;
    if (addedChars > 0) this.data.charsGrounded = (this.data.charsGrounded || 0) + addedChars;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      // best-effort
    }
  }

  summary() {
    const tok = Math.round(this.data.charsSaved / 4);
    const ground = Math.round((this.data.charsGrounded || 0) / 4);
    return (
      `${this.data.requests} request(s) proxied, ~${tok} input tokens deduplicated` +
      (ground > 0 ? `, ~${ground} tokens of grounding attached` : '') +
      ` since ${this.data.since.slice(0, 10)}`
    );
  }
}

/**
 * Full transform pipeline: ground the newest human message with facts from
 * the symbol graph, skeletonize stale reads, then dedupe identicals.
 * ctx = {graph, memo} enables grounding; without it the pipeline is
 * shrink-only (as in tests and older callers).
 */
export async function transformRequestBody(parsed, ctx = {}) {
  let grounded = parsed;
  let addedChars = 0;
  if (ctx.graph && ctx.memo) {
    const { groundHistory } = await import('./ground.js');
    const g = groundHistory(parsed, ctx.graph, ctx.memo);
    grounded = g.body;
    addedChars = g.addedChars;
  }
  const { skeletonizeStaleReads } = await import('./transforms.js');
  const skel = await skeletonizeStaleReads(grounded);
  const ded = dedupeHistory(skel.body);
  return { body: ded.body, savedChars: skel.savedChars + ded.savedChars, addedChars };
}

export function startProxy({ port = 3210, upstream = 'https://api.anthropic.com', quiet = false, root = null } = {}) {
  const stats = new ProxyStats();

  // Grounding needs the symbol graph. It loads lazily on the first request
  // and refreshes with the built-in throttle; any failure (no code, no
  // grammars) simply disables grounding — the proxy still shrinks.
  const memo = new Map();
  let indexPromise = null;
  const getGraph = async () => {
    if (!root) return null;
    if (!indexPromise) {
      indexPromise = (async () => {
        const { Index } = await import('./indexer.js');
        const ix = new Index(root);
        await ix.ensure();
        return ix;
      })().catch(() => null);
    }
    const ix = await indexPromise;
    if (!ix) return null;
    try {
      await ix.refresh({});
    } catch {
      // stale graph is still a valid graph
    }
    return ix.graph;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : null;
      let saved = 0;
      let added = 0;

      if (req.method === 'POST' && req.url.startsWith('/v1/messages') && bodyBuf) {
        try {
          const parsed = JSON.parse(bodyBuf.toString('utf8'));
          const result = await transformRequestBody(parsed, { graph: await getGraph(), memo });
          saved = result.savedChars;
          added = result.addedChars || 0;
          if (saved > 0 || added > 0) bodyBuf = Buffer.from(JSON.stringify(result.body));
        } catch {
          // not JSON we understand — forward verbatim
        }
      }

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      // fetch manages these itself; a stale value breaks the forward
      delete headers.host;
      delete headers['content-length'];
      delete headers['accept-encoding'];
      delete headers.connection;

      const upstreamRes = await fetch(upstream + req.url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf
      });

      const resHeaders = {};
      for (const [k, v] of upstreamRes.headers.entries()) {
        // fetch already decompressed the body; length/encoding no longer apply
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) continue;
        resHeaders[k] = v;
      }
      res.writeHead(upstreamRes.status, resHeaders);
      if (upstreamRes.body) {
        for await (const chunk of upstreamRes.body) res.write(chunk);
      }
      res.end();

      stats.record(saved, added);
      if (!quiet && (saved > 0 || added > 0)) {
        const parts = [];
        if (saved > 0) parts.push(`deduplicated ~${Math.round(saved / 4)} input tokens`);
        if (added > 0) parts.push(`grounded the prompt with repo facts (+${Math.round(added / 4)} tokens)`);
        console.error(`[codegraph-proxy] ${parts.join('; ')}`);
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(e.message || e) } }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      if (!quiet) {
        console.error(`[codegraph-proxy] listening on http://127.0.0.1:${port} -> ${upstream}`);
        console.error(`[codegraph-proxy] ${stats.summary()}`);
      }
      resolve(server);
    });
  });
}
