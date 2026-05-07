/**
 * log_agent_runs / log_agent_decisions / log_task_state helpers.
 *
 * Responsibility matrix:
 *   - log_agent_runs:        any agent inserts its own row, updates its own row
 *   - log_agent_decisions:   CodeChecker INSERTs, Orchestrator UPDATEs
 *   - log_task_state:        CodeChecker INSERTs, Lint UPDATEs
 */
'use strict';

const { query } = require('./db');

// ---------------- log_agent_runs ----------------

/**
 * INSERT a RUNNING row for an agent.
 * @returns {Promise<number>} run id
 */
async function startRun({ task_id, agent_name, target = null, input_json = null }) {
  const sql = `
    INSERT INTO log_agent_runs (task_id, agent_name, target, input_json, status)
    VALUES (?, ?, ?, ?, 'RUNNING')
  `;
  const params = [task_id, agent_name, target, input_json ? JSON.stringify(input_json) : null];
  const result = await query(sql, params);
  return result.insertId;
}

/**
 * UPDATE this agent's own run row to SUCCESS or FAILED.
 */
async function endRun(run_id, { status, output_json = null }) {
  const sql = `
    UPDATE log_agent_runs
       SET status = ?, output_json = ?, ended_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `;
  await query(sql, [status, output_json ? JSON.stringify(output_json) : null, run_id]);
}

/**
 * Convenience: are there any FAILED runs for this task? (used by Orchestrator for ERROR detection)
 */
async function hasFailedRun(task_id) {
  const rows = await query(
    `SELECT id FROM log_agent_runs WHERE task_id = ? AND status = 'FAILED' LIMIT 1`,
    [task_id]
  );
  return rows.length > 0;
}

// ---------------- log_agent_decisions ----------------

/**
 * CodeChecker only: insert one row per task.
 * @returns {Promise<number>} decision id
 */
async function insertDecision(task_id) {
  const sql = `INSERT INTO log_agent_decisions (task_id, final_verdict) VALUES (?, 'IN_PROGRESS')`;
  const result = await query(sql, [task_id]);
  return result.insertId;
}

/**
 * Orchestrator only: finalize the verdict.
 */
async function updateDecision(task_id, { final_verdict, final_result_text = null }) {
  const sql = `
    UPDATE log_agent_decisions
       SET final_verdict = ?, final_result_text = ?
     WHERE task_id = ?
  `;
  await query(sql, [final_verdict, final_result_text, task_id]);
}

async function getDecision(task_id) {
  const rows = await query(
    `SELECT * FROM log_agent_decisions WHERE task_id = ?`,
    [task_id]
  );
  return rows[0] || null;
}

// ---------------- log_task_state ----------------

/**
 * CodeChecker only: insert one row per (decision_id, target).
 */
async function insertTaskState(decision_id, target) {
  const sql = `
    INSERT INTO log_task_state (decision_id, target, status)
    VALUES (?, ?, 'PENDING')
  `;
  const result = await query(sql, [decision_id, target]);
  return result.insertId;
}

/**
 * Lint only: update area state.
 * Pass only the fields you want to change.
 */
async function updateTaskState(state_id, fields) {
  const allowed = ['status', 'retry_count', 'failed_stage', 'fix_instructions', 'stage_logs', 'result_text'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = ?`);
      let v = fields[key];
      if (key === 'stage_logs' && v != null && typeof v !== 'string') v = JSON.stringify(v);
      params.push(v);
    }
  }
  if (sets.length === 0) return;
  params.push(state_id);
  const sql = `UPDATE log_task_state SET ${sets.join(', ')} WHERE id = ?`;
  await query(sql, params);
}

async function listTaskStates(decision_id) {
  return query(
    `SELECT * FROM log_task_state WHERE decision_id = ? ORDER BY target`,
    [decision_id]
  );
}

module.exports = {
  // runs
  startRun,
  endRun,
  hasFailedRun,
  // decisions
  insertDecision,
  updateDecision,
  getDecision,
  // task state
  insertTaskState,
  updateTaskState,
  listTaskStates,
};
