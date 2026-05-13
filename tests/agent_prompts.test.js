/**
 * Unit tests for BE/FE Agent prompt builders (D39, 2026-05-14).
 *
 * 검증 대상:
 *   - api_contract.endpoints가 prompt에 *명시적 list*로 포함되는지
 *     (JSON 블록 외에 별도 체크리스트로 — LLM에게 강제 신호)
 *   - initial + retry 두 모드 모두에 포함
 *   - BE + FE 두 agent 모두에 포함
 *
 * 검증 안 함: LLM 호출, 파일 emit, 디스크 mutation (e2e 책임).
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const be = require('../agents/be_agent');
const fe = require('../agents/fe_agent');

// 공통 fixture
const CONTRACT = {
  version: '1.0',
  base_url: '/api/v1',
  endpoints: [
    { name: 'auth_signup', method: 'POST', path: '/auth/signup' },
    { name: 'auth_login', method: 'POST', path: '/auth/login' },
    { name: 'result_save', method: 'POST', path: '/result' },
    { name: 'result_best', method: 'GET', path: '/best' },
  ],
};

const BE_SPEC = { endpoints: ['POST /signup'] };
const FE_SPEC = { pages: ['SignupForm'] };

// ─────────── BE Agent ───────────

test('BE buildInitialUserPrompt — endpoint checklist 4개 모두 포함', () => {
  const out = be._internal.buildInitialUserPrompt({
    be_spec: BE_SPEC,
    api_contract: CONTRACT,
    existing_files: {},
  });
  assert.match(out, /구현해야 할 endpoint/);
  assert.match(out, /POST\s+\/api\/v1\/auth\/signup/);
  assert.match(out, /POST\s+\/api\/v1\/auth\/login/);
  assert.match(out, /POST\s+\/api\/v1\/result/);
  assert.match(out, /GET\s+\/api\/v1\/best/);
  // ContractSync 언급으로 LLM에 *결과*를 알려줌
  assert.match(out, /ContractSync/);
});

test('BE buildRetryUserPrompt — endpoint checklist도 retry mode에 포함 (CONTRACT_SYNC retry 케이스)', () => {
  const out = be._internal.buildRetryUserPrompt({
    be_spec: BE_SPEC,
    api_contract: CONTRACT,
    existing_files: {},
    allowed_paths: ['BE/src/routes/auth_routes.js'],
    fix_instructions: '[CONTRACT_SYNC] api_contract.json declares 4 endpoints; BE/src/ implements 3...',
  });
  assert.match(out, /구현해야 할 endpoint/);
  assert.match(out, /POST\s+\/api\/v1\/auth\/login/);
  assert.match(out, /GET\s+\/api\/v1\/best/);
});

test('BE buildInitialUserPrompt — api_contract null이면 checklist 자리에 "(없음)" 표시 (crash 안 함)', () => {
  const out = be._internal.buildInitialUserPrompt({
    be_spec: BE_SPEC,
    api_contract: null,
    existing_files: {},
  });
  // checklist는 비어있지만 헤더는 그대로 등장
  assert.match(out, /구현해야 할 endpoint/);
  assert.match(out, /\(없음\)/);
});

// ─────────── FE Agent ───────────

test('FE buildInitialUserPrompt — endpoint checklist 4개 모두 포함 (fetch URL 매칭용)', () => {
  const out = fe._internal.buildInitialUserPrompt({
    fe_spec: FE_SPEC,
    api_contract: CONTRACT,
    existing_files: {},
  });
  assert.match(out, /사용 가능한 endpoint/);
  assert.match(out, /POST\s+\/api\/v1\/auth\/signup/);
  assert.match(out, /POST\s+\/api\/v1\/auth\/login/);
  assert.match(out, /POST\s+\/api\/v1\/result/);
  assert.match(out, /GET\s+\/api\/v1\/best/);
});

test('FE buildRetryUserPrompt — endpoint checklist도 retry mode에 포함', () => {
  const out = fe._internal.buildRetryUserPrompt({
    fe_spec: FE_SPEC,
    api_contract: CONTRACT,
    existing_files: {},
    allowed_paths: ['FE/src/App.jsx'],
    fix_instructions: 'stage 1 eslint failed: ...',
  });
  assert.match(out, /사용 가능한 endpoint/);
  assert.match(out, /POST\s+\/api\/v1\/auth\/signup/);
});

test('FE buildInitialUserPrompt — api_contract null도 안전', () => {
  const out = fe._internal.buildInitialUserPrompt({
    fe_spec: FE_SPEC,
    api_contract: null,
    existing_files: {},
  });
  assert.match(out, /사용 가능한 endpoint/);
  assert.match(out, /\(없음\)/);
});

// ─────────── rules 파일 정합성 (D39 prompt와 짝) ───────────

test('rules/be.md — Contract endpoint mount 강제 룰 (§3-bis) 포함', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'be.md'), 'utf8');
  assert.match(md, /Contract endpoint mount/);
  assert.match(md, /ContractSync/);
  assert.match(md, /빠짐없이/);
});

test('rules/fe.md — 보안·해싱 라이브러리 안티패턴 (§7-bis) 포함', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'fe.md'), 'utf8');
  // bcrypt / bcryptjs / crypto-js / Web Crypto API 모두 명시
  assert.match(md, /bcrypt/);
  assert.match(md, /bcryptjs/);
  assert.match(md, /crypto-js/);
  assert.match(md, /Web Crypto API/);
  // 핵심 메시지: FE 해싱은 안티패턴
  assert.match(md, /안티패턴/);
});
