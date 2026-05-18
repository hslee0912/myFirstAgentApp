# BE Convention (Backend-Specific)

이 문서는 BE Agent **전용** 규칙입니다. 공통 규칙은 `rules/common.md` 참조 — 두 문서를 합쳐 BE Agent의 system prompt에 주입됩니다.

## ⚠️ BE 응답 emit 전 자가 체크 (필독 — BE에서 자주 어기는 4개)

응답 JSON 직렬화 직전 마지막 확인. 하나라도 어기면 round ERROR 또는 STAGE 3 FAIL.

1. **🚫 `require('bcrypt')` 정확 철자** — *NOT* `require('bcryptjs')`. `bcryptjs`는 별도 패키지로 allowedDeps에 없다. 회원가입/로그인 기능 만들 때 *가장 흔한 위반*. `const bcrypt = require('bcrypt');` 한 줄 그대로 사용. §5-bis 참조.
2. **🩺 `GET /health` endpoint 반드시 정의** — `app.get('/health', ...)` + `res.json({ success: true, data: { status: 'ok' } })` + `module.exports = app`. 누락 시 placeholder smoke test fail. §3-α 참조.
3. **🔗 contract endpoint 빠짐 없이 mount** — `shared/api_contract.json`의 *모든* endpoint를 `server.js` + `routes/*.js`에 mount. 한 개라도 빠지면 Phase 2.7 ContractSync FAIL. §3-bis 참조.
4. **📦 모든 비즈니스 함수 `module.exports`에 포함** — `auth_service.js`에 `signup`, `login` 정의했으면 `module.exports = { signup, login };` 둘 다. 누락 시 smoke test가 `typeof undefined` fail. §7-ter 참조.

---

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

## 5-bis. 🚫 BE allowedDeps (위반 시 즉시 ERROR) — common.md §9-bis 참조

> **일반 금지 패키지 표 + self-check 절차는 `rules/common.md` §9-bis 참조.** 이 절은 *BE 한정* 정보만.

### BE allowedDeps (정확 7개)

```
express, mysql2, bcrypt, cors, dotenv, jest, supertest
```

→ 이 7개 + 상대경로 + Node.js builtin 외엔 *어떤 require/import도 emit 금지*.

### ⚠️ `bcrypt` vs `bcryptjs` — 가장 흔한 BE 위반

- **`require('bcrypt')`** ← 정확한 철자. allowedDeps에 있음.
- `require('bcryptjs')` ← **별도 패키지**. allowedDeps에 *없음*. 즉시 `UNAUTHORIZED_DEPS` ERROR.
- 사용자 prompt에 "회원가입" 있으면 자동 완성 IDE 패턴 따라 `bcryptjs` 시도 빈번 — *반드시* `bcrypt` 정확 입력.

### 부수

- 비밀번호 길이: `password.length >= 8` 단순 검사.
- JWT/세션: PoC 스코프 밖 — `notes`에만.
- HTTP 호출은 builtin `https`/`http` 또는 global `fetch`. UUID는 `crypto.randomUUID()`.

## 5-ter. ⚠️ 시드 데이터 정합성 — *명세서의 시드가 모든 validation을 통과해야 함* (PostTest 연쇄 fail 방지)

> 명세서의 `4-3. 시드 데이터` 가 `INSERT IGNORE`로 들어가도, **signup/login/auth-check 핸들러의 validation regex와 충돌**하면 PostTest의 `duplicate_username` / `valid_credentials` / `valid_query_exists` 시나리오가 일제히 400/401 fail. 시드는 *런타임 검사를 우회해 INSERT*되지만 그 시드를 *대상으로 호출하는 모든 endpoint*는 똑같은 validation을 거친다.

**자가 점검 (migration + service 작성 후, 응답 emit 전):**

1. **username regex가 시드 username을 통과하는가** — 시드 `demo_user`는 underscore 포함 → regex는 반드시 `[a-zA-Z0-9_]{4,16}` (underscore 누락 시 duplicate 시나리오가 409 대신 400 으로 fail).
2. **password_hash가 *시드 평문 password*의 실제 bcrypt 해시인가** — 임의의 60자 문자열로 채우면 `bcrypt.compare('Pass1234', hash)` → false → login valid_credentials 시나리오가 401 fail.
3. migration의 `INSERT IGNORE` 값은 *signup endpoint를 통과 가능한 형태*여야 한다 — signup → DB가 아니라 *signup 후 다시 그 username을 endpoint로 조회/로그인하는 시나리오*가 PostTest에 있기 때문.

```sql
-- ✅ 시드 정합성 OK
INSERT IGNORE INTO player_users (username, password_hash, player_name)
VALUES ('demo_user', '$2b$10$<Pass1234의 실제 bcrypt 해시 60자>', '데모용사');
-- + auth_service의 username regex = /^[a-zA-Z0-9_]{4,16}$/

-- ❌ 정합성 깨짐 — username regex 충돌
INSERT IGNORE ... VALUES ('demo_user', ...);
-- + regex = /^[a-zA-Z0-9]{4,16}$/  ← underscore 누락 → PostTest fail
```

권장 hash 생성 명령(터미널, 결과 그대로 SQL에 paste):

```
node -e "console.log(require('bcrypt').hashSync('Pass1234', 10))"
```

## 6. 에러 핸들링

- try/catch로 잡고, 5xx로 응답할 때는 `{ success: false, error: '...' }` 형식 유지.
- 클라이언트 에러(4xx)는 구체적 메시지, 서버 에러(5xx)는 일반화된 메시지 (스택 트레이스 노출 금지).
- ⚠️ `catch (err)` 안에 **반드시 `console.error('[<endpoint> error]', err);`** 추가 — 500 원인 추적 가능. 침묵 catch 금지.

