/**
 * Lint Agent (no LLM, deterministic)
 *
 * 3-stage gate per area (FE or BE). Stage commands come from lib/stack.config.json
 * so swapping the stack does NOT require editing this file.
 *
 * Verdict policy (per area, per round):
 *   - all 3 pass             → status='SUCCESS'
 *   - Stage 3 fail           → status='FAILED', failed_stage='STAGE3', NO retry_count++
 *                              (Orchestrator terminates the whole task with FAIL)
 *   - Stage 1 or 2 fail      → status='FAILED', failed_stage='STAGEx', retry_count++
 *                              fix_instructions = summarized error log
 *   - Exception              → status='FAILED', result_text=<message>,
 *                              log_agent_runs.status='FAILED' (ERROR signal)
 *
 * Stage runners supported:
 *   - { type: 'command', command: ['npx', 'eslint', ...] }
 *   - { type: 'node_check_recursive', rootDir: 'src', include: ['.js'], exclude: ['.test.js'] }
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');
const logger = require('../lib/logger');
const stack = require('../lib/stack');
const { checkBeServerSanity } = require('../lib/container_sanity');
const { checkMigrationSanity } = require('../lib/migration_sanity');

const ROOT = path.resolve(__dirname, '..');
const TRUNCATE = 4000;

function truncate(s, n = TRUNCATE) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s;
}

const STAGE_TIMEOUT_MS = Number(process.env.LINT_STAGE_TIMEOUT_MS || 5 * 60 * 1000);

function runCommand(command, cwd, timeoutMs = STAGE_TIMEOUT_MS) {
  const [bin, ...args] = command;
  const r = spawnSync(bin, args, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  const timedOut = r.status === null && (r.signal === 'SIGTERM' || r.signal === 'SIGKILL');
  const timeoutMsg = timedOut ? `\n[lint_agent] command timed out after ${timeoutMs}ms (killed)` : '';
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '') + timeoutMsg,
    error: r.error ? String(r.error) : null,
    timed_out: timedOut,
  };
}

// ---------------- Stage runners ----------------

function runStageCommand(stageCfg, cwd) {
  const cmd = stageCfg.command;
  const r = runCommand(cmd, cwd);
  return {
    pass: r.code === 0,
    code: r.code,
    stdout: truncate(r.stdout),
    stderr: truncate(r.stderr),
    cmd: cmd.join(' ') + `  (cwd=${path.basename(cwd)})`,
  };
}

function runStageNodeCheckRecursive(stageCfg, cwd) {
  const rootDir = path.join(cwd, stageCfg.rootDir || 'src');
  const include = stageCfg.include || ['.js'];
  const exclude = stageCfg.exclude || [];
  const files = [];
  if (fs.existsSync(rootDir)) {
    const stack_ = [rootDir];
    while (stack_.length) {
      const d = stack_.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack_.push(full);
        else if (include.some((ext) => e.name.endsWith(ext)) && !exclude.some((suf) => e.name.endsWith(suf))) {
          files.push(full);
        }
      }
    }
  }
  if (files.length === 0) {
    return { pass: true, code: 0, stdout: '(no source files to check)', stderr: '', cmd: 'node --check (no files)' };
  }
  const out = [];
  let pass = true;
  for (const f of files) {
    const r = runCommand(['node', '--check', JSON.stringify(f)], cwd);
    out.push(`-- ${path.relative(cwd, f)} (exit=${r.code})\n${r.stderr || r.stdout}`);
    if (r.code !== 0) pass = false;
  }
  return {
    pass,
    code: pass ? 0 : 1,
    stdout: truncate(out.join('\n\n')),
    stderr: '',
    cmd: `node --check (${files.length} files under ${stageCfg.rootDir || 'src'})`,
  };
}

function runStage(stageCfg, cwd) {
  if (!stageCfg) return { pass: true, code: 0, stdout: '(stage skipped — no config)', stderr: '', cmd: '(skip)' };
  if (stageCfg.type === 'command') return runStageCommand(stageCfg, cwd);
  if (stageCfg.type === 'node_check_recursive') return runStageNodeCheckRecursive(stageCfg, cwd);
  if (stageCfg.type === 'skip') {
    return { pass: true, code: 0, stdout: '(skip)', stderr: '', cmd: 'skip' };
  }
  throw new Error(`[lint_agent] unknown stage type '${stageCfg.type}'`);
}

// ---------------- fix_instructions builder ----------------

function buildFixInstructions(stage, log) {
  let header;
  if (stage === 'STAGE1') {
    header = '정적 분석(Stage 1)에서 에러 발생. 아래 출력에서 지적된 파일/라인의 규칙 위반을 수정하라.';
  } else if (stage === 'STAGE2') {
    header = '빌드/구문 검증(Stage 2)에서 에러 발생. 아래 출력의 구문/import/빌드 에러를 수정하라.';
  } else {
    // STAGE3 — D30=A: Stage 3도 retry 대상. fix_instructions로 테스트 출력 전달.
    header = [
      '단위 테스트(Stage 3)에서 에러 발생. 아래 vitest/jest 출력의 실패 원인을 분석하라.',
      '',
      '주의 — 테스트 파일 자체는 시스템이 결정론적으로 자동 생성하므로 *수정 대상이 아니다*.',
      '문제는 *비즈니스 코드 측*에 있다. 다음 흔한 패턴을 가장 먼저 의심하라:',
      '',
      '1. (FE) 컴포넌트가 조건부로 null을 반환 — 가장 흔함.',
      '     예: `function Modal({isOpen}) { if (!isOpen) return null; ... }`',
      '     시스템 smoke test는 props 없이 render(<Modal />) → null → 실패.',
      '     해결: 닫힌 상태도 non-null DOM 노드 (`<div hidden />` 또는 display:none).',
      '     rules/fe.md §4-bis 참조.',
      '2. 필수처럼 보이는 prop의 default 값 누락 → undefined 접근 시 throw.',
      '3. (BE) 모듈이 비즈니스 함수를 export 안 함 — `typeof exportedFn === \'function\'` 검증 실패.',
      '4. import 경로 오타나 missing default export.',
      '',
      '비즈니스 의도(예: Modal이 isOpen=false일 때 안 보임)를 유지하면서 *DOM에는 항상 무언가가 있도록* 코드를 수정하라.',
    ].join('\n');
  }
  const body = [
    `[command] ${log.cmd}`,
    `[exit code] ${log.code}`,
    log.stdout ? `[stdout]\n${log.stdout}` : '',
    log.stderr ? `[stderr]\n${log.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return `${header}\n\n${body}`;
}

// ---------------- Main ----------------

/**
 * @param {Object} p
 * @param {string} p.task_id
 * @param {'FE'|'BE'} p.target
 * @param {number} p.state_id
 * @param {number} p.current_retry_count
 */
