# BE Convention (Backend-Specific)

이 문서는 BE Agent **전용** 규칙입니다. 공통 규칙은 `rules/common.md` 참조 — 두 문서를 합쳐 BE Agent의 system prompt에 주입됩니다.

## 1. 파일명 (BE)

- BE 파일명: `snake_case` (예: `user_service.js`, `auth_router.js`, `db_helper.js`)
- **테스트 파일은 Agent가 작성하지 않는다** — `lib/test_codegen.js`가 비즈니스 코드를 분석해 결정론적으로 smoke test (`<name>.test.js`)를 자동 생성한다. Agent가 응답에 `*.test.js` 파일을 포함하면 `dropAgentGeneratedTests`가 silent drop한다.

## 2. 모듈/임포트 (BE)

- **CommonJS 사용** (`require` / `module.exports`)
- ES Modules import/export 사용 금지

```js
// 좋음
const express = require('express');
module.exports = { signupHandler };

// 나쁨 (BE는 CommonJS)
import express from 'express';
export default signupHandler;
```

## 3. 진입점 — `BE/src/server.js`

- bootstrap이 깔아둔 `server.js` placeholder가 있으면 **그 응답 형식·동작을 보존**하면서 비즈니스 로직 추가.
- `GET /health` 엔드포인트는 placeholder 테스트가 기대하는 형식(`{ success: true, data: { status: 'ok' } }`) 그대로 유지.

### 3-bis. Contract endpoint mount — *모든* endpoint 빠짐없이 구현 (필수)

`shared/api_contract.json`에 선언된 **모든** endpoint는 `BE/src/server.js` + `BE/src/routes/*.js`에 mount해야 한다. 하나라도 빠지면 **Phase 2.7 ContractSync (정적 분석)** 가 즉시 FAIL → 다음 retry의 `fix_instructions`로 누락 list 전달. *retry로 풀지 말고 첫 응답에서 모두 mount하는 게 정상 경로*.

mount 패턴 (변수명·경로는 *해당 cycle의 api_contract*에 따라 결정 — 아래는 형태만 보여주는 placeholder):

```js
// BE/src/server.js
const <feature>Routes = require('./routes/<feature>_routes');
app.use('<공통 prefix>', <feature>Routes);  // prefix from contract

// BE/src/routes/<feature>_routes.js
router.<method>('<subpath>', handler);       // subpath from contract
// 최종 경로 = prefix + subpath = api_contract endpoint path와 *정확히 일치*해야 함
```

구체 예시 (auth 시나리오):
- `app.use('/api/v1/auth', authRoutes)` + `router.post('/signup', ...)` → `POST /api/v1/auth/signup`
- `app.use('/api/v1', resultRoutes)` + `router.get('/best', ...)` → `GET /api/v1/best`

→ 변수명(authRoutes, resultRoutes), prefix(/api/v1/auth, /api/v1), subpath(/signup, /best)는 *모두* 이 시나리오의 예시값. 다른 cycle의 contract면 다른 값을 써야 한다.

핵심 룰:
- 최종 path = `app.use prefix` + `router.<method> subpath`. **둘 다 정확해야 contract path와 매칭**.
- ContractSync는 `(METHOD, full path)` tuple로 비교. OpenAPI 스타일 `{id}` ↔ Express 스타일 `:id`는 동등 처리.
- contract에 *없는* extra endpoint를 만들지는 말 것 (warning은 나지만 FAIL은 아님 — FE는 contract만 보므로 dead code가 됨).
- prompt에 `## 구현해야 할 endpoint` 체크리스트가 함께 표시되므로 그것을 빠짐없이 확인할 것 (D39, 2026-05-14).

## 4. DB 접근 패턴

- `mysql2` 패키지 사용 (`allowedDeps`에 등록됨).
- 항상 prepared statement (`?` placeholder) — 공통 규칙 §2 보안 참조.
- DB 풀 연결은 `lib/db.js` 패턴 참고:
  ```js
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await pool.execute('SELECT ... WHERE email = ?', [email]);
  ```
- **단일 DB 가정 (D29=A)**: BE 컨테이너는 호스트 MySQL(`host.docker.internal`)
  에 직접 연결한다. 환경 변수(`DB_HOST` 등)는 docker-compose.yml이 주입하므로
  *BE 코드는 host/port를 hardcode하면 안 된다*. 항상 `process.env.DB_*` 만.
