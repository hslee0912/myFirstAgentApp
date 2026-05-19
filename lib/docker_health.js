'use strict';

/**
 * Docker daemon preflight helpers.
 *
 * UI server is the entry point for "Run Pipeline" cycles. Phase 8 (Deploy)
 * and Phase 9 (PostTest) are Docker-dependent — if daemon is dead, cycle
 * starts but fails late in deploy with an opaque error. This module lets
 * the UI fail fast with a clear hint instead, and optionally auto-start
 * the daemon if sudo NOPASSWD is configured for `systemctl start docker`.
 *
 * Cross-platform: Windows callers will see daemon-not-running results
 * (no `sudo` there). Same fail-fast behavior, just no auto-start branch.
 */

const { spawnSync } = require('child_process');

function isDaemonRunning() {
  const r = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  return r.status === 0;
}

function detectCompose() {
  const v2 = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if (v2.status === 0) return 'docker compose';
  const v1 = spawnSync('docker-compose', ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  if (v1.status === 0) return 'docker-compose';
  return null;
}

/**
 * Try to start docker daemon via sudo NOPASSWD. Returns immediately if
 * already running. Polls `docker info` for up to ~10s after systemctl
 * succeeds (daemon socket takes a moment to come up).
 */
function tryStartDaemon() {
  if (isDaemonRunning()) return { ok: true, message: 'already running' };
  const r = spawnSync('sudo', ['-n', 'systemctl', 'start', 'docker'], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `sudo systemctl start failed (exit=${r.status}): ${(r.stderr || r.stdout || '').trim()}`,
    };
  }
  // `systemctl start`는 명령만 보내고 즉시 return. daemon이 socket을
  // listen 가능해지기까지 wall clock으로 수 초~수십 초 걸리는 경우가 있다.
  // 30s 마진으로 polling (실제 ready 후엔 즉시 통과).
  for (let i = 0; i < 60; i++) {
    if (isDaemonRunning()) return { ok: true, message: `started (after ~${(i * 0.5).toFixed(1)}s)` };
    spawnSync('sleep', ['0.5'], { windowsHide: true });
  }
  return {
    ok: false,
    message: 'systemctl start 성공했으나 30s 안에 daemon이 응답하지 않음',
  };
}

/**
 * Single entry point for UI startup. Returns either:
 *   { ok: true, compose: 'docker compose' | 'docker-compose' }
 *   { ok: false, reason, hint, detail? }
 *
 * Caller logs/fails based on .ok. Reason codes:
 *   - 'daemon-not-running' : daemon down and auto-start failed
 *   - 'compose-not-found'  : docker compose v2 plugin and v1 binary both missing
 */
function dockerPreflight() {
  if (!isDaemonRunning()) {
    const t = tryStartDaemon();
    if (!t.ok) {
      return {
        ok: false,
        reason: 'daemon-not-running',
        hint: '서버에서 직접 실행: sudo systemctl start docker',
        detail: t.message,
      };
    }
  }
  const compose = detectCompose();
  if (!compose) {
    return {
      ok: false,
      reason: 'compose-not-found',
      hint: 'docker-compose-plugin 또는 docker-compose 설치 필요',
    };
  }
  return { ok: true, compose };
}

module.exports = {
  isDaemonRunning,
  detectCompose,
  tryStartDaemon,
  dockerPreflight,
};
