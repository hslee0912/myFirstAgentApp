/**
 * Agent runtime error 분류 (D34, 2026-05-14).
 *
 * BE/FE Agent의 run() 호출이 throw할 수 있는 모든 *runtime 가드 throw*를
 * 카테고리별로 분류해 *retryable 여부*와 *LLM에게 보낼 fix_instructions*를
 * 만든다. orchestrator의 try-catch가 이걸 사용해 *분류 가능한 throw*는
 * task_state를 FAILED + retry_count++ + fix_instructions로 업데이트하고
 * 다음 round에서 Agent retry로 회복을 시도한다.
 *
 * 분류 안 되는 throw(시스템 예외 — DB connection, fs permission 등)는
 * retryable=false로 표시되어 orchestrator가 그대로 ERROR로 처리.
 *
 * Throw 발생 위치 (현 시스템 inventory):
 *   1. lib/prompt_util.js:178  → UNAUTHORIZED_DEPS
 *   2. be_agent.js:188 / fe_agent.js:168  → PATH_BOUNDARY
 *   3. be_agent.js:192 / fe_agent.js:172  → PROTECTED_PATH
 *   4. be_agent.js:195 / fe_agent.js:175  → PATH_NOT_ALLOWED
 *   5. lib/fs_util.js:28  → PATH_UNSAFE
 *   6. lib/llm.js:130-134 → CONTEXT_BUDGET
 *   7. lib/llm.js:137-140 → MAX_TOKENS_EXCEEDS_MODEL (시스템 설정 — 미분류)
 *   8. lib/llm.js:298     → LLM_TRUNCATED (continuation 한계)
 *   9. lib/llm.js:394-399 → JSON_PARSE_FAIL (callJSON 내부 재시도 후에도 실패)
 *  10. apiClient.messages.create — anthropic SDK throw (D34+):
 *      - 네트워크 (ECONNRESET / ETIMEDOUT / ENOTFOUND / socket hang up)
 *      - rate limit (429 / rate_limit_error / overloaded_error)
 *      - 일시 5xx (500 / 502 / 503 / internal_server_error)
 *        → LLM_API_TRANSIENT (retryable — cycle retry로 시간 흘러 회복)
 *      - auth (401 / invalid x-api-key / authentication_error)
 *        → LLM_API_AUTH (retryable=false — .env API key 문제, retry 무의미)
 *
 * SDK 에러는 .message 외에 .status / .error.type / .code 같은 metadata도 갖는다.
 * classifier가 .message + .status + .error.type을 *합친 문자열*에 패턴 매치
 * 해 SDK가 message에 코드를 안 적은 케이스도 분류 가능.
 */
'use strict';

/**
 * @typedef {Object} Classification
 * @property {boolean} retryable
 * @property {string} category
 * @property {string} hint
 * @property {string} original_message
 */

/**
 * 패턴 매트릭스 — 순서대로 검사. 첫 매치를 반환.
 * 모든 카테고리에 *fix_instructions 힌트*가 함께 있어 LLM이 회복 시도 가능.
 */
