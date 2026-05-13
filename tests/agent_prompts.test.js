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

// ─────────── D41 (2026-05-14): rules/db.md + FE/BE rules 확장 ───────────

test('rules/db.md — 신규 파일 존재 + 핵심 키워드 (checksum 충돌, 새 timestamp) 포함', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.resolve(__dirname, '..', 'rules', 'db.md');
  assert.ok(fs.existsSync(p), 'rules/db.md가 없음');
  const md = fs.readFileSync(p, 'utf8');
  // 사용자 보고 케이스의 정확한 메시지 + 해결책
  assert.match(md, /checksum 충돌/);
  assert.match(md, /수정 금지/);
  assert.match(md, /새 timestamp/);
  // idempotent 작성 안내
  assert.match(md, /IF NOT EXISTS/);
  assert.match(md, /idempotent/i);
  // agent_schema 분리 명시
  assert.match(md, /agent_schema\.sql/);
});

test('rules/be.md — Migration 자세한 규칙은 rules/db.md로 위임 (중복 제거)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'be.md'), 'utf8');
  // be.md는 db.md 참조만 남기고 자세한 룰은 위임
  assert.match(md, /rules\/db\.md/);
});

test('rules/fe.md — §4-ter (default prop 누락) + §4-quater (import/export) 패턴 추가', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'fe.md'), 'utf8');
  // §4-ter
  assert.match(md, /4-ter/);
  assert.match(md, /default 값 누락/);
  assert.match(md, /optional chaining/);
  // §4-quater
  assert.match(md, /4-quater/);
  assert.match(md, /import 경로 오타/);
  assert.match(md, /export default/);
});

test('rules/be.md — §7-ter (모듈 export 누락) 패턴 추가', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'be.md'), 'utf8');
  assert.match(md, /7-ter/);
  assert.match(md, /export 안 함/);
  assert.match(md, /module\.exports/);
});

test('BE agent system prompt에 rules/db.md 내용 inject (readConvention 통해)', () => {
  // be_agent.js의 SYSTEM_PROMPT는 module load 시 한 번 빌드. 직접 require → readConvention 결과 검증.
  // 다만 SYSTEM_PROMPT 자체는 export 안 되어 있어, readConvention의 동작을 *간접* 검증.
  const fs = require('node:fs');
  const path = require('node:path');
  // db.md가 prompt에 들어가는 흔적: be_agent.js 소스에 db.md path 참조가 존재
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'agents', 'be_agent.js'), 'utf8');
  assert.match(src, /['"]rules['"]\s*,\s*['"]db\.md['"]/);
});

test('CLAUDE.md — 문서 구조 테이블에 rules/db.md row 추가', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // worktree CLAUDE.md만 검사 — main의 동기화는 push 후 사용자가 reset --hard.
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.match(md, /rules\/db\.md/);
  assert.match(md, /DB migration 규칙/);
});
