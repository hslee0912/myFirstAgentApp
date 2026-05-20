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

test('BE agent system prompt에 rules/db.md 내용 *실제* inject (D42 직접 검증)', () => {
  // D41까지는 *소스 참조만* 검증 (간접) → D42에서 SYSTEM_PROMPT 자체를
  // _internal로 노출 + *실제 prompt 결과*에 db.md 핵심 키워드가 있는지 직접 확인.
  const be = require('../agents/be_agent');
  const sp = be._internal.SYSTEM_PROMPT;
  assert.ok(typeof sp === 'string' && sp.length > 1000, 'SYSTEM_PROMPT가 비정상');

  // db.md의 모든 핵심 섹션이 prompt에 포함되어야 함
  assert.match(sp, /# DB Migration Convention/);            // 타이틀
  assert.match(sp, /두 schema의 \*완전 분리\*/);            // §1
  assert.match(sp, /UTC YYYYMMDDHHmmss/);                   // §2 파일명
  assert.match(sp, /checksum 충돌/);                        // §3 핵심 사고
  assert.match(sp, /새 timestamp의 추가 migration/);        // §3 정답 패턴
  assert.match(sp, /IF NOT EXISTS/);                        // §4 idempotent
  assert.match(sp, /1~3개/);                                // §5 cycle 개수
  assert.match(sp, /CREATE DATABASE/);                      // §8 함정
  // Reset to origin/main 언급은 D41-fix에서 제거됨 — prompt에도 부재 확인
  assert.doesNotMatch(sp, /Reset to origin\/main/i);
});

// ─────────── D43 (2026-05-14): readSchemaSection 슬림화 — 인라인 Migration 룰 제거 ───────────

test('D43: be_agent.js readSchemaSection 인라인의 D33 Migration 헤더가 prompt에서 *0회* 등장 (rules/db.md로 single source)', () => {
  const be = require('../agents/be_agent');
  const sp = be._internal.SYSTEM_PROMPT;
  // 옛 인라인 헤더 — 제거 확인. (D43)
  assert.doesNotMatch(sp, /## 비즈니스 DB schema — Migration emit 흐름 \(D33/);
  // 인라인 본문에만 있던 정확한 표현 — 사라져야.
  assert.doesNotMatch(sp, /checksum 변경이 감지되면 시스템이 즉시 FAIL/);
  // 옛 인라인의 다른 specific 문구도 확인 (rules/db.md 본문엔 다른 표현으로 들어있음)
  assert.doesNotMatch(sp, /비즈니스 영속화가 필요하면 \*\*`BE\/db\/migrations/);
});

test('D43: rules/db.md 참조 1줄이 readSchemaSection 출력에 들어있음', () => {
  const be = require('../agents/be_agent');
  const sp = be._internal.SYSTEM_PROMPT;
  // 새 referencer 문구
  assert.match(sp, /`rules\/db\.md` 참조/);
});

test('D43: agent_schema.sql 본문 inject는 유지 — log_* 테이블 컬럼 정의 prompt에 있음', () => {
  const be = require('../agents/be_agent');
  const sp = be._internal.SYSTEM_PROMPT;
  // agent_schema.sql 안의 대표 키워드들
  assert.match(sp, /CREATE TABLE IF NOT EXISTS log_agent_runs/);
  assert.match(sp, /CREATE TABLE IF NOT EXISTS log_db_migrations/);
});

test('D43: prompt 길이 — 슬림화 효과 지속 + 후속 rules 보강 반영', () => {
  const be = require('../agents/be_agent');
  const sp = be._internal.SYSTEM_PROMPT;
  // 길이 진행:
  //   D42 24,045 (검증 시작점)
  //   D43 23,347 (인라인 D33 섹션 제거, -698)
  //   D44 23,556 (rules/db.md D44 안내 +209)
  //   D45 25,117 (rules/be.md §3-zero 컨테이너 sanity +~1,500)
  //   D48 26,446 (rules/db.md §4-bis 인덱스 idempotent +~1,300)
  //   D52 ~27,400 (rules/db.md JS 문법 금지 +~900)
  //   D56 ~28,170 (rules/common.md §10 코드 최적화 + 10-bis FE 특별 주의 +~800)
  //   D59 ~27,400 (D56 §10 삭제)
  //   D60 ~28,200 (rules/be.md §3-α /health 강조 +~800)
  //   D62 ~30,460 (rules/common.md §9-bis 강화 + rules/be.md §5-bis 강화 +~2,200)
  //   D72 ~33,237 (rules/be.md §5-ter 시드 정합성 룰 +~1,200, PostTest 4종 연쇄 fail 패턴 차단)
  //   D87 (2026-05-20) ~38,648 (rules/domain.md inject + validator 통일 블록 +~5,400, endpoint 간 drift 차단)
  //   D92 (2026-05-20) ~42,070 (rules/domain.md §4-ter valid_credentials seed 매핑 룰 +~1,400, credential_seed_mismatch 정적 가드)
  // 핵심: D43 슬림화 자체는 *여전히 유효* — 인라인 D33 부활 시 +800~1000 더 늘어남.
  // 상한 45,000으로 완화 (D92 시드 매핑 룰 반영). 회귀 감지 보장.
  assert.ok(sp.length < 45000, `SYSTEM_PROMPT total = ${sp.length} chars — 45,000 미만 유지 필요 (D43 인라인 부활 감지)`);
});

// ─────────── D44 (2026-05-14): BE Agent prompt에 DB 상태 inject ───────────

test('D44: buildInitialUserPrompt — db_state 세 섹션 모두 표시', () => {
  const be = require('../agents/be_agent');
  const out = be._internal.buildInitialUserPrompt({
    be_spec: {},
    api_contract: null,
    existing_files: {},
    db_state: {
      applied: [{ filename: '20260514120000_create_users.sql', checksum: 'x', applied_at: '2026-05-14T12:00:01Z' }],
      disk: [{ filename: '20260514120000_create_users.sql', checksum: 'x', size: 100 }],
      schema: {
        tables: {
          users: [
            { column: 'id', type: 'int', nullable: false, key: 'PRI', extra: 'auto_increment' },
            { column: 'email', type: 'varchar(255)', nullable: false, key: 'UNI', extra: '' },
          ],
        },
      },
    },
  });
  assert.match(out, /## 이미 적용된 migration/);
  assert.match(out, /20260514120000_create_users\.sql.*applied 2026/);
  assert.match(out, /## 디스크의 migration 파일/);
  assert.match(out, /BE\/db\/migrations\/20260514120000_create_users\.sql/);
  assert.match(out, /## 현재 비즈니스 DB schema/);
  assert.match(out, /users\(.*email varchar\(255\) UNI/);
});

test('D44: buildInitialUserPrompt — db_state 없으면 "(아직 없음 — 첫 migration cycle)" 표시 (crash 안 함)', () => {
  const be = require('../agents/be_agent');
  const out = be._internal.buildInitialUserPrompt({
    be_spec: {},
    api_contract: null,
    existing_files: {},
    // db_state 일부러 누락
  });
  assert.match(out, /첫 migration cycle/);   // applied 빈 상태
  assert.match(out, /## 디스크의 migration 파일/);
  assert.match(out, /## 현재 비즈니스 DB schema/);
});

test('D44: buildRetryUserPrompt — db_state 세 섹션 retry mode에서도 표시', () => {
  const be = require('../agents/be_agent');
  const out = be._internal.buildRetryUserPrompt({
    be_spec: {},
    api_contract: null,
    existing_files: {},
    allowed_paths: ['BE/db/migrations/20260514130000_alter_users.sql'],
    fix_instructions: '[CONTRACT_SYNC] ...',
    db_state: {
      applied: [{ filename: '20260514120000_a.sql', checksum: 'x', applied_at: '2026-05-14T12:00:01Z' }],
      disk: [{ filename: '20260514120000_a.sql', checksum: 'x', size: 100 }],
      schema: { tables: { users: [{ column: 'id', type: 'int', nullable: false, key: 'PRI', extra: '' }] } },
    },
  });
  assert.match(out, /## 이미 적용된 migration/);
  assert.match(out, /20260514120000_a\.sql/);
  assert.match(out, /## 디스크의 migration 파일/);
  assert.match(out, /## 현재 비즈니스 DB schema/);
});

test('D44: rules/db.md에 D44 안내 (LLM이 prompt에 새 섹션이 들어옴을 인지) 포함', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'db.md'), 'utf8');
  assert.match(md, /D44/);
  assert.match(md, /현재 비즈니스 DB schema/);
});

test('D44: orchestrator가 dbState 모듈 import 흔적 + getBeStateBundle 호출', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'agents', 'orchestrator.js'), 'utf8');
  assert.match(src, /require\(['"]\.\.\/lib\/db_state['"]\)/);
  assert.match(src, /getBeStateBundle\s*\(/);
});

test('CLAUDE.md — 문서 구조 테이블에 rules/db.md row 추가', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // worktree CLAUDE.md만 검사 — main의 동기화는 push 후 사용자가 reset --hard.
  const md = fs.readFileSync(path.resolve(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.match(md, /rules\/db\.md/);
  assert.match(md, /DB migration 규칙/);
});

// ─────────── D41-fix (2026-05-14): "Reset to origin/main" 언급 금지 ───────────
//   LLM이 destructive 작업(ahead commit + 코드 + DB 모두 폐기)을 *해결책으로
//   제안*하지 않도록, prompt에 inject되는 .md 파일(rules/* + CLAUDE.md)에서
//   해당 문구를 완전히 제거. 미래 회귀 방지.

test('rules/*.md + CLAUDE.md에 "Reset to origin/main" 언급 없음 (destructive 작업 제안 차단)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const candidates = [
    path.resolve(__dirname, '..', 'CLAUDE.md'),
    path.resolve(__dirname, '..', 'rules', 'common.md'),
    path.resolve(__dirname, '..', 'rules', 'be.md'),
    path.resolve(__dirname, '..', 'rules', 'fe.md'),
    path.resolve(__dirname, '..', 'rules', 'db.md'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const md = fs.readFileSync(p, 'utf8');
    assert.doesNotMatch(
      md,
      /Reset to origin\/main/i,
      `${path.basename(p)}에 "Reset to origin/main" 언급이 남아있음 — LLM에게 destructive 옵션을 제안하면 안 됨`
    );
  }
});
