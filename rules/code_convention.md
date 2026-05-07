# Code Convention

이 문서는 BE/FE Agent가 매 실행 시 반드시 먼저 읽고 따라야 할 규칙입니다.

## 1. 명명 규칙
- 변수/함수: `camelCase`
- 상수: `UPPER_SNAKE_CASE`
- FE 파일명:
  - React 컴포넌트: `PascalCase` (예: `SignupForm.jsx`)
  - 유틸/훅: `camelCase` (예: `useAuth.js`, `validateEmail.js`)
- BE 파일명: `snake_case` (예: `user_service.js`, `auth_router.js`)

## 2. 보안 (필수 — 위반 시 Lint Stage 3에서 fail)
- **비밀번호는 반드시 bcrypt 해시로 저장**. 평문 저장 금지.
  - 권장: `bcrypt.hash(password, 10)`
- **SQL은 반드시 Prepared Statement (mysql2 placeholder `?` 사용)**. 문자열 결합 금지.
  - 좋음: `db.query('SELECT * FROM app_users WHERE email = ?', [email])`
  - 나쁨: `db.query("SELECT * FROM app_users WHERE email = '" + email + "'")`

## 3. API 응답 형식 (필수)
모든 BE 엔드포인트는 다음 JSON 구조로 응답:
```json
{ "success": true, "data": {...} }
```
또는 에러 시:
```json
{ "success": false, "error": "에러 메시지" }
```

HTTP 상태 코드도 함께 사용:
- 성공: 200 / 201
- 클라이언트 에러: 400 / 401 / 409
- 서버 에러: 500

## 4. 주석
- 함수 단위 JSDoc 권장:
```js
/**
 * 이메일 중복을 확인한다.
 * @param {string} email
 * @returns {Promise<boolean>} 이미 가입된 이메일이면 true
 */
async function isEmailTaken(email) { ... }
```

## 5. 모듈/임포트
- BE: CommonJS (`require` / `module.exports`)
- FE: ES Modules (`import` / `export`)

## 6. 테스트 (필수)
- **새로 작성하는 모든 함수/컴포넌트/클래스는 최소 1개 이상의 단위 테스트 케이스를 동반해야 함**.
- 테스트 도구·파일 패턴은 **시스템 프롬프트에 자동 주입되는 스택 정보**를 따른다 (현재 스택은 `lib/stack.config.json`의 `<AREA>.agent.testFilePattern` / `testFramework` 참조). 스택을 임의 변경하지 말 것.
- 테스트 파일은 대상 파일과 동일한 폴더에 둔다.

## 7. 환경 변수
- 모든 BE 모듈은 `dotenv.config()`로 환경 변수 로드.
- DB 비밀번호 등 민감정보는 절대 코드에 하드코딩 금지.

## 8. 폴더 격리 (절대 위반 금지)
- BE Agent는 `BE/` 내부만 수정. `FE/`는 절대 손대지 않음.
- FE Agent는 `FE/` 내부만 수정. `BE/`는 절대 손대지 않음.
- 양쪽 모두 `shared/api_contract.json`은 **읽기 전용 참조**. 수정 금지.

## 9. Placeholder 보존 규칙
- `lib/bootstrap.js`가 `lib/stack_templates/<AREA>/`에서 깔아둔 `*.test.js` / `*.test.jsx` 등 placeholder 파일은 **명세에 명백히 어긋나지 않는 한 보존**한다.
- 신규 비즈니스 코드(특히 진입점 `server.js`, `App.jsx`)는 **placeholder 테스트가 기대하는 응답 형식·동작을 그대로 만족**시켜야 한다.
  예: placeholder가 `GET /health → { success: true, data: { status: 'ok' } }`를 검증하면, 새 server.js의 `/health` 도 동일 형식 유지.
- placeholder 자체가 명백히 명세와 충돌(예: 명세는 응답 형식 X인데 placeholder는 다른 형식 검증)할 때만 placeholder를 합리적으로 수정 가능. 그 외에는 절대 수정 금지.

## 10. 스택 일관성 (Agent 주의)
- 사용 가능한 의존성과 도구는 **`lib/stack.config.json`**의 `<AREA>.agent.allowedDeps`에 정의되어 있고, 매니페스트 파일(예: package.json / pom.xml)에 이미 등록된 것만 사용한다.
- "다른 라이브러리가 더 좋다"는 판단으로 **새 의존성을 추가하거나 매니페스트를 수정하지 말 것**. 필요한 경우 응답의 `notes`에 사유를 기록만 하고, 패키지 매니페스트는 절대 건드리지 말 것.
- bootstrap이 정한 모듈 시스템(시스템 프롬프트의 `moduleSystem` 항목)을 임의로 바꾸지 말 것. 스택을 바꾸는 결정은 사람의 작업이며, 그 절차는 `README.md`의 "스택 변경 체크리스트"에 따라 진행된다.

### 보호 파일 — 절대 수정·생성 금지
- 각 스택의 빌드/매니페스트 설정 파일은 **placeholder 상태 그대로 보존**한다. 어떤 파일이 보호 대상인지는 `lib/stack.config.json`의 `<AREA>.protectedConfigFiles`에 정의되어 있고, **시스템 프롬프트에 자동 주입되어 매 호출마다 Agent에게 전달**된다.
- 보호 파일에 대한 응답은 Orchestrator의 `validatePaths` 단계에서 **런타임 거부**되어 그 라운드 전체가 ERROR로 처리되니 주의.
- 새 의존성·플러그인이 정말 필요하면 응답의 `notes`에 사유만 기록하고 코드는 만들지 말 것.
