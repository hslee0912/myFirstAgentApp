'use strict';

/**
 * docker_health module sanity tests.
 *
 * These run against the *real* docker on the host (no mocking) — the module
 * is a thin wrapper over spawnSync so mocking would test almost nothing.
 * Each assertion is permissive about ok vs not-ok so the suite passes in
 * both "docker installed + daemon up" and "docker absent" environments.
 *
 * What we actually verify:
 *   - exports surface is stable (callers won't break)
 *   - return shapes are well-formed (callers can branch on .ok safely)
 *   - reason codes are from the documented set when fail
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dh = require('../lib/docker_health');

test('docker_health: module exports four functions', () => {
  assert.equal(typeof dh.isDaemonRunning, 'function');
  assert.equal(typeof dh.detectCompose, 'function');
  assert.equal(typeof dh.tryStartDaemon, 'function');
  assert.equal(typeof dh.dockerPreflight, 'function');
});

test('docker_health: isDaemonRunning returns boolean', () => {
  const r = dh.isDaemonRunning();
  assert.equal(typeof r, 'boolean');
});

test('docker_health: detectCompose returns one of {docker compose, docker-compose, null}', () => {
  const r = dh.detectCompose();
  assert.ok(
    r === null || r === 'docker compose' || r === 'docker-compose',
    `unexpected detectCompose value: ${r}`,
  );
});

test('docker_health: dockerPreflight return shape', () => {
  const r = dh.dockerPreflight();
  assert.equal(typeof r.ok, 'boolean');
  if (r.ok) {
    assert.equal(typeof r.compose, 'string');
  } else {
    assert.equal(typeof r.reason, 'string');
    assert.ok(
      r.reason === 'daemon-not-running' || r.reason === 'compose-not-found',
      `unexpected reason code: ${r.reason}`,
    );
    assert.equal(typeof r.hint, 'string');
  }
});