- **`db/agent_schema.sql`은 Agent 도구 전용** (D31, 2026-05-13). 거기 정의된 `log_agent_runs`, `log_agent_decisions`, `log_task_state`, `log_db_migrations`는 모두 *agent system 전용* — 비즈니스 코드에서 절대 SELECT/INSERT/UPDATE/DELETE 금지.
- **비즈니스 DB schema가 필요하면 `BE/db/migrations/<YYYYMMDDHHmmss>_<snake_case_name>.sql` 파일을 emit** (D33, 2026-05-14, B-2). orchestrator Phase 2.5가 그 파일을 *자동으로 MySQL에 적용*하고 `log_db_migrations`에 이력을 남긴다.
  - 파일명: `<UTC timestamp>_<name>.sql`. 알파벳 순서 = 시간순 적용 보장.
  - **idempotent하게 작성**: `CREATE TABLE IF NOT EXISTS ...`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` (MySQL 8 지원). 한 번 적용된 migration이 다시 실행되지는 않지만(checksum 체크), 사람이 reset 후 처음부터 재실행할 때도 안전.
  - **이미 적용된 migration 파일은 *수정 금지*** — 시스템이 checksum 변경을 감지하면 즉시 FAIL + retry 흐름 진입. 변경이 필요하면 *새 timestamp의 추가 migration*을 만들 것.
  - 한 cycle에 1~3개 migration만 emit. 관련된 변경(테이블 + 인덱스 + FK)은 한 파일에 묶을 수 있음.
  - `USE myfirstagentapp_db;` 문 불필요 — orchestrator가 `database` 옵션으로 connection 함.
- migration이 만든 비즈니스 테이블만 BE 코드(routes/services 등)에서 SELECT/INSERT/UPDATE/DELETE 가능. 회원가입 같은 영속 기능도 이 흐름으로 표현 (in-memory 우회 불필요).

## 5. 비밀번호 처리

- 저장 시: `bcrypt.hash(password, 10)`
- 검증 시: `bcrypt.compare(plain, hashed)`
- 평문 비교(`if (password === stored)`) 절대 금지.
- **`bcrypt` 패키지만 사용 — `bcryptjs`는 NOT `bcrypt`** (이름은 비슷하지만 별도 패키지로, `allowedDeps`에 없음). `require('bcryptjs')` 절대 금지. `validateAllowedDeps` 가드가 즉시 ERROR로 잡음.

## 5-bis. 입력 검증 — allowedDeps만 사용 (위반 시 즉시 ERROR)

- 이메일 검증: **regex로 직접** 처리. `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)` 정도면 충분.
- 비밀번호 길이: `password.length >= 8` 같은 단순 검사.
- **`require('email-validator')`, `require('joi')`, `require('zod')`, `require('validator')` 절대 금지** — 응답 시점에 `validateAllowedDeps` 가드가 잡아 라운드 ERROR.
- 외부 HTTP 호출: Node.js builtin `https`/`http`, 또는 Node 18+ global `fetch`만. `axios` 등 금지.
- UUID: `crypto.randomUUID()` (Node builtin) 사용. `uuid` 패키지 금지.
- JWT/세션: 본 PoC 스코프에선 사용 안 함. 필요하면 `notes`에 적고 코드는 만들지 말 것.

## 6. 에러 핸들링

- try/catch로 잡고, 5xx로 응답할 때는 `{ success: false, error: '...' }` 형식 유지.
- 클라이언트 에러(4xx)는 구체적 메시지, 서버 에러(5xx)는 일반화된 메시지 (스택 트레이스 노출 금지).

## 7. 테스트 (BE) — 시스템이 자동 생성

- **단위 테스트는 시스템(`lib/test_codegen.js`)이 결정론적으로 자동 생성**한다. Agent는 비즈니스 코드만 emit.
- 응답에 `*.test.js` 파일을 포함하면 `dropAgentGeneratedTests`가 silent drop. disk에 작성되지 않으며 출력 토큰만 낭비됨.
- 시스템이 emit하는 BE smoke test 형태 (참고용, 실제 결정은 `lib/test_codegen.js`):
  ```js
  const moduleX = require('./moduleX');
  describe('moduleX.js (auto-generated smoke test)', () => {
    it('exposes its declared exports', () => {
      expect(typeof exportedFn).toBe('function');
    });
  });
  ```
- 도구·환경: 시스템 생성 test도 **Jest + Supertest** 가정의 환경에서 실행 (`lib/stack.config.json` BE 블록의 `lint.stage3` = `jest --runInBand`). `BE/package.json`에 `jest`/`supertest` dep는 그대로 유지 (미래 확장 대비).

### 7-bis. Stage 3 smoke test 친화적 export (D30=A)

시스템 자동 생성 test는 `typeof exportedFn === 'function'`을 검증한다. 모듈이 require될 때 *throw하지 않고* 비즈니스 함수를 export해야 한다.

흔한 실패 패턴 — 모듈 top-level에서 환경변수 누락 시 throw:
```js
// 나쁨 — DB_PASSWORD 빈 값이면 module load 시점에 throw
if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD missing');
const pool = mysql.createPool({...});
module.exports = { signupHandler };
```

```js
// 좋음 — pool은 lazy, env 검증은 핸들러 호출 시점에
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  password: process.env.DB_PASSWORD || '',
  // ...
});
async function signupHandler(req, res) {
  if (!process.env.DB_PASSWORD) {
    return res.status(500).json({ success: false, error: '...' });
  }
  // ...
}
module.exports = { signupHandler };
```

Stage 3 실패 시 시스템이 `fix_instructions`로 jest 출력 전달 + LLM에게 최대 `MAX_RETRIES`(3)회 재시도 요청. 첫 시도부터 룰을 따르는 게 정상 경로.
- bootstrap이 깐 placeholder test (예: `server.test.js`)는 disk에 그대로 보존된다 — 시스템 자동 생성도 placeholder는 덮어쓰지 않음 (`isTestFile()` skip).
- **Agent의 책임**: placeholder test가 통과되도록 비즈니스 코드를 작성. test 코드 작성은 Agent의 책임이 아님.

## 8. 보호 파일 (BE)

정확한 list는 `lib/stack.config.json`의 `BE.protectedConfigFiles`에서 매 호출마다 자동 주입됨. 현재 값:

- 의존성 매니페스트: `BE/package.json`, `BE/package-lock.json`
- Lint 설정: `BE/.eslintrc.json`
- Docker 설정: `BE/Dockerfile`, `BE/.dockerignore`

(Jest 설정은 `BE/package.json`의 `"jest"` key에 인라인 — 별도 `jest.config.*` 파일은 없음.)

**응답에 절대 포함하지 말 것**. 응답에 들어가면 1차로 `dropProtectedFiles`가 silent drop, 그래도 새 나간 케이스는 `Orchestrator.validatePaths`가 throw해 라운드 전체가 ERROR. 자세한 행동 규칙은 `rules/common.md` §9 참조.
