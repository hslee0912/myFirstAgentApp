'use strict';

/**
 * ui/server.js의 lifecycle helpers 단위 테스트.
 *
 * 대상:
 *   - writePidFile(pidFile)       — 자기 PID 박기
 *   - cleanupPidFile(pidFile)     — owner=self일 때만 삭제
 *   - killPreviousUIServer(file)  — PID file 읽고 SIGTERM/SIGKILL 흐름
 *
 * 임시 PID file을 tmp dir에 만들어 격리. 실제 server는 띄우지 않음.
 * 자식 process는 'sleep 30' 같이 신호 받으면 즉시 죽는 명령으로 시뮬레이트.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ui/server.js를 require하기 전에 dotenv가 .env를 override 모드로 읽음.
// test 환경에서 부작용 최소화 위해 환경 보존.
const lifecycle = require('../ui/server');

let TMPDIR;
let pidFile;

before(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-lifecycle-'));
});

after(() => {
  if (TMPDIR && fs.existsSync(TMPDIR)) {
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  }
});

function freshPidPath() {
  pidFile = path.join(TMPDIR, `pid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return pidFile;
}

test('exports surface: lifecycle helpers + PID_FILE 노출', () => {
  assert.equal(typeof lifecycle.writePidFile, 'function');
  assert.equal(typeof lifecycle.cleanupPidFile, 'function');
  assert.equal(typeof lifecycle.killPreviousUIServer, 'function');
  assert.equal(typeof lifecycle.PID_FILE, 'string');
});

test('writePidFile: 파일에 process.pid 저장 + true 반환', () => {
  const file = freshPidPath();
  const ok = lifecycle.writePidFile(file);
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
});

test('cleanupPidFile: owner=self일 때 삭제 + true 반환', () => {
  const file = freshPidPath();
  fs.writeFileSync(file, String(process.pid), 'utf8');
  const removed = lifecycle.cleanupPidFile(file);
  assert.equal(removed, true);
  assert.equal(fs.existsSync(file), false);
});

test('cleanupPidFile: owner != self이면 보존 + false 반환', () => {
  const file = freshPidPath();
  // 다른 임의 PID
  fs.writeFileSync(file, '99999', 'utf8');
  const removed = lifecycle.cleanupPidFile(file);
  assert.equal(removed, false);
  assert.equal(fs.existsSync(file), true);
});

test('cleanupPidFile: 파일 없으면 false 반환 (no-op)', () => {
  const file = freshPidPath();
  const removed = lifecycle.cleanupPidFile(file);
  assert.equal(removed, false);
});

test('killPreviousUIServer: PID file 없으면 reason=no-pid-file', async () => {
  const file = freshPidPath();
  const r = await lifecycle.killPreviousUIServer(file);
  assert.equal(r.killed, false);
  assert.equal(r.reason, 'no-pid-file');
});

test('killPreviousUIServer: PID file이 self pid이면 reason=self-or-invalid', async () => {
  const file = freshPidPath();
  fs.writeFileSync(file, String(process.pid), 'utf8');
  const r = await lifecycle.killPreviousUIServer(file);
  assert.equal(r.killed, false);
  assert.equal(r.reason, 'self-or-invalid');
});

test('killPreviousUIServer: 죽은 PID 가리키면 reason=stale (kill 안 함)', async () => {
  const file = freshPidPath();
  // 안전한 죽은 PID — 매우 큰 PID는 거의 항상 존재 X
  fs.writeFileSync(file, '999999', 'utf8');
  const r = await lifecycle.killPreviousUIServer(file);
  assert.equal(r.killed, false);
  assert.equal(r.reason, 'stale');
  assert.equal(r.pid, 999999);
});

test('killPreviousUIServer: 살아있는 자식 process를 SIGTERM으로 종료', async () => {
  const file = freshPidPath();
  // sleep 30 자식 process 띄움. detached로 group leader 분리해 우리가 그 PID만 정확히 추적.
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();

  // PID file에 자식 PID 박기.
  fs.writeFileSync(file, String(child.pid), 'utf8');

  // 약간 대기 — child가 fork 직후 안정.
  await new Promise((r) => setTimeout(r, 100));

  const r = await lifecycle.killPreviousUIServer(file);

  assert.equal(r.killed, true, `kill 결과: ${JSON.stringify(r)}`);
  assert.equal(r.pid, child.pid);
  // sleep는 SIGTERM에 즉시 반응 → reason=sigterm 기대 (sigkill로 escalate되면 폴백 폴링이 1초)
  assert.ok(
    r.reason === 'sigterm' || r.reason === 'sigkill',
    `reason 예상: sigterm/sigkill, 실제: ${r.reason}`,
  );

  // signal 0으로 정말 죽었는지 한 번 더 확인.
  let alive = false;
  try { process.kill(child.pid, 0); alive = true; } catch (_) { /* dead OK */ }
  assert.equal(alive, false, '자식 process가 여전히 살아있음');
});
