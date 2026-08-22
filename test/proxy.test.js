import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const bigRead = (marker) =>
  `File: src/app.js (${marker})\n` + 'const x = 1;\n'.repeat(60); // > 400 chars

function toolResultMsg(text, id) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }]
  };
}

test('dedupeHistory elides later duplicates, keeps the first occurrence', async () => {
  const { dedupeHistory } = await import('../src/proxy.js');
  const text = bigRead('same');
  const body = {
    model: 'claude-sonnet-5',
    messages: [
      toolResultMsg(text, 't1'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      toolResultMsg(text, 't2'),
      toolResultMsg(bigRead('different'), 't3'),
      toolResultMsg('short', 't4')
    ]
  };
  const { body: out, savedChars } = dedupeHistory(body);
  assert.ok(savedChars > 500, `expected real savings, got ${savedChars}`);
  const texts = out.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content[0].content)
    .map((c) => (typeof c === 'string' ? c : c[0].text));
  assert.equal(texts[0], text, 'first occurrence kept verbatim');
  assert.match(texts[1], /codegraph-proxy: identical/, 'second occurrence stubbed');
  assert.equal(texts[2], bigRead('different'), 'unique content untouched');
  assert.equal(texts[3], 'short', 'small blocks untouched');
  // original object not mutated
  assert.equal(body.messages[2].content[0].content[0].text, text);
});

const numbered = (src) =>
  src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(6)}→${l}`)
    .join('\n');

function readPair(id, filePath, text) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: filePath } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] }
  ];
}

test('stale Read results become AST skeletons; the newest read stays verbatim', async () => {
  const { skeletonizeStaleReads } = await import('../src/transforms.js');
  const fnBody = '  const data = load();\n  return data.map((d) => d * 2);\n';
  const v1 = `import { load } from './load.js';\nexport function process(items) {\n${fnBody.repeat(20)}}\nfunction helper(x) {\n${fnBody.repeat(20)}}\n`;
  const v2 = v1.replace('helper(x)', 'helper(x, y)');
  const body = {
    messages: [
      ...readPair('r1', 'C:\\proj\\src\\logic.js', numbered(v1)),
      { role: 'assistant', content: [{ type: 'text', text: 'editing...' }] },
      ...readPair('r2', 'C:\\proj\\src\\logic.js', numbered(v2)),
      ...readPair('r3', 'C:\\proj\\notes.txt', 'line\n'.repeat(400))
    ]
  };
  const { body: out, savedChars, count } = await skeletonizeStaleReads(body);
  assert.equal(count, 1, 'only the stale duplicate-file read is transformed');
  assert.ok(savedChars > 1000, `expected big savings, got ${savedChars}`);

  const staleText = out.messages[1].content[0].content[0].text;
  assert.match(staleText, /codegraph-proxy: stale read/, 'stale read replaced');
  assert.match(staleText, /function process/, 'skeleton keeps signatures');
  assert.ok(!staleText.includes('d.map((d) => d * 2)') || staleText.length < numbered(v1).length / 3, 'bodies dropped');

  const freshText = out.messages[4].content[0].content[0].text;
  assert.equal(freshText, numbered(v2), 'newest read untouched');
  const otherFile = out.messages[6].content[0].content[0].text;
  assert.equal(otherFile, 'line\n'.repeat(400), 'single-read files untouched');
  assert.equal(body.messages[1].content[0].content[0].text, numbered(v1), 'input not mutated');
});

test('pipeline: identical repeats go to dedup, changed repeats to skeletons', async () => {
  const { transformRequestBody } = await import('../src/proxy.js');
  const same = numbered('const a = 1;\n'.repeat(100));
  const body = {
    messages: [
      ...readPair('i1', '/p/same.js', same),
      ...readPair('i2', '/p/same.js', same)
    ]
  };
  const { body: out, savedChars } = await transformRequestBody(body);
  assert.ok(savedChars > 500);
  const first = out.messages[1].content[0].content[0].text;
  const second = out.messages[3].content[0].content[0].text;
  assert.equal(first, same, 'identical case: FIRST copy stays verbatim (dedup semantics)');
  assert.match(second, /identical to an earlier tool result/, 'later identical copy stubbed');
  assert.ok(!second.includes('stale read'), 'skeletonizer skipped the identical pair');
});

test('proxy forwards requests with dedup, streams responses, passes auth', async () => {
  const { startProxy, dedupeHistory } = await import('../src/proxy.js');
  void dedupeHistory;

  let received = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => {
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      }, 20);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const proxy = await startProxy({ port: 0, upstream: `http://127.0.0.1:${upstreamPort}`, quiet: true });
  const proxyPort = proxy.address().port;

  try {
    const text = bigRead('dup');
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-123', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        stream: true,
        messages: [toolResultMsg(text, 'a'), { role: 'assistant', content: 'ok' }, toolResultMsg(text, 'b')]
      })
    });
    assert.equal(res.status, 200);
    const sse = await res.text();
    assert.match(sse, /message_start/);
    assert.match(sse, /message_stop/, 'stream fully forwarded');

    assert.equal(received.headers['x-api-key'], 'sk-test-123', 'auth passes through');
    const upstreamTexts = received.body.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content[0].content)
      .map((c) => (typeof c === 'string' ? c : c[0].text));
    assert.equal(upstreamTexts[0], text, 'first read reaches the API in full');
    assert.match(upstreamTexts[1], /codegraph-proxy: identical/, 'duplicate reaches the API deduplicated');
  } finally {
    proxy.close();
    upstream.close();
  }
});
