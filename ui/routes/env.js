/**
 * /api/env — read/write .env via the allowlist in lib/env_writer.
 */
'use strict';

const express = require('express');
const { readEnv, updateEnv, UI_EDITABLE_KEYS, TOGGLE_KEYS, ADVANCED_KEYS } = require('../../lib/env_writer');
const { ENV_PATH } = require('./_context');

const router = express.Router();

router.get('/', (_req, res) => {
  const all = readEnv(ENV_PATH);
  const editable = {};
  for (const k of UI_EDITABLE_KEYS) editable[k] = all[k] ?? '';
  // `editableKeys`는 하위호환용 — 신규 클라이언트는 toggleKeys/advancedKeys로 분기.
  res.json({
    editable,
    editableKeys: UI_EDITABLE_KEYS,
    toggleKeys: TOGGLE_KEYS,
    advancedKeys: ADVANCED_KEYS,
  });
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const k of Object.keys(body)) {
    if (!UI_EDITABLE_KEYS.includes(k)) {
      return res.status(400).json({ error: `key '${k}' not in allowlist` });
    }
    updates[k] = body[k];
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no keys to update' });
  }
  const result = updateEnv(ENV_PATH, updates);
  res.json({ ok: true, ...result });
});

module.exports = router;
