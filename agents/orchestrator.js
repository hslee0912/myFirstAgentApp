/**
 * Orchestrator (no LLM)
 *
 * Phases:
 *   0. Generate task_id, INSERT log_agent_runs (Orchestrator, RUNNING). Bootstrap FE/BE skeletons.
 *   1. Run CodeChecker. Inserts log_agent_decisions + log_task_state.
 *   2. (round) Run BE Agent if BE row is PENDING/FAILED.
 *   3. (round) Run FE Agent if FE row is PENDING/FAILED. (Always after BE.)
 *   4. (round) Run Lint per area that needs verification.
 *   5. Evaluate termination priority:
 *        ① any log_agent_runs FAILED  → ERROR
 *        ② all task_state SUCCESS     → PASS
 *        ③ any retry_count >= MAX     → FAIL  (D30=A: Stage 3도 retry 대상에 포함)
 *        else → next round (only FAILED areas)
 *   6. UPDATE log_agent_decisions, UPDATE Orchestrator's own log_agent_runs.
 *   7. Auto-commit BE/+FE/ if final_verdict='PASS' AND COMMIT_MODE='auto'.
 *      Push is always left to the human; this step never pushes.
 *
 * Spec data flow:
 *   CodeChecker output {fe_spec, be_spec, api_contract} is held in memory and passed forward.
 *   The DB record of these specs lives in CodeChecker's log_agent_runs.output_json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
require('dotenv').config({ override: true });

const logger = require('../lib/logger');
const db = require('../lib/db');
const fsu = require('../lib/fs_util');
const { runBootstrap } = require('../lib/bootstrap');
const stack = require('../lib/stack');

const codeChecker = require('./codechecker_agent');
const beAgent = require('./be_agent');
const feAgent = require('./fe_agent');
const lintAgent = require('./lint_agent');
const migrationAgent = require('./migration_agent');
const contractSyncAgent = require('./contract_sync_agent');
const dbState = require('../lib/db_state');
const { classifyAgentError, buildFixInstructions } = require('../lib/agent_error_classifier');
const { checkResumeEligibility } = require('../lib/resume_helper');
const deployAgent = require('./deploy_agent');
const testAgent = require('./test_agent');
const { resolveModel } = require('../lib/llm');

const ROOT = path.resolve(__dirname, '..');
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
// Anti rate-limit: pause between LLM-calling phases so input-tokens-per-minute stays under quota.
const SLEEP_BETWEEN_LLM_MS = Number(process.env.LLM_INTER_CALL_MS || 15000);  // BE↔FE within a round
const SLEEP_BETWEEN_ROUNDS_MS = Number(process.env.LLM_INTER_ROUND_MS || 30000); // round N → round N+1

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- helpers ----------------

function generateTaskId() {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `task_${ts}_${rand}`;
}

function readUserRequest() {
  // Priority: argv[2] string  >  --file=path  >  stdin
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));
  if (fileArg) {
    const p = fileArg.slice('--file='.length);
    return fs.readFileSync(p, 'utf8').trim();
  }
  if (args.length > 0 && !args[0].startsWith('--')) return args.join(' ').trim();

  const defaultRequest =
    '이메일과 비밀번호로 회원가입할 수 있는 기능을 만들어줘. ' +
    '비밀번호는 8자 이상이어야 하고, 이메일 중복 체크도 해야 해.';
  console.log('[orchestrator] no --file or argv user_request supplied, using default scenario');
  return defaultRequest;
}

/**
 * Re-fetch task states keyed by target.
 */
async function fetchStateMap(decision_id) {
  const rows = await logger.listTaskStates(decision_id);
  const map = {};
  for (const r of rows) map[r.target] = r;
  return map;
}

/**
 * Snapshot of files inside a target folder, used as `existing_files` in retry mode.
 */
