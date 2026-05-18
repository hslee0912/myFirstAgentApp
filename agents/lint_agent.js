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

/**
 * D57 (2026-05-15): per-file Lint 실행.
 *
 * 한 stage가 통째 디렉토리를 lint/test하면 한 파일의 syntax error에 모든 출력이
 * 쏟아져 LLM이 fix할 우선순위를 못 잡음. 또 vitest의 한 파일이 무한 루프면 stage
 * 전체가 hang. 이 함수는 per_file_pattern 매치 파일 목록을 만들고, 각 파일을
 * 순차적으로 command_prefix와 합쳐 실행 + 매 파일 후 onProgress callback 호출.
 *
 * - per_file_pattern.rootDir: 검색 시작점 (cwd 기준 relative)
 * - per_file_pattern.include: 포함할 확장자 (suffix 매치)
 * - per_file_pattern.exclude: 제외할 suffix
 * - per_file_pattern.excludeDirs: 제외할 디렉토리 이름
 *
 * onProgress(current, total, relFile) — UI 진행 표시용.
 * 한 파일이라도 fail이면 stage fail. 모든 fail 파일 stderr/stdout은 truncate 누적.
 */
async function runStageCommandPerFile(stageCfg, cwd, onProgress) {
  const pat = stageCfg.per_file_pattern || {};
  const rootDir = path.join(cwd, pat.rootDir || 'src');
  const include = pat.include || ['.js'];
  const exclude = pat.exclude || [];
  const excludeDirs = pat.excludeDirs || [];
  const label = stageCfg.label || stageCfg.command_prefix.join(' ');

  const files = collectFilesPerFile(rootDir, include, exclude, excludeDirs);
  if (files.length === 0) {
    return {
      pass: true,
      code: 0,
      stdout: '(no matching files)',
      stderr: '',
      cmd: stageCfg.command_prefix.join(' ') + ' (no files)',
      per_file_results: [],
      file_count: 0,
    };
  }

  const out = [];
  const perFile = [];
  let allPass = true;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const relF = path.relative(cwd, f);
    if (onProgress) {
      try { await onProgress(i + 1, files.length, relF); } catch (_) { /* swallow */ }
    }
    console.log(`[lint_agent] ${label} ${i + 1}/${files.length} ${relF}`);
    // D60 (2026-05-15): jest의 testPathPattern은 regex 해석 — Windows 절대경로의
    // backslash가 regex special char로 인식되어 "0 matches"로 fail. relative path
    // + forward slash로 통일 (eslint도 둘 다 호환, vitest도 동일).
    const argPath = relF.replace(/\\/g, '/');
    const r = runCommand([...stageCfg.command_prefix, argPath], cwd);
    const flag = r.timed_out ? ' [TIMED_OUT]' : '';
    out.push(`-- ${relF} (exit=${r.code})${flag}\n${truncate(r.stderr || r.stdout, 800)}`);
    perFile.push({ file: relF, pass: r.code === 0, code: r.code, timed_out: !!r.timed_out });
    if (r.code !== 0) allPass = false;
  }
  return {
    pass: allPass,
    code: allPass ? 0 : 1,
    stdout: truncate(out.join('\n\n')),
    stderr: '',
    cmd: stageCfg.command_prefix.join(' ') + ` (per-file, ${files.length} files)`,
    per_file_results: perFile,
    file_count: files.length,
  };
}

function collectFilesPerFile(rootDir, include, exclude, excludeDirs) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const queue = [rootDir];
  while (queue.length) {
    const d = queue.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!excludeDirs.includes(e.name)) queue.push(full);
      } else if (
        include.some((ext) => e.name.endsWith(ext)) &&
        !exclude.some((suf) => e.name.endsWith(suf))
      ) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * D85 (2026-05-18): batch + JSON parse + per-file fallback.
 *
 * 한 번에 전체 src/를 호출 (eslint --format=json / vitest --reporter=json).
 *   - stdout JSON parse 성공 + 모든 파일 PASS → 즉시 PASS 반환 (가장 흔한 경로)
 *   - JSON parse 실패 또는 부분 FAIL → command_per_file fallback (정확 식별)
 *
 * 절감: 매 파일마다 다시 spawn (cold-start 2~5s)하던 overhead 제거.
 * - BE eslint 7파일: ~21s → 1.5s
 * - FE eslint 18파일: ~54s → 2s
 * - FE vitest 6~8파일: ~36~48s → 3.5s
 *
 * stageCfg 추가 필드:
 *   - batch_args: string[]  — command_prefix 뒤에 붙는 batch 인자 (예: ['src/', '--format=json'])
 *   - batch_parser: 'eslint' | 'vitest' | 'jest'  — stdout JSON 형식
 *   - per_file_pattern: 기존 그대로 (fallback 용)
 */
