/**
 * Phase 2.8 — SpecSync Agent (deterministic, no LLM).
 *
 * D89 (2026-05-20). ContractSync(D36) 패턴 복제.
 *
 * Orchestrator integration:
 *   - CodeChecker 산출(router_details) 직후, ContractSync 통과 후 실행.
 *   - BOTH/BE 모드에서만 (FE-only면 router_details 없음).
 *   - SUCCESS → orchestrator 계속 진행 (Lint Agent).
 *   - FAILED  → BE task_state FAILED + failed_stage='SPEC_SYNC' + fix_instructions → BE 재진입.
 *
 * Always ON — VALIDATION_MODE 무관 (safety guard).
 *
 * Schema requirement:
 *   log_agent_runs.agent_name ENUM 에 'SpecSync'
 *   log_task_state.failed_stage ENUM 에 'SPEC_SYNC'
 */
'use strict';

const path = require('path');

const logger = require('../lib/logger');
const { checkSpecSync } = require('../lib/spec_sync');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'rules', 'domain.md');
const ROUTER_DIR = path.join(ROOT, 'shared', 'router');

async function run({ task_id }) {
  const run_id = await logger.startRun({
    task_id,
    agent_name: 'SpecSync',
    input_json: { catalog_path: CATALOG_PATH, router_dir: ROUTER_DIR },
  });

  let result;
  try {
    result = checkSpecSync({ catalogPath: CATALOG_PATH, routerDir: ROUTER_DIR });
  } catch (e) {
    console.error(`[spec_sync] internal error: ${e.message}`);
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { error: e.message, internal: true },
    });
    return { status: 'FAILED', error: e.message };
  }

  if (result.skipped) {
    console.log(`[spec_sync] skipped: ${result.skipped}`);
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: { skipped: result.skipped, error: result.error || null },
    });
    return { status: 'SUCCESS', skipped: true };
  }

  if (result.pass) {
    console.log(
      `[spec_sync] PASS: ${result.field_count} catalog fields × ${result.router_count} routers`
    );
    await logger.endRun(run_id, {
      status: 'SUCCESS',
      output_json: {
        pass: true,
        field_count: result.field_count,
        router_count: result.router_count,
        drift_count: 0,
      },
    });
    return { status: 'SUCCESS' };
  }

  console.error(`[spec_sync] FAIL: ${result.drifts.length} drifts`);
  await logger.endRun(run_id, {
    status: 'FAILED',
    output_json: {
      pass: false,
      field_count: result.field_count,
      router_count: result.router_count,
      drift_count: result.drifts.length,
      drifts: result.drifts,
      fix_instructions: result.fix_instructions,
    },
  });
  return {
    status: 'FAILED',
    drifts: result.drifts,
    fix_instructions: result.fix_instructions,
  };
}

module.exports = { run };
