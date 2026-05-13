/**
 * BE container sanity — server.js 정적 검증 (D45, 2026-05-14).
 *
 * 배경:
 *   - PostTest `fetch failed` 사고: LLM이 placeholder의 *port 코드까지 갈아치움*
 *     (`process.env.PORT || 3000` ← Heroku 컨벤션). docker-compose는 호스트 3001
 *     → 컨테이너 3001 매핑인데 BE는 3000에 listen → ECONNREFUSED.
 *   - rules에 *원칙*만 박아도 LLM이 학습 데이터 패턴(Heroku PORT)을 자동 적용
 *     하는 사고가 반복. 정적 grep으로 *retry 흐름 안에서* 잡아 사고 차단.
 *
 * 흐름:
 *   Lint Agent Stage 1 시작 직전 BE target에서만 호출 → 위반 발견 시 즉시
 *   Stage 1 FAIL + fix_instructions 채워서 retry 흐름 진입. eslint는 *안 돌림*
 *   (이미 명백한 위반).
 *
 * 검출하는 4 antipattern (사용자 보고 사고 기반):
 *   1. process.env.PORT 사용 — Heroku 스타일. 본 시스템은 BE_PORT.
 *   2. app.listen(port, 'localhost') — 컨테이너 외부 접근 불가.
 *   3. if (require.main === module) 가드 *부재* — jest 시점 listen 시작 위험.
 *   4. express.json() middleware *부재* — POST body undefined → 500.
 *
 * 본 모듈은 *읽기 전용*. 파일 mutation 안 함.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * BE/src/server.js만 검사. 다른 파일은 LLM이 직접 다루지 않음 (route 안에서
 * listen 또는 PORT 사용은 비정상적이므로 stage 2/3에서 잡힘).
 *
 * @param {string} [beRoot]  default: BE/ 절대경로
 * @returns {{
 *   pass: boolean,
 *   skipped?: 'no_server',
 *   violations: Array<{rule:string, line?:number, hint:string, fix:string}>,
 *   fix_instructions: string,
 * }}
 */
function checkBeServerSanity(beRoot) {
  const root = beRoot || path.join(ROOT, 'BE');
  const serverPath = path.join(root, 'src', 'server.js');

  if (!fs.existsSync(serverPath)) {
    return { pass: true, skipped: 'no_server', violations: [], fix_instructions: '' };
  }

  const raw = fs.readFileSync(serverPath, 'utf8');
  // 주석 제거 후 검사 — 주석 안의 antipattern은 false positive 회피.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const violations = [];

  // ① process.env.PORT 사용 금지 (Heroku 컨벤션 — 본 시스템엔 BE_PORT)
  //    경계 `\b` 사용해 BE_PORT나 PORT_X 같은 다른 변수명은 false positive 회피.
  const reHerokuPort = /\bprocess\.env\.PORT\b/;
  if (reHerokuPort.test(code)) {
    violations.push({
      rule: 'PROCESS_ENV_PORT',
      hint: '`process.env.PORT` 는 Heroku 컨벤션입니다. 본 시스템 docker-compose는 BE_PORT=3001을 주입합니다.',
      fix: '`const port = process.env.BE_PORT || 3001;` 로 변경하세요.',
    });
  }

  // ② app.listen(port, 'localhost' | '127.0.0.1') 금지
  //    컨테이너 내부 localhost만 잡으면 외부에서 접근 불가 (ECONNREFUSED).
  const reListenLocalhost = /app\.listen\s*\([^,)]+,\s*['"](?:localhost|127\.0\.0\.1)['"]/;
  if (reListenLocalhost.test(code)) {
    violations.push({
      rule: 'LISTEN_LOCALHOST_ONLY',
      hint: '`app.listen(port, \'localhost\')` 는 컨테이너 내부에서만 접근 가능. 외부(호스트, 다른 컨테이너)에서 접근 불가.',
      fix: '호스트 인자 없이 `app.listen(port, () => ...)` 또는 명시적으로 `\'0.0.0.0\'`을 사용하세요.',
    });
  }

  // ③ require.main === module 가드 부재 검출 (jest가 server.js를 require 할 때
  //    listen이 시작되어 port 충돌 또는 test hang. placeholder는 이 가드를 가짐).
  //    app.listen 호출이 *있는데* 가드가 *없는* 경우만 위반.
  const hasListen = /\bapp\.listen\s*\(/.test(code);
  const hasMainGuard = /require\.main\s*===\s*module/.test(code);
  if (hasListen && !hasMainGuard) {
    violations.push({
      rule: 'MISSING_REQUIRE_MAIN_GUARD',
      hint: 'app.listen()이 module top-level에 있으면 jest가 server.js를 require할 때 listen이 시작되어 port 충돌·테스트 hang.',
      fix: '`if (require.main === module) { app.listen(port, () => ...); }` 로 감싸세요.',
    });
  }

  // ④ express.json() middleware 부재 — POST body 파싱 필수.
  //    app.use(express.json()) 또는 app.use(json()) 등.
  const hasJsonMiddleware = /app\.use\s*\(\s*(?:express\.)?json\s*\(/.test(code);
  if (!hasJsonMiddleware) {
    violations.push({
      rule: 'MISSING_JSON_MIDDLEWARE',
      hint: 'express.json() middleware 없으면 POST body가 undefined → handler 안에서 throw 또는 잘못된 400.',
      fix: '`app.use(express.json());` 를 모든 route 등록 *전*에 추가하세요.',
    });
  }

  return {
    pass: violations.length === 0,
    violations,
    fix_instructions: violations.length === 0 ? '' : buildFixInstructions(violations),
  };
}

/**
 * fix_instructions 텍스트 조립. Lint Stage 1 실패 형태와 일관된 포맷.
 */
function buildFixInstructions(violations) {
  const lines = [];
  lines.push('[LINT STAGE1 / container_sanity] BE/src/server.js에 컨테이너 sanity 위반이 있습니다.');
  lines.push('정상 placeholder 패턴은 lib/stack_templates/BE/src/server.js 또는 rules/be.md §3 참조.');
  lines.push('');
  let i = 1;
  for (const v of violations) {
    lines.push(`${i}. ${v.rule}`);
    lines.push(`   - 문제: ${v.hint}`);
    lines.push(`   - 해결: ${v.fix}`);
    i++;
  }
  return lines.join('\n');
}

module.exports = {
  checkBeServerSanity,
  // exported for unit tests only
  _internal: { buildFixInstructions },
};
