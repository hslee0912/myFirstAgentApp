# FE Convention (Frontend-Specific)

이 문서는 FE Agent **전용** 규칙입니다. 공통 규칙은 `rules/common.md` 참조 — 두 문서를 합쳐 FE Agent의 system prompt에 주입됩니다.

## 1. 파일명 (FE)

- React 컴포넌트: `PascalCase` (예: `SignupForm.jsx`, `LoginForm.jsx`, `UserProfile.jsx`)
- 유틸·훅: `camelCase` (예: `useAuth.js`, `validateEmail.js`, `apiClient.js`)
- **테스트 파일은 Agent가 작성하지 않는다** — `lib/test_codegen.js`가 비즈니스 코드를 분석해 결정론적으로 smoke test (`<Component>.test.jsx` / `<util>.test.js`)를 자동 생성한다. Agent가 응답에 `*.test.{js,jsx}` 파일을 포함하면 `dropAgentGeneratedTests`가 silent drop한다.

## 2. 모듈/임포트 (FE)

- **ES Modules 사용** (`import` / `export`)
- CommonJS `require`/`module.exports` 사용 금지

```js
// 좋음
import { useState } from 'react';
export default function SignupForm() { ... }

// 나쁨 (FE는 ES Modules)
const { useState } = require('react');
module.exports = SignupForm;
```

## 3. 진입점 — `FE/src/App.jsx`

- bootstrap이 깔아둔 `App.jsx` placeholder가 있으면 **그 동작·테스트를 보존**하면서 새 컴포넌트 추가.
- placeholder 테스트가 검증하는 셀렉터(예: `screen.getByText(...)`)가 깨지지 않도록 주의.

## 4. React 패턴

- Functional component + Hooks 사용. Class component 사용 금지.
- 상태는 `useState` / `useReducer`. 외부 상태 관리 라이브러리(Redux, Zustand 등) 도입 금지 (`allowedDeps` 위반).
- 폼은 controlled component (`value` + `onChange`).

### 4-bis. 조건부 `return null` 절대 금지 (Stage 3 가장 흔한 실패 원인)

시스템의 자동 생성 smoke test는 *props 없이* `render(<Component />)`를 호출하고
`expect(container.firstChild).not.toBeNull()`을 검증한다. 따라서 컴포넌트가
*어떤 prop 조합에서도* null을 반환하면 안 된다.

**나쁨** — Modal/Toast/Drawer 같은 컴포넌트의 흔한 패턴:
```jsx
function Modal({ isOpen, children }) {
  if (!isOpen) return null;       // ← smoke test가 render(<Modal />) 호출 → null → FAIL
  return <div className="modal">{children}</div>;
}
```

**좋음** — 닫힌 상태도 *non-null DOM 노드* 반환:
```jsx
function Modal({ isOpen = false, children }) {
  return (
    <div className="modal" style={{ display: isOpen ? 'block' : 'none' }}>
      {children}
    </div>
  );
}
// 또는:
function Modal({ isOpen, children }) {
  if (!isOpen) return <div data-state="closed" hidden />;
  return <div className="modal">{children}</div>;
}
```

핵심 룰:
- 어떤 prop 입력에서도 *non-null DOM*을 반환할 것. 빈 `<div hidden />` 도 OK.
- 필수처럼 보이는 prop은 default 값을 두거나 optional로 처리.
- Fragment(`<>...</>`)도 *내부 자식이 없으면* `firstChild === null`이 될 수 있으니 주의 — 차라리 빈 `<div />`.
- 이 룰을 위반하면 Stage 3 단위 테스트가 즉시 실패하고, 시스템이 `fix_instructions`로 LLM에 재시도 요청한다 (최대 `MAX_RETRIES` = 3회). 첫 시도부터 룰을 따르는 게 정상 경로.

### 4-ter. 필수처럼 보이는 prop의 default 값 누락 (Stage 3 두 번째 흔한 실패)

위 §4-bis와 짝. *render(<Component />)* 가 props 없이 호출되므로, 컴포넌트가 *undefined prop에 접근해 throw*하면 smoke test 실패한다.

**나쁨** — undefined.toUpperCase()로 throw:
```jsx
function UserBadge({ user }) {
  return <span>{user.name.toUpperCase()}</span>;   // ← user undefined → throw
}
```

**좋음** — default + optional chaining:
```jsx
function UserBadge({ user = { name: '' } }) {
  return <span>{(user.name || '').toUpperCase()}</span>;
}
// 또는
function UserBadge({ user }) {
  const name = user?.name || '';
  return <span>{name.toUpperCase()}</span>;
}
```

핵심 룰:
- 모든 prop은 *undefined로 들어와도* throw 없이 일관된 결과 반환.
- 객체/배열 prop은 default `{}` / `[]` 또는 optional chaining(`?.`).
- 함수 prop(예: `onClick`)도 *호출 안 해도 안전*해야 하지만, *호출 시*엔 default가 없으면 throw → `onClick = () => {}`처럼 noop default.

