# Common Code Convention (BE + FE)

이 문서는 BE Agent와 FE Agent **모두** 매 LLM 호출 시 반드시 읽고 따라야 할 공통 규칙입니다. 영역 전용 규칙은 각각 `rules/be.md`, `rules/fe.md`에 있습니다.

## 1. 명명 규칙 (공통)

- 변수/함수: `camelCase`
- 상수: `UPPER_SNAKE_CASE`

영역별 파일명 규칙은 `be.md` / `fe.md` 참조.

## 2. 보안 (필수 — Agent의 자체 책임)

> ⚠️ 현재 스택엔 보안 lint plugin(eslint-plugin-security 등)이 없다. Stage 1(eslint), Stage 2(build), Stage 3(자동 생성 smoke test) 어느 단계도 보안 위반을 자동 검증하지 못한다. Agent가 코드 작성 시 자체 책임으로 다음 룰을 강력히 따를 것.

- **비밀번호는 반드시 bcrypt 해시로 저장**. 평문 저장 금지.
  - 권장: `bcrypt.hash(password, 10)`
- **SQL은 반드시 Prepared Statement (mysql2 placeholder `?` 사용)**. 문자열 결합 금지.
  - 좋음: `db.query('SELECT * FROM some_table WHERE col = ?', [val])`
  - 나쁨: `db.query("SELECT * FROM some_table WHERE col = '" + val + "'")`

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

## 5. 테스트 (시스템이 자동 생성)

- **단위 테스트는 시스템(`lib/test_codegen.js`)이 결정론적으로 자동 생성한다**. Agent는 비즈니스 코드만 emit.
- *.test.{js,jsx}* 파일을 응답에 포함하면 `dropAgentGeneratedTests` 가 silent drop한다. 응답에 넣지 말 것.
- 시스템이 만드는 테스트는 *smoke 수준* — React 컴포넌트는 `render(<X />)` non-empty 검증, 라이브러리 모듈은 `typeof === 'function'` 검증. 깊은 비즈니스 검증은 다음 phase 작업.
- placeholder test (`server.test.js`, `App.test.jsx` 등 bootstrap이 깐 것)는 disk에 그대로 유지되며 자동 생성 대상에서 skip된다.
- 워크플로우: **Agent (LLM, 코드만) → test_codegen (deterministic, smoke test) → Lint Agent (deterministic, eslint+build+test 실행)**.

## 6. 환경 변수

- **BE 한정**: BE 모듈은 `dotenv.config()`로 환경 변수 로드 (`{ override: true }` 옵션 필수 — 시스템 env에 빈 값이 잡혀있을 때 .env가 묻히는 현상 방지).
- **FE**: Vite의 `import.meta.env.VITE_*` 패턴 사용. dotenv 사용 X (브라우저 번들 환경).
- 두 영역 모두 **DB 비밀번호·API 키 등 민감정보는 절대 코드에 하드코딩 금지**.

## 7. 폴더 격리 (절대 위반 금지)

- BE Agent는 `BE/` 내부만 수정. `FE/`는 절대 손대지 않음.
- FE Agent는 `FE/` 내부만 수정. `BE/`는 절대 손대지 않음.
- 양쪽 모두 `shared/api_contract.json`은 **읽기 전용 참조**. 수정 금지.

## 8. Placeholder 보존 규칙

- `lib/bootstrap.js`가 `lib/stack_templates/<AREA>/`에서 깔아둔 placeholder 파일(특히 `*.test.js` / `*.test.jsx`)은 **disk에 그대로 보존된다**. Agent는 수정·삭제할 수 없다.
- **placeholder test는 응답에 포함하지 말 것**. 시스템의 `dropAgentGeneratedTests`가 어떤 `*.test.{js,jsx}` 응답이든 silent drop하므로(§5 참조), 응답에 넣어도 disk엔 반영되지 않고 출력 토큰만 낭비됨. placeholder는 disk의 원본이 그대로 사용된다.
- **신규 비즈니스 코드는 placeholder test가 기대하는 응답 형식·동작을 그대로 만족시켜야 한다.**
  예: placeholder가 `GET /health → { success: true, data: { status: 'ok' } }` 를 검증하면, 새 `server.js`의 `/health`도 동일 형식 유지.
- placeholder 자체가 명세와 충돌하는 케이스(드물지만 가능)는 *별도 phase 작업* — 시스템 동작상 Agent가 직접 수정할 수 없다. 사람이 `lib/stack_templates/<AREA>/`의 placeholder를 직접 수정해야 한다.

## 9. 스택 일관성

