/**
 * Resume from failure (D35, 2026-05-14, 옵션 C).
 *
 * 기존 task_id의 *decision/state/spec*을 DB에서 복원해 orchestrator round loop만
 * 재진입한다. CodeChecker는 *이미 SUCCESS* 결과를 그대로 재사용 (LLM 토큰 절감).
 *
 * 책임 (이 모듈):
 *   - checkResumeEligibility(task_id): DB 조회 + 조건 검증
 *   - loadCheckpoint(task_id):         실제 spec/decision_id 복원
 *   - extractUserRequest(rows):        CodeChecker input_json or Orchestrator argv에서 fallback
 *
 * 책임이 아닌 것:
 *   - round loop 자체 (orchestrator.js의 runRoundLoop)
 *   - process.exit / spawn (orchestrator.js / UI run.js)
 */
'use strict';

const db = require('./db');

/**
 * @typedef {Object} Eligibility
 * @property {boolean} eligible
 * @property {string} reason
 * @property {number=} decision_id
 * @property {string=} user_request
 * @property {Object=} codechecker_output     // { be_spec, fe_spec, api_contract, targets, ... }
 * @property {Array=} task_states              // log_task_state rows (BE/FE)
 */

/**
 * Resume 가능 여부 + 복원 데이터 반환.
 * 호출자는 결과의 `eligible`만 확인하면 됨. 모든 검증·복원이 한 번에.
 *
 * 검증 조건:
 *   1. log_agent_decisions에 row 존재 + verdict in (ERROR, FAIL)
 *   2. CodeChecker run이 SUCCESS + output_json에 spec 필드 보존
 *   3. user_request 복원 가능 (CodeChecker input_json or Orchestrator argv)
 *
 * @param {string} task_id
 * @returns {Promise<Eligibility>}
 */
async function checkResumeEligibility(task_id) {
  if (!task_id || typeof task_id !== 'string') {
    return { eligible: false, reason: 'task_id가 비어있거나 형식 오류' };
  }

  // 1. decision 조회
  const decisionRows = await db.query(
    'SELECT id, final_verdict FROM log_agent_decisions WHERE task_id = ? LIMIT 1',
    [task_id]
  );
  if (decisionRows.length === 0) {
    return { eligible: false, reason: `decision row 없음 (task_id=${task_id})` };
  }
  const decision_id = decisionRows[0].id;
  const verdict = decisionRows[0].final_verdict;
  if (verdict !== 'ERROR' && verdict !== 'FAIL') {
    return { eligible: false, reason: `verdict=${verdict} — ERROR/FAIL만 resume 가능` };
  }

  // 2. CodeChecker run 조회 (SUCCESS여야 함)
  const ccRows = await db.query(
    "SELECT input_json, output_json, status FROM log_agent_runs WHERE task_id = ? AND agent_name = 'CodeChecker' ORDER BY id DESC LIMIT 1",
    [task_id]
  );
  if (ccRows.length === 0) {
    return { eligible: false, reason: 'CodeChecker run row 없음 — 처음부터 재실행 필요' };
  }
  if (ccRows[0].status !== 'SUCCESS') {
    return {
      eligible: false,
      reason: `CodeChecker status=${ccRows[0].status} — Resume 불가 (BE/FE는 spec 없이 시작 못 함). 새 task로 처음부터 진행 필요.`,
    };
  }
  const cc_output = ccRows[0].output_json || {};
  if (!cc_output.be_spec && !cc_output.fe_spec) {
    return {
      eligible: false,
      reason: 'CodeChecker output_json에 be_spec/fe_spec 모두 없음 — spec 복원 불가',
    };
  }

  // 3. user_request 복원
  const user_request = await extractUserRequest({
    codechecker_input: ccRows[0].input_json,
    task_id,
  });

  // 4. task_state 조회 (BE/FE row, retry_count 등)
  const stateRows = await db.query(
    'SELECT id, target, status, retry_count, failed_stage, fix_instructions FROM log_task_state WHERE decision_id = ?',
    [decision_id]
  );

  return {
    eligible: true,
    reason: 'OK',
    decision_id,
    user_request,
    codechecker_output: cc_output,
    task_states: stateRows,
  };
}

/**
 * CodeChecker input_json에서 user_request 추출. fallback으로 Orchestrator argv 사용.
 *
 * @param {{codechecker_input: Object|null, task_id: string}} params
 * @returns {Promise<string>}
 */
async function extractUserRequest({ codechecker_input, task_id }) {
  // 1순위: CodeChecker input_json.user_request
  if (codechecker_input && typeof codechecker_input.user_request === 'string') {
    return codechecker_input.user_request;
  }
  // 2순위: Orchestrator argv (orchestrator/readUserRequest와 동일한 의미적 추출 —
  //   첫 argv가 --로 시작하면 옵션 모드라 user_request 없음으로 간주).
  const orchRows = await db.query(
    "SELECT input_json FROM log_agent_runs WHERE task_id = ? AND agent_name = 'Orchestrator' ORDER BY id ASC LIMIT 1",
    [task_id]
  );
  if (orchRows.length > 0) {
    const argv = orchRows[0].input_json && orchRows[0].input_json.argv;
    if (Array.isArray(argv) && argv.length > 0 && !String(argv[0]).startsWith('--')) {
      // join으로 multi-arg user_request도 합침 (orchestrator readUserRequest와 동일)
      return argv.filter((a) => !String(a).startsWith('--')).join(' ').trim();
    }
  }
  return ''; // empty → orchestrator의 default scenario로 fallback
}

module.exports = {
  checkResumeEligibility,
  extractUserRequest,
};
