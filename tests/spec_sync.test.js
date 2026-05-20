/**
 * Unit tests for lib/spec_sync.js (D89, 2026-05-20).
 *
 * 검증: rules/domain.md 파싱 + router_details drift 정적 검증.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseDomainCatalog, classifyScenario, checkSpecSync } = require('../lib/spec_sync');

const SAMPLE_CATALOG = `# Domain

intro text

## 1. 원칙

skip me

## 2. 도메인 필드 카탈로그

### username
- regex: \`^[a-zA-Z0-9_]{4,16}$\`
- minLength: 4, maxLength: 16
- PASS 예: \`newplayer1\`, \`demo_user\`, \`valid_user\`
- FAIL 예:
  - 너무 짧음: \`ab\`, \`joe\`
  - 너무 김: \`totally_new_user99\`

### password
- 조건: minLength 8
- regex: \`^(?=.*[A-Za-z])(?=.*\\d)[A-Za-z\\d]{8,}$\`
- PASS 예: \`Pass1234\`, \`secure99x\`
- FAIL 예:
  - 너무 짧음: \`abc\`
  - 숫자 누락: \`password\`, \`Onlyalpha\`

## 3. status

skip me too
`;

test('parseDomainCatalog — username/password 두 field 추출', () => {
  const cat = parseDomainCatalog(SAMPLE_CATALOG);
  assert.ok(cat.fields.username);
  assert.ok(cat.fields.password);
  assert.equal(cat.fields.username.regex, '^[a-zA-Z0-9_]{4,16}$');
  assert.deepEqual(cat.fields.username.passExamples, ['newplayer1', 'demo_user', 'valid_user']);
  assert.ok(cat.fields.username.failExamples.includes('ab'));
  assert.ok(cat.fields.username.failExamples.includes('totally_new_user99'));
  assert.ok(cat.fields.password.failExamples.includes('password'));
  assert.ok(cat.fields.password.failExamples.includes('Onlyalpha'));
});

test('parseDomainCatalog — §3 이후 내용은 무시', () => {
  const cat = parseDomainCatalog(SAMPLE_CATALOG);
  assert.equal(Object.keys(cat.fields).length, 2);
});

test('parseDomainCatalog — 실제 rules/domain.md 파싱', () => {
  const real = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'domain.md'), 'utf8');
  const cat = parseDomainCatalog(real);
  assert.ok(cat.fields.username, 'username field missing');
  assert.ok(cat.fields.password, 'password field missing');
  assert.equal(cat.fields.username.regex, '^[a-zA-Z0-9_]{4,16}$');
  assert.ok(cat.fields.username.passExamples.includes('newplayer1'));
  assert.ok(cat.fields.username.failExamples.includes('totally_new_user99'));
});

test('classifyScenario — valid_*, available_*는 PASS 의도', () => {
  assert.equal(classifyScenario('valid_signup'), 'PASS_VALID');
  assert.equal(classifyScenario('valid_login'), 'PASS_VALID');
  assert.equal(classifyScenario('available_username'), 'PASS_AVAILABLE');
});

test('classifyScenario — invalid_*, weak_password는 FAIL 의도', () => {
  assert.equal(classifyScenario('invalid_username_format'), 'INVALID');
  assert.equal(classifyScenario('invalid_weapon'), 'INVALID');
  assert.equal(classifyScenario('weak_password'), 'INVALID_PASSWORD');
});

test('classifyScenario — missing/duplicate/nonexistent는 검증 skip', () => {
  assert.equal(classifyScenario('missing_field'), null);
  assert.equal(classifyScenario('duplicate_username'), null);
  assert.equal(classifyScenario('nonexistent_user'), null);
  assert.equal(classifyScenario('ghost_user'), null);
});

function mkTempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-sync-test-'));
  const catalogPath = path.join(base, 'domain.md');
  const routerDir = path.join(base, 'router');
  fs.writeFileSync(catalogPath, SAMPLE_CATALOG);
  fs.mkdirSync(routerDir);
  return { base, catalogPath, routerDir };
}

function writeRouter(routerDir, name, content) {
  fs.writeFileSync(path.join(routerDir, `${name}.json`), JSON.stringify(content));
}

test('checkSpecSync — 카탈로그 없으면 skip', () => {
  const { routerDir } = mkTempDirs();
  const r = checkSpecSync({ catalogPath: '/nonexistent.md', routerDir });
  assert.equal(r.pass, true);
  assert.equal(r.skipped, 'no-catalog');
});

test('checkSpecSync — router 디렉토리 없으면 skip', () => {
  const { catalogPath } = mkTempDirs();
  const r = checkSpecSync({ catalogPath, routerDir: '/nonexistent-dir' });
  assert.equal(r.pass, true);
  assert.equal(r.skipped, 'no-router-dir');
});

test('checkSpecSync — router 파일 없으면 skip', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, true);
  assert.equal(r.skipped, 'no-router-files');
});

test('checkSpecSync — 모든 spec 정상이면 PASS', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  writeRouter(routerDir, 'auth_signup', {
    request: {
      schema: {
        properties: {
          username: { type: 'string', pattern: '^[a-zA-Z0-9_]{4,16}$' },
          password: { type: 'string', pattern: '^(?=.*[A-Za-z])(?=.*\\d)[A-Za-z\\d]{8,}$' },
        },
      },
    },
    test_scenarios: [
      { name: 'valid_signup', request_body: { username: 'newplayer1', password: 'Pass1234' }, expect_status: 201 },
      { name: 'weak_password', request_body: { username: 'demo_user', password: 'password' }, expect_status: 400 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, true);
  assert.equal(r.drifts.length, 0);
  assert.equal(r.router_count, 1);
});

test('checkSpecSync — pattern 불일치 감지', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  writeRouter(routerDir, 'auth_signup', {
    request: { schema: { properties: { username: { pattern: '^[a-z]{3,20}$' } } } },
    test_scenarios: [],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, false);
  assert.equal(r.drifts.length, 1);
  assert.equal(r.drifts[0].issue, 'pattern_mismatch');
  assert.equal(r.drifts[0].field, 'username');
  assert.equal(r.drifts[0].expected, '^[a-zA-Z0-9_]{4,16}$');
});

test('checkSpecSync — PASS 시나리오에 FAIL 예 사용 감지 (이번 cycle 케이스)', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  writeRouter(routerDir, 'auth_check', {
    request: { schema: { properties: { username: { pattern: '^[a-zA-Z0-9_]{4,16}$' } } } },
    test_scenarios: [
      { name: 'available_username', request_query: { username: 'totally_new_user99' }, expect_status: 200 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, false);
  assert.equal(r.drifts.length, 1);
  assert.equal(r.drifts[0].issue, 'pass_scenario_uses_fail_example');
  assert.equal(r.drifts[0].scenario, 'available_username');
  assert.equal(r.drifts[0].actual, 'totally_new_user99');
  assert.match(r.fix_instructions, /SPEC_SYNC/);
  assert.match(r.fix_instructions, /available_username/);
});

test('checkSpecSync — INVALID 시나리오에 PASS 예 사용 감지', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  writeRouter(routerDir, 'auth_signup', {
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'weak_password', request_body: { username: 'demo_user', password: 'Pass1234' }, expect_status: 400 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, false);
  assert.equal(r.drifts.length, 1);
  assert.equal(r.drifts[0].issue, 'invalid_scenario_uses_pass_example');
  assert.equal(r.drifts[0].field, 'password');
  assert.equal(r.drifts[0].actual, 'Pass1234');
});

test('checkSpecSync — duplicate/nonexistent 시나리오는 검증 skip', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  writeRouter(routerDir, 'auth_signup', {
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'duplicate_username', request_body: { username: 'demo_user', password: 'Pass1234' }, expect_status: 409 },
      { name: 'nonexistent_user', request_body: { username: 'ghostly_user', password: 'Pass1234' }, expect_status: 401 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, true);
  assert.equal(r.drifts.length, 0);
});

// D90: cross-endpoint username 충돌 (signup valid_* INSERT × check available_*)

test('checkSpecSync — cross-endpoint username 충돌 감지 (D90)', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  // signup이 valid_user INSERT
  writeRouter(routerDir, 'auth_signup', {
    method: 'POST', path: '/auth/signup',
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'valid_signup', request_body: { username: 'valid_user', password: 'Pass1234' }, expect_status: 201 },
    ],
  });
  // check available가 같은 valid_user 사용 → 충돌
  writeRouter(routerDir, 'auth_check', {
    method: 'GET', path: '/auth/check',
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'available_username', request_query: { username: 'valid_user' }, expect_status: 200 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, false);
  assert.equal(r.drifts.length, 1);
  assert.equal(r.drifts[0].issue, 'cross_endpoint_username_collision');
  assert.equal(r.drifts[0].scenario, 'available_username');
  assert.equal(r.drifts[0].actual, 'valid_user');
  assert.match(r.fix_instructions, /이미 INSERT한 값/);
});

test('checkSpecSync — cross-endpoint 분리된 경우 PASS', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  // signup은 newplayer1, check는 player_99 → 겹치지 않음
  writeRouter(routerDir, 'auth_signup', {
    method: 'POST', path: '/auth/signup',
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'valid_signup', request_body: { username: 'newplayer1', password: 'Pass1234' }, expect_status: 201 },
    ],
  });
  writeRouter(routerDir, 'auth_check', {
    method: 'GET', path: '/auth/check',
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'available_username', request_query: { username: 'player_99' }, expect_status: 200 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  assert.equal(r.pass, true);
  assert.equal(r.drifts.length, 0);
});

test('checkSpecSync — signup의 invalid_* / missing_* 는 INSERT 안 일으키므로 충돌 검사 제외', () => {
  const { catalogPath, routerDir } = mkTempDirs();
  // signup의 invalid_username 시나리오 username='ab' (FAIL 예라 INSERT 안 됨)
  writeRouter(routerDir, 'auth_signup', {
    method: 'POST', path: '/auth/signup',
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'invalid_username_format', request_body: { username: 'ab', password: 'Pass1234' }, expect_status: 400 },
    ],
  });
  // check available가 같은 'ab' 사용 → invalid라 충돌 아님 (단 invalid_* PASS 의도 아니라 별개)
  writeRouter(routerDir, 'auth_check', {
    method: 'GET', path: '/auth/check',
    request: { schema: { properties: {} } },
    test_scenarios: [
      { name: 'available_username', request_query: { username: 'valid_user' }, expect_status: 200 },
    ],
  });
  const r = checkSpecSync({ catalogPath, routerDir });
  // cross collision은 0 (signup이 valid_*가 아니라 invalid_*만 가짐)
  const collisions = r.drifts.filter((d) => d.issue === 'cross_endpoint_username_collision');
  assert.equal(collisions.length, 0);
});
