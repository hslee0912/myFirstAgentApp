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
const { normalizeContract } = require('../lib/api_test');

const ROOT = path.resolve(__dirname, '..');

function readSchemaIfAny() {
  try {
    return fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  } catch (_) {
    return null;
  }
}

const SCHEMA_SQL = readSchemaIfAny();
const SCHEMA_SECTION = SCHEMA_SQL
  ? `

## DB schema (실제 적용된 \`db/schema.sql\` — 반드시 이 테이블/컬럼/타입을 정확히 따를 것)

\`\`\`sql
${SCHEMA_SQL}
\`\`\`

규칙 (schema):
- BE 비즈니스 코드는 **\`app_users\`** 테이블만 사용. \`users\` 같은 다른 이름으로 SELECT/INSERT/UPDATE 절대 금지.
- \`log_agent_runs\`, \`log_agent_decisions\`, \`log_task_state\`는 agent system 전용 — 비즈니스 코드에서 절대 접근하지 말 것.
- \`api_contract\`의 \`example\` 값은 schema의 컬럼 타입과 정확히 일치. \`id INT AUTO_INCREMENT\`이면 example도 정수형 (e.g. 1, 42). UUID/string으로 emit 금지.
- 컬럼은 schema에 정의된 것만 사용. 새 컬럼 추가 가이드 금지.
- schema 변경 가이드(ALTER TABLE 등) 금지 — schema는 사용자 영역.`
  : '';

