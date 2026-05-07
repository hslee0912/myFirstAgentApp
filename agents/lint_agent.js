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

const ROOT = path.resolve(__dirname, '..');
const TRUNCATE = 4000;

function truncate(s, n = TRUNCATE) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s;
}

function runCommand(command, cwd) {
  const [bin, ...args] = command;
  const r = spawnSync(bin, args, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error) : null,
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
  const header =
    stage === 'STAGE1'
      ? '정적 분석(Stage 1)에서 에러 발생. 아래 출력에서 지적된 파일/라인의 규칙 위반을 수정하라.'
      : '빌드/구문 검증(Stage 2)에서 에러 발생. 아래 출력의 구문/import/빌드 에러를 수정하라.';
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
      // Stage 3 fail: NO retry_count increment (per policy). Just mark FAILED+STAGE3.
      await logger.updateTaskState(state_id, {
        status: 'FAILED',
        failed_stage: 'STAGE3',
        fix_instructions: null,
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
