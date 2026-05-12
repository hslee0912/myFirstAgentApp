/**
 * Project init — 사용자가 "처음 cycle 돌리기 직전" 상태로 되돌릴 때.
 *
 *   GET  /api/init-preview — 삭제될 src 파일 개수 + DB row 개수 미리보기
 *   POST /api/init         — BE/src + FE/src 통째 삭제 + DB 전체 truncate
 *
 * 보존:
 *   - BE/{Dockerfile, package*.json, .eslintrc.json, .dockerignore, node_modules}
 *   - FE/{Dockerfile, package*.json, vite.config.js, index.html, .eslintrc.json,
 *         .dockerignore, node_modules, dist}
 *   - host MySQL schema (테이블 구조는 그대로, 데이터만 truncate)
 *   - 떠있는 docker 컨테이너 (메모리 — 다음 Redeploy까지 그대로)
 *   - .env (인프라 설정)
 *
 * 다음 Run pipeline 시작 시점에 lib/bootstrap.js가 src/ 폴더 + placeholder
 * 파일들(server.js, server.test.js, App.jsx 등)을 자동 복원한다 (idempotent).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const mysql = require('mysql2/promise');
const { ROOT, currentRunRef } = require('./_context');
const db = require('../../lib/db');

const router = express.Router();

const BE_SRC = path.join(ROOT, 'BE', 'src');
const FE_SRC = path.join(ROOT, 'FE', 'src');
const RESET_SQL = path.join(ROOT, 'db', 'reset.sql');
const SCHEMA_SQL = path.join(ROOT, 'db', 'agent_schema.sql');

const DB_TABLES = ['log_agent_runs', 'log_agent_decisions', 'log_task_state'];

/** 디렉터리 안의 모든 파일을 재귀적으로 열거 (count + sample 최대 N개). */
function listFilesRecursive(dir, sampleLimit = 10) {
  if (!fs.existsSync(dir)) return { count: 0, sample: [] };
  const out = [];
  const queue = [{ abs: dir, rel: '' }];
  while (queue.length) {
    const { abs, rel } = queue.pop();
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) queue.push({ abs: childAbs, rel: childRel });
      else out.push(childRel);
    }
  }
  return { count: out.length, sample: out.slice(0, sampleLimit) };
}

router.get('/init-preview', async (_req, res) => {
  const beSrc = listFilesRecursive(BE_SRC);
  const feSrc = listFilesRecursive(FE_SRC);

  const dbCounts = {};
  try {
    for (const t of DB_TABLES) {
      // lib/db.js의 query는 이미 rows 배열을 반환 (mysql2의 [rows] tuple 안에서 unwrap됨)
      const rows = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      dbCounts[t] = Number(rows[0].n);
    }
  } catch (e) {
    dbCounts._error = e.message;
  }

  const dbTotal = Object.entries(dbCounts)
    .filter(([k]) => !k.startsWith('_'))
    .reduce((a, [, v]) => a + v, 0);

  res.json({
    be_src: beSrc,
    fe_src: feSrc,
    db: dbCounts,
    db_total: dbTotal,
    can_init: beSrc.count > 0 || feSrc.count > 0 || dbTotal > 0,
  });
});

router.post('/init', async (_req, res) => {
  if (currentRunRef.value) {
    return res.status(409).json({
      ok: false,
      error: '다른 작업 진행 중. 끝난 후 다시 시도하세요.',
      current: { task_id: currentRunRef.value.task_id, pid: currentRunRef.value.pid },
    });
  }

  const result = {
    ok: true,
    be_src_deleted: 0,
    fe_src_deleted: 0,
    db_truncated: [],
  };

  try {
    // 1. src 파일 개수 사전 측정 (return value용)
    const bePre = listFilesRecursive(BE_SRC, 0);
    const fePre = listFilesRecursive(FE_SRC, 0);
    result.be_src_deleted = bePre.count;
    result.fe_src_deleted = fePre.count;

    // 2. src 통째 삭제 (recursive + force)
    if (fs.existsSync(BE_SRC)) fs.rmSync(BE_SRC, { recursive: true, force: true });
    if (fs.existsSync(FE_SRC)) fs.rmSync(FE_SRC, { recursive: true, force: true });

    // 3. DB 전체 reset (D31=a, 2026-05-13) — db/reset.sql 실행 후 agent_schema.sql 재실행.
    //    lib/db.js의 pool은 multipleStatements:false라 여기선 별도 connection
    //    (multipleStatements:true) 만들어 sql 한 번에 실행. lib/reset_db.js와
    //    동일 패턴. spawn 안 하는 이유: HTTP 응답 안에서 결과 정리하기 쉬움.
    const resetSql = fs.readFileSync(RESET_SQL, 'utf8');
    const schemaSql = fs.readFileSync(SCHEMA_SQL, 'utf8');
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      multipleStatements: true,
    });
    try {
      await conn.query(resetSql);
      await conn.query(schemaSql);
      result.db_truncated = [...DB_TABLES];
    } finally {
      await conn.end();
    }

    result.notice =
      `BE/src ${result.be_src_deleted}개, FE/src ${result.fe_src_deleted}개 파일 삭제 + ` +
      `DB ${result.db_truncated.length}개 테이블 reset (DROP+CREATE). ` +
      '다음 Run pipeline 시작 시 bootstrap이 placeholder를 자동 복원합니다. ' +
      '컨테이너는 그대로 떠있으니 새 cycle 결과를 보려면 cycle 완료 후 Redeploy.';
    res.json(result);
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    res.status(500).json(result);
  }
});

/**
 * POST /api/restart-ui — 현재 UI 서버 process를 재가동.
 *
 * 동작 흐름:
 *   1. 새 node ui/server.js process를 detached로 spawn (이 process가 부팅 시점에
 *      PID file로 옛 PID 확인 → SIGTERM → 자기 listen).
 *   2. res.json 응답 보냄.
 *   3. 800ms 후 자기 자신 process.exit(0) — 새 process가 SIGTERM 보내기 전에
 *      자발적으로 죽어 같은 port를 빠르게 비움.
 *
 * 사용 시점: 도구 코드(ui/routes/*.js, ui/server.js, agents/*) 변경 후 즉시
 * 적용하고 싶을 때. Node require 캐시 때문에 떠있는 process는 옛 코드 실행.
 *
 * Frontend는 응답 받자마자 사용자에게 "잠시 후 새로고침" alert + 2초 후
 * location.reload(). 그 사이에 새 process가 같은 port에 listen 완료.
 */
router.post('/restart-ui', (_req, res) => {
  const child = spawn('node', [path.join(ROOT, 'ui', 'server.js')], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT,
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();

  res.json({
    ok: true,
    new_pid: child.pid,
    notice: '800ms 후 현재 process 종료. 새 process가 같은 port에 listen.',
  });

  // 응답 flush를 위해 약간 대기 후 종료. 새 process는 부팅 시 PID file에서
  // 우리 PID를 발견하고 SIGTERM 보내는데, 우리가 그 전에 자발적으로 죽으면
  // 더 깔끔하게 port가 비워진다.
  setTimeout(() => {
    try { /* PID file 정리는 process.on('exit') 핸들러가 처리 */ }
    finally { process.exit(0); }
  }, 800);
});

module.exports = router;