## 6-bis. 🚫 API 통신 흔한 함정 — 모든 endpoint에 *반드시* 적용 (PostTest 랜덤 fail 방지)

> ⚠️ **rules에 명시해도 LLM이 자주 어기는 4가지 — 매 endpoint 핸들러 작성 직전 self-check.**

### (1) datetime은 MySQL 형식으로 변환 후 INSERT

MySQL `DATETIME` 컬럼은 `'YYYY-MM-DD HH:MM:SS'` 형식만 받음. FE가 보내는 ISO 8601 (`new Date().toISOString()` → `'2026-05-18T07:30:45.123Z'`)을 *그대로* INSERT하면 `ER_TRUNCATED_WRONG_VALUE` → 500.

```js
// ✅ 반드시 변환
const mysqlTime = new Date(play_time).toISOString().slice(0, 19).replace('T', ' ');
await pool.execute('INSERT ... VALUES (..., ?)', [..., mysqlTime]);

// ❌ 그대로 넣음 — 500
await pool.execute('INSERT ... VALUES (..., ?)', [..., play_time]);
```

### (2) response data 필드에 `null` 금지 — contract type 유지

contract response schema가 `type: integer` / `string`이라 선언했으면 응답에 `null` 넣지 말 것. 빈 이력·미존재 경우엔 **default 값으로 채울 것** (정수=0, 문자열=`'none'`/`''`).

```js
// ✅ default 값
if (rows.length === 0) return { best_score: 0, stage_reached: 0, weapon_used: 'none' };

// ❌ null — PostTest schema 검증 fail
if (rows.length === 0) return { best_score: 0, stage_reached: null, weapon_used: null };
```

### (3) HTTP status code 정확성 (contract와 일치)

| 상황 | status | 응답 body |
|---|---|---|
| 신규 리소스 생성 (INSERT 성공) | **201** | `{success:true, data:{...}}` |
| 정상 조회/처리 (GET, login 등) | **200** | `{success:true, data:{...}}` |
| 입력 검증 실패 (필수 필드 누락, 형식 위반, enum 미일치, 범위 위반) | **400** | `{success:false, error:"<구체적 메시지>"}` |
| 인증 실패 (잘못된 username/password — 어느 쪽이 틀렸는지 누설 X) | **401** | `{success:false, error:"Invalid username or password"}` |
| 충돌 (UNIQUE 위반 — 이미 가입된 username 등) | **409** | `{success:false, error:"Username already exists"}` |
| 서버 내부 throw (catch 안) | **500** | `{success:false, error:"Internal server error"}` |

POST endpoint가 INSERT 성공 시 200 응답하면 PostTest는 *contract의 201과 mismatch*로 FAIL. 항상 contract의 declared statuses 와 정확히 일치.

### (4) error 응답 형식 일관 — `{success:false, error:string}`

쓰는 message는 짧고 사용자 노출 가능한 수준 (스택 트레이스 X). FE가 `if (!json.success) showError(json.error)` 로 일관 처리할 수 있어야.

### (5) self-check (응답 emit 전)

각 endpoint 핸들러 작성 후 다음을 점검:
- [ ] 모든 throw 경로에 적절한 status code (400/401/409/500) 매핑됐는가
- [ ] body 받는 모든 datetime 필드를 MySQL 형식으로 변환했는가
- [ ] response data 어디에도 `null`/`undefined` 가 새지 않는가 (default 값 채움)
- [ ] catch 안에 console.error 로깅 있는가
- [ ] contract의 declared statuses 와 모든 응답이 일치하는가

## 7. 테스트 (BE) — common.md §5 참조 + BE 한정 룰

시스템 자동 생성 / dropAgentGeneratedTests / placeholder 보존 등 일반 룰은 `rules/common.md` §5·§8 참조. 환경은 **Jest + Supertest** (stack.config의 `lint.stage3` = `jest --runInBand`).

### 7-bis. Stage 3 친화적 export (D30=A)

시스템 smoke test는 `typeof exportedFn === 'function'`을 검증한다. 모듈이 require될 때 *throw하지 않고* 함수를 export해야 한다.

```js
// ❌ 나쁨 — top-level throw로 require 자체가 실패
if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD missing');
module.exports = { signupHandler };

// ✅ 좋음 — env 검증은 핸들러 호출 시점에, pool은 lazy
const pool = mysql.createPool({ password: process.env.DB_PASSWORD || '', ... });
async function signupHandler(req, res) {
  if (!process.env.DB_PASSWORD) return res.status(500).json({ success: false, error: '...' });
  // ...
}
module.exports = { signupHandler };
```

### 7-ter. 모든 비즈니스 함수를 export (smoke test가 어떤 함수를 검증할지 모름)

함수를 정의했지만 `module.exports`에 포함시키지 않으면 (export 안 함), smoke test의 `typeof mod.fn === 'function'`이 `undefined`로 fail.

```js
// ❌ 나쁨 — 함수 정의는 했지만 export 안 함 → mod = {} 가 됨
async function signup() { ... }
async function login() { ... }

// ✅ 좋음 — 한 파일의 모든 함수를 module.exports에 포함
module.exports = { signup, login };
```

ES Modules 문법(`export default`)은 BE에서 금지 (§2 참조).

## 8. 보호 파일 (BE) — common.md 보호 파일 섹션 참조

BE 정확한 list (`BE.protectedConfigFiles`)는 매 호출마다 system prompt에 자동 주입됨. 행동 룰(silent drop / validatePaths ERROR)은 `rules/common.md` 보호 파일 섹션 참조.

비고: Jest 설정은 `BE/package.json`의 `"jest"` key 인라인 — 별도 `jest.config.*` 파일은 없음.
