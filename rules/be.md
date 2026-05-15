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

### 3-α. ⚠️ `GET /health` endpoint — **반드시 정의** (placeholder smoke test가 검증)

`lib/stack_templates/BE/src/server.test.js`(placeholder, 절대 수정 불가)가 다음을 검증한다:

```js
const res = await request(app).get('/health');
expect(res.status).toBe(200);
expect(res.body.success).toBe(true);
```

즉 **server.js는 항상 다음 3가지를 만족**해야 한다 (하나라도 누락하면 Stage 3 jest 즉시 FAIL):

1. `app.get('/health', ...)` 라우트 정의
2. `res.status(200)` + `res.json({ success: true, data: { status: 'ok' } })` 응답
3. `module.exports = app` (supertest가 require해서 호출)

응답에 `BE/src/server.js`를 포함시킬 거면 반드시 다음 골격을 보존하라 (다른 비즈니스 라우트는 그 위에 추가):

```js
'use strict';
const express = require('express');
const app = express();
app.use(express.json());

// ⚠️ 필수 — placeholder smoke test 통과를 위해
app.get('/health', (_req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok' } });
});

// ... 비즈니스 routes (app.use('/api/...', ...)) 여기에 추가 ...

if (require.main === module) {
  const port = process.env.BE_PORT || 3001;
  app.listen(port, () => console.log(`[BE] listening on ${port}`));
}

module.exports = app;   // jest supertest가 require해 사용
```

**경험적 사고 패턴**: LLM이 server.js를 통째 새로 쓰면서 `/health`를 자주 누락한다. *응답에 server.js를 넣을 거면* 위 골격을 그대로 유지하고 *비즈니스 라우트만 추가*하는 게 정상 경로. 혹은 server.js를 아예 응답에 넣지 않고 placeholder 그대로 두면서 routes만 새로 emit하는 것도 OK (bootstrap idempotent라 placeholder 보존됨).

### 3-zero. 컨테이너 sanity — *반드시 지킬 4가지* (위반 시 Lint Stage 1 즉시 FAIL, D45)

placeholder의 *port·listen·middleware 코드는 절대 갈아치우지 말 것*. 학습 데이터의 Heroku/PaaS 패턴을 무의식적으로 적용하면 컨테이너가 *시작은 됐는데 listen을 잘못 잡아* PostTest의 `fetch failed` 사고 발생. 다음 4가지는 `lib/container_sanity.js`가 정적 grep으로 검출 → 위반 시 Stage 1 FAIL + retry:

1. **`process.env.PORT` 사용 금지** — Heroku 컨벤션. 본 시스템 docker-compose는 `BE_PORT=3001`을 주입.
   ```js
   // ❌ const port = process.env.PORT || 3000;
   // ✅ const port = process.env.BE_PORT || 3001;
   ```
2. **`app.listen(port, 'localhost')` 또는 `'127.0.0.1'` 금지** — 컨테이너 외부(호스트/다른 컨테이너)에서 접근 불가 → ECONNREFUSED.
   ```js
   // ❌ app.listen(port, 'localhost', () => ...);
   // ✅ app.listen(port, () => ...);          // 호스트 인자 무지정
   // ✅ app.listen(port, '0.0.0.0', () => ...); // 명시
   ```
3. **`if (require.main === module)` 가드 *반드시 보존*** — jest가 server.js를 require할 때 listen이 자동 시작되면 port 충돌 또는 테스트 hang.
   ```js
   // ❌ app.listen(port, () => ...);    // top-level
   // ✅ if (require.main === module) {
   //      app.listen(port, () => ...);
   //    }
   //    module.exports = app;            // jest는 app 객체를 require해서 supertest로 검증
   ```
4. **`express.json()` middleware *반드시 모든 route 등록 전*** — 누락하면 POST body가 `undefined` → handler 안에서 throw 또는 잘못된 400.
   ```js
   // ✅
   app.use(express.json());      // route 전
   app.use('/api/v1/auth', authRoutes);
   ```

placeholder (`lib/stack_templates/BE/src/server.js`)는 위 4가지를 모두 만족하는 정답 패턴이다. **port 핸들링 + listen 가드 + middleware 코드는 그대로 두고 route 등록만 추가**하는 게 정상 경로.

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
- **비즈니스 DB schema가 필요하면** `BE/db/migrations/<UTC ts>_<name>.sql` 파일을 emit (D33). orchestrator Phase 2.5가 자동 적용. **자세한 규칙·함정·예시는 `rules/db.md` 참조** — 특히 *적용된 migration 수정 금지 (checksum 충돌 사고 방지)* 와 *idempotent 작성*은 반드시 읽을 것.
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

### 7-ter. 모듈에서 비즈니스 함수를 *반드시* export (Stage 3 BE측 흔한 실패)

시스템 smoke test는 `const mod = require('./auth_service'); expect(typeof mod.signup).toBe('function');`처럼 *export된 함수의 타입*을 검증한다. 함수가 export 안 되면 `typeof undefined === 'undefined'` → 실패.

**나쁨** — 함수 정의는 했지만 export 안 함:
```js
// auth_service.js
async function signup(email, password) { ... }
async function login(email, password) { ... }
// (module.exports가 없음 → mod = {} 가 됨)
```

**좋음** — 모든 비즈니스 함수를 명시적으로 export:
```js
// auth_service.js
async function signup(email, password) { ... }
async function login(email, password) { ... }

module.exports = { signup, login };
```

핵심 룰:
- BE는 CommonJS. `module.exports = { fnA, fnB, ... }` 패턴.
- 한 파일에 여러 함수가 있으면 *모두* exports에 포함 (smoke test가 어떤 걸 검증할지 모르므로).
- ES Modules 문법(`export default`, `export function`)은 BE에서 *금지* — `rules/be.md` §2 참조.

## 8. 보호 파일 (BE)

정확한 list는 `lib/stack.config.json`의 `BE.protectedConfigFiles`에서 매 호출마다 자동 주입됨. 현재 값:

- 의존성 매니페스트: `BE/package.json`, `BE/package-lock.json`
- Lint 설정: `BE/.eslintrc.json`
- Docker 설정: `BE/Dockerfile`, `BE/.dockerignore`

(Jest 설정은 `BE/package.json`의 `"jest"` key에 인라인 — 별도 `jest.config.*` 파일은 없음.)

**응답에 절대 포함하지 말 것**. 응답에 들어가면 1차로 `dropProtectedFiles`가 silent drop, 그래도 새 나간 케이스는 `Orchestrator.validatePaths`가 throw해 라운드 전체가 ERROR. 자세한 행동 규칙은 `rules/common.md` §9 참조.
