# FE Convention (Frontend-Specific)

이 문서는 FE Agent **전용** 규칙입니다. 공통 규칙은 `rules/common.md` 참조 — 두 문서를 합쳐 FE Agent의 system prompt에 주입됩니다.

## ⚠️ FE 응답 emit 전 자가 체크 (필독 — FE에서 자주 어기는 4개)

응답 JSON 직렬화 직전 마지막 확인. 하나라도 어기면 round ERROR 또는 STAGE 3 FAIL.

1. **🚫 FE에서 비밀번호 해싱 시도 금지** — `bcrypt`, `bcryptjs`, `crypto-js`, Web Crypto API 사용 *모두* 금지. 평문 그대로 fetch body에 담아 BE로 전송. BE가 bcrypt로 해시 (`rules/be.md §5`). FE 사전 해시는 *해시값=비밀번호* 안티패턴. §7-bis 참조.
2. **🧱 `return null` 절대 금지** — props 없이 `render(<Component />)` 호출되어 *non-null DOM 노드* 반환해야 함. `Modal`/`Toast`/`Drawer` 컴포넌트의 `if (!isOpen) return null` 패턴 매우 흔함. 차라리 `<div hidden />` 또는 `<div style={{display:'none'}} />`. §4-bis 참조.
3. **🎁 prop default 값 반드시** — `function UserBadge({ user })` → `user.name` 접근 시 throw. `{ user = { name: '' } }` 또는 optional chaining `user?.name`. §4-ter 참조.
4. **🚫 외부 라이브러리 — allowedDeps만** — `react-router-dom`, `react-hook-form`, `formik`, `axios`, `react-icons`, `styled-components`, `@emotion/*`, `tailwindcss`, `lodash`, `validator`, `joi`, `zod` 등 *모두 금지*. 직접 구현. `rules/common.md §9-bis` 함정 표 참조.

---

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

### 4-ter-α. ⚠️ **inline default가 useEffect dep에 들어가면 무한 setState 루프** (D78, vitest 5min hang 사고)

함수/객체/배열 prop default를 *컴포넌트 시그니처 안*에서 inline으로 적으면 *매 render마다 새 reference* 가 생성된다. 이 prop을 useEffect dep array에 넣으면 *매 render마다 dep 변화 인식 → cleanup → re-run → 만약 effect 안에서 setState 호출하면 → re-render → 무한 루프*.

**❌ 나쁨** (smoke test에서 vitest 5분 timeout, 사용자 사고 보고):
```jsx
function GamePage({ onNavigate = () => {}, gameData = { weapon: 'holy_sword' } }) {
  const [ui, setUi] = useState({});
  useEffect(() => {
    // ... gameLoop 또는 setUi 호출 ...
    setUi(...);
  }, [onNavigate]);   // ← onNavigate가 매 render마다 새 reference → 무한 cleanup/re-run
}
```

매 render마다 `onNavigate`/`gameData`가 새로 평가되어 *참조 동일성* 깨짐 → useEffect dep diff가 항상 변화 인식 → setState → re-render → 반복. **smoke test render(<GamePage />)가 무한 루프로 vitest 5분 timeout**.

**✅ 좋음 — 패턴 1**: 모듈 상수로 default 분리 (가장 안전):
```jsx
const NOOP = () => {};
const DEFAULT_GAME_DATA = { weapon: 'holy_sword' };
function GamePage({ onNavigate = NOOP, gameData = DEFAULT_GAME_DATA }) {
  // onNavigate/gameData 둘 다 *모듈 상수 reference* → 매 render마다 동일.
  useEffect(() => { /* ... */ }, [onNavigate]);   // OK
}
```

**✅ 좋음 — 패턴 2**: dep array에서 unstable prop 제외 + useRef로 최신값 보관:
```jsx
function GamePage({ onNavigate = () => {} }) {
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    // onNavigateRef.current() 호출
  }, []);   // ← dep []
}
```

**✅ 좋음 — 패턴 3**: dep array 자체 빈 (`[]`) — mount once. 대부분의 game-loop / event-listener 패턴에 적합:
```jsx
useEffect(() => {
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);   // mount once
```

**검출 단서**: 컴포넌트 시그니처에 `= () =>`, `= [...]`, `= {...}` inline default가 있고 그 prop이 useEffect dep array에 등장 → 위 3가지 패턴 중 하나로 *반드시* 교체. smoke test가 render만 호출해도 hang.

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

### 5-zero. ⚠️ contract에 *있는 endpoint만* fetch — 결정론 가드 (D66)

> **`fetch('/api/...')` 라인의 URL은 `shared/api_contract.json`의 endpoints에 *정확히* 포함된 path만 사용 가능.** contract에 없는 endpoint를 fetch하면 `lib/fe_contract_guard.js` 가 정적으로 catch하고 `FE_CONTRACT_DRIFT` ERROR로 round retry 발동. *retry로 풀지 말고 첫 응답부터 contract endpoint만 호출하는 게 정상 경로*.

흔한 사고 (절대 금지):

