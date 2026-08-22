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
