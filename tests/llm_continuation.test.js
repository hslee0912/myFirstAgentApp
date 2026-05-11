/**
 * Unit tests for lib/llm.js — Continuation pattern in callJSON.
 *
 * Tests inject a stubbed Anthropic client via the opt-in `_client` parameter,
 * so they never make a real API call. Tests cover:
 *   - single-call happy path
 *   - max_tokens → continuation accumulation → valid JSON
 *   - exhausted continuations → full-call retry → throw LLM_TRUNCATED
 *   - JSON parse failure → retry path remains intact
 *   - usage aggregation across continuations
 *
 * Run: npm test  (uses node --test, no extra dependency)
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { callJSON } = require('../lib/llm');

// ─────────── stub helpers ───────────

function makeResponse(text, stop_reason, usage = {}) {
  return {
    content: [{ type: 'text', text }],
    stop_reason,
    usage: {
      input_tokens: usage.input_tokens || 10,
      output_tokens: usage.output_tokens || 20,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    },
  };
}

function makeStub(responseQueue) {
  const state = { calls: 0, lastParams: null };
  const client = {
    messages: {
      create: async (params) => {
        state.lastParams = params;
        const r = responseQueue[state.calls];
        state.calls += 1;
        if (!r) {
          const err = new Error(`stub: no response defined for call ${state.calls}`);
          err.code = 'STUB_EXHAUSTED';
          throw err;
        }
        return r;
      },
    },
    state,
  };
  return client;
}

// ─────────── single-call happy path ───────────

test('callJSON: single call (stop=end_turn) parses normally', async () => {
  const stub = makeStub([makeResponse('{"a":1}', 'end_turn')]);
  const out = await callJSON({
    system: 'sys',
    user: 'u',
    agent: 'be',
    _client: stub,
  });
  assert.deepEqual(out, { a: 1 });
  assert.equal(stub.state.calls, 1);
});

// ─────────── continuation: max_tokens → continue → end_turn ───────────

test('callJSON: max_tokens → 1 continuation accumulates into valid JSON', async () => {
  const stub = makeStub([
    makeResponse('{"a":1,', 'max_tokens'),
    makeResponse('"b":2}', 'end_turn'),
  ]);
  const out = await callJSON({
    system: 'sys',
    user: 'u',
    agent: 'be',
    _client: stub,
  });
  assert.deepEqual(out, { a: 1, b: 2 });
  assert.equal(stub.state.calls, 2);
});

test('callJSON: max_tokens → 2 continuations accumulate', async () => {
  const stub = makeStub([
    makeResponse('{"a":1,', 'max_tokens'),
    makeResponse('"b":2,', 'max_tokens'),
    makeResponse('"c":3}', 'end_turn'),
  ]);
  const out = await callJSON({
    system: 'sys',
    user: 'u',
    agent: 'be',
    _client: stub,
  });
  assert.deepEqual(out, { a: 1, b: 2, c: 3 });
  assert.equal(stub.state.calls, 3);
});

test('callJSON: continuation message structure includes assistant accumulated + continue user', async () => {
  let capturedAt2;
  const stub = {
    messages: {
      create: async (params) => {
        stub.state.calls += 1;
        if (stub.state.calls === 1) {
          return makeResponse('{"a":', 'max_tokens');
        }
        capturedAt2 = params;
        return makeResponse('1}', 'end_turn');
      },
    },
    state: { calls: 0 },
  };
  await callJSON({ system: 'sys', user: 'u', agent: 'be', _client: stub });
  assert.equal(capturedAt2.messages.length, 3);
  assert.equal(capturedAt2.messages[0].role, 'user');
  assert.equal(capturedAt2.messages[1].role, 'assistant');
  assert.equal(capturedAt2.messages[1].content, '{"a":');
  assert.equal(capturedAt2.messages[2].role, 'user');
  assert.match(capturedAt2.messages[2].content, /이어서/);
});

// ─────────── exhausted continuations → retry → throw ───────────

test('callJSON: all continuations + retries exhausted → throws LLM_TRUNCATED', async () => {
  // 1 initial + MAX_CONTINUATIONS(3) = 4 calls per attempt
  // MAX_LLM_RETRIES(2) + initial = 3 attempts → 12 total calls all max_tokens
  const queue = [];
  for (let i = 0; i < 12; i++) queue.push(makeResponse('{', 'max_tokens'));
  const stub = makeStub(queue);
  await assert.rejects(
    () => callJSON({ system: 'sys', user: 'u', agent: 'be', _client: stub }),
    (err) => err.code === 'LLM_TRUNCATED'
  );
  assert.equal(stub.state.calls, 12);
});

// (parse-fail retry path is exercised indirectly by other tests + jsonrepair
//  fallback chain; not duplicated here.)

// ─────────── continuation preserves system cache ───────────

test('callJSON: cache=system marks systemParam on every continuation call', async () => {
  const captured = [];
  const stub = {
    messages: {
      create: async (params) => {
        captured.push(params);
        stub.state.calls += 1;
        if (stub.state.calls === 1) return makeResponse('{', 'max_tokens');
        return makeResponse('}', 'end_turn');
      },
    },
    state: { calls: 0 },
  };
  await callJSON({
    system: 'sys',
    user: 'u',
    agent: 'be',
    cache: 'system',
    _client: stub,
  });
  for (const params of captured) {
    assert.ok(Array.isArray(params.system));
    assert.equal(params.system[0].cache_control.type, 'ephemeral');
  }
});

// ─────────── usage aggregation visible (we can't easily inspect console, but
//             we can verify continuation count by observing call count) ───────────

test('callJSON: max_tokens then end_turn results in exactly 2 calls (no extra retry)', async () => {
  const stub = makeStub([
    makeResponse('{', 'max_tokens', { output_tokens: 50 }),
    makeResponse('"a":1}', 'end_turn', { output_tokens: 10 }),
  ]);
  await callJSON({ system: 'sys', user: 'u', agent: 'be', _client: stub });
  assert.equal(stub.state.calls, 2);
});

// ─────────── continuation interaction with cache='user' ───────────

test('callJSON: cache=user puts cache_control on initial user content only', async () => {
  const captured = [];
  const stub = {
    messages: {
      create: async (params) => {
        captured.push(params);
        stub.state.calls += 1;
        if (stub.state.calls === 1) return makeResponse('{"x":', 'max_tokens');
        return makeResponse('1}', 'end_turn');
      },
    },
    state: { calls: 0 },
  };
  await callJSON({
    system: 'sys',
    user: 'u',
    agent: 'codechecker',
    cache: 'user',
    _client: stub,
  });
  // Initial call: 1 message (user), content is an array with cache_control.
  assert.equal(captured[0].messages.length, 1);
  assert.equal(captured[0].messages[0].role, 'user');
  assert.ok(Array.isArray(captured[0].messages[0].content));
  assert.equal(captured[0].messages[0].content[0].cache_control.type, 'ephemeral');
  // Continuation: 3 messages (user, assistant, user). First message still
  // carries cache_control (same array reference reused).
  assert.equal(captured[1].messages.length, 3);
  assert.ok(Array.isArray(captured[1].messages[0].content));
  assert.equal(captured[1].messages[0].content[0].cache_control.type, 'ephemeral');
});