```js
// ❌ 나쁨 — "ID 중복확인" UX를 위해 contract에 없는 /auth/check를 자체 발명
fetch('/api/v1/auth/check?username=' + u)  // → 404, gate 차단

// ✅ 좋음 — contract에 있는 signup endpoint를 호출하고 409 응답으로 "이미 사용중" 표시
const res = await fetch('/api/v1/auth/signup', { method: 'POST', body: ... });
if (res.status === 409) setError('이미 사용중인 아이디입니다');
```

**판단 기준**:
1. UX 요소(중복확인, 비밀번호 강도, 자동 저장 등)가 *새* endpoint를 요구하는 것 같아도 — 먼저 `shared/api_contract.json` endpoint 목록을 본다.
2. 같은 UX를 contract endpoint *조합*으로 달성 가능한지 검토 (signup 시도 후 409, login 후 token 검사 등).
3. 그래도 새 endpoint가 *진짜* 필요하면 응답의 `notes`에 사유만 기록 — Agent가 contract를 임의 확장하지 말 것. system이 contract 갱신을 결정하는 영역.

### 5-bis. 기본 fetch 룰

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

## 6. 테스트 (FE) — common.md §5 참조 + FE 한정 룰

시스템 자동 생성 / dropAgentGeneratedTests / placeholder 보존 등 일반 룰은 `rules/common.md` §5·§8 참조. 환경은 **Vitest + React Testing Library + jsdom** (stack.config의 `lint.stage3` = `vitest run`).

FE smoke test 형태 (참고용):
```jsx
const { container } = render(<SignupForm />);
expect(container.firstChild).not.toBeNull();   // ← 핵심: non-null DOM
```

**Agent의 책임**: 새 컴포넌트는 *render(<X />)만 해도 throw 안 나고 non-null DOM 반환*해야 함 (§4-bis / 4-ter 참조).

## 7. 스타일링

- CSS-in-JS 라이브러리 없음. 인라인 style / `<style>` 태그 / 별도 `.css` import만.
- `styled-components`, `@emotion/*`, `tailwindcss`, `clsx`, `classnames` 등 모두 `validateAllowedDeps` ERROR.

## 7-bis. FE 한정 흔한 위반 — *학습 데이터 빈도 높아 자동완성 함정* (round ERROR 0회 목표)

> ⚠️ **FE Agent의 system prompt 상단 `🚫 의존성` 카드에 같은 표가 *그대로* prepend된다.** 이 §7-bis는 *왜 금지인지*의 부연 + FE 특이 함정. 표 자체는 system prompt를 우선 참조.

일반 금지 패키지 표는 `rules/common.md` §9-bis + `agents/fe_agent.js` buildSystemPrompt 상단 카드 참조. *FE에서 LLM이 학습 분포 따라 가장 자주 시도하는 5종*:

| 함정 패키지 | 시도 동기 (학습 빈도) | ✅ 대체 (allowedDeps만 사용) |
|---|---|---|
| `react-router-dom` | "여러 페이지 = 라우터" 학습 강함 | `useState`로 현재 페이지 state 관리 + 조건부 렌더링. 예: `const [page, setPage] = useState('login'); return page==='login' ? <Login/> : <Game/>` |
| `axios` | "HTTP 호출 = axios" 패턴 강함 | 브라우저 builtin `fetch`. `await fetch(url, {method, headers, body})` — import 자체 불필요 |
| `react-hook-form` / `formik` | form 다루는 React 코드 = 거의 항상 둘 중 하나 | `useState`로 controlled input. `<input value={u} onChange={e=>setU(e.target.value)} />` |
| `lodash` / `date-fns` | util 함수 학습 빈도 1위 | `Array.prototype.{map,filter,reduce}`, `Date` builtin. lodash debounce는 직접 `setTimeout` |
| `styled-components` / `@emotion/*` | React + 스타일 = CSS-in-JS 학습 강함 | 인라인 `style={{color:'red'}}` 또는 `.css` import |

### 자가 점검 절차 (응답 emit 전 *마지막* 단계)

1. 응답에 포함될 모든 `.jsx`/`.js` 파일에서 `^import\b` 라인을 *전부* 모아본다.
2. 각 라인의 from 뒤 모듈명을 *눈으로* 확인:
   - `from './...'` / `from '../...'` → OK (상대경로)
   - `from 'react'` / `from 'react-dom/client'` / `from 'react-dom'` → OK
   - 그 외 → **emit 전에 위 표의 대체 코드로 치환**.
3. *retry로 풀리는 게 정상 경로가 아니다*. 처음부터 안 쓰는 것이 비용·시간 절감.

### FE 한정 비밀번호 처리

**🚫 FE에서 비밀번호 해싱 시도 금지** (`bcrypt`, `bcryptjs`, `crypto-js`, Web Crypto API). 평문 그대로 fetch body로 BE에 전송 (HTTPS가 전송 구간 담당). BE가 bcrypt로 해시 (`rules/be.md §5`). FE 사전 해시는 *해시값=비밀번호* 안티패턴 + DB가 *해시의 해시* 보관.

## 8. 보호 파일 (FE) — common.md 보호 파일 섹션 참조

FE 정확한 list (`FE.protectedConfigFiles`)는 매 호출마다 system prompt에 자동 주입됨. 행동 룰(silent drop / validatePaths ERROR)은 `rules/common.md` 보호 파일 섹션 참조.

비고: Vitest 설정은 `FE/vite.config.js` 또는 `FE/package.json` 인라인.
