/**
 * /api/run — spawn agents/orchestrator.js as a child, with a single-run slot.
 *
 * Exports `startOrchestrator` so the bootstrap can still re-export it for
 * tests (preserving the historical surface of ui/server.js).
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { ROOT, currentRunRef } = require('./_context');

/**
 * Orchestrator child process spawn.
 *
 * @param {string} userPrompt — initial mode면 user_request 문자열
 * @param {Object} [opts]
 * @param {string} [opts.resumeTaskId] — set이면 --resume=<id>로 spawn. CodeChecker skip 모드.
 */
function startOrchestrator(userPrompt, opts = {}) {
  if (currentRunRef.value) {
    return { ok: false, error: 'busy', current: currentRunRef.value };
  }
  const args = [path.join(ROOT, 'agents', 'orchestrator.js')];
  if (opts.resumeTaskId) {
    args.push(`--resume=${opts.resumeTaskId}`);
  } else if (userPrompt && userPrompt.trim()) {
    args.push(userPrompt);
  }

  const child = spawn('node', args, {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const logChunks = [];
  let detectedTaskId = null;
  const onData = (buf) => {
    const s = buf.toString();
    logChunks.push(s);
    if (!detectedTaskId) {
      const m = s.match(/task_id=([a-z0-9_]+)/i);
      if (m) {
        detectedTaskId = m[1];
        if (currentRunRef.value) currentRunRef.value.task_id = detectedTaskId;
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  currentRunRef.value = {
    task_id: null,
    pid: child.pid,
    startedAt: Date.now(),
    log: () => logChunks.join('').slice(-30000),
  };

  child.on('exit', (code) => {
    const slot = currentRunRef.value;
    if (slot && slot.pid === child.pid) {
      slot.finishedAt = Date.now();
      slot.exitCode = code;
      // Keep last run visible for ~10s so polling picks it up, then clear.
      setTimeout(() => {
        if (currentRunRef.value && currentRunRef.value.pid === child.pid) {
          currentRunRef.value = null;
        }
      }, 10_000);
    }
  });

  return { ok: true, pid: child.pid };
}

const router = express.Router();

router.get('/', (_req, res) => {
  const slot = currentRunRef.value;
  res.json({
    running: slot !== null,
    current: slot
      ? {
          task_id: slot.task_id,
          pid: slot.pid,
          startedAt: slot.startedAt,
          finishedAt: slot.finishedAt || null,
          exitCode: slot.exitCode ?? null,
          logTail: slot.log ? slot.log() : '',
        }
      : null,
  });
});

router.post('/', (req, res) => {
  const prompt = (req.body && req.body.prompt) || '';
  const result = startOrchestrator(prompt);
  if (!result.ok) return res.status(409).json(result);
  res.json({ ok: true, pid: result.pid });
});

// D35 (2026-05-14, 옵션 C): POST /api/run/resume/:task_id
//   기존 task의 CodeChecker 결과 재사용 + round loop만 재진입.
//   eligibility는 orchestrator(resume_helper) 안에서 한 번 더 검증 — UI 측에서도
//   미리 확인하면 더 빠른 피드백 가능하지만 race condition 방지를 위해 spawn 후
//   orchestrator에서 검증해 fail이면 즉시 exit하도록 함.
router.post('/resume/:task_id', (req, res) => {
  const { task_id } = req.params;
  if (!task_id || !/^[a-z0-9_]+$/i.test(task_id)) {
    return res.status(400).json({ ok: false, error: 'invalid task_id format' });
  }
  const result = startOrchestrator('', { resumeTaskId: task_id });
  if (!result.ok) return res.status(409).json(result);
  res.json({ ok: true, pid: result.pid, resume_task_id: task_id });
});

module.exports = router;
module.exports.startOrchestrator = startOrchestrator;