- 사용 가능한 의존성과 도구는 **`lib/stack.config.json`**의 `<AREA>.agent.allowedDeps`에 정의되어 있고, 매니페스트 파일(예: package.json / pom.xml)에 이미 등록된 것만 사용한다.
- "다른 라이브러리가 더 좋다"는 판단으로 **새 의존성을 추가하거나 매니페스트를 수정하지 말 것**. 필요한 경우 응답의 `notes`에 사유를 기록만 하고, 패키지 매니페스트는 절대 건드리지 말 것.
- bootstrap이 정한 모듈 시스템(시스템 프롬프트의 `moduleSystem` 항목)을 임의로 바꾸지 말 것. 스택을 바꾸는 결정은 사람의 작업이며, 그 절차는 `README.md`의 "스택 변경 체크리스트"에 따라 진행된다.

### 9-bis. allowedDeps 위반 가드 (결정론, 매 응답 검증)

- 응답의 모든 `.js` / `.jsx` 파일은 `require()` / `import` 정적 분석 대상이다. 외부 모듈 (상대경로 `./`/`../` 아니고 Node.js builtin 아닌 것) 중 `allowedDeps`에 없는 것이 발견되면 **즉시 `UNAUTHORIZED_DEPS` 오류로 라운드 ERROR 종료**.
- 흔한 위반 사례 (절대 시도하지 말 것):
  - `require('email-validator')`, `require('joi')`, `require('zod')`, `require('validator')` — 이메일/입력 검증은 직접 regex 또는 단순 string 검사로 처리하라. 모든 검증 라이브러리 금지.
  - `require('axios')`, `require('node-fetch')` — BE는 외부 HTTP 호출 시 Node.js builtin `https`/`http` 또는 `fetch` (Node 18+ global) 사용. FE는 global `fetch`만.
  - `require('jsonwebtoken')`, `require('uuid')` — `crypto.randomUUID()` (Node builtin)으로 충분.
  - `require('lodash')`, `require('ramda')`, `require('moment')`, `require('date-fns')` — 표준 라이브러리/직접 구현으로 처리.
  - `import 'styled-components'`, `import '@emotion/react'` — FE는 인라인 style 또는 plain CSS만.
  - **`require('bcryptjs')` — NOT `bcrypt`**. 이름은 비슷하지만 별도 패키지. BE allowedDeps엔 `bcrypt`만 있음. **`bcrypt`만 사용**.
- 이 가드는 *retry 없는 즉시 ERROR* 이다 (validatePaths와 동일). prompt 단계에서 룰을 따르는 게 정상 경로.

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

## 10. 코드 최적화 / 산출물 크기 절약 (필수)

LLM의 `max_output_tokens`는 한정 자원이다 (현재 BE/FE 모두 30000). 산출물이 cap에 도달하면 응답이 잘려 *continuation* 모드로 이어 받게 되고, 여러 응답을 한 JSON으로 합치는 과정에서 구조가 깨질 위험이 커진다 (`JSON_PARSE_FAIL` round retry로 이어짐).

따라서 모든 코드 산출 시 다음을 **반드시** 지킬 것:

- **DRY 원칙 엄격 적용** — 동일·유사 로직이 두 곳 이상이면 헬퍼 함수 / 공통 컴포넌트로 추출.
- **wrapper / boilerplate 최소화** — 같은 동작이면 더 짧은 표현 선호.
- **불필요한 주석·로그·placeholder 제거** — JSDoc은 함수당 한 줄, debug `console.log` 잔여 금지.
- **유사 페이지/컴포넌트 통합** — 공통 layout / wrapper / 핸들러는 한 곳에서 import.
- **CSS·inline style 중복 제거** — 같은 색·spacing이 여러 컴포넌트에 있으면 상수 또는 공통 클래스.

### 10-bis. FE 특별 주의

⚠️ **FE 산출물은 BE보다 코드량이 현저히 많은 경향이 있다** (multi-page React, canvas 게임 로직, 다양한 UI state 등). 다음을 *우선순위로* 고려:

- 5개 페이지가 비슷한 layout이면 → `<Layout>` 컴포넌트 1개 + 페이지별 컴포넌트.
- 같은 fetch 패턴이 여러 페이지에 있으면 → `api/client.js` 한 모듈로 묶기.
- canvas 게임의 entity (Player / Enemy / Bullet 등)는 공통 base + 차이만 override.
- 불필요한 prop drilling 대신 직접 import 또는 context 사용.

**핵심 목표**: continuation 횟수 ↓ → JSON parse 실패 ↓ → cycle 성공률 ↑. 같은 동작을 *짧게* 표현할 수 있다면 *반드시* 그 방향으로.