### 4-quater. import 경로 오타 / missing default export

모듈 로드 단계에서 throw → smoke test가 컴포넌트 자체를 require하지 못해 실패한다. eslint Stage 1이 *상당 부분* 잡아주지만 default export 누락 같은 케이스는 stage 3까지 가서 깨질 수 있음.

**나쁨**:
```jsx
// SignupForm.jsx — export 누락
function SignupForm() { return <div>...</div>; }
// (export default가 없음)

// App.jsx에서 import 시 SignupForm은 undefined → render(<undefined />) → throw
import SignupForm from './SignupForm';
```

**좋음**:
```jsx
// SignupForm.jsx — default export 명시
export default function SignupForm() { return <div>...</div>; }
// 또는
function SignupForm() { return <div>...</div>; }
export default SignupForm;
```

```jsx
// LoginForm.jsx — named export로 emit한 경우
export function LoginForm() { return <div>...</div>; }

// App.jsx — *named import* 사용 (default import 아님)
import { LoginForm } from './LoginForm';
```

핵심 룰:
- *어떻게 import 할지 미리 정하고* 그에 맞게 export. default와 named 섞지 말 것.
- 파일명 = 컴포넌트명을 권장 (`SignupForm.jsx`에 `SignupForm` export).
- import 경로는 *상대 경로 + 확장자 생략*. `./components/SignupForm` (확장자 .jsx 생략 OK, Vite resolve).

## 4-quinque. Canvas 컴포넌트 — smoke test 친화적 작성 (D50)

`<canvas>` 사용 컴포넌트(예: 게임 캔버스)는 jsdom 환경에서 `getContext`가 native 구현 안 됩니다. 시스템 setup file (`FE/src/setupTests.js`)이 *no-op stub*을 자동 제공하지만, 추가로 *컴포넌트 코드 측 가드*도 권장됩니다 (이중 보호).

**가드 패턴**:
```jsx
import { useRef, useEffect } from 'react';

function GameCanvas({ width = 1000, height = 750 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof canvas.getContext !== 'function') return;  // 가드 — jsdom 안전
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 정상 게임 로직 (drawImage, fillRect, requestAnimationFrame 루프 등)
  }, []);

  return <canvas ref={canvasRef} width={width} height={height} />;
}
```

핵심 룰:
- 컴포넌트는 *props 없이 render되어도 throw 안 함* (§4-bis와 동일).
- `getContext` 호출 *직전*에 `typeof === 'function'` 검사 — setup stub은 *항상* 함수 반환하지만, *코드 가드*가 있으면 setup file 없는 환경에서도 안전.
- `requestAnimationFrame` 게임 루프도 useEffect cleanup에서 `cancelAnimationFrame`로 정리 (setup file이 둘 다 mock 제공).
- canvas 자체는 *항상 DOM 노드 반환* — 빈 canvas여도 OK (§4-bis non-null).

> 시스템 setup file이 잡아주는 안전망이지만, *컴포넌트가 직접 가드*하면 *다른 환경 (server-side rendering, Node CLI 테스트 등)에서도 재사용 가능* — 안정성 ↑.

## 5. API 호출 패턴

- `fetch` 또는 axios... 가 아니라 **fetch만**: `axios`는 `allowedDeps`에 없음 → `validateAllowedDeps` 가드가 즉시 ERROR.
- **URL은 항상 상대 경로** (`/api/...` 형태). absolute URL (`http://...`)이나 BE host hardcode 금지.
  - Vite dev server에 `server.proxy['/api']`가 설정되어 있어 `/api/*` 요청을
    자동으로 BE 컨테이너로 forward한다. FE Agent는 BE의 host/port를 *알 필요
    없음*. dev/docker/EC2 환경 분기, CORS 헤더, `VITE_BE_URL` 같은 env 변수는
    *인프라 영역* — LLM이 절대 신경 쓰지 말 것.
- 경로는 `shared/api_contract.json`의 `base_url` + `endpoint.path`로 조합.
  예: `base_url='/api/v1'`, `endpoint.path='/auth/signup'` → 최종 fetch URL은
  `'/api/v1/auth/signup'`.
- 응답 형식은 공통 규칙 §3 — `{ success, data, error }`.
  ```js
  // 좋음 (상대경로 + base_url + path 조합)
  const res = await fetch('/api/v1/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  ```
- **흔한 함정 — 절대 금지**:
  ```js
  // 나쁨 1: BE host hardcode
  fetch('http://localhost:3001/api/v1/auth/signup', ...)
  // → 브라우저 cross-origin 호출 → CORS 차단되거나 환경 의존(EC2 도메인 등).

  // 나쁨 2: env 분기 시도
  const BE_URL = import.meta.env.VITE_BE_URL || 'http://localhost:3001';
  fetch(`${BE_URL}/api/v1/auth/signup`, ...)
  // → 인프라 영역 침범. Vite proxy로 이미 해결된 문제를 FE 코드에서 다시 풀려는
  //   안티패턴. proxy 설정 자체가 protected file이라 FE Agent는 그게 어떻게
  //   세팅됐는지 알 필요도 없다.

  // 나쁨 3: base_url 누락
  fetch('/auth/signup', ...)
  // → BE의 mount path는 base_url 포함. base_url 빼면 404.
  ```