async function runStageCommandBatch(stageCfg, cwd, onProgress) {
  const label = stageCfg.label || stageCfg.command_prefix.join(' ');
  const batchArgs = stageCfg.batch_args || [];
  const parser = stageCfg.batch_parser || 'eslint';
  console.log(`[lint_agent] ${label} (batch)`);
  if (onProgress) {
    try { await onProgress(0, 1, '(batch)'); } catch (_) { /* swallow */ }
  }

  const cmd = [...stageCfg.command_prefix, ...batchArgs];
  const r = runCommand(cmd, cwd);

  let parsedPass = null;
  let failedFiles = [];
  if (!r.timed_out && r.stdout) {
    try {
      const j = JSON.parse(r.stdout);
      if (parser === 'eslint' && Array.isArray(j)) {
        for (const f of j) {
          if ((f.errorCount || 0) > 0) failedFiles.push({ file: f.filePath, errors: f.errorCount });
        }
        parsedPass = failedFiles.length === 0;
      } else if (parser === 'vitest' && j.testResults) {
        for (const t of j.testResults) {
          if (t.status === 'failed') failedFiles.push({ file: t.name, errors: 1 });
        }
        parsedPass = failedFiles.length === 0;
      }
    } catch (_) {
      parsedPass = null;
    }
  }

  if (parsedPass === true && r.code === 0) {
    if (onProgress) {
      try { await onProgress(1, 1, '(batch PASS)'); } catch (_) { /* swallow */ }
    }
    return {
      pass: true,
      code: 0,
      stdout: `(batch PASS — JSON-parsed, ${batchArgs.join(' ')})`,
      stderr: '',
      cmd: cmd.join(' '),
      per_file_results: [],
      file_count: 0,
    };
  }

  // batch FAIL 또는 JSON parse 실패 → per-file fallback (정확한 fail 식별).
  console.log(`[lint_agent] ${label} batch FAIL or unparsed — falling back to per-file (D85)`);
  return await runStageCommandPerFile(stageCfg, cwd, onProgress);
}

async function runStage(stageCfg, cwd, onProgress) {
  if (!stageCfg) return { pass: true, code: 0, stdout: '(stage skipped — no config)', stderr: '', cmd: '(skip)' };
  if (stageCfg.type === 'command') return runStageCommand(stageCfg, cwd);
  if (stageCfg.type === 'command_per_file') return await runStageCommandPerFile(stageCfg, cwd, onProgress);
  if (stageCfg.type === 'command_batch') return await runStageCommandBatch(stageCfg, cwd, onProgress);
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
/**
 * D71 (2026-05-18): Lint stage fail 시 stage_logs를 disk에 영구 저장.
 * 기존 흐름은 round 1/2 fail이 round 3 PASS 시점에 stage_logs 덮어쓰여 분석 불가.
 * file: big_cycle_logs/lint_errors/<task_id>__<target>__round<N>__<stage>.json
 */
function saveLintFailLog(task_id, target, retry_count, stage_logs, failed_stage) {
  try {
    const dir = path.join(ROOT, 'big_cycle_logs', 'lint_errors');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const round = (retry_count || 0) + 1;
    const stage = (failed_stage || 'UNKNOWN').toLowerCase();
    const filename = `${task_id}__${target}__round${round}__${stage}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({
      task_id, target, round, failed_stage,
      saved_at: new Date().toISOString(),
      stage_logs,
    }, null, 2));
    console.log(`[lint_agent] saved fail log → big_cycle_logs/lint_errors/${filename}`);
  } catch (e) {
    console.warn(`[lint_agent] saveLintFailLog skipped: ${e.message}`);
  }
}

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
        saveLintFailLog(task_id, target, current_retry_count || 0, stage_logs, 'STAGE1_container_sanity');
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
        saveLintFailLog(task_id, target, current_retry_count || 0, stage_logs, 'STAGE1_migration_sanity');
        const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE1' };
        await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
        return out;
      }
    }

    // D57 (2026-05-15): per-file 진행 표시 — Stage 1/3 (command_per_file) 진입 시
    // 매 파일 후 stage_logs.stage<N>_progress = { current, total, file }를 DB에
    // partial update. UI tasks polling이 이 필드로 진행률 보여줌. stage 끝나면
    // _progress 키 제거하여 정리.
    const makeOnProgress = (stageNum) => async (current, total, file) => {
      stage_logs[`stage${stageNum}_progress`] = { current, total, file };
      try { await logger.updateTaskState(state_id, { stage_logs }); }
      catch (_) { /* progress update 실패는 fatal 아님 */ }
    };

    stage_logs.stage1 = await runStage(cfg.lint.stage1, cwd, makeOnProgress(1));
    delete stage_logs.stage1_progress;
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
      saveLintFailLog(task_id, target, current_retry_count || 0, stage_logs, 'STAGE1');
      const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE1' };
      await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
      return out;
    }

    stage_logs.stage2 = await runStage(cfg.lint.stage2, cwd);
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
      saveLintFailLog(task_id, target, current_retry_count || 0, stage_logs, 'STAGE2');
      const out = { stage_logs, verdict: 'FAILED', failed_stage: 'STAGE2' };
      await logger.endRun(run_id, { status: 'SUCCESS', output_json: out });
      return out;
    }

    stage_logs.stage3 = await runStage(cfg.lint.stage3, cwd, makeOnProgress(3));
    delete stage_logs.stage3_progress;
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
      saveLintFailLog(task_id, target, current_retry_count || 0, stage_logs, 'STAGE3');
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
