/**
 * FE Agent
 *
 * Owns: FE/ directory only. Must NEVER touch BE/.
 * Stack-specific bits (system prompt, allowed deps, eslintrc, snapshot exts) come from
 * lib/stack.config.json — swapping the FE stack should NOT require editing this file.
 *
 * Modes:
 *   - mode='initial': free-form generation under FE/ from fe_spec + api_contract,
 *                     receives existing_files snapshot so placeholder tests are honored.
 *   - mode='retry'  : whitelisted partial fix per Lint's fix_instructions.
 *
 * Always:
 *   - reads rules/common.md + rules/fe.md
 *   - writes a unit test for any new component/function (per stack config testFilePattern)
 *   - creates FE/.eslintrc.json if missing (from stack config eslintConfig)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const { callJSON, assertContextBudget } = require('../lib/llm');
const { abridgeExistingFiles, abridgeForRetry, dropProtectedFiles, validateAllowedDeps } = require('../lib/prompt_util');
const { autoFixDependencyAliases } = require('../lib/dep_autofix');
const { assertFEContract } = require('../lib/fe_contract_guard');
const { checkPlaceholderUsageInFiles, formatMissingForFix } = require('../lib/placeholder_usage_check');
const { dropAgentGeneratedTests, generateSmokeTests } = require('../lib/test_codegen');
const { endpointChecklist } = require('../lib/api_test');
const fsu = require('../lib/fs_util');
const stack = require('../lib/stack');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'FE';

const stackCfg = stack.get(BASE);
const SNAPSHOT_EXTS = stackCfg.snapshot.extensions;
const SNAPSHOT_ROOT_GLOB = stackCfg.snapshot.rootGlob;
const PROTECTED_FILES = stackCfg.protectedConfigFiles || [];

function buildSystemPrompt(cfg) {
  const a = cfg.agent;
  const protectedList = (cfg.protectedConfigFiles || []).map((f) => `  - ${f}`).join('\n');
  return [
    a.systemPromptHeader,
    '',
    '## 🚫 의존성 (필독 — 위반 시 즉시 round ERROR, retry 자원 낭비)',
    '',
    `**FE allowedDeps (정확 7개, 이 외 import/require 절대 emit 금지)**:`,
    '```',
    a.allowedDeps,
    '```',
    '',
    '비즈니스 코드(.jsx 컴포넌트·hook·service)에서 import 가능한 건 사실상 `react` + `react-dom` 둘뿐. 나머지(vite, vitest, jsdom, @testing-library/*)는 빌드·테스트 환경 전용.',
    '',
    '### 절대 금지 패키지 — *학습 데이터 빈도 높아 자동완성 함정* (대체 코드 표)',
    '',
    '| ❌ 금지 | 시도 동기 | ✅ 대체 |',
    '|---|---|---|',
    '| `react-router-dom` | SPA 라우팅 | `useState`로 현재 페이지 state 관리 + 조건부 렌더링. 필요하면 `window.location.hash` + `hashchange` 이벤트. |',
    '| `axios`, `node-fetch` | HTTP 호출 | 브라우저 기본 `fetch` (global, import 불필요). |',
    '| `react-hook-form`, `formik` | form 관리 | `useState`로 controlled inputs. |',
    '| `redux`, `zustand`, `recoil`, `jotai` | 전역 state | `useState`/`useReducer` + props drilling 또는 React Context. |',
    '| `lodash`, `ramda` | 유틸 | `Array.prototype.map/filter/reduce`, `Object.entries/keys`, 직접 구현. |',
    '| `moment`, `date-fns`, `dayjs` | 날짜 | builtin `Date` + `toLocaleString()` / `toISOString()`. |',
    '| `uuid` | UUID 생성 | `crypto.randomUUID()` (브라우저 builtin). |',
    '| `jsonwebtoken` | 토큰 발급/검증 | PoC 스코프 밖 — FE는 토큰 발급 X. `notes`에만 기록. |',
    '| `bcrypt`, `bcryptjs`, `crypto-js` | 비밀번호 해싱 | **FE 사전 해시 금지** — 평문 그대로 fetch body, BE가 bcrypt 처리. |',
    '| `styled-components`, `@emotion/react`, `@emotion/styled` | CSS-in-JS | 인라인 `style={{...}}` 또는 `.css` import. |',
    '| `tailwindcss` | utility CSS | 인라인 style 또는 plain CSS. |',
    '| `clsx`, `classnames` | className 결합 | `[a, b].filter(Boolean).join(\' \')`. |',
    '| `react-icons`, `@mui/icons-material`, `@heroicons/react` | 아이콘 | SVG 인라인 또는 텍스트(이모지/유니코드). |',
    '| `@mui/material`, `antd`, `chakra-ui` | UI 컴포넌트 라이브러리 | 직접 JSX + 인라인 style. |',
    '| `react-query`, `swr` | 데이터 fetching | `useEffect` + `fetch` + `useState`. |',
    '| `email-validator`, `joi`, `zod`, `yup`, `validator` | 입력 검증 | regex 직접 (`/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`) 또는 `if`/`else`. |',
    '',
    '### 응답 emit 직전 self-check (필수)',
    '',
    '응답 JSON 직렬화 *직전* 다음 순서로 손으로 한 번 더:',
    '1. 응답의 모든 `.js`/`.jsx` 파일을 열어 `import` / `require` 라인을 *전부* 모은다.',
    '2. 각 라인의 모듈명이 다음 중 하나인지 확인:',
    '   - 상대경로 (`./`, `../`)',
    `   - Node.js builtin (FE에선 보통 없음)`,
    `   - allowedDeps의 정확한 이름 (${a.allowedDeps})`,
    '3. 셋 중 어느 것도 아니면 *그 줄을 emit하지 말 것*. 학습 분포 따라 `react-router-dom` 등을 무의식적으로 적었다면 위 표의 대체 코드로 *바로 치환*. retry로 풀리는 게 정상이 아니다 — 처음부터 안 쓰는 게 정상 경로.',
    '',
    '---',
    '',
    '규칙:',
    '- 응답은 반드시 JSON: { "files": { "<repo-relative-path>": "<full file content>" }, "notes": "..." }',
    `- 모든 경로는 "${BASE}/"로 시작해야 한다. ${BASE === 'FE' ? 'BE/ 등 다른 폴더는 절대 손대지 말 것.' : '다른 폴더는 절대 손대지 말 것.'}`,
    `- **단위 테스트는 시스템(lib/test_codegen.js)이 자동 생성한다**. *.test.* file을 응답에 포함하지 말 것. 응답에 포함되면 silent drop됨.`,
    `- ${a.moduleSystem}.`,
    '',
    '스택 규칙:',
    ...a.stackSpecificRules.map((r) => `- ${r}`),
    '',
    '보호 파일 (lint 설정 / docker 설정 / 스택 매니페스트 — 절대 수정·생성 금지):',
    protectedList || '  (없음)',
    '**위 파일은 fix_instructions나 existing_files에 언급·포함되어 있더라도 응답에서 완전히 제외하라.** 응답에 포함하면 Orchestrator의 validatePaths에서 즉시 차단되어 task가 ERROR로 종료된다.',
    '필요한 의존성·플러그인이 부족하면 코드를 만들지 말고 응답의 `notes`에 사유를 기록하라.',
    '',
    '- 응답에 포함된 file은 disk에 덮어씌워진다 (응답하지 않은 file은 그대로 유지).',
    '- **새로 만드는 모든 file은 반드시 응답에 포함하라** — 이것이 핵심 산출물이다.',
    '- 기존 placeholder는 *내용을 실제로 변경한 경우에만* 응답에 포함하라.',
    '- 내용 변경 없는 placeholder는 응답에서 완전히 제외 (토큰 낭비). notes에 "kept N files unchanged" 정도만 명시.',
  ].join('\n');
}

function readConvention() {
  const common = fs.readFileSync(path.join(ROOT, 'rules', 'common.md'), 'utf8');
  const feSpecific = fs.readFileSync(path.join(ROOT, 'rules', 'fe.md'), 'utf8');
  return common + '\n\n---\n\n' + feSpecific;
}

// D97 (2026-05-21): placeholder 필드 인벤토리를 prompt 상단에 inject.
// LLM이 추측하다가 환각 필드명(`SPAWN_CONFIG.intervalMs` 등)을 발명하는 패턴 차단.
// `lib/placeholder_inventory.js`가 game.js를 정규식 파싱해 export 객체의 키 목록을
// 생성. 빈 game.js 또는 파일 부재 시 fallback으로 빈 문자열.
function readPlaceholderInventory() {
  try {
    const { buildPlaceholderInventory } = require('../lib/placeholder_inventory');
    const ph = path.join(ROOT, 'lib', 'stack_templates', 'FE', 'src', 'constants', 'game.js');
    if (!fs.existsSync(ph)) return '';
    return buildPlaceholderInventory(ph);
  } catch (err) {
    logger.warn('placeholder_inventory build failed: ' + err.message);
    return '';
  }
}

// Built once at module load. Includes rules so the entire system prompt is
// stable across calls within an orchestrator run → prompt caching can hit.
const PLACEHOLDER_INVENTORY = readPlaceholderInventory();
const SYSTEM_PROMPT =
  buildSystemPrompt(stackCfg) +
  (PLACEHOLDER_INVENTORY
    ? '\n\n## 🔒 PLACEHOLDER FIELD INVENTORY (D97 — 반드시 이 필드명만 사용)\n\n' +
      PLACEHOLDER_INVENTORY +
      '\n\n위 인벤토리에 없는 필드명(예: `intervalMs`, `frequency`, `maxEnemies`, ' +
      '`.type` 같은 환각)을 사용하면 빌드/테스트 실패. *추측 금지* — 정확한 이름만.' +
      '\n\n⚠️⚠️ **PATTERN_DEFINITIONS 사용 룰 (D97-bis-3)** — *플레이어와 적 모두* ' +
      '같은 PATTERN_DEFINITIONS lookup을 거쳐 발사해야 함. fireEnemyBullet 같은 ' +
      '함수에서 `BULLET_SPEED * 0.7 * unit(dx,dy)` 같은 *aimed 단발 hardcode 금지*. ' +
      '플레이어와 같은 코드 경로 (helper 1개 권장), 기준 각도만 다름 ' +
      '(플레이어=-π/2, 적=atan2). bullets / speedMul / pierce / fixedDirection 4 ' +
      '필드를 *적 발사에도* 그대로 적용.'
    : '') +
  '\n\n## rules (common + FE-specific, 반드시 준수)\n\n' +
  readConvention();

function readApiContractIfAny() {
  const p = path.join(ROOT, 'shared', 'api_contract.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Inline shared/router/<name>.json into each index entry so the LLM prompt
    // sees the full endpoint spec (request/responses), not just the index.
    const { normalizeContract } = require('../lib/api_test');
    return normalizeContract(raw, {
      routerDir: path.join(ROOT, 'shared', 'router'),
    });
  } catch (_) {
    return null;
  }
}

function ensureEslintrc() {
  const p = path.join(ROOT, BASE, '.eslintrc.json');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(stackCfg.eslintConfig, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}

function buildInitialUserPrompt({ fe_spec, api_contract, existing_files }) {
  // D39 (2026-05-14): endpoint checklist — FE도 contract 모든 endpoint를 *fetch
  //   호출 대상*으로 인지해야 함. JSON 외에 명시적 list 추가.
  const checklist = endpointChecklist(api_contract);
  return [
    '## fe_spec',
    '```json',
    JSON.stringify(fe_spec, null, 2),
    '```',
    '',
    '## api_contract (BE 엔드포인트 — 이 형식 그대로 fetch 호출)',
    api_contract ? '```json\n' + JSON.stringify(api_contract, null, 2) + '\n```' : '(없음)',
    '',
    '## 사용 가능한 endpoint (api_contract 선언 — fetch URL은 정확히 이 path와 일치해야 함)',
    checklist || '(없음)',
    '- 절대 다른 path로 fetch 호출하지 말 것. base_url 누락이나 prefix 오타는 BE에서 404.',
    '',
    '## 기존 파일 (bootstrap이 깐 placeholder + 이전 라운드 산출물)',
    '```json',
    JSON.stringify(existing_files || {}, null, 2),
    '```',
    '',
    '### 기존 파일 처리 규칙 (필수)',
    `- ${stackCfg.agent.testFilePattern} 파일은 **명세에 명백히 어긋나지 않는 한 절대 수정/삭제하지 말 것**.`,
    '- placeholder 테스트가 기대하는 컴포넌트 동작·텍스트를 새 코드에서 그대로 만족시켜라.',
    '- 진입점 main.jsx 와 App.jsx 는 비즈니스 컴포넌트 추가는 OK. 단, placeholder 테스트가 검증하는 텍스트(예: "placeholder")가 사라지면 테스트가 실패하므로, 기존 컴포넌트는 보존하거나 placeholder 테스트도 함께 합리적으로 수정.',
    '',
    '## 작업',
    `${BASE}/src/ 아래에 위 명세를 만족하는 코드와 단위 테스트를 작성하라.`,
    `권장 구조: ${BASE}/src/components/<Feature>.jsx, ${BASE}/src/api/<feature>.js. **테스트는 시스템이 자동 생성하므로 응답에 포함하지 말 것**.`,
    '',
    '## ⚠️ 응답 JSON 직렬화 직전 마지막 self-check (FE 한정)',
    '- 모든 `.jsx`/`.js` 파일의 `import` 라인을 한 번 더 훑었는가?',
    `- 각 import의 모듈명이 *상대경로* 또는 *${BASE} allowedDeps의 정확한 이름* (${stackCfg.agent.allowedDeps}) 중 하나인가?`,
    '- 학습 분포 따라 `react-router-dom` / `axios` / `lodash` / `react-hook-form` 등을 무의식적으로 적은 라인은 없는가? 있다면 system prompt 상단 *절대 금지 패키지 표*의 대체 코드로 *지금 바로* 치환.',
    '- 위 셋 다 OK일 때만 응답 emit. (위반 시 *round 통째 ERROR* — Lint도 안 가고 종료. 회복은 비용 큼.)',
    '',
    '응답 JSON 스키마:',
    `{ "files": { "${BASE}/path/to/file": "<full content>" }, "notes": "<짧은 설명>" }`,
  ].join('\n');
}

function buildRetryUserPrompt({ fe_spec, api_contract, existing_files, allowed_paths, fix_instructions }) {
  const checklist = endpointChecklist(api_contract);
  return [
    '## 모드: RETRY (부분 수정)',
    '',
    '## fe_spec (참고)',
    '```json',
    JSON.stringify(fe_spec, null, 2),
    '```',
    '',
    '## api_contract (참고)',
    api_contract ? '```json\n' + JSON.stringify(api_contract, null, 2) + '\n```' : '(없음)',
    '',
    '## 사용 가능한 endpoint (api_contract 선언)',
    checklist || '(없음)',
    '',
    '## 현재 파일 상태 (existing_files)',
    '```json',
    JSON.stringify(existing_files, null, 2),
    '```',
    '',
    '## 수정 허용 파일',
    '```json',
    JSON.stringify(allowed_paths, null, 2),
    '```',
    '',
    '## fix_instructions',
    fix_instructions || '(없음)',
    '',
    '## 작업',
    '- allowed_paths 파일만 수정. 그 외 파일은 응답에 포함하지 말 것.',
    '- 최소 수정 원칙.',
    '',
    '응답 JSON 스키마: { "files": { "<path>": "<full content>" }, "notes": "<짧은 설명>" }',
  ].join('\n');
}

function validatePaths(files, { mode, allowed_paths }) {
  for (const p of Object.keys(files)) {
    if (!p.startsWith(`${BASE}/`)) {
      throw new Error(`[FE Agent] Disallowed path '${p}' (must start with ${BASE}/)`);
    }
    fsu.resolveSafe(p, BASE);
    if (PROTECTED_FILES.includes(p)) {
      throw new Error(`[FE Agent] Path '${p}' is a protected stack config file (see lib/stack.config.json protectedConfigFiles)`);
    }
    if (mode === 'retry' && allowed_paths && !allowed_paths.includes(p)) {
      throw new Error(`[FE Agent] Path '${p}' not in allowed_paths`);
    }
  }
}

function applyFiles(files) {
  for (const [p, content] of Object.entries(files)) {
    fsu.writeFileSafe(p, content, BASE);
  }
}

async function run(params) {
  const { task_id, mode } = params;
  const run_id = await logger.startRun({
    task_id,
    agent_name: 'FE',
    target: 'FE',
    input_json: {
      mode,
      fe_spec: params.fe_spec,
      allowed_paths: params.allowed_paths,
      fix_instructions: params.fix_instructions,
      existing_files_keys: params.existing_files ? Object.keys(params.existing_files) : undefined,
    },
  });

  try {
    const eslintrcCreated = ensureEslintrc();
    const api_contract = params.api_contract || readApiContractIfAny();

    let userPrompt;
    if (mode === 'retry') {
      // O2: keep only allowed_paths in full, stub the rest.
      userPrompt = buildRetryUserPrompt({
        fe_spec: params.fe_spec || {},
        api_contract,
        existing_files: abridgeForRetry(params.existing_files || {}, params.allowed_paths || []),
        allowed_paths: params.allowed_paths || [],
        fix_instructions: params.fix_instructions || '',
      });
    } else {
      const initialExisting =
        params.existing_files ||
        fsu.snapshot(fsu.listFiles(BASE, SNAPSHOT_EXTS).filter((f) => f.startsWith(SNAPSHOT_ROOT_GLOB)));
      // O1: abridge large non-test files to keep input tokens manageable.
      userPrompt = buildInitialUserPrompt({
        fe_spec: params.fe_spec || {},
        api_contract,
        existing_files: abridgeExistingFiles(initialExisting),
      });
    }

    // S1: max_tokens explicit at the call site for tunability + visibility.
    // D55 (2026-05-15): Sonnet 4.5 (cap 64K)에서 30000으로 늘려 큰 FE 산출물도
    // 한 번에 받음. 게임 5 페이지 + canvas 같은 큰 응답도 continuation 1~2회로 마무리.
    const max_tokens = 30000;
    // Pre-call context budget check (also re-checked inside callJSON as defense in depth)
    assertContextBudget({ system: SYSTEM_PROMPT, user: userPrompt, agent: 'fe', max_tokens });

    // D64 (2026-05-15) inline retry: 같은 round 안 UNAUTHORIZED_DEPS 자동 회복 시도.
    const MAX_INLINE_RETRIES = Number(process.env.FE_AGENT_INLINE_RETRIES || 1);
    let llmOut;
    let userPromptForCall = userPrompt;
    let files, filesA, filesB;
    let droppedProtected;
    let droppedTests;
    let autoTests;

    for (let inlineRetry = 0; inlineRetry <= MAX_INLINE_RETRIES; inlineRetry++) {
      llmOut = await callJSON({ agent: 'fe', system: SYSTEM_PROMPT, user: userPromptForCall, cache: 'system', max_tokens });

      // D64 옵션 1: alias auto-fix (FE는 보통 bcryptjs 등 사용 안 하지만 대비).
      const fixed = autoFixDependencyAliases(llmOut.files || {});
      if (fixed.replacements.length > 0) {
        const summary = fixed.replacements.map((r) => `${r.from}→${r.to} in ${r.path}`).join('; ');
        console.log(`[fe:autofix] ${fixed.replacements.length} alias replacement(s): ${summary}`);
      }
      llmOut.files = fixed.files;

      // Y: silent-drop protected files BEFORE validatePaths.
      ({ files: filesA, dropped: droppedProtected } =
        dropProtectedFiles(llmOut.files, PROTECTED_FILES, 'FE Agent'));
      ({ files: filesB, dropped: droppedTests } =
        dropAgentGeneratedTests(filesA, 'FE Agent'));
      autoTests = generateSmokeTests(filesB);
      files = { ...filesB, ...autoTests };

      try {
        validateAllowedDeps(files, stackCfg.agent.allowedDeps, 'FE Agent');
        // D66 (2026-05-18) FE contract drift guard — fetch literal URL이 contract endpoints에
        // 매핑되는지 정적 검증. drift 발견 시 throw → inline retry로 LLM에게 fix 요청.
        const apiContract = readApiContractIfAny();
        if (apiContract) {
          assertFEContract(files, apiContract.endpoints || [], apiContract.base_url || '');
        }
        // D97-bis (2026-05-21) placeholder usage check — emit 직전 정적 스캔으로
        // 무기 동작 핵심 식별자(PATTERN_DEFINITIONS / bullets / speedMul /
        // fixedDirection)가 코드에 reference되는지 확인. 누락 시 throw → inline retry.
        const usage = checkPlaceholderUsageInFiles(files);
        if (!usage.ok) {
          const err = new Error(formatMissingForFix(usage.missing));
          err.code = 'MISSING_WEAPON_BEHAVIOR';
          err.missing = usage.missing;
          throw err;
        }
        break;  // PASS — exit inline retry loop
      } catch (e) {
        const retriableCodes = ['UNAUTHORIZED_DEPS', 'FE_CONTRACT_DRIFT', 'MISSING_WEAPON_BEHAVIOR'];
        if (!retriableCodes.includes(e.code) || inlineRetry >= MAX_INLINE_RETRIES) {
          throw e;
        }
        const violationLabel =
          e.code === 'FE_CONTRACT_DRIFT' ? 'contract drift' :
          e.code === 'MISSING_WEAPON_BEHAVIOR' ? '무기 동작 누락 (placeholder 필수 식별자 미참조)' :
          '미허가 의존성';
        console.log(`[fe:inline-retry ${inlineRetry + 1}/${MAX_INLINE_RETRIES}] ${e.code} — retrying with fix hint`);
        userPromptForCall =
          userPrompt +
          `\n\n---\n\n## ⚠️ 직전 응답에 ${violationLabel} 발견 — 즉시 fix하라\n\n` +
          e.message +
          '\n\n위 안내대로 코드를 바꾸고 *동일 형식*의 JSON으로 다시 emit하라.';
      }
    }

    validatePaths(files, { mode, allowed_paths: params.allowed_paths });
    applyFiles(files);

    const output = {
      mode,
      written_files: Object.keys(files),
      dropped_protected: droppedProtected,
      dropped_tests: droppedTests,
      auto_generated_tests: Object.keys(autoTests),
      eslintrc_created: eslintrcCreated,
      notes: llmOut.notes || '',
    };
    await logger.endRun(run_id, { status: 'SUCCESS', output_json: output });
    return output;
  } catch (e) {
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { error: e.message, stack: (e.stack || '').slice(0, 2000) },
    });
    throw e;
  }
}

module.exports = {
  run,
  // exported for unit tests only — prompt 함수 직접 검증용 (D39).
  _internal: { buildInitialUserPrompt, buildRetryUserPrompt },
};
