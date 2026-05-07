# BE Convention (Backend-Specific)

이 문서는 BE Agent **전용** 규칙입니다. 공통 규칙은 `rules/common.md` 참조 — 두 문서를 합쳐 BE Agent의 system prompt에 주입됩니다.

## 1. 파일명 (BE)

- BE 파일명: `snake_case` (예: `user_service.js`, `auth_router.js`, `db_helper.js`)
- 테스트 파일: 대상과 동일한 base + `.test.js` (예: `user_service.test.js`)

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
  const pool = mysql.createPool({...});
  await pool.execute('SELECT ... WHERE email = ?', [email]);
  ```

## 5. 비밀번호 처리

- 저장 시: `bcrypt.hash(password, 10)`
- 검증 시: `bcrypt.compare(plain, hashed)`
- 평문 비교(`if (password === stored)`) 절대 금지.

## 6. 에러 핸들링

- try/catch로 잡고, 5xx로 응답할 때는 `{ success: false, error: '...' }` 형식 유지.
- 클라이언트 에러(4xx)는 구체적 메시지, 서버 에러(5xx)는 일반화된 메시지 (스택 트레이스 노출 금지).

## 7. 테스트 (BE)

- 도구: **Jest + Supertest** (`lib/stack.config.json` BE 블록 참조).
- 파일 패턴: `<name>.test.js` (대상 파일과 같은 디렉토리).
- HTTP 핸들러는 supertest로 실제 요청 흘려보내고 응답 검증:
  ```js
  const request = require('supertest');
  const app = require('./server');
  test('signup returns 201', async () => {
    const r = await request(app).post('/signup').send({...});
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
  });
  ```

## 8. 보호 파일 (BE)

`lib/stack.config.json` `BE.protectedConfigFiles`에 정의됨. 일반적으로:
- `BE/package.json`, `BE/package-lock.json`
- `BE/.eslintrc.json`
- `BE/jest.config.*`

이 파일들은 응답에 절대 포함하지 말 것. 응답에 들어가면 라운드가 ERROR로 처리됩니다.