function snapshotArea(target) {
  const exts = target === 'FE' ? ['.js', '.jsx', '.json', '.html', '.css'] : ['.js', '.json'];
  // Exclude protected config files (lint/docker/package). LLM should never
  // see these as candidates for modification — they live outside src/ but
  // the recursive listFiles picks them up.
  const protectedFiles = new Set(stack.get(target).protectedConfigFiles || []);
  const files = fsu.listFiles(target, exts)
    .filter((f) => !f.includes('/node_modules/'))
    .filter((f) => !protectedFiles.has(f));
  return fsu.snapshot(files);
}

/**
 * Extract repo-relative paths mentioned in fix_instructions.
 * We accept any token starting with FE/ or BE/ that contains a dot extension.
 */
function extractAllowedPathsFromFix(target, fix) {
  if (!fix) return [];
  const re = new RegExp(`(?:\\b|[^A-Za-z0-9_/.-])(${target}/[A-Za-z0-9_./-]+\\.[A-Za-z0-9]+)`, 'g');
  const found = new Set();
  let m;
  while ((m = re.exec(fix)) !== null) {
    found.add(m[1]);
  }
  // Also include the test partner of any source file (so the agent can fix the test if needed).
  const out = new Set(found);
  for (const p of found) {
    if (target === 'BE' && p.endsWith('.js') && !p.endsWith('.test.js')) {
      out.add(p.replace(/\.js$/, '.test.js'));
    } else if (target === 'FE' && (p.endsWith('.jsx') || p.endsWith('.js')) && !/\.test\.(jsx|js)$/.test(p)) {
      out.add(p.replace(/\.(jsx|js)$/, '.test.$1'));
    }
  }
  // X1: filter out protected config files (lint/docker/package configs) even if
  // fix_instructions mentions them. The agent must NOT modify these — removing
  // them from allowed_paths ensures the LLM never receives them as a target.
  const protectedFiles = new Set(stack.get(target).protectedConfigFiles || []);
  return [...out].filter((p) => !protectedFiles.has(p));
}

/**
 * D46 (2026-05-14): round 안에서 FE Agent를 *이번 round에* 실행할지 결정.
 *   - needBE=false (예: targets='FE')면 → BE 안 돌렸으니 그대로 FE 진행.
 *   - needBE=true + BE가 이번 round에서 SUCCESS → FE 진행.
 *   - needBE=true + BE가 SUCCESS 아님 (FAILED 또는 다른 상태) → FE skip.
 *     사용자 결정: BE 안정화 후 FE 진행. BE FAIL task는 어차피 최종 FAIL →
 *     그 cycle의 FE 호출은 폐기될 코드 → LLM 비용 낭비.
 *
 * Pure function — orchestrator round loop에서 직접 호출. 단위 테스트 용이.
 *
 * @param {{ needFE: boolean, needBE: boolean, beFinalStatus: string|null }} p
 * @returns {boolean}
 */
function shouldRunFeThisRound({ needFE, needBE, beFinalStatus }) {
  if (!needFE) return false;
  if (needBE && beFinalStatus !== 'SUCCESS') return false;
  return true;
}

// ---------------- Phase 7 auto-commit ----------------

/**
 * Stage BE/ + FE/ and create a commit when the pipeline produced a passing run.
 * Only runs when final_verdict='PASS' AND COMMIT_MODE='auto'. Never pushes.
 *
 * Failures here never affect the verdict — we just warn and continue.
 */