async function run(p) {
  const { task_id, target, state_id, current_retry_count } = p;
  const cfg = stack.get(target);
  const cwd = path.join(ROOT, target);

  const run_id = await logger.startRun({
    task_id,
    agent_name: 'Lint',
    target,
    input_json: { state_id, current_retry_count, displayName: cfg.displayName },
  });

  const stage_logs = {};

  try {
    // D45 (2026-05-14): BE container sanity 정적 grep — eslint 돌리기 전에
    //   server.js의 4 antipattern (process.env.PORT, listen localhost,
    //   require.main 가드 부재, express.json 부재) 검출. 위반 시 Stage 1 FAIL
    //   로 처리해 retry 흐름과 통합. eslint는 *안 돌림* (이미 명백한 위반).
    if (target === 'BE') {
      const sanity = checkBeServerSanity(cwd);
      if (!sanity.pass) {
        stage_logs.stage1 = {
          pass: false,
          cmd: 'container_sanity (BE/src/server.js static grep)',
          violations: sanity.violations,
          stdout: sanity.fix_instructions,
          stderr: '',
          code: 1,
        };
        await logger.updateTaskState(state_id, {
          status: 'FAILED',
          retry_count: (current_retry_count || 0) + 1,
          failed_stage: 'STAGE1',
          fix_instructions: sanity.fix_instructions,
          stage_logs,
          result_text: null,
        });
        const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE1' };
        await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
        return out;
      }

      // D48 (2026-05-14): BE migration SQL 정적 grep — Migration Agent가
      //   *MySQL syntax error*로 fail하는 LLM 사고 패턴(PostgreSQL 문법 등)을
      //   Migration 호출 *이전*에 차단. 위반 시 즉시 Stage 1 FAIL + retry.
      //   현재 검출: CREATE INDEX [IF NOT EXISTS] (MySQL 미지원).
      const migSanity = checkMigrationSanity();
      if (!migSanity.pass) {
        stage_logs.stage1 = {
          pass: false,
          cmd: 'migration_sanity (BE/db/migrations/*.sql static grep)',
          violations: migSanity.violations,
          stdout: migSanity.fix_instructions,
          stderr: '',
          code: 1,
        };
        await logger.updateTaskState(state_id, {
          status: 'FAILED',
          retry_count: (current_retry_count || 0) + 1,
          failed_stage: 'STAGE1',
          fix_instructions: migSanity.fix_instructions,
          stage_logs,
          result_text: null,
        });
        const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE1' };
        await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
        return out;
      }
    }

    stage_logs.stage1 = runStage(cfg.lint.stage1, cwd);
    if (!stage_logs.stage1.pass) {
      const fix = buildFixInstructions('STAGE1', stage_logs.stage1);
      await logger.updateTaskState(state_id, {
        status: 'FAILED',
        retry_count: (current_retry_count || 0) + 1,
        failed_stage: 'STAGE1',
        fix_instructions: fix,
        stage_logs,
        result_text: null,
      });
      const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE1' };
      await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
      return out;
    }

    stage_logs.stage2 = runStage(cfg.lint.stage2, cwd);
    if (!stage_logs.stage2.pass) {
      const fix = buildFixInstructions('STAGE2', stage_logs.stage2);
      await logger.updateTaskState(state_id, {
        status: 'FAILED',
        retry_count: (current_retry_count || 0) + 1,
        failed_stage: 'STAGE2',
        fix_instructions: fix,
        stage_logs,
        result_text: null,
      });
      const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE2' };
      await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
      return out;
    }

    stage_logs.stage3 = runStage(cfg.lint.stage3, cwd);
    if (!stage_logs.stage3.pass) {
      // D30=A: Stage 3도 retry 대상. 이전엔 즉시 FAIL이었으나 LLM이 흔한 안티
      // 패턴(조건부 null 반환 등)으로 자주 실패했고, vitest 출력 그대로 fix
      // hint로 보내면 LLM이 코드 수정해 통과할 수 있음. retry_count 증가 +
      // fix_instructions로 vitest stderr 전달. MAX_RETRIES(3) 도달 시 FAIL.
      const fix = buildFixInstructions('STAGE3', stage_logs.stage3);
      await logger.updateTaskState(state_id, {
        status: 'FAILED',
        retry_count: (current_retry_count || 0) + 1,
        failed_stage: 'STAGE3',
        fix_instructions: fix,
        stage_logs,
        result_text: null,
      });
      const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE3' };
      await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
      return out;
    }

    // ALL PASS
    await logger.updateTaskState(state_id, {
      status: 'SUCCESS',
      failed_stage: null,
      fix_instructions: null,
      stage_logs,
      result_text: null,
    });
    const out = { stage_logs, verdict: 'SUCCESS' };
    await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
    return out;
  } catch (e) {
    try {
      await logger.updateTaskState(state_id, {
        status: 'FAILED',
        stage_logs,
        result_text: truncate(`${e.message}\n${e.stack || ''}`),
      });
    } catch (_) { /* swallow */ }
    await logger.endRun(run_id, {
      status: 'FAILED',
      output_json: { error: e.message, stage_logs },
    });
    return { stage_logs, verdict: 'EXCEPTION', error: e.message };
  }
}

module.exports = { run };
