/**
 * Unit tests for lib/agent_error_classifier.js (D34, 2026-05-14).
 *
 * 7가지 retryable 카테고리의 패턴 매칭 + buildFixInstructions 출력 검증.
 * 시스템 예외(retryable=false) 패스스루도 확인.
 *
 * Run: npm test
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAgentError,
  buildFixInstructions,
  RETRYABLE_PATTERNS,
} = require('../lib/agent_error_classifier');

const makeErr = (msg) => Object.assign(new Error(msg), { stack: msg });

// ─────────── classifyAgentError — 7 retryable categories ───────────

test('UNAUTHORIZED_DEPS — validateAllowedDeps throw', () => {
  const e = makeErr("[FE Agent] Unauthorized dependencies detected: FE/src/App.jsx: 'react-router-dom'.");
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'UNAUTHORIZED_DEPS');
  assert.match(c.hint, /allowedDeps|notes/);
});

test('PROTECTED_PATH — protected stack config file throw', () => {
  const e = makeErr("[BE Agent] Path 'BE/package.json' is a protected stack config file (see lib/stack.config.json protectedConfigFiles)");
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'PROTECTED_PATH');
});

test('PATH_BOUNDARY — Disallowed path / must start with', () => {
  const e = makeErr("[BE Agent] Disallowed path 'FE/src/foo.jsx' (must start with BE/)");
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'PATH_BOUNDARY');
  assert.match(c.hint, /BE\/|FE\//);
});

test('PATH_NOT_ALLOWED — retry mode allowed_paths 위반', () => {
  const e = makeErr("[BE Agent] Path 'BE/src/extra.js' not in allowed_paths");
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'PATH_NOT_ALLOWED');
});

test('PATH_UNSAFE — fs_util path outside base', () => {
  const e = makeErr("[fs_util] path '../etc/passwd' is outside BE/");
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'PATH_UNSAFE');
});

test('CONTEXT_BUDGET — input + max_output > model window', () => {
  const e = makeErr('[llm:BE] Context budget exceeded: input ~120000t + max_output 8000t = 128000t > model input window 200000t');
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'CONTEXT_BUDGET');
});

test('JSON_PARSE_FAIL — callJSON 최종 실패', () => {
  const e = makeErr('LLM did not return valid JSON after 3 recovery attempts. Raw response dumped to: /tmp/x. Last error: Unexpected token');
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'JSON_PARSE_FAIL');
});

// ─────────── classifyAgentError — anthropic SDK throw (D34+) ───────────

test('LLM_API_TRANSIENT — rate limit (429 in message)', () => {
  const e = makeErr('429 Too Many Requests');
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'LLM_API_TRANSIENT');
});

test('LLM_API_TRANSIENT — rate_limit_error type', () => {
  const e = Object.assign(new Error('Anthropic API error'), { status: 429, error: { type: 'rate_limit_error' } });
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'LLM_API_TRANSIENT');
});

test('LLM_API_TRANSIENT — overloaded_error', () => {
  const e = Object.assign(new Error('Overloaded'), { error: { type: 'overloaded_error' } });
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'LLM_API_TRANSIENT');
});

test('LLM_API_TRANSIENT — ECONNRESET network error', () => {
  const e = makeErr('connect ECONNRESET 192.168.0.1:443');
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'LLM_API_TRANSIENT');
});

test('LLM_API_TRANSIENT — 503 service unavailable', () => {
  const e = Object.assign(new Error('Service Unavailable'), { status: 503 });
  const c = classifyAgentError(e);
  assert.equal(c.retryable, true);
  assert.equal(c.category, 'LLM_API_TRANSIENT');
});

test('LLM_API_AUTH — 401 invalid API key', () => {
  const e = Object.assign(new Error('Invalid x-api-key header'), { status: 401, error: { type: 'authentication_error' } });
  const c = classifyAgentError(e);
  assert.equal(c.retryable, false);  // override
  assert.equal(c.category, 'LLM_API_AUTH');
});

test('LLM_API_AUTH — message에 401만 있어도 매치', () => {
  const e = makeErr('Request failed with status code 401');
  const c = classifyAgentError(e);
  assert.equal(c.retryable, false);
  assert.equal(c.category, 'LLM_API_AUTH');
});

test('우선순위 — AUTH(401)이 TRANSIENT보다 먼저 매치', () => {
  // 만약 AUTH 패턴이 TRANSIENT 뒤에 있으면 401이 transient에 잘못 잡힐 위험 — 순서 검증.
  const e = makeErr('401 Unauthorized');
  const c = classifyAgentError(e);
  assert.equal(c.category, 'LLM_API_AUTH');
  assert.equal(c.retryable, false);
});

// ─────────── classifyAgentError — non-retryable ───────────

test('UNKNOWN — 시스템 예외 (ECONNREFUSED, EACCES 등)는 non-retryable', () => {
  const e1 = makeErr('connect ECONNREFUSED 127.0.0.1:3306');
  assert.equal(classifyAgentError(e1).retryable, false);
  assert.equal(classifyAgentError(e1).category, 'UNKNOWN');

  const e2 = makeErr('EACCES: permission denied, open /tmp/x');
  assert.equal(classifyAgentError(e2).retryable, false);
});

test('UNKNOWN — 빈 메시지', () => {
  const c = classifyAgentError(new Error(''));
  assert.equal(c.retryable, false);
  assert.equal(c.category, 'UNKNOWN');
});

test('UNKNOWN — null/undefined safe', () => {
  const c1 = classifyAgentError(null);
  assert.equal(c1.retryable, false);
  const c2 = classifyAgentError(undefined);
  assert.equal(c2.retryable, false);
});

// ─────────── buildFixInstructions ───────────

test('buildFixInstructions — retryable이면 카테고리·hint·원본 메시지 포함', () => {
  const e = makeErr("[BE Agent] Unauthorized dependencies detected: BE/src/foo.js: 'lodash'.");
  const cls = classifyAgentError(e);
  const fix = buildFixInstructions(cls);
  assert.match(fix, /Agent guard — UNAUTHORIZED_DEPS/);
  assert.match(fix, /원본 에러 메시지/);
  assert.match(fix, /lodash/);
});

test('buildFixInstructions — non-retryable이면 원본 메시지 그대로', () => {
  const e = makeErr('connect ECONNREFUSED');
  const cls = classifyAgentError(e);
  const fix = buildFixInstructions(cls);
  assert.equal(fix, 'connect ECONNREFUSED');
});

test('buildFixInstructions — 1000자 넘는 원본 메시지는 자름', () => {
  const longMsg = '[FE Agent] Unauthorized dependencies detected: ' + 'x'.repeat(2000);
  const cls = classifyAgentError(makeErr(longMsg));
  const fix = buildFixInstructions(cls);
  // hint + 800자 제한 + 헤더 등 합치면 1500 미만이어야
  assert.ok(fix.length < 1800, `fix_instructions too long: ${fix.length}`);
});

// ─────────── RETRYABLE_PATTERNS 자체 sanity ───────────

test('RETRYABLE_PATTERNS — 9개 모두 unique category (D34+ 2개 추가)', () => {
  const cats = new Set(RETRYABLE_PATTERNS.map((p) => p.category));
  assert.equal(cats.size, 9);
  // 핵심 카테고리 존재 확인
  assert.ok(cats.has('UNAUTHORIZED_DEPS'));
  assert.ok(cats.has('LLM_API_TRANSIENT'));
  assert.ok(cats.has('LLM_API_AUTH'));
});

test('RETRYABLE_PATTERNS — retryable_override가 있으면 false 강제', () => {
  const auth = RETRYABLE_PATTERNS.find((p) => p.category === 'LLM_API_AUTH');
  assert.equal(auth.retryable_override, false);
});

test('RETRYABLE_PATTERNS — 각 패턴이 hint를 갖춤', () => {
  for (const p of RETRYABLE_PATTERNS) {
    assert.ok(typeof p.hint === 'string' && p.hint.length > 0, `category ${p.category} hint missing`);
    assert.ok(p.pattern instanceof RegExp, `category ${p.category} pattern not RegExp`);
  }
});
