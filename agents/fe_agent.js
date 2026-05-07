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
const { callJSON } = require('../lib/llm');
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
    '규칙:',
    '- 응답은 반드시 JSON: { "files": { "<repo-relative-path>": "<full file content>" }, "notes": "..." }',
    `- 모든 경로는 "${BASE}/"로 시작해야 한다. ${BASE === 'FE' ? 'BE/ 등 다른 폴더는 절대 손대지 말 것.' : '다른 폴더는 절대 손대지 말 것.'}`,
    `- 새로 작성하는 모든 컴포넌트/함수에는 최소 1개의 단위 테스트를 동반해야 한다 (${a.testFilePattern}, ${a.testFramework}).`,
    `- 의존성은 ${BASE}/package.json에 이미 포함된 것만 사용 (${a.allowedDeps}).`,
    `- ${a.moduleSystem}.`,
    '',
    '스택 규칙:',
    ...a.stackSpecificRules.map((r) => `- ${r}`),
    '',
    '보호 파일 (스택 매니페스트/빌드 설정 — 절대 수정·생성 금지):',
    protectedList || '  (없음)',
    '필요한 의존성·플러그인이 부족하면 코드를 만들지 말고 응답의 `notes`에 사유를 기록하라. 위 파일들에 대한 응답은 Orchestrator에서 거부된다.',
    '',
    '- 기존 파일은 보존이 우선. 명시적으로 수정해야만 응답에 포함하라.',
  ].join('\n');
}

function readConvention() {
  const common = fs.readFileSync(path.join(ROOT, 'rules', 'common.md'), 'utf8');
  const feSpecific = fs.readFileSync(path.join(ROOT, 'rules', 'fe.md'), 'utf8');
  return common + '\n\n---\n\n' + feSpecific;
}

// Built once at module load. Includes rules so the entire system prompt is
// stable across calls within an orchestrator run → prompt caching can hit.
const SYSTEM_PROMPT =
  buildSystemPrompt(stackCfg) +
  '\n\n## rules (common + FE-specific, 반드시 준수)\n\n' +
  readConvention();

function readApiContractIfAny() {
  const p = path.join(ROOT, 'shared', 'api_contract.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
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
  return [
    '## fe_spec',
    '```json',
    JSON.stringify(fe_spec, null, 2),
    '```',
    '',
    '## api_contract (BE 엔드포인트 — 이 형식 그대로 fetch 호출)',
    api_contract ? '```json\n' + JSON.stringify(api_contract, null, 2) + '\n```' : '(없음)',
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
    `권장 구조: ${BASE}/src/components/<Feature>.jsx, ${BASE}/src/api/<feature>.js, 동반 ${stackCfg.agent.testFilePattern}`,
    '',
    '응답 JSON 스키마:',
    `{ "files": { "${BASE}/path/to/file": "<full content>" }, "notes": "<짧은 설명>" }`,
  ].join('\n');
}

function buildRetryUserPrompt({ fe_spec, api_contract, existing_files, allowed_paths, fix_instructions }) {
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
      userPrompt = buildRetryUserPrompt({
        fe_spec: params.fe_spec || {},
        api_contract,
        existing_files: params.existing_files || {},
        allowed_paths: params.allowed_paths || [],
        fix_instructions: params.fix_instructions || '',
      });
    } else {
      const initialExisting =
        params.existing_files ||
        fsu.snapshot(fsu.listFiles(BASE, SNAPSHOT_EXTS).filter((f) => f.startsWith(SNAPSHOT_ROOT_GLOB)));
      userPrompt = buildInitialUserPrompt({
        fe_spec: params.fe_spec || {},
        api_contract,
        existing_files: initialExisting,
      });
    }

    const llmOut = await callJSON({ agent: 'fe', system: SYSTEM_PROMPT, user: userPrompt, cache: 'system' });
    const files = llmOut.files || {};

    validatePaths(files, { mode, allowed_paths: params.allowed_paths });
    applyFiles(files);

    const output = {
      mode,
      written_files: Object.keys(files),
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

module.exports = { run };
