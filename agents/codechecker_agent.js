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
    return fs.readFileSync(path.join(ROOT, 'db', 'agent_schema.sql'), 'utf8');
  } catch (_) {
    return null;
  }
}

function readDomainRulesIfAny() {
  // 2026-05-20: rules/domain.md를 CodeChecker에도 inject — endpoint 간 validator/scenarios drift 차단.
  // BE/FE Agent는 이미 매 호출마다 rules/* 읽음. CodeChecker만 안 읽고 있어 spec 단계에서 drift 발생 가능.
  try {
    return fs.readFileSync(path.join(ROOT, 'rules', 'domain.md'), 'utf8');
  } catch (_) {
    return null;
  }
}

const SCHEMA_SQL = readSchemaIfAny();
const DOMAIN_RULES = readDomainRulesIfAny();
const DOMAIN_SECTION = DOMAIN_RULES
  ? `\n\n## 도메인 필드 카탈로그 (rules/domain.md — 반드시 글자 그대로 사용)\n\n${DOMAIN_RULES}`
  : '';
const SCHEMA_SECTION = SCHEMA_SQL
  ? `

## DB schema (\`db/agent_schema.sql\` — Agent 도구 전용)

\`\`\`sql
${SCHEMA_SQL}
\`\`\`

규칙 (schema):
- 위 \`log_agent_runs\`, \`log_agent_decisions\`, \`log_task_state\`, \`log_db_migrations\`는 **agent system 전용**. 비즈니스 코드에서 SELECT/INSERT/UPDATE/DELETE 절대 금지.
- **비즈니스 DB 영속화는 BE Agent가 \`BE/db/migrations/<timestamp>_<name>.sql\` 파일을 emit해 처리** (D33, 2026-05-14). orchestrator Phase 2.5가 자동 적용.
- be_spec에 비즈니스 schema가 필요하면 *어떤 테이블·컬럼이 필요한지*를 \`notes\`에 명시 (예: "users(id INT PK, email VARCHAR UNIQUE, password_hash VARCHAR)"). BE Agent가 그 spec을 바탕으로 migration 파일을 작성한다.
- api_contract의 \`example\` 값은 schema 컬럼 타입과 정확히 일치 (\`id INT AUTO_INCREMENT\`면 example도 정수형).
- CodeChecker 자신은 SQL emit 안 함 — be_spec.notes에 schema 의도만 적고, 실제 SQL은 BE Agent가 작성.`
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
  "base_url": "/api/v1",                   // 필수 (required). 값은 반드시 "/api/v1" 고정 — Nginx reverse proxy가 이 prefix만 BE 컨테이너로 forward. 다른 값(/api, /v1, /api/v2 등) 금지. BE는 이 prefix를 \`app.use\`에 적용.
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
- ⚠️ D68: 각 endpoint의 router_details에 권장 — \`test_scenarios\` 배열 (PostTest 정밀 검증).
  형식: \`[{ name, request_body|request_query, expect_status, expect_response_subset }]\`. PostTest가 각 시나리오 모두 실행해 BE 실제 동작 (validation/edge case/error) 검증.
  권장 패턴: POST → valid_input(201), missing_field(400), duplicate(409); GET → valid_query(200), missing_query(400), empty_result(200, default 응답); 인증 → valid_credentials(200), invalid_credentials(401).
  미정의 시 기존 동작(request.example로 positive case 1번)만 검증 — 약함.
  ⚠️ **D69 시나리오 작성 룰** (어기면 시나리오 일제히 fail):
    1. **동적 값(auto-increment id, INSERT 후 생성된 timestamp 등) hardcode 금지** — \`expect_response_subset\`에 \`{id: 2}\`처럼 정확한 숫자를 박으면 다음 cycle에서 다른 id가 나와 fail. 동적 값은 \`expect_response_subset\`에서 *생략*하거나 *type만 검증*하라(예: schema에 \`type: integer\`로 위임).
    2. **시드 의존 시나리오는 사용자 정의 시드만 참조** — 명세서의 \`4-3. 시드 데이터\`에 명시된 값(예: \`demo_user\` / score 500)만 사용. 임의의 username/score를 시드라고 가정하지 말 것.
    3. **type 정확성** — \`expect_response_subset\`의 값 타입이 실제 응답 타입과 정확히 일치해야 함 (\`success: true\`는 boolean, \`exists: true\`는 boolean, id는 integer).
    4. **시나리오 간 체이닝 의존 금지** — signup 시나리오가 만든 user를 login 시나리오가 그대로 쓰는 식의 순서 의존 X. 각 시나리오는 독립적으로 PASS 가능해야 함 (시드 사용자나 명시적 setup만 의존).
    5. **subset 검증이 안전한 default** — \`expect_response_subset\`은 *부분 일치*(deep subset)로 검증. 가변 필드를 굳이 명시하지 말고, *확실히 안정된 필드만* 적어라 (예: \`{success: true, data: {username: 'demo_user'}}\` 정도. \`data.id\`는 빼라).
    6. **집계 endpoint(best/top/latest/max 등) 시드 보존** — PostTest는 endpoint × 시나리오를 *동일 컨테이너/DB*에 직렬 실행. *집계 결과를 갈아치울 수 있는 endpoint* (예: \`POST /game/result\` → is_best=1 갱신)의 시나리오는 *시드값보다 작은 값만* 사용. 그래야 그 다음 실행되는 \`GET /game/best\` 시나리오가 시드 값을 안정적으로 검증. 명세서 §4-3 시드값을 인지하고 다른 endpoint의 시나리오값을 *반드시 시드보다 낮게* 설계할 것.
- **base_url은 반드시 \`/api/v1\` 고정** (다른 값 금지). 외부 진입은 Nginx :80 → \`/api/v1/*\`만 BE로 forward되므로, BE는 모든 비즈니스 router를 \`app.use('/api/v1/...', ...)\` 형태로 mount해야 한다. \`/api\`, \`/v1\`, \`/api/v2\` 등 다른 prefix를 사용하면 외부 요청이 BE에 도달하지 못한다.
- ⚠️ **도메인 필드 일관성 (rules/domain.md — endpoint 간 drift 차단)**: \`router_details\`의 모든 \`request.schema.properties[].pattern/minLength/maxLength\`는 rules/domain.md §2 카탈로그 값을 *글자 그대로* 사용. \`test_scenarios[].request_body\`의 valid 입력은 §2 "PASS 예", invalid 입력은 §2 "FAIL 예"에서만 선택. 임의 값 금지. 같은 field 이름(예: \`username\`)이 여러 endpoint에 등장하면 모든 endpoint에서 동일 규칙·동일 PASS 예 사용. 특히 "available_*"/"check_*" 같은 *PASS 의도* 시나리오는 §2 "PASS 예" 중에서 시드 외 값을 선택해야 한다 (FAIL 예를 PASS 시나리오에 넣으면 BE validator가 400 반환 → scenario FAIL).${SCHEMA_SECTION}${DOMAIN_SECTION}`;

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
    `  "api_contract": { version, base_url: "/api/v1", endpoints: [{ name, path, method, description }] } | null,`,
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

  const t0 = Date.now();
  console.log(`[codechecker] start — user_request=${user_request.length} chars`);
  try {
    const userPrompt = buildUserPrompt(user_request);
    // 2026-05-19: max_tokens 미지정 → callJSON이 model cap 그대로 사용.
    // budget check도 callJSON 내부에서 단일 수행.
    const llmOut = await callJSON({
      agent: 'codechecker',
      system: SYSTEM_PROMPT,
      user: userPrompt,
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
    console.log(`[codechecker] done SUCCESS in ${((Date.now() - t0) / 1000).toFixed(1)}s — targets=${targets}, endpoints=${(llmOut.api_contract?.endpoints || []).length}`);
    return output;
  } catch (e) {
    console.error(`[codechecker] done FAIL in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e.message}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { error: e.message, stack: (e.stack || '').slice(0, 2000) },
    });
    throw e;
  }
}

module.exports = { run };
