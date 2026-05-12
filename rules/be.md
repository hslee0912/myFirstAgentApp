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
  에 직접 연결한다. `app_users` 데이터는 *영구 보존* — 컨테이너 재배포로
  사라지지 않음. 이전의 컨테이너 MySQL ephemeral 디자인은 obsolete. 환경
  변수(`DB_HOST` 등)는 docker-compose.yml이 주입하므로 *BE 코드는 host/port
  를 hardcode하면 안 된다*. 항상 `process.env.DB_*` 만.
- **테이블 이름은 `db/schema.sql`에 정의된 것만 사용** — 시스템 프롬프트의 "DB schema" 섹션이 매 호출마다 실제 schema를 주입한다. 회원 비즈니스는 `app_users`(NOT `users`)만 사용. `log_*` 테이블은 절대 건드리지 말 것.
- 컬럼은 schema에 있는 것만. `id`는 AUTO_INCREMENT이므로 INSERT에 포함 금지, `LAST_INSERT_ID()` 또는 mysql2 `result.insertId`로 받음. `created_at`/`updated_at`은 DEFAULT가 있어 INSERT 제외.
- 비밀번호 컬럼명은 `password_hash` (schema 그대로). 다른 이름(`password`, `pwd` 등) 사용 금지.

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
- bootstrap이 깐 placeholder test (예: `server.test.js`)는 disk에 그대로 보존된다 — 시스템 자동 생성도 placeholder는 덮어쓰지 않음 (`isTestFile()` skip).
- **Agent의 책임**: placeholder test가 통과되도록 비즈니스 코드를 작성. test 코드 작성은 Agent의 책임이 아님.

## 8. 보호 파일 (BE)

정확한 list는 `lib/stack.config.json`의 `BE.protectedConfigFiles`에서 매 호출마다 자동 주입됨. 현재 값:

- 의존성 매니페스트: `BE/package.json`, `BE/package-lock.json`
- Lint 설정: `BE/.eslintrc.json`
- Docker 설정: `BE/Dockerfile`, `BE/.dockerignore`

(Jest 설정은 `BE/package.json`의 `"jest"` key에 인라인 — 별도 `jest.config.*` 파일은 없음.)

**응답에 절대 포함하지 말 것**. 응답에 들어가면 1차로 `dropProtectedFiles`가 silent drop, 그래도 새 나간 케이스는 `Orchestrator.validatePaths`가 throw해 라운드 전체가 ERROR. 자세한 행동 규칙은 `rules/common.md` §9 참조.
