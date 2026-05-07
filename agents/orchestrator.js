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
 *        ③ any failed_stage='STAGE3'  → FAIL
 *        ④ any retry_count >= MAX     → FAIL
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

const codeChecker = require('./codechecker_agent');
const beAgent = require('./be_agent');
const feAgent = require('./fe_agent');
const lintAgent = require('./lint_agent');
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
  const files = fsu.listFiles(target, exts).filter((f) => !f.includes('/node_modules/'));
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
  return [...out];
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
  // ① ERROR
  if (await logger.hasFailedRun(task_id)) {
    return { verdict: 'ERROR', reason: 'one or more log_agent_runs are FAILED (exception path)' };
  }
  const stateMap = await fetchStateMap(decision_id);
  const states = Object.values(stateMap);
  // ② PASS
  if (states.length > 0 && states.every((s) => s.status === 'SUCCESS')) {
    return { verdict: 'PASS', reason: 'all areas SUCCESS' };
  }
  // ③ STAGE3 FAIL
  for (const s of states) {
    if (s.failed_stage === 'STAGE3') {
      return { verdict: 'FAIL', reason: `Stage 3 (tests) failed for ${s.target}` };
    }
  }
  // ④ retry exceeded
  for (const s of states) {
    if (s.retry_count >= MAX_RETRIES) {
      return { verdict: 'FAIL', reason: `retry_count(${s.retry_count}) >= MAX(${MAX_RETRIES}) for ${s.target}` };
    }
  }
  return { verdict: 'CONTINUE', reason: 'retry FAILED areas' };
}

// ---------------- main flow ----------------

async function main() {
  const task_id = generateTaskId();
  console.log(`[orchestrator] task_id=${task_id}`);

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
    input_json: { argv: process.argv.slice(2), commitMode, validationMode, models },
  });

  let finalVerdict = 'ERROR';
  let finalText = '';
  let userRequest = '';

  try {
    // Phase 0: bootstrap (idempotent)
    console.log('[phase 0] bootstrapping FE/ and BE/ if needed...');
    await runBootstrap({ install: true });

    userRequest = readUserRequest();
    console.log(`[phase 0] user_request: ${userRequest}`);

    // Phase 1: CodeChecker
    console.log('[phase 1] CodeChecker running...');
    const cc = await codeChecker.run({ task_id, user_request: userRequest });
    console.log(`[phase 1] targets=${cc.targets} decision_id=${cc.decision_id}`);

    const fe_spec = cc.fe_spec;
    const be_spec = cc.be_spec;
    const api_contract = cc.api_contract;
    const decision_id = cc.decision_id;

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

      // Phase 2: BE first
      if (needBE) {
        const beState = stateMap.BE;
        const isRetry = beState.status === 'FAILED';
        console.log(`[phase 2] BE Agent (mode=${isRetry ? 'retry' : 'initial'})`);
        const params = { task_id, mode: isRetry ? 'retry' : 'initial', be_spec, api_contract };
        if (isRetry) {
          params.fix_instructions = beState.fix_instructions || '';
          params.allowed_paths = extractAllowedPathsFromFix('BE', beState.fix_instructions);
          if (params.allowed_paths.length === 0) {
            // fallback: allow any file under BE/src/
            params.allowed_paths = fsu.listFiles('BE', ['.js']).filter((f) => f.startsWith('BE/src/'));
          }
          params.existing_files = snapshotArea('BE');
        }
        await beAgent.run(params);
      }

      // rate-limit defense: short pause between BE and FE LLM calls within the same round
      if (needBE && needFE) {
        console.log(`[round ${round}] inter-LLM cooldown ${SLEEP_BETWEEN_LLM_MS}ms...`);
        await sleep(SLEEP_BETWEEN_LLM_MS);
      }

      // Phase 3: FE next (after BE)
      if (needFE) {
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
        await feAgent.run(params);
      }

      // Phase 4: Lint per area (or skip when VALIDATION_MODE=off)
      stateMap = await fetchStateMap(decision_id);
      const areasToLint = [];
      if (stateMap.BE && (needBE || stateMap.BE.status === 'PENDING')) areasToLint.push('BE');
      if (stateMap.FE && (needFE || stateMap.FE.status === 'PENDING')) areasToLint.push('FE');

      for (const target of areasToLint) {
        const st = stateMap[target];
        if (validationMode === 'off') {
          console.log(`[phase 4] ⚠️  VALIDATION_MODE=off — skip Lint for ${target}, auto-SUCCESS (state_id=${st.id})`);
          await logger.updateTaskState(st.id, {
            status: 'SUCCESS',
            failed_stage: null,
            fix_instructions: null,
            stage_logs: { skipped: 'VALIDATION_MODE=off' },
            result_text: null,
          });
        } else {
          console.log(`[phase 4] Lint Agent target=${target} (state_id=${st.id})`);
          await lintAgent.run({
            task_id,
            target,
            state_id: st.id,
            current_retry_count: st.retry_count || 0,
          });
        }
      }

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

  console.log(`\n[${finalVerdict}] task_id=${task_id}`);
  process.exit(finalVerdict === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { main };
