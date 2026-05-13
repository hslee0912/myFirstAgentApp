/**
 * Phase 2.7 — ContractSync Agent (deterministic, no LLM).
 *
 * Decision provenance: D36 (2026-05-14, see lib/contract_sync.js header).
 *
 * Orchestrator integration contract:
 *   - Called AFTER BE Agent + Migration Agent succeed, BEFORE FE Agent runs.
 *   - Only runs when `targets` is 'BE' or 'BOTH' (FE-only mode has nothing
 *     to verify against api_contract).
 *   - SUCCESS  → orchestrator continues (Lint Agent next).
 *   - FAILED   → orchestrator marks BE task_state FAILED with
 *                failed_stage='CONTRACT_SYNC' + fix_instructions, BE re-enters
 *                the round loop on next round (same pattern as MIGRATION
 *                or AGENT_GUARD).
 *
 * Always ON — independent of VALIDATION_MODE / DEPLOY_MODE. The check is
 * a *safety guard* (same class as validatePaths / protectedConfigFiles).
 *
 * Schema requirement:
 *   `log_agent_runs.agent_name` ENUM must include 'ContractSync'.
 *   `log_task_state.failed_stage` ENUM must include 'CONTRACT_SYNC'.
 *   See db/agent_schema.sql migration.
 */
'use strict';

const path = require('path');

const logger = require('../lib/logger');
const { checkContractSync } = require('../lib/contract_sync');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'shared', 'api_contract.json');
const ROUTER_DIR = path.join(ROOT, 'shared', 'router');
const BE_SERVER_FILE = path.join(ROOT, 'BE', 'src', 'server.js');

/**
 * Phase 2.7 main entry.
 *
 * @param {{task_id: string}} params
 * @returns {Promise<{
 *   status: 'SUCCESS'|'FAILED',
 *   skipped?: boolean,
 *   missing?: Array,
 *   extra?: Array,
 *   fix_instructions?: string,
 *   error?: string,
 * }>}
 */
async function run({ task_id }) {
  const run_id = await logger.startRun({
    task_id,
    agent_name: 'ContractSync',
    input_json: {
      contract_path: CONTRACT_PATH,
      router_dir: ROUTER_DIR,
      be_server_file: BE_SERVER_FILE,
    },
  });

  let result;
  try {
    result = checkContractSync({
      contractPath: CONTRACT_PATH,
      routerDir: ROUTER_DIR,
      beServerFile: BE_SERVER_FILE,
    });
  } catch (e) {
    // 정규식 파싱 자체가 throw — 시스템 결함이지 contract drift는 아니다.
    console.error(`[contract_sync] internal error: ${e.message}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { error: e.message, internal: true },
    });
    return { status: 'FAILED', error: e.message };
  }

  // skip-with-success — round 1 BE 산출 전이거나 contract 없음
  if (result.skipped) {
    console.log(`[contract_sync] skipped: ${result.skipped}`);
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: { skipped: result.skipped, error: result.error || null },
    });
    return { status: 'SUCCESS', skipped: true };
  }

  if (result.pass) {
    console.log(
      `[contract_sync] PASS: ${result.contract_endpoints.length} contract / ` +
      `${result.code_endpoints.length} code endpoints matched`
    );
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: {
        pass: true,
        contract_count: result.contract_endpoints.length,
        code_count: result.code_endpoints.length,
        extra_count: result.extra.length, // informational
        extra: result.extra,
      },
    });
    return { status: 'SUCCESS' };
  }

  // FAIL — BE re-enters retry flow
  console.error(
    `[contract_sync] FAIL: ${result.missing.length} missing endpoints ` +
    `(${result.contract_endpoints.length} contract / ${result.code_endpoints.length} code)`
  );
  await logger.endRun(run_id, {
    status: 'FAILED',
    output_json: {
      pass: false,
      contract_count: result.contract_endpoints.length,
      code_count: result.code_endpoints.length,
      missing: result.missing,
      extra: result.extra,
      fix_instructions: result.fix_instructions,
    },
  });
  return {
    status: 'FAILED',
    missing: result.missing,
    extra: result.extra,
    fix_instructions: result.fix_instructions,
  };
}

module.exports = { run };
