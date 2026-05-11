/**
 * CodeChecker Agent
 *
 * Phase 1 of the orchestration:
 *   1. Classify user requirement → 'FE' | 'BE' | 'BOTH'
 *   2. If BOTH: write shared/api_contract.json (endpoints, methods, request/response schemas)
 *   3. Produce fe_spec / be_spec for downstream agents
 *
 * Owns INSERTs into:
 *   - log_agent_decisions (1 row, final_verdict='IN_PROGRESS')
 *   - log_task_state      (1~2 rows, status='PENDING')
 *
 * Always logs its own log_agent_runs row (RUNNING → SUCCESS/FAILED).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');
const { callJSON, assertContextBudget } = require('../lib/llm');

const ROOT = path.resolve(__dirname, '..');

const SYSTEM_PROMPT = `당신은 풀스택 요구사항 분석가다.
사용자 자연어 요구사항을 받아 다음을 결정한다:
1) targets: "FE", "BE", "BOTH" 중 하나
2) targets가 "BOTH" 또는 "BE"면 BE 명세(be_spec) 작성
3) targets가 "BOTH" 또는 "FE"면 FE 명세(fe_spec) 작성
4) targets가 "BOTH"면 api_contract도 작성

규칙:
- be_spec / fe_spec은 **핵심만 간결히** (한 영역당 max ~600 tokens). 자연어 설명 최소화, 구조화된 list/object 우선.
- api_contract: { version, endpoints: [{ path, method, request: {...JSON Schema...}, response: {...} }] }
- 응답 형식은 항상 JSON 객체. 반드시 "targets" 키 포함.
- 회원가입 류의 흔한 요구사항이면 검증 규칙(예: 이메일 형식, 비밀번호 길이) 명시.
- 보안: 비밀번호는 bcrypt 해시. SQL injection 방지를 위해 prepared statement.
- 응답 형식 표준: { success: bool, data: any, error?: string }
- be_spec / fe_spec에 lint 설정(.eslintrc), Docker 설정(Dockerfile, .dockerignore), 의존성 매니페스트(package.json, package-lock.json) 변경 가이드를 포함하지 말 것. 이 파일들은 protected이라 BE/FE Agent가 수정 못 한다.`;

function buildUserPrompt(userRequirement) {
  return [
    '아래 요구사항을 분석하라:',
    '---',
    userRequirement,
    '---',
    '',
    '다음 JSON 스키마로 응답하라:',
    `{`,
    `  "targets": "FE" | "BE" | "BOTH",`,
    `  "be_spec": { ... } | null,`,
    `  "fe_spec": { ... } | null,`,
    `  "api_contract": { ... } | null,`,
    `  "rationale": "분류 근거 1-2문장"`,
    `}`,
    '',
    '"targets"가 "BOTH"가 아니면 해당 영역의 spec은 null로 두어도 된다.',
    '"BOTH"인 경우 api_contract는 반드시 채워라.',
  ].join('\n');
}

/**
 * @param {Object} params
 * @param {string} params.task_id
 * @param {string} params.user_request
 * @returns {Promise<{
 *   targets: 'FE'|'BE'|'BOTH',
 *   be_spec: Object|null,
 *   fe_spec: Object|null,
 *   api_contract: Object|null,
 *   decision_id: number,
 *   state_ids: { FE?: number, BE?: number }
 * }>}
 */
async function run({ task_id, user_request }) {
  const run_id = await logger.startRun({
    task_id,
    agent_name: 'CodeChecker',
    input_json: { user_request },
  });

  try {
    const userPrompt = buildUserPrompt(user_request);
    // S1: max_tokens explicit at the call site for tunability + visibility.
    const max_tokens = 8192;
    // Pre-call context budget check (also re-checked inside callJSON as defense in depth)
    assertContextBudget({ system: SYSTEM_PROMPT, user: userPrompt, agent: 'codechecker', max_tokens });
    const llmOut = await callJSON({
      agent: 'codechecker',
      system: SYSTEM_PROMPT,
      user: userPrompt,
      max_tokens,
      // CodeChecker는 user_request가 큰 spec일 때 캐시 효과. 같은 spec 재실행
      // (디버깅·시연 반복) 시 5분 TTL 안에서 ~90% 절감. user_request가 작으면
      // 캐시 임계값 미달로 자동 no-op.
      cache: 'user',
    });

    const targets = llmOut.targets;
    if (!['FE', 'BE', 'BOTH'].includes(targets)) {
      throw new Error(`Invalid targets from LLM: ${JSON.stringify(targets)}`);
    }

    // Persist api_contract.json if BOTH
    if (targets === 'BOTH') {
      if (!llmOut.api_contract) {
        throw new Error('targets=BOTH but api_contract is missing in LLM response');
      }
      const contractPath = path.join(ROOT, 'shared', 'api_contract.json');
      fs.writeFileSync(contractPath, JSON.stringify(llmOut.api_contract, null, 2) + '\n', 'utf8');
    }

    // INSERT decision (1 row)
    const decision_id = await logger.insertDecision(task_id);

    // INSERT task_state row(s)
    const state_ids = {};
    if (targets === 'BE' || targets === 'BOTH') {
      state_ids.BE = await logger.insertTaskState(decision_id, 'BE');
    }
    if (targets === 'FE' || targets === 'BOTH') {
      state_ids.FE = await logger.insertTaskState(decision_id, 'FE');
    }

    const output = {
      targets,
      be_spec: llmOut.be_spec || null,
      fe_spec: llmOut.fe_spec || null,
      api_contract: llmOut.api_contract || null,
      rationale: llmOut.rationale || '',
      decision_id,
      state_ids,
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
