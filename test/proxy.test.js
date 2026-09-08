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

test('grounding: the newest human message gains repo facts; history stays byte-stable', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ground-'));
  try {
    fs.mkdirSync(path.join(dir, 'pay'));
    fs.writeFileSync(
      path.join(dir, 'pay', 'charge.py'),
      '"""Charge cards via the gateway."""\n\ndef charge(amount):\n    """Charge the given amount once."""\n    return amount\n'
    );
    const { Index } = await import('../src/indexer.js');
    const index = new Index(dir);
    await index.ensure();

    const { buildGroundingBlock, groundHistory } = await import('../src/ground.js');

    // exact-case symbol match -> fact with location and doc
    const block = buildGroundingBlock(index.graph, 'почини charge чтобы не падал');
    assert.match(block, /charge — function, pay\/charge\.py:3-5/);
    assert.match(block, /Charge the given amount once\./);
    // deterministic
    assert.equal(block, buildGroundingBlock(index.graph, 'почини charge чтобы не падал'));
    // wrong case / unknown identifiers -> no block
    assert.equal(buildGroundingBlock(index.graph, 'почини Charge пожалуйста'), null);
    assert.equal(buildGroundingBlock(index.graph, 'сделай красиво'), null);
    // file mentions ground too
    assert.match(buildGroundingBlock(index.graph, 'посмотри pay/charge.py'), /python, 1 symbols — Charge cards/);

    // fresh user turn (last message) gets the block...
    const memo = new Map();
    const turn1 = { messages: [{ role: 'user', content: 'почини charge' }] };
    const g1 = groundHistory(turn1, index.graph, memo);
    assert.ok(g1.addedChars > 0);
    assert.match(g1.body.messages[0].content, /codegraph context/);
    assert.equal(turn1.messages[0].content, 'почини charge', 'input not mutated');

    // ...and on the NEXT request (agentic loop appended messages) the same
    // turn re-attaches the identical bytes from the memo
    const turn2 = {
      messages: [
        { role: 'user', content: 'почини charge' },
        { role: 'assistant', content: [{ type: 'text', text: 'смотрю' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }] }
      ]
    };
    const g2 = groundHistory(turn2, index.graph, memo);
    assert.equal(g2.body.messages[0].content, g1.body.messages[0].content, 'history byte-stable');
    assert.equal(
      g2.body.messages[2].content[0].type, 'tool_result',
      'tool_result carriers are never grounded'
    );

    // an old human turn the proxy never grounded stays untouched (cache safety)
    const memo2 = new Map();
    const g3 = groundHistory(turn2, index.graph, memo2);
    assert.equal(g3.body.messages[0].content, 'почини charge', 'unknown history left alone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function bashPair(id, command, text) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] }
  ];
}

test('Bash cat / sed -n count as reads: stale cat becomes a skeleton, stale sed a stub', async () => {
  const { skeletonizeStaleReads, bashRead } = await import('../src/transforms.js');
  assert.deepEqual(bashRead('cat app/models.py'), { file: 'app/models.py', partial: null });
  assert.deepEqual(bashRead("sed -n '10,40p' app/models.py"), { file: 'app/models.py', partial: '10-40' });
  assert.equal(bashRead('cat app/models.py | wc -l'), null);
  assert.equal(bashRead('grep -rn foo app'), null);

  const fnBody = '    value = compute(x)\n    return value * 2\n';
  const v1 = `import os\n\n\ndef process(items):\n${fnBody.repeat(30)}\n\ndef helper(x):\n${fnBody.repeat(30)}`;
  const v2 = v1.replace('helper(x)', 'helper(x, y)');
  const chunk = fnBody.repeat(40);
  const body = {
    messages: [
      ...bashPair('b1', 'cat app/models.py', v1),
      ...bashPair('b2', "sed -n '10,40p' app/models.py", chunk),
      { role: 'assistant', content: [{ type: 'text', text: 'editing...' }] },
      ...bashPair('b3', 'cat app/models.py', v2)
    ]
  };
  const { body: out, count } = await skeletonizeStaleReads(body);
  assert.equal(count, 2);
  const staleCat = out.messages[1].content[0].content[0].text;
  assert.match(staleCat, /stale read of app\/models\.py/);
  assert.match(staleCat, /def process/);
  assert.ok(staleCat.length < v1.length / 3);
  const staleSed = out.messages[3].content[0].content[0].text;
  assert.match(staleSed, /stale partial read of app\/models\.py \(10-40\)/);
  assert.equal(out.messages[6].content[0].content[0].text, v2, 'newest read verbatim');
});

test('earlier runs of the same Bash command keep head and tail only', async () => {
  const { truncateStaleOutputs } = await import('../src/transforms.js');
  const log = (marker) => Array.from({ length: 200 }, (_, i) => `test line ${i} ${marker}`).join('\n');
  const body = {
    messages: [
      ...bashPair('t1', 'docker-compose run --rm web python manage.py test esum', log('run1')),
      ...bashPair('t2', 'sleep 60; tail -40 /tmp/tasks/abc.output', log('poll1')),
      ...bashPair('t3', 'tail -30 /tmp/tasks/abc.output', log('poll2')),
      ...bashPair('t4', 'docker-compose run --rm web python manage.py test esum', log('run2')),
      ...bashPair('t5', 'ls -la', log('once'))
    ]
  };
  const { body: out, savedChars, count } = truncateStaleOutputs(body);
  assert.equal(count, 2, 'first test run and first poll are cut');
  assert.ok(savedChars > 5000, `saved ${savedChars}`);
  const cut = out.messages[1].content[0].content[0].text;
  assert.match(cut, /earlier run of `docker-compose run/);
  assert.match(cut, /test line 0 run1/);
  assert.match(cut, /test line 199 run1/);
  assert.ok(!cut.includes('test line 100 run1'));
  assert.match(out.messages[3].content[0].content[0].text, /earlier run of `tail/);
  assert.equal(out.messages[5].content[0].content[0].text, log('poll2'), 'latest poll verbatim');
  assert.equal(out.messages[7].content[0].content[0].text, log('run2'), 'latest run verbatim');
  assert.equal(out.messages[9].content[0].content[0].text, log('once'), 'single run untouched');
  assert.equal(body.messages[1].content[0].content[0].text, log('run1'), 'input not mutated');
});

test('proxy health route answers locally and idle timeout closes the server', async () => {
  const { startProxy, proxyAlive, HEALTH_PATH } = await import('../src/proxy.js');
  const port = 3300 + Math.floor(Math.random() * 500);
  assert.equal(await proxyAlive(port), false);
  const server = await startProxy({ port, upstream: 'http://127.0.0.1:1', quiet: true, idleMs: 60_000 });
  try {
    assert.equal(await proxyAlive(port), true);
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    server.close();
  }
});