const SYSTEM_PROMPT = `당신은 풀스택 요구사항 분석가다.
사용자 자연어 요구사항을 받아 다음을 결정한다:
1) targets: "FE", "BE", "BOTH" 중 하나
2) targets가 "BOTH" 또는 "BE"면 BE 명세(be_spec) 작성
3) targets가 "BOTH" 또는 "FE"면 FE 명세(fe_spec) 작성
4) targets가 "BOTH"면 api_contract도 작성

규칙:
- be_spec / fe_spec은 **핵심만 간결히** (한 영역당 max ~600 tokens). 자연어 설명 최소화, 구조화된 list/object 우선.
- 응답 형식은 항상 JSON 객체. 반드시 "targets" 키 포함.
- 회원가입 류의 흔한 요구사항이면 검증 규칙(예: 이메일 형식, 비밀번호 길이) 명시.
- 보안: 비밀번호는 bcrypt 해시. SQL injection 방지를 위해 prepared statement.
- 응답 형식 표준: { success: bool, data: any, error?: string }
- be_spec / fe_spec에 lint 설정(.eslintrc), Docker 설정(Dockerfile, .dockerignore), 의존성 매니페스트(package.json, package-lock.json) 변경 가이드를 포함하지 말 것. 이 파일들은 protected이라 BE/FE Agent가 수정 못 한다.

## api_contract / router_details 형식 (split layout)

응답의 \`api_contract\`는 **endpoint index만** 담는다 (각 endpoint의 detail은 \`router_details\`에 별도로). 시스템이 두 부분을 받아 \`shared/api_contract.json\` + \`shared/router/<name>.json\` 두 위치에 저장한다.

\`api_contract\` (= index):
\`\`\`json
{
  "version": "1.0.0",
  "base_url": "/api/v1",                   // optional. BE는 이 prefix를 \`app.use\`에 적용.
  "endpoints": [
    {
      "name": "auth_signup",               // shared/router/<name>.json 파일명과 일치 (snake_case)
      "path": "/auth/signup",              // base_url 제외
      "method": "POST",
      "description": "사용자 회원가입"     // 한 줄 요약
    }
  ]
}
\`\`\`

\`router_details\` (= per-endpoint full spec, key는 위의 \`name\`):
\`\`\`json
{
  "auth_signup": {
    "path": "/auth/signup",
    "method": "POST",
    "description": "사용자 회원가입",
    "request": {
      "schema": { ... JSON Schema ... },   // properties.<field>.example 으로 request body 자동 구성
      "example": { ... }                   // optional
    },
    "responses": {                          // **반드시 객체** — key는 status code(string), value는 { schema }
      "201": { "schema": { ... } },
      "400": { "schema": { ... } },
      "409": { "schema": { ... } }
    }
  }
}
\`\`\`

규칙:
- \`api_contract.endpoints\`의 모든 \`name\`이 \`router_details\`에 1:1로 있어야 한다. 누락 시 Phase 9 PostTest가 throw.
- \`name\`은 snake_case. path를 기준으로 자연스러운 이름 (\`/auth/signup\` → \`auth_signup\`).
- **금지 형식 (Phase 9가 처리 못함)**: \`response\` (단수), \`success/error_cases\` 분리 구조, \`status_code\`를 schema 안에 두는 형식, endpoint detail을 \`api_contract\` 자체에 inline 두는 형식. **반드시 index + router_details 분리**.
- base_url을 적었으면 BE는 그 prefix를 \`app.use\`에 적용해야 한다.${SCHEMA_SECTION}`;

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
    `  "api_contract": { version, base_url?, endpoints: [{ name, path, method, description }] } | null,`,
    `  "router_details": { "<name>": { path, method, description?, request, responses } } | null,`,
    `  "rationale": "분류 근거 1-2문장"`,
    `}`,
    '',
    '"targets"가 "BOTH"가 아니면 해당 영역의 spec은 null로 두어도 된다.',
    '"BOTH"인 경우 api_contract + router_details 둘 다 반드시 채워라. router_details의 키는 api_contract.endpoints[].name과 1:1 매칭이어야 한다.',
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

    // Persist api_contract.json (index) + shared/router/<name>.json (details) if BOTH
    if (targets === 'BOTH') {
      if (!llmOut.api_contract) {
        throw new Error('targets=BOTH but api_contract is missing in LLM response');
      }
      if (!llmOut.router_details || typeof llmOut.router_details !== 'object') {
        throw new Error('targets=BOTH but router_details is missing in LLM response');
      }
      // Verify every index entry has a matching detail (and vice versa) so we
      // don't write a half-broken contract.
      const indexNames = (llmOut.api_contract.endpoints || []).map((e) => e.name);
      const detailNames = Object.keys(llmOut.router_details);
      const missingDetails = indexNames.filter((n) => !detailNames.includes(n));
      const orphanDetails = detailNames.filter((n) => !indexNames.includes(n));
      if (missingDetails.length > 0) {
        throw new Error(
          `api_contract endpoints reference names with no matching router_details entry: ${missingDetails.join(', ')}`
        );
      }
      if (orphanDetails.length > 0) {
        throw new Error(
          `router_details contains entries with no matching api_contract endpoint: ${orphanDetails.join(', ')}`
        );
      }

      // Write index.
      const contractPath = path.join(ROOT, 'shared', 'api_contract.json');
      fs.writeFileSync(contractPath, JSON.stringify(llmOut.api_contract, null, 2) + '\n', 'utf8');

      // Write per-endpoint detail files. mkdir is idempotent.
      const routerDir = path.join(ROOT, 'shared', 'router');
      fs.mkdirSync(routerDir, { recursive: true });
      // Remove any stale detail files no longer in the new contract — keeps
      // shared/router/ in sync with the current api_contract.
      for (const f of fs.readdirSync(routerDir)) {
        if (f.endsWith('.json')) {
          const base = f.slice(0, -'.json'.length);
          if (!detailNames.includes(base)) {
            try { fs.unlinkSync(path.join(routerDir, f)); } catch (_) { /* best-effort */ }
          }
        }
      }
      for (const [name, detail] of Object.entries(llmOut.router_details)) {
        const detailPath = path.join(routerDir, `${name}.json`);
        fs.writeFileSync(detailPath, JSON.stringify(detail, null, 2) + '\n', 'utf8');
      }
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

    // Build the in-memory expanded contract (split layout merged into the
    // canonical full form runEndpoint expects). Downstream BE/FE Agents see
    // this full form via api_contract in their params; disk stays split.
    let expandedContract = llmOut.api_contract || null;
    if (expandedContract && llmOut.router_details) {
      const inlined = (expandedContract.endpoints || []).map((e) => ({
        ...e,
        ...(llmOut.router_details[e.name] || {}),
      }));
      expandedContract = normalizeContract({ ...expandedContract, endpoints: inlined });
    }

    const output = {
      targets,
      be_spec: llmOut.be_spec || null,
      fe_spec: llmOut.fe_spec || null,
      api_contract: expandedContract,
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
