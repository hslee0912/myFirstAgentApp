/**
 * BE migration SQL 정적 검증 (D48, 2026-05-14).
 *
 * 배경:
 *   big-cycle 4 사고 — LLM이 `CREATE INDEX IF NOT EXISTS ...` 패턴을 emit
 *   (PostgreSQL 문법). MySQL은 이 옵션 미지원 → syntax error → Migration FAIL.
 *   사용자 보고 사고 패턴: 학습 데이터의 PostgreSQL/일반 SQL 패턴을 MySQL에 잘못
 *   적용. retry 흐름 안에서 잡혀도 LLM 호출 비용 발생 → *Lint Stage 1*에서
 *   *Migration Agent 호출 전에* 정적 grep으로 차단.
 *
 * 흐름:
 *   Lint Agent Stage 1 시작 직전 BE target에서 container_sanity 다음에 호출 →
 *   위반 발견 시 즉시 Stage 1 FAIL + fix_instructions. eslint·jest 안 돌림.
 *
 * 검출하는 antipattern:
 *   1. CREATE INDEX [IF NOT EXISTS] — MySQL 미지원 (사용자 보고 사고 정확 재현)
 *   2. (확장 여지) DROP INDEX IF NOT EXISTS — 헷갈리기 쉬운 비대칭 (DROP은 IF
 *      EXISTS, CREATE는 IF NOT EXISTS — 단 MySQL은 CREATE INDEX에 옵션 자체
 *      없음)
 *
 * 본 모듈은 *읽기 전용*. 파일 mutation 안 함.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'BE', 'db', 'migrations');

/**
 * `BE/db/migrations/*.sql` 전체를 grep해서 antipattern 검출.
 *
 * @param {string} [migrationsDir]  default: BE/db/migrations
 * @returns {{
 *   pass: boolean,
 *   skipped?: 'no_dir'|'no_files',
 *   violations: Array<{file:string, rule:string, line?:number, snippet:string, hint:string, fix:string}>,
 *   fix_instructions: string,
 * }}
 */
function checkMigrationSanity(migrationsDir) {
  const dir = migrationsDir || MIGRATIONS_DIR;

  if (!fs.existsSync(dir)) {
    return { pass: true, skipped: 'no_dir', violations: [], fix_instructions: '' };
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    return { pass: true, skipped: 'no_files', violations: [], fix_instructions: '' };
  }

  const violations = [];
  for (const filename of files) {
    const full = path.join(dir, filename);
    const raw = fs.readFileSync(full, 'utf8');
    // 주석 strip — false positive 회피 (-- 단행, /* */ 블록)
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])--[^\n]*/g, '$1');

    // ① CREATE INDEX [optional UNIQUE/FULLTEXT/SPATIAL] IF NOT EXISTS — MySQL 미지원
    //    경우의 수: "CREATE INDEX IF NOT EXISTS", "CREATE UNIQUE INDEX IF NOT EXISTS",
    //               "CREATE FULLTEXT INDEX IF NOT EXISTS" 등. 모두 잡음.
    const reCreateIndexIfNotExists =
      /\bCREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi;
    let m;
    while ((m = reCreateIndexIfNotExists.exec(code)) !== null) {
      const lineNo = lineNumberAt(code, m.index);
      const snippet = extractLine(code, m.index);
      violations.push({
        file: 'BE/db/migrations/' + filename,
        rule: 'CREATE_INDEX_IF_NOT_EXISTS_MYSQL_UNSUPPORTED',
        line: lineNo,
        snippet: snippet.slice(0, 200),
        hint: 'MySQL은 `CREATE INDEX`에 `IF NOT EXISTS` 옵션을 지원하지 않습니다 (PostgreSQL 전용 문법).',
        fix: '인덱스를 `CREATE TABLE` 정의 안으로 옮기거나, 별도 migration 파일에서 `ALTER TABLE x ADD INDEX idx_name (...)` 사용. 자세한 패턴은 rules/db.md §4-bis 참조.',
      });
    }
  }

  return {
    pass: violations.length === 0,
    violations,
    fix_instructions: violations.length === 0 ? '' : buildFixInstructions(violations),
  };
}

function lineNumberAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

function extractLine(text, idx) {
  let start = idx;
  while (start > 0 && text.charCodeAt(start - 1) !== 10) start--;
  let end = idx;
  while (end < text.length && text.charCodeAt(end) !== 10) end++;
  return text.slice(start, end).trim();
}

function buildFixInstructions(violations) {
  const lines = [];
  lines.push('[LINT STAGE1 / migration_sanity] BE/db/migrations/*.sql에 MySQL 비호환 SQL 패턴이 있습니다.');
  lines.push('rules/db.md §4-bis (인덱스 idempotent 패턴) 참조.');
  lines.push('');
  let i = 1;
  for (const v of violations) {
    lines.push(`${i}. ${v.rule}  (${v.file}:${v.line || '?'})`);
    lines.push(`   - 코드: ${v.snippet}`);
    lines.push(`   - 문제: ${v.hint}`);
    lines.push(`   - 해결: ${v.fix}`);
    i++;
  }
  return lines.join('\n');
}

module.exports = {
  checkMigrationSanity,
  _internal: { lineNumberAt, extractLine, buildFixInstructions },
};