function maybeAutoCommit({ task_id, userRequest, finalVerdict }) {
  if (finalVerdict !== 'PASS') return;
  const mode = (process.env.COMMIT_MODE || 'auto').toLowerCase();
  if (mode !== 'auto') {
    console.log(`[commit] COMMIT_MODE=${mode} — auto-commit skipped`);
    return;
  }

  const opts = { cwd: ROOT, encoding: 'utf8', windowsHide: true };

  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], opts);
  if (inRepo.status !== 0) {
    console.warn('[commit] not a git repository — auto-commit skipped');
    return;
  }

  const beExists = fs.existsSync(path.join(ROOT, 'BE'));
  const feExists = fs.existsSync(path.join(ROOT, 'FE'));
  if (!beExists && !feExists) {
    console.warn('[commit] neither BE/ nor FE/ exists — auto-commit skipped');
    return;
  }

  const stageArgs = ['add', '--'];
  if (beExists) stageArgs.push('BE');
  if (feExists) stageArgs.push('FE');
  const add = spawnSync('git', stageArgs, opts);
  if (add.status !== 0) {
    console.warn(`[commit] git add failed: ${(add.stderr || '').trim()}`);
    return;
  }

  // Anything actually staged inside BE/FE?
  const diffArgs = ['diff', '--cached', '--quiet', '--'];
  if (beExists) diffArgs.push('BE');
  if (feExists) diffArgs.push('FE');
  const diff = spawnSync('git', diffArgs, opts);
  if (diff.status === 0) {
    console.log('[commit] no changes in BE/ or FE/ — auto-commit skipped');
    return;
  }

  const summary = (userRequest || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const message = summary ? `auto: ${task_id} — ${summary}` : `auto: ${task_id}`;
  const commit = spawnSync('git', ['commit', '-m', message], opts);
  if (commit.status !== 0) {
    console.warn(`[commit] git commit failed: ${(commit.stderr || commit.stdout || '').trim()}`);
    return;
  }

  console.log(`[commit] auto-committed: ${message}`);
}

// ---------------- Phase 5 evaluator ----------------

async function evaluateVerdict(task_id, decision_id) {
  const stateMap = await fetchStateMap(decision_id);
  const states = Object.values(stateMap);

  // ① PASS — 모든 영역 SUCCESS
  if (states.length > 0 && states.every((s) => s.status === 'SUCCESS')) {
    return { verdict: 'PASS', reason: 'all areas SUCCESS' };
  }

  // ② retry exceeded — Stage 1/2/3/MIGRATION/AGENT_GUARD 모두 MAX_RETRIES(3) 도달 시 FAIL.
  for (const s of states) {
    if (s.retry_count >= MAX_RETRIES) {
      return {
        verdict: 'FAIL',
        reason: `retry_count(${s.retry_count}) >= MAX(${MAX_RETRIES}) for ${s.target} (failed_stage=${s.failed_stage || '-'})`,
      };
    }
  }

  // ③ FAILED 영역이 있으면 retry (CONTINUE).
  //    D34 (2026-05-14): Agent guard throw도 task_state.status='FAILED'로 표시되므로
  //    여기서 자연 흐름. log_agent_runs.status='FAILED'가 있어도 task_state가 갱신됐다면
  //    분류된 retryable 케이스라 retry 흐름.
  if (states.some((s) => s.status === 'FAILED')) {
    return { verdict: 'CONTINUE', reason: 'retry FAILED areas' };
  }

  // ④ 모든 task_state가 PENDING/SUCCESS인데 log_agent_runs에 FAILED가 있다면 —
  //    *분류 안 된 throw* (orchestrator catch에서 분류 못한 시스템 예외 등).
  //    이건 진짜 ERROR.
  if (await logger.hasFailedRun(task_id)) {
    return {
      verdict: 'ERROR',
      reason: 'unclassified agent exception (task_state not updated by retry handler)',
    };
  }

  // ⑤ 도달하면 비정상 (states 비어있음 등) — 안전 위해 ERROR.
  return { verdict: 'ERROR', reason: 'no decisive state' };
}

/**
 * D40: combine round-loop verdict with Phase 8 (Deploy) and Phase 9 (PostTest)
 * results into the final verdict.
 *
 * Rules:
 *   - initialVerdict (from evaluateVerdict) NOT 'PASS' → return as-is (no deploy attempted).
 *   - deployStatus === 'FAILED' → final 'FAIL'.
 *   - posttestStatus === 'FAILED' → final 'FAIL'.
 *   - all SUCCESS → 'PASS'.
 *
 * SKIPPED states (DEPLOY_MODE=off) are reported as status='SUCCESS' by both
 * agents, so they cleanly pass through without changing the verdict.
 */
function evaluateFinalVerdict({ initialVerdict, deployStatus, posttestStatus }) {
  if (initialVerdict !== 'PASS') return initialVerdict;
  if (deployStatus === 'FAILED') return 'FAIL';
  if (posttestStatus === 'FAILED') return 'FAIL';
  return 'PASS';
}