## 6. 테스트 (FE) — 시스템이 자동 생성

- **단위 테스트는 시스템(`lib/test_codegen.js`)이 결정론적으로 자동 생성**한다. Agent는 비즈니스 코드만 emit.
- 응답에 `*.test.{js,jsx}` 파일을 포함하면 `dropAgentGeneratedTests`가 silent drop. disk에 작성되지 않으며 출력 토큰만 낭비됨.
- 시스템이 emit하는 FE smoke test 형태 (참고용, 실제 결정은 `lib/test_codegen.js`):
  ```jsx
  import { describe, it, expect } from 'vitest';
  import { render } from '@testing-library/react';
  import SignupForm from './SignupForm';

  describe('SignupForm (auto-generated smoke test)', () => {
    it('renders without crashing and produces non-empty output', () => {
      const { container } = render(<SignupForm />);
      expect(container).toBeTruthy();
      expect(container.firstChild).not.toBeNull();
    });
  });
  ```
- 도구·환경: 시스템 생성 test도 **Vitest + React Testing Library + jsdom** 가정의 환경에서 실행 (`lib/stack.config.json` FE 블록의 `lint.stage3` = `vitest run`). `FE/package.json`에 `vitest`/`@testing-library/*` dep는 그대로 유지.
- bootstrap이 깐 placeholder test (예: `App.test.jsx`)는 disk에 그대로 보존된다 — 시스템 자동 생성도 placeholder는 덮어쓰지 않음 (`isTestFile()` skip).
- **Agent의 책임**:
  1. placeholder test가 통과되도록 비즈니스 코드를 작성.
  2. 새 컴포넌트는 *smoke test 친화적*으로 — render만 시켜도 throw하지 않게 (필수 prop은 default value 또는 optional 처리).
  3. 깊은 동작 test는 향후 phase에서 추가 예정. 현재는 smoke 수준만 시스템이 보장.

## 7. 스타일링

- 스택에 CSS-in-JS 라이브러리는 없음. 인라인 style 또는 `<style>` 태그 또는 별도 `.css` 파일 import 사용.
- Tailwind 등 외부 의존성 도입 금지.
- `styled-components`, `@emotion/*`, `tailwindcss`, `clsx`, `classnames` 등 **모두 `validateAllowedDeps` 가드가 즉시 ERROR**.

## 7-bis. 흔한 위반 (절대 시도하지 말 것)

- 검증 라이브러리: `validator`, `yup`, `zod`, `joi` — regex 또는 직접 검사로 처리.
- HTTP: `axios`, `node-fetch` — 항상 global `fetch`.
- 라우팅: `react-router-dom` 등 — `allowedDeps`에 없으므로 단일 페이지 또는 조건부 렌더링으로 처리.
- 폼 라이브러리: `react-hook-form`, `formik` — `useState`로 직접 controlled form.
- 아이콘: `react-icons`, `@mui/icons-material` — SVG 인라인 또는 텍스트로.
- **보안·해싱 라이브러리: `bcrypt`, `bcryptjs`, `crypto-js`, Web Crypto API (PBKDF2/SubtleCrypto 등) — *FE에서 비밀번호 해싱 시도 자체가 안티패턴*.**
  - 비밀번호는 **평문 그대로 fetch body에 담아 BE로 전송**. HTTPS가 전송 구간 암호화 담당.
  - BE가 bcrypt로 해시해 DB에 저장 (rules/be.md §5 참조).
  - FE에서 미리 해시하면 *해시값이 곧 비밀번호*가 되어 보안 효과 없음 + DB는 *해시의 해시*만 갖게 됨 (이중 해시 안티패턴).
- 위반 시 응답 시점에 라운드 ERROR 종료.

## 8. 보호 파일 (FE)

정확한 list는 `lib/stack.config.json`의 `FE.protectedConfigFiles`에서 매 호출마다 자동 주입됨. 현재 값:

- 의존성 매니페스트: `FE/package.json`, `FE/package-lock.json`
- Build 설정: `FE/vite.config.js`
- 진입 HTML: `FE/index.html`
- Lint 설정: `FE/.eslintrc.json`
- Docker 설정: `FE/Dockerfile`, `FE/.dockerignore`

(`setupTests.js` 같은 별도 Vitest 환경 파일은 현재 스택에 없음. Vitest 설정은 `FE/vite.config.js` 또는 `FE/package.json` 내 인라인.)

**응답에 절대 포함하지 말 것**. 응답에 들어가면 1차로 `dropProtectedFiles`가 silent drop, 그래도 새 나간 케이스는 `Orchestrator.validatePaths`가 throw해 라운드 전체가 ERROR. 자세한 행동 규칙은 `rules/common.md` §9 참조.
