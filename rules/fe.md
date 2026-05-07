# FE Convention (Frontend-Specific)

이 문서는 FE Agent **전용** 규칙입니다. 공통 규칙은 `rules/common.md` 참조 — 두 문서를 합쳐 FE Agent의 system prompt에 주입됩니다.

## 1. 파일명 (FE)

- React 컴포넌트: `PascalCase` (예: `SignupForm.jsx`, `LoginForm.jsx`, `UserProfile.jsx`)
- 유틸·훅: `camelCase` (예: `useAuth.js`, `validateEmail.js`, `apiClient.js`)
- 테스트 파일: 대상과 동일한 base + `.test.jsx` (컴포넌트) 또는 `.test.js` (유틸)

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

## 5. API 호출 패턴

- `fetch` 또는 axios... 가 아니라 **fetch만**: `axios`는 `allowedDeps`에 없음.
- 응답 형식은 공통 규칙 §3 — `{ success, data, error }`.
  ```js
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  ```

## 6. 테스트 (FE)

- 도구: **Vitest + React Testing Library + jsdom** (`lib/stack.config.json` FE 블록 참조).
- 파일 패턴: `<Component>.test.jsx` 또는 `<util>.test.js`.
- 컴포넌트 테스트는 RTL의 `render`, `screen.getBy...`, `userEvent` 사용:
  ```jsx
  import { render, screen } from '@testing-library/react';
  import userEvent from '@testing-library/user-event';
  import SignupForm from './SignupForm';

  test('submits valid form', async () => {
    render(<SignupForm />);
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
    // ...
  });
  ```

## 7. 스타일링

- 스택에 CSS-in-JS 라이브러리는 없음. 인라인 style 또는 `<style>` 태그 또는 별도 `.css` 파일 import 사용.
- Tailwind 등 외부 의존성 도입 금지.

## 8. 보호 파일 (FE)

`lib/stack.config.json` `FE.protectedConfigFiles`에 정의됨. 일반적으로:
- `FE/package.json`, `FE/package-lock.json`
- `FE/vite.config.js`
- `FE/index.html`
- `FE/.eslintrc.json`
- `FE/src/setupTests.js` (Vitest 환경)

이 파일들은 응답에 절대 포함하지 말 것. 응답에 들어가면 라운드가 ERROR로 처리됩니다.