// ---------------- main flow ----------------

/**
 * argv에서 --resume=<task_id> 또는 --resume <task_id> 파싱.
 * @returns {string|null} resume할 task_id (없으면 null)
 */
function parseResumeArg() {
  const args = process.argv.slice(2);
  const idx = args.findIndex((a) => a === '--resume' || a.startsWith('--resume='));
  if (idx === -1) return null;
  if (args[idx].startsWith('--resume=')) {
    return args[idx].slice('--resume='.length).trim() || null;
  }
  return (args[idx + 1] || '').trim() || null;
}

async function main() {
  // D35 (2026-05-14, 옵션 C): --resume=<task_id>면 기존 task의 CodeChecker 결과
  // 재사용하고 round loop만 재진입. 같은 task_id, 같은 decision_id 유지 →
  // task_state.retry_count 누적, log_db_migrations 이력 그대로.
  const resumeTaskId = parseResumeArg();
  const isResume = !!resumeTaskId;
  const task_id = resumeTaskId || generateTaskId();
  console.log(`[orchestrator] ${isResume ? 'RESUME' : 'NEW'} task_id=${task_id}`);

  const commitMode = (process.env.COMMIT_MODE || 'auto').toLowerCase();
  const validationMode = (process.env.VALIDATION_MODE || 'on').toLowerCase();
  console.log(`[orchestrator] modes: COMMIT_MODE=${commitMode}, VALIDATION_MODE=${validationMode}`);
  if (validationMode === 'off') {
    console.warn('[orchestrator] ⚠️  VALIDATION_MODE=off — Lint/build/test will be skipped, code is UNVERIFIED');
  }

  const models = {
    CodeChecker: resolveModel('codechecker'),
    BE: resolveModel('be'),
    FE: resolveModel('fe'),
  };
  console.log(`[orchestrator] models: CodeChecker=${models.CodeChecker}, BE=${models.BE}, FE=${models.FE}`);

  const orchRun = await logger.startRun({
    task_id,
    agent_name: 'Orchestrator',
    input_json: { argv: process.argv.slice(2), commitMode, validationMode, models, resume: isResume },
  });

  let finalVerdict = 'ERROR';
  let finalText = '';
  let userRequest = '';

  try {
    // Phase 0: bootstrap (idempotent)
    console.log('[phase 0] bootstrapping FE/ and BE/ if needed...');
    await runBootstrap({ install: true });

    let fe_spec, be_spec, api_contract, decision_id, targets;

    if (isResume) {
      // Phase 1 SKIP — 기존 CodeChecker 결과를 DB에서 복원
      console.log(`[phase 1] CodeChecker SKIPPED (resume mode — restoring spec from DB)`);
      const elig = await checkResumeEligibility(task_id);
      if (!elig.eligible) {
        throw new Error(`Resume not eligible: ${elig.reason}`);
      }
      userRequest = elig.user_request || '';
      decision_id = elig.decision_id;
      const cc_output = elig.codechecker_output;
      fe_spec = cc_output.fe_spec;
      be_spec = cc_output.be_spec;
      api_contract = cc_output.api_contract;
      targets = cc_output.targets || 'BOTH';
      console.log(`[phase 1] restored: targets=${targets} decision_id=${decision_id}, user_request="${userRequest.slice(0, 100)}"`);
    } else {
      userRequest = readUserRequest();
      console.log(`[phase 0] user_request: ${userRequest}`);

      // Phase 1: CodeChecker (정상 모드)
      console.log('[phase 1] CodeChecker running...');
      const cc = await codeChecker.run({ task_id, user_request: userRequest });
      console.log(`[phase 1] targets=${cc.targets} decision_id=${cc.decision_id}`);

      fe_spec = cc.fe_spec;
      be_spec = cc.be_spec;
      api_contract = cc.api_contract;
      decision_id = cc.decision_id;
      targets = cc.targets || 'BOTH';
    }

    // ---------------- round loop ----------------
    let round = 0;
    while (true) {
      round += 1;
      console.log(`\n[round ${round}] start`);

      // rate-limit defense: cool down before round 2+
      if (round > 1) {
        console.log(`[round ${round}] cooldown ${SLEEP_BETWEEN_ROUNDS_MS}ms before next LLM batch...`);
        await sleep(SLEEP_BETWEEN_ROUNDS_MS);
      }

      let stateMap = await fetchStateMap(decision_id);

      // determine which targets need work this round
      const needBE = stateMap.BE && (stateMap.BE.status === 'PENDING' || stateMap.BE.status === 'FAILED');
      const needFE = stateMap.FE && (stateMap.FE.status === 'PENDING' || stateMap.FE.status === 'FAILED');

      // Workflow per round (user-confirmed sequential):
      //   BE Agent → Lint(BE) → [cooldown] → FE Agent → Lint(FE)
      // Rationale: Lint each area immediately after its Agent so subsequent
      // Agents see a clean baseline; also makes debug attribution per-area trivial.

      // Phase 2 + Phase 4(BE): BE Agent → Lint(BE)
      if (needBE) {
        const beState = stateMap.BE;
        const isRetry = beState.status === 'FAILED';
        console.log(`[phase 2] BE Agent (mode=${isRetry ? 'retry' : 'initial'})`);

        // D44 (2026-05-14): BE Agent에 *이미 적용된 migration 이력* + *디스크의
        //   migration 파일 list* + *현재 비즈니스 DB schema* inject. rules/db.md의
        //   *원칙*만으로는 LLM이 *실제 상태*를 추론 못해 checksum 충돌 사고 발생 →
        //   상태 정보 자체를 prompt에 박아 사고 차단.
        let beStateBundle;
        try {
          beStateBundle = await dbState.getBeStateBundle();
          console.log(
            `[phase 2] db_state: applied=${beStateBundle.applied.length}, ` +
            `disk=${beStateBundle.disk.length}, ` +
            `business_tables=${Object.keys(beStateBundle.schema.tables).length}`
          );
        } catch (e) {
          console.warn(`[phase 2] db_state fetch failed: ${e.message} — proceeding with empty state`);
          beStateBundle = { applied: [], disk: [], diff: { in_sync: true, conflicts: [], orphan_on_disk: [], orphan_in_db: [] }, schema: { tables: {} } };
        }

        const params = { task_id, mode: isRetry ? 'retry' : 'initial', be_spec, api_contract, db_state: beStateBundle };
        if (isRetry) {
          params.fix_instructions = beState.fix_instructions || '';
          params.allowed_paths = extractAllowedPathsFromFix('BE', beState.fix_instructions);
          if (params.allowed_paths.length === 0) {
            params.allowed_paths = fsu.listFiles('BE', ['.js']).filter((f) => f.startsWith('BE/src/'));
          }
          params.existing_files = snapshotArea('BE');
        }

        // D34 (2026-05-14): Agent run의 retryable guard throw도 retry 흐름으로.
        //   classifyAgentError가 retryable=true면 task_state FAILED + retry_count++
        //   + fix_instructions = 카테고리별 hint + 원본 message → 다음 round에서
        //   BE Agent가 retry mode로 받아 회복 시도.
        //   분류 안 되는 throw(시스템 예외)는 그대로 throw → main catch ERROR.
        let beAgentThrew = false;
        try {
          await beAgent.run(params);
        } catch (e) {
          const cls = classifyAgentError(e);
          if (!cls.retryable) throw e;
          beAgentThrew = true;
          const newRetryCount = (beState.retry_count || 0) + 1;
          console.log(`[phase 2] BE Agent guard throw (${cls.category}) — retry_count=${newRetryCount}`);
          await logger.updateTaskState(beState.id, {
            status: 'FAILED',
            failed_stage: 'AGENT_GUARD',
            retry_count: newRetryCount,
            fix_instructions: buildFixInstructions(cls),
            stage_logs: { agent_guard: { category: cls.category, original_message: cls.original_message.slice(0, 1000) } },
            result_text: `BE Agent guard: ${cls.category}`,
          });
        }

        // Phase 2.5 (D33, 2026-05-14): Migration Agent — BE Agent가 emit한
        //   BE/db/migrations/*.sql을 MySQL에 적용. Lint 직전에 실행해야 stage 3
        //   (jest)가 정상 schema 위에서 runtime 검증 가능.
        //   FAIL 시 Lint 건너뛰고 task_state를 FAILED로 표시 (retry 흐름 진입).
        //   beAgentThrew면 BE Agent 출력이 없으니 Migration·Lint 둘 다 skip.
        if (beAgentThrew) {
          // 위에서 task_state를 이미 FAILED로 갱신 — Migration·Lint 건너뛰고 verdict 단계로
        } else {
        console.log(`[phase 2.5] Migration Agent`);
        const migResult = await migrationAgent.run({ task_id });
        if (migResult.status === 'FAILED') {
          console.log(`[phase 2.5] Migration FAILED — ${migResult.error}`);
          const newRetryCount = (beState.retry_count || 0) + 1;
          await logger.updateTaskState(beState.id, {
            status: 'FAILED',
            failed_stage: 'MIGRATION',
            retry_count: newRetryCount,
            fix_instructions: migResult.fix_instructions || migResult.error,
            stage_logs: { migration: migResult },
            result_text: `Migration FAILED: ${migResult.failed || migResult.error}`,
          });
          // ContractSync + Lint 둘 다 건너뛰고 verdict 단계로
        } else {
          // Phase 2.7 (D36, 2026-05-14): ContractSync Agent — BE Agent 산출물의
          //   라우터 mount가 shared/api_contract.json과 일치하는지 정적 검증.
          //   BE/BOTH 모드일 때만 실행 (FE-only는 verify할 BE 산출물 없음).
          //   FAIL 시 Lint 건너뛰고 task_state를 FAILED+CONTRACT_SYNC로 → BE 재진입.
          //   VALIDATION_MODE 무관 항상 ON (safety guard 등급).
          let contractSyncFailed = false;
          if (targets === 'BE' || targets === 'BOTH') {
            console.log(`[phase 2.7] ContractSync Agent`);
            const csResult = await contractSyncAgent.run({ task_id });
            if (csResult.status === 'FAILED') {
              contractSyncFailed = true;
              const missingCount = (csResult.missing || []).length;
              console.log(`[phase 2.7] ContractSync FAILED — ${missingCount} missing endpoints`);
              const newRetryCount = (beState.retry_count || 0) + 1;
              await logger.updateTaskState(beState.id, {
                status: 'FAILED',
                failed_stage: 'CONTRACT_SYNC',
                retry_count: newRetryCount,
                fix_instructions: csResult.fix_instructions || csResult.error || 'contract sync failed',
                stage_logs: {
                  migration: migResult,
                  contract_sync: { missing: csResult.missing, extra: csResult.extra },
                },
                result_text: `ContractSync FAILED: ${missingCount} missing endpoints`,
              });
              // Lint 건너뛰고 verdict 단계로 — BE 재진입
            }
          }

          if (contractSyncFailed) {
            // 위에서 task_state 갱신 — Lint skip
          } else if (validationMode === 'off') {
            console.log(`[phase 4] ⚠️  VALIDATION_MODE=off — skip Lint for BE, auto-SUCCESS (state_id=${beState.id})`);
            await logger.updateTaskState(beState.id, {
              status: 'SUCCESS', failed_stage: null, fix_instructions: null,
              stage_logs: { skipped: 'VALIDATION_MODE=off', migration: migResult },
              result_text: null,
            });
          } else {
            console.log(`[phase 4] Lint Agent target=BE (state_id=${beState.id})`);
            await lintAgent.run({
              task_id, target: 'BE', state_id: beState.id,
              current_retry_count: beState.retry_count || 0,
            });
          }
        }
        }  // /beAgentThrew else
      }

      // D46 (2026-05-14): BE가 이번 round에서 실행됐는데 SUCCESS가 아니면 FE skip.
      //   사용자 결정: BE 정의가 명확히 끝난 후 FE 진행 — BE FAIL인 task는 어차피
      //   최종 task FAIL → 그 task의 FE 작업은 폐기됨 → 미리 부르면 LLM 비용 낭비.
      //   needBE=false (예: targets='FE')인 경우는 그대로 FE 진행.
      let beFinalStatus = null;
      if (needBE) {
        const afterBe = await fetchStateMap(decision_id);
        beFinalStatus = afterBe.BE && afterBe.BE.status;
      }
      const skipFeBecauseBe = needBE && beFinalStatus !== 'SUCCESS';
      if (skipFeBecauseBe) {
        console.log(`[round ${round}] BE status=${beFinalStatus} — FE skip this round (D46: BE 안정화 후 FE 진행)`);
      }

      // Inter-LLM cooldown between BE Lint and FE LLM call.
      if (needBE && needFE && !skipFeBecauseBe) {
        console.log(`[round ${round}] inter-LLM cooldown ${SLEEP_BETWEEN_LLM_MS}ms...`);
        await sleep(SLEEP_BETWEEN_LLM_MS);
      }

      // Phase 3 + Phase 4(FE): FE Agent → Lint(FE)
      if (needFE && !skipFeBecauseBe) {
        const feState = stateMap.FE;
        const isRetry = feState.status === 'FAILED';
        console.log(`[phase 3] FE Agent (mode=${isRetry ? 'retry' : 'initial'})`);
        const params = { task_id, mode: isRetry ? 'retry' : 'initial', fe_spec, api_contract };
        if (isRetry) {
          params.fix_instructions = feState.fix_instructions || '';
          params.allowed_paths = extractAllowedPathsFromFix('FE', feState.fix_instructions);
          if (params.allowed_paths.length === 0) {
            params.allowed_paths = fsu.listFiles('FE', ['.js', '.jsx']).filter((f) => f.startsWith('FE/src/'));
          }
          params.existing_files = snapshotArea('FE');
        }

        // D34 (2026-05-14): FE Agent도 동일한 retryable guard 처리.
        let feAgentThrew = false;
        try {
          await feAgent.run(params);
        } catch (e) {
          const cls = classifyAgentError(e);
          if (!cls.retryable) throw e;
          feAgentThrew = true;
          const newRetryCount = (feState.retry_count || 0) + 1;
          console.log(`[phase 3] FE Agent guard throw (${cls.category}) — retry_count=${newRetryCount}`);
          await logger.updateTaskState(feState.id, {
            status: 'FAILED',
            failed_stage: 'AGENT_GUARD',
            retry_count: newRetryCount,
            fix_instructions: buildFixInstructions(cls),
            stage_logs: { agent_guard: { category: cls.category, original_message: cls.original_message.slice(0, 1000) } },
            result_text: `FE Agent guard: ${cls.category}`,
          });
        }

        if (feAgentThrew) {
          // Lint 건너뛰고 verdict 단계로 — Phase 5가 retry 결정
        } else if (validationMode === 'off') {
          console.log(`[phase 4] ⚠️  VALIDATION_MODE=off — skip Lint for FE, auto-SUCCESS (state_id=${feState.id})`);
          await logger.updateTaskState(feState.id, {
            status: 'SUCCESS', failed_stage: null, fix_instructions: null,
            stage_logs: { skipped: 'VALIDATION_MODE=off' }, result_text: null,
          });
        } else {
          console.log(`[phase 4] Lint Agent target=FE (state_id=${feState.id})`);
          await lintAgent.run({
            task_id, target: 'FE', state_id: feState.id,
            current_retry_count: feState.retry_count || 0,
          });
        }
      }

      // Re-fetch state map for the verdict step (Lint updated it just now).
      stateMap = await fetchStateMap(decision_id);

      // Phase 5: evaluate
      const evalResult = await evaluateVerdict(task_id, decision_id);
      console.log(`[phase 5] verdict=${evalResult.verdict} (${evalResult.reason})`);
      if (evalResult.verdict !== 'CONTINUE') {
        finalVerdict = evalResult.verdict;
        finalText = evalResult.reason;
        break;
      }
      // else loop again — only FAILED areas re-enter via the needBE/needFE check
    }

    // Phase 8 (Deploy) + Phase 9 (PostTest): only if round loop ended in PASS.
    // D25=B: round loop 밖, verdict 후보가 PASS일 때만 1회 실행.
    if (finalVerdict === 'PASS') {
      console.log('[phase 8] Deploy Agent running...');
      const deployResult = await deployAgent.run({ task_id });

      let posttestResult = { status: 'SUCCESS', skipped: true };
      if (deployResult.status === 'SUCCESS') {
        console.log('[phase 9] PostTest Agent running...');
        posttestResult = await testAgent.run({ task_id });
      } else {
        console.log('[phase 9] skipped — Phase 8 did not succeed');
      }

      // D40: combine into final verdict.
      const newVerdict = evaluateFinalVerdict({
        initialVerdict: 'PASS',
        deployStatus: deployResult.status,
        posttestStatus: posttestResult.status,
      });

      if (newVerdict !== finalVerdict) {
        finalVerdict = newVerdict;
        if (deployResult.status === 'FAILED') {
          finalText = 'Phase 8 (Deploy) FAILED — see Deploy run output_json for details';
        } else if (posttestResult.status === 'FAILED') {
          finalText = 'Phase 9 (PostTest) FAILED — see PostTest run output_json for details';
        }
      }
    }
  } catch (e) {
    finalVerdict = 'ERROR';
    finalText = `[orchestrator exception] ${e.message}\n${(e.stack || '').slice(0, 1500)}`;
    console.error(finalText);
  }

  // Phase 6: finalize
  try {
    // decisions row was inserted by CodeChecker; if CodeChecker itself failed, it may not exist.
    const dec = await logger.getDecision(task_id);
    if (dec) {
      await logger.updateDecision(task_id, {
        final_verdict: finalVerdict,
        final_result_text: finalText.slice(0, 4000),
      });
    }
    await logger.endRun(orchRun, {
      status: finalVerdict === 'PASS' ? 'SUCCESS' : 'FAILED',
      output_json: { final_verdict: finalVerdict, final_result_text: finalText.slice(0, 1000) },
    });
  } catch (e) {
    console.error('[orchestrator] failed to write final status:', e.message);
  } finally {
    await db.close().catch(() => {});
  }

  // Phase 7: auto-commit (PASS + COMMIT_MODE=auto only). Never pushes.
  try {
    maybeAutoCommit({ task_id, userRequest, finalVerdict });
  } catch (e) {
    console.warn(`[commit] unexpected error: ${e.message}`);
  }

  // Phase 7.5: deploy teardown (D6=B PASS branch).
  // Conditions:
  //   - DEPLOY_MODE=on (skipped runs have nothing to tear down)
  //   - finalVerdict === 'PASS' (FAIL/ERROR always keeps containers for debugging)
  //   - DEPLOY_TEARDOWN_ON_PASS === 'on' (default; 'off' keeps containers so the
  //     UI's "FE/BE 열기" buttons remain functional. User stops via the
  //     "Stop containers" button or `npm run ui` → POST /api/stop-containers.)
  try {
    const deployMode = (process.env.DEPLOY_MODE || 'on').toLowerCase();
    const teardownOnPass = (process.env.DEPLOY_TEARDOWN_ON_PASS || 'on').toLowerCase();
    if (finalVerdict === 'PASS' && deployMode === 'on') {
      if (teardownOnPass === 'on') {
        deployAgent.teardown();
      } else {
        console.log(
          '[teardown] kept alive — DEPLOY_TEARDOWN_ON_PASS=off. ' +
          'Stop via UI "Stop containers" or docker compose down manually.'
        );
      }
    } else if (finalVerdict !== 'PASS' && deployMode === 'on') {
      console.log('[teardown] skipped — verdict is not PASS, containers kept for debugging (D6=B)');
    }
  } catch (e) {
    console.warn(`[teardown] unexpected error: ${e.message}`);
  }

  console.log(`\n[${finalVerdict}] task_id=${task_id}`);
  process.exit(finalVerdict === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { main, extractAllowedPathsFromFix, snapshotArea, shouldRunFeThisRound };