const RETRYABLE_PATTERNS = [
  {
    pattern: /Unauthorized dependencies detected/i,
    category: 'UNAUTHORIZED_DEPS',
    hint:
      '허가된 의존성(allowedDeps)만 사용하세요. package.json은 protected이라 수정 불가. ' +
      '대안: (1) 같은 효과를 allowed deps로 재구현, (2) 정말 필요하면 notes에 "추가 dep 요청" 사유만 적기 (코드 추가 X). ' +
      '예: react-router-dom 대신 useState + hashchange 이벤트로 라우팅 구현.',
  },
  {
    pattern: /is a protected stack config file/i,
    category: 'PROTECTED_PATH',
    hint:
      '해당 경로는 lib/stack.config.json의 protectedConfigFiles로 보호됨 (package.json, vite.config.js, .eslintrc.json, Dockerfile 등). ' +
      '응답에서 그 파일을 완전히 제외하고, 같은 기능을 다른 파일에서 구현하세요.',
  },
  {
    pattern: /Disallowed path .*must start with/i,
    category: 'PATH_BOUNDARY',
    hint:
      '경로는 반드시 자기 영역(BE/ 또는 FE/) 안에 있어야 합니다. ' +
      '다른 영역(반대편) 또는 루트 디렉터리 파일 emit 금지. 모든 path는 BE/src/... 또는 FE/src/... 형태로.',
  },
  {
    pattern: /not in allowed_paths/i,
    category: 'PATH_NOT_ALLOWED',
    hint:
      'Retry 모드에서는 *fix_instructions에 명시된 파일*만 수정 가능합니다. ' +
      '새 파일 만들거나 다른 파일 변경 금지. 현재 fix_instructions의 파일 목록만 응답에 포함하세요.',
  },
  {
    pattern: /path .* is outside/i,
    category: 'PATH_UNSAFE',
    hint:
      'Path가 base 디렉터리 바깥을 가리키고 있습니다 (symlink/.. 등). ' +
      '상대 경로 대신 명시적 하위 경로 사용. ".." / 절대경로 / symlink 우회 금지.',
  },
  {
    pattern: /Context budget exceeded/i,
    category: 'CONTEXT_BUDGET',
    hint:
      'Prompt + max_tokens가 모델 input window 초과. ' +
      '응답을 더 간결하게: 작은 파일로 분할, 불필요한 placeholder 응답 제외, notes를 짧게.',
  },
  {
    pattern: /did not return valid JSON|JSON\.parse|Unexpected token/i,
    category: 'JSON_PARSE_FAIL',
    hint:
      '응답이 유효한 JSON이 아닙니다. ' +
      '필수 형식: { "files": { "<path>": "<full content>" }, "notes": "..." } — 마크다운 ```json ``` 감싸기, 주석, trailing comma 모두 금지. ' +
      '순수 JSON 객체만 응답하세요.',
  },
  // D34+ (2026-05-14): anthropic SDK 호출 자체의 throw 패턴.
  // 우선순위 주의: LLM_API_AUTH 패턴이 LLM_API_TRANSIENT보다 앞에 있어야 401이
  // *transient 401-매치 안 되도록* (현재 transient는 429/5xx만 매치하므로 안전).
  {
    pattern: /(401\b|invalid_api_key|invalid.x.api.key|authentication_error|unauthorized.*api)/i,
    category: 'LLM_API_AUTH',
    retryable_override: false,   // 명시적 non-retryable (auth는 시간 흘러도 회복 X)
    hint:
      'Anthropic API 인증 실패. .env의 ANTHROPIC_API_KEY 값을 확인하세요. ' +
      'retry로 회복 불가 — orchestrator는 즉시 ERROR로 종료.',
  },
  {
    pattern: /(rate.?limit|\b429\b|overloaded_error|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|\b50[023]\b|internal_server_error|service.?unavailable|connection error)/i,
    category: 'LLM_API_TRANSIENT',
    hint:
      'Anthropic API 일시 장애 (rate limit / 5xx / network). ' +
      'prompt 변경 불필요 — 시간이 지나면 자연 회복. cycle retry로 자동 재호출. ' +
      '연속 발생 시 .env의 BE/FE 모델 토글이나 호출 빈도 점검.',
  },
];

/**
 * Agent run에서 throw한 Error를 분류.
 *
 * SDK 에러는 .message 외에 .status / .error.type / .code metadata도 가질 수 있어
 * 셋을 합친 *signature 문자열*에 패턴 매치한다. 일반 Error는 message만으로도 충분.
 *
 * @param {Error|unknown} err
 * @returns {Classification}
 */
function classifyAgentError(err) {
  const msg = String((err && err.message) || err || '');
  // SDK metadata 합치기 (anthropic SDK 같은 라이브러리의 error.status / error.type 보강)
  const status = err && (err.status != null ? String(err.status) : '');
  const errorType = err && err.error && err.error.type ? String(err.error.type) : '';
  const code = err && err.code ? String(err.code) : '';
  const signature = `${msg} status=${status} type=${errorType} code=${code}`;

  for (const p of RETRYABLE_PATTERNS) {
    if (p.pattern.test(signature)) {
      // retryable_override가 명시되면 그것 우선 (e.g. LLM_API_AUTH는 retryable=false)
      const retryable = (p.retryable_override !== undefined) ? p.retryable_override : true;
      return {
        retryable,
        category: p.category,
        hint: p.hint,
        original_message: msg,
      };
    }
  }
  return {
    retryable: false,
    category: 'UNKNOWN',
    hint: '시스템 예외 (DB connection / fs permission / OOM / SDK 비-인식 throw 등)로 추정. retry 대상 아님.',
    original_message: msg,
  };
}

/**
 * 분류 결과 → LLM에게 보낼 fix_instructions 문자열.
 * 카테고리별 hint + 원본 에러 메시지(자르기)를 합쳐 *재시도 시 LLM이 회복 가능*한 안내.
 *
 * @param {Classification} cls
 * @returns {string}
 */
function buildFixInstructions(cls) {
  if (!cls.retryable) return cls.original_message;
  const trimmed = cls.original_message.slice(0, 800);
  return (
    `[Agent guard — ${cls.category}]\n\n` +
    `${cls.hint}\n\n` +
    `원본 에러 메시지:\n${trimmed}`
  );
}

module.exports = {
  classifyAgentError,
  buildFixInstructions,
  RETRYABLE_PATTERNS,
};
