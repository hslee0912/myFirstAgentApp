/**
 * Deploy ops:
 *   POST /api/stop-containers — `docker compose down` for the managed compose.
 *   POST /api/redeploy        — compose up only (Phase 8 standalone, no PostTest).
 *
 * DB reset은 별도 단독 버튼에서 제거됨 — Init project (POST /api/init) 가 코드+DB
 * 모두 reset하므로 단독 reset-db는 죽은 기능이 됨 (D38, 2026-05-14).
 */
'use strict';

const express = require('express');
const { readEnv } = require('../../lib/env_writer');
const deployAgent = require('../../agents/deploy_agent');
const { ENV_PATH, currentRunRef } = require('./_context');

const router = express.Router();

router.post('/stop-containers', (_req, res) => {
  try {
    deployAgent.teardown();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/redeploy', async (_req, res) => {
  // DEPLOY_MODE=off면 의도적 거부 — 사용자가 토글을 끈 상태에서 우연히 누른 경우 방지.
  // .env 디스크 상태를 보고 판단 (UI 토글이 즉시 반영되어야 하므로 process.env 캐시 사용 X).
  const diskEnv = readEnv(ENV_PATH);
  const mode = (diskEnv.DEPLOY_MODE || process.env.DEPLOY_MODE || 'on').toLowerCase();
  if (mode !== 'on') {
    return res.status(400).json({
      ok: false,
      error: '.env의 DEPLOY_MODE가 off라 Redeploy 실행 안 됩니다. 좌측 토글을 on으로 바꾸고 다시 시도하세요.',
    });
  }
  if (currentRunRef.value) {
    return res.status(409).json({
      ok: false,
      error: '다른 작업 진행 중. 끝난 후 다시 시도하세요.',
      current: { task_id: currentRunRef.value.task_id, pid: currentRunRef.value.pid },
    });
  }
  try {
    // Sync disk → process.env for the deploy-relevant keys so deployAgent.run()
    // (which reads process.env directly) sees the UI's latest toggle state, not
    // the stale snapshot from server startup.
    for (const k of ['DEPLOY_MODE', 'DEPLOY_PORT_FE', 'DEPLOY_PORT_BE',
                     'DEPLOY_TIMEOUT_SEC', 'LOG_TAIL_LINES', 'DEPLOY_TEARDOWN_ON_PASS']) {
      if (diskEnv[k] != null && diskEnv[k] !== '') process.env[k] = diskEnv[k];
    }
    const taskId =
      'manual_redeploy_' +
      new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const result = await deployAgent.run({ task_id: taskId });
    // deploy_agent.run() mutates process.env.DEPLOY_PORT_* with the resolved
    // (post-fallback) host ports. Surface them so the UI can show "FE 열기"
    // links pointing at the right places without round-tripping through DB.
    // D29=A 이후 mysql 컨테이너 없음 — 호스트 MySQL은 .env의 DB_PORT 그대로.
    const ports = {
      be: Number(process.env.DEPLOY_PORT_BE || 3001),
      fe: Number(process.env.DEPLOY_PORT_FE || 5173),
    };
    res.json({ ok: result.status === 'SUCCESS', task_id: taskId, status: result.status, ports });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
