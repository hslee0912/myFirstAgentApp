/**
 * Unit tests for agents/deploy_agent.js — port preflight helpers.
 *
 * Run: npm test  (uses node --test, no extra dependency)
 *
 * Note: tests bind to ephemeral ports on 0.0.0.0 to verify probe behavior.
 * They do not require Docker or DB and avoid the env-mutating
 * resolvePortsWithFallback path by snapshotting + restoring process.env.
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  isPortFree,
  findFreePort,
  resolvePortsWithFallback,
  dockerPublishedPorts,
} = require('../agents/deploy_agent');

/** Bind a listener on `port` so subsequent probes see EADDRINUSE. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => resolve(server));
    server.listen(port, '0.0.0.0');
  });
}

/** Find a port the OS hands out for us — we then re-use it for occupy(). */
function pickEphemeral() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(0, '0.0.0.0');
  });
}

// ─────────── isPortFree ───────────

test('isPortFree: returns true for an unused port', async () => {
  const port = await pickEphemeral();
  assert.equal(await isPortFree(port), true);
});

test('isPortFree: returns false when port is already bound', async () => {
  const port = await pickEphemeral();
  const occupied = await occupy(port);
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    occupied.close();
  }
});

// ─────────── findFreePort ───────────

test('findFreePort: returns the start port when it is free', async () => {
  const port = await pickEphemeral();
  const result = await findFreePort(port, 'mysql', 5);
  assert.equal(result, port);
});

test('findFreePort: falls back to start+1 when start is occupied', async () => {
  const port = await pickEphemeral();
  const occupied = await occupy(port);
  try {
    const result = await findFreePort(port, 'be', 5);
    assert.notEqual(result, port);
    assert.ok(result > port && result <= port + 5);
  } finally {
    occupied.close();
  }
});

test('findFreePort: skips ports listed in dockerPorts even when OS reports free', async () => {
  const a = await pickEphemeral();
  const dockerPorts = new Set([a]);
  const result = await findFreePort(a, 'mysql', 50, dockerPorts);
  assert.notEqual(result, a);
  assert.ok(result > a);
});

test('findFreePort: dockerPorts default empty Set keeps backwards-compat behavior', async () => {
  const port = await pickEphemeral();
  const result = await findFreePort(port, 'be', 5);
  assert.equal(result, port);
});

test('findFreePort: throws when no port is free within the window', async () => {
  // Occupy two consecutive ephemeral ports, then point findFreePort at the
  // first one with maxOffset=1 (so the only candidates are both occupied).
  const a = await pickEphemeral();
  let b;
  // Find a 'b' that is exactly a+1 if possible. Retry a few times.
  for (let i = 0; i < 5; i++) {
    b = await pickEphemeral();
    if (b === a + 1) break;
  }
  if (b !== a + 1) {
    // Fallback strategy: occupy 'a' only and pass maxOffset=0 so there is no
    // fallback candidate; this still exercises the throw path.
    const occA = await occupy(a);
    try {
      await assert.rejects(
        () => findFreePort(a, 'fe', 0),
        /No free port found/
      );
    } finally {
      occA.close();
    }
    return;
  }
  const occA = await occupy(a);
  const occB = await occupy(b);
  try {
    await assert.rejects(
      () => findFreePort(a, 'fe', 1),
      /No free port found/
    );
  } finally {
    occA.close();
    occB.close();
  }
});

// ─────────── resolvePortsWithFallback ───────────

test('resolvePortsWithFallback: returns requested ports when all free + sets env', async () => {
  const snap = {
    DEPLOY_PORT_DB: process.env.DEPLOY_PORT_DB,
    DEPLOY_PORT_BE: process.env.DEPLOY_PORT_BE,
    DEPLOY_PORT_FE: process.env.DEPLOY_PORT_FE,
  };
  try {
    const a = await pickEphemeral();
    const b = await pickEphemeral();
    const c = await pickEphemeral();
    const out = await resolvePortsWithFallback({ mysql: a, be: b, fe: c });
    assert.equal(out.mysql, a);
    assert.equal(out.be, b);
    assert.equal(out.fe, c);
    assert.equal(out.changed, false);
    assert.equal(process.env.DEPLOY_PORT_DB, String(a));
    assert.equal(process.env.DEPLOY_PORT_BE, String(b));
    assert.equal(process.env.DEPLOY_PORT_FE, String(c));
  } finally {
    process.env.DEPLOY_PORT_DB = snap.DEPLOY_PORT_DB ?? '';
    process.env.DEPLOY_PORT_BE = snap.DEPLOY_PORT_BE ?? '';
    process.env.DEPLOY_PORT_FE = snap.DEPLOY_PORT_FE ?? '';
  }
});

test('resolvePortsWithFallback: sets changed=true when any port shifts', async () => {
  const snap = {
    DEPLOY_PORT_DB: process.env.DEPLOY_PORT_DB,
    DEPLOY_PORT_BE: process.env.DEPLOY_PORT_BE,
    DEPLOY_PORT_FE: process.env.DEPLOY_PORT_FE,
  };
  const port = await pickEphemeral();
  const occupied = await occupy(port);
  try {
    const free1 = await pickEphemeral();
    const free2 = await pickEphemeral();
    const out = await resolvePortsWithFallback({ mysql: port, be: free1, fe: free2 });
    assert.notEqual(out.mysql, port);
    assert.equal(out.be, free1);
    assert.equal(out.fe, free2);
    assert.equal(out.changed, true);
  } finally {
    occupied.close();
    process.env.DEPLOY_PORT_DB = snap.DEPLOY_PORT_DB ?? '';
    process.env.DEPLOY_PORT_BE = snap.DEPLOY_PORT_BE ?? '';
    process.env.DEPLOY_PORT_FE = snap.DEPLOY_PORT_FE ?? '';
  }
});

// ─────────── dockerPublishedPorts ───────────

test('dockerPublishedPorts: returns a Set of numeric ports', () => {
  const ports = dockerPublishedPorts();
  assert.ok(ports instanceof Set);
  // Can't assert specific contents (depends on what's running); just verify
  // shape + that every entry is a valid port number.
  for (const p of ports) {
    assert.equal(typeof p, 'number');
    assert.ok(p > 0 && p < 65536);
  }
});

after(() => { /* node:test doesn't auto-exit if a stray listener lingers */ });
