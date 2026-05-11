/**
 * Unit tests for lib/container_cleanup.js — pure helpers only.
 *
 * The side-effecting cleanupOurContainers() shells out to `docker rm -f`;
 * its body is integration territory and is exercised by the next Phase 8
 * end-to-end run. The pure helpers (matchesOurConvention / parseDockerPsRows
 * / selectVictims) carry the actual matching logic — those we test
 * exhaustively, especially for the false-positive risk.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  matchesOurConvention,
  parseDockerPsRows,
  selectVictims,
  MANAGED_LABEL,
  MANAGED_LABEL_VALUE,
  NAME_PATTERNS,
} = require('../lib/container_cleanup');

// ─────────── matchesOurConvention: TRUE cases (real container names) ───────────

test('convention: FE — test-fe-1 + test-fe matches', () => {
  assert.equal(matchesOurConvention('test-fe-1', 'test-fe'), true);
});

test('convention: FE — finalize-fe-1 + finalize-fe matches', () => {
  assert.equal(matchesOurConvention('finalize-fe-1', 'finalize-fe'), true);
});

test('convention: FE — verify-port-fix-fe-1 + verify-port-fix-fe matches', () => {
  assert.equal(matchesOurConvention('verify-port-fix-fe-1', 'verify-port-fix-fe'), true);
});

test('convention: BE — finalize-be-1 + finalize-be matches', () => {
  assert.equal(matchesOurConvention('finalize-be-1', 'finalize-be'), true);
});

test('convention: BE — multi-digit index test-be-12', () => {
  assert.equal(matchesOurConvention('test-be-12', 'test-be'), true);
  assert.equal(matchesOurConvention('test-be-99', 'test-be'), true);
});

test('convention: MySQL — finalize-mysql-1 + mysql:8 matches', () => {
  assert.equal(matchesOurConvention('finalize-mysql-1', 'mysql:8'), true);
});

test('convention: MySQL — different mysql tags (8.0, latest, 8.4.9)', () => {
  assert.equal(matchesOurConvention('test-mysql-1', 'mysql:8.0'), true);
  assert.equal(matchesOurConvention('test-mysql-1', 'mysql:latest'), true);
  assert.equal(matchesOurConvention('test-mysql-1', 'mysql:8.4.9'), true);
});

test('convention: case-insensitive (uppercase still matches)', () => {
  assert.equal(matchesOurConvention('TEST-FE-1', 'TEST-FE'), true);
  assert.equal(matchesOurConvention('Test-Be-1', 'Test-Be'), true);
  assert.equal(matchesOurConvention('TEST-MYSQL-1', 'MYSQL:8'), true);
});

// ─────────── matchesOurConvention: FALSE cases (false-positive prevention) ───────────

test('false-positive guard: name matches FE pattern but image is wrong (e.g. nginx)', () => {
  // 흔한 함정: 누가 nginx 컨테이너를 nginx-fe-1로 이름 짓는 경우
  assert.equal(matchesOurConvention('nginx-fe-1', 'nginx:latest'), false);
  assert.equal(matchesOurConvention('myapp-fe-1', 'redis:7'), false);
});

test('false-positive guard: image ends with -fe but name does NOT match pattern', () => {
  // 누가 우리와 같은 image suffix 쓰는 경우 — 이름 패턴이 다르면 안 잡힘
  assert.equal(matchesOurConvention('some-other-container', 'myproject-fe'), false);
  assert.equal(matchesOurConvention('random_container_1', 'company-fe'), false);
});

test('false-positive guard: standalone mysql:8 with non-matching name', () => {
  // 다른 사용자의 standalone mysql 컨테이너 — 이름이 우리 패턴 아님
  assert.equal(matchesOurConvention('my-db', 'mysql:8'), false);
  assert.equal(matchesOurConvention('production-mysql', 'mysql:8'), false);
  assert.equal(matchesOurConvention('mysql', 'mysql:8'), false);
});

test('false-positive guard: completely unrelated stacks', () => {
  assert.equal(matchesOurConvention('postgres-1', 'postgres:13'), false);
  assert.equal(matchesOurConvention('redis-server', 'redis:7'), false);
  assert.equal(matchesOurConvention('jenkins-master', 'jenkins/jenkins'), false);
  assert.equal(matchesOurConvention('grafana-1', 'grafana/grafana'), false);
});

test('false-positive guard: -fe-1 / -be-1 / -mysql-1 must be at end (not middle)', () => {
  // 중간에 -fe-1 끼어 있어도 안 잡힘 — `\d+$` 정규식이 끝 anchor
  assert.equal(matchesOurConvention('something-fe-1-extra', 'whatever-fe'), false);
  assert.equal(matchesOurConvention('proj-be-1-suffix', 'proj-be'), false);
});

test('false-positive guard: digit-only at end is required (no -fe alone)', () => {
  // 숫자 인덱스가 없는 경우 (compose가 항상 -1, -2 같은 인덱스 붙임)
  assert.equal(matchesOurConvention('test-fe', 'test-fe'), false);
  assert.equal(matchesOurConvention('test-be', 'test-be'), false);
  assert.equal(matchesOurConvention('test-mysql', 'mysql:8'), false);
});

// ─────────── matchesOurConvention: edge cases ───────────

test('edge: empty / null / undefined inputs all return false', () => {
  assert.equal(matchesOurConvention('', 'test-fe'), false);
  assert.equal(matchesOurConvention('test-fe-1', ''), false);
  assert.equal(matchesOurConvention(null, null), false);
  assert.equal(matchesOurConvention(undefined, undefined), false);
  assert.equal(matchesOurConvention('test-fe-1', null), false);
});

test('edge: non-string inputs (numbers / objects) return false', () => {
  assert.equal(matchesOurConvention(123, 'test-fe'), false);
  assert.equal(matchesOurConvention('test-fe-1', { value: 'x' }), false);
});

// ─────────── parseDockerPsRows ───────────

test('parseDockerPsRows: 4-column tab-separated rows', () => {
  const stdout =
    'abc123\ttest-fe-1\ttest-fe\ttrue\n' +
    'def456\tfinalize-be-1\tfinalize-be\t\n';
  const rows = parseDockerPsRows(stdout);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 'abc123', name: 'test-fe-1', image: 'test-fe', isManaged: true });
  assert.deepEqual(rows[1], { id: 'def456', name: 'finalize-be-1', image: 'finalize-be', isManaged: false });
});

test('parseDockerPsRows: blank lines ignored', () => {
  const rows = parseDockerPsRows('\n\nabc\tname\timage\t\n\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'abc');
});

test('parseDockerPsRows: malformed rows (<3 columns) skipped', () => {
  const rows = parseDockerPsRows('only-one\nx\ty\nproper\tname\timage\t\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'proper');
});

test('parseDockerPsRows: missing 4th column → isManaged=false', () => {
  const rows = parseDockerPsRows('abc\tname\timage');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isManaged, false);
});

test('parseDockerPsRows: 4th column with value "true" → isManaged=true', () => {
  assert.equal(parseDockerPsRows('a\tb\tc\ttrue')[0].isManaged, true);
});

test('parseDockerPsRows: 4th column with anything else → isManaged=false', () => {
  assert.equal(parseDockerPsRows('a\tb\tc\tfalse')[0].isManaged, false);
  assert.equal(parseDockerPsRows('a\tb\tc\t1')[0].isManaged, false);
  assert.equal(parseDockerPsRows('a\tb\tc\tyes')[0].isManaged, false);
  assert.equal(parseDockerPsRows('a\tb\tc\t<no value>')[0].isManaged, false);
});

test('parseDockerPsRows: CRLF line endings handled', () => {
  const rows = parseDockerPsRows('abc\tname\timage\ttrue\r\ndef\tn2\ti2\t\r\n');
  assert.equal(rows.length, 2);
});

test('parseDockerPsRows: empty / null / undefined input returns []', () => {
  assert.deepEqual(parseDockerPsRows(''), []);
  assert.deepEqual(parseDockerPsRows(null), []);
  assert.deepEqual(parseDockerPsRows(undefined), []);
});

test('parseDockerPsRows: whitespace trimmed on each field', () => {
  const rows = parseDockerPsRows('  abc  \t  test-fe-1  \t  test-fe  \t  true  ');
  assert.deepEqual(rows[0], {
    id: 'abc',
    name: 'test-fe-1',
    image: 'test-fe',
    isManaged: true,
  });
});

// ─────────── selectVictims ───────────

test('selectVictims: label-managed row → victim with reason=label', () => {
  const rows = [
    { id: 'a', name: 'arbitrary', image: 'arbitrary-image', isManaged: true },
  ];
  const victims = selectVictims(rows);
  assert.equal(victims.length, 1);
  assert.equal(victims[0].reason, 'label');
});

test('selectVictims: convention match (no label) → reason=convention', () => {
  const rows = [
    { id: 'b', name: 'finalize-fe-1', image: 'finalize-fe', isManaged: false },
  ];
  const victims = selectVictims(rows);
  assert.equal(victims.length, 1);
  assert.equal(victims[0].reason, 'convention');
});

test('selectVictims: unrelated containers preserved', () => {
  const rows = [
    { id: 'c', name: 'postgres-1', image: 'postgres:13', isManaged: false },
    { id: 'd', name: 'redis', image: 'redis:7', isManaged: false },
    { id: 'e', name: 'nginx-fe-1', image: 'nginx:latest', isManaged: false }, // 함정
  ];
  assert.deepEqual(selectVictims(rows), []);
});

test('selectVictims: realistic mixed batch (label + convention + preserved)', () => {
  const rows = [
    // Will be killed:
    { id: 'a', name: 'test-fe-1', image: 'test-fe', isManaged: true },                // label
    { id: 'b', name: 'finalize-be-1', image: 'finalize-be', isManaged: false },       // convention
    { id: 'c', name: 'verify-port-fix-mysql-1', image: 'mysql:8', isManaged: false }, // convention
    // Will be preserved:
    { id: 'd', name: 'random', image: 'nginx', isManaged: false },
    { id: 'e', name: 'someones-mysql-1', image: 'postgres:13', isManaged: false },    // wrong image
    { id: 'f', name: 'standalone-mysql', image: 'mysql:8', isManaged: false },        // wrong name pattern
  ];
  const victims = selectVictims(rows);
  assert.equal(victims.length, 3);
  assert.deepEqual(victims.map((v) => v.id), ['a', 'b', 'c']);
  assert.deepEqual(victims.map((v) => v.reason), ['label', 'convention', 'convention']);
});

test('selectVictims: label takes precedence over convention (no double-count)', () => {
  // 라벨 있는 컨테이너도 convention 매칭도 됨 → 결과 한 번만 + reason='label'
  const rows = [
    { id: 'x', name: 'test-fe-1', image: 'test-fe', isManaged: true },
  ];
  const victims = selectVictims(rows);
  assert.equal(victims.length, 1);
  assert.equal(victims[0].reason, 'label');
});

test('selectVictims: empty / null input', () => {
  assert.deepEqual(selectVictims([]), []);
  assert.deepEqual(selectVictims(null), []);
  assert.deepEqual(selectVictims(undefined), []);
});

test('selectVictims: 모든 row가 양쪽 모두 안 맞을 때', () => {
  const rows = [
    { id: 'a', name: 'redis', image: 'redis:7', isManaged: false },
    { id: 'b', name: 'kibana', image: 'kibana:8', isManaged: false },
    { id: 'c', name: 'jenkins-1', image: 'jenkins/jenkins', isManaged: false },
  ];
  assert.deepEqual(selectVictims(rows), []);
});

// ─────────── module shape ───────────

test('exports: MANAGED_LABEL constant', () => {
  assert.equal(MANAGED_LABEL, 'com.myfirstagentapp.managed');
  assert.equal(MANAGED_LABEL_VALUE, 'true');
});

test('exports: NAME_PATTERNS regex objects for each service', () => {
  assert.ok(NAME_PATTERNS.fe instanceof RegExp);
  assert.ok(NAME_PATTERNS.be instanceof RegExp);
  assert.ok(NAME_PATTERNS.mysql instanceof RegExp);
  assert.ok(NAME_PATTERNS.fe.test('whatever-fe-1'));
  assert.ok(NAME_PATTERNS.be.test('whatever-be-99'));
  assert.ok(NAME_PATTERNS.mysql.test('whatever-mysql-1'));
});

// ─────────── full pipeline through parse → select ───────────

test('end-to-end: realistic docker ps output → correct victims', () => {
  // 사용자가 보여준 docker ps 스크린샷의 실제 케이스 + 함정 컨테이너 몇 개
  const stdout = [
    '6a5cfbf77e99\tfinalize-fe-1\tfinalize-fe\t',                 // convention victim
    'd3a4e86f888b\tfinalize-be-1\tfinalize-be\t',                 // convention victim
    'e2158bd4a072\tfinalize-mysql-1\tmysql:8\t',                  // convention victim
    '085f2740eff4\tverify-port-fix-fe-1\tverify-port-fix-fe\t',   // convention victim
    'af29f92de500\tverify-port-fix-be-1\tverify-port-fix-be\t',   // convention victim
    '94c1bd0192c1\tverify-port-fix-mysql-1\tmysql:8\t',           // convention victim
    'aaaa\tunrelated-postgres\tpostgres:13\t',                     // preserved
    'bbbb\tmy-redis-cache\tredis:7\t',                             // preserved
    'cccc\tnginx-fe-1\tnginx:latest\t',                            // preserved (image mismatch)
  ].join('\n');
  const rows = parseDockerPsRows(stdout);
  assert.equal(rows.length, 9);
  const victims = selectVictims(rows);
  assert.equal(victims.length, 6);
  assert.deepEqual(
    victims.map((v) => v.name),
    ['finalize-fe-1', 'finalize-be-1', 'finalize-mysql-1',
     'verify-port-fix-fe-1', 'verify-port-fix-be-1', 'verify-port-fix-mysql-1']
  );
  assert.ok(victims.every((v) => v.reason === 'convention'));
});

test('end-to-end: label + legacy mix', () => {
  const stdout = [
    'newid1\ttest-fe-1\ttest-fe\ttrue',          // label victim (new container)
    'newid2\ttest-be-1\ttest-be\ttrue',          // label victim
    'newid3\ttest-mysql-1\tmysql:8\ttrue',       // label victim
    'oldid1\tfinalize-fe-1\tfinalize-fe\t',      // convention victim
    'safe1\tcustomer-postgres\tpostgres:13\t',   // preserved
  ].join('\n');
  const rows = parseDockerPsRows(stdout);
  const victims = selectVictims(rows);
  assert.equal(victims.length, 4);
  assert.equal(victims.filter((v) => v.reason === 'label').length, 3);
  assert.equal(victims.filter((v) => v.reason === 'convention').length, 1);
});
