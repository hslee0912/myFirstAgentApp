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

function startOrchestrator(userPrompt) {
  if (currentRunRef.value) {
    return { ok: false, error: 'busy', current: currentRunRef.value };
  }
  const args = [path.join(ROOT, 'agents', 'orchestrator.js')];
  if (userPrompt && userPrompt.trim()) args.push(userPrompt);

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

module.exports = router;
module.exports.startOrchestrator = startOrchestrator;
