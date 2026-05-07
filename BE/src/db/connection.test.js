'use strict';

const { getPool, closePool } = require('./connection');

describe('connection', () => {
  afterAll(async () => {
    await closePool();
  });

  test('getPool returns a pool instance', () => {
    const pool = getPool();
    expect(pool).toBeDefined();
    expect(typeof pool.query).toBe('function');
  });

  test('getPool returns the same instance on multiple calls', () => {
    const pool1 = getPool();
    const pool2 = getPool();
    expect(pool1).toBe(pool2);
  });
});
