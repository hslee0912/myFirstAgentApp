# Common Code Convention (BE + FE)

이 문서는 BE Agent와 FE Agent **모두** 매 LLM 호출 시 반드시 읽고 따라야 할 공통 규칙입니다. 영역 전용 규칙은 각각 `rules/be.md`, `rules/fe.md`에 있습니다.

## 1. 명명 규칙 (공통)

- 변수/함수: `camelCase`
- 상수: `UPPER_SNAKE_CASE`

영역별 파일명 규칙은 `be.md` / `fe.md` 참조.

## 2. 보안 (필수 — 위반 시 Lint Stage 3에서 fail)

- **비밀번호는 반드시 bcrypt 해시로 저장**. 평문 저장 금지.
  - 권장: `bcrypt.hash(password, 10)`
- **SQL은 반드시 Prepared Statement (mysql2 placeholder `?` 사용)**. 문자열 결합 금지.
  - 좋음: `db.query('SELECT * FROM app_users WHERE email = ?', [email])`
  - 나쁨: `db.query("SELECT * FROM app_users WHERE email = '" + email + "'")`

## 3. API 응답 형식 (필수)

모든 BE 엔드포인트는 다음 JSON 구조로 응답하고, FE는 이 형식을 가정해 소비:
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

## 5. 테스트 (필수)

- **새로 작성하는 모든 함수/컴포넌트/클래스는 최소 1개 이상의 단위 테스트 케이스를 동반해야 함**.
- 테스트 도구·파일 패턴은 **시스템 프롬프트에 자동 주입되는 스택 정보**를 따른다 (현재 스택은 `lib/stack.config.json`의 `<AREA>.agent.testFilePattern` / `testFramework` 참조). 스택을 임의 변경하지 말 것.
- 테스트 파일은 대상 파일과 동일한 폴더에 둔다.

## 6. 환경 변수

- 모든 BE 모듈은 `dotenv.config()`로 환경 변수 로드 (`{ override: true }` 옵션 필수).
- DB 비밀번호 등 민감정보는 절대 코드에 하드코딩 금지.

## 7. 폴더 격리 (절대 위반 금지)

- BE Agent는 `BE/` 내부만 수정. `FE/`는 절대 손대지 않음.
- FE Agent는 `FE/` 내부만 수정. `BE/`는 절대 손대지 않음.
- 양쪽 모두 `shared/api_contract.json`은 **읽기 전용 참조**. 수정 금지.

## 8. Placeholder 보존 규칙

- `lib/bootstrap.js`가 `lib/stack_templates/<AREA>/`에서 깔아둔 `*.test.js` / `*.test.jsx` 등 placeholder 파일은 **명세에 명백히 어긋나지 않는 한 보존**한다.
- 신규 비즈니스 코드(특히 진입점 `server.js`, `App.jsx`)는 **placeholder 테스트가 기대하는 응답 형식·동작을 그대로 만족**시켜야 한다.
  예: placeholder가 `GET /health → { success: true, data: { status: 'ok' } }`를 검증하면, 새 server.js의 `/health` 도 동일 형식 유지.
- placeholder 자체가 명백히 명세와 충돌(예: 명세는 응답 형식 X인데 placeholder는 다른 형식 검증)할 때만 placeholder를 합리적으로 수정 가능. 그 외에는 절대 수정 금지.

## 9. 스택 일관성

- 사용 가능한 의존성과 도구는 **`lib/stack.config.json`**의 `<AREA>.agent.allowedDeps`에 정의되어 있고, 매니페스트 파일(예: package.json / pom.xml)에 이미 등록된 것만 사용한다.
- "다른 라이브러리가 더 좋다"는 판단으로 **새 의존성을 추가하거나 매니페스트를 수정하지 말 것**. 필요한 경우 응답의 `notes`에 사유를 기록만 하고, 패키지 매니페스트는 절대 건드리지 말 것.
- bootstrap이 정한 모듈 시스템(시스템 프롬프트의 `moduleSystem` 항목)을 임의로 바꾸지 말 것. 스택을 바꾸는 결정은 사람의 작업이며, 그 절차는 `README.md`의 "스택 변경 체크리스트"에 따라 진행된다.

### 보호 파일 — 절대 수정·생성·참조 금지

각 스택의 빌드/매니페스트 설정 파일은 **placeholder 상태 그대로 보존**한다. 어떤 파일이 보호 대상인지는 `lib/stack.config.json`의 `<AREA>.protectedConfigFiles`에 정의되어 있고, **시스템 프롬프트에 자동 주입되어 매 호출마다 Agent에게 전달**된다.

#### 카테고리 (개념)

다음 카테고리의 file은 모두 보호 대상이다 — 정확한 path는 시스템 프롬프트의 protected files 리스트 참조:

- **의존성 매니페스트**: `package.json`, `package-lock.json`
- **Lint 설정**: `.eslintrc.json`, `.eslintignore`, `.prettierrc`
- **Docker / 컨테이너 설정**: `Dockerfile`, `.dockerignore`, `docker-compose.yml`
- **Build / 빌드 설정**: `vite.config.js`, `webpack.config.js`, `tsconfig.json`
- **진입 HTML**: `index.html` (FE 한정)

#### 행동 규칙 (필수)

1. **응답의 `files` 객체 key에 위 파일 path를 절대 포함하지 말 것.** 포함하면 Orchestrator의 `validatePaths`가 차단(throw 또는 silent-drop)하고 — 어느 쪽이든 그 응답의 출력 토큰은 낭비된다.
2. **`notes`나 다른 설명 텍스트에 "위 파일을 수정해야 한다"는 가이드를 주지 말 것.** 이런 가이드가 다음 라운드의 fix_instructions에 누적되면 다른 sub-agent가 시도하게 되어 시스템이 loop에 빠진다.
3. **`existing_files` snapshot에 위 파일이 보일 수 있다 — 이는 *읽기 전용 컨텍스트***. 그 안의 import path나 export 같은 것을 *읽고 비즈니스 코드 작성에 참조*하는 것은 OK. 하지만 *수정 가이드를 주거나 응답에 포함*하지 말 것.
4. **`fix_instructions`에 위 파일 path가 등장해도 무시하라.** lint 에러가 `.eslintrc.json` 같은 protected file에서 발생한 것처럼 보여도, 실제 fix는 *비즈니스 코드 측*(예: ESLint rule을 따르도록 코드를 수정)에서 해야 한다. protected file 자체를 건드리지 말 것.
5. **새 의존성·플러그인이 정말 필요하면 응답의 `notes`에 사유만 기록**. `package.json` 수정·생성도 금지.

#### 위반 시 시스템 동작 (참고)

- `Orchestrator.validatePaths` — 1차 차단: protected file을 응답에서 발견하면 라운드 ERROR.
- `lib/prompt_util.dropProtectedFiles` — 2차 차단(defense-in-depth): protected file을 silent-drop하고 audit log에 기록 후 진행.
- 두 layer 모두 LLM이 prompt를 따르지 않은 경우의 안전망. **prompt를 따르는 것이 정상 동작**이다.
